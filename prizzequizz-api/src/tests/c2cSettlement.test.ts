/* THE DEPOSIT BECOMES THE GOODS.
 *
 * Everything before this stage was evidence-gathering. This is where a bank
 * transfer turns into a ticket in a player's account, so the things worth a
 * test are the ways that goes wrong with real money:
 *
 *   - ONE DEPOSIT SETTLES ONE ORDER. Two operators clearing the same queue,
 *     or a double-entered SMS, must not deliver twice.
 *   - A WRONG AMOUNT IS NEVER WAVED THROUGH. The payable figure is the ONLY
 *     thing tying a transfer to an order; settling against a different one is
 *     a person's decision, with a reason, in the audit.
 *   - THE UNIT IS ASKED FOR. Refah reports rial, others toman. A default
 *     would be a ten-times error on a busy evening.
 *   - AN INTERRUPTED SETTLEMENT CAN BE FINISHED. Money bound to an order that
 *     was never delivered must be completable from the same screen.
 *
 * Run: npx tsx src/tests/c2cSettlement.test.ts
 */
process.env.MATCHMAKING_WORKER = 'false';
process.env.LAST_SURVIVOR_WORKER = 'false';
process.env.LEAGUE_WORKER = 'false';
process.env.SERVER_MONITOR = 'false';
process.env.C2C_WORKER = 'false';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../app.js';
import { signAccessToken } from '../services/tokenService.js';
import { repositories } from '../repositories/index.js';
import { isValidPan, saveCard } from '../services/c2c/cardService.js';
import { getSession } from '../services/c2c/sessionStore.js';
import { getTransaction } from '../services/c2c/transactionStore.js';
import { listGateways, removeGateway, saveGateway } from '../services/paymentGatewayService.js';
import { getPaymentIntent } from '../services/paymentService.js';
import { find as findFulfilment } from '../services/orderFulfilmentService.js';
import { id } from '../utils/id.js';
import { resetC2c } from './c2cTestReset.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

function makePan(): string {
  const body = ('627412' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0')).slice(0, 15);
  for (let d = 0; d <= 9; d++) if (isValidPan(body + d)) return body + d;
  throw new Error('no check digit');
}

const ORDER = { kind: 'ticket' as const, tier: 'red', qty: 2 };   // 100,000 تومان

async function run(): Promise<void> {
  await resetC2c();
  for (const g of await listGateways()) await removeGateway(g.id);

  const gw = await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'live', priority: 1 });
  const card = await saveCard({
    pan: makePan(), accountNo: '49302749612', bankKey: 'sepah', bankName: 'بانک سپه',
    holderName: 'مهدی', status: 'ACTIVE', priority: 1, minAmountToman: 50_000
  });

  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const admin = (method: string, path: string, body?: unknown, key?: string) =>
    fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-admin-key': key ?? (process.env.ADMIN_KEY || 'dev-admin') },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  async function newPlayer() {
    const uid = id();
    await repositories.users.save({
      id: uid, username: 'st' + uid.slice(0, 8), displayName: 'ست',
      phone: '09' + String(200000000 + Math.floor(Math.random() * 99999999)),
      wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
      tickets: { green: 0, blue: 0, red: 0 }
    } as any);
    return { uid, token: signAccessToken(uid) };
  }

  /** A player opens a payment page and gets a figure to send. */
  async function openPayment() {
    const p = await newPlayer();
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token}` },
      body: JSON.stringify({ order: ORDER, method: 'gateway', gatewayId: gw.id, idempotencyKey: id() })
    });
    const d = (await res.json() as any).data;
    assert.ok(d?.sessionId, 'the payment page must open for these tests to mean anything');
    return { ...p, sessionId: d.sessionId as string, intentId: d.intentId as string, amountRial: d.amounts.payableRial as number };
  }

  try {
    await check('the queue is behind its own permission', async () => {
      const { createAccount, deleteAccount } = await import('../services/adminAccountService.js');
      const acc = await createAccount({
        username: 'c2cq' + Math.floor(Math.random() * 1e6), password: 'x'.repeat(12),
        perms: ['users', 'payments', 'c2ccards']
      });
      const res = await admin('GET', '/admin/c2c/transactions', undefined, acc.token);
      assert.equal(res.status, 403, 'editing destination cards is not the same as settling deposits');
      assert.equal((await res.json() as any).error.code, 'TAB_FORBIDDEN');
      await deleteAccount(acc.id);
    });

    await check('a deposit with no unit named is refused', async () => {
      /* Refah reports rial and others toman: a default here is a ten-times
       * error waiting for a busy evening. */
      const res = await admin('POST', '/admin/c2c/transactions/manual', { amount: 1_000_047, destRef: '49302749612' });
      assert.equal(res.status, 409);
      assert.equal((await res.json() as any).error.code, 'AMOUNT_UNIT_REQUIRED');
    });

    await check('a toman deposit is stored in rial', async () => {
      const res = await admin('POST', '/admin/c2c/transactions/manual', {
        amount: 60_000, amountUnit: 'toman', destRef: '49302749612', bankKey: 'sepah'
      });
      assert.equal(res.status, 201);
      const tx = (await res.json() as any).data.transaction;
      assert.equal(tx.amountRial, 600_000, 'one place converts, and it converted');
      assert.equal(tx.cardId, card.id, 'and the account number found our card by itself');
    });

    let player: Awaited<ReturnType<typeof openPayment>>;
    let txId = '';
    await check('a deposit of the exact figure finds the payment it belongs to', async () => {
      player = await openPayment();
      const res = await admin('POST', '/admin/c2c/transactions/manual', {
        amount: player.amountRial, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah',
        balance: 5_000_000, balanceUnit: 'rial'
      });
      const body = (await res.json() as any).data;
      txId = body.transaction.id;
      const exact = body.candidates.filter((c: any) => c.exact);
      assert.equal(exact.length, 1, 'exactly one — two live sessions cannot share an amount on a card');
      assert.equal(exact[0].session.id, player.sessionId);
      assert.equal(exact[0].warnings.length, 0, 'and nothing about it needs a warning');
      assert.equal(exact[0].player.id, player.uid, 'the operator sees WHO is waiting');
    });

    await check('but it is offered, never applied', async () => {
      const tx = await getTransaction(txId);
      assert.equal(tx!.status, 'NEW', 'entering a deposit settles nothing on its own');
      assert.equal(tx!.sessionId, null);
      const s = await getSession(player.sessionId);
      assert.equal(s!.status, 'AWAITING');
    });

    await check('assigning it delivers the goods', async () => {
      const res = await admin('POST', `/admin/c2c/transactions/${txId}/assign`, { sessionId: player.sessionId });
      assert.equal(res.status, 200);
      const body = (await res.json() as any).data;
      assert.equal(body.delivered, true);
      assert.equal(body.transaction.status, 'SETTLED');
      assert.equal(body.session.status, 'PAID');
      const user = await repositories.users.findById(player.uid);
      assert.equal((user as any).tickets.red, 2, 'the player actually has the tickets');
      const intent = await getPaymentIntent(player.intentId);
      assert.equal(intent!.status, 'paid');
      const f = await findFulfilment('intent:' + player.intentId);
      assert.equal(f!.status, 'done');
      assert.equal(f!.source, 'card_to_card', 'and the sale is recorded as card-to-card income');
      assert.equal(f!.amountToman, 100_000);
    });

    await check('the same deposit cannot be settled twice', async () => {
      const res = await admin('POST', `/admin/c2c/transactions/${txId}/assign`, { sessionId: player.sessionId });
      assert.equal(res.status, 409);
      assert.equal((await res.json() as any).error.code, 'BANK_TX_SETTLED');
      const user = await repositories.users.findById(player.uid);
      assert.equal((user as any).tickets.red, 2, 'and no second pair of tickets appeared');
    });

    await check('nor can a SECOND deposit be settled against the same payment', async () => {
      /* The operator types the same SMS in again. The money is real either
       * way — but the order was already delivered, and delivering it again is
       * a free ticket. */
      const dup = await admin('POST', '/admin/c2c/transactions/manual', {
        amount: player.amountRial, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah'
      });
      const dupId = (await dup.json() as any).data.transaction.id;
      const res = await admin('POST', `/admin/c2c/transactions/${dupId}/assign`, { sessionId: player.sessionId });
      assert.equal(res.status, 409);
      assert.equal((await res.json() as any).error.code, 'SESSION_ALREADY_PAID');
      const user = await repositories.users.findById(player.uid);
      assert.equal((user as any).tickets.red, 2);
      assert.equal((await getTransaction(dupId))!.status, 'NEW', 'the duplicate stays in the queue to be dealt with');
    });

    await check('a mismatched amount is refused until a person says why', async () => {
      const p2 = await openPayment();
      const res = await admin('POST', '/admin/c2c/transactions/manual', {
        amount: p2.amountRial - 5_000, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah'
      });
      const body = (await res.json() as any).data;
      const near = body.candidates.find((c: any) => c.session.id === p2.sessionId);
      assert.ok(near, 'the near miss is still offered — a fat-fingered digit is not a different order');
      assert.equal(near.exact, false);
      assert.match(near.warnings.join(' '), /یکی نیست/);

      const bad = await admin('POST', `/admin/c2c/transactions/${body.transaction.id}/assign`, { sessionId: p2.sessionId });
      assert.equal(bad.status, 409);
      assert.equal((await bad.json() as any).error.code, 'AMOUNT_MISMATCH');

      const noReason = await admin('POST', `/admin/c2c/transactions/${body.transaction.id}/assign`, {
        sessionId: p2.sessionId, acceptAmountMismatch: true
      });
      assert.equal((await noReason.json() as any).error.code, 'AMOUNT_MISMATCH', 'a tick without a reason is not a reason');

      const ok = await admin('POST', `/admin/c2c/transactions/${body.transaction.id}/assign`, {
        sessionId: p2.sessionId, acceptAmountMismatch: true, reason: 'کاربر ۵۰۰ تومان کمتر زد، با پشتیبانی تأیید شد'
      });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json() as any).data.delivered, true);
      const user = await repositories.users.findById(p2.uid);
      assert.equal((user as any).tickets.red, 2, 'the player got what they ordered');
    });

    await check('and that decision is in the admin audit, with its reason', async () => {
      const { listAdminAudit } = await import('../services/adminAuditService.js');
      const rows = await listAdminAudit({ action: 'c2c_transaction_settled', limit: 20 });
      const mismatch = rows.find((r: any) => (r.meta as any)?.amountMismatch === true);
      assert.ok(mismatch, 'a settlement against a different figure must be findable months later');
      assert.match(String((mismatch!.meta as any).reason), /۵۰۰ تومان کمتر/);
    });

    await check('a deposit that is nobody’s is rejected with a reason, not deleted', async () => {
      const res = await admin('POST', '/admin/c2c/transactions/manual', {
        amount: 12_345_670, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah'
      });
      const tx = (await res.json() as any).data.transaction;
      const noReason = await admin('POST', `/admin/c2c/transactions/${tx.id}/ignore`, {});
      assert.equal((await noReason.json() as any).error.code, 'REASON_REQUIRED');
      const ok = await admin('POST', `/admin/c2c/transactions/${tx.id}/ignore`, { reason: 'حقوق اپراتور' });
      assert.equal(ok.status, 200);
      const after = await getTransaction(tx.id);
      assert.equal(after!.status, 'IGNORED');
      assert.equal(after!.note, 'حقوق اپراتور', 'the queue stays explainable months later');
    });

    await check('an interrupted settlement can be finished from the same screen', async () => {
      /* Matrix row ۶: the process dies between binding the money and handing
       * over the goods. Refusing to continue would leave real money bound to
       * an order nobody ever delivered, with no way through the panel. */
      const p3 = await openPayment();
      const made = await admin('POST', '/admin/c2c/transactions/manual', {
        amount: p3.amountRial, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah'
      });
      const tx3 = (await made.json() as any).data.transaction.id;
      const { bindToSession } = await import('../services/c2c/transactionStore.js');
      await bindToSession(tx3, p3.sessionId);          // the crash: bound, not delivered
      assert.equal((await getTransaction(tx3))!.status, 'ASSIGNED');

      const res = await admin('POST', `/admin/c2c/transactions/${tx3}/assign`, { sessionId: p3.sessionId });
      assert.equal(res.status, 200, 'the same action carries it the rest of the way');
      assert.equal((await res.json() as any).data.delivered, true);
      const user = await repositories.users.findById(p3.uid);
      assert.equal((user as any).tickets.red, 2);
    });

    await check('a deposit bound to one payment cannot be moved to another', async () => {
      /* Money already attached to one order must not be re-pointed at a
       * different one: the first order would be left paid-for and undelivered
       * while the second is delivered for free. */
      const a = await openPayment();
      const b = await openPayment();
      const made = await admin('POST', '/admin/c2c/transactions/manual', {
        amount: a.amountRial, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah'
      });
      const txId4 = (await made.json() as any).data.transaction.id;
      const { bindToSession } = await import('../services/c2c/transactionStore.js');
      assert.ok(await bindToSession(txId4, a.sessionId), 'bound to the first');

      const res = await admin('POST', `/admin/c2c/transactions/${txId4}/assign`, { sessionId: b.sessionId });
      assert.equal(res.status, 409);
      assert.equal((await res.json() as any).error.code, 'BANK_TX_ASSIGNED_ELSEWHERE');
      assert.equal((await getSession(b.sessionId))!.status, 'AWAITING', 'and the other order is untouched');
      assert.equal((await getTransaction(txId4))!.sessionId, a.sessionId);
    });

    await check('the card-to-card settlement door is shut to gateway payments', async () => {
      /* settleCardToCardIntent marks an intent paid with NO signature to
       * check, because the bank never calls back. If it also accepted a
       * redirect-gateway intent it would be a way around the HMAC entirely. */
      const redirect = await saveGateway({ name: 'درگاه تست', type: 'sandbox', availability: 'live', priority: 9 });
      const p5 = await newPlayer();
      const { createPaymentIntent, settleCardToCardIntent } = await import('../services/paymentService.js');
      const intent = await createPaymentIntent({
        userId: p5.uid, order: ORDER, gatewayId: redirect.id, idempotencyKey: id()
      });
      await assert.rejects(
        () => settleCardToCardIntent(intent.id),
        (e: any) => e.code === 'INTENT_NOT_CARD_TO_CARD',
        'a gateway intent must settle by signed callback and nothing else');
      const user = await repositories.users.findById(p5.uid);
      /* A fresh user's ticket map carries whichever tiers the driver seeds —
       * Postgres seeds bronze/silver/gold — so «none» is a missing key there
       * and a zero in memory. */
      assert.equal(Number((user as any).tickets?.red ?? 0), 0, 'and nothing was handed over');
      await removeGateway(redirect.id);
    });

    await check('a masked tail does not identify a destination card', async () => {
      /* Banks print «…۴۲۵۶». Four digits matches many cards, and crediting a
       * deposit to the wrong destination is how it lands on the wrong order. */
      const { findCardByRef } = await import('../services/c2c/cardService.js');
      assert.equal(await findCardByRef(card.pan.slice(-4)), null, 'four digits is not an identifier');
      assert.equal((await findCardByRef('49302749612'))?.id, card.id, 'the whole account number is');
      assert.equal((await findCardByRef('۴۹۳۰۲۷۴۹۶۱۲'))?.id, card.id,
        'and so is the same number in Persian digits, which is how an SMS app writes it');
    });

    await check('the same bank reference cannot be entered twice', async () => {
      const body = { amount: 777_777, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah', reference: 'RF-9001' };
      assert.equal((await admin('POST', '/admin/c2c/transactions/manual', body)).status, 201);
      const again = await admin('POST', '/admin/c2c/transactions/manual', body);
      assert.equal(again.status, 409);
      assert.equal((await again.json() as any).error.code, 'BANK_TX_DUPLICATE');
      /* But three of the four banks print no reference at all, so two blank
       * ones must never collide — that would block real deposits. */
      const blank = { amount: 888_888, amountUnit: 'rial', destRef: '49302749612', bankKey: 'sepah' };
      assert.equal((await admin('POST', '/admin/c2c/transactions/manual', blank)).status, 201);
      assert.equal((await admin('POST', '/admin/c2c/transactions/manual', blank)).status, 201);
    });

    await check('the queue reports what really arrived, for reconciling with the bank', async () => {
      const body = (await (await admin('GET', '/admin/c2c/transactions')).json() as any).data;
      assert.ok(body.rows.length >= 5);
      const settled = body.rows.filter((r: any) => r.status === 'SETTLED');
      assert.equal(body.settled.count, settled.length);
      assert.equal(body.settled.totalRial, settled.reduce((s: number, r: any) => s + r.amountRial, 0),
        'the only check that catches a forged deposit is this total against the bank statement');
      assert.ok(body.rows[0].amountRialText.includes('ریال'), 'the panel never formats money itself');
    });

    await check('and the sale lands in the finance report as card-to-card income', async () => {
      /* The whole point of settling by hand before any Android code exists:
       * the money chain is proven end to end — session, deposit, delivery,
       * ACCOUNTING — with the operator's own test transfer. A sale paid
       * outside the صندوق leaves no trace in wallet_ledger by design, so if it
       * does not appear here it appears nowhere. */
      const { financeReport } = await import('../services/accountingService.js');
      const r = await financeReport({});
      assert.ok(r.externalSales.count >= 3, 'the settled sales are counted: ' + r.externalSales.count);
      const c2cLine = r.externalSales.bySource.find((b: any) => b.source === 'card_to_card');
      assert.ok(c2cLine, 'card-to-card is not a source the report knows about');
      assert.ok(c2cLine!.total >= 300_000, 'three settled orders at ۱۰۰٬۰۰۰ تومان: ' + c2cLine!.total);
      assert.ok(r.externalSales.tickets >= 300_000, 'and they are broken out as ticket income');
      assert.ok(r.income.tickets >= r.externalSales.tickets,
        'the breakdown is folded into the income line, not added beside it');
    });

    await check('the payments list shows who is waiting and for how much', async () => {
      const body = (await (await admin('GET', '/admin/c2c/sessions?status=AWAITING')).json() as any).data;
      assert.ok(body.rows.every((r: any) => r.status === 'AWAITING'));
      assert.ok(body.rows.every((r: any) => r.amountRialText && r.cardLabel));
    });
  } finally {
    server.close();
  }

  console.log(`[c2cSettlement] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
