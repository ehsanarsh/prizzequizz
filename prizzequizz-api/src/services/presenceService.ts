/* WHO IS ACTUALLY HERE.
 *
 * The dashboard has always read "آنلاین (۵ دقیقه)" and DAU out of
 * `game_sessions.last_seen_at`, and nothing in the codebase has ever written a
 * row to that table — only a migration creates it and two queries read it. So
 * both numbers were structurally zero: not "no players right now", but "no
 * player can ever be counted". Worse, the dashboard swallows query errors and
 * shows 0, so a missing table looked exactly like an empty game.
 *
 * Presence is per-USER, not per-match-session, so it lives in its own table
 * with the user id as the primary key — that makes the write a real upsert
 * instead of an ever-growing log nobody prunes.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS user_presence (
    user_id TEXT PRIMARY KEY,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_presence_seen ON user_presence(last_seen_at)`);
  _schemaReady = true;
}

/* Memory fallback, so the numbers are real on a Postgres-less install too. */
const memSeen = new Map<string, number>();

/* One write per user per half-minute at most. Every authenticated request
 * calling this would put a write on the hot path of the whole API for a figure
 * that is only ever read at five-minute resolution. */
const THROTTLE_MS = 30_000;
const lastWrite = new Map<string, number>();

/** Record that this user is here. Never throws — presence must not break a request. */
export async function touchPresence(userId: string): Promise<void> {
  if (!userId) return;
  const now = Date.now();
  const prev = lastWrite.get(userId) ?? 0;
  if (now - prev < THROTTLE_MS) return;
  lastWrite.set(userId, now);
  memSeen.set(userId, now);
  const pool = pg();
  if (!pool) return;
  try {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO user_presence(user_id,last_seen_at) VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()`, [userId]);
  } catch (e) {
    /* A presence write is never worth failing a request over, but silence is
     * how the old zero hid for so long — so it is logged. */
    lastWrite.delete(userId);
    logger.warn('presence_write_failed', { userId, message: e instanceof Error ? e.message : 'unknown' });
  }
}

/** How many distinct users have been seen within the last `minutes`. */
export async function onlineCount(minutes = 5): Promise<number> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT count(*)::int c FROM user_presence WHERE last_seen_at >= now() - ($1 || ' minutes')::interval`,
      [String(Math.max(1, Math.floor(minutes)))]);
    return Number(rows[0]?.c ?? 0) || 0;
  }
  const cutoff = Date.now() - minutes * 60_000;
  let n = 0;
  for (const t of memSeen.values()) if (t >= cutoff) n++;
  return n;
}

/** Distinct users seen since local midnight — the day's active players. */
export async function activeTodayCount(): Promise<number> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT count(*)::int c FROM user_presence WHERE last_seen_at >= current_date`);
    return Number(rows[0]?.c ?? 0) || 0;
  }
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  let n = 0;
  for (const t of memSeen.values()) if (t >= midnight.getTime()) n++;
  return n;
}

/** Test seam. */
export function _resetPresence(): void { memSeen.clear(); lastWrite.clear(); }
