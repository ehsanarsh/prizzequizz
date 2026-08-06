/* COMPANY ACCOUNTING — the money view of the business, not of a player.
 *
 * Income is read from the wallet ledger, which is the only place money moves,
 * so nothing here can drift from what players actually paid or were paid:
 *   • commission  — `fee` rows tied to a match, grouped by the mode that earned
 *                   them, so each game mode shows what it brings in
 *   • tickets     — ticket purchases
 *   • shop        — in-game item purchases
 *   • penalties   — fines
 * Payouts (prizes, bonuses, refunds) are subtracted to give gross profit, then
 * company expenses — recorded by hand plus the accrued server bill — are taken
 * off to give the net.
 *
 * Server cost is entered once as a price per hour per machine; the accrual is
 * computed from how long each machine has actually been registered, so the
 * figure keeps itself up to date with no monthly data entry. */
import { getPgPool } from '../database/postgres.js';
import { houseRevenueSummary, type HouseRevenueSummary } from './houseRevenueService.js';
import { id } from '../utils/id.js';

export type Granularity = 'day' | 'week' | 'month';

export interface ExpenseRow {
  id: string;
  title: string;
  category: string;
  amount: number;
  spentAt: string;      // ISO date
  note: string;
  createdAt: string;
}

export interface RevenueByMode { modeId: string; commission: number; matches: number }

export type { HouseRevenueSummary } from './houseRevenueService.js';

export interface FinanceReport {
  from: string; to: string; granularity: Granularity;
  income: { commission: number; tickets: number; shop: number; penalties: number; deposits: number; total: number };
  commissionByMode: RevenueByMode[];
  payouts: { prizes: number; bonuses: number; refunds: number; total: number };
  expenses: { manual: number; server: number; total: number; byCategory: Array<{ category: string; amount: number }> };
  grossProfit: number;
  netProfit: number;
  series: Array<{ bucket: string; income: number; payouts: number; expenses: number; net: number }>;
  serverCost: { hourlyTotal: number; machines: Array<{ name: string; hourly: number; hours: number; cost: number }> };
  hasDatabase: boolean;
  /** false → the shop has no purchase flow yet, so its income line is not "zero
   *  sales" but "not yet measurable". The panel says so instead of implying 0. */
  shopSalesTracked: boolean;
  /** Money the company kept that never passed through a player's wallet — a Last
   *  Survivor pot nobody won, the commission on such a pot.
   *
   *  NOT added to `income.total`, and that is deliberate. The money entered as
   *  ticket sales, which `income.tickets` already counts; because no payout ever
   *  left, it is already sitting inside `grossProfit`. Adding it again would
   *  report a profit that was never made. This is a breakdown OF the totals, so
   *  a forfeited pot can be pointed at per room instead of merely inferred. */
  houseRevenue: HouseRevenueSummary;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

/* Schema statements are run once and independently: one that cannot apply in a
 * given deployment (e.g. the ALTER when `monitor_servers` has not been created
 * yet) must not take the other four down with it, and must not make the whole
 * accounting tab fail. Each statement is tried on its own, the pass is marked
 * done either way, and any query that then hits a missing table degrades to an
 * empty figure rather than a 500. */
let _schemaReady = false;
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS company_expenses (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category VARCHAR(40) NOT NULL DEFAULT 'other',
    amount BIGINT NOT NULL CHECK (amount >= 0),
    spent_at DATE NOT NULL DEFAULT current_date,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_company_expenses_date ON company_expenses(spent_at DESC)`,
  // Price per hour for each monitored machine (0 = free / not billed).
  `ALTER TABLE monitor_servers ADD COLUMN IF NOT EXISTS hourly_cost BIGINT NOT NULL DEFAULT 0`,
  /* Item-sales log. The shop is catalog-only today — there is no buy endpoint —
   * so this stays empty and the "shop" income line reads zero until the purchase
   * flow is built. The table exists now so that flow has somewhere to write. */
  `CREATE TABLE IF NOT EXISTS shop_purchases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    price BIGINT NOT NULL CHECK (price >= 0),
    currency VARCHAR(12) NOT NULL DEFAULT 'cash',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_shop_purchases_time ON shop_purchases(created_at DESC)`
];

async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  _schemaReady = true;   // set first: the DDL is attempted once, never per request
  for (const sql of SCHEMA_SQL) {
    try { await pool.query(sql); } catch { /* not applicable here — the reader below copes */ }
  }
}

const memExpenses: ExpenseRow[] = [];

export const EXPENSE_CATEGORIES = ['server', 'salary', 'marketing', 'sms', 'gateway', 'tax', 'other'] as const;

function clampDate(v: unknown, fallback: string): string {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}
function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function daysAgoIso(n: number): string { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
export async function listExpenses(from?: string, to?: string, limit = 500): Promise<ExpenseRow[]> {
  const f = clampDate(from, daysAgoIso(365)), t = clampDate(to, todayIso());
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    try {
      const { rows } = await pool.query(
        `SELECT * FROM company_expenses WHERE spent_at BETWEEN $1 AND $2 ORDER BY spent_at DESC, created_at DESC LIMIT $3`, [f, t, limit]);
      return rows.map(expenseFromRow);
    } catch { return []; }   // no table yet → an empty list, not a broken tab
  }
  return memExpenses.filter((e) => e.spentAt >= f && e.spentAt <= t).slice(0, limit);
}

function expenseFromRow(r: any): ExpenseRow {
  return {
    id: String(r.id), title: r.title, category: r.category, amount: Number(r.amount),
    spentAt: r.spent_at?.toISOString?.().slice(0, 10) ?? String(r.spent_at).slice(0, 10),
    note: r.note ?? '', createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}

export async function saveExpense(input: { id?: string; title: string; category?: string; amount: number; spentAt?: string; note?: string }): Promise<ExpenseRow> {
  const row: ExpenseRow = {
    id: input.id || id(),
    title: String(input.title ?? '').trim().slice(0, 160) || 'هزینه',
    category: (EXPENSE_CATEGORIES as readonly string[]).includes(String(input.category)) ? String(input.category) : 'other',
    amount: Math.max(0, Math.round(Number(input.amount) || 0)),
    spentAt: clampDate(input.spentAt, todayIso()),
    note: String(input.note ?? '').slice(0, 500),
    createdAt: new Date().toISOString()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO company_expenses(id,title,category,amount,spent_at,note) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET title=$2, category=$3, amount=$4, spent_at=$5, note=$6`,
      [row.id, row.title, row.category, row.amount, row.spentAt, row.note]);
  } else {
    const i = memExpenses.findIndex((e) => e.id === row.id);
    if (i >= 0) memExpenses[i] = row; else memExpenses.unshift(row);
  }
  return row;
}

export async function deleteExpense(expenseId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM company_expenses WHERE id=$1`, [expenseId]);
    return (rowCount ?? 0) > 0;
  }
  const i = memExpenses.findIndex((e) => e.id === expenseId);
  if (i < 0) return false;
  memExpenses.splice(i, 1); return true;
}

// ---------------------------------------------------------------------------
// Server cost — entered per hour, accrued automatically
// ---------------------------------------------------------------------------
export async function setServerHourlyCost(serverId: string, hourly: number): Promise<void> {
  const pool = pg();
  if (!pool) { memHourly.set(serverId, Math.max(0, Math.round(Number(hourly) || 0))); return; }
  await ensureSchema(pool);
  await pool.query(`UPDATE monitor_servers SET hourly_cost=$2 WHERE id=$1`, [serverId, Math.max(0, Math.round(Number(hourly) || 0))]);
}
const memHourly = new Map<string, number>();

/** Cost accrued between two dates, from each machine's hourly price. */
async function serverCost(from: string, to: string): Promise<FinanceReport['serverCost']> {
  const pool = pg();
  const windowStart = new Date(from + 'T00:00:00Z').getTime();
  const windowEnd = Math.min(Date.now(), new Date(to + 'T23:59:59Z').getTime());
  if (!pool) return { hourlyTotal: [...memHourly.values()].reduce((a, b) => a + b, 0), machines: [] };
  await ensureSchema(pool);
  let rows: any[] = [];
  try {
    const r = await pool.query(`SELECT name, hourly_cost, created_at, enabled FROM monitor_servers`);
    rows = r.rows;
  } catch { return { hourlyTotal: 0, machines: [] }; }
  const machines = rows.map((r: any) => {
    const hourly = Number(r.hourly_cost) || 0;
    // Billed from whichever is later: the window start or the day it was added.
    const added = new Date(r.created_at).getTime();
    const start = Math.max(windowStart, Number.isFinite(added) ? added : windowStart);
    const hours = Math.max(0, (windowEnd - start) / 3600000);
    return { name: r.name as string, hourly, hours: Math.round(hours * 10) / 10, cost: Math.round(hours * hourly) };
  });
  return { hourlyTotal: machines.reduce((s, m) => s + m.hourly, 0), machines };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
const BUCKET_SQL: Record<Granularity, string> = {
  day: `to_char(date_trunc('day', created_at),'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week', created_at),'YYYY-"W"IW')`,
  month: `to_char(date_trunc('month', created_at),'YYYY-MM')`
};

export async function financeReport(opts: { from?: string; to?: string; granularity?: Granularity } = {}): Promise<FinanceReport> {
  const from = clampDate(opts.from, daysAgoIso(29));
  const to = clampDate(opts.to, todayIso());
  const granularity: Granularity = (['day', 'week', 'month'] as const).includes(opts.granularity as Granularity) ? opts.granularity as Granularity : 'day';
  const empty: FinanceReport = {
    from, to, granularity,
    income: { commission: 0, tickets: 0, shop: 0, penalties: 0, deposits: 0, total: 0 },
    commissionByMode: [], payouts: { prizes: 0, bonuses: 0, refunds: 0, total: 0 },
    expenses: { manual: 0, server: 0, total: 0, byCategory: [] },
    grossProfit: 0, netProfit: 0, series: [],
    serverCost: { hourlyTotal: 0, machines: [] }, hasDatabase: false, shopSalesTracked: false,
    houseRevenue: { total: 0, bySource: [], recent: [] }
  };
  const pool = pg();
  if (!pool) return { ...empty, houseRevenue: await houseRevenueSummary(from, to) };
  await ensureSchema(pool);
  const range = [from, to + ' 23:59:59'];

  try {
    const totalsQ = pool.query(
      `SELECT
         coalesce(sum(amount) FILTER (WHERE entry_type='fee'),0)::bigint            AS commission,
         coalesce(sum(amount) FILTER (WHERE entry_type='ticket_purchase'),0)::bigint AS tickets,
         coalesce(sum(amount) FILTER (WHERE entry_type='match_stake'),0)::bigint     AS stakes,
         coalesce(sum(amount) FILTER (WHERE entry_type='penalty'),0)::bigint         AS penalties,
         coalesce(sum(amount) FILTER (WHERE entry_type='deposit'),0)::bigint         AS deposits,
         coalesce(sum(amount) FILTER (WHERE entry_type IN ('match_reward','league_reward','referral_reward')),0)::bigint AS prizes,
         coalesce(sum(amount) FILTER (WHERE entry_type='bonus'),0)::bigint           AS bonuses,
         coalesce(sum(amount) FILTER (WHERE entry_type IN ('refund','stake_refund')),0)::bigint AS refunds
       FROM wallet_ledger WHERE created_at BETWEEN $1 AND $2`, range);

    // Commission per game mode: the fee row points at the match that produced it.
    const byModeQ = pool.query(
      `SELECT coalesce(m.mode_id,'other') AS mode,
              coalesce(sum(l.amount),0)::bigint AS commission,
              count(DISTINCT l.ref_id)::int AS matches
         FROM wallet_ledger l
         LEFT JOIN matches m ON m.id::text = l.ref_id
        WHERE l.entry_type='fee' AND l.ref_type='match' AND l.created_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY commission DESC`, range);

    /* In-game item sales: the shop's own purchase log PLUS lifeline purchases,
     * which go straight through the wallet ledger. Counting only the first
     * would leave help sales out of revenue entirely. */
    const shopQ = pool.query(
      `SELECT coalesce(sum(price),0)::bigint AS total, count(*)::int AS n FROM shop_purchases
        WHERE currency='cash' AND created_at BETWEEN $1 AND $2`, range).catch(() => ({ rows: [{ total: 0, n: 0 }] } as any));
    const lifelineSalesQ = pool.query(
      `SELECT coalesce(sum(amount),0)::bigint AS total, count(*)::int AS n FROM wallet_ledger
        WHERE entry_type='lifeline_purchase' AND created_at BETWEEN $1 AND $2`, range)
      .catch(() => ({ rows: [{ total: 0, n: 0 }] } as any));

    const expQ = pool.query(
      `SELECT category, coalesce(sum(amount),0)::bigint AS amount FROM company_expenses
        WHERE spent_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY amount DESC`, [from, to]);

    const seriesQ = pool.query(
      `SELECT ${BUCKET_SQL[granularity]} AS bucket,
              coalesce(sum(amount) FILTER (WHERE entry_type IN ('fee','ticket_purchase','lifeline_purchase','match_stake','penalty')),0)::bigint AS income,
              coalesce(sum(amount) FILTER (WHERE entry_type IN ('match_reward','league_reward','referral_reward','bonus','refund','stake_refund')),0)::bigint AS payouts
         FROM wallet_ledger WHERE created_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`, range);

    const expSeriesQ = pool.query(
      `SELECT to_char(date_trunc($3, spent_at), CASE $3 WHEN 'day' THEN 'YYYY-MM-DD' WHEN 'week' THEN 'YYYY-"W"IW' ELSE 'YYYY-MM' END) AS bucket,
              coalesce(sum(amount),0)::bigint AS amount
         FROM company_expenses WHERE spent_at BETWEEN $1 AND $2 GROUP BY 1`, [from, to, granularity]);

    const [totalsR, byModeR, shopR, lifelineSalesR, expR, seriesR, expSeriesR, srv, house] = await Promise.all([
      totalsQ, byModeQ, shopQ, lifelineSalesQ, expQ, seriesQ, expSeriesQ, serverCost(from, to),
      houseRevenueSummary(from, to)
    ]);

    const t = totalsR.rows[0] || {};
    const n = (v: any) => Number(v ?? 0) || 0;
    const shop = n(shopR.rows?.[0]?.total) + n(lifelineSalesR.rows?.[0]?.total);
    const shopTracked = (n(shopR.rows?.[0]?.n) + n(lifelineSalesR.rows?.[0]?.n)) > 0;
    const income = {
      commission: n(t.commission), tickets: n(t.tickets), shop, penalties: n(t.penalties),
      deposits: n(t.deposits), total: 0
    };
    // Deposits are the player's own money arriving — not revenue. Stakes are
    // returned as prizes, so they are not counted as income either; the house
    // earns the commission on them.
    income.total = income.commission + income.tickets + income.shop + income.penalties;

    const payouts = { prizes: n(t.prizes), bonuses: n(t.bonuses), refunds: n(t.refunds), total: 0 };
    payouts.total = payouts.prizes + payouts.bonuses + payouts.refunds;

    const byCategory = expR.rows.map((r: any) => ({ category: r.category, amount: n(r.amount) }));
    const manual = byCategory.reduce((s, e) => s + e.amount, 0);
    const serverAccrued = srv.machines.reduce((s, m) => s + m.cost, 0);
    const expenses = { manual, server: serverAccrued, total: manual + serverAccrued, byCategory };

    // Tickets already ARE the entry money; prizes are paid out of it. Gross
    // profit is what the house keeps before running costs.
    const grossProfit = income.total - payouts.total;

    const expByBucket = new Map<string, number>(expSeriesR.rows.map((r: any) => [String(r.bucket), n(r.amount)]));
    const buckets = new Set<string>([...seriesR.rows.map((r: any) => String(r.bucket)), ...expByBucket.keys()]);
    const series = [...buckets].sort().map((bucket) => {
      const row = seriesR.rows.find((r: any) => String(r.bucket) === bucket);
      const inc = n(row?.income), pay = n(row?.payouts), exp = expByBucket.get(bucket) ?? 0;
      return { bucket, income: inc, payouts: pay, expenses: exp, net: inc - pay - exp };
    });

    return {
      from, to, granularity, income, payouts, expenses,
      commissionByMode: byModeR.rows.map((r: any) => ({ modeId: String(r.mode), commission: n(r.commission), matches: n(r.matches) })),
      grossProfit, netProfit: grossProfit - expenses.total, series,
      serverCost: srv, hasDatabase: true, shopSalesTracked: shopTracked,
      houseRevenue: house
    };
  } catch {
    return { ...empty, hasDatabase: true };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
const FA_MODE: Record<string, string> = {
  duel: 'دوئل', lastSurvivor: 'آخرین بازمانده', allOrNothing: 'همه یا هیچ', weeklyLeague: 'لیگ هفتگی', other: 'سایر'
};
const FA_CAT: Record<string, string> = {
  server: 'سرور', salary: 'حقوق', marketing: 'بازاریابی', sms: 'پیامک', gateway: 'درگاه پرداخت', tax: 'مالیات', other: 'سایر'
};

/** Excel-friendly CSV. BOM first so Excel opens Persian text correctly. */
export function reportToCsv(r: FinanceReport): string {
  const rows: string[][] = [];
  rows.push(['گزارش مالی', `${r.from} تا ${r.to}`]);
  rows.push([]);
  rows.push(['درآمد', 'مبلغ (تومان)']);
  rows.push(['کارمزد مسابقات', String(r.income.commission)]);
  rows.push(['فروش بلیط', String(r.income.tickets)]);
  rows.push(['فروش آیتم فروشگاه', String(r.income.shop)]);
  rows.push(['جریمه‌ها', String(r.income.penalties)]);
  rows.push(['جمع درآمد', String(r.income.total)]);
  rows.push([]);
  rows.push(['کارمزد به تفکیک بازی', 'مبلغ', 'تعداد مسابقه']);
  for (const m of r.commissionByMode) rows.push([FA_MODE[m.modeId] ?? m.modeId, String(m.commission), String(m.matches)]);
  rows.push([]);
  rows.push(['پرداختی به بازیکنان', 'مبلغ']);
  rows.push(['جوایز', String(r.payouts.prizes)]);
  rows.push(['بونوس', String(r.payouts.bonuses)]);
  rows.push(['بازگشت وجه', String(r.payouts.refunds)]);
  rows.push(['جمع پرداختی', String(r.payouts.total)]);
  rows.push([]);
  rows.push(['هزینه‌ها', 'مبلغ']);
  for (const e of r.expenses.byCategory) rows.push([FA_CAT[e.category] ?? e.category, String(e.amount)]);
  rows.push(['هزینه سرور (محاسبه‌شده)', String(r.expenses.server)]);
  rows.push(['جمع هزینه', String(r.expenses.total)]);
  rows.push([]);
  rows.push(['سود ناخالص', String(r.grossProfit)]);
  rows.push(['سود خالص', String(r.netProfit)]);
  rows.push([]);
  rows.push(['دوره', 'درآمد', 'پرداختی', 'هزینه', 'خالص']);
  for (const s of r.series) rows.push([s.bucket, String(s.income), String(s.payouts), String(s.expenses), String(s.net)]);
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return '﻿' + rows.map((row) => row.map(esc).join(',')).join('\r\n');
}

/* A real, minimal PDF written by hand — no dependency, no binary to ship.
 * Persian glyphs need an embedded font, which a hand-rolled writer cannot do,
 * so the PDF carries the figures with Latin/なnumeric labels and the CSV export
 * is the one to use for full Persian text. */
export function reportToPdf(r: FinanceReport): Buffer {
  const lines: string[] = [];
  lines.push(`PrizzeQuizz - Financial Report`);
  lines.push(`Period: ${r.from} .. ${r.to}   (${r.granularity})`);
  lines.push('');
  lines.push('INCOME');
  lines.push(`  Match commission .......... ${r.income.commission.toLocaleString('en-US')}`);
  lines.push(`  Ticket sales .............. ${r.income.tickets.toLocaleString('en-US')}`);
  lines.push(`  Shop item sales ........... ${r.income.shop.toLocaleString('en-US')}`);
  lines.push(`  Penalties ................. ${r.income.penalties.toLocaleString('en-US')}`);
  lines.push(`  TOTAL ..................... ${r.income.total.toLocaleString('en-US')}`);
  lines.push('');
  lines.push('COMMISSION BY GAME MODE');
  for (const m of r.commissionByMode) lines.push(`  ${(m.modeId + ' ').padEnd(24, '.')} ${m.commission.toLocaleString('en-US')}  (${m.matches} matches)`);
  if (!r.commissionByMode.length) lines.push('  (none)');
  lines.push('');
  lines.push('PAYOUTS TO PLAYERS');
  lines.push(`  Prizes .................... ${r.payouts.prizes.toLocaleString('en-US')}`);
  lines.push(`  Bonuses ................... ${r.payouts.bonuses.toLocaleString('en-US')}`);
  lines.push(`  Refunds ................... ${r.payouts.refunds.toLocaleString('en-US')}`);
  lines.push(`  TOTAL ..................... ${r.payouts.total.toLocaleString('en-US')}`);
  lines.push('');
  lines.push('EXPENSES');
  for (const e of r.expenses.byCategory) lines.push(`  ${(e.category + ' ').padEnd(24, '.')} ${e.amount.toLocaleString('en-US')}`);
  lines.push(`  Server (accrued) .......... ${r.expenses.server.toLocaleString('en-US')}`);
  lines.push(`  TOTAL ..................... ${r.expenses.total.toLocaleString('en-US')}`);
  lines.push('');
  lines.push(`GROSS PROFIT ................ ${r.grossProfit.toLocaleString('en-US')}`);
  lines.push(`NET PROFIT .................. ${r.netProfit.toLocaleString('en-US')}`);
  lines.push('');
  lines.push('PERIOD BREAKDOWN');
  lines.push('  bucket        income      payouts     expenses    net');
  for (const s of r.series.slice(-40)) {
    lines.push(`  ${s.bucket.padEnd(12)}  ${String(s.income).padStart(10)}  ${String(s.payouts).padStart(10)}  ${String(s.expenses).padStart(10)}  ${String(s.net).padStart(10)}`);
  }
  return buildPdf(lines);
}

/** Lay text out over as many US-Letter pages as it needs. */
function buildPdf(lines: string[]): Buffer {
  const perPage = 58;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push(['(empty)']);

  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    .replace(/[^\x20-\x7E]/g, '?');   // the base font has no Persian glyphs

  const objects: string[] = [];
  const fontObj = 3 + pages.length * 2;      // after catalog, pages tree, each page + its stream
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((pl, i) => {
    const contentObj = 4 + i * 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`);
    const body = pl.map((l, k) => `BT /F1 10 Tf 40 ${740 - k * 12} Td (${escape(l)}) Tj ET`).join('\n');
    objects.push(`__STREAM__${body}`);
  });
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    if (o.startsWith('__STREAM__')) {
      const body = o.slice('__STREAM__'.length);
      out += `${i + 1} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`;
    } else {
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    }
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
