/* Ledger-based wallet engine — the single money authority of the API.
 *
 * Rules enforced here (and nowhere else):
 *  - Every balance change is an immutable wallet_ledger row (never updated/deleted).
 *  - wallet_accounts is a materialized balance maintained in the SAME db
 *    transaction as the ledger insert; available/locked can never go negative.
 *  - Concurrency safety: SELECT ... FOR UPDATE row lock per user account, so
 *    parallel spends serialize and can never double-spend (pg driver), plus a
 *    per-user promise mutex for the in-memory dev driver.
 *  - Idempotency: every posting carries a UNIQUE idempotency_key; replays
 *    return the original entry instead of double-posting.
 *  - users.wallet is kept as a read-only mirror of `available` for backward
 *    compatibility with existing screens; it is written only here, in-txn.
 *  - A compatibility row is also written to the legacy `transactions` table for
 *    real money movements so existing stats/winnings boards keep working.
 */
import { getPgPool } from '../database/postgres.js';
import { getPartner, reserveCode, issueForWithdraw, releaseForWithdraw } from './payoutPartnerService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export type LedgerEntryType =
  | 'deposit' | 'ticket_purchase' | 'lifeline_purchase' | 'shop_purchase' | 'match_stake' | 'stake_refund' | 'refund'
  | 'match_reward' | 'league_reward' | 'referral_reward' | 'bonus'
  | 'withdraw_lock' | 'withdraw_release' | 'withdraw_paid'
  | 'fee' | 'penalty' | 'adjustment' | 'transfer_in' | 'transfer_out';

export type LedgerKind = 'credit' | 'debit' | 'lock' | 'release' | 'settle';

export interface LedgerEntry {
  id: string; userId: string; entryType: LedgerEntryType; kind: LedgerKind; amount: number;
  availableBefore: number; availableAfter: number; lockedBefore: number; lockedAfter: number;
  refType?: string; refId?: string; idempotencyKey: string; description?: string;
  operatorId?: string; ip?: string; device?: string; platform?: string;
  metadata?: Record<string, unknown>; createdAt: string;
}

export interface WalletAccount { userId: string; available: number; locked: number; pendingSettlement: number; version: number; updatedAt: string }

export interface PostInput {
  userId: string; entryType: LedgerEntryType; kind: LedgerKind; amount: number;
  idempotencyKey: string; refType?: string; refId?: string; description?: string;
  operatorId?: string; ip?: string; device?: string; platform?: string; metadata?: Record<string, unknown>;
}

export interface PostResult { entry: LedgerEntry; account: WalletAccount; duplicate: boolean }

export class WalletError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// Live limits — read from the editable economy config on every access so admin
// changes apply instantly. `WALLET_LIMITS` kept as a Proxy for the few existing
// call sites that read it like a static object.
import { getWalletLimits } from './economyConfig.js';
export const WALLET_LIMITS: WalletLimits = new Proxy({} as WalletLimits, { get: (_t, prop: string) => (getWalletLimits() as any)[prop] });
type WalletLimits = ReturnType<typeof getWalletLimits>;

// ---------------------------------------------------------------------------
// Schema (runtime-ensured so a plain build+restart deploy works; mirrors
// database/migrations/019_wallet_ledger.sql)
// ---------------------------------------------------------------------------
let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_accounts (
      user_id UUID PRIMARY KEY REFERENCES users(id),
      available BIGINT NOT NULL DEFAULT 0 CHECK (available >= 0),
      locked BIGINT NOT NULL DEFAULT 0 CHECK (locked >= 0),
      pending_settlement BIGINT NOT NULL DEFAULT 0 CHECK (pending_settlement >= 0),
      version BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS wallet_ledger (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      entry_type VARCHAR(32) NOT NULL,
      kind VARCHAR(12) NOT NULL,
      amount BIGINT NOT NULL CHECK (amount > 0),
      available_before BIGINT NOT NULL,
      available_after BIGINT NOT NULL,
      locked_before BIGINT NOT NULL,
      locked_after BIGINT NOT NULL,
      ref_type VARCHAR(32), ref_id VARCHAR(120),
      idempotency_key VARCHAR(200) UNIQUE NOT NULL,
      description TEXT, operator_id UUID,
      ip VARCHAR(64), device VARCHAR(160), platform VARCHAR(40),
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_time ON wallet_ledger(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_type_time ON wallet_ledger(entry_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wallet_ledger_ref ON wallet_ledger(ref_type, ref_id);
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      amount BIGINT NOT NULL CHECK (amount > 0),
      fee BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
      destination VARCHAR(120) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      reject_reason TEXT, reviewed_by UUID, reviewed_at TIMESTAMP,
      paid_by UUID, paid_at TIMESTAMP, payment_reference VARCHAR(160),
      idempotency_key VARCHAR(200) UNIQUE NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now(),
      updated_at TIMESTAMP NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_withdraw_requests_user_time ON withdraw_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status_time ON withdraw_requests(status, created_at DESC);
    CREATE TABLE IF NOT EXISTS wallet_audit_logs (
      id UUID PRIMARY KEY,
      user_id UUID, actor_id UUID,
      action VARCHAR(64) NOT NULL, api VARCHAR(160),
      ip VARCHAR(64), device VARCHAR(200), platform VARCHAR(40),
      request JSONB, response JSONB, error TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_wallet_audit_user_time ON wallet_audit_logs(user_id, created_at DESC);
  `);
  // Withdrawal KYC fields for admin review (added for existing deployments too).
  await pool.query(`ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS national_id VARCHAR(20)`);
  await pool.query(`ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS holder_name VARCHAR(120)`);
  // Immutability trigger (separate statement: CREATE FUNCTION can't be batched blindly).
  await pool.query(`CREATE OR REPLACE FUNCTION wallet_ledger_immutable() RETURNS trigger AS $f$ BEGIN RAISE EXCEPTION 'wallet_ledger rows are immutable'; END; $f$ LANGUAGE plpgsql`);
  await pool.query(`DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable ON wallet_ledger`);
  await pool.query(`CREATE TRIGGER trg_wallet_ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION wallet_ledger_immutable()`);
  _schemaReady = true;
}

function pgAvailable(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// In-memory driver (dev/tests) — same semantics, per-user promise mutex.
// ---------------------------------------------------------------------------
const memAccounts = new Map<string, WalletAccount>();
const memLedger: LedgerEntry[] = [];
const memByIdem = new Map<string, LedgerEntry>();
const memWithdraws: any[] = [];
const memAudit: any[] = [];
const memLocks = new Map<string, Promise<unknown>>();
function memLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = memLocks.get(userId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  memLocks.set(userId, next.catch(() => undefined));
  return next;
}
function memAccount(userId: string): WalletAccount {
  let a = memAccounts.get(userId);
  if (!a) { a = { userId, available: 0, locked: 0, pendingSettlement: 0, version: 0, updatedAt: new Date().toISOString() }; memAccounts.set(userId, a); }
  return a;
}

function applyKind(kind: LedgerKind, amount: number, available: number, locked: number): { available: number; locked: number } {
  switch (kind) {
    case 'credit': return { available: available + amount, locked };
    case 'debit': return { available: available - amount, locked };
    case 'lock': return { available: available - amount, locked: locked + amount };
    case 'release': return { available: available + amount, locked: locked - amount };
    case 'settle': return { available, locked: locked - amount };
  }
}

/* Legacy `transactions` compatibility row for real money movements (skips the
 * internal lock/release moves so old sums stay meaningful). */
function legacyRow(e: { entryType: LedgerEntryType; kind: LedgerKind }): { type: string; direction: 'in' | 'out'; status: string } | null {
  switch (e.entryType) {
    // 'deposit' intentionally returns null: the payment-intent flow owns its own
    // legacy `topup` transaction row (created pending, flipped to paid at settle),
    // so writing another here would double-count topups in old reports.
    case 'deposit': return null;
    case 'match_reward': case 'league_reward': case 'referral_reward': return { type: 'reward', direction: 'in', status: 'ok' };
    case 'bonus': return { type: 'bonus', direction: 'in', status: 'ok' };
    case 'refund': case 'stake_refund': return { type: 'refund', direction: 'in', status: 'ok' };
    case 'ticket_purchase': return { type: 'ticket', direction: 'out', status: 'ok' };
    case 'match_stake': return { type: 'game', direction: 'out', status: 'ok' };
    case 'withdraw_paid': return { type: 'withdraw', direction: 'out', status: 'paid' };
    case 'fee': return { type: 'fee', direction: 'out', status: 'ok' };
    case 'penalty': return { type: 'penalty', direction: 'out', status: 'ok' };
    case 'adjustment': return { type: 'adjust', direction: e.kind === 'credit' ? 'in' : 'out', status: 'ok' };
    case 'transfer_in': return { type: 'transfer', direction: 'in', status: 'ok' };
    case 'transfer_out': return { type: 'transfer', direction: 'out', status: 'ok' };
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Core posting — the ONLY way money moves.
// ---------------------------------------------------------------------------
/* THE ONE-WAY DOOR.
 *
 * The صندوق جایزه is not a wallet: money enters it by being WON and leaves it
 * by being spent or withdrawn. There is no topping up, so a `deposit` entry is
 * no longer a thing that can exist. Refusing it here — at the only place money
 * moves — is what makes that true, rather than merely hiding the button.
 *
 * This matters beyond tidiness: if a player could put money in and take it out
 * again, the game would be moving other people's money for them, which is a
 * different and heavily regulated business. */
export async function postEntry(input: PostInput): Promise<PostResult> {
  if (input.entryType === 'deposit') {
    throw new WalletError('DEPOSIT_REMOVED', 'شارژ صندوق جایزه ممکن نیست؛ فقط جایزه وارد آن می‌شود.');
  }
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new WalletError('AMOUNT_INVALID', 'Amount must be a positive integer.');
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new WalletError('IDEMPOTENCY_KEY_INVALID', 'Idempotency key missing or too long.');
  const pool = pgAvailable();
  if (pool) return postEntryPg(pool, { ...input, amount });
  return memLock(input.userId, () => postEntryMem({ ...input, amount }));
}

async function postEntryPg(pool: ReturnType<typeof getPgPool>, input: PostInput): Promise<PostResult> {
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Fast idempotency check inside the txn (unique index is the hard guarantee).
    const dup = await client.query('SELECT * FROM wallet_ledger WHERE idempotency_key=$1', [input.idempotencyKey]);
    if (dup.rows[0]) {
      await client.query('ROLLBACK');
      return { entry: entryFromRow(dup.rows[0]), account: await getAccount(input.userId), duplicate: true };
    }
    await client.query('INSERT INTO wallet_accounts(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [input.userId]);
    const acc = await client.query('SELECT * FROM wallet_accounts WHERE user_id=$1 FOR UPDATE', [input.userId]);
    const a = acc.rows[0];
    const availableBefore = Number(a.available), lockedBefore = Number(a.locked);
    const next = applyKind(input.kind, input.amount, availableBefore, lockedBefore);
    if (next.available < 0) { await client.query('ROLLBACK'); throw new WalletError('INSUFFICIENT_FUNDS', 'موجودی کافی نیست.'); }
    if (next.locked < 0) { await client.query('ROLLBACK'); throw new WalletError('LOCKED_UNDERFLOW', 'Locked balance underflow.'); }
    const entryId = id();
    const now = new Date().toISOString();
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO wallet_ledger(id,user_id,entry_type,kind,amount,available_before,available_after,locked_before,locked_after,ref_type,ref_id,idempotency_key,description,operator_id,ip,device,platform,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [entryId, input.userId, input.entryType, input.kind, input.amount, availableBefore, next.available, lockedBefore, next.locked,
         input.refType ?? null, input.refId ?? null, input.idempotencyKey, input.description ?? null, input.operatorId ?? null,
         input.ip ?? null, input.device ?? null, input.platform ?? null, JSON.stringify(input.metadata ?? {})]);
    } catch (e: any) {
      await client.query('ROLLBACK');
      if (e?.code === '23505') { // idempotency race with a concurrent identical posting
        const existing = await pool.query('SELECT * FROM wallet_ledger WHERE idempotency_key=$1', [input.idempotencyKey]);
        if (existing.rows[0]) return { entry: entryFromRow(existing.rows[0]), account: await getAccount(input.userId), duplicate: true };
      }
      throw e;
    }
    await client.query('UPDATE wallet_accounts SET available=$2, locked=$3, version=version+1, updated_at=now() WHERE user_id=$1', [input.userId, next.available, next.locked]);
    // users.wallet mirror (read-only elsewhere) — same txn, always consistent.
    await client.query('UPDATE users SET wallet_balance=$2, updated_at=now() WHERE id=$1', [input.userId, next.available]);
    const legacy = legacyRow(input);
    if (legacy) {
      await client.query(
        `INSERT INTO transactions(id,user_id,type,currency,amount,direction,status,reference,created_at) VALUES ($1,$2,$3,'cash',$4,$5,$6,$7,now())`,
        [id(), input.userId, legacy.type, input.amount, legacy.direction, legacy.status, input.refId ?? entryId]);
    }
    await client.query('COMMIT');
    const account: WalletAccount = { userId: input.userId, available: next.available, locked: next.locked, pendingSettlement: Number(a.pending_settlement), version: Number(a.version) + 1, updatedAt: now };
    return { entry: entryFromRow(inserted.rows[0]), account, duplicate: false };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  } finally {
    client.release();
  }
}

async function postEntryMem(input: PostInput): Promise<PostResult> {
  const existing = memByIdem.get(input.idempotencyKey);
  if (existing) return { entry: existing, account: { ...memAccount(input.userId) }, duplicate: true };
  const a = memAccount(input.userId);
  const next = applyKind(input.kind, input.amount, a.available, a.locked);
  if (next.available < 0) throw new WalletError('INSUFFICIENT_FUNDS', 'موجودی کافی نیست.');
  if (next.locked < 0) throw new WalletError('LOCKED_UNDERFLOW', 'Locked balance underflow.');
  const entry: LedgerEntry = {
    id: id(), userId: input.userId, entryType: input.entryType, kind: input.kind, amount: input.amount,
    availableBefore: a.available, availableAfter: next.available, lockedBefore: a.locked, lockedAfter: next.locked,
    refType: input.refType, refId: input.refId, idempotencyKey: input.idempotencyKey, description: input.description,
    operatorId: input.operatorId, ip: input.ip, device: input.device, platform: input.platform,
    metadata: input.metadata ?? {}, createdAt: new Date().toISOString()
  };
  memLedger.push(entry); memByIdem.set(input.idempotencyKey, entry);
  a.available = next.available; a.locked = next.locked; a.version += 1; a.updatedAt = entry.createdAt;
  const u = await repositories.users.findById(input.userId);
  if (u) { u.wallet = next.available; await repositories.users.save(u); }
  const legacy = legacyRow(input);
  if (legacy) await repositories.transactions.save({ id: id(), userId: input.userId, type: legacy.type, currency: 'cash', amount: input.amount, direction: legacy.direction as any, status: legacy.status as any, reference: input.refId ?? entry.id, createdAt: entry.createdAt });
  return { entry, account: { ...a }, duplicate: false };
}

/* ---------------------------------------------------------------------------
 * PRIZE-MONEY BOARDS
 *
 * Both money leaderboards come from HERE, from the ledger, using one query with
 * a different time window — which is what makes "this week" mathematically
 * incapable of exceeding "ever". They previously read different sources: the
 * lifetime board preferred an in-process cache that starts empty on every
 * restart, so after a redeploy it could report less than the weekly board.
 *
 * The figure is what the player actually KEEPS: prize credits minus the
 * commission taken on the same match. That matches the amount quoted before the
 * match and the amount that lands in the wallet.
 * ------------------------------------------------------------------------- */
const PRIZE_TYPES = ['match_reward', 'league_reward'];

/** Monday 00:00 UTC of the current week — the boundary the cup resets on. */
export function weekStartIso(): string {
  const n = new Date();
  const day = (n.getUTCDay() + 6) % 7;                       // Mon=0 … Sun=6
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - day)).toISOString();
}

export async function prizeMoneyBoard(limit = 100, sinceIso?: string): Promise<Array<{ userId: string; score: number }>> {
  const pool = pgAvailable();
  if (pool) {
    await ensureSchema(pool);
    const params: any[] = [PRIZE_TYPES, limit];
    let since = '';
    if (sinceIso) { params.push(sinceIso); since = ` AND created_at >= $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT user_id,
              sum(CASE WHEN entry_type = ANY($1) AND kind='credit' THEN amount
                       WHEN entry_type='fee' AND ref_type='match'  THEN -amount
                       ELSE 0 END) AS score
         FROM wallet_ledger
        WHERE (entry_type = ANY($1) OR (entry_type='fee' AND ref_type='match'))${since}
        GROUP BY user_id
       HAVING sum(CASE WHEN entry_type = ANY($1) AND kind='credit' THEN amount
                       WHEN entry_type='fee' AND ref_type='match'  THEN -amount
                       ELSE 0 END) > 0
        ORDER BY score DESC
        LIMIT $2`, params);
    return rows.map((r: any) => ({ userId: String(r.user_id), score: Number(r.score) }));
  }
  const cut = sinceIso ? Date.parse(sinceIso) : -Infinity;
  const totals = new Map<string, number>();
  for (const e of memLedger) {
    if (Date.parse(e.createdAt) < cut) continue;
    let delta = 0;
    if (PRIZE_TYPES.includes(e.entryType) && e.kind === 'credit') delta = e.amount;
    else if (e.entryType === 'fee' && e.refType === 'match') delta = -e.amount;
    if (delta) totals.set(e.userId, (totals.get(e.userId) ?? 0) + delta);
  }
  return [...totals.entries()]
    .map(([userId, score]) => ({ userId, score }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId))
    .slice(0, limit);
}

function entryFromRow(r: any): LedgerEntry {
  return {
    id: r.id, userId: r.user_id, entryType: r.entry_type, kind: r.kind, amount: Number(r.amount),
    availableBefore: Number(r.available_before), availableAfter: Number(r.available_after),
    lockedBefore: Number(r.locked_before), lockedAfter: Number(r.locked_after),
    refType: r.ref_type ?? undefined, refId: r.ref_id ?? undefined, idempotencyKey: r.idempotency_key,
    description: r.description ?? undefined, operatorId: r.operator_id ?? undefined,
    ip: r.ip ?? undefined, device: r.device ?? undefined, platform: r.platform ?? undefined,
    metadata: r.metadata ?? {}, createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function findEntryByIdempotencyKey(key: string): Promise<LedgerEntry | null> {
  const pool = pgAvailable();
  if (!pool) return memByIdem.get(key) ?? null;
  await ensureSchema(pool);
  const { rows } = await pool.query('SELECT * FROM wallet_ledger WHERE idempotency_key=$1', [key]);
  return rows[0] ? entryFromRow(rows[0]) : null;
}

export async function getAccount(userId: string): Promise<WalletAccount> {
  const pool = pgAvailable();
  if (!pool) return { ...memAccount(userId) };
  await ensureSchema(pool);
  const { rows } = await pool.query('SELECT * FROM wallet_accounts WHERE user_id=$1', [userId]);
  const r = rows[0];
  if (!r) return { userId, available: 0, locked: 0, pendingSettlement: 0, version: 0, updatedAt: new Date().toISOString() };
  return { userId, available: Number(r.available), locked: Number(r.locked), pendingSettlement: Number(r.pending_settlement), version: Number(r.version), updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at) };
}

export interface LedgerFilter { type?: string; q?: string; from?: string; to?: string; page?: number; pageSize?: number; sort?: 'asc' | 'desc'; playerVisibleOnly?: boolean }

/* WHAT A PLAYER SEES IN THEIR STATEMENT.
 *
 * Prizes in, prize withdrawals out, and purchases they paid for out of the
 * صندوق — which are there because otherwise the balance drops with nothing to
 * explain it. Everything else is house bookkeeping and is not the player's
 * business: fees above all. The player is shown the prize they actually get;
 * what the house kept on the way is not itemised for them.
 *
 * `withdraw_lock` is included because money that has left the available
 * balance and is waiting on a payout has to appear somewhere, or the player
 * simply loses sight of it. */
export const PLAYER_VISIBLE_ENTRY_TYPES: LedgerEntryType[] = [
  'match_reward', 'league_reward', 'referral_reward', 'bonus', 'refund', 'stake_refund',
  'ticket_purchase', 'shop_purchase', 'lifeline_purchase',
  'withdraw_lock', 'withdraw_release', 'withdraw_paid', 'adjustment'
];
const PLAYER_HIDDEN = new Set<LedgerEntryType>(['fee', 'penalty', 'deposit', 'match_stake', 'transfer_in', 'transfer_out']);
export function isPlayerVisible(entryType: LedgerEntryType): boolean { return !PLAYER_HIDDEN.has(entryType); }

export async function listEntries(userId: string, f: LedgerFilter = {}): Promise<{ rows: LedgerEntry[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 20));
  const pool = pgAvailable();
  if (!pool) {
    let rows = memLedger.filter((e) => e.userId === userId);
    if (f.playerVisibleOnly) rows = rows.filter((e) => isPlayerVisible(e.entryType));
    if (f.type) rows = rows.filter((e) => e.entryType === f.type);
    if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter((e) => (e.description ?? '').toLowerCase().includes(q) || (e.refId ?? '').toLowerCase().includes(q) || e.id.includes(q)); }
    if (f.from) rows = rows.filter((e) => e.createdAt >= f.from!);
    if (f.to) rows = rows.filter((e) => e.createdAt <= f.to!);
    rows = rows.sort((x, y) => f.sort === 'asc' ? x.createdAt.localeCompare(y.createdAt) : y.createdAt.localeCompare(x.createdAt));
    return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize };
  }
  await ensureSchema(pool);
  const conds: string[] = ['user_id=$1']; const args: unknown[] = [userId];
  if (f.playerVisibleOnly) { args.push(Array.from(PLAYER_HIDDEN)); conds.push(`NOT (entry_type = ANY($${args.length}::text[]))`); }
  if (f.type) { args.push(f.type); conds.push(`entry_type=$${args.length}`); }
  if (f.q) { args.push(`%${f.q}%`); conds.push(`(description ILIKE $${args.length} OR ref_id ILIKE $${args.length} OR id::text ILIKE $${args.length})`); }
  if (f.from) { args.push(f.from); conds.push(`created_at >= $${args.length}`); }
  if (f.to) { args.push(f.to); conds.push(`created_at <= $${args.length}`); }
  const where = conds.join(' AND ');
  const order = f.sort === 'asc' ? 'ASC' : 'DESC';
  const total = await pool.query(`SELECT count(*) AS n FROM wallet_ledger WHERE ${where}`, args);
  const rows = await pool.query(`SELECT * FROM wallet_ledger WHERE ${where} ORDER BY created_at ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, args);
  return { rows: rows.rows.map(entryFromRow), total: Number(total.rows[0]?.n ?? 0), page, pageSize };
}

export async function getDashboard(userId: string): Promise<Record<string, unknown>> {
  const account = await getAccount(userId);
  const user = await repositories.users.findById(userId);
  const agg = await aggregateByType(userId);
  const rewards = (agg['match_reward']?.credit ?? 0) + (agg['league_reward']?.credit ?? 0) + (agg['referral_reward']?.credit ?? 0);
  /* Kept only to add up history that predates the change. Nothing writes a
   * deposit any more, so on a fresh account this is always zero. */
  const legacyDeposits = agg['deposit']?.credit ?? 0;
  const bonuses = agg['bonus']?.credit ?? 0;
  const refunds = (agg['refund']?.credit ?? 0) + (agg['stake_refund']?.credit ?? 0);
  const withdrawn = agg['withdraw_paid']?.settle ?? 0;
  const ticketSpend = (agg['ticket_purchase']?.debit ?? 0) + (agg['match_stake']?.debit ?? 0);
  return {
    available: account.available,
    locked: account.locked,
    pendingSettlement: account.pendingSettlement,
    totalIncome: legacyDeposits + rewards + bonuses + refunds + (agg['transfer_in']?.credit ?? 0) + (agg['adjustment']?.credit ?? 0),
    totalWithdrawn: withdrawn,
    /* The صندوق جایزه has no deposits. `totalPrizes` is the figure that means
     * something now; `totalDeposits` stays, zero on every new account, so an
     * older admin screen reading it does not break while it is being updated. */
    totalPrizes: rewards + bonuses,
    totalDeposits: legacyDeposits,
    totalRewards: rewards,
    totalTicketSpend: ticketSpend,
    totalBonuses: bonuses,
    totalRefunds: refunds,
    lastTransactionAt: await lastEntryAt(userId),
    kycStatus: user ? 'phone_verified' : 'unknown',
    accountStatus: user ? (user.status ?? 'active') : 'unknown',
    limits: getWalletLimits() // plain object (the Proxy JSON-serializes empty)
  };
}

async function aggregateByType(userId: string): Promise<Record<string, Record<string, number>>> {
  const pool = pgAvailable();
  const out: Record<string, Record<string, number>> = {};
  if (!pool) {
    for (const e of memLedger) {
      if (e.userId !== userId) continue;
      (out[e.entryType] ??= {})[e.kind] = ((out[e.entryType] ?? {})[e.kind] ?? 0) + e.amount;
    }
    return out;
  }
  await ensureSchema(pool);
  const { rows } = await pool.query('SELECT entry_type, kind, coalesce(sum(amount),0) AS total FROM wallet_ledger WHERE user_id=$1 GROUP BY entry_type, kind', [userId]);
  for (const r of rows) (out[r.entry_type] ??= {})[r.kind] = Number(r.total);
  return out;
}

async function lastEntryAt(userId: string): Promise<string | null> {
  const pool = pgAvailable();
  if (!pool) { const mine = memLedger.filter((e) => e.userId === userId); return mine.length ? mine[mine.length - 1]!.createdAt : null; }
  const { rows } = await pool.query('SELECT max(created_at) AS at FROM wallet_ledger WHERE user_id=$1', [userId]);
  const at = rows[0]?.at; return at ? (at.toISOString?.() ?? String(at)) : null;
}

// ---------------------------------------------------------------------------
// Withdrawals — pending → approved → paid, or rejected/failed (funds locked
// while in flight, released on reject/fail, settled on paid).
// ---------------------------------------------------------------------------
/** How the player wants the prize out: to a bank account, or as partner credit. */
export type PayoutMethod = 'bank' | 'partner';

export interface WithdrawRequest {
  id: string; userId: string; amount: number; fee: number; destination: string;
  status: 'pending' | 'approved' | 'rejected' | 'paid' | 'failed';
  payoutMethod: PayoutMethod; partnerId?: string; partnerName?: string;
  nationalId?: string; holderName?: string;
  rejectReason?: string; reviewedBy?: string; reviewedAt?: string;
  paidBy?: string; paidAt?: string; paymentReference?: string; createdAt: string;
}

// The one-time code the user must enter to confirm a withdrawal. It is "sent" to
// the user's registered mobile. For now it is a FIXED code (1234) — overridable
// via WITHDRAW_OTP_CODE — so switching to a real per-phone SMS OTP later is a
// localized change. A withdrawal is NEVER recorded without the correct code.
export function withdrawOtpCode(): string { return String(process.env.WITHDRAW_OTP_CODE || '1234'); }

export async function requestWithdraw(input: { userId: string; amount: number; destination?: string; nationalId?: string; holderName?: string; otp?: string; ip?: string; device?: string; platform?: string; idempotencyKey?: string; payoutMethod?: PayoutMethod; partnerId?: string }): Promise<WithdrawRequest> {
  // Mobile-code gate FIRST: no valid code ⇒ nothing is locked or recorded.
  if (String(input.otp ?? '').trim() !== withdrawOtpCode()) throw new WalletError('WITHDRAW_OTP_INVALID', 'کد تأیید پیامک‌شده نادرست است.');
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) throw new WalletError('AMOUNT_INVALID', 'مبلغ نامعتبر است.');
  if (amount < WALLET_LIMITS.minWithdraw) throw new WalletError('WITHDRAW_BELOW_MIN', `حداقل برداشت ${WALLET_LIMITS.minWithdraw.toLocaleString('fa-IR')} تومان است.`);
  if (amount > WALLET_LIMITS.maxWithdraw) throw new WalletError('WITHDRAW_ABOVE_MAX', `حداکثر برداشت ${WALLET_LIMITS.maxWithdraw.toLocaleString('fa-IR')} تومان است.`);
  /* TWO DOORS OUT. A bank payout needs a card or SHEBA; a partner payout needs
   * a partner that actually has a code of this amount on the shelf. Asking a
   * player for their bank details in order to hand them a discount code would
   * be collecting information for no reason. */
  const payoutMethod: PayoutMethod = input.payoutMethod === 'partner' ? 'partner' : 'bank';
  let dest = String(input.destination ?? '').trim();
  let partner: { id: string; name: string } | null = null;
  const nationalId = String(input.nationalId ?? '').replace(/[^\d]/g, '').slice(0, 20) || undefined;
  const holderName = String(input.holderName ?? '').trim().slice(0, 120) || undefined;
  if (payoutMethod === 'bank') {
    if (!/^(IR[0-9]{24}|[0-9]{16}|[0-9]{24})$/.test(dest.replace(/[\s-]/g, ''))) throw new WalletError('DESTINATION_INVALID', 'شماره شبا (IR + ۲۴ رقم) یا کارت ۱۶ رقمی معتبر وارد کن.');
  } else {
    const p = await getPartner(String(input.partnerId ?? ''));
    if (!p) throw new WalletError('PARTNER_NOT_FOUND', 'شریک انتخاب‌شده پیدا نشد.');
    if (!p.enabled) throw new WalletError('PARTNER_DISABLED', 'این شریک فعلاً فعال نیست.');
    partner = { id: p.id, name: p.name };
    dest = 'partner:' + p.id;
  }
  const user = await repositories.users.findById(input.userId);
  if (!user) throw new WalletError('USER_NOT_FOUND', 'کاربر یافت نشد.');
  if ((user.status ?? 'active') !== 'active') throw new WalletError('ACCOUNT_NOT_ACTIVE', 'حساب کاربری فعال نیست؛ برداشت ممکن نیست.');
  const todays = await withdrawnToday(input.userId);
  if (todays + amount > WALLET_LIMITS.dailyWithdrawCap) throw new WalletError('DAILY_CAP_EXCEEDED', `سقف برداشت روزانه ${WALLET_LIMITS.dailyWithdrawCap.toLocaleString('fa-IR')} تومان است.`);
  const reqId = id();
  const idem = input.idempotencyKey ? `wd:${input.userId}:${input.idempotencyKey}` : `wd_lock:${reqId}`;
  // Lock funds FIRST (atomic; throws INSUFFICIENT_FUNDS if not enough).
  const posted = await postEntry({ userId: input.userId, entryType: 'withdraw_lock', kind: 'lock', amount, idempotencyKey: idem, refType: 'withdraw', refId: reqId, description: `درخواست برداشت به ${dest}`, ip: input.ip, device: input.device, platform: input.platform });
  if (posted.duplicate) {
    const existing = await findWithdrawByLedgerRef(posted.entry.refId!);
    if (existing) return existing;
  }
  /* Reserve the code AFTER the money is locked and BEFORE the player is told
   * yes. Reserving first would strand a code whenever the lock failed; telling
   * them yes first would let two players be promised the same last code. If
   * the shelf is empty the lock is released again — a request that cannot be
   * paid must not sit on the player's balance. */
  if (payoutMethod === 'partner') {
    try {
      await reserveCode({ partnerId: partner!.id, amount, userId: input.userId, withdrawId: reqId });
    } catch (e) {
      await postEntry({ userId: input.userId, entryType: 'withdraw_release', kind: 'release', amount, idempotencyKey: `wd_release:${reqId}`, refType: 'withdraw', refId: reqId, description: 'کد موجود نبود' }).catch(() => undefined);
      throw new WalletError((e as any)?.code || 'OUT_OF_STOCK', (e as Error)?.message || 'کد این مبلغ موجود نیست.');
    }
  }
  const row: WithdrawRequest = { id: reqId, userId: input.userId, amount, fee: WALLET_LIMITS.withdrawFee, destination: dest, status: 'pending', payoutMethod, partnerId: partner?.id, partnerName: partner?.name, nationalId, holderName, createdAt: new Date().toISOString() };
  const pool = pgAvailable();
  if (pool) {
    const hasCols = await ensureWithdrawPayoutColumns(pool);
    if (hasCols) {
      await pool.query(`INSERT INTO withdraw_requests(id,user_id,amount,fee,destination,status,national_id,holder_name,idempotency_key,payout_method,partner_id) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10)`, [reqId, input.userId, amount, WALLET_LIMITS.withdrawFee, dest, nationalId ?? null, holderName ?? null, idem, payoutMethod, partner?.id ?? null]);
    } else {
      await pool.query(`INSERT INTO withdraw_requests(id,user_id,amount,fee,destination,status,national_id,holder_name,idempotency_key) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`, [reqId, input.userId, amount, WALLET_LIMITS.withdrawFee, dest, nationalId ?? null, holderName ?? null, idem]);
    }
  } else {
    memWithdraws.push({ ...row, idempotencyKey: idem });
  }
  return row;
}

/* Adds the two payout columns to a table that predates them. Never throws:
 * a withdrawal is money, and it must not fail because a schema statement did.
 * If the columns cannot be added, partner payouts simply record as bank rows
 * with a `partner:` destination, which still names the partner. */
let _wdColsReady: Promise<boolean> | null = null;
async function ensureWithdrawPayoutColumns(pool: ReturnType<typeof getPgPool>): Promise<boolean> {
  if (!_wdColsReady) {
    _wdColsReady = pool.query(`ALTER TABLE withdraw_requests
        ADD COLUMN IF NOT EXISTS payout_method TEXT NOT NULL DEFAULT 'bank',
        ADD COLUMN IF NOT EXISTS partner_id TEXT`)
      .then(() => true)
      .catch((e) => { _wdColsReady = null; logger.warn('withdraw_payout_columns_missing', { message: e instanceof Error ? e.message : 'unknown' }); return false; });
  }
  return _wdColsReady;
}

async function withdrawnToday(userId: string): Promise<number> {
  const pool = pgAvailable();
  if (!pool) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return memWithdraws.filter((w) => w.userId === userId && w.status !== 'rejected' && w.status !== 'failed' && new Date(w.createdAt) >= start).reduce((s, w) => s + w.amount, 0);
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT coalesce(sum(amount),0) AS total FROM withdraw_requests WHERE user_id=$1 AND status NOT IN ('rejected','failed') AND created_at >= date_trunc('day', now())`, [userId]);
  return Number(rows[0]?.total ?? 0);
}

async function findWithdrawByLedgerRef(reqId: string): Promise<WithdrawRequest | null> {
  const pool = pgAvailable();
  if (!pool) return memWithdraws.find((w) => w.id === reqId) ?? null;
  const { rows } = await pool.query('SELECT * FROM withdraw_requests WHERE id=$1', [reqId]);
  return rows[0] ? withdrawFromRow(rows[0]) : null;
}

export async function listWithdraws(filter: { userId?: string; status?: string; page?: number; pageSize?: number } = {}): Promise<{ rows: WithdrawRequest[]; total: number }> {
  const page = Math.max(1, Number(filter.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(filter.pageSize) || 20));
  const pool = pgAvailable();
  if (!pool) {
    let rows = [...memWithdraws];
    if (filter.userId) rows = rows.filter((w) => w.userId === filter.userId);
    if (filter.status) rows = rows.filter((w) => w.status === filter.status);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
  }
  await ensureSchema(pool);
  const conds: string[] = []; const args: unknown[] = [];
  if (filter.userId) { args.push(filter.userId); conds.push(`user_id=$${args.length}`); }
  if (filter.status) { args.push(filter.status); conds.push(`status=$${args.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = await pool.query(`SELECT count(*) AS n FROM withdraw_requests ${where}`, args);
  const rows = await pool.query(`SELECT * FROM withdraw_requests ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, args);
  return { rows: rows.rows.map(withdrawFromRow), total: Number(total.rows[0]?.n ?? 0) };
}

export async function transitionWithdraw(reqId: string, action: 'approve' | 'reject' | 'paid' | 'failed', operator: { id: string; reason?: string; paymentReference?: string }): Promise<WithdrawRequest> {
  const w = await findWithdrawByLedgerRef(reqId);
  if (!w) throw new WalletError('WITHDRAW_NOT_FOUND', 'درخواست برداشت یافت نشد.');
  const valid: Record<string, string[]> = { approve: ['pending'], reject: ['pending', 'approved'], paid: ['approved', 'pending'], failed: ['approved', 'pending'] };
  if (!valid[action]!.includes(w.status)) throw new WalletError('WITHDRAW_BAD_STATE', `از وضعیت ${w.status} نمی‌توان ${action} کرد.`);
  const now = new Date().toISOString();
  if (action === 'reject' || action === 'failed') {
    await postEntry({ userId: w.userId, entryType: 'withdraw_release', kind: 'release', amount: w.amount, idempotencyKey: `wd_release:${reqId}`, refType: 'withdraw', refId: reqId, description: action === 'reject' ? `برداشت رد شد: ${operator.reason ?? ''}` : `پرداخت ناموفق: ${operator.reason ?? ''}`, operatorId: operator.id });
    /* The code goes back on the shelf. A rejected request that kept its code
     * would quietly burn stock nobody can account for. */
    if (w.payoutMethod === 'partner') await releaseForWithdraw(reqId).catch(() => undefined);
  }
  if (action === 'paid') {
    await postEntry({ userId: w.userId, entryType: 'withdraw_paid', kind: 'settle', amount: w.amount, idempotencyKey: `wd_paid:${reqId}`, refType: 'withdraw', refId: reqId, description: `برداشت پرداخت شد (${operator.paymentReference ?? ''})`, operatorId: operator.id });
    /* «اولین برداشت» means money that actually reached the player's bank, not a
     * request they filed — so it is counted here and not at request time.
     * Imported lazily: missionService imports postEntry from this file, and a
     * static import back would put a cycle in the middle of the money code. */
    try {
      const m = await import('./missionService.js');
      await m.recordMoney(w.userId, 'withdrawal', w.amount);
    } catch { /* missions must never block a payout */ }
    /* The payout has happened, so the reserved code becomes the player's. */
    if (w.payoutMethod === 'partner') {
      const issued = await issueForWithdraw(reqId).catch(() => null);
      if (!issued) logger.error('payout_code_not_issued', { withdrawId: reqId, userId: w.userId });
    }
  }
  const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : action === 'paid' ? 'paid' : 'failed';
  const pool = pgAvailable();
  if (pool) {
    await pool.query(
      `UPDATE withdraw_requests SET status=$2, reject_reason=coalesce($3,reject_reason), reviewed_by=coalesce($4,reviewed_by), reviewed_at=coalesce($5,reviewed_at), paid_by=$6, paid_at=$7, payment_reference=coalesce($8,payment_reference), updated_at=now() WHERE id=$1`,
      [reqId, status, operator.reason ?? null, operator.id, now, action === 'paid' ? operator.id : null, action === 'paid' ? now : null, operator.paymentReference ?? null]);
  } else {
    const m = memWithdraws.find((x) => x.id === reqId);
    if (m) { m.status = status; m.rejectReason = operator.reason ?? m.rejectReason; m.reviewedBy = operator.id; m.reviewedAt = now; if (action === 'paid') { m.paidBy = operator.id; m.paidAt = now; m.paymentReference = operator.paymentReference; } }
  }
  return (await findWithdrawByLedgerRef(reqId))!;
}

function withdrawFromRow(r: any): WithdrawRequest {
  return {
    id: r.id, userId: r.user_id, amount: Number(r.amount), fee: Number(r.fee), destination: r.destination,
    /* A row written before the column existed is a bank payout, which is what
     * every withdrawal was until partners arrived. */
    payoutMethod: (r.payout_method === 'partner' ? 'partner' : 'bank'), partnerId: r.partner_id ?? undefined,
    nationalId: r.national_id ?? undefined, holderName: r.holder_name ?? undefined,
    status: r.status, rejectReason: r.reject_reason ?? undefined, reviewedBy: r.reviewed_by ?? undefined,
    reviewedAt: r.reviewed_at?.toISOString?.() ?? r.reviewed_at ?? undefined,
    paidBy: r.paid_by ?? undefined, paidAt: r.paid_at?.toISOString?.() ?? r.paid_at ?? undefined,
    paymentReference: r.payment_reference ?? undefined,
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}

// ---------------------------------------------------------------------------
// Admin: adjustment + internal transfer
// ---------------------------------------------------------------------------
export async function adminAdjust(input: { userId: string; amount: number; reason: string; operatorId: string }): Promise<PostResult> {
  const amt = Math.round(Number(input.amount));
  if (!Number.isFinite(amt) || amt === 0) throw new WalletError('AMOUNT_INVALID', 'مبلغ اصلاح نامعتبر است.');
  return postEntry({
    userId: input.userId, entryType: 'adjustment', kind: amt > 0 ? 'credit' : 'debit', amount: Math.abs(amt),
    idempotencyKey: `adj:${input.operatorId}:${input.userId}:${Date.now()}:${Math.abs(amt)}`,
    refType: 'admin', refId: input.operatorId, description: `اصلاح حساب: ${input.reason}`, operatorId: input.operatorId
  });
}

export async function internalTransfer(input: { fromUserId: string; toUserId: string; amount: number; reason: string; operatorId: string }): Promise<{ out: PostResult; in: PostResult }> {
  const amt = Math.round(Number(input.amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new WalletError('AMOUNT_INVALID', 'مبلغ انتقال نامعتبر است.');
  if (input.fromUserId === input.toUserId) throw new WalletError('TRANSFER_SELF', 'انتقال به خود ممکن نیست.');
  const ref = id();
  const out = await postEntry({ userId: input.fromUserId, entryType: 'transfer_out', kind: 'debit', amount: amt, idempotencyKey: `tr_out:${ref}`, refType: 'transfer', refId: ref, description: `انتقال به ${input.toUserId}: ${input.reason}`, operatorId: input.operatorId });
  try {
    const inn = await postEntry({ userId: input.toUserId, entryType: 'transfer_in', kind: 'credit', amount: amt, idempotencyKey: `tr_in:${ref}`, refType: 'transfer', refId: ref, description: `انتقال از ${input.fromUserId}: ${input.reason}`, operatorId: input.operatorId });
    return { out, in: inn };
  } catch (e) {
    // Compensating credit so money is never destroyed if the second leg fails.
    await postEntry({ userId: input.fromUserId, entryType: 'refund', kind: 'credit', amount: amt, idempotencyKey: `tr_comp:${ref}`, refType: 'transfer', refId: ref, description: 'برگشت انتقال ناموفق', operatorId: input.operatorId });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Reports + consistency
// ---------------------------------------------------------------------------
export async function reportSummary(opts: { granularity?: 'daily' | 'monthly'; from?: string; to?: string } = {}): Promise<Record<string, unknown>> {
  const pool = pgAvailable();
  const trunc = opts.granularity === 'monthly' ? 'month' : 'day';
  if (!pool) {
    interface Bucket { deposits: number; withdrawals: number; rewards: number; stakes: number; refunds: number }
    const buckets: Record<string, Bucket> = {};
    for (const e of memLedger) {
      const day = e.createdAt.slice(0, trunc === 'month' ? 7 : 10);
      const b = (buckets[day] ??= { deposits: 0, withdrawals: 0, rewards: 0, stakes: 0, refunds: 0 });
      if (e.entryType === 'deposit') b.deposits += e.amount;
      if (e.entryType === 'withdraw_paid') b.withdrawals += e.amount;
      if (['match_reward', 'league_reward', 'referral_reward', 'bonus'].includes(e.entryType)) b.rewards += e.amount;
      if (['match_stake', 'ticket_purchase'].includes(e.entryType)) b.stakes += e.amount;
      if (['refund', 'stake_refund'].includes(e.entryType)) b.refunds += e.amount;
    }
    const rows = Object.entries(buckets).sort(([a], [b]) => b.localeCompare(a)).map(([period, v]) => ({ period, ...v, systemProfit: v.stakes - v.rewards }));
    return { granularity: trunc, rows };
  }
  await ensureSchema(pool);
  const conds: string[] = []; const args: unknown[] = [];
  if (opts.from) { args.push(opts.from); conds.push(`created_at >= $${args.length}`); }
  if (opts.to) { args.push(opts.to); conds.push(`created_at <= $${args.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT date_trunc('${trunc}', created_at) AS period,
       coalesce(sum(amount) FILTER (WHERE entry_type='deposit'),0) AS deposits,
       coalesce(sum(amount) FILTER (WHERE entry_type='withdraw_paid'),0) AS withdrawals,
       coalesce(sum(amount) FILTER (WHERE entry_type IN ('match_reward','league_reward','referral_reward','bonus')),0) AS rewards,
       coalesce(sum(amount) FILTER (WHERE entry_type IN ('match_stake','ticket_purchase')),0) AS stakes,
       coalesce(sum(amount) FILTER (WHERE entry_type IN ('refund','stake_refund')),0) AS refunds
     FROM wallet_ledger ${where} GROUP BY 1 ORDER BY 1 DESC LIMIT 120`, args);
  return {
    granularity: trunc,
    rows: rows.map((r) => ({ period: r.period?.toISOString?.().slice(0, trunc === 'month' ? 7 : 10) ?? String(r.period), deposits: Number(r.deposits), withdrawals: Number(r.withdrawals), rewards: Number(r.rewards), stakes: Number(r.stakes), refunds: Number(r.refunds), systemProfit: Number(r.stakes) - Number(r.rewards) }))
  };
}

export async function reportTopUsers(limit = 20): Promise<unknown[]> {
  const pool = pgAvailable();
  if (!pool) {
    const vol = new Map<string, number>();
    for (const e of memLedger) vol.set(e.userId, (vol.get(e.userId) ?? 0) + e.amount);
    return [...vol.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([userId, volume]) => ({ userId, volume }));
  }
  const { rows } = await pool.query(`SELECT user_id, coalesce(sum(amount),0) AS volume, count(*) AS entries FROM wallet_ledger GROUP BY user_id ORDER BY volume DESC LIMIT $1`, [limit]);
  const out = [];
  for (const r of rows) {
    const u = await repositories.users.findById(r.user_id);
    out.push({ userId: r.user_id, username: u?.username ?? r.user_id, volume: Number(r.volume), entries: Number(r.entries) });
  }
  return out;
}

export async function reportSuspicious(): Promise<unknown[]> {
  const pool = pgAvailable();
  if (!pool) return [];
  await ensureSchema(pool);
  // High-velocity spenders + users with many rejected/failed withdrawals in 24h.
  const { rows } = await pool.query(`
    SELECT user_id, 'high_velocity' AS reason, count(*) AS n FROM wallet_ledger
      WHERE created_at >= now() - interval '1 hour' GROUP BY user_id HAVING count(*) >= 30
    UNION ALL
    SELECT user_id, 'failed_withdrawals' AS reason, count(*) AS n FROM withdraw_requests
      WHERE status IN ('rejected','failed') AND created_at >= now() - interval '24 hours' GROUP BY user_id HAVING count(*) >= 3`);
  return rows.map((r) => ({ userId: r.user_id, reason: r.reason, count: Number(r.n) }));
}

export async function verifyConsistency(userId?: string): Promise<{ checked: number; mismatches: unknown[] }> {
  const pool = pgAvailable();
  if (!pool) {
    const ids = userId ? [userId] : [...memAccounts.keys()];
    const mismatches: unknown[] = [];
    for (const uid of ids) {
      const a = memAccount(uid);
      let av = 0, lk = 0;
      for (const e of memLedger) {
        if (e.userId !== uid) continue;
        const next = applyKind(e.kind, e.amount, av, lk); av = next.available; lk = next.locked;
      }
      if (av !== a.available || lk !== a.locked) mismatches.push({ userId: uid, ledger: { available: av, locked: lk }, account: { available: a.available, locked: a.locked } });
    }
    return { checked: ids.length, mismatches };
  }
  await ensureSchema(pool);
  const args: unknown[] = []; let where = '';
  if (userId) { args.push(userId); where = 'WHERE a.user_id=$1'; }
  const { rows } = await pool.query(`
    SELECT a.user_id, a.available, a.locked,
      coalesce(l.av,0) AS ledger_available, coalesce(l.lk,0) AS ledger_locked
    FROM wallet_accounts a
    LEFT JOIN (
      SELECT user_id,
        sum(CASE kind WHEN 'credit' THEN amount WHEN 'release' THEN amount WHEN 'debit' THEN -amount WHEN 'lock' THEN -amount ELSE 0 END) AS av,
        sum(CASE kind WHEN 'lock' THEN amount WHEN 'release' THEN -amount WHEN 'settle' THEN -amount ELSE 0 END) AS lk
      FROM wallet_ledger GROUP BY user_id
    ) l ON l.user_id = a.user_id ${where}`, args);
  const mismatches = rows.filter((r) => Number(r.available) !== Number(r.ledger_available) || Number(r.locked) !== Number(r.ledger_locked))
    .map((r) => ({ userId: r.user_id, account: { available: Number(r.available), locked: Number(r.locked) }, ledger: { available: Number(r.ledger_available), locked: Number(r.ledger_locked) } }));
  return { checked: rows.length, mismatches };
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
export async function auditLog(input: { userId?: string; actorId?: string; action: string; api?: string; ip?: string; device?: string; platform?: string; request?: unknown; response?: unknown; error?: string }): Promise<void> {
  try {
    const pool = pgAvailable();
    if (!pool) { memAudit.push({ ...input, id: id(), createdAt: new Date().toISOString() }); return; }
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO wallet_audit_logs(id,user_id,actor_id,action,api,ip,device,platform,request,response,error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id(), input.userId ?? null, input.actorId ?? null, input.action, input.api ?? null, input.ip ?? null, input.device ?? null, input.platform ?? null,
       JSON.stringify(input.request ?? null), JSON.stringify(input.response ?? null), input.error ?? null]);
  } catch (e) {
    logger.warn('wallet_audit_failed', { action: input.action, message: e instanceof Error ? e.message : 'unknown' });
  }
}

export async function listAudit(filter: { userId?: string; action?: string; limit?: number } = {}): Promise<unknown[]> {
  const pool = pgAvailable();
  const limit = Math.min(500, Math.max(1, Number(filter.limit) || 100));
  if (!pool) {
    let rows = [...memAudit];
    if (filter.userId) rows = rows.filter((r) => r.userId === filter.userId);
    if (filter.action) rows = rows.filter((r) => r.action === filter.action);
    return rows.slice(-limit).reverse();
  }
  await ensureSchema(pool);
  const conds: string[] = []; const args: unknown[] = [];
  if (filter.userId) { args.push(filter.userId); conds.push(`user_id=$${args.length}`); }
  if (filter.action) { args.push(filter.action); conds.push(`action=$${args.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await pool.query(`SELECT * FROM wallet_audit_logs ${where} ORDER BY created_at DESC LIMIT ${limit}`, args);
  return rows;
}
