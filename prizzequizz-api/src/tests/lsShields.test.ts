/* LAST SURVIVOR — shields, the extra lives a ticket colour buys.
 *
 * Green has none and behaves as it always did: one wrong answer, out. Blue
 * carries one, red carries two — a wrong answer spends a shield instead of a
 * place, so red survives two mistakes and goes out on the third.
 *
 * Run: npx tsx src/tests/lsShields.test.ts
 */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { getConfig, updateConfig } from '../services/lastSurvivorConfig.js';
import { ticketShields } from '../services/lastSurvivorPrize.js';
import { joinTopic, getRoom, saveRoom, getPlayer, listPlayers } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer } from '../services/lastSurvivorWorker.js';

const TOPIC = 'اطلاعات عمومی';
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let n = 0;
async function player(color: string): Promise<string> {
  const id = 'sh' + (++n) + '-' + Math.random().toString(36).slice(2, 8);
  await repositories.users.save({
    id, username: 'p' + n, displayName: 'p' + n, phone: '09' + String(300000000 + n),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(id, color, 1);
  return id;
}

/* Drive one round to its verdict: everyone answers WRONG (index 1; every seeded
 * question has correctIndex 0), then the question phase is expired so the
 * orchestrator grades it. */
let keepers: string[] = [];

/** Walk the room forward until it is actually asking a question. */
async function reachQuestion(roomId: string): Promise<number | null> {
  for (let i = 0; i < 12; i++) {
    const r = (await getRoom(roomId))!;
    if (r.status !== 'running') return null;
    if (r.phase === 'question') return r.round;
    r.phaseEndsAt = 0; await saveRoom(r);
    await advanceRoom((await getRoom(roomId))!);
  }
  return null;
}

/* Play one round where `users` answer WRONG and the keepers answer right, then
 * expire the question so the orchestrator grades it. Answers are only accepted
 * during the question phase — a room that has just started is in 'ready', which
 * is why this waits for the right phase instead of assuming it. */
async function playWrongRound(roomId: string, users: string[]): Promise<void> {
  const round = await reachQuestion(roomId);
  if (round == null) return;
  for (const u of users) {
    const p = await getPlayer(roomId, u);
    if (p && p.status === 'alive') await submitAnswer(roomId, u, round, 1);
  }
  for (const u of keepers) {
    const p = await getPlayer(roomId, u);
    if (p && p.status === 'alive') await submitAnswer(roomId, u, round, 0);
  }
  const r = (await getRoom(roomId))!;
  r.phaseEndsAt = 0; await saveRoom(r);
  await advanceRoom((await getRoom(roomId))!);      // question → elimination: graded here
}

async function run(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await repositories.questions.save({
      id: 'shq' + i, category: TOPIC, difficulty: ['easy', 'medium', 'hard', 'veryhard'][i % 4],
      text: 'س' + i, options: ['درست', 'غلط', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  await updateConfig({
    room: { capacity: 3, minUsers: 3, waitSeconds: 0, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 12, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  });

  await check('the colours carry the shields the rules say', async () => {
    const cfg = await getConfig();
    assert.equal(ticketShields(cfg, 'green'), 0, 'green: no shield');
    assert.equal(ticketShields(cfg, 'blue'), 1, 'blue: one shield');
    assert.equal(ticketShields(cfg, 'red'), 2, 'red: two shields');
  });

  await check('joining stamps the shields onto the player', async () => {
    const g = await player('green'), b = await player('blue'), r = await player('red');
    const j = await joinTopic({ id: g, username: 'g' }, TOPIC, 'green');
    await joinTopic({ id: b, username: 'b' }, TOPIC, 'blue');
    await joinTopic({ id: r, username: 'r' }, TOPIC, 'red');
    const roomId = j.room.id;
    assert.equal((await getPlayer(roomId, g))!.shields, 0);
    assert.equal((await getPlayer(roomId, b))!.shields, 1);
    assert.equal((await getPlayer(roomId, r))!.shields, 2);
  });

  await check('a wrong answer spends a shield before it takes a place', async () => {
    /* Two extra players answer CORRECTLY every round. Without them the subject
       becomes the last one standing and the match ends before the third
       mistake can be made — which is the rule working, not a shield bug. */
    await updateConfig({ room: { capacity: 5, minUsers: 5, waitSeconds: 0, manualStartEnabled: false, startPct: 70 } });
    const g = await player('green'), b = await player('blue'), r = await player('red');
    const k1 = await player('green'), k2 = await player('green');
    const j = await joinTopic({ id: g, username: 'g' }, TOPIC, 'green');
    await joinTopic({ id: b, username: 'b' }, TOPIC, 'blue');
    await joinTopic({ id: r, username: 'r' }, TOPIC, 'red');
    await joinTopic({ id: k1, username: 'k1' }, TOPIC, 'green');
    await joinTopic({ id: k2, username: 'k2' }, TOPIC, 'green');
    const roomId = j.room.id;
    await advanceRoom((await getRoom(roomId))!);          // capacity 5 → starts
    assert.equal((await getRoom(roomId))!.status, 'running');
    keepers = [k1, k2];

    // ---- first wrong answer
    await playWrongRound(roomId, [g, b, r]);
    assert.equal((await getPlayer(roomId, g))!.status, 'eliminated', 'green has no shield — out at once');
    assert.equal((await getPlayer(roomId, b))!.status, 'alive', 'blue spends its shield');
    assert.equal((await getPlayer(roomId, b))!.shields, 0);
    assert.equal((await getPlayer(roomId, r))!.status, 'alive', 'red spends one of two');
    assert.equal((await getPlayer(roomId, r))!.shields, 1);

    // ---- second wrong answer
    await playWrongRound(roomId, [b, r]);
    assert.equal((await getPlayer(roomId, b))!.status, 'eliminated', 'blue is out of shields — out');
    assert.equal((await getPlayer(roomId, r))!.status, 'alive', 'red still has one left');
    assert.equal((await getPlayer(roomId, r))!.shields, 0);

    // ---- third wrong answer
    await playWrongRound(roomId, [r]);
    assert.equal((await getPlayer(roomId, r))!.status, 'eliminated', 'red goes out on the third mistake');
  });

  keepers = [];
  await check('a correct answer never costs a shield', async () => {
    await updateConfig({ room: { capacity: 3, minUsers: 3, waitSeconds: 0, manualStartEnabled: false, startPct: 70 } });
    const a = await player('red'), b = await player('red'), c = await player('red');
    const j = await joinTopic({ id: a, username: 'a' }, TOPIC, 'red');
    await joinTopic({ id: b, username: 'b' }, TOPIC, 'red');
    await joinTopic({ id: c, username: 'c' }, TOPIC, 'red');
    const roomId = j.room.id;
    await advanceRoom((await getRoom(roomId))!);
    const rd = await reachQuestion(roomId);
    assert.ok(rd != null, 'the room should reach a question');
    for (const u of [a, b, c]) await submitAnswer(roomId, u, rd!, 0);   // 0 is correct
    const r = (await getRoom(roomId))!; r.phaseEndsAt = 0; await saveRoom(r);
    await advanceRoom((await getRoom(roomId))!);
    for (const u of [a, b, c]) {
      const p = (await getPlayer(roomId, u))!;
      assert.equal(p.status, 'alive');
      assert.equal(p.shields, 2, 'shields are untouched by a right answer');
    }
  });

  await check('the snapshot tells the client how many shields are left', async () => {
    const a = await player('blue'), b = await player('blue'), c = await player('blue');
    const j = await joinTopic({ id: a, username: 'a' }, TOPIC, 'blue');
    await joinTopic({ id: b, username: 'b' }, TOPIC, 'blue');
    await joinTopic({ id: c, username: 'c' }, TOPIC, 'blue');
    const { snapshot } = await import('../services/lastSurvivorService.js');
    const snap = await snapshot(j.room.id, a);
    const me = snap.players.find((p: any) => p.userId === a);
    assert.ok(me, 'the player should be in the snapshot');
    assert.equal(me.shields, 1, 'a blue ticket shows one shield');
  });

  await check('an older room with no shields behaves exactly as before', async () => {
    /* Rooms already in flight when this shipped have shields = 0 on every row,
       which must mean the old rule: one wrong answer, out. */
    const a = await player('red'), b = await player('red'), c = await player('red');
    const j = await joinTopic({ id: a, username: 'a' }, TOPIC, 'red');
    await joinTopic({ id: b, username: 'b' }, TOPIC, 'red');
    await joinTopic({ id: c, username: 'c' }, TOPIC, 'red');
    const roomId = j.room.id;
    for (const u of [a, b, c]) {
      const { savePlayer } = await import('../services/lastSurvivorService.js');
      const p = (await getPlayer(roomId, u))!;
      p.shields = 0; await savePlayer(p);
    }
    await advanceRoom((await getRoom(roomId))!);
    await playWrongRound(roomId, [a, b, c]);
    const out = (await listPlayers(roomId)).filter((p) => p.status === 'eliminated').length;
    assert.equal(out, 3, 'with no shields, one wrong answer is the end');
  });

  console.log(`[lsShields] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
