/* AN ANSWER THAT ARRIVES BY THE OTHER DOOR IS STILL AN ANSWER.
 *
 * The report: two players are matched, one of them is told «اینترنت شما
 * ناپایدار است», then «اتصال شما قطع شده است», and is thrown out — while
 * Last Survivor plays perfectly on the same phone, on the same internet, in
 * the same minute.
 *
 * The difference between the two modes is the road the answer takes. Last
 * Survivor answers with an ordinary request; the duel answered over the live
 * socket, and on these networks the socket is the thing that gets dropped. The
 * client now falls back to HTTP — but the HTTP route only recorded the answer
 * and told nobody, so the opponent sat waiting and eventually claimed the
 * match by timeout.
 *
 * This test is the opponent. It listens on a real socket and answers over
 * plain HTTP as the other player, and requires that the verdict and the new
 * snapshot reach the listener exactly as they would have from the socket path.
 *
 * Run: npx tsx src/tests/httpAnswerBroadcast.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApiServer } from '../app.js';
import { createMatchForPlayers, startMatch, getMatch } from '../services/matchEngine.js';
import { createSession } from '../services/sessionService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/* A real row in the user table — createSession only mints a token for an id. */
async function player(name: string): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'n_' + userId.slice(0, 6),
    displayName: name, plan: 'premium', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const server = createApiServer({ attachRealtime: true });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}/v1`;

  try {
    /* Two real players, a real match, and the SECOND one listening on a socket
       the way a phone with working internet does. */
    const a = await player('A');
    const b = await player('B');
    const sa = createSession(a);
    const sb = createSession(b);

    /* A question the answer can actually be validated against, so the verdict
       the opponent receives is a real one. */
    await repositories.questions.save({
      id: 'q-http-1', category: 'عمومی', difficulty: 'easy', text: 'پایتخت ایران؟',
      options: ['تهران', 'شیراز', 'اصفهان', 'تبریز'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);

    const match = await createMatchForPlayers(a, b, 'duel', 'free', 0);
    await startMatch(match.id);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime?token=${encodeURIComponent(sb.accessToken)}`);
    await once(ws, 'open');
    const seen: any[] = [];
    ws.on('message', (raw) => { try { seen.push(JSON.parse(String(raw))); } catch { /* not ours */ } });
    ws.send(JSON.stringify({ type: 'client:join_match', payload: { matchId: match.id } }));
    await waitFor(() => seen.some((m) => m.type === 'server:presence' || m.type === 'server:match_snapshot'));

    /* Player A has no usable socket, so the answer goes over HTTP — exactly
       what the client does when a pong has not come back. */
    const live = await getMatch(match.id);
    const round = live!.round;
    const questionId = 'q-http-1';
    seen.length = 0;
    const res = await fetch(`${base}/matches/${match.id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sa.accessToken}` },
      body: JSON.stringify({ questionId, selectedIndex: 0, round, answerTimeMs: 1200, idempotencyKey: `a-${match.id}-${a}-${round}-0` })
    });
    const payload = await res.json() as any;

    await check('the answer is accepted over plain HTTP', () => {
      assert.equal(res.status, 200, 'status ' + res.status + ' ' + JSON.stringify(payload));
      assert.equal(payload.ok, true);
    });

    await check('and the opponent is told about it on their socket', async () => {
      await waitFor(() => seen.some((m) => m.type === 'server:answer_result'));
      const ev = seen.find((m) => m.type === 'server:answer_result');
      assert.equal(ev.payload.userId, a, 'whose answer: ' + ev.payload.userId);
      assert.equal(Number(ev.payload.round), round, 'round ' + ev.payload.round);
      assert.equal(ev.payload.questionId, questionId);
    });

    await check('with the option they picked, so the board can be drawn', () => {
      const ev = seen.find((m) => m.type === 'server:answer_result');
      assert.equal(Number(ev.payload.selectedIndex), 0);
      assert.equal(typeof ev.payload.correct, 'boolean');
    });

    await check('and the new state of the match follows it', async () => {
      await waitFor(() => seen.some((m) => m.type === 'server:match_snapshot'));
      const snap = seen.filter((m) => m.type === 'server:match_snapshot').pop();
      assert.equal(snap.payload.matchId, match.id);
      assert.ok(Array.isArray(snap.payload.players), 'players missing');
    });

    /* The same answer twice — which is what the client does when the socket
       swallowed the first copy — must not be counted twice. */
    await check('the same answer sent twice is still one answer', async () => {
      const before = (await getMatch(match.id))!;
      const scoreBefore = before.players.find((p: any) => p.userId === a)?.score ?? 0;
      const again = await fetch(`${base}/matches/${match.id}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sa.accessToken}` },
        body: JSON.stringify({ questionId, selectedIndex: 0, round, answerTimeMs: 1200, idempotencyKey: `a-${match.id}-${a}-${round}-0` })
      });
      const body = await again.json() as any;
      assert.equal(body.ok, true);
      assert.equal(body.data.duplicate, true, 'the server did not recognise the repeat');
      const after = (await getMatch(match.id))!;
      const scoreAfter = after.players.find((p: any) => p.userId === a)?.score ?? 0;
      assert.equal(scoreAfter, scoreBefore, 'scored twice: ' + scoreBefore + ' → ' + scoreAfter);
    });

    ws.close();
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

await main();
