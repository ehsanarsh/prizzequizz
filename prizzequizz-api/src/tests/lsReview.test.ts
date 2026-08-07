/* LAST SURVIVOR — reviewing the match afterwards.
 *
 * The duel has always let a player look back at what they were asked, what they
 * picked and what the answer was, and report a bad question from there. Last
 * Survivor could not: the room row holds only the CURRENT question and
 * overwrites it every round, so once a match ended there was no record of what
 * anyone had been asked. Worse, recordAnswerAudit existed but was never called
 * from anywhere — the answers table had never been written on any server.
 *
 * What matters most here is that this does NOT become a cheat sheet, hence the
 * cases about a running match and about somebody who was never in the room.
 *
 * Run: npx tsx src/tests/lsReview.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, getPlayer, listRounds } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer } from '../services/lastSurvivorWorker.js';
import { signAccessToken } from '../services/tokenService.js';
import { id } from '../utils/id.js';

const TOPIC = 'مرور آخرین بازمانده';
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let base = '';
async function api(path: string, token?: string): Promise<{ status: number; body: any; code: string }> {
  const res = await fetch(base + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  const text = await res.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { status: res.status, body: j?.data ?? j, code: j?.error?.code ?? '' };
}

const tokens = new Map<string, string>();
async function player(color: string, name: string): Promise<string> {
  const uid = id();
  await repositories.users.save({ id: uid, username: name, displayName: name, wallet: 0, coins: 0, xp: 0, level: 1, createdAt: new Date().toISOString() } as any);
  await grantTickets(uid, color, 1);
  tokens.set(uid, signAccessToken(uid));
  return uid;
}

/** Walk the room to an open question, answer for everyone, then grade it. */
async function playRound(roomId: string, picks: Record<string, number>): Promise<number | null> {
  for (let i = 0; i < 12; i++) {
    const r = (await getRoom(roomId))!;
    if (r.status !== 'running') return null;
    if (r.phase === 'question') break;
    r.phaseEndsAt = 0; await saveRoom(r);
    await advanceRoom((await getRoom(roomId))!);
  }
  const r = (await getRoom(roomId))!;
  if (r.phase !== 'question') return null;
  for (const [uid, pick] of Object.entries(picks)) {
    const p = await getPlayer(roomId, uid);
    if (p && p.status === 'alive' && pick >= 0) await submitAnswer(roomId, uid, r.round, pick);
  }
  const rr = (await getRoom(roomId))!; rr.phaseEndsAt = 0; await saveRoom(rr);
  await advanceRoom((await getRoom(roomId))!);
  return r.round;
}

async function run(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await repositories.questions.save({
      id: 'rv' + i, category: TOPIC, difficulty: ['easy', 'medium', 'hard', 'veryhard'][i % 4],
      text: 'سؤال مرور ' + i, options: ['درست', 'غلط', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  await updateConfig({
    room: { capacity: 3, minUsers: 3, waitSeconds: 0, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 10, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  } as any);

  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

  // A room where `loser` goes out in round 1 and the other two keep playing.
  const loser = await player('green', 'بازنده');
  const k1 = await player('green', 'k1'), k2 = await player('green', 'k2');
  const j = await joinTopic({ id: loser, username: 'بازنده' }, TOPIC, 'green');
  await joinTopic({ id: k1, username: 'k1' }, TOPIC, 'green');
  await joinTopic({ id: k2, username: 'k2' }, TOPIC, 'green');
  const roomId = j.room.id;
  await advanceRoom((await getRoom(roomId))!);
  const round1 = await playRound(roomId, { [loser]: 1, [k1]: 0, [k2]: 0 });   // loser picks WRONG
  await playRound(roomId, { [k1]: 0, [k2]: 0 });                              // a round loser never answered

  try {
    await check('every round that was asked is on the record', async () => {
      const rounds = await listRounds(roomId);
      assert.ok(rounds.length >= 2, 'both rounds recorded, got ' + rounds.length);
      assert.equal(rounds[0]!.round, 1);
      assert.ok(rounds[0]!.questionId, 'with the question it asked');
      assert.equal(typeof rounds[0]!.correctIndex, 'number');
      assert.notEqual(rounds[0]!.questionId, rounds[1]!.questionId, 'and a match does not repeat a question');
    });

    await check('an eliminated player can review, and sees their own wrong pick', async () => {
      const r = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(loser));
      assert.equal(r.status, 200, 'review: ' + JSON.stringify(r.body));
      const rd = r.body.rounds.find((x: any) => x.round === round1);
      assert.ok(rd, 'the round they went out on is there');
      assert.equal(rd.correctIndex, 0, 'the correct answer is shown');
      assert.equal(rd.yourIndex, 1, 'and their own pick, not somebody else’s');
      assert.equal(rd.yourCorrect, false);
      assert.equal(rd.timedOut, false, 'they did answer');
      assert.ok(rd.text && rd.options?.length === 4, 'with the question text and options');
      assert.equal(rd.questionId, (await listRounds(roomId))[0]!.questionId, 'and the id the report button needs');
    });

    await check('a round the player never answered reads as a timeout, not a wrong pick', async () => {
      const r = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(loser));
      const later = r.body.rounds.filter((x: any) => x.round > round1!);
      for (const rd of later) {
        assert.equal(rd.yourIndex, null, 'no pick may be invented for them');
        assert.equal(rd.timedOut, true);
      }
    });

    await check('a player still IN the running match cannot review it', async () => {
      const r = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(k1));
      assert.equal(r.status, 409, 'refused while still alive: ' + JSON.stringify(r.body));
      assert.equal(r.code, 'MATCH_RUNNING');
    });

    await check('the CURRENT round is withheld while the room is still running', async () => {
      const room = (await getRoom(roomId))!;
      const r = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(loser));
      for (const rd of r.body.rounds) {
        assert.ok(rd.round < room.round, 'round ' + rd.round + ' is live (room is on ' + room.round + ')');
      }
    });

    await check('somebody who was never in the room gets nothing', async () => {
      const stranger = await player('green', 'غریبه');
      const r = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(stranger));
      assert.equal(r.status, 403);
      assert.equal(r.code, 'NOT_A_PLAYER');
    });

    await check('and neither does an anonymous request', async () => {
      const r = await api(`/last-survivor/rooms/${roomId}/review`);
      assert.equal(r.status, 401);
    });

    await check('once the match is over the whole match is reviewable', async () => {
      const room = (await getRoom(roomId))!;
      room.status = 'finished'; room.phase = 'finished'; room.endedAt = Date.now();
      await saveRoom(room);
      const rounds = await listRounds(roomId);
      const r = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(loser));
      assert.equal(r.status, 200);
      assert.equal(r.body.rounds.length, rounds.length, 'nothing is held back any more');
      const s = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(k1));
      assert.equal(s.status, 200, 'a survivor reviews after the end');
      const first = s.body.rounds.find((x: any) => x.round === round1);
      assert.equal(first.yourIndex, 0, 'and sees their OWN answers, not the other player’s');
      assert.equal(first.yourCorrect, true);
    });

    await check('a review never carries anyone else’s answers', async () => {
      /* The duel shows both players because a duel has two. A hundred-player
         room must not hand every player everyone else's picks. */
      const r = await api(`/last-survivor/rooms/${roomId}/review`, tokens.get(loser));
      const blob = JSON.stringify(r.body);
      assert.ok(!blob.includes(k1), 'another player’s id leaked into the review');
      assert.ok(!blob.includes('answers'), 'there is no per-player answer map to leak');
    });
  } finally {
    server.close();
  }

  console.log(`[lsReview] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
