/* DELIVERY, EXACTLY ONCE.
 *
 * A payment used to be remembered in the process that handled it: a Set of at
 * most 20,000 refs in purchaseOrderService and a Map of at most 5,000 results
 * in shopPurchaseService, both evicting their oldest entries. That is enough
 * for a gateway that calls back within seconds and not enough for anything
 * else — a card-to-card payment is confirmed minutes or hours later, from the
 * SMS matcher, from an operator approving by hand, or from a sweeper, and any
 * two of those can land on different processes.
 *
 * What must be true, and is what this file checks:
 *
 *   - one reference hands over the goods once, however many callers race
 *   - a replay is answered with what was delivered the first time
 *   - volume does not erase the memory of a real payment
 *   - a purchase refused before any money moved frees its key
 *   - money taken and goods not handed over is WRITTEN DOWN, not lost
 *   - a refunded purchase can never look deliverable again
 *   - a caller that dies mid-delivery does not strand what the player paid for
 *
 * Run: npx tsx src/tests/orderFulfilment.test.ts
 */
import assert from 'node:assert/strict';
import {
  claim, complete, fail, voidRef, discard, find,
  _resetFulfilments, _expireClaim
} from '../services/orderFulfilmentService.js';
import { fulfil, payFromVault, OrderError } from '../services/purchaseOrderService.js';
import { purchase, ShopError } from '../services/shopPurchaseService.js';
import { saveItem, removeItem } from '../services/shopService.js';
import { getTickets } from '../services/ticketService.js';
import { getTicketPrices } from '../services/economyConfig.js';
import { postEntry, getAccount } from '../services/walletLedgerService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(prize = 0): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'of' + uid.slice(0, 8), displayName: 'of',
    phone: '09' + String(300000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  if (prize > 0) {
    await postEntry({ userId: uid, entryType: 'match_reward', kind: 'credit', amount: prize,
      idempotencyKey: 'prize:' + id(), description: 'جایزه' });
  }
  return uid;
}

const TIER = Object.keys(getTicketPrices())[0]!;
const PRICE = getTicketPrices()[TIER]!;

async function run(): Promise<void> {
  _resetFulfilments();

  /* ── the claim itself ─────────────────────────────────────────────── */

  await check('one reference is claimed by exactly one caller', async () => {
    const ref = 'r:' + id();
    const uid = await player();
    const first = await claim({ ref, userId: uid, source: 'gateway', kind: 'ticket' });
    const second = await claim({ ref, userId: uid, source: 'gateway', kind: 'ticket' });
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false, 'the second caller must not deliver');
  });

  await check('ten callers racing for the same reference produce one winner', async () => {
    const ref = 'r:' + id();
    const uid = await player();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claim({ ref, userId: uid, source: 'card_to_card', kind: 'ticket' }))
    );
    assert.equal(results.filter((r) => r.claimed).length, 1, 'exactly one claim may win');
  });

  await check('a replay is answered with what was delivered the first time', async () => {
    const ref = 'r:' + id();
    const uid = await player();
    await claim({ ref, userId: uid, source: 'gateway', kind: 'ticket' });
    await complete(ref, { payload: [{ key: 'ticket-red', value: 2, label: 'بلیط قرمز' }], amountToman: 100000, category: 'tickets' });
    const again = await claim({ ref, userId: uid, source: 'gateway', kind: 'ticket' });
    assert.equal(again.claimed, false);
    assert.equal(again.record.status, 'done');
    assert.deepEqual(again.record.payload, [{ key: 'ticket-red', value: 2, label: 'بلیط قرمز' }]);
    assert.equal(again.record.amountToman, 100000, 'and what it was worth, for the income report');
  });

  await check('VOLUME does not erase a real payment', async () => {
    /* The old Set held 20,000 refs and dropped the oldest; the old Map held
     * 5,000 and dropped a thousand at a time. Either would have forgotten this
     * first reference long before the end of the loop. */
    const uid = await player();
    const firstRef = 'vol:' + id();
    await claim({ ref: firstRef, userId: uid, source: 'card_to_card', kind: 'ticket' });
    await complete(firstRef, { payload: [{ key: 'ticket-red', value: 1, label: 'بلیط قرمز' }] });
    for (let i = 0; i < 25_000; i++) {
      await claim({ ref: `vol:${i}:${uid}`, userId: uid, source: 'card_to_card', kind: 'ticket' });
    }
    const again = await claim({ ref: firstRef, userId: uid, source: 'card_to_card', kind: 'ticket' });
    assert.equal(again.claimed, false, 'after 25,000 later payments it must still be remembered');
    assert.equal(again.record.status, 'done');
  });

  await check('nothing happened → the key is free again', async () => {
    const ref = 'r:' + id();
    const uid = await player();
    await claim({ ref, userId: uid, source: 'vault', kind: 'shop' });
    await discard(ref);
    assert.equal(await find(ref), null, 'a refusal must not burn the key');
    const retry = await claim({ ref, userId: uid, source: 'vault', kind: 'shop' });
    assert.equal(retry.claimed, true, 'so the same tap can be tried again');
  });

  await check('money taken and goods not delivered stays owed', async () => {
    const ref = 'r:' + id();
    const uid = await player();
    await claim({ ref, userId: uid, source: 'card_to_card', kind: 'ticket' });
    await fail(ref, 'grant exploded');
    const row = (await find(ref))!;
    assert.equal(row.status, 'pending', 'the debt is still on the books');
    assert.equal(row.lastError, 'grant exploded', 'and says why');
  });

  await check('a refunded purchase can never look deliverable again', async () => {
    const ref = 'r:' + id();
    const uid = await player();
    await claim({ ref, userId: uid, source: 'vault', kind: 'ticket' });
    await voidRef(ref, 'refunded');
    const again = await claim({ ref, userId: uid, source: 'vault', kind: 'ticket' });
    assert.equal(again.claimed, false);
    assert.equal(again.record.status, 'void');
    assert.equal(await complete(ref, { payload: ['nope'] }), null, 'and it cannot be completed after the fact');
  });

  await check('a caller that died mid-delivery does not strand the payment', async () => {
    const ref = 'r:' + id();
    const uid = await player();
    await claim({ ref, userId: uid, source: 'card_to_card', kind: 'ticket' });
    const tooSoon = await claim({ ref, userId: uid, source: 'card_to_card', kind: 'ticket' });
    assert.equal(tooSoon.claimed, false, 'a delivery still in flight is not taken over');
    await _expireClaim(ref);
    const takeover = await claim({ ref, userId: uid, source: 'card_to_card', kind: 'ticket' });
    assert.equal(takeover.claimed, true, 'but a stale one is finished by whoever comes next');
    assert.equal(takeover.record.attempts, 1, 'and the takeover is counted');
  });

  /* ── through the real purchase paths ──────────────────────────────── */

  await check('one reference issues one ticket, not two', async () => {
    const uid = await player();
    const ref = 'intent:' + id();
    const a = await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 2 }, ref, { source: 'card_to_card', amountToman: PRICE * 2 });
    const b = await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 2 }, ref, { source: 'card_to_card', amountToman: PRICE * 2 });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true, 'the replay delivers nothing new');
    assert.deepEqual(b.granted, a.granted, 'but reports what was delivered');
    assert.equal((await getTickets(uid))[TIER], 2, 'exactly one delivery reached the player');
  });

  await check('and the sale is on the record with what it was worth', async () => {
    const uid = await player();
    const ref = 'intent:' + id();
    await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 3 }, ref, { source: 'card_to_card', amountToman: PRICE * 3, paymentRef: 'pi_1' });
    const row = (await find(ref))!;
    assert.equal(row.status, 'done');
    assert.equal(row.source, 'card_to_card', 'so the income report can tell it from a صندوق purchase');
    assert.equal(row.amountToman, PRICE * 3);
    assert.equal(row.category, 'tickets');
    assert.equal(row.paymentRef, 'pi_1');
  });

  await check('paying from the صندوق is recorded as such, not as new income', async () => {
    const uid = await player(PRICE * 4);
    const key = 'o:' + id();
    await payFromVault(uid, { kind: 'ticket', tier: TIER, qty: 1 }, key);
    const row = (await find('vault:' + key))!;
    assert.equal(row.source, 'vault', 'the ledger already counted this one');
  });

  await check('a shop purchase repeated on the same key charges once', async () => {
    const uid = await player(500_000);
    const item = await saveItem({ name: 'تست تحویل', category: 'hearts', price: 20_000, currency: 'cash', effectKey: 'heart', effectValue: 1, enabled: true });
    const key = 'k:' + id();
    const first = await purchase({ userId: uid, itemId: item.id, idempotencyKey: key });
    const second = await purchase({ userId: uid, itemId: item.id, idempotencyKey: key });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal((await getAccount(uid)).available, 500_000 - 20_000, 'charged exactly once');
    assert.deepEqual(second.granted, first.granted, 'and the receipt is the same one');
    assert.equal(second.balances.wallet, 500_000 - 20_000, 'with balances read fresh, not replayed');
    await removeItem(item.id);
  });

  await check('a purchase nobody can afford does not burn the key', async () => {
    const uid = await player(1000);
    const item = await saveItem({ name: 'تست گران', category: 'hearts', price: 90_000, currency: 'cash', effectKey: 'heart', effectValue: 1, enabled: true });
    const key = 'k:' + id();
    await assert.rejects(
      () => purchase({ userId: uid, itemId: item.id, idempotencyKey: key }),
      (e: unknown) => e instanceof ShopError && e.code === 'INSUFFICIENT_FUNDS');
    assert.equal(await find(key), null, 'nothing was charged, so nothing is remembered');
    /* The same tap again must give the same honest answer, not "in progress". */
    await assert.rejects(
      () => purchase({ userId: uid, itemId: item.id, idempotencyKey: key }),
      (e: unknown) => e instanceof ShopError && e.code === 'INSUFFICIENT_FUNDS');
    await removeItem(item.id);
  });

  await check('charged but not delivered is written down, not lost', async () => {
    /* A league ticket may never be sold. An operator can still put one in the
     * catalogue, and the refusal fires in the grant loop — AFTER the charge. */
    const uid = await player(500_000);
    const item = await saveItem({
      name: 'بلیط لیگ (نباید فروخته شود)', category: 'tickets', price: 30_000, currency: 'cash',
      effectKey: 'ticket-gold', effectValue: 1, enabled: true
    });
    const key = 'k:' + id();
    await assert.rejects(() => purchase({ userId: uid, itemId: item.id, idempotencyKey: key }));
    const row = await find(key);
    assert.ok(row, 'the debt must exist somewhere');
    assert.equal(row!.status, 'pending', 'still owed to the player');
    assert.match(String(row!.lastError), /LEAGUE_TICKET_NOT_FOR_SALE/);
    assert.equal((await getAccount(uid)).available, 500_000 - 30_000, 'and the money really did leave');
    await removeItem(item.id);
  });

  await check('an order that cannot be priced never reaches a claim', async () => {
    const uid = await player(500_000);
    await assert.rejects(
      () => payFromVault(uid, { kind: 'ticket', tier: 'gold', qty: 1 }, 'o:' + id()),
      (e: unknown) => e instanceof OrderError && e.code === 'LEAGUE_TICKET_NOT_FOR_SALE');
  });

  console.log(`[orderFulfilment] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
