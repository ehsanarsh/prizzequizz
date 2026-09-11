/* THE PAYMENT PAGE, END TO END.
 *
 * Stage 5 is where a player can first be shown a card and an amount, so this
 * covers the three ways that goes wrong in a way nobody notices until money is
 * involved:
 *
 *   - THE SHEET LIES. A method is offered that cannot take this order — under
 *     the bank's SMS floor, or a gateway the panel has closed — and the player
 *     only finds out after choosing it.
 *   - THE PAGE SETTLES ITSELF. The sandbox pay link is a self-settling URL. A
 *     card-to-card intent that got one would let a player take the goods
 *     without transferring a rial.
 *   - ONE PAYMENT BECOMES TWO. A second tap allocates a second amount, so the
 *     player is shown a figure different from the one on their first screen
 *     and a slot in the card's amount space is held for money nobody will send.
 *
 * Run: npx tsx src/tests/c2cCheckout.test.ts
 */
/* The API's background workers keep their timers running after server.close(),
 * so a test that boots the server can finish its assertions and never exit. */
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
import { getSession, listSessions, RESERVING_STATUSES, _setExpiresAt } from '../services/c2c/sessionStore.js';
import { listGateways, removeGateway, saveGateway } from '../services/paymentGatewayService.js';
import { getPaymentIntent } from '../services/paymentService.js';
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

async function newUser(): Promise<{ uid: string; token: string }> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'cc' + uid.slice(0, 8), displayName: 'cc',
    phone: '09' + String(300000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  return { uid, token: signAccessToken(uid) };
}

/* The catalogue prices a red ticket at 50,000 — exactly the SMS floor, which
 * the floor rule excludes — so two of them is the smallest order that can be
 * paid this way, and one of them is the smallest that cannot. */
const ABOVE = { kind: 'ticket', tier: 'red', qty: 2 };   // 100,000 تومان
const AT_FLOOR = { kind: 'ticket', tier: 'red', qty: 1 };  // 50,000 تومان

async function run(): Promise<void> {
  await resetC2c();
  for (const g of await listGateways()) await removeGateway(g.id);

  const c2cGw = await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'live', priority: 2 });
  const soonGw = await saveGateway({ name: 'درگاه بانکی', type: 'zibal', availability: 'coming_soon', priority: 3 });
  const hiddenGw = await saveGateway({ name: 'درگاه کنارگذاشته', type: 'idpay', availability: 'hidden', priority: 4 });
  const card = await saveCard({
    pan: makePan(), accountNo: '49302749612', bankKey: 'sepah', bankName: 'بانک سپه',
    holderName: 'مهدی', status: 'ACTIVE', priority: 1, minAmountToman: 50_000
  });

  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  const me = await newUser();

  try {
    await check('the quote carries the sheet, in panel order', async () => {
      const body = (await (await call('POST', '/orders/quote', me.token, { order: ABOVE })).json() as any).data;
      assert.equal(body.amount, 100_000);
      const kinds = body.paymentMethods.map((m: any) => m.kind);
      assert.deepEqual(kinds, ['vault', 'card_to_card', 'gateway_redirect'],
        'vault first, then gateways by priority — and the hidden one is not in the list at all');
      assert.ok(!body.paymentMethods.some((m: any) => m.id === hiddenGw.id),
        '«پنهان» means not shown, not shown-and-greyed');
    });

    await check('a method that cannot take this order says so before it is chosen', async () => {
      const body = (await (await call('POST', '/orders/quote', me.token, { order: AT_FLOOR })).json() as any).data;
      const c2c = body.paymentMethods.find((m: any) => m.kind === 'card_to_card');
      assert.equal(c2c.state, 'live', 'the gateway is open');
      assert.equal(c2c.selectable, false, 'but not for this amount');
      assert.match(c2c.note, /۵۰٬۰۰۰ تومان/, 'and the floor is named, so the player knows what would work');
    });

    await check('an empty صندوق is offered but not selectable', async () => {
      const body = (await (await call('POST', '/orders/quote', me.token, { order: ABOVE })).json() as any).data;
      const vault = body.paymentMethods.find((m: any) => m.kind === 'vault');
      assert.equal(vault.selectable, false);
      assert.equal(body.canPayFromVault, false, 'the old field still answers the same question');
      assert.match(vault.note, /کافی نیست/);
    });

    await check('«به‌زودی» is listed, greyed, and carries its own sentence', async () => {
      const body = (await (await call('POST', '/orders/quote', me.token, { order: ABOVE })).json() as any).data;
      const soon = body.paymentMethods.find((m: any) => m.id === soonGw.id);
      assert.equal(soon.state, 'coming_soon');
      assert.equal(soon.selectable, false);
      assert.equal(soon.note, 'به‌زودی');
    });

    let sessionId = '', intentId = '', payableRial = 0;
    await check('paying opens a page with a card, a unique amount and a deadline', async () => {
      const res = await call('POST', '/orders/pay', me.token, {
        order: ABOVE, method: 'gateway', gatewayId: c2cGw.id, idempotencyKey: 'ord-one'
      });
      assert.equal(res.status, 201);
      const b = (await res.json() as any).data;
      assert.equal(b.flow, 'card_to_card');
      assert.equal(b.status, 'AWAITING');
      assert.equal(b.card.pan, card.pan);
      assert.equal(b.amounts.finalToman, 100_000);
      assert.ok(b.amounts.payableRial > 1_000_000 && b.amounts.payableRial < 1_000_100,
        'the payable figure is the Rial price plus a small suffix');
      assert.notEqual(b.amounts.payableRial, 1_000_000,
        'and never the round amount — a round transfer is what an unrelated deposit looks like');
      assert.equal(b.amounts.payableRialRaw, String(b.amounts.payableRial), 'no separators in the copy-paste figure');
      assert.match(b.trackingCode, /^PQ-[0-9A-Z]{5}$/);
      assert.ok(b.secondsLeft > 0 && b.serverTime, 'the countdown is measured against server time');
      sessionId = b.sessionId; intentId = b.intentId; payableRial = b.amounts.payableRial;
    });

    await check('and that page CANNOT settle itself', async () => {
      /* The sandbox pay link carries the HMAC that marks an intent paid. On a
       * card-to-card intent it would be a free ticket. */
      const intent = await getPaymentIntent(intentId);
      assert.ok(intent, 'the intent exists');
      assert.equal(intent!.paymentUrl, '', 'no self-settling URL');
      assert.equal(intent!.providerReference, '', 'and no sandbox reference either');
      assert.equal(intent!.provider, 'card_to_card');
      assert.equal((intent!.metadata as any).sandbox, true,
        'the gateway really is flagged sandbox — which is exactly why the flag must not be what decides this');
    });

    await check('a second tap is the same payment, not a second amount', async () => {
      const res = await call('POST', '/orders/pay', me.token, {
        order: ABOVE, method: 'gateway', gatewayId: c2cGw.id, idempotencyKey: 'ord-one'
      });
      const b = (await res.json() as any).data;
      assert.equal(b.sessionId, sessionId, 'the same session comes back');
      assert.equal(b.amounts.payableRial, payableRial, 'so the figure on the first screen is still the one to send');
      const open = (await listSessions({ cardId: card.id, status: 'AWAITING', limit: 50 }))
        .filter((s) => s.userId === me.uid);
      assert.equal(open.length, 1, 'and only one slot in the card amount space is held');
    });

    await check('a gateway the panel has closed cannot be opened by naming it', async () => {
      const res = await call('POST', '/orders/pay', me.token, {
        order: ABOVE, method: 'gateway', gatewayId: soonGw.id, idempotencyKey: 'ord-soon'
      });
      assert.equal(res.status, 409, 'a stale sheet is not a bad order');
      assert.equal((await res.json() as any).error.code, 'GATEWAY_NOT_AVAILABLE');
    });

    await check('card-to-card is chosen, never fallen into', async () => {
      /* An old cached build sends no gatewayId. It cannot render a card, an
       * exact figure or a deadline — so it must be told to refresh, not handed
       * a checkout it will drop on the floor while an amount slot is held. */
      const res = await call('POST', '/orders/pay', me.token, {
        order: ABOVE, method: 'gateway', idempotencyKey: 'ord-nochoice'
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json() as any).error.code, 'GATEWAY_SELECTION_REQUIRED');
      const sessions = (await listSessions({ cardId: card.id, limit: 100 })).filter((x) => x.userId === me.uid);
      assert.equal(sessions.length, 1, 'and no amount was reserved for it');
    });

    await check('closing every gateway closes payment — it does not open the sandbox', async () => {
      /* With no live gateway this used to fall through to the ambient provider,
       * which defaults to «sandbox» — so «همه به‌زودی» would have handed every
       * player a self-settling link instead of turning them away. */
      const reopen: Array<{ id: string; availability: 'live' | 'coming_soon' | 'hidden' }> = [];
      for (const g of await listGateways()) {
        if (g.availability === 'live') { reopen.push({ id: g.id, availability: g.availability }); await saveGateway({ ...g, availability: 'coming_soon' }); }
      }
      try {
        const res = await call('POST', '/orders/pay', me.token, {
          order: ABOVE, method: 'gateway', idempotencyKey: 'ord-closed'
        });
        assert.equal(res.status, 409);
        assert.equal((await res.json() as any).error.code, 'GATEWAY_NOT_AVAILABLE');
      } finally {
        for (const r of reopen) {
          const g = (await listGateways()).find((x) => x.id === r.id)!;
          await saveGateway({ ...g, availability: r.availability });
        }
      }
    });

    await check('the player can read their own session', async () => {
      const b = (await (await call('GET', `/c2c/sessions/${sessionId}`, me.token)).json() as any).data;
      assert.equal(b.status, 'AWAITING');
      assert.equal(b.settled, false);
      assert.equal(b.granted, null);
      assert.equal(b.checkout.amounts.payableRial, payableRial);
      assert.match(b.message, /منتظر واریز/);
    });

    await check('and nobody else can, without learning that it exists', async () => {
      const other = await newUser();
      const res = await call('GET', `/c2c/sessions/${sessionId}`, other.token);
      assert.equal(res.status, 404, '403 would confirm the id is real');
      assert.equal((await res.json() as any).error.code, 'C2C_SESSION_NOT_FOUND');
    });

    await check('an order under the floor never reaches a payment page', async () => {
      const res = await call('POST', '/orders/pay', me.token, {
        order: AT_FLOOR, method: 'gateway', gatewayId: c2cGw.id, idempotencyKey: 'ord-small'
      });
      assert.equal(res.status, 409);
      const body = await res.json() as any;
      assert.equal(body.error.code, 'C2C_BELOW_MIN');
      assert.match(body.error.message, /۵۰٬۰۰۰/);
    });

    await check('and leaves no pending payment behind when it fails', async () => {
      /* A `pending` intent for a page that never opened would sit in the
       * payments screen and count as money on its way in the gateway report. */
      const intents = await (await import('../services/paymentService.js')).listPaymentIntents({ userId: me.uid, limit: 50 });
      const orphan = intents.find((i) => i.amount === 50_000 && i.status === 'pending');
      assert.equal(orphan, undefined, 'no intent left pending for an order that could not be paid');
      const failed = intents.find((i) => i.amount === 50_000);
      assert.equal(failed?.status, 'failed');
      assert.equal((failed?.metadata as any)?.abandonedReason, 'C2C_BELOW_MIN');
    });

    await check('cancelling closes the payment but NOT the reservation', async () => {
      const b = (await (await call('POST', `/c2c/sessions/${sessionId}/cancel`, me.token)).json() as any).data;
      assert.equal(b.status, 'CANCELLED');
      assert.match(b.message, /لغو شد/);
      assert.equal(b.checkout, undefined, 'the page is over');
      const intent = await getPaymentIntent(intentId);
      assert.equal(intent!.status, 'failed', 'the intent dies with the page');
      const s = await getSession(sessionId);
      assert.equal(s!.amountRial, payableRial);
      /* RESERVING_STATUSES is the predicate of the partial unique index — the
       * actual enforcement — so this asserts the amount is genuinely still
       * held, not merely that the row remembers the figure. Somebody who
       * cancels and transfers anyway, seconds apart, must still be matched,
       * and a freed amount handed to the next player would match the wrong
       * person. */
      assert.ok(RESERVING_STATUSES.includes(s!.status),
        'the amount stays reserved after a cancel: ' + s!.status);
    });

    await check('a session whose deadline passed says the money is still recognised', async () => {
      const fresh = await newUser();
      const pay = await call('POST', '/orders/pay', fresh.token, {
        order: ABOVE, method: 'gateway', gatewayId: c2cGw.id, idempotencyKey: 'ord-exp'
      });
      const sid = (await pay.json() as any).data.sessionId;
      /* Reach past the deadline the way time does, by moving the row's. */
      await _setExpiresAt(sid, new Date(Date.now() - 1000).toISOString());
      const b = (await (await call('GET', `/c2c/sessions/${sid}`, fresh.token)).json() as any).data;
      assert.equal(b.status, 'EXPIRED', 'read applies the deadline');
      assert.equal(b.secondsLeft, 0);
      assert.match(b.message, /نگران نباش/, '«مهلت تمام شد» must not read as «پولت گم شد»');
      assert.equal(b.checkout, undefined);
    });
  } finally {
    server.close();
  }

  console.log(`[c2cCheckout] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
