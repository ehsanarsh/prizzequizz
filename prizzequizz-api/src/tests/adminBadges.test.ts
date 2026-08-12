/* THE NUMBER ON THE SIDEBAR.
 *
 * A payout request arrives and nothing on the panel moves. The badge is the
 * whole fix, so the things worth testing are the ways a badge lies:
 *
 *   — a queue that clears because somebody LOOKED at it. Then the panel says
 *     the payouts are handled and they are not.
 *   — one admin's visit clearing another admin's badge.
 *   — a fresh panel claiming every user who ever registered is "new".
 *   — a number on a screen the account cannot even open.
 *   — one broken table taking every other badge down with it.
 *
 * Run: npx tsx src/tests/adminBadges.test.ts
 */
import assert from 'node:assert/strict';
import {
  badgeCounts, markScreenSeen, isQueueScreen, BADGE_SOURCES,
  _setCounter, _resetBadges
} from '../services/adminBadgeService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
  _resetBadges();

  /* ── the queue ────────────────────────────────────────────────────── */

  await check('a pending payout shows as a number', async () => {
    _resetBadges();
    _setCounter('withdrawals', () => 3);
    const b = await badgeCounts('master');
    assert.equal(b.screens.withdrawals!.count, 3);
    assert.equal(b.screens.withdrawals!.mode, 'queue');
  });

  await check('LOOKING at the payouts does not clear them', async () => {
    /* The whole point. If opening the tab cleared it, the panel would report
       the payouts as handled while three people are still waiting. */
    _resetBadges();
    let pending = 3;
    _setCounter('withdrawals', () => pending);
    await markScreenSeen('master', 'withdrawals');
    assert.equal((await badgeCounts('master')).screens.withdrawals!.count, 3, 'still three');
    pending = 0;                                   // now they are actually paid
    assert.equal((await badgeCounts('master')).screens.withdrawals!.count, 0);
  });

  await check('the queues are the ones that cannot be cleared by looking', async () => {
    for (const s of ['withdrawals', 'rewardholds', 'support', 'qreports', 'suspicious', 'payoutpartners']) {
      assert.equal(isQueueScreen(s), true, s + ' must be a queue');
    }
    for (const s of ['finance', 'payments', 'users']) {
      assert.equal(isQueueScreen(s), false, s + ' is a "new since you looked" screen');
    }
  });

  await check('support and the money screens are all covered', async () => {
    /* The three the operator named. A badge that exists for none of them is
       the feature not being there. */
    const screens = BADGE_SOURCES.map((s) => s.screen);
    for (const must of ['withdrawals', 'support', 'finance']) assert.ok(screens.includes(must), 'no badge for ' + must);
  });

  /* ── "new since you looked" ───────────────────────────────────────── */

  await check('a fresh panel does not call every existing row new', async () => {
    /* With no mark yet, `created_at > null` would be the whole table: a badge
       reading 40,000 on the users tab of a panel opened for the first time. */
    _resetBadges();
    _setCounter('finance', (since) => (since ? 5 : 99999));
    assert.equal((await badgeCounts('master')).screens.finance!.count, 0, 'first sight starts the clock');
    await markScreenSeen('master', 'finance');
    assert.equal((await badgeCounts('master')).screens.finance!.count, 5, 'and then counts from there');
  });

  await check('opening the screen moves the mark forward', async () => {
    _resetBadges();
    const marks: Array<Date | null> = [];
    _setCounter('finance', (since) => { marks.push(since); return 1; });
    await markScreenSeen('master', 'finance');
    await badgeCounts('master');
    await sleep(5);
    await markScreenSeen('master', 'finance');
    await badgeCounts('master');
    assert.equal(marks.length, 2);
    assert.ok(marks[0] && marks[1] && marks[1]!.getTime() > marks[0]!.getTime(), 'the second read starts later than the first');
  });

  await check('marking a screen returns the PREVIOUS mark, so rows can be tagged', async () => {
    /* The panel tags rows newer than this. Handed the new mark it would tag
       nothing at all, and «تعقیب تا آخرین جا» would stop at the sidebar. */
    _resetBadges();
    const first = await markScreenSeen('master', 'support');
    assert.equal(first, null, 'never looked before');
    await sleep(5);
    const second = await markScreenSeen('master', 'support');
    assert.ok(second, 'the second visit knows when the first was');
    await sleep(5);
    const third = await markScreenSeen('master', 'support');
    assert.ok(third! > second!, 'and each one moves forward');
    assert.ok(new Date(third!).getTime() <= Date.now(), 'never in the future');
  });

  /* ── one panel, several people ────────────────────────────────────── */

  await check('one admin looking does not clear another admin’s badge', async () => {
    _resetBadges();
    _setCounter('finance', (since) => (since ? 7 : 0));
    await markScreenSeen('acc:alice', 'finance');
    const alice = await badgeCounts('acc:alice');
    const bob = await badgeCounts('acc:bob');
    assert.equal(alice.screens.finance!.count, 7, 'alice has looked, so she counts from her visit');
    assert.equal(bob.screens.finance!.count, 0, 'bob has never looked — his clock has not started');
    assert.equal(alice.screens.finance!.since != null, true);
    assert.equal(bob.screens.finance!.since, null, 'and their marks are separate');
  });

  /* ── access ───────────────────────────────────────────────────────── */

  await check('no badge for a screen the account cannot open', async () => {
    _resetBadges();
    _setCounter('withdrawals', () => 4);
    _setCounter('support', () => 9);
    const limited = await badgeCounts('acc:x', ['support']);
    assert.equal(limited.screens.support!.count, 9);
    assert.equal(limited.screens.withdrawals, undefined, 'a number they can never act on');
    assert.equal(limited.total, 9, 'and it is not in the total either');
  });

  await check('full access sees everything', async () => {
    _resetBadges();
    _setCounter('withdrawals', () => 4);
    _setCounter('support', () => 9);
    const all = await badgeCounts('master', ['*']);
    assert.equal(all.screens.withdrawals!.count, 4);
    assert.equal(all.screens.support!.count, 9);
    assert.equal(all.total, 13);
  });

  /* ── failure ──────────────────────────────────────────────────────── */

  await check('one broken source does not take the others down', async () => {
    /* Badges sit on top of a working panel. A missing table must cost its own
       number, not everybody else's. */
    _resetBadges();
    _setCounter('withdrawals', () => { throw new Error('relation "withdraw_requests" does not exist'); });
    _setCounter('support', () => 6);
    const b = await badgeCounts('master');
    assert.equal(b.screens.support!.count, 6, 'the healthy one still reports');
    assert.equal(b.screens.withdrawals!.count, 0, 'the broken one reports nothing, not a crash');
  });

  await check('a nonsense count never becomes a negative badge', async () => {
    _resetBadges();
    _setCounter('support', () => -5);
    assert.equal((await badgeCounts('master')).screens.support!.count, 0);
    _setCounter('support', () => NaN as unknown as number);
    assert.equal((await badgeCounts('master')).screens.support!.count, 0);
  });

  await check('the total is the sum of what is shown', async () => {
    _resetBadges();
    _setCounter('withdrawals', () => 2);
    _setCounter('support', () => 3);
    _setCounter('qreports', () => 4);
    const b = await badgeCounts('master');
    const shown = Object.values(b.screens).reduce((n, s) => n + s.count, 0);
    assert.equal(b.total, shown);
    assert.equal(b.total, 9);
  });

  console.log(`[adminBadges] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
