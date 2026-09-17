/* BLOCKING SOMEBODY, AND WHAT THAT HAS TO MEAN.
 *
 * «یه بلاک هم بزاریم تا کاربرا بتونن بلاک کنن تا بلاک‌شده نتونه بهشون پیام و
 *  دعوت به بازی بفرسته.»
 *
 * A block that only hides messages is not a block — it is a mute, and the
 * person who asked for it finds out the difference the first time an invitation
 * arrives. So the rule is enforced where things are SENT, not where they are
 * displayed: a blocked person's message is refused by the server, and so is
 * their invitation, their friend request and their duel challenge.
 *
 * IT WORKS IN BOTH DIRECTIONS, and that is deliberate. If A blocks B, then B
 * cannot reach A — obviously — but A also cannot reach B. A one-way block lets
 * somebody block a person and then carry on messaging them, which is a way of
 * making sure the other cannot answer. That is not a safety feature, it is a
 * weapon, and the shape of it is what decides which one you have built.
 *
 * WHAT IT IS NOT: it does not hide the game. Leaderboards, match results and
 * anything else that is simply the state of the world stay as they are —
 * disappearing from a leaderboard would tell the blocked person exactly what
 * happened, and it would let anybody edit what everyone else can see.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

export class BlockError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'BlockError'; }
}

let _ready = false;
async function ensureSchema(): Promise<void> {
  const pool = pg();
  if (!pool || _ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id UUID NOT NULL,
    blocked_id UUID NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (blocker_id, blocked_id))`);
  /* Both directions are asked about on every send, so both are indexed. */
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)`);
  _ready = true;
}

/* The memory fallback keeps the same shape, so a server with no database still
   refuses what it should rather than silently allowing everything. */
const _mem = new Set<string>();
const key = (a: string, b: string) => a + '>' + b;

export async function blockUser(me: string, other: string, reason?: string): Promise<void> {
  if (!me || !other) throw new BlockError('BAD_REQUEST', 'کاربر مشخص نیست.');
  /* «بلاک کردن خودت» is not a thing, and letting it through would quietly cut
     somebody off from their own chat. */
  if (me === other) throw new BlockError('SELF_BLOCK', 'خودت را نمی‌توانی بلاک کنی.');
  await ensureSchema();
  const pool = pg();
  if (pool) {
    await pool.query(
      `INSERT INTO user_blocks(blocker_id, blocked_id, reason) VALUES ($1,$2,$3)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`, [me, other, reason ?? null]);
  } else _mem.add(key(me, other));
  logger.info('user_blocked', { me, other });
}

export async function unblockUser(me: string, other: string): Promise<void> {
  await ensureSchema();
  const pool = pg();
  if (pool) await pool.query(`DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2`, [me, other]);
  else _mem.delete(key(me, other));
}

/** Is there a block between these two, in EITHER direction? */
export async function blockedBetween(a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  await ensureSchema();
  const pool = pg();
  if (pool) {
    const { rows } = await pool.query(
      `SELECT 1 FROM user_blocks
        WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1`, [a, b]);
    return !!rows[0];
  }
  return _mem.has(key(a, b)) || _mem.has(key(b, a));
}

/** Did `me` block `other`? — the only question the UI may answer, because
 *  telling somebody they have BEEN blocked is telling them who did it. */
export async function iBlocked(me: string, other: string): Promise<boolean> {
  if (!me || !other) return false;
  await ensureSchema();
  const pool = pg();
  if (pool) {
    const { rows } = await pool.query(`SELECT 1 FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2 LIMIT 1`, [me, other]);
    return !!rows[0];
  }
  return _mem.has(key(me, other));
}

/** Everyone `me` has blocked, newest first — the list behind «بلاک‌شده‌ها». */
export async function listBlocked(me: string): Promise<Array<{ id: string; username: string; displayName: string; createdAt: string }>> {
  await ensureSchema();
  const pool = pg();
  if (!pool) {
    return [..._mem].filter((k) => k.startsWith(me + '>')).map((k) => ({ id: k.split('>')[1] ?? '', username: '', displayName: '', createdAt: '' }));
  }
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`, [me]);
  return rows.map((r: any) => ({
    id: String(r.id), username: r.username ?? '', displayName: r.display_name ?? '',
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  }));
}

/** Of these people, which are blocked either way — one query for a whole list,
 *  so a friends page does not ask once per row. */
export async function blockedAmong(me: string, others: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!me || !others.length) return out;
  await ensureSchema();
  const pool = pg();
  if (!pool) {
    for (const o of others) if (_mem.has(key(me, o)) || _mem.has(key(o, me))) out.add(o);
    return out;
  }
  const { rows } = await pool.query(
    `SELECT blocker_id, blocked_id FROM user_blocks
      WHERE (blocker_id=$1 AND blocked_id = ANY($2)) OR (blocked_id=$1 AND blocker_id = ANY($2))`,
    [me, others]);
  for (const r of rows) out.add(String(r.blocker_id) === me ? String(r.blocked_id) : String(r.blocker_id));
  return out;
}

/** Test seam. */
export function _resetBlocks(): void { _mem.clear(); _ready = false; }
