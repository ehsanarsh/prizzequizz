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
  deleteDef, periodFor, weekKey, _resetMissionMemory
} from '../services/missionService.js';
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

  await check('a player is dealt five dailies and three weeklies', async () => {
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

  console.log(`[missions] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
run();
