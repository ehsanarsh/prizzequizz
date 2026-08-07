/* LAST SURVIVOR — a topic list the operator owns, not one the question bank
 * dictates.
 *
 * The list used to be derived: every category holding approved questions turned
 * up in the picker, and nothing else could. That had two consequences the
 * operator kept running into. A topic could not be taken off the list — DELETE
 * only dropped the config override, and the category put it straight back on
 * the next read. And a topic that did not yet exist in the bank could not be
 * announced at all, so there was no way to put a «به‌زودی» card in front of
 * players before writing its questions.
 *
 * Both are covered here, over real HTTP, because it is the admin ROUTES the
 * panel calls — a service-level pass would not prove the panel can do this.
 *
 * Run: npx tsx src/tests/lsCustomTopics.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { getConfig, updateConfig } from '../services/lastSurvivorConfig.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const REAL = 'اطلاعات عمومی';          // a category that really has questions
const CUSTOM = 'فوتبال جهانی';          // invented here; no questions anywhere
let base = '';
const ADMIN = { 'x-admin-key': 'dev-admin', 'content-type': 'application/json' };

/* The API wraps everything in {ok, data} / {ok, error}; unwrap it here so each
 * case reads as the shape the panel actually consumes. */
async function api(method: string, path: string, body?: unknown, admin = true): Promise<{ status: number; body: any; code: string }> {
  const res = await fetch(base + path, {
    method,
    headers: admin ? ADMIN : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed?.data ?? parsed, code: parsed?.error?.code ?? '' };
}

const find = (topics: any[], name: string) => topics.find((t) => t.name === name);

async function run(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await repositories.questions.save({
      id: 'ct' + i, category: REAL, difficulty: 'easy', text: 'س' + i,
      options: ['الف', 'ب', 'پ', 'ت'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

  try {
    await check('the admin can invent a topic the question bank has never heard of', async () => {
      const r = await api('POST', '/admin/last-survivor/topics', { name: CUSTOM, icon: '⚽' });
      assert.equal(r.status, 201, 'created: ' + JSON.stringify(r.body));
      assert.equal(r.body.config.custom, true, 'it is marked as the operator’s own');
      assert.equal(r.body.config.enabled, false, 'and it is NOT playable — it has no questions');

      const list = await api('GET', '/last-survivor/topics', undefined, false);
      const t = find(list.body.topics, CUSTOM);
      assert.ok(t, 'players see it in the picker');
      assert.equal(t.comingSoon, true, 'wearing the «به‌زودی» badge');
      assert.equal(t.icon, '⚽', 'with the emoji it was given, not a «؟»');
      assert.equal(t.questionCount, 0, 'and an honest question count');
    });

    await check('a topic with no questions cannot be switched on', async () => {
      const r = await api('POST', '/admin/last-survivor/topics/' + encodeURIComponent(CUSTOM), { enabled: true });
      assert.equal(r.status, 422, 'refused: ' + JSON.stringify(r.body));
      assert.equal(r.code, 'TOPIC_EMPTY');
      const list = await api('GET', '/last-survivor/topics', undefined, false);
      assert.equal(find(list.body.topics, CUSTOM).playable, false, 'still not playable');
    });

    await check('deleting an invented topic really deletes it', async () => {
      const r = await api('DELETE', '/admin/last-survivor/topics/' + encodeURIComponent(CUSTOM));
      assert.equal(r.status, 200);
      assert.equal(r.body.action, 'removed', 'nothing in the bank keeps it alive');
      const cfg = await getConfig();
      assert.equal(cfg.topics[CUSTOM], undefined, 'gone from the config');
      const list = await api('GET', '/last-survivor/topics', undefined, false);
      assert.equal(find(list.body.topics, CUSTOM), undefined, 'and gone from the picker');
      const panel = await api('GET', '/admin/last-survivor/topics');
      assert.equal(find(panel.body.topics, CUSTOM), undefined, 'gone from the panel too');
    });

    await check('deleting a category-backed topic hides it, and says so', async () => {
      const r = await api('DELETE', '/admin/last-survivor/topics/' + encodeURIComponent(REAL));
      assert.equal(r.status, 200);
      assert.equal(r.body.action, 'hidden', 'the category still holds questions, so hide is the truth');

      const list = await api('GET', '/last-survivor/topics', undefined, false);
      assert.equal(find(list.body.topics, REAL), undefined, 'players no longer see it — this is the bug that was fixed');

      const panel = await api('GET', '/admin/last-survivor/topics');
      const t = find(panel.body.topics, REAL);
      assert.ok(t, 'the operator still sees it, or they could never put it back');
      assert.equal(t.hidden, true);
    });

    await check('a hidden topic cannot be joined, even with a hand-made request', async () => {
      await updateConfig({ topics: { [REAL]: { enabled: true } } });   // on, but still hidden
      const cfg = await getConfig();
      assert.equal(cfg.topics[REAL]?.enabled, true, 'enabled…');
      assert.equal(cfg.topics[REAL]?.hidden, true, '…and hidden');
      const { isTopicPlayable } = await import('../services/lastSurvivorConfig.js');
      assert.equal(isTopicPlayable(cfg, REAL), false, 'hidden beats enabled at the gate joinTopic uses');
    });

    await check('restoring a hidden topic puts it back in the picker', async () => {
      const r = await api('POST', '/admin/last-survivor/topics/' + encodeURIComponent(REAL), { hidden: false });
      assert.equal(r.status, 200);
      const list = await api('GET', '/last-survivor/topics', undefined, false);
      const t = find(list.body.topics, REAL);
      assert.ok(t, 'back in the picker');
      assert.equal(t.playable, true, 'with the enabled flag it kept while it was hidden');
    });

    await check('«تصادفی» cannot be taken off the list', async () => {
      const r = await api('DELETE', '/admin/last-survivor/topics/' + encodeURIComponent('تصادفی'));
      assert.equal(r.status, 422, 'refused: ' + JSON.stringify(r.body));
      const list = await api('GET', '/last-survivor/topics', undefined, false);
      assert.ok(find(list.body.topics, 'تصادفی'), 'still offered');
    });

    await check('the same topic cannot be added twice', async () => {
      await api('POST', '/admin/last-survivor/topics', { name: CUSTOM, icon: '⚽' });
      const again = await api('POST', '/admin/last-survivor/topics', { name: CUSTOM });
      assert.equal(again.status, 422, 'a duplicate is refused, not silently merged');
    });

    await check('adding a name that is only hidden brings it back instead of erroring', async () => {
      await api('DELETE', '/admin/last-survivor/topics/' + encodeURIComponent(REAL));   // hide it again
      const r = await api('POST', '/admin/last-survivor/topics', { name: REAL, icon: '🧠' });
      assert.equal(r.status, 201, 're-adding a hidden name is a restore: ' + JSON.stringify(r.body));
      assert.equal(r.body.config.hidden, false);
      assert.equal(r.body.config.enabled, false, 'but it comes back gated — never silently live again');
    });

    await check('an empty or over-long name is refused', async () => {
      assert.equal((await api('POST', '/admin/last-survivor/topics', { name: '   ' })).status, 422);
      assert.equal((await api('POST', '/admin/last-survivor/topics', { name: 'x'.repeat(61) })).status, 422);
    });

    await check('none of this is open to the public', async () => {
      for (const [m, p] of [['POST', '/admin/last-survivor/topics'], ['GET', '/admin/last-survivor/topics'],
                            ['DELETE', '/admin/last-survivor/topics/' + encodeURIComponent(REAL)]] as const) {
        const r = await api(m, p, m === 'POST' ? { name: 'هک' } : undefined, false);
        assert.equal(r.status, 403, m + ' ' + p + ' must be refused without the admin key');
        assert.equal(r.code, 'ADMIN_REQUIRED');
      }
      // …and the topic was not touched by the attempt.
      const list = await api('GET', '/last-survivor/topics', undefined, false);
      assert.ok(find(list.body.topics, REAL), REAL + ' survived the unauthenticated delete');
    });
  } finally {
    server.close();
  }

  console.log(`[lsCustomTopics] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
