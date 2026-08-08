/* A HELP THAT IS REFUSED MUST COST NOTHING.
 *
 * The client used to debit the stock first and only then ask the room to act.
 * Every refusal — wrong phase, already answered, no question yet — therefore
 * took a help the player had bought and gave nothing back, and because the
 * debit also claims a once-per-round slot, tapping again answered «قبلاً
 * استفاده کرده‌ای». The charge now happens inside the room's own call, after
 * it has agreed the help can be used.
 *
 * Run: npx tsx src/tests/lsLifelineCharge.test.ts
 */
import assert from 'node:assert/strict';
import { useLifeline, advanceRoom } from '../services/lastSurvivorWorker.js';
import { getRoom, saveRoom, getPlayer, savePlayer, joinTopic } from '../services/lastSurvivorService.js';
import { updateConfig, RANDOM_TOPIC } from '../services/lastSurvivorConfig.js';
import { grantTickets } from '../services/ticketService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

const TOPIC = RANDOM_TOPIC;

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let n = 0;
async function player(): Promise<string> {
  const uid = 'lf' + (++n) + '-' + Math.random().toString(36).slice(2, 8);
  await repositories.users.save({
    id: uid, username: 'lf' + n, displayName: 'lf' + n, phone: '09' + String(400000000 + n),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(uid, 'green', 1);
  return uid;
}

/* A charge that records every time it is called, so "was the player charged?"
   is a fact rather than an inference. */
function meter() {
  const calls: number[] = [];
  return { calls, fn: async (round: number) => { calls.push(round); return { remaining: 9 - calls.length }; } };
}

async function seedQuestions(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await repositories.questions.save({
      id: id(), category: 'اطلاعات عمومی', difficulty: 'easy', text: 'س' + i,
      options: ['الف', 'ب', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
}

/** Walk a fresh room forward until it is actually asking a question. */
async function runningRoom(): Promise<{ roomId: string; uid: string }> {
  await updateConfig({ room: { capacity: 3, minUsers: 3, waitSeconds: 0, manualStartEnabled: false, startPct: 70 } });
  const uid = await player(), k1 = await player(), k2 = await player();
  const j = await joinTopic({ id: uid, username: 'lf' } as any, TOPIC, 'green');
  await joinTopic({ id: k1, username: 'k1' } as any, TOPIC, 'green');
  await joinTopic({ id: k2, username: 'k2' } as any, TOPIC, 'green');
  const roomId = j.room.id;
  await advanceRoom((await getRoom(roomId))!);
  for (let i = 0; i < 12; i++) {
    const r = (await getRoom(roomId))!;
    if (r.phase === 'question') break;
    r.phaseEndsAt = 0; await saveRoom(r);
    await advanceRoom((await getRoom(roomId))!);
  }
  return { roomId, uid };
}

async function run(): Promise<void> {
  await seedQuestions();

  await check('a help refused because the room is not in a question is not charged', async () => {
    const { roomId, uid } = await runningRoom();
    const room = (await getRoom(roomId))!;
    room.phase = 'elimination';                  // the reveal, not the question
    await saveRoom(room);
    const m = meter();
    const r = await useLifeline(roomId, uid, '5050', m.fn);
    assert.equal(r.ok, false, 'the room refuses');
    assert.equal(r.reason, 'NOT_IN_QUESTION');
    assert.deepEqual(m.calls, [], 'and nothing was taken from the stock');
  });

  await check('a help refused because the player already answered is not charged', async () => {
    const { roomId, uid } = await runningRoom();
    const room = (await getRoom(roomId))!;
    const p = (await getPlayer(roomId, uid))!;
    p.answerRound = room.round;
    await savePlayer(p);
    const m = meter();
    const r = await useLifeline(roomId, uid, 'stats', m.fn);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'ALREADY_ANSWERED');
    assert.deepEqual(m.calls, [], 'no charge');
  });

  await check('a help refused because there is no question yet is not charged', async () => {
    const { roomId, uid } = await runningRoom();
    const room = (await getRoom(roomId))!;
    room.questionId = null as any; room.correctIndex = null as any;
    await saveRoom(room);
    const m = meter();
    const r = await useLifeline(roomId, uid, '5050', m.fn);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_QUESTION');
    assert.deepEqual(m.calls, [], 'no charge');
  });

  await check('an unknown help is not charged', async () => {
    const { roomId, uid } = await runningRoom();
    const m = meter();
    const r = await useLifeline(roomId, uid, 'teleport', m.fn);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'UNKNOWN_LIFELINE');
    assert.deepEqual(m.calls, [], 'no charge');
  });

  await check('«درصد بقیه» on a question nobody has answered is free', async () => {
    /* Four bars all reading ۰٪ is not a hint. Charging a bought help for it is
       charging for nothing. */
    const { roomId, uid } = await runningRoom();
    const room = (await getRoom(roomId))!;
    const qid = id();
    await repositories.questions.save({
      id: qid, category: 'اطلاعات عمومی', difficulty: 'easy', text: 'سؤال دست‌نخورده',
      options: ['الف', 'ب', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
    room.questionId = qid;
    room.correctIndex = 0;
    await saveRoom(room);
    const m = meter();
    const r = await useLifeline(roomId, uid, 'stats', m.fn);
    assert.equal(r.ok, true, 'it answers rather than erroring');
    assert.equal(r.sample, 0);
    assert.equal(r.charged, false, 'and says plainly that it was not charged');
    assert.deepEqual(m.calls, [], 'so the stock is untouched');
  });

  await check('a help that IS delivered charges exactly once', async () => {
    const { roomId, uid } = await runningRoom();
    const m = meter();
    const r = await useLifeline(roomId, uid, '5050', m.fn);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.removeIndexes) && r.removeIndexes.length === 2, 'two wrong options go');
    assert.equal(m.calls.length, 1, 'charged once');
    assert.equal(r.remaining, 8, 'and the new stock count comes back for the header');
    assert.equal(r.charged, true);
  });

  await check('the charge happens with the round the room is actually on', async () => {
    /* The once-per-round slot is keyed on it; charging against the wrong round
       would let the same help be spent twice in one question. */
    const { roomId, uid } = await runningRoom();
    const room = (await getRoom(roomId))!;
    room.round = 7; await saveRoom(room);
    const m = meter();
    await useLifeline(roomId, uid, '5050', m.fn);
    assert.deepEqual(m.calls, [7]);
  });

  await check('arming the second chance twice does not charge twice', async () => {
    const { roomId, uid } = await runningRoom();
    const m = meter();
    const first = await useLifeline(roomId, uid, 'second', m.fn);
    assert.equal(first.ok, true);
    assert.equal(first.armed, true);
    const again = await useLifeline(roomId, uid, 'second', m.fn);
    assert.equal(again.ok, false, 'the second tap is refused');
    assert.equal(m.calls.length, 1, 'and only the first one cost anything');
  });

  await check('if the stock refuses, the room applies nothing', async () => {
    /* The charge throwing is how «نداری» arrives. It must propagate, and the
       second chance must NOT end up armed for free. */
    const { roomId, uid } = await runningRoom();
    const boom = async () => { throw new Error('LIFELINE_EMPTY'); };
    await assert.rejects(() => useLifeline(roomId, uid, 'second', boom as any), /LIFELINE_EMPTY/);
    // A later, funded attempt must still be able to arm it.
    const m = meter();
    const r = await useLifeline(roomId, uid, 'second', m.fn);
    assert.equal(r.armed, true, 'the failed attempt left nothing armed behind it');
    assert.equal(m.calls.length, 1);
  });

  console.log(`[lsLifelineCharge] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
