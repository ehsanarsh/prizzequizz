/* LAST SURVIVOR — the heartbeat must not eat the answer.
 *
 * Reported from a real match: a player with a blue shield answered CORRECTLY,
 * lost the shield anyway, and the post-match review still showed the answer as
 * right. Both statements were true, which is what made it findable.
 *
 * touchPlayer used to fetch the whole player row, set lastSeenAt on it, and
 * hand it to savePlayer — which writes EVERY column. The client polls the room
 * once a second, and that poll calls touchPlayer. Answer in the gap between
 * that read and that write and the answer columns were written back to their
 * pre-answer values. Grading then saw "did not answer", which costs a shield —
 * or, for a player with none, their place. The per-round audit is a separate
 * INSERT, so it kept the truth and the review kept saying "correct".
 *
 * Run: npx tsx src/tests/lsHeartbeatRace.test.ts
 */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import {
  joinTopic, getRoom, saveRoom, getPlayer, savePlayer, touchPlayer, listMyAnswers, listActiveRooms
} from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer } from '../services/lastSurvivorWorker.js';
import { id } from '../utils/id.js';

const TOPIC = 'تست ضربان';
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(color: string): Promise<string> {
  const uid = id();
  /* phone is NOT NULL in Postgres, and this case has to run there. */
  await repositories.users.save({
    /* The full uuid: 'p'+4 chars collides once a run creates enough players,
       and users.username is unique in Postgres. */
    id: uid, username: 'p' + uid, displayName: 'p',
    phone: '09' + String(Math.floor(100000000 + Math.random() * 899999999)),
    wallet: 0, coins: 0, xp: 0, level: 1, plan: 'premium', hearts: 5, weeklyScore: 0,
    createdAt: new Date().toISOString()
  } as any);
  await grantTickets(uid, color, 1);
  return uid;
}

/* joinTopic REUSES any waiting room with space, so a room left open by a
   previous attempt swallows the first player or two and the rest open a new
   one — leaving the players of one "room" split across two. Close everything
   first so each attempt gets a room of its own. */
async function freshRooms(): Promise<void> {
  for (const r of await listActiveRooms()) {
    r.status = 'finished'; r.phase = 'finished'; r.endedAt = Date.now();
    await saveRoom(r);
  }
}

/** A running room of three, sitting on an open question. */
async function room(colors: string[]): Promise<{ roomId: string; ids: string[]; round: number }> {
  await freshRooms();
  const ids: string[] = [];
  let roomId = '';
  for (const c of colors) {
    const uid = await player(c);
    ids.push(uid);
    const j = await joinTopic({ id: uid, username: 'p' }, TOPIC, c);
    roomId = j.room.id;
  }
  await advanceRoom((await getRoom(roomId))!);
  for (let i = 0; i < 12; i++) {
    const r = (await getRoom(roomId))!;
    if (r.phase === 'question') break;
    r.phaseEndsAt = 0; await saveRoom(r);
    await advanceRoom((await getRoom(roomId))!);
  }
  return { roomId, ids, round: (await getRoom(roomId))!.round };
}

/** End the question phase so the orchestrator grades it. */
async function grade(roomId: string): Promise<void> {
  const r = (await getRoom(roomId))!; r.phaseEndsAt = 0; await saveRoom(r);
  await advanceRoom((await getRoom(roomId))!);
}

async function run(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await repositories.questions.save({
      /* A UUID, not 'hb0': the questions table keys on uuid in Postgres, and
         this case has to run there — the in-memory driver shares objects by
         reference, so a "stale" read is never actually stale and the race this
         test exists for cannot happen in it. */
      id: id(), category: TOPIC, difficulty: 'easy', text: 'س' + i,
      options: ['درست', 'غلط', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  await updateConfig({
    room: { capacity: 3, minUsers: 3, waitSeconds: 0, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 10, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  } as any);

  await check('THE BUG: a heartbeat landing on a correct answer must not cost a shield', async () => {
   /* Repeated, because the reproduction is probabilistic: whether the poll's
      read lands before the answer's write depends on how the two queries
      interleave. A single attempt can pass against the broken code by luck; a
      run of them does not. Confirmed by putting the old touchPlayer back — this
      case and the green one below both fail within a few attempts. */
   for (let attempt = 0; attempt < 15; attempt++) {
    const { roomId, ids, round } = await room(['blue', 'green', 'green']);
    const [me] = ids;

    /* The poll and the answer genuinely overlap in flight, which is the only
       way to reproduce this: hand-scripting the two halves around a setImmediate
       does NOT — the ordering happens to come out right and the case passes
       against the broken code, proving nothing. Real concurrency, repeated,
       does. */
    await Promise.all([
      touchPlayer(roomId, me!), touchPlayer(roomId, me!),
      submitAnswer(roomId, me!, round, 0),      // the CORRECT answer
      touchPlayer(roomId, me!), touchPlayer(roomId, me!)
    ]);

    const after = (await getPlayer(roomId, me!))!;
    assert.equal(after.answerRound, round, 'the answer is still on the record');
    assert.equal(after.answerCorrect, true, 'and still correct');

    await grade(roomId);
    const graded = (await getPlayer(roomId, me!))!;
    assert.equal(graded.status, 'alive', 'a correct answer never eliminates');
    assert.equal(graded.shields, 1, 'attempt ' + attempt + ': a correct answer must not cost a shield');
    assert.equal(graded.shieldRound, 0, 'nothing was absorbed, so no shield round is stamped');
   }
  });

  await check('a GREEN player is not eliminated by the same race', async () => {
    /* The shield only made this visible. With no shield to spend, the very same
       lost answer takes the player's place instead. */
   for (let attempt = 0; attempt < 15; attempt++) {
    const { roomId, ids, round } = await room(['green', 'green', 'green']);
    const [me] = ids;
    await Promise.all([
      touchPlayer(roomId, me!),
      submitAnswer(roomId, me!, round, 0),
      touchPlayer(roomId, me!)
    ]);
    await grade(roomId);
    assert.equal((await getPlayer(roomId, me!))!.status, 'alive',
      'attempt ' + attempt + ': answering correctly must keep a green player in the match');
   }
  });

  await check('the heartbeat updates lastSeenAt and touches nothing else', async () => {
    const { roomId, ids, round } = await room(['red', 'green', 'green']);
    const [me] = ids;
    await submitAnswer(roomId, me!, round, 1);          // deliberately WRONG
    const before = { ...(await getPlayer(roomId, me!))! };
    await new Promise((r) => setTimeout(r, 5));
    await touchPlayer(roomId, me!);
    const after = (await getPlayer(roomId, me!))!;
    assert.ok(after.lastSeenAt >= before.lastSeenAt, 'the heartbeat is recorded');
    for (const k of Object.keys(before) as Array<keyof typeof before>) {
      if (k === 'lastSeenAt') continue;
      assert.deepEqual(after[k], before[k], 'the heartbeat changed ' + String(k));
    }
  });

  await check('many heartbeats during answering never lose an answer', async () => {
    /* The real client polls every second while the question is up, so the two
       genuinely overlap. Fired together, repeatedly. */
    for (let attempt = 0; attempt < 12; attempt++) {
      const { roomId, ids, round } = await room(['blue', 'green', 'green']);
      const [me] = ids;
      await Promise.all([
        touchPlayer(roomId, me!),
        submitAnswer(roomId, me!, round, 0),
        touchPlayer(roomId, me!),
        touchPlayer(roomId, me!)
      ]);
      const p = (await getPlayer(roomId, me!))!;
      assert.equal(p.answerCorrect, true, 'attempt ' + attempt + ': the answer survived');
      assert.equal(p.answerRound, round, 'attempt ' + attempt + ': for the right round');
    }
  });

  await check('the record and the grading now agree with each other', async () => {
    /* The contradiction that exposed this: the review read one store and the
       grader read another, and they disagreed. They must not. */
    const { roomId, ids, round } = await room(['blue', 'green', 'green']);
    const [me] = ids;
    await Promise.all([
      touchPlayer(roomId, me!),
      submitAnswer(roomId, me!, round, 0),
      touchPlayer(roomId, me!)
    ]);
    await grade(roomId);

    const audit = (await listMyAnswers(roomId, me!)).get(round);
    const p = (await getPlayer(roomId, me!))!;
    assert.ok(audit, 'the round is in the audit the review reads');
    assert.equal(audit!.correct, true, 'the review says correct…');
    assert.equal(p.answerCorrect, true, '…and so does the row grading reads');
    assert.equal(p.shields, 1, 'so no shield was taken for a correct answer');
  });

  console.log(`[lsHeartbeatRace] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
