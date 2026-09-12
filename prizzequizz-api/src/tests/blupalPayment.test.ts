/* PAYING FOR A TICKET WITH A CARD TRANSFER, END TO END.
 *
 * blupal.test.ts holds the gateway client to its contract. This one holds the
 * PAYMENT to its: an order goes out, a card transfer comes back, and exactly
 * one ticket is issued — no matter how many times BluPal says so, or what the
 * thing saying it claims to be.
 *
 * The rule the whole file turns on: BluPal's webhook carries no signature, so
 * the body is a nudge and never evidence. All it may do is name an invoice.
 * What decides is the answer BluPal gives over OUR connection with OUR key.
 * So every test here that tries to buy something does it by lying in the
 * webhook body — and the only ones that succeed are the ones where BluPal
 * itself, asked directly, says the money arrived for the right amount.
 *
 * Run: npx tsx src/tests/blupalPayment.test.ts */
import assert from 'node:assert/strict';
import { createPaymentIntent, settleBlupalIntent, findIntentByBlupalInvoice } from '../services/paymentService.js';
import { _resetFulfilled } from '../services/purchaseOrderService.js';
import { getTickets } from '../services/ticketService.js';
import { getTicketPrices } from '../services/economyConfig.js';
import { getAccount } from '../services/walletLedgerService.js';
import { BlupalError, tomanToRial } from '../services/blupalService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'bp' + uid.slice(0, 8), displayName: 'bp',
    phone: '09' + String(200000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  return uid;
}

const TIER = Object.keys(getTicketPrices())[0]!;
const PRICE = getTicketPrices()[TIER]!;
const ORDER = { kind: 'ticket' as const, tier: TIER, qty: 1 };

/* BluPal, played by the test. `serve` decides what their API answers; `calls`
 * records that we went and asked at all, which several tests are about. */
const realFetch = globalThis.fetch;
let calls: string[] = [];
let sentBodies: any[] = [];
let nextInvoiceId = 9000;
function serve(invoiceFor: (invoiceId: number) => any): void {
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push((init?.method || 'GET') + ' ' + u.replace(/^https?:\/\/[^/]+/, ''));
    if (init?.body) sentBodies.push(JSON.parse(String(init.body)));
    if (u.includes('/invoices/create')) {
      const body = JSON.parse(String(init.body));
      const invoiceId = ++nextInvoiceId;
      return ok({ success: true, invoice_id: invoiceId, amount: body.amount, final_amount: body.amount,
                  status: 'PENDING', payment_link: 'https://blupal.net/pay/' + invoiceId,
                  card_number: '6037-9999-0000-1111', mode: 'sandbox' });
    }
    const m = /\/invoices\/(\d+)/.exec(u);
    return ok(invoiceFor(Number(m?.[1] ?? 0)));
  }) as any;
}
const ok = (json: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) } as any);
const INV = (invoiceId: number, over: any = {}) => ({
  success: true, invoice_id: invoiceId, amount: tomanToRial(PRICE), final_amount: tomanToRial(PRICE),
  status: 'PENDING', payment_link: 'https://blupal.net/pay/' + invoiceId, card_number: '6037-9999-0000-1111',
  mode: 'sandbox', transaction_id: 55, payer_name: 'علی', payer_bank_name: 'ملت', ...over
});

const KEEP = process.env.BLUPAL_API_KEY;

(async () => {
  process.env.BLUPAL_API_KEY = 'blu_test_harness';
  await _resetFulfilled();

  /* ── opening the invoice ───────────────────────────────────────────── */

  await check('a gateway order opens a BluPal invoice and sends the player to it', async () => {
    serve((i) => INV(i));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    assert.equal(intent.amount, PRICE, 'priced from the catalogue, not the client');
    assert.match(intent.paymentUrl!, /blupal\.net\/pay\//, 'the player is sent to BluPal, not the sandbox stub');
    assert.match(String(intent.providerReference), /^blupal:\d+$/);
    const m = intent.metadata as any;
    assert.equal(m.gatewayType, 'blupal');
    assert.equal(m.blupalFinalRial, tomanToRial(PRICE), 'the rial figure that will count as paid is written down now');
    assert.ok(m.blupalInvoiceId > 0);
  });

  await check('the amount BluPal is asked for is in RIAL, not toman', async () => {
    /* A stray ×10 in a payment path is a ten-fold error in real money, and the
       two units look identical in a log. So the number that actually left the
       building is checked, not just that a call happened. */
    calls = []; sentBodies = []; serve((i) => INV(i));
    const uid = await player();
    await createPaymentIntent({ userId: uid, order: ORDER });
    assert.ok(calls.some((c) => c.includes('/invoices/create')), 'an invoice was actually opened');
    assert.equal(sentBodies[0]?.amount, PRICE * 10, `asked for ${sentBodies[0]?.amount}, but ${PRICE} toman is ${PRICE * 10} rial`);
    assert.notEqual(sentBodies[0]?.amount, PRICE, 'sending the toman figure would charge a tenth of the price');
  });

  await check('nothing is written down when BluPal refuses to open the invoice', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ success: false, error: 'amount_too_low', message: 'مبلغ کم است.' }) })) as any;
    const uid = await player();
    await assert.rejects(() => createPaymentIntent({ userId: uid, order: ORDER }), (e: unknown) => e instanceof BlupalError);
    const rows = await repositories.payments.list({ userId: uid, limit: 10 });
    assert.equal(rows.length, 0, 'a half-made intent would be something a later callback could stumble on');
  });

  /* ── the webhook is a nudge, not evidence ──────────────────────────── */

  await check('a webhook for an invoice BluPal says is unpaid delivers nothing', async () => {
    serve((i) => INV(i, { status: 'PENDING' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    const r = await settleBlupalIntent(intent.id);
    assert.equal(r.paid, false);
    assert.equal(r.reason, 'status_pending');
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0, 'no ticket for an unpaid invoice');
  });

  await check('a webhook for an EXPIRED invoice delivers nothing', async () => {
    serve((i) => INV(i, { status: 'EXPIRED' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    assert.equal((await settleBlupalIntent(intent.id)).reason, 'status_expired');
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0);
  });

  await check('a paid invoice for a DIFFERENT amount delivers nothing', async () => {
    /* The invoice is genuinely paid — for the wrong figure. A payment for a
       different amount is a different payment, however plausible it looks. */
    serve((i) => INV(i, { status: 'PAID', final_amount: tomanToRial(PRICE) - 10 }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    /* The invoice was opened at the right figure; only the "paid" answer differs. */
    serve((i) => INV(i, { status: 'PAID', final_amount: tomanToRial(PRICE) - 10 }));
    const r = await settleBlupalIntent(intent.id);
    assert.equal(r.paid, false);
    assert.equal(r.reason, 'amount_mismatch');
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0, 'ten rial short is not paid');
  });

  await check('a paid invoice from the WRONG WORLD delivers nothing', async () => {
    serve((i) => INV(i));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    process.env.BLUPAL_API_KEY = 'blu_live_harness';   // we are live now
    serve((i) => INV(i, { status: 'PAID', mode: 'sandbox' }));  // the invoice is not
    const r = await settleBlupalIntent(intent.id);
    process.env.BLUPAL_API_KEY = 'blu_test_harness';
    assert.equal(r.paid, false);
    assert.equal(r.reason, 'mode_mismatch', 'a test invoice must never be a free shop on a live system');
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0);
  });

  /* ── a real payment ────────────────────────────────────────────────── */

  await check('a genuinely paid invoice delivers the ticket', async () => {
    serve((i) => INV(i, { status: 'PAID' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0, 'nothing before payment');
    const r = await settleBlupalIntent(intent.id);
    assert.equal(r.paid, true);
    assert.equal((await getTickets(uid))[TIER], 1, 'the ticket arrived');
  });

  await check('and the money never lands in the صندوق', async () => {
    /* The whole reason topping up was removed: money that could go in and come
       back out would make a prize fund a money-transfer service. */
    serve((i) => INV(i, { status: 'PAID' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    await settleBlupalIntent(intent.id);
    assert.equal((await getAccount(uid)).available, 0, 'paid at the gateway, and the صندوق is still empty');
  });

  /* ── the same news, over and over ──────────────────────────────────── */

  await check('five identical webhooks deliver ONE ticket', async () => {
    serve((i) => INV(i, { status: 'PAID' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    for (let i = 0; i < 5; i++) await settleBlupalIntent(intent.id);
    assert.equal((await getTickets(uid))[TIER], 1, 'a gateway retrying is normal; paying out five times is not');
  });

  await check('webhook and player-return arriving together deliver ONE ticket', async () => {
    serve((i) => INV(i, { status: 'PAID' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    await Promise.all(Array.from({ length: 6 }, () => settleBlupalIntent(intent.id)));
    assert.equal((await getTickets(uid))[TIER], 1, 'both doors lead to one delivery');
  });

  await check('a settled intent is answered without asking BluPal again', async () => {
    serve((i) => INV(i, { status: 'PAID' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    await settleBlupalIntent(intent.id);
    calls = [];
    const r = await settleBlupalIntent(intent.id);
    assert.equal(r.paid, true, 'it is still paid');
    assert.equal(calls.length, 0, 'a stranger replaying a webhook must not be able to make us call BluPal all day');
  });

  /* ── invoice ids from strangers ────────────────────────────────────── */

  await check('an invoice id nobody opened belongs to no intent', async () => {
    serve((i) => INV(i));
    assert.equal(await findIntentByBlupalInvoice(4242424), null);
    assert.equal(await findIntentByBlupalInvoice(0), null, 'and neither does a missing one');
    assert.equal(await findIntentByBlupalInvoice(NaN), null);
  });

  await check('an invoice id DOES find the intent that opened it', async () => {
    serve((i) => INV(i));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    const found = await findIntentByBlupalInvoice((intent.metadata as any).blupalInvoiceId);
    assert.equal(found?.id, intent.id, 'otherwise a real webhook could never be matched to an order');
  });

  await check('an intent that never went through BluPal is not settled by this door', async () => {
    serve((i) => INV(i, { status: 'PAID' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    /* Strip what the gateway wrote, leaving the shape of an intent from some
       other provider. The BluPal door must not settle it. */
    await repositories.payments.updateStatus(intent.id, intent.status, { metadata: { order: ORDER } } as any);
    const r = await settleBlupalIntent(intent.id);
    assert.equal(r.paid, false);
    assert.equal(r.reason, 'not_a_blupal_intent');
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0);
  });

  await check('an intent id that does not exist settles nothing', async () => {
    const r = await settleBlupalIntent(id());
    assert.equal(r.paid, false);
    assert.equal(r.reason, 'not_found');
  });

  /* ── when BluPal is down ───────────────────────────────────────────── */

  await check('BluPal being unreachable is not a failed payment', async () => {
    serve((i) => INV(i, { status: 'PAID' }));
    const uid = await player();
    const intent = await createPaymentIntent({ userId: uid, order: ORDER });
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as any;
    await assert.rejects(() => settleBlupalIntent(intent.id), (e: unknown) => e instanceof BlupalError);
    assert.equal((await getTickets(uid))[TIER] ?? 0, 0, 'nothing delivered while we cannot see the gateway');
    /* And the player is not locked out of the purchase they paid for. */
    serve((i) => INV(i, { status: 'PAID' }));
    assert.equal((await settleBlupalIntent(intent.id)).paid, true);
    assert.equal((await getTickets(uid))[TIER], 1, 'the retry delivers it');
  });

  globalThis.fetch = realFetch;
  if (KEEP === undefined) delete process.env.BLUPAL_API_KEY; else process.env.BLUPAL_API_KEY = KEEP;
  console.log(`[blupalPayment] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
