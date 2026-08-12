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

/* HOW RECENTLY EACH OF THESE PEOPLE WAS HERE.
 *
 * The friends list needs this per-person, not as a total. Presence is written
 * at most once every THROTTLE_MS, so a green light must tolerate a gap that
 * size — ONLINE_MINUTES is comfortably larger, and anyone genuinely gone drops
 * off within five minutes of closing the game.
 *
 * Ids that have never been seen are simply absent from the map; the caller
 * reads that as offline, which is what it means.
 */
export const ONLINE_MINUTES = 5;

export async function lastSeenFor(userIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const ids = Array.from(new Set(userIds.map((i) => String(i)).filter(Boolean)));
  if (!ids.length) return out;
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(
        `SELECT user_id, last_seen_at FROM user_presence WHERE user_id = ANY($1::text[])`, [ids]);
      for (const r of rows) {
        const d = r.last_seen_at instanceof Date ? r.last_seen_at : new Date(r.last_seen_at);
        if (!isNaN(d.getTime())) out.set(String(r.user_id), d);
      }
      return out;
    } catch (e) {
      /* Falling through to memory would report everyone offline on a database
       * that is merely slow; saying so is better than a silently dark list. */
      logger.warn('presence_read_failed', { message: e instanceof Error ? e.message : 'unknown' });
      return out;
    }
  }
  for (const id of ids) { const t = memSeen.get(id); if (t) out.set(id, new Date(t)); }
  return out;
}

/* WHO is here, not how many. The "افراد آنلاین" panel needs the ids themselves,
 * and it needs MORE of them than it shows: the list is then narrowed by gender
 * and by who the player has already seen, so asking for exactly ten would leave
 * it short every time. */
export async function onlineUserIds(limit = 200, minutes = ONLINE_MINUTES): Promise<string[]> {
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(
        `SELECT user_id FROM user_presence
          WHERE last_seen_at >= now() - ($1 || ' minutes')::interval
          ORDER BY last_seen_at DESC LIMIT $2`,
        [String(Math.max(1, Math.floor(minutes))), Math.max(1, Math.floor(limit))]);
      return rows.map((r) => String(r.user_id));
    } catch (e) {
      logger.warn('presence_list_failed', { message: e instanceof Error ? e.message : 'unknown' });
      return [];
    }
  }
  const cutoff = Date.now() - minutes * 60_000;
  return [...memSeen.entries()]
    .filter(([, t]) => t >= cutoff)
    .sort((x, y) => y[1] - x[1])
    .slice(0, Math.max(1, Math.floor(limit)))
    .map(([id]) => id);
}

/** Is a last-seen stamp recent enough to call someone online? */
export function isOnline(seen: Date | null | undefined, minutes = ONLINE_MINUTES): boolean {
  if (!seen) return false;
  return Date.now() - seen.getTime() <= minutes * 60_000;
}

/** Test seam. */
export function _resetPresence(): void { memSeen.clear(); lastWrite.clear(); }

/** Test seam: pretend someone was seen at a given moment. */
export function _seed(userId: string, at: Date = new Date()): void { memSeen.set(userId, at.getTime()); }
