/* THE FOUR HELPS IN RECORD MODE.
 *
 * The report was that they did not work. Three of the four genuinely did not:
 * «وقت اضافه» was filtered out of the row entirely, «درصد بقیه» was consumed
 * and then said it was unavailable, and «انتخاب دوم» was consumed and did
 * nothing whatsoever — a bought item spent for no effect.
 *
 * ۵۰:۵۰ and «انتخاب دوم» and «درصد بقیه» are decided here, on the server, and
 * that is the point of these tests: a retry the client could grant itself would
 * make the run endless, and a 50:50 the client could compute would mean it
 * already knew the answer. («وقت اضافه» is the one exception — this mode has no
 * server-side deadline, so the clock is the client's and always was.)
 *
 * Run: npx tsx src/tests/recordHelps.test.ts */
import assert from 'node:assert/strict';
import {
  RecordError, answerRun, answerStats, armSecondChance, fiftyFifty, quitRun,
  recordCategories, startRun, _resetRecordMemory
} from '../services/recordModeService.js';
import { repositories } from '../repositories/index.js';
import { _resetHeartMemory } from '../services/heartService.js';
import { getQuestionDistribution, recordQuestionAnswer } from '../services/questionStatsService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function makeUser(hearts = 9): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'h_' + userId.slice(0, 6),
    displayName: 'کمک', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}
async function seed(cats: string[]): Promise<void> {
  for (const cat of cats) {
    for (let i = 0; i < 30; i++) {
      await repositories.questions.save({
        id: id(), category: cat, difficulty: 'easy', text: cat + ' — س' + i,
        options: ['الف', 'ب', 'ج', 'د'], correctIndex: i % 4, tags: [], status: 'approved', version: 1
      } as any);
    }
  }
}
const wrongIndexFor = async (qId: string): Promise<number> => {
  const q = (await repositories.questions.findById(qId))!;
  return (q.correctIndex + 1) % q.options.length;
};
const rightIndexFor = async (qId: string): Promise<number> =>
  (await repositories.questions.findById(qId))!.correctIndex;

async function run(): Promise<void> {
  _resetRecordMemory(); _resetHeartMemory();
  const cats = recordCategories();
  if (cats.length < 3) { console.log('[recordHelps] needs at least three categories configured'); process.exit(1); }
  await seed(cats.slice(0, 2).map((c) => c.name));
  /* Reserved for the empty-sample case, and deliberately NOT seeded yet: a
     'global' run draws from the whole bank, so questions that exist while the
     earlier tests run can be answered by them no matter which category they
     sit in. They are created further down, after those tests, which is what
     actually makes them untouched. */
  const virginCat = cats[2]!.name;

  // ------------------------------------------------------------- ۵۰:۵۰ ----

  await check('۵۰:۵۰ removes only wrong options, and never the right one', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const qId = s.question.id;
    const right = await rightIndexFor(qId);
    const { remove } = await fiftyFifty(s.run.id, uid);
    assert.equal(remove.length, 2, 'four options → two go');
    assert.ok(!remove.includes(right), '۵۰:۵۰ must never remove the answer');
    assert.equal(new Set(remove).size, remove.length, 'and never the same one twice');
  });

  // ------------------------------------------------------ انتخاب دوم ----

  await check('«انتخاب دوم» absorbs a wrong answer: no heart, same question', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const qId = s.question.id;
    const before = s.run.hearts;
    await armSecondChance(s.run.id, uid);
    const r = await answerRun(s.run.id, uid, await wrongIndexFor(qId));
    assert.equal(r.retry, true, 'the wrong answer should be absorbed');
    assert.equal(r.run.hearts, before, 'and cost no heart');
    assert.equal(r.question, undefined, 'the run must NOT move to a new question');
    assert.equal(r.correctIndex, -1, 'and must not leak the answer on the retry path');
    assert.equal(typeof r.ruledOut, 'number', 'the option just ruled out comes back');
  });

  await check('after the retry the SAME question can still be answered correctly', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const qId = s.question.id;
    await armSecondChance(s.run.id, uid);
    await answerRun(s.run.id, uid, await wrongIndexFor(qId));
    const r = await answerRun(s.run.id, uid, await rightIndexFor(qId));
    assert.equal(r.correct, true);
    assert.equal(r.run.score, 1, 'the retried question scores normally');
    assert.ok(r.question, 'and the run moves on');
  });

  await check('the retry is spent — a SECOND wrong answer costs a heart', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const before = s.run.hearts;
    await armSecondChance(s.run.id, uid);
    await answerRun(s.run.id, uid, await wrongIndexFor(s.question.id));
    const r = await answerRun(s.run.id, uid, await wrongIndexFor(s.question.id));
    assert.ok(!r.retry, 'only one absorption per arming');
    assert.equal(r.run.hearts, before - 1);
  });

  await check('it cannot be armed twice for the same question', async () => {
    /* Otherwise buying a second copy mid-question would stack two retries onto
       one answer, which is a different (and much stronger) item. */
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    await armSecondChance(s.run.id, uid);
    assert.deepEqual(await armSecondChance(s.run.id, uid), { armed: true }, 'arming twice is idempotent, not an error');
    await answerRun(s.run.id, uid, await wrongIndexFor(s.question.id));   // spends it
    await assert.rejects(() => armSecondChance(s.run.id, uid),
      (e: any) => e instanceof RecordError && e.code === 'SECOND_CHANCE_SPENT');
  });

  await check('a CORRECT answer does not burn the retry', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    await armSecondChance(s.run.id, uid);
    const r = await answerRun(s.run.id, uid, await rightIndexFor(s.question.id));
    assert.equal(r.correct, true);
    /* Still armed on the NEXT question — proven by it absorbing a wrong one. */
    const w = await answerRun(s.run.id, uid, await wrongIndexFor(r.question!.id));
    assert.equal(w.retry, true, 'the retry should have survived the correct answer');
  });

  await check('a retry does not end the run even on the last heart', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    let q = s.question, r: any = { run: s.run };
    /* Burn down to one heart. */
    while (r.run.hearts > 1) { r = await answerRun(s.run.id, uid, await wrongIndexFor(q.id)); q = r.question; }
    assert.equal(r.run.hearts, 1);
    await armSecondChance(s.run.id, uid);
    const abs = await answerRun(s.run.id, uid, await wrongIndexFor(q.id));
    assert.equal(abs.retry, true);
    assert.equal(abs.run.hearts, 1, 'the last heart survives');
    assert.equal(abs.result, undefined, 'and the run is not over');
  });

  await check('another player cannot arm a retry on your run', async () => {
    const uid = await makeUser(), other = await makeUser();
    const s = await startRun(uid, 'global');
    await assert.rejects(() => armSecondChance(s.run.id, other),
      (e: any) => e instanceof RecordError && e.code === 'RUN_NOT_FOUND');
  });

  await check('a finished run refuses both helps', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    await quitRun(s.run.id, uid);
    for (const fn of [armSecondChance, answerStats, fiftyFifty]) {
      await assert.rejects(() => (fn as any)(s.run.id, uid), (e: any) => e instanceof RecordError);
    }
  });

  // -------------------------------------------------------- درصد بقیه ----

  await check('a question nobody has answered reports an empty sample, not a fake split', async () => {
    /* This is the case the client refuses to spend the help on: four bars all
       reading ۰٪ is not a hint. Inventing an even 25/25/25/25 would be worse —
       it would look like real data. */
    /* Created here, after every test above has finished answering, and played
       in category mode — so the question really is untouched rather than
       probably untouched. */
    await seed([virginCat]);
    const uid = await makeUser();
    const s = await startRun(uid, 'category', virginCat);
    const st = await answerStats(s.run.id, uid);
    assert.equal(st.sample, 0, 'a fresh question has no answers behind it');
    assert.deepEqual(st.percents, [0, 0, 0, 0]);
  });

  await check('once people have answered, it returns one figure per option summing to ~100', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const qId = s.question.id;
    /* Build a real distribution on THIS question. The run may have been handed
       a question an earlier test already answered, so the baseline is measured
       rather than assumed — heavily weighted picks keep the ordering assertions
       true either way. */
    const base = await getQuestionDistribution(qId, 4);
    const picks = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2];
    for (const pick of picks) await recordQuestionAnswer(qId, pick);
    const st = await answerStats(s.run.id, uid);
    assert.equal(st.percents.length, 4, 'one figure per option');
    assert.equal(st.sample, base.sample + picks.length, 'every answer should be counted');
    const total = st.percents.reduce((a, b) => a + b, 0);
    assert.equal(total, 100, 'percentages must add up exactly, got ' + total);
    assert.ok(st.percents[0]! > st.percents[1]!, 'the most-chosen option should lead');
    assert.ok(st.percents[1]! > st.percents[3]!, 'and an option nobody picked should trail');
  });

  await check('it never says which option is right', async () => {
    /* The whole value of the help is that it is a crowd hint, not an answer
       key. Nothing in the payload may correlate with the correct index. */
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const st = await answerStats(s.run.id, uid);
    assert.deepEqual(Object.keys(st).sort(), ['percents', 'sample']);
  });

  await check('record answers feed the tally the help reads', async () => {
    /* Record mode used to take from this pool without ever putting anything
       back, so its own questions stayed at an even split forever. */
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const qId = s.question.id;
    const pick = await wrongIndexFor(qId);
    const before = await getQuestionDistribution(qId, 4);
    await answerRun(s.run.id, uid, pick);
    const after = await getQuestionDistribution(qId, 4);
    assert.equal(after.sample, before.sample + 1, 'the answer should have been counted');
    assert.ok(after.percents[pick]! > before.percents[pick]! - 1,
      'and counted against the option that was actually chosen');
  });

  await check('a timeout is not counted as somebody\'s choice', async () => {
    /* The client reports a timeout as an index past the end of the options.
       Feeding that to the tally would invent a fifth option. */
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const qId = s.question.id;
    const before = await getQuestionDistribution(qId, 4);
    await answerRun(s.run.id, uid, 99);
    const after = await getQuestionDistribution(qId, 4);
    assert.equal(after.sample, before.sample, 'a timeout is not an opinion');
  });

  console.log(`[recordHelps] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
