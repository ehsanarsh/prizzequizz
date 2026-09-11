/* THE PAYMENT SESSION — and the one index that makes the whole scheme work.
 *
 * A card-to-card transfer carries no message: the payer cannot attach an order
 * number, and the bank's own reference is invented at transfer time, so it
 * cannot be handed out in advance. The ONLY identifier we can put in the
 * player's hands before they pay is the amount itself. Which means the amount
 * has to be unique — and "has to be" is worth exactly nothing unless something
 * enforces it.
 *
 *   CREATE UNIQUE INDEX c2c_amount_unique ON c2c_sessions(card_id, amount_rial)
 *     WHERE status IN ('AWAITING','EXPIRED','CANCELLED');
 *
 * That index is the enforcement. The allocator only proposes candidates; the
 * database decides. With any number of API processes and any number of
 * simultaneous requests, two live sessions on one card cannot share an amount.
 *
 * The second thing this file exists to say is that a session EXPIRING and its
 * amount being RELEASED are different events, minutes to hours apart:
 *
 *   AWAITING   the player is looking at the payment page
 *   EXPIRED    their time ran out — but the amount is STILL reserved
 *   CANCELLED  they backed out — also still reserved, for a cool-down
 *   RELEASED   the reservation is over and the amount may be handed out again
 *
 * CANCELLED holds its amount for the same reason: «انصراف» followed by a
 * transfer anyway is a thing people do, and without the cool-down a cancel
 * would also be a way to churn through the amount space on purpose.
 *
 * Without that gap, a payment made just after the deadline gets matched to
 * whoever was given the same amount next. That is why the index predicate
 * covers all three of the reserving states rather than only the live one.
 */
import { getPgPool } from '../../database/postgres.js';
import { id } from '../../utils/id.js';

export const SESSION_STATUSES = ['AWAITING', 'EXPIRED', 'RELEASED', 'PAID', 'CANCELLED', 'REVIEW'] as const;
export type C2cSessionStatus = (typeof SESSION_STATUSES)[number];

/** The statuses that still hold their amount. Must match the index predicate. */
export const RESERVING_STATUSES: C2cSessionStatus[] = ['AWAITING', 'EXPIRED', 'CANCELLED'];
/** Repeated verbatim in the index predicate and the ON CONFLICT clause below. */
export const RESERVING_SQL = `status IN ('AWAITING','EXPIRED','CANCELLED')`;

export interface C2cSession {
  id: string;
  intentId: string | null;
  userId: string;
  cardId: string;
  baseAmountToman: number;
  amountRial: number;
  suffixRial: number;
  trackingCode: string;
  status: C2cSessionStatus;
  expiresAt: string;
  reservedUntil: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewSession {
  intentId?: string | null;
  userId: string;
  cardId: string;
  baseAmountToman: number;
  amountRial: number;
  suffixRial: number;
  expiresAt: string;
  reservedUntil: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
export async function ensureSessionSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS c2c_sessions (
      id TEXT PRIMARY KEY,
      intent_id UUID,
      user_id UUID NOT NULL REFERENCES users(id),
      card_id TEXT NOT NULL REFERENCES c2c_cards(id),
      base_amount_toman BIGINT NOT NULL CHECK (base_amount_toman > 0),
      amount_rial BIGINT NOT NULL CHECK (amount_rial > 0),
      suffix_rial INT NOT NULL CHECK (suffix_rial > 0),
      tracking_code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AWAITING',
      expires_at TIMESTAMPTZ NOT NULL,
      reserved_until TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS c2c_amount_unique
      ON c2c_sessions(card_id, amount_rial) WHERE status IN ('AWAITING','EXPIRED','CANCELLED');
    CREATE UNIQUE INDEX IF NOT EXISTS c2c_tracking_unique ON c2c_sessions(tracking_code);
    CREATE INDEX IF NOT EXISTS idx_c2c_sessions_sweep ON c2c_sessions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_c2c_sessions_user ON c2c_sessions(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_c2c_sessions_match ON c2c_sessions(amount_rial, status);
    /* The retry lookup — see database/migrations/029. Partial, because only
     * live sessions are ever asked for by intent. */
    CREATE INDEX IF NOT EXISTS idx_c2c_sessions_intent ON c2c_sessions(intent_id) WHERE status = 'AWAITING';
  `);
  _schemaReady = true;
}

/* Ambiguous glyphs are left out: this code is read aloud to support and typed
 * back by hand, and 0/O, 1/I/L are where that goes wrong. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newTrackingCode(): string {
  let out = '';
  for (let i = 0; i < 5; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return 'PQ-' + out;
}

// ---------------------------------------------------------------------------
// In-memory driver — same semantics, including the uniqueness the index gives.
// ---------------------------------------------------------------------------
const mem = new Map<string, C2cSession>();

function memAmountTaken(cardId: string, amountRial: number): boolean {
  for (const s of mem.values()) {
    if (s.cardId === cardId && s.amountRial === amountRial && RESERVING_STATUSES.includes(s.status)) return true;
  }
  return false;
}

function rowToSession(r: any): C2cSession {
  return {
    id: r.id, intentId: r.intent_id ?? null, userId: String(r.user_id), cardId: r.card_id,
    baseAmountToman: Number(r.base_amount_toman), amountRial: Number(r.amount_rial),
    suffixRial: Number(r.suffix_rial), trackingCode: r.tracking_code, status: r.status,
    expiresAt: r.expires_at?.toISOString?.() ?? String(r.expires_at),
    reservedUntil: r.reserved_until?.toISOString?.() ?? String(r.reserved_until),
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at)
  };
}

/**
 * Claim one amount on one card, or report that it is taken.
 *
 * Returns null — not an error — when the amount is already reserved, because
 * that is an ordinary outcome the allocator answers by trying another
 * candidate, not a failure anyone needs to hear about.
 */
export async function tryInsertSession(input: NewSession): Promise<C2cSession | null> {
  const pool = pg();
  if (pool) {
    await ensureSessionSchema(pool);
    /* The inference clause repeats the index predicate so a clash on the AMOUNT
     * is handled here, while a clash on anything else (a repeated tracking
     * code) still raises — those are different problems and must not be
     * silently folded together. */
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO c2c_sessions(id,intent_id,user_id,card_id,base_amount_toman,amount_rial,suffix_rial,tracking_code,expires_at,reserved_until)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (card_id, amount_rial) WHERE status IN ('AWAITING','EXPIRED','CANCELLED') DO NOTHING
           RETURNING *`,
          [id(), input.intentId ?? null, input.userId, input.cardId, input.baseAmountToman,
           input.amountRial, input.suffixRial, newTrackingCode(), input.expiresAt, input.reservedUntil]);
        return rows[0] ? rowToSession(rows[0]) : null;
      } catch (e: any) {
        /* Only a tracking-code collision is worth retrying; one in seventeen
         * million, and cheaper to retry than to reason about. */
        if (e?.code === '23505' && String(e?.constraint ?? '').includes('tracking')) continue;
        throw e;
      }
    }
    throw new Error('C2C_TRACKING_CODE_EXHAUSTED');
  }

  if (memAmountTaken(input.cardId, input.amountRial)) return null;
  let code = newTrackingCode();
  while ([...mem.values()].some((s) => s.trackingCode === code)) code = newTrackingCode();
  const now = new Date().toISOString();
  const session: C2cSession = {
    id: id(), intentId: input.intentId ?? null, userId: input.userId, cardId: input.cardId,
    baseAmountToman: input.baseAmountToman, amountRial: input.amountRial, suffixRial: input.suffixRial,
    trackingCode: code, status: 'AWAITING',
    expiresAt: input.expiresAt, reservedUntil: input.reservedUntil, createdAt: now, updatedAt: now
  };
  mem.set(session.id, session);
  return session;
}

export async function getSession(sessionId: string): Promise<C2cSession | null> {
  const pool = pg();
  if (pool) {
    await ensureSessionSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM c2c_sessions WHERE id=$1`, [sessionId]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }
  const s = mem.get(sessionId);
  return s ? { ...s } : null;
}

/* The live session for a payment intent, if one was already made.
 *
 * Two taps on «پرداخت» are one payment, not two: without this the second tap
 * burns another slot in the card's amount space and shows a different figure
 * for the same order — and whichever one the player then transfers, the other
 * stays reserved for hours holding an amount nobody will ever send.
 *
 * Only AWAITING counts. An expired session's deadline has passed, so a fresh
 * attempt needs a fresh deadline; the old amount stays reserved and still
 * settles the same intent, which `orderFulfilmentService` keeps to once. */
export async function liveSessionForIntent(intentId: string): Promise<C2cSession | null> {
  const pool = pg();
  if (pool) {
    await ensureSessionSchema(pool);
    const { rows } = await pool.query(
      `SELECT * FROM c2c_sessions WHERE intent_id=$1 AND status='AWAITING' ORDER BY created_at DESC LIMIT 1`,
      [intentId]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }
  const found = [...mem.values()]
    .filter((s) => s.intentId === intentId && s.status === 'AWAITING')
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))[0];
  return found ? { ...found } : null;
}

/** Sessions still holding an amount for this user — the per-user cap counts these. */
export async function reservingSessionsForUser(userId: string): Promise<C2cSession[]> {
  const pool = pg();
  if (pool) {
    await ensureSessionSchema(pool);
    const { rows } = await pool.query(
      `SELECT * FROM c2c_sessions WHERE user_id=$1 AND status='AWAITING' ORDER BY created_at`, [userId]);
    return rows.map(rowToSession);
  }
  return [...mem.values()].filter((s) => s.userId === userId && s.status === 'AWAITING')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function setSessionStatus(sessionId: string, status: C2cSessionStatus): Promise<C2cSession | null> {
  const pool = pg();
  if (pool) {
    await ensureSessionSchema(pool);
    const { rows } = await pool.query(
      `UPDATE c2c_sessions SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [sessionId, status]);
    return rows[0] ? rowToSession(rows[0]) : null;
  }
  const s = mem.get(sessionId);
  if (!s) return null;
  s.status = status;
  s.updatedAt = new Date().toISOString();
  return { ...s };
}

export async function listSessions(filter: { cardId?: string; status?: C2cSessionStatus; limit?: number } = {}): Promise<C2cSession[]> {
  const pool = pg();
  const limit = Math.max(1, Math.min(500, Number(filter.limit ?? 100)));
  if (pool) {
    await ensureSessionSchema(pool);
    const where: string[] = []; const params: any[] = [];
    if (filter.cardId) { params.push(filter.cardId); where.push(`card_id=$${params.length}`); }
    if (filter.status) { params.push(filter.status); where.push(`status=$${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM c2c_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return rows.map(rowToSession);
  }
  return [...mem.values()]
    .filter((s) => (!filter.cardId || s.cardId === filter.cardId) && (!filter.status || s.status === filter.status))
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
    .slice(0, limit);
}

/** Memory-driver half of the daily cap. */
export function _memPaidTodayRial(cardId: string): number {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  let sum = 0;
  for (const s of mem.values()) {
    if (s.cardId === cardId && s.status === 'PAID' && Date.parse(s.updatedAt) >= dayStart.getTime()) sum += s.amountRial;
  }
  return sum;
}

/** Test seam. */
export function _resetSessions(): void { mem.clear(); _schemaReady = false; }

/* Test seam: move a session's deadline, on whichever driver is running.
 * The alternative is a test that sleeps for the shortest configurable TTL —
 * one minute — which is not a test anybody runs. */
export async function _setExpiresAt(sessionId: string, iso: string): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSessionSchema(pool);
    await pool.query(`UPDATE c2c_sessions SET expires_at=$2 WHERE id=$1`, [sessionId, iso]);
    return;
  }
  const s = mem.get(sessionId);
  if (s) s.expiresAt = iso;
}
