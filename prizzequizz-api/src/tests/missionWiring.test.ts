/* MISSION WIRING.
 *
 * The bug this suite exists for: «یک مسابقه ببر» never completed no matter how
 * many duels you won, while the record-mode missions worked perfectly. The
 * engine was fine — nothing outside record mode had ever been wired to report
 * anything, so most of the pool counted events that were never sent.
 *
 * So these tests are deliberately about the REPORTERS, not the engine. They ask
 * the question the player asked: I did the thing — did the mission move? Each
 * one plays the event through the same function the game calls, then reads the
 * mission's own progress back.
 *
 * Run: npx tsx src/tests/missionWiring.test.ts */
import assert from 'node:assert/strict';
import {
  boardFor, counterValue, dayKey, listDefs, progressOf, recordAnswer, recordLogin, recordMatch,
  recordMoney, recordPurchase, recordSocial, saveDef, _resetMissionMemory
} from '../services/missionService.js';
import { createMatchForPlayers, forfeitMatch, getMatch, startMatch, submitAnswer } from '../services/matchEngine.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function makeUser(level = 1): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'mw_' + userId.slice(0, 6),
    displayName: 'بازیکن', plan: 'free', level, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}

/** Progress on one mission id, or -1 when the mission does not exist. */
async function prog(userId: string, missionId: string): Promise<number> {
  const v = await progressOf(userId, missionId);
  return v ? v.progress : -1;
}

/** Every daily/weekly a player was actually dealt, so a test can pick one that
 *  is live for them rather than assuming the deal. */
async function dealtMetrics(userId: string): Promise<Map<string, { id: string; target: number }>> {
  const b = await boardFor(userId);
  const out = new Map<string, { id: string; target: number }>();
  for (const m of [...b.daily, ...b.weekly]) out.set(m.metric, { id: m.id, target: m.target });
  return out;
}

async function run(): Promise<void> {
  _resetMissionMemory();

  // ------------------------------------------------------- the duel path ----

  await check('winning a match completes «یک مسابقه ببر»', async () => {
    const u = await makeUser();
    /* The starter chain's first step is exactly the mission the player reported:
     * they won, and it stayed at zero. */
    assert.equal(await prog(u, 'ch_start_1'), 0, 'should start unwon');
    await recordMatch({ userId: u, won: true });
    assert.equal(await prog(u, 'ch_start_1'), 1, 'a win must move matchesWon');
    const v = await progressOf(u, 'ch_start_1');
    assert.ok(v!.completed, 'and at target 1 it must be complete');
  });

  await check('losing a match counts as played but not as won', async () => {
    const u = await makeUser();
    await recordMatch({ userId: u, won: false });
    assert.equal(await prog(u, 'a_matchesPlayed_1'), 1);
    assert.equal(await prog(u, 'ch_start_1'), 0);
  });

  await check('answers move questionsAnswered and correctAnswers separately', async () => {
    /* questionsAnswered only has DAILY missions in the seed, and a daily is
     * inert unless it was dealt — so the count is checked on a lifetime mission
     * of our own rather than on whichever five this player happened to get. */
    await saveDef({ id: 'test_answered', kind: 'achievement', metric: 'questionsAnswered', target: 99,
      title: 'شمارش پاسخ‌ها', rewards: [], enabled: true });
    const u = await makeUser();
    await recordAnswer(u, true, 1);
    await recordAnswer(u, false, 0);
    await recordAnswer(u, true, 1);
    assert.equal(await prog(u, 'a_correctAnswers_100'), 2, 'two of the three were correct');
    /* The chain's second step counts correct answers to 10. */
    assert.equal(await prog(u, 'ch_start_2'), 2);
    /* The wrong one still counts as a question answered. */
    assert.equal(await prog(u, 'test_answered'), 3);
  });

  await check('a correct-answer run is kept at its best, not its latest', async () => {
    const u = await makeUser();
    for (let i = 1; i <= 6; i++) await recordAnswer(u, true, i);
    await recordAnswer(u, false, 0);            // run broken
    await recordAnswer(u, true, 1);             // and restarted
    assert.equal(await prog(u, 's_correctStreak_5'), 6, 'best run of 6 must survive the break');
  });

  await check('a bot opponent reports nothing', async () => {
    const bot = 'bot_' + id();
    await recordMatch({ userId: bot, won: true });
    await recordAnswer(bot, true, 3);
    assert.equal(await prog(bot, 'ch_start_1'), 0);
  });

  // ------------------------------------------------------------ streaks ----

  await check('five wins in a row completes the chain, and a loss resets the run', async () => {
    const u = await makeUser();
    for (let i = 0; i < 4; i++) await recordMatch({ userId: u, won: true });
    assert.equal(await counterValue(u, 'winStreak'), 4);
    await recordMatch({ userId: u, won: false });
    assert.equal(await counterValue(u, 'winStreak'), 0, 'a loss ends the run');
    /* The banked best must NOT be undone by the loss — that is the difference
     * between a run counter and the mission's own progress. */
    assert.equal(await prog(u, 's_winStreak_3'), 4);
    for (let i = 0; i < 5; i++) await recordMatch({ userId: u, won: true });
    const v = await progressOf(u, 'ch_start_5');
    assert.equal(v!.progress, 5);
    assert.ok(v!.completed, '«۵ برد متوالی» must complete on the fifth');
  });

  await check('a login streak advances once a day, not once a request', async () => {
    const u = await makeUser();
    const day = 86_400_000;
    const t0 = Date.parse('2026-03-10T12:00:00Z');
    await recordLogin(u, t0);
    await recordLogin(u, t0 + 3600_000);          // same Tehran day
    assert.equal(await counterValue(u, 'loginStreak'), 1, 'opening the app twice is still one day');
    await recordLogin(u, t0 + day);
    await recordLogin(u, t0 + 2 * day);
    assert.equal(await counterValue(u, 'loginStreak'), 3);
    assert.equal(await prog(u, 'st_login_3'), 3);
    await recordLogin(u, t0 + 5 * day);           // skipped two days
    assert.equal(await counterValue(u, 'loginStreak'), 1, 'a gap restarts at day one');
    assert.equal(await prog(u, 'st_login_3'), 3, 'but the best streak stays banked');
  });

  await check('day streaks use the Tehran boundary, not UTC midnight', async () => {
    /* Both of these are the 10th in UTC, but 21:00 UTC is already 00:30 on the
     * 11th in Tehran. On UTC days they would be one day and a player logging in
     * at 13:30 and again after midnight would see their streak stall. */
    const afternoon = Date.parse('2026-03-10T10:00:00Z');   // Tehran 13:30 on the 10th
    const pastMidnight = Date.parse('2026-03-10T21:00:00Z'); // Tehran 00:30 on the 11th
    assert.equal(new Date(afternoon).toISOString().slice(0, 10), new Date(pastMidnight).toISOString().slice(0, 10));
    assert.equal(dayKey(afternoon), '2026-03-10');
    assert.equal(dayKey(pastMidnight), '2026-03-11');
    const u = await makeUser();
    await recordLogin(u, afternoon);
    await recordLogin(u, pastMidnight);
    assert.equal(await counterValue(u, 'loginStreak'), 2, 'crossing Tehran midnight is a new day');
  });

  // ------------------------------------------------------------- topics ----

  await check('a topic counts as new only the first time it is played', async () => {
    /* newCategory's seeded missions are daily/weekly, which are inert unless
     * dealt — so the counting itself is checked on a lifetime mission. */
    await saveDef({ id: 'test_newcat', kind: 'achievement', metric: 'newCategory', target: 99,
      title: 'موضوع‌های تازه', rewards: [], enabled: true });
    const u = await makeUser();
    await recordMatch({ userId: u, won: false, categories: ['ورزشی'] });
    await recordMatch({ userId: u, won: false, categories: ['ورزشی'] });
    assert.equal(await prog(u, 'test_newcat'), 1, 'the same topic twice is one topic');
    await recordMatch({ userId: u, won: false, categories: ['تاریخ', 'علمی'] });
    assert.equal(await prog(u, 'test_newcat'), 3);
  });

  await check('categoriesWon counts distinct topics, and only won ones', async () => {
    const u = await makeUser();
    await recordMatch({ userId: u, won: false, categories: ['ورزشی'] });
    assert.equal(await prog(u, 's_categoriesWon_5'), 0, 'a loss wins no topic');
    await recordMatch({ userId: u, won: true, categories: ['ورزشی'] });
    await recordMatch({ userId: u, won: true, categories: ['ورزشی'] });
    assert.equal(await prog(u, 's_categoriesWon_5'), 1, 'twice in one topic is still one');
    await recordMatch({ userId: u, won: true, categories: ['تاریخ'] });
    assert.equal(await prog(u, 's_categoriesWon_5'), 2);
  });

  // -------------------------------------------------------------- skill ----

  await check('flawless and higher-level wins only count on a win', async () => {
    const u = await makeUser();
    await recordMatch({ userId: u, won: false, flawless: true, myLevel: 2, opponentLevel: 9 });
    assert.equal(await prog(u, 's_flawlessWin_1'), 0);
    assert.equal(await prog(u, 's_beatHigherLevel_1'), 0);
    await recordMatch({ userId: u, won: true, flawless: true, myLevel: 2, opponentLevel: 9 });
    assert.equal(await prog(u, 's_flawlessWin_1'), 1);
    assert.equal(await prog(u, 's_beatHigherLevel_1'), 1);
  });

  await check('beating a LOWER-level opponent is not an upset', async () => {
    const u = await makeUser();
    await recordMatch({ userId: u, won: true, myLevel: 20, opponentLevel: 3 });
    assert.equal(await prog(u, 's_beatHigherLevel_1'), 0);
  });

  // ------------------------------------------------------------ economy ----

  await check('paid entry, cash prize and tickets used are reported', async () => {
    const u = await makeUser();
    await recordMatch({ userId: u, won: true, paid: true, ticketsUsed: 1, cashPrize: 40_000 });
    assert.equal(await prog(u, 'ch_start_4'), 1, '«در یک مسابقهٔ پولی شرکت کن»');
    assert.equal(await prog(u, 'e_cashPrize_1'), 40_000);
    const v = await progressOf(u, 'e_cashPrize_1');
    assert.ok(v!.completed, 'the first cash prize completes at any amount ≥ 1');
  });

  await check('a losing player earns no cash-prize progress', async () => {
    const u = await makeUser();
    await recordMatch({ userId: u, won: false, paid: true, cashPrize: 0 });
    assert.equal(await prog(u, 'e_cashPrize_1'), 0);
  });

  await check('buying tickets and spending coins are reported', async () => {
    const u = await makeUser();
    await recordPurchase(u, { tickets: 1 });
    await recordPurchase(u, { coins: 600 });
    await recordPurchase(u, { coins: 500 });
    assert.equal(await prog(u, 'e_ticketsBought_1'), 1);
    assert.equal(await prog(u, 'e_coinsSpent_1000'), 1100);
    assert.ok((await progressOf(u, 'e_coinsSpent_1000'))!.completed);
  });

  await check('deposits and withdrawals are reported', async () => {
    const u = await makeUser();
    await recordMoney(u, 'deposit', 200_000);
    await recordMoney(u, 'withdrawal', 50_000);
    assert.ok((await progressOf(u, 'e_deposit_1'))!.completed);
    assert.ok((await progressOf(u, 'e_withdrawal_1'))!.completed);
  });

  await check('a zero or negative amount reports nothing', async () => {
    const u = await makeUser();
    await recordMoney(u, 'deposit', 0);
    await recordMoney(u, 'deposit', -5);
    assert.equal(await prog(u, 'e_deposit_1'), 0);
  });

  // ------------------------------------------------------------- social ----

  await check('adding a friend and playing one are reported', async () => {
    const u = await makeUser();
    await recordSocial(u, 'friendsAdded');
    await recordMatch({ userId: u, won: false, friendMatch: true });
    assert.ok((await progressOf(u, 'so_friendsAdded_1'))!.completed);
    assert.ok((await progressOf(u, 'so_friendMatch_1'))!.completed);
  });

  // ------------------------------------------------------ the whole pool ----

  await check('every metric a seeded mission counts has a reporter behind it', async () => {
    /* The regression guard for the original bug: a mission whose metric nothing
     * ever sends can never be completed, and the player has no way to know why.
     * `invites`, `giftSent` and `giftReceived` are listed as KNOWN-UNWIRED
     * because the referral and player-to-player gift features do not exist yet
     * — when either is built, delete it from here and the test starts guarding
     * it too. Anything else appearing in this list is a wiring bug. */
    const KNOWN_UNWIRED = new Set(['invites', 'giftSent', 'giftReceived']);
    const WIRED = new Set([
      // matchEngine.submitAnswer / lastSurvivorWorker.advancePhase
      'questionsAnswered', 'correctAnswers', 'correctStreak',
      // matchEngine.settleDuel / lastSurvivorWorker.finishRoom
      'matchesPlayed', 'matchesWon', 'xpEarned', 'paidMatch', 'ticketsUsed', 'cashPrize',
      'flawlessWin', 'beatHigherLevel', 'winStreak', 'winStreakDays', 'playStreak',
      'newCategory', 'categoriesWon', 'friendMatch',
      // ticketService / shopPurchaseService
      'ticketsBought', 'coinsSpent',
      // paymentService / walletLedgerService
      'deposit', 'withdrawal',
      // friends routes
      'friendsAdded',
      // missions routes (client-reported) + missions GET
      'shopVisit', 'adWatched', 'login', 'loginStreak', 'dailyClaim', 'wheelSpin',
      // recordModeService
      'recordSet', 'recordValue', 'recordGlobal', 'recordImproved', 'recordCategoriesAbove',
      'recordRank', 'recordStreakDays', 'recordsInOneDay',
      // awarded by the level-up path
      'level'
    ]);
    const unwired = new Set<string>();
    for (const d of await listDefs()) {
      if (!d.enabled) continue;
      if (!WIRED.has(d.metric) && !KNOWN_UNWIRED.has(d.metric)) unwired.add(d.metric);
    }
    assert.deepEqual([...unwired], [], 'these metrics have missions but no call site');
  });

  await check('a dealt daily really moves when its own metric is reported', async () => {
    /* End to end through the deal: whichever five this player was given, the
     * matching event must move the one it belongs to. */
    const u = await makeUser();
    const dealt = await dealtMetrics(u);
    let checked = 0;
    for (const [metric, m] of dealt) {
      if (metric === 'matchesWon') { await recordMatch({ userId: u, won: true }); checked++; }
      else if (metric === 'matchesPlayed') { await recordMatch({ userId: u, won: false }); checked++; }
      else if (metric === 'correctAnswers') { await recordAnswer(u, true, 1); checked++; }
      else if (metric === 'questionsAnswered') { await recordAnswer(u, false, 0); checked++; }
      else continue;
      assert.ok(await prog(u, m.id) > 0, metric + ' was dealt but did not move');
    }
    assert.ok(checked > 0, 'the deal contained no match/answer mission to exercise');
  });

  // ------------------------------------------- end to end through a duel ----

  await check('an actual duel, played through matchEngine, completes «یک مسابقه ببر»', async () => {
    /* Everything above tests the reporters. This one tests the thing the player
     * did: it plays a real duel through submitAnswer and lets the engine settle
     * it, with no mission call of its own. If matchEngine ever stops reporting,
     * this is the test that fails — the reporter tests would all still pass,
     * which is exactly how the original bug survived so long. */
    const winner = await makeUser(4);
    const loser = await makeUser(4);
    for (let i = 0; i < 12; i++) {
      await repositories.questions.save({
        id: 'mwq' + i, category: 'ورزشی', difficulty: 'easy', text: 'س' + i,
        options: ['الف', 'ب', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
      } as any);
    }
    const match = await createMatchForPlayers(winner, loser, 'duel' as any, 'free' as any);
    await startMatch(match.id);
    /* Ten rounds, both answering every round; the winner gets them all right. */
    for (let round = 0; round < 10; round++) {
      for (const [uid, correct] of [[winner, true], [loser, false]] as Array<[string, boolean]>) {
        await submitAnswer({
          matchId: match.id, userId: uid, questionId: 'mwq' + round,
          selectedIndex: correct ? 0 : 1, correct, answerTimeMs: 3000,
          idempotencyKey: 'mw:' + match.id + ':' + uid + ':' + round, round
        });
      }
    }
    const finished = await getMatch(match.id);
    assert.equal(finished.winnerUserId, winner, 'the player who answered correctly must win');

    assert.equal(await prog(winner, 'ch_start_1'), 1, 'winning a real duel must complete «یک مسابقه ببر»');
    assert.equal(await prog(loser, 'ch_start_1'), 0);
    assert.equal(await prog(winner, 'a_matchesPlayed_1'), 1);
    assert.equal(await prog(loser, 'a_matchesPlayed_1'), 1, 'the loser still played a match');
    assert.equal(await prog(winner, 'ch_start_2'), 10, 'ten correct answers');
    assert.equal(await prog(loser, 'ch_start_2'), 0);
    assert.equal(await prog(winner, 's_correctStreak_5'), 10, 'the whole run was correct');
    assert.equal(await prog(winner, 's_flawlessWin_1'), 1, 'never wrong → a flawless win');
    /* The topic the questions actually came from is the one that counts. */
    assert.equal(await prog(winner, 'test_newcat'), 1);
    assert.ok((await progressOf(winner, 'a_matchesWon_1'))!.completed);
  });

  await check('a duel that never started reports nothing', async () => {
    /* A cancelled search refunds the tickets, so counting it as a match played
     * would let a player farm «۳ مسابقه انجام بده» by queueing and quitting. */
    const a = await makeUser();
    const b = await makeUser();
    const match = await createMatchForPlayers(a, b, 'duel' as any, 'free' as any);
    await forfeitMatch(match.id, a);            // walked out before any question
    assert.equal(await prog(a, 'a_matchesPlayed_1'), 0);
    assert.equal(await prog(b, 'ch_start_1'), 0, 'and the other side did not "win" it');
  });

  await check('a custom mission added from the panel is counted with no code change', async () => {
    await saveDef({
      id: 'test_custom_wired', kind: 'achievement', metric: 'matchesWon', target: 2,
      title: 'دو برد آزمایشی', icon: '🧪', rarity: 'rare', rewards: [{ type: 'coins', amount: 10 }],
      enabled: true
    });
    const u = await makeUser();
    await recordMatch({ userId: u, won: true });
    await recordMatch({ userId: u, won: true });
    assert.ok((await progressOf(u, 'test_custom_wired'))!.completed);
  });

  console.log(`[missionWiring] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
