/* ENTRY TICKETS — the rule under test is a single sentence: a ticket is gone
 * only if the match actually started. Every other ending gives it back.
 *
 * The old code refunded in exactly one place — a successful cancel — so each
 * assertion below is a way the player used to lose a ticket for a game they
 * never played. */
import assert from 'node:assert/strict';
import {
  holdTicket, bindHold, bindHoldsToMatch, spendHolds, refundHolds, refundHoldById,
  refundStaleHolds, hasLiveHolds, _resetHoldsMemory, _memoryHolds
} from '../services/ticketHoldService.js';
import { grantTickets, getTickets } from '../services/ticketService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function makeUser(tickets = 3): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'u_' + userId.slice(0, 6),
    displayName: 'تستی', plan: 'premium', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(userId, 'green', tickets);
  return userId;
}
const green = async (userId: string) => Number((await getTickets(userId)).green || 0);

async function run() {
  _resetHoldsMemory();

  await check('holding takes exactly one ticket', async () => {
    const u = await makeUser(3);
    await holdTicket(u, 'green');
    assert.equal(await green(u), 2);
  });

  await check('a player with no tickets cannot hold one', async () => {
    const u = await makeUser(0);
    await assert.rejects(() => holdTicket(u, 'green'));
    assert.equal(await green(u), 0);
  });

  await check('cancelling the search gives the ticket back', async () => {
    const u = await makeUser(3);
    const h = await holdTicket(u, 'green');
    await bindHold(h.id, 'queue', 'q1');
    assert.equal(await green(u), 2);
    assert.equal(await refundHolds('queue', 'q1', 'search_cancelled'), 1);
    assert.equal(await green(u), 3);
  });

  await check('a second cancel does not mint a ticket', async () => {
    const u = await makeUser(3);
    const h = await holdTicket(u, 'green');
    await bindHold(h.id, 'queue', 'q2');
    await refundHolds('queue', 'q2', 'search_cancelled');
    assert.equal(await refundHolds('queue', 'q2', 'search_cancelled'), 0);
    assert.equal(await green(u), 3, 'the balance must not go above what they started with');
  });

  await check('the search expiring gives the ticket back', async () => {
    const u = await makeUser(1);
    const h = await holdTicket(u, 'green');
    await bindHold(h.id, 'queue', 'q3');
    await refundHolds('queue', 'q3', 'search_expired');
    assert.equal(await green(u), 1);
  });

  await check('being matched moves the hold onto the match', async () => {
    const u = await makeUser(2);
    const h = await holdTicket(u, 'green');
    await bindHold(h.id, 'queue', 'q4');
    await bindHoldsToMatch([u], 'm1');
    assert.equal(await hasLiveHolds('m1'), true);
    assert.equal(await refundHolds('queue', 'q4', 'late'), 0, 'the queue reference must no longer own it');
  });

  await check('BOTH players are refunded when the match dies before it starts', async () => {
    const a = await makeUser(2), b = await makeUser(2);
    for (const u of [a, b]) { const h = await holdTicket(u, 'green'); await bindHold(h.id, 'queue', 'q_' + u); }
    await bindHoldsToMatch([a, b], 'm2');
    assert.equal(await green(a), 1);
    assert.equal(await green(b), 1);
    assert.equal(await refundHolds('match', 'm2', 'opponent_left'), 2);
    assert.equal(await green(a), 2);
    assert.equal(await green(b), 2);
  });

  await check('once the match starts the ticket is gone for good', async () => {
    const u = await makeUser(2);
    const h = await holdTicket(u, 'green');
    await bindHold(h.id, 'queue', 'q5');
    await bindHoldsToMatch([u], 'm3');
    assert.equal(await spendHolds('m3'), 1);
    assert.equal(await green(u), 1);
    // Every later ending path must find nothing to give back.
    assert.equal(await refundHolds('match', 'm3', 'forfeit_leave'), 0);
    assert.equal(await refundHolds('match', 'm3', 'forfeit_timeout'), 0);
    assert.equal(await green(u), 1, 'a played match must never refund');
  });

  await check('a match with no live holds is distinguishable from one with', async () => {
    const u = await makeUser(2);
    const h = await holdTicket(u, 'green');
    await bindHold(h.id, 'queue', 'q6');
    await bindHoldsToMatch([u], 'm4');
    assert.equal(await hasLiveHolds('m4'), true);
    await spendHolds('m4');
    assert.equal(await hasLiveHolds('m4'), false);
  });

  await check('a free match holds nothing and refunds nothing', async () => {
    assert.equal(await refundHolds('match', 'm-free', 'forfeit_leave'), 0);
  });

  await check('an enqueue that blows up gives the ticket straight back', async () => {
    const u = await makeUser(1);
    const h = await holdTicket(u, 'green');
    assert.equal(await green(u), 0);
    assert.equal(await refundHoldById(h.id, 'enqueue_failed'), true);
    assert.equal(await green(u), 1);
    assert.equal(await refundHoldById(h.id, 'enqueue_failed'), false, 'not twice');
    assert.equal(await green(u), 1);
  });

  await check('one player refunding cannot take another player\'s hold', async () => {
    const a = await makeUser(1), b = await makeUser(1);
    const ha = await holdTicket(a, 'green');
    const hb = await holdTicket(b, 'green');
    await bindHold(ha.id, 'queue', 'qa');
    await bindHold(hb.id, 'queue', 'qb');
    await refundHolds('queue', 'qa', 'search_cancelled');
    assert.equal(await green(a), 1);
    assert.equal(await green(b), 0, "b's ticket must still be held");
    await refundHolds('queue', 'qb', 'search_cancelled');
    assert.equal(await green(b), 1);
  });

  await check('a hold nobody ever claimed is swept back', async () => {
    _resetHoldsMemory();
    const u = await makeUser(1);
    await holdTicket(u, 'green');
    assert.equal(await green(u), 0);
    // Nothing bound it, nothing cancelled it — the client simply vanished.
    const swept = await refundStaleHolds(-1);
    assert.equal(swept, 1);
    assert.equal(await green(u), 1);
  });

  await check('the sweep leaves a fresh hold alone', async () => {
    _resetHoldsMemory();
    const u = await makeUser(1);
    await holdTicket(u, 'green');
    assert.equal(await refundStaleHolds(5 * 60_000), 0);
    assert.equal(await green(u), 0, 'a search in progress must not be swept');
  });

  await check('the sweep never touches a ticket already spent on a game', async () => {
    _resetHoldsMemory();
    const u = await makeUser(2);
    const h = await holdTicket(u, 'green');
    await bindHoldsToMatch([u], 'm5');
    await spendHolds('m5');
    assert.equal(await refundStaleHolds(-1), 0);
    assert.equal(await green(u), 1);
    assert.equal(_memoryHolds().find((x) => x.id === h.id)?.state, 'spent');
  });

  await check('every hold ends in exactly one terminal state', async () => {
    const states = _memoryHolds().map((h) => h.state);
    assert.ok(states.every((st) => ['held', 'spent', 'refunded'].includes(st)));
  });

  console.log(`[ticketHolds] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
