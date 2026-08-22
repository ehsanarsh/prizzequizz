/* HOUSE REVENUE — money the company keeps that never passes through a player's
 * wallet.
 *
 * Everything else the platform earns is already legible in the wallet ledger: a
 * commission is a `fee` row against the winner, a ticket sale is a
 * `ticket_purchase` debit. Those work because a real player is on the other side
 * of them, and `wallet_ledger.user_id` has a foreign key to `users` — there is
 * no house account to post against, by design.
 *
 * Last Survivor produced money with nobody on the other side. When the last
 * players all answer wrongly the room ends with no survivor, the pot is never
 * paid out, and until now nothing recorded what became of it. The money was not
 * lost — it entered as ticket sales and simply stayed with the company, so the
 * finance report's profit line was already right — but there was no record you
 * could point at, per room, saying so. That is what this table is.
 *
 * IMPORTANT for anyone extending the finance report: these amounts are NOT
 * additional income. The money is already counted once, as the ticket sales that
 * funded the pot. Adding it to the income total would count it twice and report
 * a profit the company never made. It is a breakdown of money already in the
 * totals, not a new source. */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export type HouseRevenueSource =
  | 'ls_forfeited_pot'    // room ended with no survivor — the remaining pot stays with the house
  | 'ls_rake'             // the configured commission on a Last Survivor pot
  /* MONEY THE GAME NEVER SEES. «سود ما از … تبلیغات … هست» — an advertising
   * payment arrives in a bank account, not through anybody's wallet, so there
   * is nothing in the ledger for it to be read off. It is typed in, and this is
   * where it lands so it sits beside the rest of what the company earned rather
   * than in a spreadsheet somewhere. */
  | 'ads';

export interface HouseRevenueRow {
  id: string;
  source: HouseRevenueSource;
  refType: string;
  refId: string;
  amount: number;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS house_revenue (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    ref_type TEXT NOT NULL DEFAULT '',
    ref_id TEXT NOT NULL DEFAULT '',
    amount BIGINT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  /* The id IS the idempotency key. A room can only be finished once, but the
   * worker retries on error and a restart can replay a tick, so a second
   * attempt must not book the same pot twice. */
  await pool.query(`CREATE INDEX IF NOT EXISTS house_revenue_at ON house_revenue(created_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS house_revenue_src ON house_revenue(source, created_at)`);
  _schemaReady = true;
}

const _mem: HouseRevenueRow[] = [];

/**
 * Book an amount to the company. `key` must be derived from what produced it
 * (room id, round) so a retry writes nothing new. Returns false when the amount
 * was zero or the entry already existed.
 */
export async function bookHouseRevenue(input: {
  key: string;
  source: HouseRevenueSource;
  amount: number;
  refType?: string;
  refId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const amount = Math.round(Number(input.amount) || 0);
  if (amount <= 0 || !input.key) return false;
  const row: HouseRevenueRow = {
    id: input.key, source: input.source,
    refType: input.refType ?? '', refId: input.refId ?? '',
    amount, description: input.description ?? '',
    metadata: input.metadata ?? {}, createdAt: new Date().toISOString()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(
      `INSERT INTO house_revenue(id,source,ref_type,ref_id,amount,description,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.source, row.refType, row.refId, row.amount, row.description, JSON.stringify(row.metadata)]);
    if (!rowCount) return false;
  } else {
    if (_mem.some((r) => r.id === row.id)) return false;
    _mem.push(row);
  }
  logger.info('house_revenue_booked', { source: row.source, amount, refId: row.refId });
  return true;
}

/** Remove one hand-entered row. Only ever the manual kinds: a rake or a
 *  forfeited pot is a record of something that really happened in a room, and
 *  deleting it would make the books disagree with the game. */
export async function removeHouseRevenue(rowId: string): Promise<boolean> {
  const key = String(rowId || '');
  if (!key) return false;
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(
      `DELETE FROM house_revenue WHERE id = $1 AND source = 'ads'`, [key]);
    return (rowCount ?? 0) > 0;
  }
  const i = _mem.findIndex((r) => r.id === key && r.source === 'ads');
  if (i < 0) return false;
  _mem.splice(i, 1);
  return true;
}

export interface HouseRevenueSummary {
  total: number;
  bySource: Array<{ source: string; amount: number; count: number }>;
  recent: HouseRevenueRow[];
}

/** What the company kept, over a date range, for the admin finance screen. */
export async function houseRevenueSummary(from?: string, to?: string, limit = 50): Promise<HouseRevenueSummary> {
  const pool = pg();
  if (!pool) {
    const rows = _mem.filter((r) => (!from || r.createdAt >= from) && (!to || r.createdAt <= to + 'T23:59:59.999Z'));
    const by = new Map<string, { amount: number; count: number }>();
    for (const r of rows) {
      const b = by.get(r.source) ?? { amount: 0, count: 0 };
      b.amount += r.amount; b.count += 1; by.set(r.source, b);
    }
    return {
      total: rows.reduce((s, r) => s + r.amount, 0),
      bySource: [...by.entries()].map(([source, b]) => ({ source, ...b })).sort((a, b) => b.amount - a.amount),
      recent: rows.slice(-limit).reverse()
    };
  }
  try {
    await ensureSchema(pool);
    const range: any[] = [from ?? '1970-01-01', (to ?? '2999-12-31') + ' 23:59:59'];
    const [agg, recent] = await Promise.all([
      pool.query(`SELECT source, coalesce(sum(amount),0)::bigint AS amount, count(*)::int AS n
                    FROM house_revenue WHERE created_at BETWEEN $1 AND $2
                   GROUP BY 1 ORDER BY amount DESC`, range),
      pool.query(`SELECT * FROM house_revenue WHERE created_at BETWEEN $1 AND $2
                   ORDER BY created_at DESC LIMIT $3`, [...range, limit])
    ]);
    const bySource = agg.rows.map((r: any) => ({ source: String(r.source), amount: Number(r.amount), count: Number(r.n) }));
    return {
      total: bySource.reduce((s, b) => s + b.amount, 0),
      bySource,
      recent: recent.rows.map((r: any) => ({
        id: String(r.id), source: r.source, refType: String(r.ref_type ?? ''), refId: String(r.ref_id ?? ''),
        amount: Number(r.amount), description: String(r.description ?? ''),
        metadata: r.metadata ?? {}, createdAt: new Date(r.created_at).toISOString()
      }))
    };
  } catch {
    return { total: 0, bySource: [], recent: [] };
  }
}

/** Test seam. */
export function _resetHouseRevenue(): void { _mem.length = 0; }
