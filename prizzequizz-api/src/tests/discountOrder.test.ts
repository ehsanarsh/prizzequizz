/* A CODE THAT REALLY TAKES MONEY OFF A REAL ORDER.
 *
 * discountCode.test.ts checks the codes themselves. This checks the join: what
 * the صندوق is actually charged, what the ledger records, and — the one that
 * costs real money if it is wrong — that a code cannot be spent twice, or spent
 * on an order that then failed.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/discountOrder.test.ts
 */
import assert from 'node:assert/strict';
import { saveDiscountCode, quoteDiscount } from '../services/discountService.js';
import { payFromVault, quote } from '../services/purchaseOrderService.js';
import { postEntry, getAccount } from '../services/walletLedgerService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

if (!process.env.DATABASE_URL) {
  console.log('  — skipped: a discount is a claim about a ledger, which needs the database that holds it');
  console.log('[discountOrder] 0 passed, 0 failed');
  process.exit(0);
}

/** A player with a known amount of prize money in the صندوق. */
async function player(prize: number): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'dc' + uid.slice(0, 8), displayName: 'dc', phone: '09' + String(Date.now()).slice(-9),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0, status: 'active',
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  if (prize > 0) await postEntry({ userId: uid, entryType: 'match_reward', kind: 'credit', amount: prize, idempotencyKey: 'seed:' + uid, description: 'جایزه' });
  return uid;
}
const balance = async (uid: string) => Number((await getAccount(uid)).available) || 0;
const TICKET = { kind: 'ticket' as const, tier: 'green', qty: 1 };

(async () => {
  const price = (await quote(TICKET)).amount;
  assert.ok(price > 0, 'a green ticket has no price to discount');

  await check('a percentage really comes off what the صندوق is charged', async () => {
    await saveDiscountCode({ code: 'ORD20', kind: 'percent', value: 20, usageLimit: 0, perUserLimit: 0 });
    const uid = await player(price);
    const before = await balance(uid);
    const r = await payFromVault(uid, TICKET, 'ord-' + id(), 'ORD20');
    const off = Math.floor(price * 0.2);
    assert.equal(r.discount, off, 'the discount reported is not 20%');
    assert.equal(await balance(uid), before - (price - off), 'the صندوق was charged the wrong amount');
  });

  await check('and the player keeps what the code saved them', async () => {
    /* The point of the whole feature, stated as money: after a discounted
       purchase there is more left than after a full-price one. */
    await saveDiscountCode({ code: 'ORDHALF', kind: 'percent', value: 50, usageLimit: 0, perUserLimit: 0 });
    const a = await player(price), b = await player(price);
    await payFromVault(a, TICKET, 'ord-' + id());
    await payFromVault(b, TICKET, 'ord-' + id(), 'ORDHALF');
    assert.ok(await balance(b) > await balance(a),
      'paying with a code left no more money than paying without one');
  });

  await check('a صندوق holding exactly the DISCOUNTED price can pay', async () => {
    /* The ordering that makes this work: the code is spent first and the charge
       is made for what is left. Charging the full price first would refuse a
       player for not having money they were never going to be asked for. */
    await saveDiscountCode({ code: 'ORDEXACT', kind: 'amount', value: Math.floor(price / 2), usageLimit: 0, perUserLimit: 0 });
    const due = price - Math.floor(price / 2);
    const uid = await player(due);
    const r = await payFromVault(uid, TICKET, 'ord-' + id(), 'ORDEXACT');
    assert.ok(r.granted.length > 0, 'nothing was handed over');
    assert.equal(await balance(uid), 0);
  });

  await check('a code worth more than the order makes it free, not negative', async () => {
    await saveDiscountCode({ code: 'ORDHUGE', kind: 'amount', value: price * 10, usageLimit: 0, perUserLimit: 0 });
    const uid = await player(0);                       /* not a rial */
    const r = await payFromVault(uid, TICKET, 'ord-' + id(), 'ORDHUGE');
    assert.ok(r.granted.length > 0, 'a fully discounted order was refused');
    assert.equal(await balance(uid), 0, 'the صندوق moved on a free order');
  });

  await check('a code nobody made changes nothing', async () => {
    const uid = await player(price);
    const before = await balance(uid);
    const r = await payFromVault(uid, TICKET, 'ord-' + id(), 'NO-SUCH-CODE');
    assert.equal(r.discount, 0);
    assert.equal(await balance(uid), before - price, 'an unknown code moved the price');
  });

  await check('one player cannot spend a once-each code twice', async () => {
    await saveDiscountCode({ code: 'ORDONCE', kind: 'amount', value: Math.floor(price / 2), usageLimit: 0, perUserLimit: 1 });
    const uid = await player(price * 3);
    const first = await payFromVault(uid, TICKET, 'ord-' + id(), 'ORDONCE');
    assert.ok(first.discount! > 0, 'the first use took nothing off');
    const after = await balance(uid);
    const second = await payFromVault(uid, TICKET, 'ord-' + id(), 'ORDONCE');
    assert.equal(second.discount, 0, 'the same player got the discount a second time');
    assert.equal(await balance(uid), after - price, 'and was charged the discounted price again');
  });

  await check('retrying the SAME order is not a second discount', async () => {
    /* A payment can be retried — a dropped connection, a tapped button. The
       retry must land on the same order, not buy a second ticket at half price
       and burn a second use. */
    await saveDiscountCode({ code: 'ORDIDEM', kind: 'amount', value: Math.floor(price / 2), usageLimit: 1, perUserLimit: 0 });
    const uid = await player(price * 2);
    const key = 'ord-' + id();
    const a = await payFromVault(uid, TICKET, key, 'ORDIDEM');
    const mid = await balance(uid);
    const b = await payFromVault(uid, TICKET, key, 'ORDIDEM');
    assert.equal(b.duplicate, true, 'the retry was treated as a new purchase');
    assert.equal(await balance(uid), mid, 'the retry charged the صندوق again');
    assert.equal(b.discount, a.discount, 'the retry reported a different discount');
  });

  await check('a use spent on an order that failed is handed back', async () => {
    /* A single-use code burned on a purchase that never happened is the
       player's loss, and they did nothing wrong. */
    await saveDiscountCode({ code: 'ORDBACK', kind: 'amount', value: Math.floor(price / 2), usageLimit: 1, perUserLimit: 0 });
    const poor = await player(1);                      /* cannot cover even the discounted price */
    let threw = false;
    try { await payFromVault(poor, TICKET, 'ord-' + id(), 'ORDBACK'); } catch { threw = true; }
    assert.ok(threw, 'a player with one rial was allowed to buy');
    const rich = await player(price);
    const q = await quoteDiscount({ code: 'ORDBACK', userId: rich, amount: price });
    assert.equal(q.ok, true, 'the code stayed burnt on an order that never happened: ' + String(q.message));
  });

  console.log(`[discountOrder] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
