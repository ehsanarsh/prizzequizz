/* Friendship lookups for code outside the friends module.
 *
 * The friends REST routes own the `friendships` table and query it directly.
 * This is the one question the rest of the game needs to ask of it — "are these
 * two on each other's list?" — which the duel needs so «با یک دوست بازی کن»
 * can tell a friendly match from a matchmade stranger. */
import { getPgPool } from '../database/postgres.js';

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

/** True when an ACCEPTED friendship exists in either direction. Never throws:
 *  a lookup failure means "not known to be friends", not a broken match. */
export async function areFriends(a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const pool = pg();
  if (!pool) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM friendships
        WHERE status='accepted'
          AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1))
        LIMIT 1`, [a, b]);
    return !!rows[0];
  } catch { return false; }
}
