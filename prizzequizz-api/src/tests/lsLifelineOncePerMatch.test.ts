/* ONE OF EACH HELP, PER MATCH — NOT PER ROUND.
 *
 * The room endpoint spent the help against the scope `ls:{room}:{round}`, and
 * «already used in this scope» is what stops a second use. With the round in the
 * key that meant once per ROUND: a player holding stock could fire 50:50 on
 * every question of a twelve-round match. That is not a help any more, it is the
 * answer, and in a mode where a wrong answer costs a real ticket and a share of
 * a real pot it is the difference between a game and a purchase.
 *
 * This drives the REAL endpoint rather than the worker's `charge` seam, because
 * the scope string is the whole bug and the seam does not see it.
 *
 * Run: npx tsx src/tests/lsLifelineOncePerMatch.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { grantLifeline, inventoryFor } from '../services/lifelineService.js';
import { updateConfig, RANDOM_TOPIC } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, snapshot } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer } from '../services/lastSurvivorWorker.js';
import { signAccessToken } from '../services/tokenService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let base = '';
async function post(path: string, token: string, body: unknown): Promise<{ status: number; body: any; code: string }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { status: res.status, body: j?.data ?? j, code: j?.error?.code ?? '' };
}

let n = 0;
async function player(): Promise<{ uid: string; token: string }> {
  const uid = 'll' + (++n) + '-' + id().slice(0, 6);
  await repositories.users.save({
    id: uid, username: 'll' + n, displayName: 'll' + n, phone: '099' + String(1000000 + n),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(uid, 'green', 1);
  /* Plenty of stock, so that running out can never be mistaken for the rule
     under test doing its job. */
  for (const k of ['p5050', 'psecond', 'pstats']) await grantLifeline(uid, k, 9);
  return { uid, token: signAccessToken(uid) };
}

async function seedQuestions(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await repositories.questions.save({
      id: id(), category: 'اطلاعات عمومی', difficulty: (['easy', 'medium', 'hard', 'veryhard'] as const)[i % 4],
      text: 'کمکی ' + i, options: ['الف', 'ب', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
}

/** Walk the room forward until a question is open. */
async function toQuestion(roomId: string): Promise<void> {
  for (let i = 0; i < 14; i++) {
    const r = (await getRoom(roomId))!;
    if (r.phase === 'question') return;
    r.phaseEndsAt = 0; await saveRoom(r);
    await advanceRoom((await getRoom(roomId))!);
  }
  throw new Error('the room never opened a question');
}
/** Everyone answers CORRECTLY, so the match keeps going and the next question
 *  opens. A round nobody answers eliminates the whole room on a green ticket. */
async function nextRound(roomId: string, everyone: string[]): Promise<void> {
  const open = (await getRoom(roomId))!;
  const from = open.round;
  if (open.phase === 'question' && open.correctIndex != null) {
    for (const uid of everyone) await submitAnswer(roomId, uid, open.round, open.correctIndex);
  }
  for (let i = 0; i < 20; i++) {
    const r = (await getRoom(roomId))!;
    if (r.status !== 'running') throw new Error('the room ended at round ' + r.round);
    if (r.round > from && r.phase === 'question') return;
    r.phaseEndsAt = 0; await saveRoom(r);
    await advanceRoom((await getRoom(roomId))!);
  }
  throw new Error('the room never reached the next question');
}

async function newMatch(): Promise<{ roomId: string; me: { uid: string; token: string }; everyone: string[] }> {
  await updateConfig({
    room: { capacity: 3, minUsers: 3, waitSeconds: 0, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 10, questionsPerRound: 1, minSurvivors: 1 }
  } as any);
  const me = await player(), a = await player(), b = await player();
  const j = await joinTopic({ id: me.uid, username: 'me' } as any, RANDOM_TOPIC, 'green');
  await joinTopic({ id: a.uid, username: 'a' } as any, RANDOM_TOPIC, 'green');
  await joinTopic({ id: b.uid, username: 'b' } as any, RANDOM_TOPIC, 'green');
  const roomId = j.room.id;
  await advanceRoom((await getRoom(roomId))!);
  await toQuestion(roomId);
  return { roomId, me, everyone: [me.uid, a.uid, b.uid] };
}

async function run(): Promise<void> {
  await seedQuestions();
  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

  try {
    await check('50:50 works the first time', async () => {
      const { roomId, me } = await newMatch();
      const r = await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(Array.isArray(r.body.removeIndexes) && r.body.removeIndexes.length >= 1, 'and removes wrong options');
    });

    await check('and is refused for the REST OF THE MATCH, not just that round', async () => {
      /* The reported bug: the round rolled over and the help came back. */
      const { roomId, me, everyone } = await newMatch();
      const first = await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' });
      assert.equal(first.status, 200, 'round 1: ' + JSON.stringify(first.body));

      const again = await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' });
      assert.equal(again.status, 409, 'same round, twice');

      for (let round = 2; round <= 4; round++) {
        await nextRound(roomId, everyone);
        const r = await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' });
        assert.equal(r.status, 409, 'round ' + round + ' let it through again: ' + JSON.stringify(r.body));
        assert.equal(r.code, 'LIFELINE_USED_THIS_MATCH', 'round ' + round + ' code: ' + r.code);
      }
    });

    await check('and the stock is down by exactly one for the whole match', async () => {
      /* Once per round would have taken four. */
      const { roomId, me, everyone } = await newMatch();
      const before = (await inventoryFor(me.uid)).p5050 ?? 0;
      await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' });
      for (let i = 0; i < 3; i++) {
        await nextRound(roomId, everyone);
        await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' });
      }
      const after = (await inventoryFor(me.uid)).p5050 ?? 0;
      assert.equal(before - after, 1, 'four rounds took ' + (before - after) + ' from the stock');
    });

    await check('one of EACH — spending 50:50 does not lock the others', async () => {
      const { roomId, me, everyone } = await newMatch();
      assert.equal((await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' })).status, 200);
      const second = await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: 'second' });
      assert.equal(second.status, 200, 'انتخاب دوم: ' + JSON.stringify(second.body));
      await nextRound(roomId, everyone);
      const stats = await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: 'stats' });
      assert.ok(stats.status === 200, 'درصد بقیه in a later round: ' + JSON.stringify(stats.body));
    });

    await check('a NEW match starts with all three back', async () => {
      /* Per match, not per lifetime. */
      const one = await newMatch();
      assert.equal((await post(`/last-survivor/rooms/${one.roomId}/lifeline`, one.me.token, { type: '5050' })).status, 200);
      const two = await newMatch();
      const r = await post(`/last-survivor/rooms/${two.roomId}/lifeline`, two.me.token, { type: '5050' });
      assert.equal(r.status, 200, 'the next match refused it: ' + JSON.stringify(r.body));
    });

    await check('the room tells the player which ones are gone', async () => {
      /* Otherwise the buttons stay lit and the refusal only arrives after the
         tap — which is how this looked before anyone read the code. */
      const { roomId, me, everyone } = await newMatch();
      await post(`/last-survivor/rooms/${roomId}/lifeline`, me.token, { type: '5050' });
      await nextRound(roomId, everyone);
      const snap = await snapshot(roomId, me.uid);
      assert.ok(Array.isArray(snap.me.lifelinesUsed), 'the snapshot carries the used list');
      assert.ok(snap.me.lifelinesUsed.includes('p5050'), 'including the one just spent: ' + JSON.stringify(snap.me.lifelinesUsed));
      assert.ok(!snap.me.lifelinesUsed.includes('pstats'), 'and not the ones still in hand');
    });

    /* ── the screen the player is looking at ─────────────────────────── */

    function findClient(): string {
      let dir = process.cwd();
      for (let i = 0; i < 5; i++) {
        const p = resolve(dir, 'prizze-v643.html');
        if (existsSync(p)) return p;
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
      throw new Error('prizze-v643.html not found above ' + process.cwd());
    }
    const client = readFileSync(findClient(), 'utf8');

    await check('the client no longer re-lights the buttons every round', async () => {
      const i = client.indexOf('function lsRender(');
      const body = client.slice(i, i + 2600);
      assert.ok(!/phase==='ready'\)\{ lsPuUsed=\{\}/.test(body),
        'the per-round reset of lsPuUsed is still there');
      assert.match(body, /snap\.me\.lifelinesUsed[\s\S]{0,400}lsPuUsed=next/,
        'the used list from the server must drive the buttons');
      assert.match(body, /changed[\s\S]{0,160}lsBindPowerups\(\)/,
        'and the row must repaint when it changes, not at the next round');
    });

    console.log(`[lsLifelineOncePerMatch] ${passed} passed, ${failed} failed`);
  } finally {
    server.close();
  }
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
