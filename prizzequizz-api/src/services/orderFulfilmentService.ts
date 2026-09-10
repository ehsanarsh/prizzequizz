/* DELIVERY, EXACTLY ONCE — the durable record of what was handed over.
 *
 * Two guards used to stand between a player and a second free ticket, and both
 * lived in the process:
 *
 *   purchaseOrderService  const _fulfilled = new Set<string>()
 *   shopPurchaseService   const _seen = new Map<string, PurchaseResult>()
 *
 * The comment above the first one argued that the only gap was a restart
 * between two callbacks, and that a gateway's retry window is far shorter than
 * that. For a gateway that calls back within seconds, that is true. It stops
 * being true here for two separate reasons:
 *
 *  1. Both guards are BOUNDED and evict the oldest entries — 20,000 refs in one
 *     and 5,000 in the other. So the gap is a function of VOLUME, not just of
 *     restarts: on a busy night a real payment's key can fall out of memory
 *     before the SMS confirming it arrives.
 *  2. A card-to-card payment is confirmed minutes or hours later, from three
 *     different directions — the SMS matcher, an operator approving by hand,
 *     and the sweeper that retries payments left half-finished. Any two of
 *     those can arrive on different processes.
 *
 * So the record moves into the database, where it is also the answer to a
 * second question nobody could answer before: WHAT WAS SOLD. Income for
 * externally-paid orders is invisible in `wallet_ledger` by design — the money
 * belongs to the house and never enters the player's صندوق — which means the
 * finance report has been reading zero for every gateway sale. These rows are
 * what it will read instead.
 *
 * The lifecycle is deliberately three-state rather than a boolean:
 *
 *   pending  claimed by one caller, goods not handed over yet
 *   done     handed over; `payload` is what the player got, replayed verbatim
 *   void     the payment behind it was reversed, so the reference is dead
 *
 * `void` exists because the two callers want opposite things when a grant
 * fails. Paying from the صندوق refunds the ledger and must not leave a
 * reference that would later look deliverable; a gateway payment cannot be
 * refunded automatically, so its row stays `pending` and is owed to the player
 * until it is delivered.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export type FulfilSource = 'vault' | 'gateway' | 'card_to_card';
export type FulfilStatus = 'pending' | 'done' | 'void';

export interface FulfilmentRecord {
  ref: string;
  userId: string;
  source: FulfilSource;
  status: FulfilStatus;
  kind: string;
  category: string;
  currency: 'cash' | 'coins';
  amountToman: number;
  paymentRef?: string;
  order: Record<string, unknown>;
  payload: unknown;
  attempts: number;
  lastError?: string;
  claimedAt: string;
  deliveredAt?: string;
  createdAt: string;
}

export interface ClaimInput {
  ref: string;
  userId: string;
  source: FulfilSource;
  kind: string;
  order?: Record<string, unknown>;
  paymentRef?: string;
}

export interface ClaimResult {
  /** True only for the ONE caller that may now hand over the goods. */
  claimed: boolean;
  record: FulfilmentRecord;
}

export interface CompleteInput {
  payload?: unknown;
  amountToman?: number;
  currency?: 'cash' | 'coins';
  category?: string;
}

/* How long a claim is good for. A caller that dies mid-delivery holds the row
 * for this long; after that another caller may take it over and finish the
 * delivery the player already paid for. Short enough that a crash is not felt
 * as a lost purchase, long enough that a slow grant is never run twice. */
const LEASE_MS = 60_000;

export class FulfilmentError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'FulfilmentError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Schema (runtime-ensured so a plain build+restart deploy works; mirrors
// database/migrations/026_order_fulfilments.sql)
// ---------------------------------------------------------------------------
let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_fulfilments (
      ref VARCHAR(200) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id),
      source VARCHAR(20) NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      kind VARCHAR(16) NOT NULL DEFAULT '',
      category VARCHAR(40) NOT NULL DEFAULT '',
      currency VARCHAR(8) NOT NULL DEFAULT 'cash',
      amount_toman BIGINT NOT NULL DEFAULT 0 CHECK (amount_toman >= 0),
      payment_ref VARCHAR(120),
      order_json JSONB NOT NULL DEFAULT '{}',
      payload JSONB,
      attempts INT NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS idx_order_fulfilments_status ON order_fulfilments(status, claimed_at);
    CREATE INDEX IF NOT EXISTS idx_order_fulfilments_time ON order_fulfilments(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_fulfilments_income ON order_fulfilments(source, category, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_order_fulfilments_user ON order_fulfilments(user_id, created_at DESC);
  `);
  _schemaReady = true;
}

// ---------------------------------------------------------------------------
// In-memory driver (dev/tests) — same semantics, same three states.
// ---------------------------------------------------------------------------
const mem = new Map<string, FulfilmentRecord>();

function nowIso(): string { return new Date().toISOString(); }

function rowToRecord(r: any): FulfilmentRecord {
  return {
    ref: r.ref,
    userId: String(r.user_id),
    source: r.source,
    status: r.status,
    kind: r.kind ?? '',
    category: r.category ?? '',
    currency: r.currency === 'coins' ? 'coins' : 'cash',
    amountToman: Number(r.amount_toman ?? 0),
    paymentRef: r.payment_ref ?? undefined,
    order: r.order_json ?? {},
    payload: r.payload ?? null,
    attempts: Number(r.attempts ?? 0),
    lastError: r.last_error ?? undefined,
    claimedAt: r.claimed_at?.toISOString?.() ?? String(r.claimed_at),
    deliveredAt: r.delivered_at ? (r.delivered_at.toISOString?.() ?? String(r.delivered_at)) : undefined,
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}

function validateRef(ref: string): string {
  const key = String(ref ?? '').trim();
  if (!key) throw new FulfilmentError('FULFILMENT_REF_REQUIRED', 'کلید یکتای تحویل لازم است.');
  if (key.length > 200) throw new FulfilmentError('FULFILMENT_REF_TOO_LONG', 'کلید یکتای تحویل بیش از حد بلند است.');
  return key;
}

/**
 * Take ownership of a delivery, exactly once.
 *
 * Returns `claimed: true` to at most one caller per reference — the one that
 * must now hand over the goods and then call `complete`. Every other caller
 * gets `claimed: false` plus the record, so a replay can answer with what was
 * delivered the first time instead of delivering again.
 *
 * A row left `pending` past the lease (a caller that crashed mid-delivery) can
 * be taken over, because the player has already paid for it.
 */
export async function claim(input: ClaimInput): Promise<ClaimResult> {
  const ref = validateRef(input.ref);
  const pool = pg();
  if (pool) return claimPg(pool, { ...input, ref });
  return claimMem({ ...input, ref });
}

async function claimPg(pool: ReturnType<typeof getPgPool>, input: ClaimInput): Promise<ClaimResult> {
  await ensureSchema(pool);
  const inserted = await pool.query(
    `INSERT INTO order_fulfilments(ref,user_id,source,kind,category,payment_ref,order_json)
     VALUES ($1,$2,$3,$4,'',$5,$6) ON CONFLICT (ref) DO NOTHING RETURNING *`,
    [input.ref, input.userId, input.source, input.kind, input.paymentRef ?? null, JSON.stringify(input.order ?? {})]);
  if (inserted.rows[0]) return { claimed: true, record: rowToRecord(inserted.rows[0]) };

  /* Someone holds it. Only a claim that has gone stale may be taken over, and
   * the WHERE clause is what makes that decision atomic: two servers both
   * finding the same stale row still produce exactly one winner. */
  const stolen = await pool.query(
    `UPDATE order_fulfilments
        SET claimed_at = now(), attempts = attempts + 1
      WHERE ref = $1 AND status = 'pending' AND claimed_at < now() - make_interval(secs => $2)
      RETURNING *`,
    [input.ref, LEASE_MS / 1000]);
  if (stolen.rows[0]) {
    logger.warn('fulfilment_claim_taken_over', { ref: input.ref, attempts: Number(stolen.rows[0].attempts) });
    return { claimed: true, record: rowToRecord(stolen.rows[0]) };
  }

  const existing = await pool.query('SELECT * FROM order_fulfilments WHERE ref = $1', [input.ref]);
  if (!existing.rows[0]) {
    /* The row was deleted between the two statements — vanishingly unlikely,
     * and retrying is the honest answer rather than pretending it was a dup. */
    throw new FulfilmentError('FULFILMENT_RACE', 'تحویل هم‌زمان در جریان است؛ دوباره تلاش کن.');
  }
  return { claimed: false, record: rowToRecord(existing.rows[0]) };
}

async function claimMem(input: ClaimInput): Promise<ClaimResult> {
  const found = mem.get(input.ref);
  if (!found) {
    const record: FulfilmentRecord = {
      ref: input.ref, userId: input.userId, source: input.source, status: 'pending',
      kind: input.kind, category: '', currency: 'cash', amountToman: 0,
      paymentRef: input.paymentRef, order: input.order ?? {}, payload: null,
      attempts: 0, claimedAt: nowIso(), createdAt: nowIso()
    };
    mem.set(input.ref, record);
    return { claimed: true, record: { ...record } };
  }
  if (found.status === 'pending' && Date.parse(found.claimedAt) < Date.now() - LEASE_MS) {
    found.claimedAt = nowIso();
    found.attempts += 1;
    logger.warn('fulfilment_claim_taken_over', { ref: input.ref, attempts: found.attempts });
    return { claimed: true, record: { ...found } };
  }
  return { claimed: false, record: { ...found } };
}

/** The goods are handed over. Records what the player got and what it was worth. */
export async function complete(ref: string, input: CompleteInput = {}): Promise<FulfilmentRecord | null> {
  const key = validateRef(ref);
  const amount = Math.max(0, Math.round(Number(input.amountToman) || 0));
  const currency = input.currency === 'coins' ? 'coins' : 'cash';
  const category = String(input.category ?? '').slice(0, 40);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `UPDATE order_fulfilments
          SET status='done', delivered_at=now(), payload=$2, amount_toman=$3, currency=$4, category=$5, last_error=NULL
        WHERE ref=$1 AND status='pending' RETURNING *`,
      [key, JSON.stringify(input.payload ?? null), amount, currency, category]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }
  const found = mem.get(key);
  if (!found || found.status !== 'pending') return null;
  found.status = 'done';
  found.deliveredAt = nowIso();
  found.payload = input.payload ?? null;
  found.amountToman = amount;
  found.currency = currency;
  found.category = category;
  found.lastError = undefined;
  return { ...found };
}

/**
 * Nothing happened — the purchase was refused before any money moved (an item
 * that does not exist, a balance too small). The reference is freed rather than
 * marked, because the player retrying the same tap must get the same honest
 * error, not "already in progress".
 */
export async function discard(ref: string): Promise<void> {
  const key = validateRef(ref);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`DELETE FROM order_fulfilments WHERE ref=$1 AND status='pending' AND delivered_at IS NULL`, [key]);
    return;
  }
  const found = mem.get(key);
  if (found && found.status === 'pending' && !found.deliveredAt) mem.delete(key);
}

/**
 * Delivery failed but the payment stands. The row stays `pending`, so once the
 * lease expires another attempt may finish what the player paid for.
 */
export async function fail(ref: string, message: string): Promise<void> {
  const key = validateRef(ref);
  const err = String(message ?? '').slice(0, 500);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`UPDATE order_fulfilments SET last_error=$2 WHERE ref=$1 AND status='pending'`, [key, err]);
  } else {
    const found = mem.get(key);
    if (found && found.status === 'pending') found.lastError = err;
  }
  logger.error('fulfilment_failed', { ref: key, message: err });
}

/**
 * The payment behind this reference was reversed (the صندوق was refunded), so
 * nothing is owed and the reference must never look deliverable again.
 */
export async function voidRef(ref: string, reason: string): Promise<void> {
  const key = validateRef(ref);
  const why = String(reason ?? '').slice(0, 500);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`UPDATE order_fulfilments SET status='void', last_error=$2 WHERE ref=$1 AND status='pending'`, [key, why]);
  } else {
    const found = mem.get(key);
    if (found && found.status === 'pending') { found.status = 'void'; found.lastError = why; }
  }
  logger.warn('fulfilment_voided', { ref: key, reason: why });
}

export async function find(ref: string): Promise<FulfilmentRecord | null> {
  const key = validateRef(ref);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query('SELECT * FROM order_fulfilments WHERE ref=$1', [key]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }
  const found = mem.get(key);
  return found ? { ...found } : null;
}

/** Test seam. */
export function _resetFulfilments(): void { mem.clear(); }

/** Test seam: age a claim past its lease, so a takeover can be exercised
 *  without a test sitting still for a minute. */
export async function _expireClaim(ref: string): Promise<void> {
  const key = validateRef(ref);
  const past = new Date(Date.now() - LEASE_MS * 2).toISOString();
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`UPDATE order_fulfilments SET claimed_at=$2 WHERE ref=$1`, [key, past]);
    return;
  }
  const found = mem.get(key);
  if (found) found.claimedAt = past;
}
