/* TAKING A PRIZE AS SOMETHING OTHER THAN CASH.
 *
 * A player who has won money can ask for it as a bank transfer, or as credit
 * with a company the game has an arrangement with — a طلاسی or اسنپ code they
 * redeem there. Same prize, same amount, different door out.
 *
 * There is no API to call. Until a partner offers one, the only honest way to
 * do this is a STOCK of codes the operator loads in the panel, handed out one
 * at a time and marked used. That is what this is, and it is built so the
 * shape does not have to change when a real integration arrives: `reserve` and
 * `issue` are the two moments an API would slot into.
 *
 * The part that has to be right is the race. Two players asking for the last
 * ۵۰۰٬۰۰۰ code at the same instant must not both be promised it, and a player
 * whose withdrawal is rejected must give the code back to the shelf. So a code
 * is RESERVED when the request is filed — before the player is told yes — and
 * only ISSUED when the payout is actually made.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export interface PayoutPartner {
  id: string;
  name: string;
  /** Shown in the picker. A URL the panel uploaded, or empty. */
  logo?: string;
  enabled: boolean;
  /** The amounts this partner has codes for, e.g. [100000, 200000, 500000]. */
  denominations: number[];
  /** «کد را در اپلیکیشن اسنپ، بخش کیف پول وارد کن» — shown with the code. */
  instructions?: string;
  createdAt: string;
}

export type PayoutCodeStatus = 'available' | 'reserved' | 'issued' | 'void';

export interface PayoutCode {
  id: string;
  partnerId: string;
  amount: number;
  code: string;
  status: PayoutCodeStatus;
  userId?: string;
  withdrawId?: string;
  reservedAt?: string;
  issuedAt?: string;
  createdAt: string;
}

export class PayoutError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'PayoutError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS payout_partners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    logo TEXT,
    enabled BOOLEAN NOT NULL DEFAULT true,
    denominations JSONB NOT NULL DEFAULT '[]',
    instructions TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS payout_codes (
    id TEXT PRIMARY KEY,
    partner_id TEXT NOT NULL,
    amount BIGINT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    user_id TEXT,
    withdraw_id TEXT,
    reserved_at TIMESTAMPTZ,
    issued_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  /* The same code must never be loaded twice for one partner — a duplicate is
   * two players being given the same credit. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_codes_unique ON payout_codes(partner_id, code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payout_codes_pick ON payout_codes(partner_id, amount, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payout_codes_withdraw ON payout_codes(withdraw_id)`);
  _schemaReady = true;
}

/* Memory fallback so the whole flow works without Postgres. */
const memPartners: PayoutPartner[] = [];
const memCodes: PayoutCode[] = [];

/** Test seam. */
export function _resetPayouts(): void { memPartners.length = 0; memCodes.length = 0; _schemaReady = false; }

function cleanDenoms(raw: unknown): number[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out = arr.map((n) => Math.round(Number(n) || 0)).filter((n) => n > 0);
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function partnerFromRow(r: any): PayoutPartner {
  return {
    id: String(r.id), name: r.name, logo: r.logo ?? undefined, enabled: r.enabled !== false,
    denominations: cleanDenoms(r.denominations), instructions: r.instructions ?? undefined,
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}
function codeFromRow(r: any): PayoutCode {
  return {
    id: String(r.id), partnerId: String(r.partner_id), amount: Number(r.amount), code: r.code,
    status: r.status, userId: r.user_id ?? undefined, withdrawId: r.withdraw_id ?? undefined,
    reservedAt: r.reserved_at?.toISOString?.() ?? r.reserved_at ?? undefined,
    issuedAt: r.issued_at?.toISOString?.() ?? r.issued_at ?? undefined,
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}

/* ---------------------------------------------------------------------------
 * Partners
 * ------------------------------------------------------------------------- */

export async function listPartners(opts: { includeDisabled?: boolean } = {}): Promise<PayoutPartner[]> {
  const pool = pg();
  let rows: PayoutPartner[];
  if (pool) {
    await ensureSchema(pool);
    const r = await pool.query('SELECT * FROM payout_partners ORDER BY name');
    rows = r.rows.map(partnerFromRow);
  } else {
    rows = [...memPartners].sort((a, b) => a.name.localeCompare(b.name));
  }
  return opts.includeDisabled ? rows : rows.filter((p) => p.enabled);
}

export async function getPartner(partnerId: string): Promise<PayoutPartner | null> {
  return (await listPartners({ includeDisabled: true })).find((p) => p.id === partnerId) ?? null;
}

export async function savePartner(input: Partial<PayoutPartner> & { name: string }): Promise<PayoutPartner> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new PayoutError('PARTNER_NAME_REQUIRED', 'نام شریک لازم است.');
  const existing = input.id ? await getPartner(input.id) : null;
  const row: PayoutPartner = {
    id: existing?.id ?? input.id ?? id(),
    name,
    logo: input.logo ?? existing?.logo,
    enabled: input.enabled ?? existing?.enabled ?? true,
    denominations: input.denominations !== undefined ? cleanDenoms(input.denominations) : (existing?.denominations ?? []),
    instructions: input.instructions ?? existing?.instructions,
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO payout_partners(id,name,logo,enabled,denominations,instructions,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, logo=$3, enabled=$4, denominations=$5, instructions=$6`,
      [row.id, row.name, row.logo ?? null, row.enabled, JSON.stringify(row.denominations), row.instructions ?? null, row.createdAt]);
  } else {
    const i = memPartners.findIndex((p) => p.id === row.id);
    if (i >= 0) memPartners[i] = row; else memPartners.push(row);
  }
  return row;
}

export async function removePartner(partnerId: string): Promise<boolean> {
  /* Codes already given to players are kept: they are a record of a payout
   * that happened, and deleting them would erase it. Only unused stock goes. */
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`DELETE FROM payout_codes WHERE partner_id=$1 AND status='available'`, [partnerId]);
    const { rowCount } = await pool.query('DELETE FROM payout_partners WHERE id=$1', [partnerId]);
    return (rowCount ?? 0) > 0;
  }
  for (let i = memCodes.length - 1; i >= 0; i--) if (memCodes[i]!.partnerId === partnerId && memCodes[i]!.status === 'available') memCodes.splice(i, 1);
  const i = memPartners.findIndex((p) => p.id === partnerId);
  if (i < 0) return false;
  memPartners.splice(i, 1);
  return true;
}

/* ---------------------------------------------------------------------------
 * Stock
 * ------------------------------------------------------------------------- */

export async function addCodes(partnerId: string, amount: number, codes: string[]): Promise<{ added: number; skipped: number }> {
  const partner = await getPartner(partnerId);
  if (!partner) throw new PayoutError('PARTNER_NOT_FOUND', 'شریک پیدا نشد.');
  const amt = Math.round(Number(amount) || 0);
  if (amt <= 0) throw new PayoutError('AMOUNT_INVALID', 'مبلغ کد نامعتبر است.');
  const clean = Array.from(new Set(codes.map((c) => String(c ?? '').trim()).filter(Boolean)));
  let added = 0, skipped = 0;
  const pool = pg();
  if (pool) await ensureSchema(pool);
  for (const code of clean) {
    if (pool) {
      /* ON CONFLICT DO NOTHING is what makes re-uploading the same file safe —
       * an operator pasting a list twice must not double the stock. */
      const { rowCount } = await pool.query(
        `INSERT INTO payout_codes(id,partner_id,amount,code,status) VALUES ($1,$2,$3,$4,'available')
         ON CONFLICT (partner_id, code) DO NOTHING`, [id(), partnerId, amt, code]);
      if ((rowCount ?? 0) > 0) added++; else skipped++;
    } else {
      if (memCodes.some((c) => c.partnerId === partnerId && c.code === code)) { skipped++; continue; }
      memCodes.push({ id: id(), partnerId, amount: amt, code, status: 'available', createdAt: new Date().toISOString() });
      added++;
    }
  }
  /* A denomination with stock but not listed on the partner would be invisible
   * to players, which is a silent way to strand codes. */
  if (added > 0 && !partner.denominations.includes(amt)) {
    await savePartner({ ...partner, denominations: [...partner.denominations, amt] });
  }
  logger.info('payout_codes_added', { partnerId, amount: amt, added, skipped });
  return { added, skipped };
}

/** How many unused codes exist, per amount. */
export async function stock(partnerId: string): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT amount, count(*)::int c FROM payout_codes WHERE partner_id=$1 AND status='available' GROUP BY amount`, [partnerId]);
    for (const r of rows) out[Number(r.amount)] = Number(r.c);
    return out;
  }
  for (const c of memCodes) if (c.partnerId === partnerId && c.status === 'available') out[c.amount] = (out[c.amount] ?? 0) + 1;
  return out;
}

/** The picker a player sees: partners, their amounts, and what is really in stock. */
export async function payoutOptions(): Promise<Array<{ id: string; name: string; logo?: string; instructions?: string; amounts: Array<{ amount: number; available: number }> }>> {
  const partners = await listPartners();
  const out = [];
  for (const p of partners) {
    const s = await stock(p.id);
    const amounts = p.denominations.map((a) => ({ amount: a, available: s[a] ?? 0 })).filter((a) => a.available > 0);
    /* A partner with nothing on the shelf is not an option, however enabled it
     * is — offering it would be promising something we cannot hand over. */
    if (amounts.length) out.push({ id: p.id, name: p.name, logo: p.logo, instructions: p.instructions, amounts });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Reserve → issue, or reserve → release.
 * ------------------------------------------------------------------------- */

/** Claim one code for this withdrawal. Exactly one caller can win any code. */
export async function reserveCode(input: { partnerId: string; amount: number; userId: string; withdrawId: string }): Promise<PayoutCode> {
  const partner = await getPartner(input.partnerId);
  if (!partner) throw new PayoutError('PARTNER_NOT_FOUND', 'شریک پیدا نشد.');
  if (!partner.enabled) throw new PayoutError('PARTNER_DISABLED', 'این شریک فعلاً فعال نیست.');
  const amt = Math.round(Number(input.amount) || 0);
  if (!partner.denominations.includes(amt)) throw new PayoutError('AMOUNT_NOT_OFFERED', 'این مبلغ برای این شریک تعریف نشده است.');

  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    /* FOR UPDATE SKIP LOCKED is the whole race: two requests for the last two
     * codes take one each instead of fighting over the same row. */
    const { rows } = await pool.query(
      `UPDATE payout_codes SET status='reserved', user_id=$3, withdraw_id=$4, reserved_at=now()
       WHERE id = (SELECT id FROM payout_codes WHERE partner_id=$1 AND amount=$2 AND status='available'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`, [input.partnerId, amt, input.userId, input.withdrawId]);
    if (!rows[0]) throw new PayoutError('OUT_OF_STOCK', 'کد این مبلغ تمام شده است. مبلغ یا شریک دیگری انتخاب کن.');
    return codeFromRow(rows[0]);
  }
  const free = memCodes.find((c) => c.partnerId === input.partnerId && c.amount === amt && c.status === 'available');
  if (!free) throw new PayoutError('OUT_OF_STOCK', 'کد این مبلغ تمام شده است. مبلغ یا شریک دیگری انتخاب کن.');
  free.status = 'reserved'; free.userId = input.userId; free.withdrawId = input.withdrawId; free.reservedAt = new Date().toISOString();
  return { ...free };
}

/** The payout happened: the code is now the player's. */
export async function issueForWithdraw(withdrawId: string): Promise<PayoutCode | null> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `UPDATE payout_codes SET status='issued', issued_at=now() WHERE withdraw_id=$1 AND status='reserved' RETURNING *`, [withdrawId]);
    if (rows[0]) return codeFromRow(rows[0]);
    /* Already issued — a repeated 'paid' transition must return the same code
     * rather than nothing, or the player loses sight of what they were given. */
    const again = await pool.query(`SELECT * FROM payout_codes WHERE withdraw_id=$1 AND status='issued' LIMIT 1`, [withdrawId]);
    return again.rows[0] ? codeFromRow(again.rows[0]) : null;
  }
  const c = memCodes.find((x) => x.withdrawId === withdrawId && (x.status === 'reserved' || x.status === 'issued'));
  if (!c) return null;
  if (c.status === 'reserved') { c.status = 'issued'; c.issuedAt = new Date().toISOString(); }
  return { ...c };
}

/** The withdrawal was rejected or failed: put the code back on the shelf. */
export async function releaseForWithdraw(withdrawId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(
      `UPDATE payout_codes SET status='available', user_id=NULL, withdraw_id=NULL, reserved_at=NULL
       WHERE withdraw_id=$1 AND status='reserved'`, [withdrawId]);
    return (rowCount ?? 0) > 0;
  }
  const c = memCodes.find((x) => x.withdrawId === withdrawId && x.status === 'reserved');
  if (!c) return false;
  c.status = 'available'; c.userId = undefined; c.withdrawId = undefined; c.reservedAt = undefined;
  return true;
}

/** What the player is shown once it is theirs. Never reveals a reserved code. */
export async function issuedCodeFor(withdrawId: string, userId: string): Promise<PayoutCode | null> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM payout_codes WHERE withdraw_id=$1 AND user_id=$2 AND status='issued' LIMIT 1`, [withdrawId, userId]);
    return rows[0] ? codeFromRow(rows[0]) : null;
  }
  const c = memCodes.find((x) => x.withdrawId === withdrawId && x.userId === userId && x.status === 'issued');
  return c ? { ...c } : null;
}

/** Operator view of the shelf. */
export async function listCodes(filter: { partnerId?: string; status?: PayoutCodeStatus; limit?: number } = {}): Promise<PayoutCode[]> {
  const limit = Math.min(500, Math.max(1, Number(filter.limit) || 200));
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const conds: string[] = []; const args: unknown[] = [];
    if (filter.partnerId) { args.push(filter.partnerId); conds.push(`partner_id=$${args.length}`); }
    if (filter.status) { args.push(filter.status); conds.push(`status=$${args.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM payout_codes ${where} ORDER BY created_at DESC LIMIT ${limit}`, args);
    return rows.map(codeFromRow);
  }
  return memCodes
    .filter((c) => (!filter.partnerId || c.partnerId === filter.partnerId) && (!filter.status || c.status === filter.status))
    .slice(-limit).reverse();
}
