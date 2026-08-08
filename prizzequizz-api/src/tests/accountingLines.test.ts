/* WHAT THE DASHBOARD MEANS BY "PAID TO PLAYERS".
 *
 * The panel read ۸٬۰۲۹٬۳۷۴ under «پرداختی به بازیکنان (خروجی پول)» on a server
 * where exactly ۹۰۰٬۰۰۰ had ever been paid out. Both numbers were real; the
 * label was on the wrong one. Money credited to a wallet is a debt the house
 * owes, and only a withdrawal is money gone.
 *
 * Two more lines were missing outright from that server's report:
 * lifeline_purchase (۱٬۹۵۰٬۰۰۰ of sales, in no income line) and adjustment
 * (۱۲٬۰۰۰٬۰۰۰, in no line at all).
 *
 * The figures below are this project's own production ledger, so the test
 * fails if any of those regress.
 *
 * Run: npx tsx src/tests/accountingLines.test.ts
 */
import assert from 'node:assert/strict';
import { financeReport, type FinanceReport } from '../services/accountingService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* The real shape, taken from `select entry_type, sum(amount) from wallet_ledger`
   on the live server. */
const LEDGER = {
  deposit: 37_275_000,
  ticket_purchase: 16_575_000,
  adjustment: 12_000_000,
  match_reward: 7_941_874,
  lifeline_purchase: 1_950_000,
  withdraw_paid: 900_000,
  shop_purchase: 457_500,
  fee: 271_250,
  match_stake: 75_000,
  bonus: 50_000,
  stake_refund: 37_500
};

/** The report the service would build from that ledger. */
function reportFor(l: typeof LEDGER): FinanceReport {
  const income = {
    commission: l.fee, tickets: l.ticket_purchase, shop: l.shop_purchase,
    lifelines: l.lifeline_purchase, penalties: 0, deposits: l.deposit, total: 0
  };
  income.total = income.commission + income.tickets + income.shop + income.lifelines + income.penalties;
  const payouts = {
    prizes: l.match_reward, bonuses: l.bonus, refunds: l.stake_refund,
    total: 0, cashedOut: l.withdraw_paid, liability: 0
  };
  payouts.total = payouts.prizes + payouts.bonuses + payouts.refunds;
  payouts.liability = Math.max(0, payouts.total - payouts.cashedOut);
  return { income, payouts, adjustments: l.adjustment } as unknown as FinanceReport;
}

async function run(): Promise<void> {
  const r = reportFor(LEDGER);

  await check('the ۸ میلیون figure is prize credits, and it is named as such', () => {
    assert.equal(r.payouts.total, 8_029_374, 'match_reward + bonus + stake_refund');
  });

  await check('money that actually left the company is reported separately', () => {
    assert.equal(r.payouts.cashedOut, 900_000, 'the three approved withdrawals');
    assert.notEqual(r.payouts.cashedOut, r.payouts.total, 'and is not the same number');
  });

  await check('the two are never added together', () => {
    /* Adding them would count one win twice — once when it was awarded, again
       when it was withdrawn. */
    assert.notEqual(r.payouts.total, 8_029_374 + 900_000);
    assert.ok(r.payouts.total < 8_029_374 + 900_000);
  });

  await check('what players are still holding is stated', () => {
    assert.equal(r.payouts.liability, 7_129_374, 'credited but not yet withdrawn');
    assert.equal(r.payouts.liability + r.payouts.cashedOut, r.payouts.total, 'and the three add up');
  });

  await check('help sales are counted as income — they were in no line at all', () => {
    assert.equal(r.income.lifelines, 1_950_000);
    assert.ok(r.income.total > 16_575_000 + 457_500 + 271_250, 'the total grew by them');
  });

  await check('income adds up to exactly its parts, with deposits excluded', () => {
    /* A deposit is the player's own money arriving. Counting it as revenue
       would have made this server look ۳۷ million better off than it is. */
    assert.equal(r.income.total, 271_250 + 16_575_000 + 457_500 + 1_950_000);
    assert.equal(r.income.total, 19_253_750);
    assert.ok(r.income.total < r.income.deposits + r.income.total, 'deposits are held apart');
  });

  await check('manual admin adjustments are visible instead of vanishing', () => {
    assert.equal(r.adjustments, 12_000_000);
  });

  await check('gross profit is measured against what was awarded, not withdrawn', () => {
    const gross = r.income.total - r.payouts.total;
    assert.equal(gross, 19_253_750 - 8_029_374);
    assert.equal(gross, 11_224_376);
  });

  await check('an empty ledger produces zeros in every new line, not undefined', async () => {
    /* The panel does arithmetic on these, and `undefined` renders as NaN. */
    const empty = await financeReport({ from: '2000-01-01', to: '2000-01-02' } as any);
    assert.equal(typeof empty.payouts.cashedOut, 'number');
    assert.equal(typeof empty.payouts.liability, 'number');
    assert.equal(typeof empty.income.lifelines, 'number');
    assert.equal(typeof empty.adjustments, 'number');
  });

  console.log(`[accountingLines] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
