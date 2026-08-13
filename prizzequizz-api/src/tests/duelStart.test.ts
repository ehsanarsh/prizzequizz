/* THE DUEL ACTUALLY STARTING.
 *
 * The report: an opponent is found, the player is thrown back to the home
 * screen, no match is played — and the entry ticket is gone. The client only
 * says «خطا در ورود» and goes home when POST /matches/:id/start does not come
 * back OK, so that call is what is under test here, over real HTTP and through
 * the whole chain the queue puts in front of it.
 *
 * The ticket assertion is the important half: a start that fails must not leave
 * the player paying for a match that never happened.
 *
 * Run: npx tsx src/tests/duelStart.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { grantTickets, getTickets } from '../services/ticketService.js';
import { createSession } from '../services/sessionService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let base = '';
async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed?.data ?? parsed, code: parsed?.error?.code ?? '', raw: text };
}

async function makePlayer(tickets = 2): Promise<{ userId: string; token: string }> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'd_' + userId.slice(0, 6),
    displayName: 'دوئل‌باز', plan: 'premium', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(userId, 'green', tickets);
  return { userId, token: createSession(userId).accessToken };
}
const green = async (userId: string) => Number((await getTickets(userId)).green || 0);

async function run(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await repositories.questions.save({
      id: 'ds' + i, category: 'عمومی', difficulty: 'easy', text: 'سؤال ' + i,
      options: ['الف', 'ب', 'پ', 'ت'], correctIndex: i % 4, tags: [], status: 'approved', version: 1
    } as any);
  }

  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

  try {
    await check('two players who queue together are matched and the duel starts', async () => {
      const a = await makePlayer(2);
      const b = await makePlayer(2);

      const q1 = await api('POST', '/matchmaking/enqueue', a.token,
        { modeId: 'duel', economyType: 'v12500', skill: 800, ticketTier: 'green' });
      assert.ok(q1.status === 200 || q1.status === 202, 'first enqueue: ' + q1.status + ' ' + q1.raw.slice(0, 200));

      const q2 = await api('POST', '/matchmaking/enqueue', b.token,
        { modeId: 'duel', economyType: 'v12500', skill: 800, ticketTier: 'green' });
      assert.ok(q2.status === 200 || q2.status === 202, 'second enqueue: ' + q2.status + ' ' + q2.raw.slice(0, 200));

      /* Either the second enqueue paired immediately, or the queue does it a
         moment later and the poll picks it up — the client handles both. */
      let matchId: string | null = q2.body?.status === 'matched' ? q2.body.matchId : null;
      for (let i = 0; i < 40 && !matchId; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const poll = await api('GET', '/matchmaking/' + q2.body.id, b.token);
        if (poll.body?.status === 'matched' && poll.body.matchId) matchId = poll.body.matchId;
      }
      assert.ok(matchId, 'the two players were never matched');

      /* THE CALL THE PLAYER IS THROWN OUT ON. */
      const s = await api('POST', '/matches/' + matchId + '/start', a.token, {});
      assert.equal(s.status, 200, 'start failed with ' + s.status + ': ' + s.raw.slice(0, 300));
      assert.equal(s.body && s.body.matchId, matchId, 'the snapshot is the match: ' + s.raw.slice(0, 200));

      /* And the other player starting the same match must work too — both
         clients call it, and a second call is not an error. */
      const s2 = await api('POST', '/matches/' + matchId + '/start', b.token, {});
      assert.equal(s2.status, 200, 'the second player: ' + s2.status + ' ' + s2.raw.slice(0, 300));

      /* Questions have to arrive, or the client falls back and the round is
         played on local data — which is how two phones end up disagreeing. */
      const q = await api('GET', '/matches/' + matchId + '/question?round=0', a.token);
      assert.equal(q.status, 200, 'question: ' + q.status + ' ' + q.raw.slice(0, 200));
      assert.ok(Array.isArray(q.body.options) && q.body.options.length >= 4, q.raw.slice(0, 200));

      /* One ticket each, and exactly one. */
      assert.equal(await green(a.userId), 1, 'player A paid once');
      assert.equal(await green(b.userId), 1, 'player B paid once');
    });

    await check('a player who cannot be paired gets the ticket back when they cancel', async () => {
      const a = await makePlayer(2);
      const q = await api('POST', '/matchmaking/enqueue', a.token,
        { modeId: 'duel', economyType: 'v50000', skill: 1500, ticketTier: 'green' });
      assert.equal(q.status, 202, 'nobody to match: ' + q.raw.slice(0, 200));
      assert.equal(await green(a.userId), 1, 'the ticket is held while queued');

      const c = await api('POST', '/matchmaking/' + q.body.id + '/cancel', a.token, { reason: 'user' });
      assert.equal(c.status, 200, c.raw.slice(0, 200));
      assert.equal(await green(a.userId), 2, 'and comes back on cancel');
    });

    await check('starting a match that does not exist fails without taking a ticket', async () => {
      const a = await makePlayer(2);
      const before = await green(a.userId);
      const s = await api('POST', '/matches/does-not-exist/start', a.token, {});
      assert.ok(s.status >= 400, 'expected a refusal, got ' + s.status);
      assert.equal(await green(a.userId), before, 'and nothing was charged for it');
    });
  } finally {
    server.close();
  }

  console.log(`[duelStart] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
