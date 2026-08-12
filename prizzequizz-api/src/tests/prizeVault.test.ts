/* THE صندوق جایزه — A ONE-WAY DOOR.
 *
 * The wallet is gone. What replaces it fills with prizes and nothing else:
 *
 *   - there is no topping up, at any level, including the ledger itself
 *   - a purchase names its own funding — the صندوق, or the gateway
 *   - a gateway payment DELIVERS THE THING BOUGHT; the money never lands in
 *     the صندوق, because money that went in and could come out again would
 *     make this a money-transfer business rather than a game
 *   - the player's statement never itemises what the house kept
 *
 * Run: npx tsx src/tests/prizeVault.test.ts
 */
import assert from 'node:assert/strict';
import { postEntry, getAccount, listEntries, isPlayerVisible, WalletError } from '../services/walletLedgerService.js';
import { quote, payFromVault, parseOrder, isGatewayPayable, OrderError, _resetFulfilled, fulfil } from '../services/purchaseOrderService.js';
import { createPaymentIntent, settlePaymentIntent, paymentSignature } from '../services/paymentService.js';
import { getTickets } from '../services/ticketService.js';
import { getTicketPrices } from '../services/economyConfig.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'pv' + uid.slice(0, 8), displayName: 'pv',
    phone: '09' + String(200000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  return uid;
}

/** Win a prize — the only way money may enter. */
async function win(uid: string, amount: number): Promise<void> {
  await postEntry({ userId: uid, entryType: 'match_reward', kind: 'credit', amount, idempotencyKey: 'prize:' + id(), description: 'جایزه برد' });
}

const tiers = Object.keys(getTicketPrices());
const TIER = tiers[0]!;
const PRICE = getTicketPrices()[TIER]!;

async function run(): Promise<void> {
  /* ── no topping up, anywhere ──────────────────────────────────────── */

  await check('the ledger itself refuses a deposit', async () => {
    const uid = await player();
    await assert.rejects(
      () => postEntry({ userId: uid, entryType: 'deposit', kind: 'credit', amount: 100000, idempotencyKey: 'd:' + id() }),
      (e: unknown) => e instanceof WalletError && e.code === 'DEPOSIT_REMOVED'
    );
    assert.equal((await getAccount(uid)).available, 0, 'and nothing was credited');
  });

  await check('a payment with no order is refused rather than credited', async () => {
    const uid = await player();
    await assert.rejects(
      () => createPaymentIntent({ userId: uid, amount: 200000 } as any),
      (e: unknown) => e instanceof WalletError && e.code === 'DEPOSIT_REMOVED'
    );
  });

  await check('winning is the way money gets in', async () => {
    const uid = await player();
    await win(uid, 500000);
    assert.equal((await getAccount(uid)).available, 500000);
  });

  /* ── paying from the صندوق ────────────────────────────────────────── */

  await check('a ticket can be paid for out of the صندوق', async () => {
    _resetFulfilled();
    const uid = await player();
    await win(uid, PRICE * 3);
    const r = await payFromVault(uid, { kind: 'ticket', tier: TIER, qty: 1 }, 'o:' + id());
    assert.equal(r.quote.amount, PRICE);
    assert.equal((await getTickets(uid))[TIER], 1, 'the ticket arrived');
    assert.equal((await getAccount(uid)).available, PRICE * 2, 'and the صندوق paid for it');
  });

  await check('an empty صندوق says so, and points at the gateway', async () => {
    const uid = await player();
    await assert.rejects(
      () => payFromVault(uid, { kind: 'ticket', tier: TIER, qty: 1 }, 'o:' + id()),
      (e: unknown) => e instanceof OrderError && e.code === 'INSUFFICIENT_VAULT'
    );
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0, 'and no ticket was issued');
  });

  await check('paying twice with the same key charges once', async () => {
    _resetFulfilled();
    const uid = await player();
    await win(uid, PRICE * 4);
    const key = 'o:' + id();
    await payFromVault(uid, { kind: 'ticket', tier: TIER, qty: 1 }, key);
    const second = await payFromVault(uid, { kind: 'ticket', tier: TIER, qty: 1 }, key);
    assert.equal(second.duplicate, true);
    assert.equal((await getAccount(uid)).available, PRICE * 3, 'charged once');
    assert.equal((await getTickets(uid))[TIER], 1, 'issued once');
  });

  /* ── paying at the gateway ────────────────────────────────────────── */

  await check('a gateway payment delivers the ticket', async () => {
    _resetFulfilled();
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: { kind: 'ticket', tier: TIER, qty: 2 } });
    assert.equal(intent.amount, PRICE * 2, 'priced from the catalogue, not the client');
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0, 'nothing before payment');
    await settlePaymentIntent(intent.id, paymentSignature(intent.id, intent.amount, 'paid'), 'paid');
    assert.equal((await getTickets(uid))[TIER], 2, 'two tickets after payment');
  });

  await check('and the money never lands in the صندوق', async () => {
    /* The heart of it. If a gateway payment credited the صندوق, a player could
       pay in and withdraw it back out as if it were a prize. */
    _resetFulfilled();
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: { kind: 'ticket', tier: TIER, qty: 1 } });
    await settlePaymentIntent(intent.id, paymentSignature(intent.id, intent.amount, 'paid'), 'paid');
    assert.equal((await getAccount(uid)).available, 0, 'the صندوق is still empty');
  });

  await check('a replayed callback does not hand over a second ticket', async () => {
    _resetFulfilled();
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: { kind: 'ticket', tier: TIER, qty: 1 } });
    const sig = paymentSignature(intent.id, intent.amount, 'paid');
    await settlePaymentIntent(intent.id, sig, 'paid');
    await settlePaymentIntent(intent.id, sig, 'paid');
    await settlePaymentIntent(intent.id, sig, 'paid');
    assert.equal((await getTickets(uid))[TIER], 1, 'one payment, one ticket');
  });

  await check('an unsigned callback settles nothing', async () => {
    _resetFulfilled();
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: { kind: 'ticket', tier: TIER, qty: 1 } });
    await assert.rejects(() => settlePaymentIntent(intent.id, 'deadbeef', 'paid'));
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0, 'nothing was delivered');
  });

  await check('the price is never taken from the client', async () => {
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, amount: 1, order: { kind: 'ticket', tier: TIER, qty: 1 } } as any);
    assert.equal(intent.amount, PRICE, 'a client-supplied amount is ignored');
  });

  /* ── the sheet the player is shown ────────────────────────────────── */

  await check('a quote says which methods are actually open', async () => {
    const uid = await player();
    const q = await quote({ kind: 'ticket', tier: TIER, qty: 1 });
    assert.equal(q.amount, PRICE);
    assert.equal(isGatewayPayable(q), true, 'the gateway can always take it');
    const empty = await getAccount(uid);
    assert.equal(Number(empty.available) >= q.amount, false, 'and the صندوق cannot, while empty');
  });

  await check('a malformed order is rejected before anything is priced', async () => {
    assert.equal(parseOrder({ kind: 'ticket' }), null, 'no tier');
    assert.equal(parseOrder({ kind: 'shop' }), null, 'no item');
    assert.equal(parseOrder({ kind: 'nonsense', tier: 'x' }), null);
    assert.deepEqual(parseOrder({ kind: 'ticket', tier: TIER, qty: 999 }), { kind: 'ticket', tier: TIER, qty: 20 }, 'quantity is bounded');
  });

  /* ── what the player is shown afterwards ──────────────────────────── */

  await check('the statement never itemises the house fee', async () => {
    const uid = await player();
    await win(uid, 300000);
    await postEntry({ userId: uid, entryType: 'fee', kind: 'debit', amount: 30000, idempotencyKey: 'f:' + id(), description: 'کارمزد' });
    const seen = await listEntries(uid, { playerVisibleOnly: true, pageSize: 100 });
    assert.equal(seen.rows.some((r) => r.entryType === 'fee'), false, 'no fee line');
    assert.equal(seen.rows.some((r) => r.entryType === 'match_reward'), true, 'the prize is there');
  });

  await check('nor the stake, nor any internal transfer', async () => {
    assert.equal(isPlayerVisible('fee'), false);
    assert.equal(isPlayerVisible('penalty'), false);
    assert.equal(isPlayerVisible('deposit'), false);
    assert.equal(isPlayerVisible('match_stake'), false);
    assert.equal(isPlayerVisible('transfer_in'), false);
  });

  await check('but a purchase paid from the صندوق IS shown', async () => {
    /* Otherwise the balance drops and nothing on the statement explains it. */
    _resetFulfilled();
    const uid = await player();
    await win(uid, PRICE * 2);
    await payFromVault(uid, { kind: 'ticket', tier: TIER, qty: 1 }, 'o:' + id());
    const seen = await listEntries(uid, { playerVisibleOnly: true, pageSize: 100 });
    assert.equal(seen.rows.some((r) => r.entryType === 'ticket_purchase'), true);
  });

  await check('and a withdrawal is shown', async () => {
    assert.equal(isPlayerVisible('withdraw_lock'), true);
    assert.equal(isPlayerVisible('withdraw_paid'), true);
  });

  /* ── fulfilment on its own ────────────────────────────────────────── */

  await check('fulfilment hands over goods without charging', async () => {
    _resetFulfilled();
    const uid = await player();
    await win(uid, 400000);
    const before = (await getAccount(uid)).available;
    await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 3 }, 'ref:' + id());
    assert.equal((await getTickets(uid))[TIER], 3);
    assert.equal((await getAccount(uid)).available, before, 'the صندوق was untouched');
  });

  console.log(`[prizeVault] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
