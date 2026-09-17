/* «پشتیبان پیامت را خواند.»
 *
 * «برای پشتیبانی مهم نیست کاربر سین کرده یا نه؛ برای کاربر مهمه که پشتیبان سین
 *  کرده یا نه.»
 *
 * So this is deliberately ONE-WAY. A support desk does not need to know whether
 * the player has read the answer — they will reply or they will not. The player
 * waiting to hear back is the one for whom «it has been read» is the difference
 * between silence and being ignored.
 *
 * It keeps its own table rather than adding a column to the ticket: a ticket is
 * written by four different code paths and read by a row mapper that lists its
 * columns by hand, and threading a new field through all of that to store one
 * timestamp is a lot of surface for a small fact. This owns the fact instead.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

/* Without a database the marks live here, which is right for tests and for the
 * memory driver: nothing is lost that a restart would not lose anyway. */
const mem = new Map<string, number>();

let _ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  const pool = pg();
  if (!pool) return Promise.resolve();
  if (!_ready) {
    /* Runtime, not a migration: the server ships as a built `dist/` and
       migrations do not travel with it. */
    _ready = pool.query(`
      CREATE TABLE IF NOT EXISTS support_seen (
        ticket_id TEXT PRIMARY KEY,
        support_read_at BIGINT NOT NULL
      )`).then(() => undefined)
      .catch((e) => { _ready = null; logger.warn('support_seen_schema_failed', { message: e instanceof Error ? e.message : 'unknown' }); });
  }
  return _ready;
}

/* THE MARK ONLY EVER MOVES FORWARD.
 * An admin opening an old ticket after a newer one must not pull the mark back
 * and un-read messages the player has already been told were read. */
export async function markSupportRead(ticketId: string, at = Date.now()): Promise<void> {
  if (!ticketId) return;
  const prev = mem.get(ticketId) ?? 0;
  if (at > prev) mem.set(ticketId, at);
  const pool = pg(); if (!pool) return;
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO support_seen(ticket_id, support_read_at) VALUES ($1,$2)
       ON CONFLICT (ticket_id) DO UPDATE SET support_read_at = GREATEST(support_seen.support_read_at, $2)`,
      [ticketId, at]);
  } catch (e) {
    logger.warn('support_seen_write_failed', { ticketId, message: e instanceof Error ? e.message : 'unknown' });
  }
}

/** When support last had this ticket open, or null if they never have. */
export async function supportReadAt(ticketId: string): Promise<string | null> {
  if (!ticketId) return null;
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema();
      const { rows } = await pool.query(`SELECT support_read_at FROM support_seen WHERE ticket_id=$1`, [ticketId]);
      if (rows[0]) return new Date(Number(rows[0].support_read_at)).toISOString();
    } catch { /* fall through to memory */ }
  }
  const m = mem.get(ticketId);
  return m ? new Date(m).toISOString() : null;
}

/** Test seam. */
export function _resetSupportSeen(): void { mem.clear(); _ready = null; }
