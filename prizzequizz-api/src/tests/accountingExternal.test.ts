/* MONEY THAT ARRIVES WHERE THE LEDGER CANNOT SEE IT.
 *
 * Every income line in the finance report is read from `wallet_ledger`. An
 * order paid at a gateway — or by card-to-card — writes nothing there, and
 * that is deliberate: the money belongs to the house, and crediting the
 * player's صندوق with it would let a purchase be laundered into a withdrawable
 * prize. The cost of that decision went unnoticed: every such sale has been
 * reported as zero income since the day the gateway path was built.
 *
 * The same mistake has happened here once before. `accountingService` still
 * carries the note about it: the shop's takings were read from a table nothing
 * wrote to, so «فروش ثبت نشده» was shown while money was coming in.
 *
 * What must be true:
 *
 *   - a sale paid outside the صندوق reaches the income lines
 *   - a sale paid FROM the صندوق is not counted a second time
 *   - only delivered cash sales count — not pending, void, or coin purchases
 *   - the tickets shelf stays entry money, wherever it was paid
 *   - `wallet_ledger` is not touched to make any of this work
 *
 * Run: npx tsx src/tests/accountingExternal.test.ts
 *      (add DATABASE_URL to also check the finance report itself)
 */
import assert from 'node:assert/strict';
import {
  claim, complete, voidRef, externalSalesSummary, saleLine
} from '../services/orderFulfilmentService.js';
import { fulfil, payFromVault } from '../services/purchaseOrderService.js';
import { financeReport } from '../services/accountingService.js';
import { postEntry, listEntries } from '../services/walletLedgerService.js';
import { getTicketPrices } from '../services/economyConfig.js';
import { saveItem, removeItem } from '../services/shopService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

const HAS_DB = !!process.env.DATABASE_URL;

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(prize = 0): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'ax' + uid.slice(0, 8), displayName: 'ax',
    phone: '09' + String(400000000 + Math.floor(Math.random() * 99999999)),
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

/** A delivered sale, written straight to the record. */
async function sale(opts: {
  source: 'vault' | 'gateway' | 'card_to_card'; kind: string; category: string;
  amountToman: number; currency?: 'cash' | 'coins'; deliver?: boolean; voidIt?: boolean;
}): Promise<string> {
  const ref = 'sale:' + id();
  const uid = await player();
  await claim({ ref, userId: uid, source: opts.source, kind: opts.kind });
  if (opts.voidIt) { await voidRef(ref, 'test'); return ref; }
  if (opts.deliver === false) return ref;
  await complete(ref, {
    payload: [], amountToman: opts.amountToman,
    currency: opts.currency ?? 'cash', category: opts.category
  });
  return ref;
}

/* Scope every assertion to a window that opens just before the sale it is
 * about. `_resetFulfilments()` clears the in-memory driver only, so against a
 * real database the totals would otherwise carry over from the test before —
 * which is exactly how a green suite hides a broken filter. */
async function since<T>(fn: () => Promise<T>): Promise<{ result: T; sales: Awaited<ReturnType<typeof externalSalesSummary>> }> {
  /* A guard band on BOTH sides of t0. The window is inclusive (`delivered_at >=
   * from`), and ISO timestamps only go to the millisecond — so a row written by
   * the previous test in the same millisecond as t0 would be counted here. That
   * is a flake, and a flake in a test about double-counting money is worse than
   * no test at all. */
  await new Promise((r) => setTimeout(r, 5));
  const t0 = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  const result = await fn();
  return { result, sales: await externalSalesSummary(t0) };
}

async function run(): Promise<void> {
  /* ── which rows are income at all ─────────────────────────────────── */

  await check('a card-to-card sale is income', async () => {
    const { sales } = await since(() => sale({ source: 'card_to_card', kind: 'shop', category: 'hearts', amountToman: 80_000 }));
    assert.equal(sales.total, 80_000);
    assert.equal(sales.shop, 80_000);
    assert.equal(sales.bySource[0]!.source, 'card_to_card');
  });

  await check('a صندوق purchase is NOT — the ledger already counted it', async () => {
    const { sales } = await since(() => sale({ source: 'vault', kind: 'shop', category: 'hearts', amountToman: 80_000 }));
    assert.equal(sales.total, 0, 'counting it here would double every صندوق purchase');
  });

  await check('an undelivered or voided sale is not income', async () => {
    const { sales } = await since(async () => {
      await sale({ source: 'gateway', kind: 'shop', category: 'hearts', amountToman: 50_000, deliver: false });
      await sale({ source: 'gateway', kind: 'shop', category: 'hearts', amountToman: 50_000, voidIt: true });
    });
    assert.equal(sales.total, 0, 'money owed or refunded is not money earned');
  });

  await check('a coin purchase is not cash income', async () => {
    const { sales } = await since(() => sale({ source: 'gateway', kind: 'shop', category: 'skins', amountToman: 0, currency: 'coins' }));
    assert.equal(sales.total, 0, 'no real money arrived');
  });

  /* ── which line each sale lands on ────────────────────────────────── */

  await check('the tickets shelf is entry money wherever it was paid', async () => {
    assert.equal(saleLine('ticket', ''), 'tickets', 'a ticket order');
    assert.equal(saleLine('shop', 'tickets'), 'tickets', 'and a ticket sold from the shop');
    assert.equal(saleLine('shop', 'coins'), 'coins');
    assert.equal(saleLine('shop', 'hearts'), 'shop');
    assert.equal(saleLine('shop', ''), 'shop', 'an uncategorised sale is not silently folded into tickets');
  });

  await check('the three lines are kept apart', async () => {
    const { sales } = await since(async () => {
      await sale({ source: 'card_to_card', kind: 'ticket', category: 'tickets', amountToman: 60_000 });
      await sale({ source: 'card_to_card', kind: 'shop', category: 'coins', amountToman: 30_000 });
      await sale({ source: 'gateway', kind: 'shop', category: 'hearts', amountToman: 10_000 });
    });
    assert.deepEqual(
      { tickets: sales.tickets, coins: sales.coins, shop: sales.shop, total: sales.total, count: sales.count },
      { tickets: 60_000, coins: 30_000, shop: 10_000, total: 100_000, count: 3 });
    assert.equal(sales.bySource.length, 2, 'and each channel is reported on its own');
  });

  await check('the window filters by when the goods were handed over', async () => {
    await sale({ source: 'card_to_card', kind: 'shop', category: 'hearts', amountToman: 70_000 });
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await externalSalesSummary(future)).total, 0, 'a window that starts tomorrow sees nothing');
  });

  await check('a real card-to-card fulfilment lands on the record as income', async () => {
    const { sales } = await since(async () => {
      const uid = await player();
      await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 5 }, 'intent:' + id(),
        { source: 'card_to_card', amountToman: PRICE * 5 });
    });
    assert.equal(sales.tickets, PRICE * 5, 'the whole path, not just the primitive');
  });

  await check('and it does it WITHOUT touching the صندوق', async () => {
    const uid = await player();
    await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 2 }, 'intent:' + id(),
      { source: 'card_to_card', amountToman: PRICE * 2 });
    const rows = await listEntries(uid, { pageSize: 50 });
    assert.equal(rows.rows.length, 0,
      'money paid outside must never appear in the player ledger — that is the whole point');
  });

  /* ── the report itself (needs a database) ─────────────────────────── */

  if (!HAS_DB) {
    console.log('  … finance-report checks skipped (no DATABASE_URL)');
  } else {
    await check('the finance report picks the sale up', async () => {
      const before = await financeReport();
      assert.equal(before.hasDatabase, true, 'the report must really be reading the database');
      const uid = await player();
      await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 4 }, 'intent:' + id(),
        { source: 'card_to_card', amountToman: PRICE * 4 });
      const after = await financeReport();
      assert.equal(after.income.tickets - before.income.tickets, PRICE * 4, 'income.tickets');
      assert.equal(after.externalSales.tickets - before.externalSales.tickets, PRICE * 4, 'and the breakdown agrees');
      assert.equal(after.earnings.ticketsExcluded - before.earnings.ticketsExcluded, PRICE * 4,
        'ticket money is reported but never counted as earnings');
      assert.equal(after.earnings.total, before.earnings.total, 'so earnings must not move');
    });

    await check('a non-ticket sale paid outside DOES become earnings', async () => {
      const before = await financeReport();
      const item = await saveItem({ name: 'پک تست جان', category: 'hearts', price: 90_000, currency: 'cash', effectKey: 'heart', effectValue: 5, enabled: true });
      const uid = await player();
      await fulfil(uid, { kind: 'shop', itemId: item.id, qty: 1 }, 'intent:' + id(),
        { source: 'card_to_card', amountToman: 90_000 });
      const after = await financeReport();
      assert.equal(after.earnings.shopItems - before.earnings.shopItems, 90_000, 'earnings.shopItems');
      assert.equal(after.earnings.total - before.earnings.total, 90_000, 'and the earnings total');
      assert.equal(after.income.shop - before.income.shop, 90_000, 'income.shop');
      await removeItem(item.id);
    });

    await check('a صندوق purchase is counted exactly once', async () => {
      const before = await financeReport();
      const uid = await player(PRICE * 3);
      await payFromVault(uid, { kind: 'ticket', tier: TIER, qty: 1 }, 'o:' + id());
      const after = await financeReport();
      assert.equal(after.income.tickets - before.income.tickets, PRICE,
        'the ledger counts it; the fulfilment record must not count it again');
      assert.equal(after.externalSales.total, before.externalSales.total, 'and it is not an external sale');
    });

    await check('externalSales is a breakdown, not an extra line', async () => {
      const r = await financeReport();
      assert.equal(
        r.income.total,
        r.income.commission + r.income.tickets + r.income.shop + r.income.lifelines + r.income.penalties,
        'income.total must stay the sum of its own lines');
      assert.ok(r.externalSales.total <= r.income.tickets + r.income.shop,
        'every external toman is already inside those lines');
    });

    await check('the chart shows it too', async () => {
      const before = await financeReport();
      const bucket = new Date().toISOString().slice(0, 10);
      const beforeInc = before.series.find((s) => s.bucket === bucket)?.income ?? 0;
      const uid = await player();
      await fulfil(uid, { kind: 'ticket', tier: TIER, qty: 6 }, 'intent:' + id(),
        { source: 'card_to_card', amountToman: PRICE * 6 });
      const after = await financeReport();
      const afterInc = after.series.find((s) => s.bucket === bucket)?.income ?? 0;
      assert.equal(afterInc - beforeInc, PRICE * 6, 'a sale missing from the chart is a sale nobody sees');
    });
  }

  console.log(`[accountingExternal] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
