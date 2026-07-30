/* LAST SURVIVOR integration — drives a full match through the orchestrator in
 * memory (no DB, no real timers): join → start → answer → eliminate → cash-out →
 * final split. Verifies real ticket consumption, wallet payouts, and exact
 * money conservation. Run: npx tsx src/tests/lastSurvivor.test.ts */
import assert from 'node:assert';
import { repositories } from '../repositories/index.js';
import { grantTickets, getTickets } from '../services/ticketService.js';
import { getAccount } from '../services/walletLedgerService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, snapshot } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer, submitDecision } from '../services/lastSurvivorWorker.js';

const TOPIC = 'اطلاعات عمومی';
let passed = 0; const ok = (n: string) => { console.log('✔', n); passed++; };

async function forceExpire(roomId: string) { const r = (await getRoom(roomId))!; r.phaseEndsAt = 0; await saveRoom(r); }

(async () => {
  // Small room so 3 joiners fill it and it starts instantly.
  await updateConfig({ room: { capacity: 3, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 }, match: { totalRounds: 5, questionsPerRound: 1, minSurvivors: 1 }, topics: { [TOPIC]: { enabled: true } } });

  // Seed approved questions for the topic (correctIndex = 0 for all → easy to control).
  for (let i = 0; i < 6; i++) {
    await repositories.questions.save({ id: 'lsq' + i, category: TOPIC, difficulty: 'easy', text: 'سوال ' + i, options: ['درست', 'غلط', 'گزینه۳', 'گزینه۴'], correctIndex: 0, tags: [], status: 'approved', version: 1 } as any);
  }

  // Three players, one of each colour.
  const users = [
    { id: 'lsG', color: 'green', username: 'سبز' },
    { id: 'lsB', color: 'blue', username: 'آبی' },
    { id: 'lsR', color: 'red', username: 'قرمز' }
  ];
  for (const u of users) {
    await repositories.users.save({ id: u.id, username: u.username, displayName: u.username, wallet: 0, coins: 0, xp: 0, level: 1, createdAt: new Date().toISOString() } as any);
    await grantTickets(u.id, u.color, 1);
  }

  // ---- join: consumes a ticket, builds the pot ----
  let roomId = '';
  for (const u of users) { const snap = await joinTopic({ id: u.id, username: u.username }, TOPIC, u.color); roomId = snap.room.id; }
  for (const u of users) assert.equal((await getTickets(u.id))[u.color] ?? 0, 0); // ticket consumed
  let room = (await getRoom(roomId))!;
  assert.equal(room.grossPool, 87500); // 12500+25000+50000
  ok('join consumes one real ticket each and builds the 87,500 pot');

  // ---- start: capacity full → running, round 1 question ----
  await advanceRoom(room, Date.now());
  room = (await getRoom(roomId))!;
  assert.equal(room.status, 'running');
  assert.equal(room.phase, 'question');
  assert.equal(room.round, 1);
  assert.ok(room.questionId);
  ok('room fills to capacity and starts round 1 automatically');

  // ---- answers: green wrong, blue+red correct (correctIndex is 0) ----
  assert.equal(room.correctIndex, 0);
  assert.equal((await submitAnswer(roomId, 'lsG', 1, 2)).accepted, true); // wrong
  assert.equal((await submitAnswer(roomId, 'lsB', 1, 0)).accepted, true); // right
  assert.equal((await submitAnswer(roomId, 'lsR', 1, 0)).accepted, true); // right
  // A second answer must not overwrite the first (anti-cheat idempotency).
  await submitAnswer(roomId, 'lsG', 1, 0);
  ok('answers accepted once per round (first answer stands)');

  // ---- grade → elimination: green out, only green sees the correct answer ----
  await forceExpire(roomId); await advanceRoom((await getRoom(roomId))!, Date.now());
  room = (await getRoom(roomId))!;
  assert.equal(room.phase, 'elimination');
  const gSnap = await snapshot(roomId, 'lsG');
  assert.equal(gSnap.me.status, 'eliminated');
  assert.equal(gSnap.me.reveal.correctIndex, 0);          // private reveal for the eliminated player
  const rSnap = await snapshot(roomId, 'lsR');
  assert.equal(rSnap.me.status, 'alive');
  assert.equal(rSnap.me.reveal, undefined);               // survivors never see the correct index
  ok('wrong/no answer is eliminated; correct answer revealed only to the eliminated');

  // ---- elimination → dashboard → cashout ----
  await forceExpire(roomId); await advanceRoom((await getRoom(roomId))!, Date.now()); // → dashboard
  assert.equal((await getRoom(roomId))!.phase, 'dashboard');
  await forceExpire(roomId); await advanceRoom((await getRoom(roomId))!, Date.now()); // → cashout (2 alive > 1)
  assert.equal((await getRoom(roomId))!.phase, 'cashout');
  ok('survivors advance through dashboard into the cash-out window');

  // ---- decisions: blue cashes out, red continues → red is last survivor ----
  assert.equal((await submitDecision(roomId, 'lsB', 1, 'cashout')).accepted, true);
  assert.equal((await submitDecision(roomId, 'lsR', 1, 'continue')).accepted, true);
  await forceExpire(roomId); await advanceRoom((await getRoom(roomId))!, Date.now());
  room = (await getRoom(roomId))!;
  assert.equal(room.status, 'finished'); // red alone (<= minSurvivors) → match ends
  ok('cash-out processed; last remaining survivor ends the match');

  // ---- money: blue share + red final == net pot, credited to real wallets ----
  const blue = (await getAccount('lsB')).available;
  const red = (await getAccount('lsR')).available;
  const green = (await getAccount('lsG')).available;
  assert.equal(green, 0);                 // eliminated → nothing
  assert.equal(blue, 29166);              // floor(87500 * 2/6)
  assert.equal(red, 87500 - 29166);       // last survivor takes the rest
  assert.equal(blue + red + green, 87500);// conservation: nothing created or lost
  ok('payouts hit real wallets and conserve the pot exactly (blue 29,166 + red 58,334)');

  console.log(`\nALL LAST SURVIVOR INTEGRATION TESTS PASSED (${passed})`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
