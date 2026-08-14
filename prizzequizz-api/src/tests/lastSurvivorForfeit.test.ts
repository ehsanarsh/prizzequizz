/* LAST SURVIVOR — the pot nobody won.
 *
 * The reported bug: "when the last two or three players all answer wrongly,
 * nobody wins a prize and it is not clear what happens to the prize money."
 *
 * Both halves of that are real. Nobody winning is the rules working — everyone
 * missed the question, so there is no survivor to pay. But the money then went
 * unmentioned: no payout, no record, nothing any screen could show. It stayed
 * with the company by accident of arithmetic rather than by decision.
 *
 * These tests drive a real room to that ending through the orchestrator and
 * assert the two things that matter: not a single toman is paid out, and the
 * whole remaining pot is booked to the house against the room it came from.
 *
 * Run: npx tsx src/tests/lastSurvivorForfeit.test.ts */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { getAccount } from '../services/walletLedgerService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, listPlayers } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer, eliminationOrder } from '../services/lastSurvivorWorker.js';
import { houseRevenueSummary, _resetHouseRevenue } from '../services/houseRevenueService.js';
import { buildPool } from '../services/lastSurvivorPrize.js';
import { gameConfig } from '../core/config.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const TOPIC = 'فراموش‌شده';
function setCommission(pct: number): void {
  (gameConfig as any).economy = (gameConfig as any).economy ?? {};
  (gameConfig as any).economy.paid = { ...((gameConfig as any).economy.paid ?? {}), rakePercent: pct };
}

async function expire(roomId: string): Promise<void> {
  const r = (await getRoom(roomId))!;
  r.phaseEndsAt = 0;
  await saveRoom(r);
}
/** Push the room forward until it leaves the phase it is in. */
async function step(roomId: string): Promise<void> {
  await expire(roomId);
  await advanceRoom((await getRoom(roomId))!);
}

let seq = 0;
/** A fresh room of `n` players, already running and on round 1. */
async function openRoom(n: number): Promise<{ roomId: string; ids: string[] }> {
  const tag = 'f' + (++seq) + '_';
  const ids: string[] = [];
  let roomId = '';
  for (let i = 0; i < n; i++) {
    const uid = tag + i;
    ids.push(uid);
    await repositories.users.save({
      id: uid, username: uid, displayName: uid, phone: '0913' + Math.floor(Math.random() * 1e7),
      plan: 'paid', wallet: 0, coins: 0, xp: 0, level: 1, weeklyScore: 0, hearts: 5,
      tickets: { bronze: 0, silver: 0, gold: 0 }
    } as any);
    await grantTickets(uid, 'green', 1);
    const s = await joinTopic({ id: uid, username: uid }, TOPIC, 'green');
    roomId = s.room.id;
  }
  /* Capacity is set to n, so the room starts the moment it fills. */
  await advanceRoom((await getRoom(roomId))!);
  const r = (await getRoom(roomId))!;
  assert.equal(r.status, 'running', 'the room should have started');
  return { roomId, ids };
}

/** Answer for everyone this round, then let the round grade and settle. */
async function playRound(roomId: string, answers: Record<string, number>): Promise<void> {
  let r = (await getRoom(roomId))!;
  if (r.phase === 'ready') { await step(roomId); r = (await getRoom(roomId))!; }
  assert.equal(r.phase, 'question', 'expected an open question');
  for (const [uid, idx] of Object.entries(answers)) await submitAnswer(roomId, uid, r.round, idx);
  await step(roomId);                       // question → elimination (grades)
  r = (await getRoom(roomId))!;
  if (r.status === 'finished') return;
  await step(roomId);                       // elimination → dashboard
  r = (await getRoom(roomId))!;
  if (r.status === 'finished') return;
  await step(roomId);                       // dashboard → cashout (or finish)
  r = (await getRoom(roomId))!;
  if (r.status === 'finished') return;
  if (r.phase === 'cashout') await step(roomId);   // cashout → next round (or finish)
}

async function run(): Promise<void> {
  _resetHouseRevenue();
  setCommission(0);
  await updateConfig({
    room: { capacity: 3, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 },
    match: { totalRounds: 6, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  });
  /* Every question's correct answer is index 0, so a test controls exactly who
   * survives by choosing what each player picks. */
  for (let i = 0; i < 10; i++) {
    await repositories.questions.save({
      id: 'fq' + i, category: TOPIC, difficulty: 'easy', text: 'سوال ' + i,
      options: ['درست', 'غلط', 'سه', 'چهار'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }

  /* THE RULE CHANGED, ON PURPOSE.
   *
   * This used to assert that nobody at all was paid when the room was wiped
   * out and that the WHOLE pot went to the house. The operator's rule now is
   * kinder by exactly one share: the pot is divided among the players who were
   * still standing when that last round began, and the LAST one out — the last
   * name in the server's own elimination order — is paid their share. The rest
   * is still booked to the house, and still to the rial.
   *
   * The old expectation is not "broken", it is superseded; what has to stay
   * true is that ONE player is paid, that it is the right one, and that nothing
   * goes missing. */
  await check('all three miss on round one → the last one out is paid, the rest is booked to the house', async () => {
    const { roomId, ids } = await openRoom(3);
    const room = (await getRoom(roomId))!;
    const pool = buildPool(room.config, ids.map(() => 'green'));
    assert.ok(pool.net > 0, 'the pot should not be empty');

    /* Everybody answers 1 — the wrong option. This is the exact situation the
     * report described, with three players instead of two. */
    await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));

    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'finished', 'a room with nobody left must end');
    const players = await listPlayers(roomId);
    assert.equal(players.filter((p) => p.status === 'alive').length, 0, 'nobody survived');

    const order = eliminationOrder(roomId, after.round, ids);
    const lastOut = order[order.length - 1]!;
    for (const u of ids) {
      const row = players.find((p) => p.userId === u)!;
      const acct = await getAccount(u);
      if (u === lastOut) {
        assert.ok(row.payoutCash > 0, 'the last player out must be paid their share');
        assert.equal(acct.available, row.payoutCash, 'and their wallet must hold it');
        /* One share of three, since all three hold the same ticket. */
        assert.ok(Math.abs(row.payoutCash - Math.floor(pool.net / 3)) <= 3,
          'the share is ' + row.payoutCash + ', not a third of ' + pool.net);
      } else {
        assert.equal(acct.available, 0, u + ' must not be paid');
        assert.equal(row.payoutCash, 0);
      }
    }

    const paid = players.reduce((sum, p) => sum + p.payoutCash, 0);
    const house = await houseRevenueSummary();
    const booked = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.ok(booked, 'the forfeited pot must be recorded, not merely lost track of');
    assert.equal(booked!.amount, pool.net - paid, 'the house keeps everything except that one share');
    /* Conservation, which is the point of the whole file. */
    assert.equal(paid + booked!.amount, pool.net, 'the pot did not add up');
    assert.equal((booked!.metadata as any).players, 3);
    assert.equal((booked!.metadata as any).topic, TOPIC);
  });

  await check('a room with a survivor books nothing as forfeited', async () => {
    const { roomId, ids } = await openRoom(3);
    const [a, b, c] = ids as [string, string, string];
    /* `a` keeps answering correctly; the other two go out on round one. With
     * minSurvivors 1 the room ends there and `a` takes the pot. */
    await playRound(roomId, { [a]: 0, [b]: 1, [c]: 1 });
    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'finished');
    assert.ok((await getAccount(a)).available > 0, 'the survivor must be paid');
    const house = await houseRevenueSummary();
    assert.ok(!house.recent.some((h) => h.refId === roomId && h.source === 'ls_forfeited_pot'),
      'nothing is forfeited when somebody won');
  });

  await check('what a player already cashed out is not forfeited twice', async () => {
    /* The forfeited amount is what is LEFT, so a cash-out earlier in the match
     * must come off it. Set up: four players, one cashes out, the rest all miss. */
    await updateConfig({ room: { capacity: 4, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 } });
    const { roomId, ids } = await openRoom(4);
    const [a, b, c, d] = ids as [string, string, string, string];
    const room = (await getRoom(roomId))!;
    const pool = buildPool(room.config, ids.map(() => 'green'));

    /* Round one: everyone survives, then `a` takes the money and leaves. */
    let r = (await getRoom(roomId))!;
    if (r.phase === 'ready') await step(roomId);
    r = (await getRoom(roomId))!;
    for (const u of ids) await submitAnswer(roomId, u, r.round, 0);
    await step(roomId);                                  // grade
    await step(roomId);                                  // elimination → dashboard
    await step(roomId);                                  // dashboard → cashout
    r = (await getRoom(roomId))!;
    assert.equal(r.phase, 'cashout', 'four survivors should be offered a cash-out');
    const { submitDecision } = await import('../services/lastSurvivorWorker.js');
    await submitDecision(roomId, a, r.round, 'cashout');
    await step(roomId);                                  // process cash-outs → round 2

    const cashed = (await getAccount(a)).available;
    assert.ok(cashed > 0, 'the cash-out must actually pay');

    /* Round two: the three who stayed all miss. */
    await playRound(roomId, { [b]: 1, [c]: 1, [d]: 1 });
    assert.equal((await getRoom(roomId))!.status, 'finished');

    const players = await listPlayers(roomId);
    const paid = players.reduce((sum, p) => sum + p.payoutCash, 0);
    /* The cash-out plus the last player's share — the wipe-out rule applies here
       too, on whatever was left after `a` took their money out. */
    const endRound = (await getRoom(roomId))!.round;
    const lastRound = players.filter((p) => p.status === 'eliminated' && p.eliminatedRound === endRound);
    const order = eliminationOrder(roomId, endRound, lastRound.map((p) => p.userId));
    const lastOut = order[order.length - 1]!;
    assert.ok(players.find((p) => p.userId === lastOut)!.payoutCash > 0, 'the last one out was not paid');

    const house = await houseRevenueSummary();
    const booked = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.ok(booked, 'the rest of the pot must still be booked');
    assert.equal(booked!.amount, pool.net - paid,
      'only what was left after the cash-out AND the last share is forfeited');
    /* Conservation: paid out + kept by the house === the whole net pot. */
    assert.equal(paid + booked!.amount, pool.net);
    assert.ok(paid > cashed, 'the wipe-out share was not paid on top of the cash-out');
    await updateConfig({ room: { capacity: 3, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 } });
  });

  await check('the commission on a Last Survivor pot is booked too', async () => {
    setCommission(10);
    const { roomId, ids } = await openRoom(3);
    const room = (await getRoom(roomId))!;
    const pool = buildPool(room.config, ids.map(() => 'green'));
    assert.ok(pool.gross > pool.net, 'a 10% commission should shrink the net pot');
    await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));

    const house = await houseRevenueSummary();
    const rake = house.recent.find((h) => h.refId === roomId && h.source === 'ls_rake');
    assert.ok(rake, 'the rake was previously invisible in every report');
    assert.equal(rake!.amount, pool.gross - pool.net);
    setCommission(0);
  });

  await check('booking the same room twice does not double-count', async () => {
    const before = (await houseRevenueSummary()).total;
    const { roomId, ids } = await openRoom(3);
    await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));
    const once = (await houseRevenueSummary()).total;
    /* A worker retry, or a replayed tick after a restart, must not book again. */
    await advanceRoom((await getRoom(roomId))!);
    const twice = (await houseRevenueSummary()).total;
    assert.ok(once > before, 'the first ending should book something');
    assert.equal(twice, once, 'a repeat must add nothing');
  });

  await check('the summary groups by source and totals correctly', async () => {
    const h = await houseRevenueSummary();
    const sum = h.bySource.reduce((s, b) => s + b.amount, 0);
    assert.equal(h.total, sum);
    assert.ok(h.bySource.some((b) => b.source === 'ls_forfeited_pot'));
  });

  console.log(`[lastSurvivorForfeit] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
