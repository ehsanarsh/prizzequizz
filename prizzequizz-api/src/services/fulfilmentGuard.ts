/* DELIVERING EXACTLY ONCE, EVEN ACROSS A RESTART.
 *
 * A gateway calls back more than once. That is not a fault — it is how a
 * gateway makes sure a payment is never lost: it keeps calling until it is
 * answered, and a card-to-card gateway keeps calling for a long time. So the
 * question is never "will the callback arrive twice", it is "what stops the
 * second one handing over a second ticket".
 *
 * The old answer was a `Set` in the process's memory. It was honest about its
 * own gap — a restart between two callbacks for the same payment emptied the
 * Set, and the next callback granted again. With a sandbox that was a
 * curiosity. With real money arriving from a card it is a leak: deploy while a
 * callback is being retried and the house pays twice.
 *
 * So the mark lives in Postgres now, where it survives the process:
 *
 *   claim(ref)    → fresh:true  you won; go and deliver, then settle()
 *                   fresh:false someone else won; `payload` is what they
 *                               delivered (null if they are still at it)
 *   settle(ref,p) → done, and `p` is what a later duplicate gets told
 *   abandon(ref)  → delivery failed; let a retry have another go
 *
 * The claim is one INSERT ... ON CONFLICT statement, so two callbacks landing
 * on two processes in the same millisecond cannot both win: Postgres locks the
 * conflicting row and the loser's condition is re-checked against the winner's
 * committed version.
 *
 * THE LEASE. A claim that is never settled would otherwise wedge the payment
 * shut forever — a process killed mid-delivery would leave a player who paid
 * with nothing, silently, and no retry able to help them. So a claim that has
 * sat unsettled longer than the lease can be taken over. The window is set far
 * wider than delivery takes (a handful of writes) precisely so a slow delivery
 * is never stolen from under itself, and every takeover is logged, because a
 * takeover means something crashed.
 *
 * Without DATABASE_URL (tests, local dev) the same rules run in memory.
 */
import { createHash } from 'node:crypto';
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export interface FulfilmentClaim {
  /** True when THIS caller owns the delivery and must go and do it. */
  fresh: boolean;
  /** What the owner delivered, once it has settled. Null while in flight. */
  payload: unknown | null;
  /** True when this claim was taken over from an owner that never settled. */
  recovered: boolean;
}

/** How long an unsettled claim is respected before a retry may take it over. */
export function leaseMs(): number {
  const raw = Number(process.env.FULFILMENT_LEASE_MS);
  return Number.isFinite(raw) && raw >= 1000 ? Math.floor(raw) : 120_000;
}

/** How long settled marks are kept before being swept. */
function retentionDays(): number {
  const raw = Number(process.env.FULFILMENT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 30;
}

/* A btree index has a size limit and a reference is caller-supplied, so anything
 * long is hashed rather than truncated — truncation would let two different
 * payments share a mark, which is the one thing this file exists to prevent. */
const MAX_REF = 200;
export function normaliseRef(ref: string): string {
  const s = String(ref ?? '').trim();
  if (!s) throw new Error('fulfilment reference is required');
  return s.length <= MAX_REF ? s : 'sha256:' + createHash('sha256').update(s).digest('hex');
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------
let _schemaReady = false;

function pgAvailable(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

/* Runtime-ensured, like the ledger's own schema: a build-and-restart deploy
 * carries dist and nothing else, so a table that only exists in a migration
 * file would not be there when the first callback arrives. */
async function ensureSchema(pool: NonNullable<ReturnType<typeof pgAvailable>>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_fulfilments (
      ref VARCHAR(200) PRIMARY KEY,
      status VARCHAR(12) NOT NULL DEFAULT 'pending',
      payload JSONB,
      claimed_at TIMESTAMP NOT NULL DEFAULT now(),
      settled_at TIMESTAMP,
      takeovers INT NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_order_fulfilments_claimed ON order_fulfilments(claimed_at);
  `);
  _schemaReady = true;
}

/* One statement, one winner.
 *
 * A row comes back only when this caller may deliver: either nothing was there
 * (plain insert) or what was there is an expired pending claim. A settled row,
 * or a pending claim still inside its lease, fails the DO UPDATE condition and
 * returns nothing at all — which is the loser's answer. */
const CLAIM_SQL = `
  INSERT INTO order_fulfilments (ref, status, claimed_at)
  VALUES ($1, 'pending', now())
  ON CONFLICT (ref) DO UPDATE
    SET claimed_at = now(), takeovers = order_fulfilments.takeovers + 1
    WHERE order_fulfilments.status = 'pending'
      AND order_fulfilments.claimed_at < now() - make_interval(secs => $2::double precision)
  RETURNING takeovers`;

// ---------------------------------------------------------------------------
// Memory (dev/tests) — same rules, bounded.
// ---------------------------------------------------------------------------
interface MemMark { status: 'pending' | 'done'; payload: unknown | null; claimedAt: number }
const _mem = new Map<string, MemMark>();
const MEM_MAX = 20_000;

function memTrim(): void {
  if (_mem.size <= MEM_MAX) return;
  /* Insertion-ordered, so the oldest marks go first. Only settled ones are
   * dropped: evicting a live claim would let a duplicate through. */
  for (const [k, v] of _mem) {
    if (_mem.size <= MEM_MAX) break;
    if (v.status === 'done') _mem.delete(k);
  }
}

// ---------------------------------------------------------------------------
// The three operations
// ---------------------------------------------------------------------------

/** Try to become the one caller that delivers `ref`. */
export async function claimFulfilment(ref: string): Promise<FulfilmentClaim> {
  const key = normaliseRef(ref);
  const pool = pgAvailable();
  if (pool) {
    try {
      await ensureSchema(pool);
      const won = await pool.query(CLAIM_SQL, [key, leaseMs() / 1000]);
      if ((won.rowCount ?? 0) > 0) {
        const takeovers = Number(won.rows[0]?.takeovers ?? 0);
        if (takeovers > 0) logger.warn('fulfilment_lease_taken_over', { ref: key, takeovers });
        return { fresh: true, payload: null, recovered: takeovers > 0 };
      }
      const held = await pool.query(`SELECT payload FROM order_fulfilments WHERE ref = $1`, [key]);
      return { fresh: false, payload: held.rows[0]?.payload ?? null, recovered: false };
    } catch (e) {
      /* A guard that fails closed would refuse to deliver what a player has
       * already paid for, so the memory rules take over and the failure is
       * made loud instead of silently doubling or silently refusing. */
      logger.error('fulfilment_guard_pg_failed', { ref: key, message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  const mark = _mem.get(key);
  if (!mark) { _mem.set(key, { status: 'pending', payload: null, claimedAt: Date.now() }); memTrim(); return { fresh: true, payload: null, recovered: false }; }
  if (mark.status === 'pending' && Date.now() - mark.claimedAt >= leaseMs()) {
    mark.claimedAt = Date.now();
    logger.warn('fulfilment_lease_taken_over', { ref: key, takeovers: 1 });
    return { fresh: true, payload: null, recovered: true };
  }
  return { fresh: false, payload: mark.payload, recovered: false };
}

/** Delivered. `payload` is what a later duplicate will be told was handed over. */
export async function settleFulfilment(ref: string, payload?: unknown): Promise<void> {
  const key = normaliseRef(ref);
  const body = payload === undefined ? null : payload;
  const pool = pgAvailable();
  if (pool) {
    try {
      await ensureSchema(pool);
      await pool.query(
        `UPDATE order_fulfilments SET status='done', payload=$2::jsonb, settled_at=now() WHERE ref=$1`,
        [key, body === null ? null : JSON.stringify(body)]
      );
      sweepSometimes(pool);
      return;
    } catch (e) {
      logger.error('fulfilment_guard_pg_failed', { ref: key, message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  _mem.set(key, { status: 'done', payload: body, claimedAt: Date.now() });
  memTrim();
}

/** Delivery failed. Drop the mark so a retry can still give the player what
 *  they paid for. Only an unsettled claim is dropped — a settled delivery is
 *  never un-done by a later failure elsewhere. */
export async function abandonFulfilment(ref: string): Promise<void> {
  const key = normaliseRef(ref);
  const pool = pgAvailable();
  if (pool) {
    try {
      await ensureSchema(pool);
      await pool.query(`DELETE FROM order_fulfilments WHERE ref=$1 AND status='pending'`, [key]);
      return;
    } catch (e) {
      logger.error('fulfilment_guard_pg_failed', { ref: key, message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  const mark = _mem.get(key);
  if (mark && mark.status === 'pending') _mem.delete(key);
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------
let _sweptAt = 0;
const SWEEP_EVERY_MS = 3_600_000;

/* Marks are small and a duplicate only ever arrives within the gateway's retry
 * window, so keeping a month of them costs nothing and answers "was this
 * delivered?" long after the fact. Older settled ones go. */
function sweepSometimes(pool: NonNullable<ReturnType<typeof pgAvailable>>): void {
  const now = Date.now();
  if (now - _sweptAt < SWEEP_EVERY_MS) return;
  _sweptAt = now;
  pool.query(
    `DELETE FROM order_fulfilments WHERE status='done' AND settled_at < now() - make_interval(days => $1::int)`,
    [retentionDays()]
  ).catch((e) => logger.warn('fulfilment_sweep_failed', { message: e instanceof Error ? e.message : 'unknown' }));
}

/** Test seam. Clears both drivers; await it. */
export async function _resetFulfilmentGuard(): Promise<void> {
  _mem.clear();
  _sweptAt = 0;
  const pool = pgAvailable();
  if (!pool) return;
  try { await ensureSchema(pool); await pool.query(`DELETE FROM order_fulfilments`); } catch { /* nothing to clear */ }
}
