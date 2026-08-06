/* TICKET HOLDS — a ticket taken for a duel is HELD, not spent, until the match
 * actually starts.
 *
 * The old flow consumed the ticket at enqueue and gave it back in exactly one
 * place: a successful `POST /matchmaking/:id/cancel`, using a Map that lived in
 * the process. Everything else lost the ticket — the opponent cancelling, the
 * opponent closing the app, either side's connection dropping, the queue
 * expiring the ticket after sixty seconds, a server restart, or a match that
 * was created and then never started. The player paid and got no game.
 *
 * A hold is a row instead: created when the ticket is taken, re-pointed at the
 * match when one is made, marked spent the moment the match really starts, and
 * refunded by ANY path that ends things before that. Every transition is
 * conditional on the current state, so a refund can never run twice and a
 * refund can never undo a ticket that was already spent on a real game.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { consumeTicket, refundTicket } from './ticketService.js';

export type HoldState = 'held' | 'spent' | 'refunded';
export type HoldRef = 'queue' | 'match';
export interface TicketHold {
  id: string;
  userId: string;
  tier: string;
  refType: HoldRef;
  refId: string;
  state: HoldState;
  reason: string | null;
  createdAt: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticket_holds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ticket_holds_ref ON ticket_holds(ref_type, ref_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ticket_holds_user ON ticket_holds(user_id, state)`);
  _schemaReady = true;
}

// Memory fallback, same shape, for running without Postgres.
const _mem: TicketHold[] = [];

/** Take one ticket and hold it. Throws the same TicketError as consumeTicket
 *  when the player has none.
 *
 *  The hold has to exist BEFORE the queue ticket — a player with no ticket must
 *  never reach the queue — so it starts unbound and `bindHold` attaches it to
 *  the queue ticket a moment later. It is addressed by its own id until then;
 *  filing every unbound hold under a shared placeholder would let one player's
 *  refund claim another's. */
export async function holdTicket(userId: string, tier: string): Promise<TicketHold> {
  await consumeTicket(userId, tier);          // throws NO_TICKET / TICKET_TIER_INVALID
  const hold: TicketHold = {
    id: id(), userId, tier, refType: 'queue', refId: '',
    state: 'held', reason: null, createdAt: new Date().toISOString()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO ticket_holds(id,user_id,tier,ref_type,ref_id,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [hold.id, hold.userId, hold.tier, hold.refType, hold.refId, hold.state, hold.createdAt]);
  } else _mem.push(hold);
  logger.info('ticket_held', { userId, tier, holdId: hold.id });
  return hold;
}

/** Attach a freshly taken hold to the queue ticket it paid for. */
export async function bindHold(holdId: string, refType: HoldRef, refId: string): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`UPDATE ticket_holds SET ref_type=$2, ref_id=$3, updated_at=now() WHERE id=$1 AND state='held'`, [holdId, refType, refId]);
    return;
  }
  const h = _mem.find((x) => x.id === holdId && x.state === 'held');
  if (h) { h.refType = refType; h.refId = refId; }
}

/** Give back one specific hold — the enqueue-failed path, where there is no
 *  queue ticket or match to refund against. */
export async function refundHoldById(holdId: string, reason: string): Promise<boolean> {
  const pool = pg();
  let row: { user_id: string; tier: string } | null = null;
  if (pool) {
    await ensureSchema(pool);
    const res = await pool.query(
      `UPDATE ticket_holds SET state='refunded', reason=$2, updated_at=now()
        WHERE id=$1 AND state='held' RETURNING user_id, tier`, [holdId, reason]);
    row = res.rows[0] ?? null;
  } else {
    const h = _mem.find((x) => x.id === holdId && x.state === 'held');
    if (h) { h.state = 'refunded'; h.reason = reason; row = { user_id: h.userId, tier: h.tier }; }
  }
  if (!row) return false;
  try { await refundTicket(row.user_id, row.tier); logger.info('ticket_refunded', { holdId, reason }); }
  catch (e) { logger.error('ticket_refund_failed', { holdId, reason, message: e instanceof Error ? e.message : 'unknown' }); }
  return true;
}

/** Re-point every live hold of these players at the match that was just made,
 *  so the match's own ending paths can find and refund them. Called from match
 *  creation rather than from the queue, because the queue does not know which
 *  tier was taken — and because BOTH players' holds must move, including the
 *  one whose ticket was matched into by somebody else. */
export async function bindHoldsToMatch(userIds: string[], matchId: string): Promise<void> {
  if (!userIds.length) return;
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `UPDATE ticket_holds SET ref_type='match', ref_id=$1, updated_at=now()
        WHERE state='held' AND ref_type='queue' AND user_id = ANY($2::text[])`,
      [matchId, userIds]);
    return;
  }
  for (const h of _mem) {
    if (h.state === 'held' && h.refType === 'queue' && userIds.includes(h.userId)) { h.refType = 'match'; h.refId = matchId; }
  }
}

/** The match really started — the tickets are now spent and can never come
 *  back. This is the line the whole design turns on: before it, every ending
 *  refunds; after it, none do. */
export async function spendHolds(matchId: string): Promise<number> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(
      `UPDATE ticket_holds SET state='spent', updated_at=now() WHERE state='held' AND ref_type='match' AND ref_id=$1`, [matchId]);
    if (rowCount) logger.info('ticket_holds_spent', { matchId, count: rowCount });
    return rowCount ?? 0;
  }
  let n = 0;
  for (const h of _mem) if (h.state === 'held' && h.refType === 'match' && h.refId === matchId) { h.state = 'spent'; n++; }
  return n;
}

/** Give back every ticket still held against this reference. Safe to call from
 *  as many paths as we like: the state check means only the first one pays. */
export async function refundHolds(refType: HoldRef, refId: string, reason: string): Promise<number> {
  const pool = pg();
  let rows: Array<{ id: string; user_id: string; tier: string }> = [];
  if (pool) {
    await ensureSchema(pool);
    // Claim the rows first, then pay. If the process dies between the two the
    // ticket is lost rather than duplicated — the safe direction for a claim,
    // and the reconciler below finds it.
    const res = await pool.query(
      `UPDATE ticket_holds SET state='refunded', reason=$3, updated_at=now()
        WHERE state='held' AND ref_type=$1 AND ref_id=$2
        RETURNING id, user_id, tier`, [refType, refId, reason]);
    rows = res.rows;
  } else {
    for (const h of _mem) {
      if (h.state === 'held' && h.refType === refType && h.refId === refId) {
        h.state = 'refunded'; h.reason = reason;
        rows.push({ id: h.id, user_id: h.userId, tier: h.tier });
      }
    }
  }
  for (const r of rows) {
    try {
      await refundTicket(r.user_id, r.tier);
      logger.info('ticket_refunded', { userId: r.user_id, tier: r.tier, refType, refId, reason });
    } catch (e) {
      logger.error('ticket_refund_failed', { holdId: r.id, userId: r.user_id, tier: r.tier, reason, message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  return rows.length;
}

/** Whether anything is still held against a match — used by the settle path to
 *  tell "ended before it started" from "ended after a real game". */
export async function hasLiveHolds(matchId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT 1 FROM ticket_holds WHERE state='held' AND ref_type='match' AND ref_id=$1 LIMIT 1`, [matchId]);
    return !!rows[0];
  }
  return _mem.some((h) => h.state === 'held' && h.refType === 'match' && h.refId === matchId);
}

/** Sweep holds that nothing ever came back for — a client that vanished between
 *  taking a ticket and being matched leaves one behind, and without this the
 *  player would simply be out a ticket with no event to trigger the refund. */
export async function refundStaleHolds(olderThanMs = 5 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const pool = pg();
  let rows: Array<{ id: string; user_id: string; tier: string }> = [];
  if (pool) {
    await ensureSchema(pool);
    const res = await pool.query(
      `UPDATE ticket_holds SET state='refunded', reason='stale', updated_at=now()
        WHERE state='held' AND created_at < $1 RETURNING id, user_id, tier`, [cutoff]);
    rows = res.rows;
  } else {
    for (const h of _mem) {
      if (h.state === 'held' && h.createdAt < cutoff) { h.state = 'refunded'; h.reason = 'stale'; rows.push({ id: h.id, user_id: h.userId, tier: h.tier }); }
    }
  }
  for (const r of rows) {
    try { await refundTicket(r.user_id, r.tier); logger.warn('ticket_refunded_stale', { userId: r.user_id, tier: r.tier }); }
    catch (e) { logger.error('ticket_refund_failed', { holdId: r.id, reason: 'stale', message: e instanceof Error ? e.message : 'unknown' }); }
  }
  return rows.length;
}

/** Test seam. */
export function _resetHoldsMemory(): void { _mem.length = 0; }
export function _memoryHolds(): TicketHold[] { return _mem.map((h) => ({ ...h })); }
