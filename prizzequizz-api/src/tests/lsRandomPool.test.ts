/* LAST SURVIVOR — which topics «تصادفی» is allowed to draw from.
 *
 * «تصادفی» has always meant "the whole approved bank". That is the right
 * default and the wrong answer as soon as an operator has a category they do
 * not want turning up in the random mix — there was no way to keep a topic
 * playable on its own while excluding it from the random pool.
 *
 * Over real HTTP, because it is the admin ROUTES the panel calls, and because
 * the player-facing topic list has to agree with them about how big the pool is.
 *
 * Run: npx tsx src/tests/lsRandomPool.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { getConfig, isInRandomPool, randomPoolCategories, setRandomCategories } from '../services/lastSurvivorConfig.js';
import { pickQuestion } from '../services/lastSurvivorWorker.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const WANTED = 'ورزش';          // in the random mix
const UNWANTED = 'سیاست';       // playable on its own, but not in the mix
const EMPTY = 'موضوع خالی';     // no approved questions at all
let base = '';
const ADMIN = { 'x-admin-key': 'dev-admin', 'content-type': 'application/json' };

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
  for (let i = 0; i < 6; i++) {
    await repositories.questions.save({
      id: 'rp-w' + i, category: WANTED, difficulty: 'easy', text: 'و' + i,
      options: ['الف', 'ب', 'پ', 'ت'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  for (let i = 0; i < 4; i++) {
    await repositories.questions.save({
      id: 'rp-u' + i, category: UNWANTED, difficulty: 'easy', text: 'س' + i,
      options: ['الف', 'ب', 'پ', 'ت'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  /* Read at assert time, never captured up front: the server seeds questions of
     its own when it starts, so a number taken before listen() is stale by the
     time the pool is compared against "the whole bank". */
  const bankSize = async () => (await repositories.questions.listApproved()).length;

  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

  try {
    await check('out of the box «تصادفی» is every category — nothing changes for an operator who never opens this', async () => {
      await setRandomCategories([]);
      const cfg = await getConfig();
      assert.deepEqual(randomPoolCategories(cfg), []);
      assert.equal(isInRandomPool(cfg, WANTED), true);
      assert.equal(isInRandomPool(cfg, UNWANTED), true);
      assert.equal(isInRandomPool(cfg, 'هر چیز دیگری'), true, 'a category invented later is in the pool too');
    });

    await check('the panel is given the categories to tick, with their real counts', async () => {
      const r = await api('GET', '/admin/last-survivor/topics');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.randomTopic, 'تصادفی');
      assert.deepEqual(r.body.randomCategories, []);
      const w = find(r.body.categories, WANTED);
      assert.ok(w, WANTED + ' is offered');
      assert.equal(w.questionCount, 6, 'with the number it really has');
      /* A category with nothing approved is not offered: ticking it would add
         no questions and make the pool look bigger than it is. */
      assert.equal(find(r.body.categories, EMPTY), undefined);
    });

    await check('naming a category narrows the pool to it', async () => {
      const r = await api('PUT', '/admin/last-survivor/random-categories', { categories: [WANTED] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.randomCategories, [WANTED]);
      assert.equal(r.body.questionCount, 6, 'the pool is that category, not the bank');

      const cfg = await getConfig();
      assert.equal(isInRandomPool(cfg, WANTED), true);
      assert.equal(isInRandomPool(cfg, UNWANTED), false, 'the excluded one really is excluded');
    });

    await check('the player-facing topic list reports the narrowed pool, not the whole bank', async () => {
      const list = await api('GET', '/last-survivor/topics', undefined, false);
      const rnd = find(list.body.topics, 'تصادفی');
      assert.ok(rnd, 'تصادفی is still on the picker');
      assert.equal(rnd.questionCount, 6, 'saw ' + rnd.questionCount + ' of a bank of ' + (await bankSize()));
    });

    await check('an excluded topic is still playable on its own', async () => {
      /* This is the whole point: «سیاست» can be a topic somebody deliberately
         chooses, without being something «تصادفی» serves by surprise. */
      const on = await api('POST', '/admin/last-survivor/topics/' + encodeURIComponent(UNWANTED), { enabled: true });
      assert.equal(on.status, 200, JSON.stringify(on.body));
      const list = await api('GET', '/last-survivor/topics', undefined, false);
      const t = find(list.body.topics, UNWANTED);
      assert.ok(t && t.playable, 'it is playable');
      assert.equal(t.questionCount, 4, 'with its own questions');

      const cfg = await getConfig();
      assert.equal(isInRandomPool(cfg, UNWANTED), false, 'and still out of the random mix');
    });

    await check('emptying the list puts every category back', async () => {
      const r = await api('PUT', '/admin/last-survivor/random-categories', { categories: [] });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.randomCategories, []);
      assert.equal(r.body.questionCount, await bankSize(), 'the pool is the whole bank again');
      const cfg = await getConfig();
      assert.equal(isInRandomPool(cfg, UNWANTED), true);
    });

    await check('the QUESTIONS «تصادفی» actually serves come only from the chosen topics', async () => {
      /* The setting is worthless unless the picker obeys it, and the picker is
         the one thing the config round-trip above cannot prove. */
      await setRandomCategories([WANTED]);
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const q = await pickQuestion('تصادفی', 'rp-room-' + i, 1, 12);
        assert.ok(q, 'the picker must not stall on a narrowed pool');
        const full = (await repositories.questions.listApproved()).find((x) => x.id === q!.id);
        seen.add(String(full?.category));
      }
      assert.deepEqual([...seen], [WANTED], 'served: ' + [...seen].join(', '));
    });

    await check('with no selection it serves the whole bank again', async () => {
      await setRandomCategories([]);
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) {
        const q = await pickQuestion('تصادفی', 'rp-open-' + i, 1, 12);
        const full = (await repositories.questions.listApproved()).find((x) => x.id === q!.id);
        seen.add(String(full?.category));
      }
      assert.ok(seen.size > 1, 'only ever saw ' + [...seen].join(', '));
    });

    await check('a named topic still ignores the random pool entirely', async () => {
      await setRandomCategories([WANTED]);
      const q = await pickQuestion(UNWANTED, 'rp-named', 1, 12);
      assert.ok(q, 'the excluded topic is still playable on its own');
      const full = (await repositories.questions.listApproved()).find((x) => x.id === q!.id);
      assert.equal(full?.category, UNWANTED);
      await setRandomCategories([]);
    });

    await check('a selection with no approved questions behind it is refused', async () => {
      /* Saving it would leave the picker with nothing to draw, so every round
         would fall back to the whole bank — the exact opposite of what was
         asked for, and silently. */
      const r = await api('PUT', '/admin/last-survivor/random-categories', { categories: [EMPTY] });
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.code, 'RANDOM_POOL_EMPTY');
      const cfg = await getConfig();
      assert.deepEqual(randomPoolCategories(cfg), [], 'and nothing was saved');
    });

    await check('a body that is not a list is refused', async () => {
      const r = await api('PUT', '/admin/last-survivor/random-categories', { categories: 'ورزش' });
      assert.equal(r.status, 422);
      assert.equal(r.code, 'BAD_INPUT');
    });

    await check('duplicates and blanks are cleaned up rather than stored', async () => {
      const r = await api('PUT', '/admin/last-survivor/random-categories', { categories: [WANTED, WANTED, '  ', '', UNWANTED] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.randomCategories, [WANTED, UNWANTED]);
    });

    await check('none of this is open to the public', async () => {
      const r = await api('PUT', '/admin/last-survivor/random-categories', { categories: [] }, false);
      assert.equal(r.status, 403);
      assert.equal(r.code, 'ADMIN_REQUIRED');
      /* …and the attempt changed nothing. */
      const cfg = await getConfig();
      assert.deepEqual(randomPoolCategories(cfg), [WANTED, UNWANTED]);
    });

    await check('turning «تصادفی» on counts the narrowed pool, not the bank', async () => {
      await setRandomCategories([EMPTY]);        // no questions behind it
      const r = await api('POST', '/admin/last-survivor/topics/' + encodeURIComponent('تصادفی'), { enabled: true });
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.code, 'TOPIC_EMPTY');
      await setRandomCategories([]);
    });
  } finally {
    server.close();
  }

  console.log(`[lsRandomPool] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
