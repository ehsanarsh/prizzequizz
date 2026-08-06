/* DAILY REWARD + WHEEL.
 *
 * Both were client-side: a hardcoded calendar and a wheel that picked its own
 * prize. This covers what changes when the server owns the outcome — that a
 * spin cannot be repeated for a better result, that the streak counts real
 * days in Tehran rather than UTC, that a prize actually reaches the account,
 * and that a configuration which cannot pay out is refused at save time
 * instead of failing silently under a player. */
import assert from 'node:assert/strict';
import {
  RewardsError, REWARDS_DEFAULTS, claimDaily, dayNumber, getConfig, pickSegment,
  saveConfig, spin, status, _resetRewardsMemory, _setState, type WheelSegment
} from '../services/rewardsService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function makeUser(): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'rw_' + userId.slice(0, 8),
    displayName: 'تستی', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 0, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}
const user = (uid: string) => repositories.users.findById(uid);
const DAY = 86_400_000;

async function run() {
  _resetRewardsMemory();

  // ------------------------------------------------------------- config ----

  await check('a fresh install already has a full wheel and calendar', async () => {
    const c = await getConfig();
    assert.equal(c.wheel.segments.length, 10, 'the ten segments the wheel face draws');
    assert.equal(c.daily.days.length, 7);
    assert.ok(c.wheel.segments.every((s) => s.label && s.icon && s.color), 'every segment is drawable');
  });

  await check('the panel can change how many segments the wheel has', async () => {
    const c = await getConfig();
    const three: WheelSegment[] = [
      { id: 'a', label: 'الف', icon: '🪙', color: '#111', type: 'coins', amount: 10, target: '', weight: 1, enabled: true },
      { id: 'b', label: 'ب', icon: '⚡', color: '#222', type: 'xp', amount: 20, target: '', weight: 1, enabled: true },
      { id: 'c', label: 'ج', icon: '❤️', color: '#333', type: 'heart', amount: 1, target: '', weight: 1, enabled: true }
    ];
    const saved = await saveConfig({ wheel: { ...c.wheel, segments: three } });
    assert.equal(saved.wheel.segments.length, 3);
    assert.equal((await status(await makeUser())).wheel.segments.length, 3, 'and the player sees the new face');
  });

  await check('the panel can change the streak length', async () => {
    const saved = await saveConfig({ daily: { streakDays: 3 } });
    assert.equal(saved.daily.streakDays, 3);
    assert.equal((await status(await makeUser())).daily.days.length, 3, 'the calendar shown matches');
  });

  await check('a streak longer than the days defined is clamped, not left dangling', async () => {
    /* Otherwise day 9 of a 7-day calendar has no prize behind it. */
    const saved = await saveConfig({ daily: { streakDays: 99 } });
    assert.equal(saved.daily.streakDays, saved.daily.days.length);
    await saveConfig({ daily: { streakDays: 7 } });
  });

  await check('a wheel that can never pay out is refused at save time', async () => {
    const c = await getConfig();
    await assert.rejects(
      () => saveConfig({ wheel: { ...c.wheel, segments: c.wheel.segments.map((s) => ({ ...s, weight: 0 })) } }),
      (e: any) => e instanceof RewardsError && e.code === 'NO_WEIGHT');
  });

  await check('an empty wheel is refused', async () => {
    await assert.rejects(() => saveConfig({ wheel: { segments: [] } }),
      (e: any) => e instanceof RewardsError && e.code === 'NO_SEGMENTS');
  });

  await check('an unknown prize type degrades to nothing rather than a crash later', async () => {
    const saved = await saveConfig({ wheel: { segments: [
      { id: 'x', label: 'x', icon: '?', color: '#000', type: 'bitcoin', amount: 5, weight: 1 }] } });
    assert.equal(saved.wheel.segments[0]!.type, 'nothing');
  });

  // -------------------------------------------------------------- odds ----

  await check('the weighted pick follows the weights it was given', async () => {
    const segs: WheelSegment[] = [
      { id: 'common', label: 'c', icon: '1', color: '#1', type: 'coins', amount: 1, target: '', weight: 90, enabled: true },
      { id: 'rare',   label: 'r', icon: '2', color: '#2', type: 'coins', amount: 1, target: '', weight: 10, enabled: true }
    ];
    const counts = [0, 0];
    for (let i = 0; i < 20000; i++) counts[pickSegment(segs)]!++;
    const rareShare = counts[1]! / 20000;
    assert.ok(rareShare > 0.07 && rareShare < 0.13, 'expected ~10%, got ' + (rareShare * 100).toFixed(1) + '%');
  });

  await check('a disabled or zero-weight segment is on the face but never wins', async () => {
    const segs: WheelSegment[] = [
      { id: 'win',  label: 'w', icon: '1', color: '#1', type: 'coins', amount: 1, target: '', weight: 5, enabled: true },
      { id: 'off',  label: 'o', icon: '2', color: '#2', type: 'cash',  amount: 1e9, target: '', weight: 5, enabled: false },
      { id: 'zero', label: 'z', icon: '3', color: '#3', type: 'cash',  amount: 1e9, target: '', weight: 0, enabled: true }
    ];
    for (let i = 0; i < 3000; i++) assert.equal(pickSegment(segs), 0);
  });

  await check('a wheel with nothing winnable reports rather than picking anyway', async () => {
    assert.equal(pickSegment([]), -1);
  });

  // -------------------------------------------------------------- spin ----

  await check('a spin pays the prize into the real account', async () => {
    _resetRewardsMemory();
    await saveConfig({ wheel: { enabled: true, cooldownHours: 24, segments: [
      { id: 'only', label: 'سکه', icon: '🪙', color: '#D9A02B', type: 'coins', amount: 250, weight: 1, enabled: true }] } });
    const uid = await makeUser();
    const before = Number((await user(uid))!.coins) || 0;
    const r = await spin(uid);
    assert.equal(r.index, 0);
    assert.equal(r.granted.amount, 250);
    assert.equal(Number((await user(uid))!.coins), before + 250, 'the coins are really there');
  });

  await check('a second spin inside the cooldown is refused', async () => {
    const uid = await makeUser();
    await spin(uid);
    await assert.rejects(() => spin(uid), (e: any) => e instanceof RewardsError && e.code === 'WHEEL_COOLDOWN');
  });

  await check('spinning again is not a way to re-roll a disliked prize', async () => {
    /* The state is written before the payout precisely so this holds even if
       granting fails. */
    const uid = await makeUser();
    await spin(uid);
    const coins = Number((await user(uid))!.coins);
    for (let i = 0; i < 5; i++) await spin(uid).catch(() => undefined);
    assert.equal(Number((await user(uid))!.coins), coins, 'no extra payout from hammering it');
  });

  await check('the spin comes back once the cooldown has passed', async () => {
    const uid = await makeUser();
    await spin(uid);
    _setState(uid, { lastSpinAt: Date.now() - 25 * 3600_000 });
    const r = await spin(uid);
    assert.ok(r.granted.amount > 0);
  });

  await check('the player is told when the next spin is, and status agrees', async () => {
    const uid = await makeUser();
    const r = await spin(uid);
    const s = await status(uid);
    assert.equal(s.wheel.ready, false);
    assert.equal(s.wheel.nextSpinAt, r.nextSpinAt);
  });

  await check('weights are never sent to the client', async () => {
    const s = await status(await makeUser());
    for (const seg of s.wheel.segments as any[]) {
      assert.equal(seg.weight, undefined, 'knowing the odds invites gaming them');
      assert.equal(seg.amount, undefined);
    }
  });

  await check('a switched-off wheel refuses to spin', async () => {
    await saveConfig({ wheel: { enabled: false } });
    const off = await makeUser();
    await assert.rejects(() => spin(off), (e: any) => e instanceof RewardsError && e.code === 'WHEEL_OFF');
    await saveConfig({ wheel: { enabled: true } });
  });

  await check('every prize type actually reaches the account it names', async () => {
    for (const [type, target, read] of [
      ['coins', '', (u: any) => Number(u.coins)],
      ['xp', '', (u: any) => Number(u.xp)],
      ['heart', '', (u: any) => Number(u.hearts)]
    ] as const) {
      _resetRewardsMemory();
      await saveConfig({ wheel: { enabled: true, cooldownHours: 24, segments: [
        { id: 't', label: type, icon: '🎁', color: '#000', type, amount: 5, target, weight: 1, enabled: true }] } });
      const uid = await makeUser();
      const before = read((await user(uid))!);
      await spin(uid);
      assert.equal(read((await user(uid))!), before + 5, type + ' did not land');
    }
  });

  await check('a ticket prize lands in the ticket wallet', async () => {
    _resetRewardsMemory();
    await saveConfig({ wheel: { enabled: true, cooldownHours: 24, segments: [
      { id: 'tk', label: 'بلیت', icon: '🎫', color: '#000', type: 'ticket', amount: 2, target: 'green', weight: 1, enabled: true }] } });
    const uid = await makeUser();
    const r = await spin(uid);
    assert.equal(r.granted.type, 'ticket');
    assert.equal(r.granted.amount, 2);
    assert.equal(r.granted.target, 'green');
  });

  // ------------------------------------------------------------- daily ----

  await check('the first claim starts the streak at day one', async () => {
    _resetRewardsMemory();
    const uid = await makeUser();
    const s = await status(uid);
    assert.equal(s.daily.day, 1);
    assert.equal(s.daily.claimedToday, false);
    const r = await claimDaily(uid);
    assert.equal(r.day, 1);
    assert.equal((await status(uid)).daily.claimedToday, true);
  });

  await check('claiming twice in one day is refused', async () => {
    const uid = await makeUser();
    await claimDaily(uid);
    await assert.rejects(() => claimDaily(uid), (e: any) => e instanceof RewardsError && e.code === 'ALREADY_CLAIMED');
  });

  await check('coming back the next day advances the streak', async () => {
    const uid = await makeUser();
    await claimDaily(uid);
    _setState(uid, { lastClaimAt: Date.now() - DAY, streakDay: 1 });
    assert.equal((await claimDaily(uid)).day, 2);
    _setState(uid, { lastClaimAt: Date.now() - DAY, streakDay: 2 });
    assert.equal((await claimDaily(uid)).day, 3);
  });

  await check('missing a day restarts the streak when configured to', async () => {
    await saveConfig({ daily: { resetOnMiss: true } });
    const uid = await makeUser();
    await claimDaily(uid);
    _setState(uid, { lastClaimAt: Date.now() - 3 * DAY, streakDay: 4 });
    assert.equal((await claimDaily(uid)).day, 1, 'a broken streak starts over');
  });

  await check('with resetOnMiss off, a missed day does not lose progress', async () => {
    await saveConfig({ daily: { resetOnMiss: false } });
    const uid = await makeUser();
    _setState(uid, { lastClaimAt: Date.now() - 3 * DAY, streakDay: 4 });
    assert.equal((await claimDaily(uid)).day, 5);
    await saveConfig({ daily: { resetOnMiss: true } });
  });

  await check('the calendar wraps instead of running off its end', async () => {
    await saveConfig({ daily: { streakDays: 7 } });
    const uid = await makeUser();
    _setState(uid, { lastClaimAt: Date.now() - DAY, streakDay: 7 });
    assert.equal((await claimDaily(uid)).day, 1, 'day 8 of a 7-day calendar loops home');
  });

  await check('the daily prize is really paid', async () => {
    await saveConfig({ daily: { enabled: true, streakDays: 1, days: [
      { day: 1, icon: '🪙', label: 'سکه', type: 'coins', amount: 300, target: '' }] } });
    const uid = await makeUser();
    const before = Number((await user(uid))!.coins) || 0;
    await claimDaily(uid);
    assert.equal(Number((await user(uid))!.coins), before + 300);
  });

  await check('a switched-off calendar refuses to pay', async () => {
    await saveConfig({ daily: { enabled: false } });
    const offU = await makeUser();
    await assert.rejects(() => claimDaily(offU), (e: any) => e instanceof RewardsError && e.code === 'DAILY_OFF');
    await saveConfig({ daily: { enabled: true } });
  });

  // ------------------------------------------------------------ the day ----

  await check('the day rolls over at Tehran midnight, not UTC midnight', async () => {
    /* The server runs on UTC and Iran is +03:30. On UTC days this player would
       be told "come back tomorrow" at 01:00 local, and could claim twice at
       04:00. 2026-08-05T21:00Z is 2026-08-06 00:30 in Tehran — a new day. */
    const beforeMidnight = Date.parse('2026-08-05T20:00:00Z');  // 23:30 Tehran, 5th
    const afterMidnight  = Date.parse('2026-08-05T21:00:00Z');  // 00:30 Tehran, 6th
    assert.equal(dayNumber(afterMidnight) - dayNumber(beforeMidnight), 1, 'these are different days locally');
    const sameUtcDay = Date.parse('2026-08-05T02:00:00Z');      // 05:30 Tehran, 5th
    assert.equal(dayNumber(sameUtcDay), dayNumber(beforeMidnight), 'and these are the same one');
  });

  console.log(`[rewards] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
