/* WHAT THE COMPANY ACTUALLY EARNED.
 *
 *   «در پنل مدیریت سود رو بد حساب میکنه و در داشبورد اشتباه مینویسه. سود ما از
 *    درصد کمسیون بازی‌ها و تبلیغات و فروش آیتم‌ها در فروشگاه — به غیر از بلیط
 *    مسابقات — هست… و پات بدون برنده در آخرین بازمانده اونم باید جزیی از سود
 *    باشه… و همه این سودها باید به صورت مجزا نوشته بشه.»
 *
 * The old figure was a cash-flow one: everything that came in, minus everything
 * awarded. That counts ticket money as income and prize money as a cost, which
 * is a long way round to the commission — and wrong the moment a ticket is
 * bought in one month and played in the next.
 *
 * These tests are about the arithmetic of the breakdown, so they run against
 * the shape the report returns rather than a database. The database-backed
 * queries behind it are covered where a database exists.
 *
 * Run: REPOSITORY_DRIVER=memory npx tsx src/tests/earnings.test.ts
 */
import assert from 'node:assert';
import { bookHouseRevenue, houseRevenueSummary, removeHouseRevenue, _resetHouseRevenue } from '../services/houseRevenueService.js';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); }
};

/* ── 1. ADVERTISING INCOME, WHICH THE GAME NEVER SEES ─────────────────── */
{
  console.log('advertising money that arrives outside the game:');
  _resetHouseRevenue();
  const booked = await bookHouseRevenue({
    key: 'ads:1', source: 'ads', amount: 5_000_000,
    refType: 'manual', refId: '2026-08-01', description: 'تپسل — مرداد'
  });
  ok('an advertising payment can be recorded', booked === true, String(booked));

  const sum = await houseRevenueSummary();
  ok('and it shows up under its own name', sum.bySource.some((b) => b.source === 'ads' && b.amount === 5_000_000),
    JSON.stringify(sum.bySource));
  /* «همه این سودها باید به صورت مجزا نوشته بشه» — never merged with the rake. */
  await bookHouseRevenue({ key: 'rake:1', source: 'ls_rake', amount: 300_000, refType: 'ls_room', refId: 'r1' });
  const sum2 = await houseRevenueSummary();
  const ads = sum2.bySource.find((b) => b.source === 'ads')?.amount ?? 0;
  const rake = sum2.bySource.find((b) => b.source === 'ls_rake')?.amount ?? 0;
  ok('advertising and commission stay on separate lines', ads === 5_000_000 && rake === 300_000, ads + ' / ' + rake);
  ok('and the total is both of them', sum2.total === 5_300_000, String(sum2.total));

  /* It was typed, so it can be mistyped. */
  const gone = await removeHouseRevenue('ads:1');
  ok('a hand-entered row can be taken back out', gone === true, String(gone));
  const sum3 = await houseRevenueSummary();
  ok('and the total follows it', sum3.total === 300_000, String(sum3.total));

  /* But a rake or a forfeited pot is a record of something that happened in a
     real room — deleting it would make the books disagree with the game. */
  const refused = await removeHouseRevenue('rake:1');
  ok('a room’s own record cannot be deleted', refused === false, String(refused));
  ok('and it is still there', (await houseRevenueSummary()).total === 300_000, String((await houseRevenueSummary()).total));
}

/* ── 2. THE SAME PAYMENT ENTERED TWICE ────────────────────────────────── */
{
  console.log('\nentering the same payment twice:');
  _resetHouseRevenue();
  await bookHouseRevenue({ key: 'ads:same', source: 'ads', amount: 1_000_000 });
  const again = await bookHouseRevenue({ key: 'ads:same', source: 'ads', amount: 1_000_000 });
  ok('the second one is refused', again === false, String(again));
  ok('and the money is counted once', (await houseRevenueSummary()).total === 1_000_000,
    String((await houseRevenueSummary()).total));

  /* Two genuinely different payments on the same day must both land, which is
     why the route builds a fresh key per entry rather than hashing the fields. */
  await bookHouseRevenue({ key: 'ads:a', source: 'ads', amount: 400_000, refId: '2026-08-02' });
  await bookHouseRevenue({ key: 'ads:b', source: 'ads', amount: 600_000, refId: '2026-08-02' });
  ok('two separate payments on one day both count', (await houseRevenueSummary()).total === 2_000_000,
    String((await houseRevenueSummary()).total));
}

/* ── 3. A ZERO OR NEGATIVE AMOUNT IS NOT INCOME ───────────────────────── */
{
  console.log('\namounts that are not money:');
  _resetHouseRevenue();
  ok('zero is refused', (await bookHouseRevenue({ key: 'z', source: 'ads', amount: 0 })) === false);
  ok('and so is a negative amount', (await bookHouseRevenue({ key: 'n', source: 'ads', amount: -5000 })) === false);
  ok('nothing was recorded', (await houseRevenueSummary()).total === 0, String((await houseRevenueSummary()).total));
}

/* ── 4. THE BREAKDOWN ADDS UP ─────────────────────────────────────────── */
/* The rule, stated as arithmetic: earnings are the named sources and nothing
 * else. Ticket money and the prizes paid out of it are reported beside them and
 * never inside them. */
{
  console.log('\nthe earnings total:');
  const e = {
    commission: 1_000_000,   // duel + همه یا هیچ + لیگ
    lsRake: 500_000,         // آخرین بازمانده
    forfeitedPot: 250_000,   // پات بدون برنده
    shopItems: 300_000,      // آیتم‌های فروشگاه، بدون بلیط
    coins: 200_000,          // پک سکه
    lifelines: 150_000,      // کمک‌ها
    ads: 2_000_000,          // تبلیغات
    penalties: 50_000,
    ticketsExcluded: 9_000_000,
    prizesExcluded: 8_100_000
  };
  const total = e.commission + e.lsRake + e.forfeitedPot + e.shopItems + e.coins + e.lifelines + e.ads + e.penalties;
  ok('it is the sum of the named sources', total === 4_450_000, String(total));
  /* The point of the change: nine million of ticket money moving through does
     not make the company nine million richer. */
  ok('ticket money is not in it', total < e.ticketsExcluded, total + ' vs ' + e.ticketsExcluded);
  const oldWay = (e.commission + e.ticketsExcluded + e.shopItems + e.coins + e.lifelines + e.penalties) - e.prizesExcluded;
  ok('and it differs from the old cash-flow figure', oldWay !== total, oldWay + ' vs ' + total);
  /* THREE OF THE SOURCES NEVER PASS THROUGH A PLAYER'S WALLET. Last Survivor's
     commission and its forfeited pots are booked straight to the house, and an
     advertising payment never touches the game at all — so a figure computed
     only from the wallet ledger cannot contain any of them, however it is
     arranged. That is the other half of «سود رو بد حساب میکنه». */
  const invisible = e.lsRake + e.forfeitedPot + e.ads;
  ok('three sources never reach the wallet ledger', invisible === 2_750_000, String(invisible));
  const ledgerVisible = e.commission + e.shopItems + e.coins + e.lifelines + e.penalties;
  ok('and the earnings figure is exactly those plus the ones that do',
    total === ledgerVisible + invisible, total + ' = ' + ledgerVisible + ' + ' + invisible);
}

/* ── 5. THE REPORT REALLY CARRIES THE BREAKDOWN ───────────────────────── */
/* Arithmetic on a literal proves the rule; this proves the report speaks it.
 * With no database there are no figures, but the shape must still be there —
 * a panel reading `earnings.ads` cannot be left with undefined. */
{
  console.log('\nthe report’s own shape:');
  const { financeReport } = await import('../services/accountingService.js');
  const r = await financeReport({});
  const e = (r as any).earnings;
  ok('the report has an earnings block', !!e, JSON.stringify(e ?? null));
  const lines = ['commission', 'lsRake', 'forfeitedPot', 'shopItems', 'coins', 'lifelines', 'ads', 'penalties'];
  const missing = lines.filter((k) => typeof e?.[k] !== 'number');
  ok('with every source named separately', missing.length === 0, missing.join(',') || lines.join(','));
  ok('and a total and a net', typeof e?.total === 'number' && typeof e?.net === 'number', JSON.stringify({ t: e?.total, n: e?.net }));
  /* Reported, but never added in. */
  ok('ticket money is carried as excluded, not as income',
    typeof e?.ticketsExcluded === 'number' && typeof e?.prizesExcluded === 'number',
    JSON.stringify({ t: e?.ticketsExcluded, p: e?.prizesExcluded }));
  ok('and the total of an empty period is zero, not undefined', e?.total === 0, String(e?.total));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
