/* CANCELLING A SEARCH — end to end through the real queue and match engine.
 *
 * The reported bug: you press cancel, the game starts anyway, and your ticket
 * is gone. Both halves are here — the pairing race that made cancel a no-op,
 * and every way a match can die before its first question. */
import assert from 'node:assert/strict';
import { matchmakingQueue } from '../services/matchmakingQueue.js';
import { createMatchForPlayers, startMatch, forfeitMatch, voidMatchBeforeStart, getMatch } from '../services/matchEngine.js';
import { holdTicket, bindHold, spendHolds, refundHolds, _resetHoldsMemory } from '../services/ticketHoldService.js';
import { grantTickets, getTickets } from '../services/ticketService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(tickets = 2): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'p_' + userId.slice(0, 6),
    displayName: 'بازیکن', plan: 'premium', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(userId, 'green', tickets);
  return userId;
}
const green = async (u: string) => Number((await getTickets(u)).green || 0);

/** A value bucket unique to each test: the queue lives for the whole process,
 *  so a ticket left waiting by one test would otherwise pair with the next. */
let bucketSeq = 0;
const newBucket = () => 'v' + (100000 + ++bucketSeq);

/** What the enqueue route does, in one call. */
async function enqueueWithTicket(userId: string, economyType: string) {
  const hold = await holdTicket(userId, 'green');
  const ticket = await matchmakingQueue.enqueue({ userId, modeId: 'duel' as any, economyType: economyType as any, skill: 800 });
  if (ticket.status !== 'matched') await bindHold(hold.id, 'queue', ticket.id);
  return { hold, ticket };
}

async function run() {
  _resetHoldsMemory();

  await check('a lone player who cancels gets the ticket back', async () => {
    const a = await player(2); const bucket = newBucket();
    const { ticket } = await enqueueWithTicket(a, bucket);
    assert.equal(await green(a), 1);
    const cancelled = await matchmakingQueue.cancel(ticket.id, a);
    assert.ok(cancelled, 'a queued ticket must be cancellable');
    await refundHolds('queue', cancelled!.id, 'search_cancelled');
    assert.equal(await green(a), 2);
  });

  await check('cancelling after the queue paired you voids the match and refunds BOTH', async () => {
    const a = await player(2), b = await player(2);
    const bucket = newBucket();
    const first = await enqueueWithTicket(a, bucket);         // waits
    const second = await enqueueWithTicket(b, bucket);        // pairs with a
    assert.equal(second.ticket.status, 'matched', 'the second enqueue should pair');
    const matchId = second.ticket.matchId!;
    assert.equal(await green(a), 1);
    assert.equal(await green(b), 1);

    // a taps cancel a moment too late: the queue says no, so the route falls
    // through to voiding the match that was made behind their back.
    assert.equal(await matchmakingQueue.cancel(first.ticket.id, a), null);
    assert.equal(await voidMatchBeforeStart(matchId, 'search_cancelled'), true);

    assert.equal(await green(a), 2, 'the canceller must not pay for a game that never ran');
    assert.equal(await green(b), 2, 'nor must the opponent');
    const m = await getMatch(matchId);
    assert.equal(m.voided, true);
    assert.equal(m.winnerUserId, undefined, 'voiding must not hand anybody a win');
  });

  await check('a started match can no longer be cancelled', async () => {
    const a = await player(2), b = await player(2);
    const bucket = newBucket();
    await enqueueWithTicket(a, bucket);
    const second = await enqueueWithTicket(b, bucket);
    const matchId = second.ticket.matchId!;
    await startMatch(matchId);
    assert.equal(await voidMatchBeforeStart(matchId, 'search_cancelled'), false,
      'a live duel must not be escapable through the cancel button');
    assert.equal(await green(a), 1);
    assert.equal(await green(b), 1);
  });

  await check('starting the match spends both tickets exactly once', async () => {
    const a = await player(3), b = await player(3);
    const bucket = newBucket();
    await enqueueWithTicket(a, bucket);
    const second = await enqueueWithTicket(b, bucket);
    const matchId = second.ticket.matchId!;
    await startMatch(matchId);
    const before = [await green(a), await green(b)];
    await startMatch(matchId);        // 'continue' between rounds hits this too
    assert.deepEqual([await green(a), await green(b)], before, 'a second start must change nothing');
    assert.equal(await refundHolds('match', matchId, 'late'), 0);
  });

  await check('an opponent who walks out before the first question refunds both', async () => {
    const a = await player(2), b = await player(2);
    const bucket = newBucket();
    await enqueueWithTicket(a, bucket);
    const second = await enqueueWithTicket(b, bucket);
    const matchId = second.ticket.matchId!;
    assert.equal(await green(a), 1);
    await forfeitMatch(matchId, b);            // b leaves the ready screen
    assert.equal(await green(a), 2, 'the player left behind must not pay');
    assert.equal(await green(b), 2, 'nor the one who left before it began');
  });

  await check('walking out of a RUNNING duel forfeits and keeps the ticket spent', async () => {
    const a = await player(2), b = await player(2);
    const bucket = newBucket();
    await enqueueWithTicket(a, bucket);
    const second = await enqueueWithTicket(b, bucket);
    const matchId = second.ticket.matchId!;
    await startMatch(matchId);
    await forfeitMatch(matchId, b);
    assert.equal(await green(a), 1, 'a real game was played; nobody gets a refund');
    assert.equal(await green(b), 1);
    const m = await getMatch(matchId);
    assert.equal(m.winnerUserId, a, 'the player who stayed wins');
  });

  await check('voiding twice pays once', async () => {
    const a = await player(2), b = await player(2);
    const bucket = newBucket();
    await enqueueWithTicket(a, bucket);
    const second = await enqueueWithTicket(b, bucket);
    const matchId = second.ticket.matchId!;
    assert.equal(await voidMatchBeforeStart(matchId, 'search_cancelled'), true);
    assert.equal(await voidMatchBeforeStart(matchId, 'search_cancelled'), false);
    assert.equal(await green(a), 2);
    assert.equal(await green(b), 2);
  });

  await check('a cancelled ticket is never paired into afterwards', async () => {
    const a = await player(2), b = await player(2);
    const bucket = newBucket();
    const first = await enqueueWithTicket(a, bucket);
    await matchmakingQueue.cancel(first.ticket.id, a);
    const second = await enqueueWithTicket(b, bucket);
    assert.notEqual(second.ticket.status, 'matched',
      'the cancelled player must not be dragged into a match');
  });

  await check('the queue expiring a search refunds it', async () => {
    const a = await player(2);
    const { ticket } = await enqueueWithTicket(a, newBucket());
    assert.equal(ticket.status, 'queued', 'this test needs an unmatched search');
    assert.equal(await green(a), 1);
    await matchmakingQueue.expireOldTickets(-1);      // everything is old
    const after = await matchmakingQueue.get(ticket.id);
    assert.equal(after?.status, 'expired');
    assert.equal(await green(a), 2, 'nobody turned up, so the ticket comes back');
  });

  await check('expiry refunds only once even when the sweep runs repeatedly', async () => {
    const a = await player(2);
    await enqueueWithTicket(a, newBucket());
    await matchmakingQueue.expireOldTickets(-1);
    await matchmakingQueue.expireOldTickets(-1);
    await matchmakingQueue.expireOldTickets(-1);
    assert.equal(await green(a), 2);
  });

  await check('a free duel neither holds nor refunds anything', async () => {
    const a = await player(0), b = await player(0);
    const match = await createMatchForPlayers(a, b, 'duel' as any, 'free' as any);
    assert.equal(await voidMatchBeforeStart(match.id, 'search_cancelled'), true);
    assert.equal(await green(a), 0);
    assert.equal(await green(b), 0);
  });

  console.log(`[duelCancel] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
