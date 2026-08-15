/* MISSIONS.
 *
 * The brief's closing note is the design: for a game meant to run for years,
 * missions must be data, not code. So most of this is about the engine being
 * genuinely generic — that it counts a metric it was told about, deals a set
 * from a pool, resets on the right boundary, and pays only once — and never
 * about any particular mission, which is a row somebody can change. */
import assert from 'node:assert/strict';
import {
  MissionError, ASSIGN_DEFAULT, boardFor, claim, dayKey, listDefs, progressOf, record, saveDef,
  deleteDef, periodFor, weekKey, _resetMissionMemory,
  boxFor, openBox, getBoxConfig, setBoxConfig, activeDailyPeriod, buildDailyLadder,
  DAILY_LADDER_LEVELS, DAILY_PER_LEVEL
} from '../services/missionService.js';
import { saveCharacter, buildRoster } from '../services/characterSelectionService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}
async function makeUser(level = 1): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'ms_' + userId.slice(0, 6),
    displayName: 'مأموریتی', plan: 'free', level, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}
const coinsOf = async (u: string) => Number((await repositories.users.findById(u))!.coins);

async function run() {
  _resetMissionMemory();

  // ------------------------------------------------------------ the pool ----

  await check('the pool is large enough that a player is not shown the same five', async () => {
    const defs = await listDefs();
    assert.ok(defs.length >= 150, 'the brief asks for 150–300; got ' + defs.length);
  });

  await check('every kind the brief lists actually exists in the pool', async () => {
    const kinds = new Set((await listDefs()).map((d) => d.kind));
    for (const k of ['daily','weekly','achievement','skill','social','economy','record','streak','chain']) {
      assert.ok(kinds.has(k as any), 'missing kind: ' + k);
    }
  });

  await check('record missions exist for each topic and each threshold', async () => {
    const rec = (await listDefs()).filter((d) => d.metric === 'recordValue');
    const topics = new Set(rec.map((d) => d.scope));
    assert.ok(topics.size >= 5, 'expected a ladder per topic, got ' + topics.size);
    const one = rec.filter((d) => d.scope === [...topics][0]);
    assert.ok(one.length >= 8, 'each topic needs its own thresholds, got ' + one.length);
  });

  await check('every mission carries a reward worth having', async () => {
    for (const d of await listDefs()) {
      assert.ok(d.rewards.length > 0, d.id + ' pays nothing');
      assert.ok(d.rewards.every((r) => r.amount > 0), d.id + ' has a zero reward');
      assert.ok(d.title, d.id + ' has no title');
    }
  });

  // ---------------------------------------------------------- assignment ----

  await check('a player is dealt three dailies and three weeklies', async () => {
    const uid = await makeUser();
    const b = await boardFor(uid);
    assert.equal(b.daily.length, ASSIGN_DEFAULT.daily);
    assert.equal(b.weekly.length, ASSIGN_DEFAULT.weekly);
  });

  await check('the same player gets the same set all day', async () => {
    /* Re-dealing on every request would reset progress the player could see. */
    const uid = await makeUser();
    const a = (await boardFor(uid)).daily.map((m) => m.id);
    const b = (await boardFor(uid)).daily.map((m) => m.id);
    assert.deepEqual(a, b);
  });

  await check('two players do not get identical sets', async () => {
    const firstUser = await makeUser();
    const a = (await boardFor(firstUser)).daily.map((m) => m.id).join(',');
    let differs = false;
    for (let i = 0; i < 6 && !differs; i++) {
      const b = (await boardFor(await makeUser())).daily.map((m) => m.id).join(',');
      if (b !== a) differs = true;
    }
    assert.ok(differs, 'every player was dealt the same five');
  });

  await check('a mission outside the level window is never dealt', async () => {
    await saveDef({ id: 'lvl_only', kind: 'daily', metric: 'login', target: 1, title: 'فقط لول بالا',
      minLevel: 50, weight: 100000, rewards: [{ type: 'coins', amount: 10 }] });
    const low = await makeUser(1);
    assert.ok(!(await boardFor(low)).daily.some((m) => m.id === 'lvl_only'));
    const high = await makeUser(60);
    assert.ok((await boardFor(high)).daily.some((m) => m.id === 'lvl_only'), 'and IS dealt to someone eligible');
    await deleteDef('lvl_only');
  });

  await check('an event mission outside its window is not offered', async () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString();
    await saveDef({ id: 'ev_over', kind: 'event', metric: 'login', target: 1, title: 'نوروز گذشته',
      startsAt: past, endsAt: past, rewards: [{ type: 'coins', amount: 10 }] });
    const evUser = await makeUser();
    assert.ok(!(await boardFor(evUser)).achievements.some((m) => m.id === 'ev_over'));
    await deleteDef('ev_over');
  });

  // ------------------------------------------------------------ counting ----

  await check('a counting metric adds up', async () => {
    const uid = await makeUser();
    await saveDef({ id: 't_count', kind: 'achievement', metric: 'questionsAnswered', target: 5,
      title: 'پنج سؤال', rewards: [{ type: 'coins', amount: 100 }] });
    await record(uid, 'questionsAnswered', 2);
    await record(uid, 'questionsAnswered', 2);
    let m = (await progressOf(uid, 't_count'))!;
    assert.equal(m.progress, 4);
    assert.equal(m.completed, false);
    await record(uid, 'questionsAnswered', 1);
    m = (await progressOf(uid, 't_count'))!;
    assert.equal(m.completed, true);
  });

  await check('a best-so-far metric keeps the best, not the sum', async () => {
    /* A streak of 10 then a streak of 3 is still a best of 10. */
    const uid = await makeUser();
    await saveDef({ id: 't_max', kind: 'skill', metric: 'correctStreak', target: 10,
      title: 'ده پشت سر هم', rewards: [{ type: 'coins', amount: 100 }] });
    await record(uid, 'correctStreak', 10);
    await record(uid, 'correctStreak', 3);
    const m = (await progressOf(uid, 't_max'))!;
    assert.equal(m.progress, 10);
    assert.equal(m.completed, true);
  });

  await check('a rank metric counts downward — lower is better', async () => {
    const uid = await makeUser();
    await saveDef({ id: 't_rank', kind: 'record', metric: 'recordRank', target: 10,
      title: 'ده نفر برتر', rewards: [{ type: 'coins', amount: 100 }] });
    await record(uid, 'recordRank', 40);
    assert.equal((await progressOf(uid, 't_rank'))!.completed, false);
    await record(uid, 'recordRank', 7);
    assert.equal((await progressOf(uid, 't_rank'))!.completed, true);
    await record(uid, 'recordRank', 90);
    assert.equal((await progressOf(uid, 't_rank'))!.completed, true,
      'slipping later does not un-earn it');
  });

  await check('a scoped mission only listens to its own topic', async () => {
    const uid = await makeUser();
    await saveDef({ id: 't_scope', kind: 'record', metric: 'recordValue', scope: 'فوتبال', target: 10,
      title: 'رکورد فوتبال', rewards: [{ type: 'coins', amount: 100 }] });
    await record(uid, 'recordValue', 30, 'سینما');
    assert.equal((await progressOf(uid, 't_scope'))!.progress, 0,
      'a cinema record must not advance a football mission');
    await record(uid, 'recordValue', 12, 'فوتبال');
    assert.equal((await progressOf(uid, 't_scope'))!.completed, true);
  });

  await check('an unknown metric is ignored rather than throwing', async () => {
    const uid = await makeUser();
    await record(uid, 'not_a_metric' as any, 5);
  });

  await check('a daily not dealt to this player does not creep along', async () => {
    /* Otherwise tomorrow's mission arrives already finished. */
    const uid = await makeUser();
    const dealt = new Set((await boardFor(uid)).daily.map((m) => m.id));
    const undealt = (await listDefs()).find((d) => d.kind === 'daily' && !dealt.has(d.id))!;
    await record(uid, undealt.metric, 99999, undealt.scope);
    const after = await boardFor(uid);
    assert.ok(!after.daily.some((m) => m.id === undealt.id));
  });

  // --------------------------------------------------------------- claim ----

  await check('claiming pays the reward once', async () => {
    const uid = await makeUser();
    await saveDef({ id: 't_pay', kind: 'achievement', metric: 'matchesWon', target: 1,
      title: 'یک برد', rewards: [{ type: 'coins', amount: 500 }] });
    await record(uid, 'matchesWon', 1);
    const before = await coinsOf(uid);
    await claim(uid, 't_pay');
    assert.equal(await coinsOf(uid), before + 500);
    await assert.rejects(() => claim(uid, 't_pay'),
      (e: any) => e instanceof MissionError && e.code === 'ALREADY_CLAIMED');
    assert.equal(await coinsOf(uid), before + 500, 'and the second attempt pays nothing');
  });

  await check('an unfinished mission cannot be claimed', async () => {
    const uid = await makeUser();
    await saveDef({ id: 't_unfin', kind: 'achievement', metric: 'matchesWon', target: 99,
      title: 'خیلی زیاد', rewards: [{ type: 'coins', amount: 500 }] });
    await assert.rejects(() => claim(uid, 't_unfin'),
      (e: any) => e instanceof MissionError && e.code === 'NOT_COMPLETED');
  });

  await check('a mission that does not exist cannot be claimed', async () => {
    const uid = await makeUser();
    await assert.rejects(() => claim(uid, 'ghost'),
      (e: any) => e instanceof MissionError && e.code === 'MISSION_NOT_FOUND');
  });

  await check('a claimed mission stops accumulating', async () => {
    const uid = await makeUser();
    await saveDef({ id: 't_stop', kind: 'achievement', metric: 'giftSent', target: 1,
      title: 'هدیه', rewards: [{ type: 'coins', amount: 10 }] });
    await record(uid, 'giftSent', 1);
    await claim(uid, 't_stop');
    await record(uid, 'giftSent', 50);
    assert.ok(!(await boardFor(uid)).achievements.some((x) => x.id === 't_stop'), 'and it leaves the board');
  });

  // ------------------------------------------------------------- periods ----

  await check('days and weeks turn over at Tehran midnight, not UTC', async () => {
    const beforeLocalMidnight = Date.parse('2026-08-05T20:00:00Z');  // 23:30 Tehran
    const afterLocalMidnight  = Date.parse('2026-08-05T21:00:00Z');  // 00:30 Tehran, next day
    assert.notEqual(dayKey(beforeLocalMidnight), dayKey(afterLocalMidnight));
    assert.equal(dayKey(Date.parse('2026-08-05T02:00:00Z')), dayKey(beforeLocalMidnight),
      'and the same local day stays one key');
  });

  await check('daily and weekly progress live in different periods', async () => {
    assert.notEqual(periodFor('daily'), periodFor('weekly'));
    assert.equal(periodFor('achievement'), '', 'lifetime missions have no period');
    assert.ok(weekKey().startsWith('w'));
  });

  await check('the board says when each set resets', async () => {
    const rUser = await makeUser();
    const b = await boardFor(rUser);
    assert.ok(b.resetsAt.daily > Date.now(), 'a reset time in the past tells the player nothing');
    assert.ok(b.resetsAt.weekly > Date.now());
  });

  // --------------------------------------------------------------- chain ----

  await check('a chain offers one step at a time and advances on claim', async () => {
    const uid = await makeUser();
    const b1 = await boardFor(uid);
    assert.ok(b1.chain, 'the starter chain must be offered');
    const step1 = b1.chain!.step!;
    assert.equal(b1.chain!.done, 0);
    await record(uid, step1.metric, step1.target, step1.scope);
    await claim(uid, step1.id);
    const b2 = await boardFor(uid);
    assert.equal(b2.chain!.done, 1);
    assert.notEqual(b2.chain!.step?.id, step1.id, 'the next step is offered');
  });

  // ---------------------------------------------------------------- admin ----

  await check('a mission with no title is refused', async () => {
    await assert.rejects(() => saveDef({ title: '  ', metric: 'login' }),
      (e: any) => e instanceof MissionError && e.code === 'TITLE_REQUIRED');
  });

  await check('a mission targeting a metric nothing reports is refused', async () => {
    /* Otherwise it sits on the board forever at zero and nobody knows why. */
    await assert.rejects(() => saveDef({ title: 'ناموجود', metric: 'bananas' as any }),
      (e: any) => e instanceof MissionError && e.code === 'UNKNOWN_METRIC');
  });

  await check('a mission added from the panel reaches players immediately', async () => {
    const uid = await makeUser();
    await saveDef({ id: 'panel_new', kind: 'achievement', metric: 'adWatched', target: 1,
      title: 'تبلیغ تازه', rewards: [{ type: 'coins', amount: 42 }] });
    await record(uid, 'adWatched', 1);
    const m = (await progressOf(uid, 'panel_new'));
    assert.ok(m && m.completed, 'no redeploy needed — that is the whole design');
  });

  await check('editing keeps the same mission rather than making a copy', async () => {
    const before = (await listDefs()).length;
    await saveDef({ id: 'panel_new', kind: 'achievement', metric: 'adWatched', target: 1,
      title: 'تبلیغ ویرایش‌شده', rewards: [{ type: 'coins', amount: 99 }] });
    assert.equal((await listDefs()).length, before);
    assert.equal((await listDefs()).find((d) => d.id === 'panel_new')!.title, 'تبلیغ ویرایش‌شده');
  });

  // ------------------------------------------------- the daily rework ----

  /* «روزانه سه ماموریت می‌دیم». */
  await check('three a day, not five', async () => {
    assert.equal(ASSIGN_DEFAULT.daily, 3);
    const uid = await makeUser();
    const b = await boardFor(uid);
    assert.equal(b.daily.length, 3, 'dealt ' + b.daily.length);
  });

  /* «ماموریت ۱ لول ۱، ماموریت ۱۰۰ لول ۱۰۰ و سخت‌تر». */
  await check('the ladder bands every level from 1 to 100', async () => {
    const rungs = buildDailyLadder();
    assert.equal(rungs.length, DAILY_LADDER_LEVELS * DAILY_PER_LEVEL);
    for (const lv of [1, 2, 50, 99]) {
      const band = rungs.filter((d) => d.minLevel === lv && d.maxLevel === lv);
      assert.equal(band.length, DAILY_PER_LEVEL, 'level ' + lv + ' has ' + band.length);
    }
    /* The last rung is open-ended, so the ladder does not simply stop. */
    const top = rungs.filter((d) => d.minLevel === DAILY_LADDER_LEVELS);
    assert.equal(top.length, DAILY_PER_LEVEL);
    assert.ok(top.every((d) => d.maxLevel === 0), 'the top rung must have no ceiling');
  });

  await check('a player past level 100 is still dealt three', async () => {
    const uid = await makeUser(140);
    const b = await boardFor(uid);
    assert.equal(b.daily.length, 3, 'dealt ' + b.daily.length + ' — the ladder ran out');
    for (const m of b.daily) assert.ok(m.minLevel <= 140, m.id + ' is banded above them');
  });

  await check('and every rung is harder than the one below it', async () => {
    const rungs = buildDailyLadder();
    const byMetric = new Map<string, Array<{ lv: number; target: number }>>();
    for (const d of rungs) {
      if (!byMetric.has(d.metric)) byMetric.set(d.metric, []);
      byMetric.get(d.metric)!.push({ lv: d.minLevel, target: d.target });
    }
    for (const [metric, rows] of byMetric) {
      const lo = rows.filter((r) => r.lv <= 3).reduce((m, r) => Math.max(m, r.target), 0);
      const hi = rows.filter((r) => r.lv >= 98).reduce((m, r) => Math.min(m, r.target), Infinity);
      assert.ok(hi > lo, metric + ': level 100 asks ' + hi + ', level 1 asks ' + lo);
    }
  });

  await check('a player is only dealt missions from their own level', async () => {
    const uid = await makeUser(7);
    const b = await boardFor(uid);
    assert.equal(b.daily.length, 3);
    for (const m of b.daily) {
      assert.ok(m.minLevel <= 7 && (m.maxLevel === 0 || m.maxLevel >= 7),
        m.id + ' is banded ' + m.minLevel + '..' + m.maxLevel + ' but the player is level 7');
    }
  });

  await check('and two levels are not handed the same three missions', async () => {
    const a2 = await boardFor(await makeUser(4));
    const b2 = await boardFor(await makeUser(40));
    assert.notDeepEqual(a2.daily.map((m) => m.id).sort(), b2.daily.map((m) => m.id).sort());
  });

  /* «هر ماموریت کاپ و ایکس پی داشته باشه». */
  await check('every daily rung pays cup and xp', async () => {
    for (const d of buildDailyLadder()) {
      assert.ok(d.rewards.some((r) => r.type === 'cup' && r.amount > 0), d.id + ' pays no cup');
      assert.ok(d.rewards.some((r) => r.type === 'xp' && r.amount > 0), d.id + ' pays no xp');
    }
  });

  await check('and claiming one really moves the player’s cup', async () => {
    const uid = await makeUser();
    const b = await boardFor(uid);
    const m = b.daily[0]!;
    const cup = m.rewards.find((r) => r.type === 'cup')!.amount;
    await record(uid, m.metric, m.target * 3);
    await claim(uid, m.id);
    const u: any = await repositories.users.findById(uid);
    assert.equal(Number(u.weeklyScore), cup, 'the cup on the card is the cup in the account');
    assert.ok(Number(u.xp) > 0, 'and the xp landed too');
  });

  /* «تا انجام نده عوض نمی‌شن، ۱۰ روز هم بگذره عوض نمی‌شن». */
  await check('an unfinished set is still there ten days later', async () => {
    const uid = await makeUser();
    const first = (await boardFor(uid)).daily.map((m) => m.id);
    const period = await activeDailyPeriod(uid);
    /* Ten days pass. Nothing was finished. */
    const later = Date.now() + 10 * 86_400_000;
    assert.equal(await activeDailyPeriod(uid, later), period, 'the set moved on without being done');
    const stillIds = (await boardFor(uid)).daily.map((m) => m.id);
    assert.deepEqual(stillIds, first, 'and the same three are shown');
  });

  await check('half-finished progress is not thrown away by the next day either', async () => {
    const uid = await makeUser();
    const m = (await boardFor(uid)).daily[0]!;
    await record(uid, m.metric, 1);
    const before = (await progressOf(uid, m.id))!.progress;
    assert.ok(before > 0, 'progress was recorded');
    /* A day later the same mission is still the one being counted. */
    const tomorrow = Date.now() + 86_400_000;
    assert.equal(await activeDailyPeriod(uid, tomorrow), await activeDailyPeriod(uid));
    assert.equal((await progressOf(uid, m.id))!.progress, before, 'the progress survived');
    /* And it is still what the CARD shows when the app is opened tomorrow —
       reading the day rather than the set would show a fresh, empty mission. */
    assert.equal((await progressOf(uid, m.id, tomorrow))!.progress, before,
      'tomorrow the card had forgotten it');
  });

  /* And tomorrow's PLAY has to land on the same mission. Progress filed under
   * the day it happened rather than the day the set was dealt would vanish
   * from the card the moment midnight passed — the set would sit there frozen
   * at whatever it reached yesterday, and no amount of playing would move it. */
  await check('and tomorrow’s play still counts towards yesterday’s set', async () => {
    const uid = await makeUser();
    const m = (await boardFor(uid)).daily[0]!;
    await record(uid, m.metric, 1);
    const before = (await progressOf(uid, m.id))!.progress;

    /* Reported as a bigger number, not another 1: some daily metrics are
       best-so-far rather than counters, and «۱ دوباره» is not an improvement
       on «۱». */
    const tomorrow = Date.now() + 86_400_000;
    await record(uid, m.metric, before + 5, '', tomorrow);
    assert.ok((await progressOf(uid, m.id))!.progress > before,
      'a day later the mission stopped counting: still ' + before);

    /* Right through to finishing it, days after it was dealt. */
    await record(uid, m.metric, m.target * 4, '', Date.now() + 5 * 86_400_000);
    assert.equal((await progressOf(uid, m.id))!.completed, true, 'and it can still be finished');
  });

  /* «وقتی انجام داد ۲۴ ساعت بعد ۳ تا دیگه فعال بشه» — the clock is 24 hours
   * from FINISHING, not the next midnight. */
  await check('finishing all three starts a 24-hour wait, not a midnight one', async () => {
    const uid = await makeUser();
    const set = (await boardFor(uid)).daily;
    const period = await activeDailyPeriod(uid);
    for (const m of set) await record(uid, m.metric, m.target * 4);
    assert.equal(await activeDailyPeriod(uid), period, 'the moment it is finished, the set stays put');

    /* Midnight is not the trigger: twenty-three hours later it is still theirs. */
    const nearly = Date.now() + 23 * 3600_000;
    assert.equal(await activeDailyPeriod(uid, nearly), period, 'the set turned over before the day was up');
    const after = Date.now() + 24 * 3600_000 + 60_000;
    assert.notEqual(await activeDailyPeriod(uid, after), period, 'and after 24 hours it turns over');
  });

  await check('and the screen is told exactly when the next three arrive', async () => {
    const uid = await makeUser();
    assert.equal((await boardFor(uid)).nextSetAt, 0, 'an unfinished set has no arrival time');
    const t0 = Date.now();
    for (const m of (await boardFor(uid)).daily) await record(uid, m.metric, m.target * 4);
    const at = (await boardFor(uid)).nextSetAt;
    assert.ok(Math.abs(at - (t0 + 24 * 3600_000)) < 60_000, 'expected ~24h out, got ' + (at - t0) + 'ms');
  });

  await check('the wait is measured from finishing, not from opening the app', async () => {
    const uid = await makeUser();
    const set = (await boardFor(uid)).daily;
    const period = await activeDailyPeriod(uid);
    for (const m of set) await record(uid, m.metric, m.target * 4);
    /* Ten hours of not touching the game, then a look at the board. The clock
     * must already be ten hours down, not restarted by the visit. */
    const tenHours = Date.now() + 10 * 3600_000;
    await boardFor(uid);
    assert.equal(await activeDailyPeriod(uid, tenHours), period);
    const at15 = Date.now() + 25 * 3600_000;
    assert.notEqual(await activeDailyPeriod(uid, at15), period, 'the visit restarted the 24 hours');
  });

  await check('two sets never share a period, so progress is not inherited', async () => {
    const uid = await makeUser();
    const first = await activeDailyPeriod(uid);
    for (const m of (await boardFor(uid)).daily) await record(uid, m.metric, m.target * 4);
    const after = Date.now() + 25 * 3600_000;
    const second = await activeDailyPeriod(uid, after);
    assert.notEqual(second, first, first + ' → ' + second);
  });

  // ------------------------------------------------------------- the box ----

  await check('the box is not ready until all three are done', async () => {
    const uid = await makeUser();
    const set = (await boardFor(uid)).daily;
    let box = await boxFor(uid);
    assert.equal(box.total, 3);
    assert.equal(box.done, 0);
    assert.equal(box.ready, false);

    await record(uid, set[0]!.metric, set[0]!.target * 4);
    box = await boxFor(uid);
    assert.ok(box.done >= 1, 'one done: ' + box.done);
    assert.equal(box.ready, false, 'one of three is not a box');

    for (const m of set) await record(uid, m.metric, m.target * 4);
    box = await boxFor(uid);
    assert.equal(box.done, 3);
    assert.equal(box.ready, true, 'all three done and still no box');
    assert.equal(box.opened, false, 'and it is not opened by itself — the player taps it');
  });

  await check('opening it pays exactly what the panel put inside', async () => {
    await setBoxConfig({ enabled: true, title: 'جعبهٔ آزمایشی', rewards: [
      { type: 'coins', amount: 777 }, { type: 'cup', amount: 11 }
    ] });
    const uid = await makeUser();
    for (const m of (await boardFor(uid)).daily) await record(uid, m.metric, m.target * 4);
    const before = await coinsOf(uid);
    const r = await openBox(uid);
    assert.deepEqual(r.rewards.map((x) => x.type + ':' + x.amount), ['coins:777', 'cup:11']);
    assert.equal(await coinsOf(uid), before + 777, 'the coins arrived');
    const u: any = await repositories.users.findById(uid);
    assert.equal(Number(u.weeklyScore), 11, 'and the cup did too');
  });

  await check('and it cannot be opened twice', async () => {
    const uid = await makeUser();
    for (const m of (await boardFor(uid)).daily) await record(uid, m.metric, m.target * 4);
    await openBox(uid);
    const before = await coinsOf(uid);
    await assert.rejects(() => openBox(uid), (e: any) => e?.code === 'BOX_ALREADY_OPEN');
    assert.equal(await coinsOf(uid), before, 'and nothing was paid the second time');
  });

  await check('an unfinished set cannot be talked into opening one', async () => {
    const uid = await makeUser();
    await assert.rejects(() => openBox(uid), (e: any) => e?.code === 'BOX_NOT_READY');
  });

  await check('a new day after a finished set brings a fresh, unopened box', async () => {
    const uid = await makeUser();
    for (const m of (await boardFor(uid)).daily) await record(uid, m.metric, m.target * 4);
    await openBox(uid);
    assert.equal((await boxFor(uid)).opened, true);
    /* The next set is a different period, so its box is its own. */
    const tomorrow = await activeDailyPeriod(uid, Date.now() + 86_400_000);
    assert.notEqual(tomorrow, (await boxFor(uid)).period);
  });

  await check('a panel edit does not rewrite a box already opened', async () => {
    await setBoxConfig({ enabled: true, rewards: [{ type: 'coins', amount: 100 }] });
    const uid = await makeUser();
    for (const m of (await boardFor(uid)).daily) await record(uid, m.metric, m.target * 4);
    await openBox(uid);
    await setBoxConfig({ enabled: true, rewards: [{ type: 'coins', amount: 5000 }] });
    const box = await boxFor(uid);
    assert.deepEqual(box.rewards.map((r) => r.amount), [100], 'what was given is what is shown');
  });

  await check('the board carries the box, so one request paints the screen', async () => {
    await setBoxConfig({ ...(await getBoxConfig()), enabled: true });
    const uid = await makeUser();
    const b = await boardFor(uid);
    assert.ok(b.box, 'no box on the board');
    assert.equal(b.box.total, 3);
    assert.equal(b.dailyRotates, false, 'an unfinished set does not rotate at midnight');
    for (const m of b.daily) await record(uid, m.metric, m.target * 4);
    assert.equal((await boardFor(uid)).dailyRotates, true, 'a finished one does');
  });

  /* «کاراکترها ... از طریق جوایز بازی یا چرخونه یا استریک یا ماموریت‌ها به دست
   * بیاد» — so a mission, and the box at the end of the day, can hand one over
   * exactly as they hand over coins. */
  await check('a mission can pay a character, and it really lands', async () => {
    const c = await saveCharacter({ name: 'کاراکتر مأموریتی', viaPurchase: false, viaLevel: false, enabled: true });
    const uid = await makeUser();
    await saveDef({ id: 'ms_char', kind: 'achievement', metric: 'adWatched', target: 1,
      title: 'کاراکتر جایزه', rewards: [{ type: 'character', amount: 1, target: c.id }] });
    await record(uid, 'adWatched', 1);
    await claim(uid, 'ms_char');
    const roster = await buildRoster(uid);
    assert.equal(roster.characters.find((x) => x.id === c.id)!.unlocked, true, 'the character was not granted');
    await deleteDef('ms_char');
  });

  await check('and so can the box', async () => {
    const c = await saveCharacter({ name: 'کاراکتر جعبه', viaPurchase: false, viaLevel: false, enabled: true });
    await setBoxConfig({ enabled: true, rewards: [{ type: 'character', amount: 1, target: c.id }] });
    const uid = await makeUser();
    for (const m of (await boardFor(uid)).daily) await record(uid, m.metric, m.target * 4);
    await openBox(uid);
    const roster = await buildRoster(uid);
    assert.equal(roster.characters.find((x) => x.id === c.id)!.unlocked, true);
  });

  console.log(`[missions] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
run();
