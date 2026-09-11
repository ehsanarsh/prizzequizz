/* THE UNIQUE AMOUNT, AND THE CARD IT IS UNIQUE ON.
 *
 * Card-to-card carries no message: the payer cannot attach an order number and
 * the bank's reference is created at transfer time, so the amount is the only
 * identifier that can be handed out in advance. Everything downstream — the
 * matcher, the delivery, the money — rests on two live sessions never sharing
 * one.
 *
 * So this file leans on that in the way that actually breaks it: hundreds of
 * allocations racing at once, until the space is full, and then past full.
 *
 * It also covers the two rules that look like details and are not:
 *
 *   - the floor is measured on the ROUND price, never on the payable figure.
 *     A red ticket at 50,000 Toman becomes 500,047 Rial, which does clear a
 *     500,000 Rial threshold — by 47 Rial of uniqueness suffix. Leaning on
 *     that is a payment that silently stops being confirmable the day the
 *     suffix mode changes.
 *   - a cancelled session keeps its amount through a cool-down, or «انصراف»
 *     followed by a transfer anyway lands on whoever was given it next.
 *
 * Run: npx tsx src/tests/c2cAmount.test.ts   (add DATABASE_URL for the real index)
 */
import assert from 'node:assert/strict';
import {
  allocate, AllocationError, suffixSpace, CANDIDATES_PER_CARD
} from '../services/c2c/amountAllocator.js';
import {
  saveCard, removeCard, listCards, isValidPan, digitsOnly, formatPan, CardError, _resetCards
} from '../services/c2c/cardService.js';
import {
  setSessionStatus, listSessions, reservingSessionsForUser, _resetSessions
} from '../services/c2c/sessionStore.js';
import { updatePaymentSettings } from '../services/paymentGatewayService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import { resetC2c } from './c2cTestReset.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** A real Luhn-valid card number, built rather than hard-coded. */
function makePan(prefix = '627412'): string {
  let body = prefix + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  body = body.slice(0, 15);
  for (let d = 0; d <= 9; d++) if (isValidPan(body + d)) return body + d;
  throw new Error('no check digit found');
}

async function player(): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'c2c' + uid.slice(0, 8), displayName: 'c2c',
    phone: '09' + String(600000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  return uid;
}

/* Both drivers, in the right order — see c2cTestReset: against a real database
 * these tables hold foreign keys to each other, so the order is a constraint
 * and not a preference, and a test that only ever ran on memory would never
 * find that out. */
const clearCards = resetC2c;

const BASE = 60_000;      // Toman — above the 50,000 SMS floor
const BASE_RIAL = 600_000;

async function run(): Promise<void> {
  await clearCards();
  await updatePaymentSettings({ c2c: { suffixMode: 'rial', ttlMinutes: 20, reserveHours: 24, cancelCooldownMinutes: 15, maxActivePerUser: 2 } as never });

  /* ── the card itself ──────────────────────────────────────────────── */

  await check('a mistyped card number is refused before it can eat a payment', async () => {
    const good = makePan();
    assert.equal(isValidPan(good), true);
    /* One digit wrong — the commonest real mistake, and the one that sends a
     * player's money to a stranger with nothing on our side ever knowing. */
    const bad = good.slice(0, 5) + String((Number(good[5]) + 1) % 10) + good.slice(6);
    assert.equal(isValidPan(bad), false, 'Luhn catches it');
    await assert.rejects(
      () => saveCard({ pan: bad, accountNo: '49302749612' }),
      (e: unknown) => e instanceof CardError && e.code === 'CARD_PAN_INVALID');
  });

  await check('and a card with no account number is refused too', async () => {
    await assert.rejects(
      () => saveCard({ pan: makePan(), accountNo: '' }),
      (e: unknown) => e instanceof CardError && e.code === 'CARD_ACCOUNT_REQUIRED');
  });

  await check('the invisible marks a bank wraps its numbers in are stripped', async () => {
    /* Straight out of the real Sepah SMS: U+202A … U+202C around the account.
     * Nothing on screen shows them; a string comparison fails anyway. */
    assert.equal(digitsOnly('‪49302749612‬'), '49302749612');
    assert.equal(digitsOnly('۶۲۷۴۱۲۱۷'), '62741217', 'and Persian digits are digits');
    assert.equal(formatPan('6274121777044256'), '6274 1217 7704 4256');
  });

  /* ── the guarantee ────────────────────────────────────────────────── */

  await check('two hundred allocations at once produce two hundred DIFFERENT amounts', async () => {
    await clearCards();
    /* Three cards, so the space is 3 × 99 and the run should fit. */
    for (let i = 0; i < 3; i++) {
      await saveCard({ pan: makePan(), accountNo: '4930274961' + i, status: 'ACTIVE', priority: i, minAmountToman: 50_000 });
    }
    await updatePaymentSettings({ c2c: { maxActivePerUser: 1000 } as never });
    const uid = await player();
    const results = await Promise.all(
      Array.from({ length: 200 }, () => allocate({ userId: uid, baseAmountToman: BASE }).catch((e) => e))
    );
    const okOnes = results.filter((r) => !(r instanceof Error));
    assert.ok(okOnes.length >= 190, `expected nearly all to succeed, got ${okOnes.length}`);
    const keys = okOnes.map((r: any) => `${r.card.id}:${r.session.amountRial}`);
    assert.equal(new Set(keys).size, keys.length, 'no two live sessions share an amount on a card');
    for (const r of okOnes as any[]) {
      assert.ok(r.session.suffixRial >= 1 && r.session.suffixRial <= 99, 'suffix inside the space');
      assert.equal(r.session.amountRial, BASE_RIAL + r.session.suffixRial);
    }
  });

  await check('a round amount is never handed out — suffix zero does not exist', async () => {
    const all = await listSessions({ limit: 500 });
    assert.ok(all.length > 0);
    assert.equal(all.some((s) => s.amountRial === BASE_RIAL), false,
      'an unrelated round deposit must never be able to auto-match a session');
    assert.equal(suffixSpace('rial').includes(0), false);
    assert.equal(suffixSpace('toman').includes(0), false);
  });

  await check('when the space runs out, the refusal is clear and never a duplicate', async () => {
    await clearCards();
    await saveCard({ pan: makePan(), accountNo: '111222333', status: 'ACTIVE', minAmountToman: 50_000 });
    await updatePaymentSettings({ c2c: { maxActivePerUser: 1000 } as never });
    const uid = await player();

    /* Allocation is probabilistic near the top: 25 random probes can all miss
     * while a few slots are still free, and the card is abandoned rather than
     * swept exhaustively. So the thing to assert is not "the 100th call fails"
     * — it is that failures are ALWAYS the honest capacity error, successes
     * never exceed the space, and no amount is ever handed out twice. */
    const amounts: number[] = [];
    let refusals = 0;
    for (let i = 0; i < 300; i++) {
      try {
        amounts.push((await allocate({ userId: uid, baseAmountToman: BASE })).session.amountRial);
      } catch (e) {
        assert.ok(e instanceof AllocationError && e.code === 'C2C_CAPACITY_FULL',
          'a full space must say so, not fail some other way: ' + (e as Error).message);
        refusals++;
      }
    }
    assert.ok(refusals > 0, 'the space is finite and the test must actually reach the end of it');
    assert.ok(amounts.length <= 99, `never more than the suffix space, got ${amounts.length}`);
    assert.ok(amounts.length >= 60, `and most of it should be usable, got ${amounts.length}`);
    assert.equal(new Set(amounts).size, amounts.length, 'no amount handed out twice, right up to the edge');
  });

  /* ── the floor ────────────────────────────────────────────────────── */

  await check('the floor is measured on the round price, not on the payable figure', async () => {
    await clearCards();
    await saveCard({ pan: makePan(), accountNo: '999888777', status: 'ACTIVE', minAmountToman: 50_000 });
    const uid = await player();
    /* 50,000 Toman = 500,000 Rial, and the suffix would push it to 500,047 —
     * over a 500,000 Rial threshold. Allowing that would make the payment
     * depend on 47 Rial of uniqueness suffix. */
    await assert.rejects(
      () => allocate({ userId: uid, baseAmountToman: 50_000 }),
      (e: unknown) => e instanceof AllocationError && e.code === 'C2C_BELOW_MIN');
    /* And the message says the number, because «کمتر از حد مجاز» helps nobody. */
    const err = await allocate({ userId: uid, baseAmountToman: 50_000 }).catch((e) => e);
    assert.match(err.message, /۵۰٬۰۰۰/);
    const ok = await allocate({ userId: uid, baseAmountToman: 50_001 });
    assert.ok(ok.session.amountRial > 500_010);
  });

  await check('a card that is off, or full for the day, is not chosen', async () => {
    await clearCards();
    const off = await saveCard({ pan: makePan(), accountNo: '1', status: 'INACTIVE', priority: 1, minAmountToman: 50_000 });
    const fixing = await saveCard({ pan: makePan(), accountNo: '2', status: 'MAINTENANCE', priority: 2, minAmountToman: 50_000 });
    const open = await saveCard({ pan: makePan(), accountNo: '3', status: 'ACTIVE', priority: 3, minAmountToman: 50_000 });
    const uid = await player();
    const a = await allocate({ userId: uid, baseAmountToman: BASE });
    assert.equal(a.card.id, open.id, 'priority cannot promote a card that is not taking money');
    await removeCard(off.id); await removeCard(fixing.id);
  });

  /* ── cancelling ───────────────────────────────────────────────────── */

  await check('a cancelled session KEEPS its amount through the cool-down', async () => {
    await clearCards();
    await saveCard({ pan: makePan(), accountNo: '555', status: 'ACTIVE', minAmountToman: 50_000 });
    await updatePaymentSettings({ c2c: { maxActivePerUser: 1000 } as never });
    const uid = await player();
    const first = await allocate({ userId: uid, baseAmountToman: BASE });
    await setSessionStatus(first.session.id, 'CANCELLED');
    /* Take the whole rest of the space; if the cancelled amount were free it
     * would be handed out again here. */
    for (let i = 0; i < 98; i++) {
      try { await allocate({ userId: uid, baseAmountToman: BASE }); } catch { break; }
    }
    const again = (await listSessions({ limit: 500 }))
      .filter((s) => s.amountRial === first.session.amountRial && s.id !== first.session.id);
    assert.equal(again.length, 0,
      'a transfer sent after «انصراف» must not land on the next player given that amount');
  });

  await check('one player cannot hold the space open with abandoned sessions', async () => {
    await clearCards();
    await saveCard({ pan: makePan(), accountNo: '777', status: 'ACTIVE', minAmountToman: 50_000 });
    await updatePaymentSettings({ c2c: { maxActivePerUser: 2 } as never });
    const uid = await player();
    await allocate({ userId: uid, baseAmountToman: BASE });
    await allocate({ userId: uid, baseAmountToman: BASE });
    const third = await allocate({ userId: uid, baseAmountToman: BASE });
    assert.equal(third.supersededSessionIds.length, 1, 'the oldest is cancelled to make room');
    const open = await reservingSessionsForUser(uid);
    assert.equal(open.length, 2, 'never more than the cap');
  });

  await check('the toman suffix mode keeps the payable amount a whole toman', async () => {
    await clearCards();
    await saveCard({ pan: makePan(), accountNo: '888', status: 'ACTIVE', minAmountToman: 50_000 });
    await updatePaymentSettings({ c2c: { suffixMode: 'toman', maxActivePerUser: 10 } as never });
    const uid = await player();
    const a = await allocate({ userId: uid, baseAmountToman: BASE });
    assert.equal(a.session.amountRial % 10, 0, 'a banking app that only takes Toman can enter it');
    assert.ok(a.session.suffixRial >= 10 && a.session.suffixRial <= 990);
    assert.equal(suffixSpace('toman').length, suffixSpace('rial').length, 'same capacity, larger visible gap');
    await updatePaymentSettings({ c2c: { suffixMode: 'rial' } as never });
  });

  await check('candidates are tried in a random order, not counted up', async () => {
    /* Sequential suffixes would make every new payment collide with the last
     * one, and would leak how many payments are open: read two amounts,
     * subtract. */
    await clearCards();
    await saveCard({ pan: makePan(), accountNo: '333', status: 'ACTIVE', minAmountToman: 50_000 });
    await updatePaymentSettings({ c2c: { maxActivePerUser: 100 } as never });
    const uid = await player();
    const first: number[] = [];
    for (let i = 0; i < 12; i++) first.push((await allocate({ userId: uid, baseAmountToman: BASE })).session.suffixRial);
    const ascending = first.every((v, i) => i === 0 || v > first[i - 1]!);
    assert.equal(ascending, false, `suffixes came out in order: ${first.join(',')}`);
    assert.ok(CANDIDATES_PER_CARD < 99, 'and a busy card is abandoned before all 99 probes');
  });

  await clearCards();
  console.log(`[c2cAmount] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
