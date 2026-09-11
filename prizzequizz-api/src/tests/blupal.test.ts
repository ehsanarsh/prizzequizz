/* THE BLUPAL GATEWAY, AND THE TWO WAYS IT COULD BE LIED TO.
 *
 * BluPal's webhook carries no signature — no HMAC, no secret, nothing in their
 * whole contract — and their own advice, «check the invoice_id against your
 * database», only proves that WE opened that invoice. It says nothing about
 * whether anybody paid it. So the rule this file exists to hold is: a webhook
 * body never unlocks anything. Goods move only on an answer BluPal gave us over
 * our own connection, with our own key.
 *
 * The second rule is arithmetic. BluPal counts in rial, PrizzeQuizz counts in
 * toman, and a stray ×10 in a payment path is a ten-fold error in real money.
 *
 * Run: npx tsx src/tests/blupal.test.ts */
import assert from 'node:assert/strict';
import {
  tomanToRial, rialToToman, MIN_RIAL, MAX_RIAL, blupalConfigured, blupalMode,
  createInvoice, getInvoice, verifyPaid, BlupalError
} from '../services/blupalService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const KEEP = { key: process.env.BLUPAL_API_KEY, base: process.env.BLUPAL_BASE_URL };
const setKey = (v?: string) => { if (v === undefined) delete process.env.BLUPAL_API_KEY; else process.env.BLUPAL_API_KEY = v; };

/** Stand in for BluPal. Records what we sent; answers what the test dictates. */
const realFetch = globalThis.fetch;
let sent: Array<{ url: string; method: string; headers: any; body: any }> = [];
function serve(handler: (url: string, body: any) => { status?: number; json: any }): void {
  sent = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ url: String(url), method: init?.method || 'GET', headers: init?.headers || {}, body });
    const r = handler(String(url), body);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.json) } as any;
  }) as any;
}
const restore = () => { globalThis.fetch = realFetch; };

const INV = (over: Record<string, unknown> = {}) => ({
  success: true, invoice_id: 123, amount: 1_000_000, final_amount: 1_000_123,
  status: 'PENDING', payment_link: 'https://blupal.net/payment/TOK', card_number: '6219861012345678',
  mode: 'sandbox', expires_at: null, ...over
});

(async () => {
  // ── the unit conversion ──────────────────────────────────────────────────
  await check('toman becomes rial by ten, in both directions', () => {
    assert.equal(tomanToRial(12_500), 125_000);
    assert.equal(rialToToman(125_000), 12_500);
    assert.equal(rialToToman(tomanToRial(45_000)), 45_000);
  });
  await check('and nonsense cannot become a negative charge', () => {
    for (const v of [-5, NaN, Infinity as unknown as number]) {
      assert.ok(tomanToRial(v as number) >= 0, String(v));
      assert.ok(rialToToman(v as number) >= 0, String(v));
    }
  });
  await check('the published limits are the ones we enforce', () => {
    assert.equal(rialToToman(MIN_RIAL), 10_000);
    assert.equal(rialToToman(MAX_RIAL), 50_000_000);
  });

  // ── which world the key lives in ─────────────────────────────────────────
  await check('a missing key means the gateway is off, not open', () => {
    setKey(undefined); assert.equal(blupalConfigured(), false);
    setKey('   '); assert.equal(blupalConfigured(), false, 'whitespace is not a key');
    setKey('blu_test_x'); assert.equal(blupalConfigured(), true);
  });
  await check('the mode is read off the key, so the two can never disagree', () => {
    setKey('blu_live_abc'); assert.equal(blupalMode(), 'live');
    setKey('blu_test_abc'); assert.equal(blupalMode(), 'sandbox');
    /* Anything unrecognised is treated as sandbox: the safe direction is to
       refuse to deliver, never to deliver by accident. */
    setKey('something-else'); assert.equal(blupalMode(), 'sandbox');
  });

  // ── opening an invoice ───────────────────────────────────────────────────
  setKey('blu_test_k');
  await check('an order priced in toman is billed in rial', async () => {
    serve(() => ({ json: INV({ amount: 125_000, final_amount: 125_456 }) }));
    const inv = await createInvoice(12_500);
    assert.equal(sent[0]!.body.amount, 125_000, 'we must send rial');
    assert.equal(inv.amountToman, 12_500, 'and read it back as toman');
    assert.equal(inv.finalAmountRial, 125_456, 'the payable figure stays in rial, to the rial');
    restore();
  });
  await check('the key travels in the header BluPal reads', async () => {
    serve(() => ({ json: INV() }));
    await createInvoice(12_500);
    assert.equal((sent[0]!.headers as any)['X-API-Key'], 'blu_test_k');
    /* Never in the query string, where it would land in every access log on
       the way. Their docs allow it; that does not make it a good idea. */
    assert.ok(!sent[0]!.url.includes('api_key'), sent[0]!.url);
    restore();
  });
  await check('an amount below their floor is refused before the request', async () => {
    serve(() => ({ json: INV() }));
    await assert.rejects(() => createInvoice(9_999), (e: unknown) => e instanceof BlupalError && e.code === 'amount_too_low');
    assert.equal(sent.length, 0, 'and no request was made at all');
    restore();
  });
  await check('as is one above their ceiling', async () => {
    serve(() => ({ json: INV() }));
    await assert.rejects(() => createInvoice(50_000_001), (e: unknown) => e instanceof BlupalError && e.code === 'amount_too_high');
    assert.equal(sent.length, 0);
    restore();
  });
  await check('their error is passed to the player, not swallowed', async () => {
    serve(() => ({ status: 400, json: { success: false, error: 'no_active_card', message: 'هیچ کارت فعالی یافت نشد' } }));
    await assert.rejects(() => createInvoice(12_500), (e: unknown) =>
      e instanceof BlupalError && e.code === 'no_active_card' && /کارت فعالی/.test(e.message));
    restore();
  });
  await check('a gateway that cannot be reached is a 502, not a crash', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    await assert.rejects(() => createInvoice(12_500), (e: unknown) =>
      e instanceof BlupalError && e.code === 'BLUPAL_UNREACHABLE' && e.httpStatus === 502);
    restore();
  });
  await check('with no key, nothing is attempted', async () => {
    setKey(undefined);
    serve(() => ({ json: INV() }));
    await assert.rejects(() => createInvoice(12_500), (e: unknown) => e instanceof BlupalError && e.code === 'BLUPAL_NOT_CONFIGURED');
    assert.equal(sent.length, 0);
    restore(); setKey('blu_test_k');
  });

  // ── THE RULE THAT GUARDS THE MONEY ───────────────────────────────────────
  const EXPECT = 1_000_123;
  await check('a paid invoice for the recorded amount is accepted', async () => {
    serve(() => ({ json: INV({ status: 'PAID', final_amount: EXPECT, transaction_id: 456 }) }));
    const r = await verifyPaid({ invoiceId: 123, expectedFinalAmountRial: EXPECT });
    assert.equal(r.paid, true);
    assert.equal(r.invoice!.transactionId, 456);
    /* It ASKED — it did not take anyone's word for it. */
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.method, 'GET');
    assert.ok(sent[0]!.url.endsWith('/v1/invoices/123'), sent[0]!.url);
    restore();
  });
  await check('an invoice BluPal still calls PENDING unlocks nothing', async () => {
    serve(() => ({ json: INV({ status: 'PENDING', final_amount: EXPECT }) }));
    const r = await verifyPaid({ invoiceId: 123, expectedFinalAmountRial: EXPECT });
    assert.equal(r.paid, false); assert.equal(r.reason, 'status_pending');
    restore();
  });
  for (const st of ['EXPIRED', 'CANCELED']) {
    await check('nor one that is ' + st, async () => {
      serve(() => ({ json: INV({ status: st, final_amount: EXPECT }) }));
      const r = await verifyPaid({ invoiceId: 123, expectedFinalAmountRial: EXPECT });
      assert.equal(r.paid, false);
      restore();
    });
  }
  await check('a payment for a different figure is a different payment', async () => {
    serve(() => ({ json: INV({ status: 'PAID', final_amount: EXPECT + 1 }) }));
    const r = await verifyPaid({ invoiceId: 123, expectedFinalAmountRial: EXPECT });
    assert.equal(r.paid, false); assert.equal(r.reason, 'amount_mismatch');
    restore();
  });
  /* THE FREE SHOP. A sandbox invoice can be marked paid by anyone holding a
     test key, with no money anywhere. If that could deliver goods on a live
     system, the test environment would be a way to buy for nothing. */
  await check('a sandbox invoice never pays out on a live system', async () => {
    setKey('blu_live_k');
    serve(() => ({ json: INV({ status: 'PAID', final_amount: EXPECT, mode: 'sandbox' }) }));
    const r = await verifyPaid({ invoiceId: 123, expectedFinalAmountRial: EXPECT });
    assert.equal(r.paid, false); assert.equal(r.reason, 'mode_mismatch');
    restore();
  });
  await check('and a live invoice is not settled by a test system either', async () => {
    setKey('blu_test_k');
    serve(() => ({ json: INV({ status: 'PAID', final_amount: EXPECT, mode: 'live' }) }));
    const r = await verifyPaid({ invoiceId: 123, expectedFinalAmountRial: EXPECT });
    assert.equal(r.paid, false); assert.equal(r.reason, 'mode_mismatch');
    restore();
  });

  setKey(KEEP.key); if (KEEP.base === undefined) delete process.env.BLUPAL_BASE_URL;
  console.log(`[blupal] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
