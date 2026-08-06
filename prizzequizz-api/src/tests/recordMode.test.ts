/* RECORD MODE.
 *
 * A leaderboard is only worth as much as the counting behind it, so most of
 * this is about the score being the server's and not the client's: that the
 * entry heart is really charged, that the three run hearts are separate from
 * the account's and vanish with the run, that a wrong answer costs exactly one,
 * that the run ends on the third and files the score, and that the board ranks
 * each player once by their best rather than by how often they played. */
import assert from 'node:assert/strict';
import {
  RecordError, answerRun, getRecordConfig, leaderboard, overview, personalBest, quitRun,
  recordCategories, saveRecordConfig, startRun, _resetRecordMemory
} from '../services/recordModeService.js';
import { repositories } from '../repositories/index.js';
import { getHearts, _resetHeartMemory, _setAnchor } from '../services/heartService.js';
import { gameConfig } from '../core/config.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function makeUser(hearts = 5): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'rec_' + userId.slice(0, 6),
    displayName: 'رکوردزن', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}
const heartsOf = async (uid: string) => Number((await repositories.users.findById(uid))!.hearts);

/* The memory repository starts with no questions, and record mode is nothing
   without a bank. Seed a real one across several categories so the category
   filter has something to actually filter. */
async function seedQuestions(categories: string[]): Promise<void> {
  for (const cat of categories) {
    for (let i = 0; i < 25; i++) {
      await repositories.questions.save({
        id: id(), category: cat, difficulty: 'easy',
        text: cat + ' — سؤال ' + (i + 1),
        options: ['الف', 'ب', 'ج', 'د'],
        correctIndex: i % 4, tags: [], status: 'approved', version: 1
      } as any);
    }
  }
}

/** Answer the current question correctly, using the correct index the server
 *  hands back only after an answer — so the first probe is a guess. */
async function answerCorrectly(runId: string, uid: string, qId: string): Promise<any> {
  const q = (await repositories.questions.findById(qId))!;
  return answerRun(runId, uid, q.correctIndex);
}
async function answerWrongly(runId: string, uid: string, qId: string): Promise<any> {
  const q = (await repositories.questions.findById(qId))!;
  return answerRun(runId, uid, (q.correctIndex + 1) % Math.max(2, q.options.length));
}

async function run() {
  _resetRecordMemory();

  const cats = recordCategories();
  if (!cats.length) { console.log('[recordMode] no categories configured — cannot test'); process.exit(1); }
  const someCategory = cats[0]!.name;
  await seedQuestions(cats.slice(0, 3).map((c) => c.name));

  // -------------------------------------------------------------- entry ----

  await check('entering spends one real heart from the header', async () => {
    const uid = await makeUser(5);
    await startRun(uid, 'global');
    assert.equal(await heartsOf(uid), 4);
  });

  await check('the run then carries its own three', async () => {
    const uid = await makeUser(5);
    const s = await startRun(uid, 'global');
    assert.equal(s.run.hearts, 3);
    assert.equal(s.run.score, 0);
    assert.ok(s.question && s.question.id && s.question.options.length >= 2);
  });

  await check('a wrong answer puts out a run heart, not an account heart', async () => {
    const uid = await makeUser(5);
    const s = await startRun(uid, 'global');
    const after = await heartsOf(uid);
    const r = await answerWrongly(s.run.id, uid, s.question.id);
    assert.equal(r.run.hearts, 2, 'one of the three goes out');
    assert.equal(await heartsOf(uid), after, 'the account paid at the door and is not charged again');
  });

  await check('a player with hearts is never told they have none', async () => {
    /* The reported bug: the header showed five while the server counted zero,
       because hearts lived in the browser and the server had its own number.
       Entry now reads the same balance the header does — including anything
       regenerated since the last visit. */
    _resetHeartMemory();
    const uid = await makeUser(0);
    /* Nothing in hand, but five hours of regeneration owed. */
    _setAnchor(uid, Date.now() - 5 * 3600_000);
    const purse = await getHearts(uid);
    assert.ok(purse.hearts >= 1, 'regeneration must be applied before the check, got ' + purse.hearts);
    const s = await startRun(uid, 'global');
    assert.ok(s.run.id, 'and entry succeeds');
  });

  await check('no heart, no entry', async () => {
    const uid = await makeUser(0);
    await assert.rejects(() => startRun(uid, 'global'),
      (e: any) => e instanceof RecordError && e.code === 'INSUFFICIENT_HEARTS');
  });

  await check('an abandoned run never locks the player out', async () => {
    /* The bug this replaces: closing the app mid-run left the run open forever
       and every later start was refused, with hearts in hand and no way back
       in. Starting again must always work. */
    const uid = await makeUser(5);
    const first = await startRun(uid, 'global');
    await answerCorrectly(first.run.id, uid, first.question.id);
    const second = await startRun(uid, 'global');
    assert.ok(second.run.id && second.run.id !== first.run.id, 'a fresh run, not a refusal');
    assert.equal(second.run.score, 0);
    assert.equal(await personalBest(uid, 'global'), 1, 'and the abandoned run was filed, not lost');
  });

  await check('the run ends when the third run heart goes out', async () => {
    const uid = await makeUser(5);
    const s = await startRun(uid, 'global');
    const accountAfterEntry = await heartsOf(uid);
    let cur: any = { question: s.question };
    for (let i = 0; i < 2; i++) cur = await answerWrongly(s.run.id, uid, cur.question.id);
    assert.equal(cur.run.hearts, 1, 'two out, one left');
    assert.ok(!cur.result);
    cur = await answerWrongly(s.run.id, uid, cur.question.id);
    assert.ok(cur.result, 'the third ends it');
    assert.equal(await heartsOf(uid), accountAfterEntry, 'and the account never paid twice');
  });

  await check('the question is handed over without its answer', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    assert.equal((s.question as any).correctIndex, undefined, 'the client must not be told');
  });

  // --------------------------------------------------------------- play ----

  await check('a correct answer adds one and keeps every heart', async () => {
    const uid = await makeUser(5);
    const s = await startRun(uid, 'global');
    const r = await answerCorrectly(s.run.id, uid, s.question.id);
    assert.equal(r.correct, true);
    assert.equal(r.run.score, 1);
    assert.equal(r.run.hearts, 3, 'a right answer costs nothing');
    assert.ok(r.question, 'and the next question comes straight away');
  });

  await check('a wrong answer costs exactly one heart and the run goes on', async () => {
    const uid = await makeUser(5);
    const s = await startRun(uid, 'global');
    const r = await answerWrongly(s.run.id, uid, s.question.id);
    assert.equal(r.correct, false);
    assert.equal(r.run.hearts, 2, 'exactly one of the three, not two');
    assert.equal(r.run.score, 0);
    assert.ok(r.question, 'losing a heart does not end it');
  });

  await check('the run files the score it earned', async () => {
    const uid = await makeUser(3);
    const s = await startRun(uid, 'global');
    let cur: any = { question: s.question, run: s.run };
    cur = await answerCorrectly(s.run.id, uid, cur.question.id);
    for (let i = 0; i < 3; i++) { if (cur.result) break; cur = await answerWrongly(s.run.id, uid, cur.question.id); }
    assert.ok(cur.result, 'hearts exhausted');
    assert.equal(cur.result.score, 1);
    assert.equal(cur.result.correct, 1);
    assert.ok(cur.result.durationMs >= 0);
    assert.equal(await personalBest(uid, 'global'), 1, 'and it is on the record');
  });

  await check('an ended run refuses further answers', async () => {
    const uid = await makeUser(2);
    const s = await startRun(uid, 'global');
    let cur: any = { question: s.question };
    for (let i = 0; i < 3; i++) { if (cur.result) break; cur = await answerWrongly(s.run.id, uid, cur.question.id); }
    await assert.rejects(() => answerRun(s.run.id, uid, 0),
      (e: any) => e instanceof RecordError && e.code === 'RUN_ENDED');
  });

  await check('another player cannot answer into your run', async () => {
    const a = await makeUser(), b = await makeUser();
    const s = await startRun(a, 'global');
    await assert.rejects(() => answerRun(s.run.id, b, 0),
      (e: any) => e instanceof RecordError && e.code === 'RUN_NOT_FOUND');
  });

  await check('leaving keeps the score that was played for', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    const r1 = await answerCorrectly(s.run.id, uid, s.question.id);
    const res = await quitRun(s.run.id, uid);
    assert.equal(res.score, 1);
    assert.ok(await personalBest(uid, 'global') >= 1);
  });

  await check('the run cannot be resumed after leaving', async () => {
    const uid = await makeUser();
    const s = await startRun(uid, 'global');
    await quitRun(s.run.id, uid);
    await assert.rejects(() => quitRun(s.run.id, uid),
      (e: any) => e instanceof RecordError && e.code === 'RUN_ENDED');
  });

  // --------------------------------------------------------- categories ----

  await check('a category run needs a category that exists', async () => {
    const uid = await makeUser();
    await assert.rejects(() => startRun(uid, 'category', ''),
      (e: any) => e instanceof RecordError && e.code === 'CATEGORY_REQUIRED');
    await assert.rejects(() => startRun(uid, 'category', 'موضوعِ-ناموجود'),
      (e: any) => e instanceof RecordError && e.code === 'UNKNOWN_CATEGORY');
    assert.equal(await heartsOf(uid), 5, 'a refused start charges nothing');
  });

  await check('a category run only ever asks that category', async () => {
    const uid = await makeUser(9);
    let s;
    try { s = await startRun(uid, 'category', someCategory); }
    catch (e: any) { if (e.code === 'NO_QUESTIONS_IN_CATEGORY') return; throw e; }
    assert.equal(s.question.category, someCategory);
    let cur: any = s;
    for (let i = 0; i < 6 && cur.question; i++) {
      cur = await answerCorrectly(s.run.id, uid, cur.question.id);
      if (cur.question) assert.equal(cur.question.category, someCategory, 'every question stays on topic');
    }
  });

  await check('global and category records are separate tables', async () => {
    _resetRecordMemory();
    const uid = await makeUser(9);
    const g = await startRun(uid, 'global');
    await answerCorrectly(g.run.id, uid, g.question.id);
    await quitRun(g.run.id, uid);
    assert.equal(await personalBest(uid, 'global'), 1);
    assert.equal(await personalBest(uid, 'category', someCategory), 0, 'the topic ladder is untouched');
  });

  await check('the toss bank never gets a record table', async () => {
    assert.ok(!recordCategories().some((c) => c.name === 'انتخاب موضوع'),
      'that bank exists for topic selection, not as a topic anyone plays');
  });

  // -------------------------------------------------------- leaderboard ----

  await check('the board ranks each player once, by their best', async () => {
    _resetRecordMemory();
    const uid = await makeUser(20);
    /* Three runs by the same player: 2, then 5, then 1. */
    for (const target of [2, 5, 1]) {
      const s = await startRun(uid, 'global');
      let cur: any = s;
      for (let i = 0; i < target; i++) cur = await answerCorrectly(s.run.id, uid, cur.question.id);
      await quitRun(s.run.id, uid);
    }
    const b = await leaderboard({ mode: 'global', period: 'all', userId: uid });
    assert.equal(b.rows.length, 1, 'one row, not three');
    assert.equal(b.rows[0]!.score, 5, 'their best, not their last');
    assert.equal(b.total, 1);
  });

  await check('players are ordered by score, best first', async () => {
    _resetRecordMemory();
    const scores = [3, 7, 1];
    const uids: string[] = [];
    for (const target of scores) {
      const uid = await makeUser(9); uids.push(uid);
      const s = await startRun(uid, 'global');
      let cur: any = s;
      for (let i = 0; i < target; i++) cur = await answerCorrectly(s.run.id, uid, cur.question.id);
      await quitRun(s.run.id, uid);
    }
    const b = await leaderboard({ mode: 'global', period: 'all' });
    assert.deepEqual(b.rows.map((r) => r.score), [7, 3, 1]);
    assert.deepEqual(b.rows.map((r) => r.rank), [1, 2, 3]);
    assert.ok(b.rows[0]!.username, 'a board with no names is not a board');
  });

  await check('a player outside the visible page still learns their rank', async () => {
    const b = await leaderboard({ mode: 'global', period: 'all', limit: 1, userId: undefined });
    assert.equal(b.rows.length, 1);
    const all = await leaderboard({ mode: 'global', period: 'all' });
    const last = all.rows[all.rows.length - 1]!;
    const withMe = await leaderboard({ mode: 'global', period: 'all', limit: 1, userId: last.userId });
    assert.ok(withMe.me, 'their own placing must come back even off the page');
    assert.equal(withMe.me!.rank, all.rows.length);
    assert.equal(withMe.me!.score, last.score);
  });

  await check('a personal best is reported as one, and only when it is', async () => {
    _resetRecordMemory();
    const uid = await makeUser(20);
    const s1 = await startRun(uid, 'global');
    let cur: any = s1;
    for (let i = 0; i < 3; i++) cur = await answerCorrectly(s1.run.id, uid, cur.question.id);
    const r1 = await quitRun(s1.run.id, uid);
    assert.equal(r1.previousBest, 0);
    assert.equal(r1.isPersonalBest, true);

    const s2 = await startRun(uid, 'global');
    const r2 = await quitRun(s2.run.id, uid);        // score 0
    assert.equal(r2.previousBest, 3);
    assert.equal(r2.isPersonalBest, false, 'a worse run is not a record');
    assert.equal(await personalBest(uid, 'global'), 3, 'and it does not replace the good one');
  });

  await check('the daily board only counts today', async () => {
    const day = await leaderboard({ mode: 'global', period: 'day' });
    const all = await leaderboard({ mode: 'global', period: 'all' });
    assert.ok(day.total <= all.total);
    assert.ok(day.rows.every((r) => Date.now() - r.createdAt <= 86_400_000 + 5000));
  });

  await check('the overview gives the record screen what it needs', async () => {
    const uid = await makeUser(4);
    const o = await overview(uid);
    assert.equal(o.hearts, 4);
    assert.equal(o.entryHearts, 1, 'one real heart at the door');
    assert.equal(o.runHearts, 3, 'three inside the run');
    assert.equal(o.friendlyOnly, true, 'record mode belongs to the friendly plan');
    assert.ok(o.categories.length > 0);
    assert.ok(o.categories.every((c) => typeof c.best === 'number' && typeof c.worldBest === 'number'));
    assert.ok(typeof o.global.worldBest === 'number');
  });

  // --------------------------------------------- not touching the rest ----

  await check('record mode moves nothing else in the game by default', async () => {
    const uid = await makeUser(5);
    const before = (await repositories.users.findById(uid))!;
    const xp0 = Number(before.xp) || 0, cup0 = Number(before.weeklyScore) || 0, coins0 = Number(before.coins) || 0;
    const s = await startRun(uid, 'global');
    let cur: any = s;
    for (let i = 0; i < 4; i++) { if (cur.result) break; cur = await answerCorrectly(s.run.id, uid, cur.question.id); }
    await quitRun(s.run.id, uid).catch(() => undefined);
    const after = (await repositories.users.findById(uid))!;
    assert.equal(Number(after.xp) || 0, xp0, 'no XP');
    assert.equal(Number(after.weeklyScore) || 0, cup0, 'no cup');
    assert.equal(Number(after.coins) || 0, coins0, 'no coins');
  });

  await check('but the panel can turn each of those on', async () => {
    await saveRecordConfig({ xpPerCorrect: 5, coinsPerCorrect: 2 });
    const uid = await makeUser(5);
    const s = await startRun(uid, 'global');
    await answerCorrectly(s.run.id, uid, s.question.id);
    const u = (await repositories.users.findById(uid))!;
    assert.equal(Number(u.xp), 5);
    assert.equal(Number(u.coins), 2);
    await saveRecordConfig({ xpPerCorrect: 0, coinsPerCorrect: 0 });
  });

  await check('the panel can change what entry costs and how many run hearts there are', async () => {
    await saveRecordConfig({ entryHearts: 2, runHearts: 5 });
    const uid = await makeUser(4);
    const s = await startRun(uid, 'global');
    assert.equal(await heartsOf(uid), 2, 'two taken at the door');
    assert.equal(s.run.hearts, 5, 'five inside');
    await saveRecordConfig({ entryHearts: 1, runHearts: 3 });
  });

  await check('the panel can switch the whole mode off', async () => {
    await saveRecordConfig({ enabled: false });
    const uid = await makeUser(5);
    await assert.rejects(() => startRun(uid, 'global'),
      (e: any) => e instanceof RecordError && e.code === 'RECORD_OFF');
    await saveRecordConfig({ enabled: true });
  });

  console.log(`[recordMode] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
