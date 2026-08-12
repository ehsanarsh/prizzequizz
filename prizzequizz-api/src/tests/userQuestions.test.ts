/* QUESTIONS PLAYERS WRITE, AND WHAT APPROVING ONE PAYS.
 *
 * The «کوییزساز» screen showed a success message and threw the question away.
 * Now it reaches the panel — so the things worth testing are the ways that can
 * go wrong quietly:
 *
 *   — approving twice paying twice. An operator double-clicks; a request is
 *     retried. Either one must pay once.
 *   — «one in every N» paying every time (or never).
 *   — a rejected question still ending up in the question bank.
 *   — a draw that is not really random, or that ignores the weights.
 *
 * Run: npx tsx src/tests/userQuestions.test.ts
 */
import assert from 'node:assert/strict';
import {
  submitQuestion, listSubmissions, submissionCounts, reviewSubmission,
  getQuizMakerConfig, setQuizMakerConfig, pickPrize, prizeAmount,
  UserQuestionError, _resetUserQuestions, QUIZ_MAKER_DEFAULTS
} from '../services/userQuestionService.js';
import { repositories } from '../repositories/index.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const GOOD = {
  text: 'پایتخت فرانسه کدام است؟',
  options: ['پاریس', 'رم', 'مادرید', 'لندن'],
  correctIndex: 0,
  category: 'عمومی',
  difficulty: 'easy'
};

async function player(id: string): Promise<string> {
  await repositories.users.save({
    id, phone: '0912' + id.replace(/\D/g, '').padStart(7, '0'), username: id, displayName: id, plan: 'free',
    level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return id;
}

async function run(): Promise<void> {
  _resetUserQuestions();
  await setQuizMakerConfig({ enabled: true, mode: 'each', prizes: QUIZ_MAKER_DEFAULTS.prizes });

  /* ── submitting ───────────────────────────────────────────────────── */

  await check('a submitted question reaches the panel', async () => {
    _resetUserQuestions();
    const u = await player('u-writer-1');
    const { questionId } = await submitQuestion({ userId: u, ...GOOD });
    const rows = await listSubmissions({ status: 'pending' });
    const mine = rows.find((r) => r.questionId === questionId)!;
    assert.ok(mine, 'the submission is listed');
    assert.equal(mine.userId, u, 'and it says who wrote it');
    assert.equal(mine.text, GOOD.text, 'with the question itself, not just an id');
    assert.deepEqual(mine.options, GOOD.options);
  });

  await check('a half-written question is refused with a reason', async () => {
    const u = await player('u-writer-2');
    await assert.rejects(() => submitQuestion({ userId: u, ...GOOD, text: 'کوتاه' }),
      (e: unknown) => e instanceof UserQuestionError && e.code === 'TEXT_TOO_SHORT');
    await assert.rejects(() => submitQuestion({ userId: u, ...GOOD, options: ['پاریس', 'رم'] }),
      (e: unknown) => e instanceof UserQuestionError && e.code === 'OPTIONS_REQUIRED');
  });

  await check('four options that are the same option are refused', async () => {
    /* Otherwise every answer is right and the question is free money. */
    const u = await player('u-writer-3');
    await assert.rejects(() => submitQuestion({ userId: u, ...GOOD, options: ['پاریس', 'پاریس ', 'PARIS', 'لندن'] }),
      (e: unknown) => e instanceof UserQuestionError && e.code === 'OPTIONS_DUPLICATE');
  });

  /* ── approving ────────────────────────────────────────────────────── */

  await check('approving publishes the question and pays the author', async () => {
    _resetUserQuestions();
    const u = await player('u-writer-4');
    const { questionId } = await submitQuestion({ userId: u, ...GOOD });
    const r = await reviewSubmission(questionId, 'approve');
    assert.equal(r.status, 'approved');
    assert.equal(r.rewarded, true, 'the author was paid');
    assert.ok(r.reward && r.reward.amount > 0, 'and it was a real amount: ' + JSON.stringify(r.reward));
    const q = await repositories.questions.findById(questionId);
    assert.equal(q?.status, 'approved', 'and the question is in the bank');
  });

  await check('approving twice does NOT pay twice', async () => {
    /* An operator double-clicks, or a request is retried. This is the one that
       costs real money if it is wrong. */
    _resetUserQuestions();
    const u = await player('u-writer-5');
    const { questionId } = await submitQuestion({ userId: u, ...GOOD });
    const first = await reviewSubmission(questionId, 'approve');
    const again = await reviewSubmission(questionId, 'approve');
    assert.equal(first.rewarded, true);
    assert.equal(again.rewarded, false, 'the second approval pays nothing');
    assert.equal(again.reason, 'ALREADY_REWARDED');
    /* And the record still shows the ONE prize that was paid. */
    const row = (await listSubmissions({ status: 'approved' })).find((x) => x.questionId === questionId)!;
    assert.deepEqual(row.reward, first.reward);
  });

  await check('rejecting keeps it out of the question bank', async () => {
    _resetUserQuestions();
    const u = await player('u-writer-6');
    const { questionId } = await submitQuestion({ userId: u, ...GOOD });
    const r = await reviewSubmission(questionId, 'reject');
    assert.equal(r.status, 'rejected');
    assert.equal(r.rewarded, false, 'and pays nothing');
    const q = await repositories.questions.findById(questionId);
    assert.equal(q?.status, 'rejected');
  });

  await check('reviewing something that was never submitted is refused', async () => {
    await assert.rejects(() => reviewSubmission('no-such-question', 'approve'),
      (e: unknown) => e instanceof UserQuestionError && e.code === 'NOT_FOUND');
  });

  /* ── how often it pays ────────────────────────────────────────────── */

  await check('«one in every N» pays exactly one in N', async () => {
    _resetUserQuestions();
    await setQuizMakerConfig({ enabled: true, mode: 'everyN', n: 3 });
    const u = await player('u-writer-7');
    const paid: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const { questionId } = await submitQuestion({ userId: u, ...GOOD, text: GOOD.text + ' ' + i });
      paid.push((await reviewSubmission(questionId, 'approve')).rewarded);
    }
    assert.deepEqual(paid, [false, false, true, false, false, true], 'every third one: ' + JSON.stringify(paid));
  });

  await check('and each author is counted on their own', async () => {
    /* Otherwise the third person to submit anything collects for everybody. */
    _resetUserQuestions();
    await setQuizMakerConfig({ enabled: true, mode: 'everyN', n: 2 });
    const a = await player('u-writer-8a'), b = await player('u-writer-8b');
    const q1 = await submitQuestion({ userId: a, ...GOOD, text: GOOD.text + ' a1' });
    const q2 = await submitQuestion({ userId: b, ...GOOD, text: GOOD.text + ' b1' });
    const q3 = await submitQuestion({ userId: a, ...GOOD, text: GOOD.text + ' a2' });
    assert.equal((await reviewSubmission(q1.questionId, 'approve')).rewarded, false, 'a: first');
    assert.equal((await reviewSubmission(q2.questionId, 'approve')).rewarded, false, 'b: first');
    assert.equal((await reviewSubmission(q3.questionId, 'approve')).rewarded, true, 'a: second');
  });

  await check('rewards can be switched off entirely', async () => {
    _resetUserQuestions();
    await setQuizMakerConfig({ enabled: false });
    const u = await player('u-writer-9');
    const { questionId } = await submitQuestion({ userId: u, ...GOOD });
    const r = await reviewSubmission(questionId, 'approve');
    assert.equal(r.rewarded, false);
    assert.equal(r.reason, 'REWARDS_OFF');
    assert.equal(r.status, 'approved', 'but the question is still published');
    await setQuizMakerConfig({ enabled: true, mode: 'each' });
  });

  /* ── the draw ─────────────────────────────────────────────────────── */

  await check('the draw follows the weights', async () => {
    /* Not a distribution test — just that a 0-weight prize never comes up and
       a lone prize always does. A silent "always the first one" would pass a
       weaker check. */
    const only = pickPrize([{ type: 'coins', min: 1, max: 1, weight: 0, label: 'x', icon: '🪙' },
                            { type: 'xp', min: 1, max: 1, weight: 5, label: 'y', icon: '⚡' }]);
    assert.equal(only?.type, 'xp', 'a zero weight is never drawn');
    const counts: Record<string, number> = {};
    for (let i = 0; i < 400; i++) {
      const p = pickPrize([{ type: 'coins', min: 1, max: 1, weight: 90, label: 'c', icon: '🪙' },
                           { type: 'cash', min: 1, max: 1, weight: 10, label: 'm', icon: '💰' }])!;
      counts[p.type] = (counts[p.type] ?? 0) + 1;
    }
    assert.ok((counts.coins ?? 0) > (counts.cash ?? 0) * 2, 'the heavy one wins more often: ' + JSON.stringify(counts));
    assert.ok((counts.cash ?? 0) > 0, 'and the light one still happens');
  });

  await check('the amount stays inside the range it was given', async () => {
    for (let i = 0; i < 200; i++) {
      const a = prizeAmount({ type: 'coins', min: 50, max: 60, weight: 1, label: '', icon: '' });
      assert.ok(a >= 50 && a <= 60, 'out of range: ' + a);
    }
    assert.equal(prizeAmount({ type: 'coins', min: 7, max: 7, weight: 1, label: '', icon: '' }), 7);
  });

  await check('no prizes configured pays nothing and says so', async () => {
    _resetUserQuestions();
    await setQuizMakerConfig({ enabled: true, mode: 'each', prizes: [{ type: 'coins', min: 1, max: 1, weight: 0, label: '', icon: '' }] });
    const u = await player('u-writer-10');
    const { questionId } = await submitQuestion({ userId: u, ...GOOD });
    const r = await reviewSubmission(questionId, 'approve');
    assert.equal(r.rewarded, false);
    assert.equal(r.reason, 'NO_PRIZES');
    await setQuizMakerConfig({ prizes: QUIZ_MAKER_DEFAULTS.prizes });
  });

  await check('the panel’s counts are the real ones', async () => {
    _resetUserQuestions();
    const u = await player('u-writer-11');
    const a = await submitQuestion({ userId: u, ...GOOD, text: GOOD.text + ' 1' });
    const b = await submitQuestion({ userId: u, ...GOOD, text: GOOD.text + ' 2' });
    await submitQuestion({ userId: u, ...GOOD, text: GOOD.text + ' 3' });
    await reviewSubmission(a.questionId, 'approve');
    await reviewSubmission(b.questionId, 'reject');
    assert.deepEqual(await submissionCounts(), { pending: 1, approved: 1, rejected: 1 });
  });

  await check('the settings survive a round trip and refuse nonsense', async () => {
    await setQuizMakerConfig({ enabled: true, mode: 'everyN', n: 7 });
    let c = await getQuizMakerConfig();
    assert.equal(c.mode, 'everyN'); assert.equal(c.n, 7);
    await setQuizMakerConfig({ n: 1 });          // below the floor
    c = await getQuizMakerConfig();
    assert.equal(c.n, 2, 'N is never less than 2 — «one in every 1» is «every one»');
    await setQuizMakerConfig({ n: 5000 });
    c = await getQuizMakerConfig();
    assert.equal(c.n, 100);
    await setQuizMakerConfig({ mode: 'each', n: 10 });
  });

  /* ── the screen the player actually uses ──────────────────────────── */

  const client = readFileSync(findClient(), 'utf8');

  await check('the client sends the question instead of dropping it', async () => {
    /* This is the whole bug: «ارسال شد» was shown and nothing left the phone. */
    const i = client.indexOf('async function submitQuestion(');
    assert.ok(i > 0, 'submitQuestion is async — it awaits the server');
    const body = client.slice(i, client.indexOf('async function qsLoadMine('));
    assert.match(body, /pzApi\('POST','\/questions\/submit'/, 'it posts to the API');
    /* The success modal must come AFTER the call, and only when it worked. */
    const call = body.indexOf("'/questions/submit'");
    const okModal = body.indexOf('سؤال برای بررسی ارسال شد');
    assert.ok(call > 0 && okModal > call, 'the success message comes after the request, not instead of it');
    assert.match(body, /if\(!r\|\|r\.error\|\|r\.ok===false\|\|!r\.data\)[\s\S]{0,200}ارسال نشد/, 'a failure is shown as a failure');
    /* Every API answer is {ok,data}. Reading the fields off the top level is
       how «افراد آنلاین» came back empty however many people were on. */
    assert.ok(!/r\.rows/.test(client.slice(client.indexOf('async function qsLoadMine('), client.indexOf('async function qsLoadMine(') + 900)),
      'the submissions list must read r.data.rows, not r.rows');
  });

  await check('the four options are sent with the right one marked', async () => {
    const i = client.indexOf('async function submitQuestion(');
    const body = client.slice(i, client.indexOf('async function qsLoadMine('));
    assert.match(body, /options:\[c,\.\.\.w\.slice\(0,3\)\],\s*correctIndex:0/,
      'the correct answer is the option the server will mark correct');
    assert.ok(body.includes('QS_DIFF['), 'and the Persian difficulty is translated, not sent as Persian');
  });

  await check('the player can see what their questions earned', async () => {
    assert.ok(client.includes("pzApi('GET','/questions/mine')"), 'the list is fetched');
    assert.ok(client.includes('id="qsMine"'), 'and it has somewhere to go');
    assert.match(client, /function hmQuizMaker\(\)\{ go\('qsubmit'\); qsLoadMine\(\); \}/,
      'opening the screen loads it');
  });

  await check('double-tapping «ارسال» cannot submit twice', async () => {
    const i = client.indexOf('async function submitQuestion(');
    const body = client.slice(i, client.indexOf('async function qsLoadMine('));
    assert.match(body, /if\(btn\.disabled\) return; btn\.disabled=true/, 'the button locks while the request is in flight');
    assert.ok(body.includes('restore()'), 'and unlocks afterwards');
  });

  console.log(`[userQuestions] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
