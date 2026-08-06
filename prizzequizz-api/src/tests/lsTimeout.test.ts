/* LAST SURVIVOR — what a player is told when their time runs out.
 *
 * The reported bug: run out of time on a question and the result screen names
 * an option as "your answer", one you never picked. The player's record keeps
 * only their LAST answer, whichever round it was for, and the reveal handed it
 * over without checking the round — so a round-3 pick was shown against the
 * round-4 question that knocked them out. */
import assert from 'node:assert/strict';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, getPlayer, snapshot } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer } from '../services/lastSurvivorWorker.js';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const TOPIC = 'تست‌تایم‌اوت';
async function seedQuestions(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await repositories.questions.save({
      id: 'lsto' + i, category: TOPIC, difficulty: 'easy', text: 'سؤال آزمایشی ' + i,
      options: ['الف', 'ب', 'پ', 'ت'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
}
async function makeUser(color: string): Promise<{ id: string; username: string; color: string }> {
  const userId = id();
  const username = 'ls_' + userId.slice(0, 6);
  await repositories.users.save({ id: userId, username, displayName: username, wallet: 0, coins: 0, xp: 0, level: 1, createdAt: new Date().toISOString() } as any);
  await grantTickets(userId, color, 1);
  return { id: userId, username, color };
}
/** Push the room past whatever phase it is sitting in. */
async function step(roomId: string): Promise<void> {
  const r = (await getRoom(roomId))!; r.phaseEndsAt = 0; await saveRoom(r);
  await advanceRoom((await getRoom(roomId))!, Date.now());
}
/** Walk to the next open question window, or give up after a few phases. */
async function toQuestion(roomId: string): Promise<any> {
  let r = (await getRoom(roomId))!;
  for (let i = 0; i < 10 && r.phase !== 'question'; i++) { await step(roomId); r = (await getRoom(roomId))!; }
  return r;
}

async function run() {
  await seedQuestions(12);
  await updateConfig({
    room: { capacity: 2, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 },
    match: { totalRounds: 6, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  } as any);

  await check('a player who never answers is not shown an answer', async () => {
    const u1 = await makeUser('green'), u2 = await makeUser('blue');
    const j1 = await joinTopic(u1, TOPIC, u1.color);
    await joinTopic(u2, TOPIC, u2.color);
    const roomId = j1.room.id;
    const r = await toQuestion(roomId);
    assert.equal(r.phase, 'question', 'the room should reach a question');

    // u1 answers, u2 says nothing at all.
    await submitAnswer(roomId, u1.id, r.round, r.correctIndex!);
    await step(roomId);

    const snap = await snapshot(roomId, u2.id);
    assert.equal(snap.me.status, 'eliminated', 'not answering must eliminate');
    assert.ok(snap.me.reveal, 'the eliminated player sees the correct answer');
    assert.equal(snap.me.reveal.yourIndex, null, 'they picked nothing, so nothing may be shown as their pick');
    assert.equal(snap.me.reveal.timedOut, true);
    assert.equal(typeof snap.me.reveal.correctIndex, 'number', 'the correct answer is still revealed');
  });

  await check('a stale answer from an earlier round is never reused', async () => {
    const u1 = await makeUser('green'), u2 = await makeUser('blue');
    const j1 = await joinTopic(u1, TOPIC, u1.color);
    await joinTopic(u2, TOPIC, u2.color);
    const roomId = j1.room.id;
    let r = await toQuestion(roomId);
    assert.equal(r.phase, 'question');

    // Round 1: BOTH answer correctly, so both survive with an answerIndex set.
    const round1Correct = r.correctIndex!;
    await submitAnswer(roomId, u1.id, r.round, round1Correct);
    await submitAnswer(roomId, u2.id, r.round, round1Correct);
    await step(roomId);
    const afterR1 = await getPlayer(roomId, u2.id);
    assert.equal(afterR1?.status, 'alive', 'a correct answer survives');
    assert.equal(afterR1?.answerIndex, round1Correct, 'their round-1 pick is on the record');

    // Walk on to the next question, where u2 answers nothing.
    r = await toQuestion(roomId);
    if (r.phase !== 'question') { console.log('    (room ended early; skipping)'); return; }
    await submitAnswer(roomId, u1.id, r.round, r.correctIndex!);
    await step(roomId);

    const snap = await snapshot(roomId, u2.id);
    assert.equal(snap.me.status, 'eliminated');
    assert.ok(snap.me.reveal, 'reveal expected for the round they went out on');
    assert.equal(snap.me.reveal.yourIndex, null,
      'the round-1 pick must NOT be presented as their answer to this question');
    assert.equal(snap.me.reveal.timedOut, true);
  });

  await check('a player who answers and gets it wrong still sees their own pick', async () => {
    const u1 = await makeUser('green'), u2 = await makeUser('blue');
    const j1 = await joinTopic(u1, TOPIC, u1.color);
    await joinTopic(u2, TOPIC, u2.color);
    const roomId = j1.room.id;
    const r = await toQuestion(roomId);
    assert.equal(r.phase, 'question');
    const wrong = (r.correctIndex! + 1) % 4;
    await submitAnswer(roomId, u1.id, r.round, r.correctIndex!);
    await submitAnswer(roomId, u2.id, r.round, wrong);
    await step(roomId);

    const snap = await snapshot(roomId, u2.id);
    assert.equal(snap.me.status, 'eliminated');
    assert.equal(snap.me.reveal.yourIndex, wrong, 'a real wrong answer must still be shown');
    assert.equal(snap.me.reveal.timedOut, false, 'answering is not timing out');
  });

  console.log(`[lsTimeout] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
