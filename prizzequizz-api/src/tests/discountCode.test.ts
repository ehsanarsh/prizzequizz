/* CODES THAT TAKE MONEY OFF A PRICE.
 *
 * «و کد تخفیف هم باید باشه.»
 *
 * The arithmetic is checked without a database, because it can be. Everything
 * about LIMITS is checked against the real Postgres, because a limit is a claim
 * about two requests arriving at once and nothing in memory can test that.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/discountCode.test.ts
 */
import assert from 'node:assert/strict';
import { foldCode, discountFor, quoteDiscount, redeemDiscount, releaseDiscount,
         saveDiscountCode, listDiscountCodes, deleteDiscountCode } from '../services/discountService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  /* ── WHAT COUNTS AS THE SAME CODE ─────────────────────────────────────── */

  await check('a code is the same code however it was typed', () => {
    /* Read off a banner and typed by hand, on a keyboard that makes its own
       digits. A player who typed the right code and was told it is invalid does
       not try a fourth spelling — they decide the code was a lie. */
    const want = foldCode('EID1404');
    assert.equal(foldCode('eid1404'), want);
    assert.equal(foldCode('Eid 1404'), want);
    assert.equal(foldCode('eid-1404'), want);
    assert.equal(foldCode('EID۱۴۰۴'), want, 'Persian digits are digits');
    assert.equal(foldCode('  eid_1404  '), want);
  });

  await check('but two different codes stay different', () => {
    assert.notEqual(foldCode('EID1404'), foldCode('EID1405'));
    assert.notEqual(foldCode('NOWRUZ'), foldCode('NOWRUZ2'));
  });

  /* ── THE ARITHMETIC ───────────────────────────────────────────────────── */

  await check('a percentage takes that percentage off', () => {
    assert.equal(discountFor({ kind: 'percent', value: 20, maxDiscount: 0 }, 125000), 25000);
    assert.equal(discountFor({ kind: 'percent', value: 50, maxDiscount: 0 }, 100000), 50000);
  });

  await check('and is FLOORED, never rounded up', () => {
    /* 33% of 1,001 is 330.33. Rounding that up is money the shop never agreed
       to give away, on every order, forever. */
    assert.equal(discountFor({ kind: 'percent', value: 33, maxDiscount: 0 }, 1001), 330);
  });

  await check('a ceiling on a percentage is a ceiling', () => {
    /* «۵۰٪ تا سقف ۲۰٬۰۰۰ تومان» — without the cap this is 250,000 off. */
    assert.equal(discountFor({ kind: 'percent', value: 50, maxDiscount: 20000 }, 500000), 20000);
    assert.equal(discountFor({ kind: 'percent', value: 50, maxDiscount: 20000 }, 30000), 15000,
      'and it does not become a flat 20,000 on a small order');
  });

  await check('a fixed discount takes that much off', () => {
    assert.equal(discountFor({ kind: 'amount', value: 30000, maxDiscount: 0 }, 125000), 30000);
  });

  await check('but never more than the price itself', () => {
    /* A code worth more than the basket makes the order free. It does not make
       the shop owe the player money. */
    assert.equal(discountFor({ kind: 'amount', value: 500000, maxDiscount: 0 }, 125000), 125000);
    assert.equal(discountFor({ kind: 'percent', value: 100, maxDiscount: 0 }, 125000), 125000);
  });

  await check('and nothing off nothing', () => {
    assert.equal(discountFor({ kind: 'percent', value: 20, maxDiscount: 0 }, 0), 0);
    assert.equal(discountFor({ kind: 'amount', value: 0, maxDiscount: 0 }, 125000), 0);
  });

  /* ── AGAINST THE REAL TABLE ───────────────────────────────────────────── */
  if (!process.env.DATABASE_URL) {
    console.log('  — skipped: every limit below is a claim about two requests at once, which needs Postgres');
    console.log(`[discountCode] ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const { getPgPool } = await import('../database/postgres.js');
  const pool = getPgPool();
  const U1 = 'u-disc-1', U2 = 'u-disc-2';
  const wipe = async () => {
    await pool.query(`DELETE FROM discount_redemptions WHERE user_id = ANY($1::text[])`, [[U1, U2]]).catch(() => {});
    await pool.query(`DELETE FROM discount_codes WHERE folded LIKE 'TST%'`).catch(() => {});
  };
  /* The first save creates the tables. */
  await saveDiscountCode({ code: 'TSTWARM', kind: 'percent', value: 10 });
  await wipe();

  await check('an operator can create a code and read it back', async () => {
    const c = await saveDiscountCode({ code: 'Tst Eid', kind: 'percent', value: 20, maxDiscount: 20000, note: 'عید' });
    assert.equal(c.code, 'Tst Eid', 'what is stored is what was typed');
    assert.equal(c.kind, 'percent'); assert.equal(c.value, 20);
    const all = await listDiscountCodes();
    assert.ok(all.some((x) => x.id === c.id), 'not in the list');
  });

  await check('and the same code cannot exist twice under two spellings', async () => {
    const a = await saveDiscountCode({ code: 'TSTDUP', kind: 'percent', value: 10 });
    const b = await saveDiscountCode({ code: 'tst-dup', kind: 'percent', value: 90 });
    assert.equal(b.id, a.id, 'a second row was created for the same code');
    assert.equal(b.value, 90, 'and the edit did not take');
  });

  await check('a live code quotes a price', async () => {
    await saveDiscountCode({ code: 'TSTLIVE', kind: 'percent', value: 20 });
    const q = await quoteDiscount({ code: 'tst live', userId: U1, amount: 125000 });
    assert.equal(q.ok, true, String(q.message));
    assert.equal(q.amountOff, 25000);
    assert.equal(q.finalAmount, 100000);
  });

  await check('a code nobody made is refused, and says so in Persian', async () => {
    const q = await quoteDiscount({ code: 'TSTNOPE', userId: U1, amount: 125000 });
    assert.equal(q.ok, false);
    assert.equal(q.finalAmount, 125000, 'the price must not move on a refusal');
    assert.ok(/معتبر/.test(String(q.message)), String(q.message));
  });

  await check('a switched-off code is refused', async () => {
    await saveDiscountCode({ code: 'TSTOFF', kind: 'percent', value: 20, enabled: false });
    const q = await quoteDiscount({ code: 'TSTOFF', userId: U1, amount: 125000 });
    assert.equal(q.ok, false); assert.equal(q.reason, 'DISABLED');
  });

  await check('a code whose time has passed is refused', async () => {
    await saveDiscountCode({ code: 'TSTOLD', kind: 'percent', value: 20, expiresAt: Date.now() - 60000 });
    const q = await quoteDiscount({ code: 'TSTOLD', userId: U1, amount: 125000 });
    assert.equal(q.ok, false); assert.equal(q.reason, 'EXPIRED');
  });

  await check('and one whose time has not come yet', async () => {
    await saveDiscountCode({ code: 'TSTSOON', kind: 'percent', value: 20, startsAt: Date.now() + 3600000 });
    const q = await quoteDiscount({ code: 'TSTSOON', userId: U1, amount: 125000 });
    assert.equal(q.ok, false); assert.equal(q.reason, 'NOT_STARTED');
  });

  await check('a minimum basket is a minimum', async () => {
    await saveDiscountCode({ code: 'TSTMIN', kind: 'amount', value: 20000, minAmount: 100000 });
    const small = await quoteDiscount({ code: 'TSTMIN', userId: U1, amount: 50000 });
    assert.equal(small.ok, false); assert.equal(small.reason, 'BELOW_MIN');
    assert.ok(/۱۰۰٬۰۰۰/.test(String(small.message)), 'it must say what the minimum IS: ' + small.message);
    const big = await quoteDiscount({ code: 'TSTMIN', userId: U1, amount: 120000 });
    assert.equal(big.ok, true, String(big.message));
  });

  /* ── SPENDING IT ──────────────────────────────────────────────────────── */

  await check('quoting is free — it spends nothing', async () => {
    await saveDiscountCode({ code: 'TSTONCE', kind: 'amount', value: 10000, usageLimit: 1, perUserLimit: 1 });
    for (let i = 0; i < 4; i++) await quoteDiscount({ code: 'TSTONCE', userId: U1, amount: 125000 });
    const q = await quoteDiscount({ code: 'TSTONCE', userId: U1, amount: 125000 });
    assert.equal(q.ok, true, 'four quotes used the code up: ' + q.message);
  });

  await check('redeeming takes the money off and consumes the use', async () => {
    const r = await redeemDiscount({ code: 'TSTONCE', userId: U1, amount: 125000, ref: 'ord-1' });
    assert.equal(r.amountOff, 10000);
    const after = await quoteDiscount({ code: 'TSTONCE', userId: U2, amount: 125000 });
    assert.equal(after.ok, false); assert.equal(after.reason, 'EXHAUSTED', String(after.message));
  });

  await check('the same order redeeming twice is not discounted twice', async () => {
    /* A settlement can be replayed — a retried webhook, a resumed payment. The
       second one must return what the first did, not take another 10,000 off
       and burn another use. */
    const again = await redeemDiscount({ code: 'TSTONCE', userId: U1, amount: 125000, ref: 'ord-1' });
    assert.equal(again.amountOff, 10000);
    assert.equal(again.duplicate, true);
    const { rows } = await pool.query(`SELECT used_count FROM discount_codes WHERE folded='TSTONCE'`);
    assert.equal(Number(rows[0].used_count), 1, 'the second call consumed another use');
  });

  await check('one use each means one use each', async () => {
    await saveDiscountCode({ code: 'TSTPER', kind: 'amount', value: 5000, usageLimit: 0, perUserLimit: 1 });
    const a = await redeemDiscount({ code: 'TSTPER', userId: U1, amount: 50000, ref: 'per-1' });
    assert.equal(a.amountOff, 5000);
    const b = await quoteDiscount({ code: 'TSTPER', userId: U1, amount: 50000 });
    assert.equal(b.ok, false); assert.equal(b.reason, 'ALREADY_USED');
    /* …but somebody else has not used it. */
    const c = await redeemDiscount({ code: 'TSTPER', userId: U2, amount: 50000, ref: 'per-2' });
    assert.equal(c.amountOff, 5000, 'a different player was blocked by somebody else’s use');
  });

  await check('the last use cannot be handed to two people at once', async () => {
    /* The race, run for real: one use, ten simultaneous redemptions, each with
       its own order reference so the idempotency path cannot mask it. */
    await saveDiscountCode({ code: 'TSTRACE', kind: 'amount', value: 7000, usageLimit: 1, perUserLimit: 0 });
    const tries = Array.from({ length: 10 }, (_, i) =>
      redeemDiscount({ code: 'TSTRACE', userId: 'racer-' + i, amount: 50000, ref: 'race-' + i }));
    const got = (await Promise.all(tries)).filter((r) => r.amountOff > 0);
    assert.equal(got.length, 1, got.length + ' of ten redemptions succeeded on a single-use code');
    const { rows } = await pool.query(`SELECT used_count FROM discount_codes WHERE folded='TSTRACE'`);
    assert.equal(Number(rows[0].used_count), 1);
    await pool.query(`DELETE FROM discount_redemptions WHERE user_id LIKE 'racer-%'`);
  });

  await check('a redemption can be given back when the payment never happened', async () => {
    /* An expired gateway invoice must not leave a single-use code burned on an
       order that was never paid. */
    await saveDiscountCode({ code: 'TSTBACK', kind: 'amount', value: 6000, usageLimit: 1, perUserLimit: 1 });
    const r = await redeemDiscount({ code: 'TSTBACK', userId: U1, amount: 50000, ref: 'back-1' });
    assert.equal(r.amountOff, 6000);
    assert.equal(await releaseDiscount('back-1'), true);
    const q = await quoteDiscount({ code: 'TSTBACK', userId: U1, amount: 50000 });
    assert.equal(q.ok, true, 'the code was not given back: ' + q.message);
    const { rows } = await pool.query(`SELECT used_count FROM discount_codes WHERE folded='TSTBACK'`);
    assert.equal(Number(rows[0].used_count), 0, 'the counter was not put back');
  });

  await check('a dead code cannot be redeemed even if a stale quote said yes', async () => {
    /* The player was shown a price minutes ago; the code has since been turned
       off. What decides is the row as it stands at the moment money moves. */
    await saveDiscountCode({ code: 'TSTSTALE', kind: 'amount', value: 9000, usageLimit: 0, perUserLimit: 0 });
    const q = await quoteDiscount({ code: 'TSTSTALE', userId: U1, amount: 50000 });
    assert.equal(q.ok, true);
    await saveDiscountCode({ code: 'TSTSTALE', kind: 'amount', value: 9000, enabled: false });
    const r = await redeemDiscount({ code: 'TSTSTALE', userId: U1, amount: 50000, ref: 'stale-1' });
    assert.equal(r.amountOff, 0, 'a switched-off code still took money off the price');
  });

  await check('and a code deleted outright is gone', async () => {
    const c = await saveDiscountCode({ code: 'TSTGONE', kind: 'amount', value: 1000 });
    assert.equal(await deleteDiscountCode(c.id), true);
    const q = await quoteDiscount({ code: 'TSTGONE', userId: U1, amount: 50000 });
    assert.equal(q.ok, false); assert.equal(q.reason, 'NOT_FOUND');
  });

  await wipe();
  console.log(`[discountCode] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
