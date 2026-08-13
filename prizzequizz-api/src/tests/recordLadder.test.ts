/* THE RECORD RUN CLIMBS.
 *
 * It used to draw from the whole approved bank at random, so question two could
 * be harder than question twenty and lasting longer meant nothing. The rule now
 * is the one that was asked for: start easy, three correct answers IN A ROW
 * move up a step, and a wrong answer holds you where you are — it must not push
 * you back down, and it must not let you through.
 *
 * The cases that matter are the ones where "three in a row" is easy to get
 * subtly wrong: three correct spread around a mistake is not three in a row,
 * and the step must not creep up on the fourth, fifth and sixth correct answer
 * one at a time.
 *
 * Run: npx tsx src/tests/recordLadder.test.ts
 */
import assert from 'node:assert/strict';
import { ladderAfter, RECORD_LADDER, startRun, answerRun, saveRecordConfig, recordCategories } from '../services/recordModeService.js';
import { repositories } from '../repositories/index.js';
import { addHearts } from '../services/heartService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** Walk a sequence of correct/wrong answers through the ladder. */
function walk(answers: boolean[]): { level: number; streak: number } {
  let st = { level: 0, streak: 0 };
  for (const c of answers) st = ladderAfter(st.level, st.streak, c);
  return st;
}

async function run(): Promise<void> {
  await check('three correct in a row moves up exactly one step', () => {
    assert.deepEqual(walk([true, true]), { level: 0, streak: 2 }, 'two is not enough');
    assert.deepEqual(walk([true, true, true]), { level: 1, streak: 0 }, 'the third one does it');
  });

  await check('and three more move up again', () => {
    assert.equal(walk([true, true, true, true, true, true]).level, 2);
    assert.equal(walk(new Array(9).fill(true)).level, 3);
  });

  await check('the fourth correct answer does NOT move up on its own', () => {
    /* Counting every correct answer instead of every third is the obvious way
       to get this wrong, and the run would reach the hardest tier in four. */
    const st = walk([true, true, true, true]);
    assert.equal(st.level, 1, 'still one step up, not two');
    assert.equal(st.streak, 1, 'and the count towards the next step has restarted');
  });

  await check('a wrong answer holds the level — it does not drop it', () => {
    const up = walk([true, true, true]);            // level 1
    const after = ladderAfter(up.level, up.streak, false);
    assert.equal(after.level, 1, 'the step already earned is kept');
    assert.equal(after.streak, 0, 'but the run of correct answers restarts');
  });

  await check('and it does not let you through either', () => {
    /* Two right, one wrong, one right is not three in a row. */
    assert.equal(walk([true, true, false, true]).level, 0);
    assert.equal(walk([true, false, true, false, true, false]).level, 0, 'alternating never climbs');
  });

  await check('three in a row AFTER a mistake still climbs', () => {
    assert.equal(walk([true, true, false, true, true, true]).level, 1);
  });

  await check('the ladder stops at the hardest tier', () => {
    const st = walk(new Array(60).fill(true));
    assert.equal(st.level, RECORD_LADDER.length - 1, 'it must not run off the end of the list');
    assert.equal(RECORD_LADDER[st.level], 'veryhard');
  });

  await check('a level out of range is pulled back in', () => {
    assert.equal(ladderAfter(99, 0, true).level, RECORD_LADDER.length - 1);
    assert.equal(ladderAfter(-5, 0, false).level, 0);
  });

  /* ── the real run ──────────────────────────────────────────────────── */

  /* A record table only exists for a REAL game topic, so the questions are
     seeded under one the game already has rather than an invented name. */
  const TOPIC = recordCategories()[0]?.name;
  assert.ok(TOPIC, 'the game has at least one topic to play');

  await check('a real run starts easy and the questions climb with it', async () => {
    /* The rule is only worth anything if the QUESTIONS follow it. */
    for (const [tier, n] of [['easy', 12], ['medium', 12], ['hard', 12], ['veryhard', 12]] as const) {
      for (let i = 0; i < n; i++) {
        await repositories.questions.save({
          id: id(), category: TOPIC, difficulty: tier, text: tier + ' ' + i,
          options: ['درست', 'ب', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
        } as any);
      }
    }
    await saveRecordConfig({ enabled: true, entryHearts: 0, runHearts: 50 });
    const uid = 'rl-' + id().slice(0, 6);
    await repositories.users.save({
      id: uid, username: uid, displayName: uid, phone: '0914' + Math.floor(Math.random() * 9e6),
      plan: 'free', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5,
      tickets: { bronze: 0, silver: 0, gold: 0 }
    } as any);
    await addHearts(uid, 10).catch(() => undefined);

    const started = await startRun(uid, 'category', TOPIC!);
    assert.equal(started.question.difficulty, 'easy', 'the first question is easy');

    const seen: string[] = [started.question.difficulty];
    let cur = started.question;
    /* Nine correct answers: three easy, three medium, three hard, then very hard. */
    for (let i = 0; i < 9; i++) {
      const r = await answerRun(started.run.id, uid, 0);
      assert.equal(r.correct, true, 'answer ' + (i + 1) + ' should be correct');
      cur = (r as any).question;
      if (cur) seen.push(cur.difficulty);
    }
    assert.deepEqual(seen.slice(0, 3), ['easy', 'easy', 'easy'], 'the first three: ' + JSON.stringify(seen));
    assert.deepEqual(seen.slice(3, 6), ['medium', 'medium', 'medium'], 'then medium: ' + JSON.stringify(seen));
    assert.deepEqual(seen.slice(6, 9), ['hard', 'hard', 'hard'], 'then hard: ' + JSON.stringify(seen));
    assert.equal(seen[9], 'veryhard', 'and finally very hard: ' + JSON.stringify(seen));
  });

  await check('a wrong answer keeps the questions at the level already reached', async () => {
    await saveRecordConfig({ enabled: true, entryHearts: 0, runHearts: 50 });
    const uid = 'rl2-' + id().slice(0, 6);
    await repositories.users.save({
      id: uid, username: uid, displayName: uid, phone: '0915' + Math.floor(Math.random() * 9e6),
      plan: 'free', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5,
      tickets: { bronze: 0, silver: 0, gold: 0 }
    } as any);
    await addHearts(uid, 10).catch(() => undefined);

    const started = await startRun(uid, 'category', TOPIC!);
    for (let i = 0; i < 3; i++) await answerRun(started.run.id, uid, 0);   // → medium
    const wrong = await answerRun(started.run.id, uid, 1);
    assert.equal(wrong.correct, false);
    const q = (wrong as any).question;
    assert.equal(q.difficulty, 'medium', 'a mistake must not make it easy again: ' + q.difficulty);
    /* And it does not skip ahead either. */
    const after = await answerRun(started.run.id, uid, 0);
    assert.equal((after as any).question.difficulty, 'medium', 'nor jump up on the next correct one');
  });

  console.log(`[recordLadder] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
