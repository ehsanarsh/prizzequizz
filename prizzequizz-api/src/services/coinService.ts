/* MOVING COINS, WITHOUT TWO MOVES CANCELLING EACH OTHER OUT.
 *
 * Every place that spent or granted coins did the same three steps by hand:
 * read the user, work out the new figure, write the whole user back. Between
 * the read and the write is a gap, and in that gap another request is reading
 * the same figure — so two grants landing together keep only one of them, and
 * two spends together charge for only one. Neither leaves a trace: the numbers
 * are simply wrong afterwards and nothing says why.
 *
 * Writing the WHOLE user back makes it worse than a coin problem. `save(user)`
 * rewrites every column from a snapshot taken before the gap, so a purchase
 * that touches coins can just as easily put back a stale heart count or undo
 * the XP a match awarded in between.
 *
 * So coins move here, and only here, in ONE statement:
 *
 *     UPDATE users SET coins = coins + delta WHERE id = ? AND coins + delta >= 0
 *
 * The database does the arithmetic on the row it is holding, so there is no gap
 * to lose anything in, and no other column is touched. The `>= 0` is what makes
 * spending safe: "can they afford it" and "take it" stop being two steps that
 * something can happen between — a refusal means the money was never taken.
 *
 * Without DATABASE_URL the same promise is kept with a per-user mutex.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { logger } from './logger.js';

/** Refused because it would leave the player owing coins. */
export const NOT_ENOUGH = null;

function pgAvailable(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

/* WHY THE MEMORY DRIVER NEEDS NO LOCK, which is worth saying because it looks
 * like it should. `findById` there hands back the LIVE row out of the map, not
 * a copy, and nothing below awaits between reading the number and writing it —
 * so the change is already applied by the time anything else can run. A mutex
 * was written here first and then removed: no test could reach it, because
 * there is no window for it to close. If that repository is ever changed to
 * hand back copies, this stops being true, which is what the test «two
 * movements at once on the memory driver» is there to catch. */

/**
 * Add `delta` coins (negative to spend).
 *
 * @returns the balance afterwards, or `null` when a spend was refused because
 *          the player does not have it — in which case NOTHING was taken.
 */
export async function addCoins(userId: string, delta: number): Promise<number | null> {
  const d = Math.round(Number(delta) || 0);   // coins move in whole numbers
  const pool = pgAvailable();
  if (pool) {
    try {
      const { rows } = await pool.query(
        `UPDATE users SET coins = coins + $2, updated_at = now()
           WHERE id = $1 AND coins + $2 >= 0
         RETURNING coins`,
        [userId, d]
      );
      /* No row back means nothing changed — they cannot afford it, or there is
       * no such player. Either way nothing was taken, which is the only thing
       * the caller has to know; every caller here has already established that
       * the player exists before it tries to charge them. */
      return rows.length ? Number(rows[0].coins) || 0 : null;
    } catch (e) {
      logger.error('coin_adjust_failed', { userId, delta: d, message: e instanceof Error ? e.message : 'unknown' });
      throw e;
    }
  }
  const u = await repositories.users.findById(userId);
  if (!u) return null;
  const now = Number(u.coins) || 0;
  if (now + d < 0) return null;
  u.coins = now + d;
  await repositories.users.save(u);
  return u.coins;
}

/** What they have right now. */
export async function getCoins(userId: string): Promise<number> {
  const pool = pgAvailable();
  if (pool) {
    try {
      const { rows } = await pool.query(`SELECT coins FROM users WHERE id = $1`, [userId]);
      return rows.length ? Number(rows[0].coins) || 0 : 0;
    } catch { /* fall through to the repository */ }
  }
  const u = await repositories.users.findById(userId);
  return Number(u?.coins ?? 0) || 0;
}

/* ---------------------------------------------------------------------------
 * THE SAME PROBLEM, THE OTHER BALANCES.
 *
 * Coins were only half of it. `save(user)` writes EVERY column from a snapshot,
 * so anything else that reads a user, changes one number and saves them back
 * puts the other numbers back too — as they were before whatever else happened
 * in between. Three purchases at once left one of them unpaid not because the
 * coin arithmetic was wrong, but because the heart the item granted was saved
 * on top of it and carried an older coin figure along for the ride.
 *
 * The repository already knows this: `updateLifelines` exists precisely so the
 * main user write never clobbers the lifeline inventory. These are the same
 * thing for the numbers that move on their own.
 * ------------------------------------------------------------------------- */

const NUMERIC_COLUMN: Record<string, string> = { hearts: 'hearts', xp: 'xp', weeklyScore: 'weekly_score' };

/** Write ONE number, leaving every other column alone. Used where the new value
 *  is computed rather than a simple delta — hearts, for instance, are worked
 *  out from regeneration first and the figure must survive that arithmetic. */
export async function setUserNumber(userId: string, field: keyof typeof NUMERIC_COLUMN, value: number): Promise<void> {
  const col = NUMERIC_COLUMN[field];
  if (!col) throw new Error('setUserNumber: unknown field ' + String(field));
  const v = Math.max(0, Math.round(Number(value) || 0));
  const pool = pgAvailable();
  if (pool) {
    try { await pool.query(`UPDATE users SET ${col} = $2, updated_at = now() WHERE id = $1`, [userId, v]); return; }
    catch (e) { logger.error('user_number_set_failed', { userId, field, message: e instanceof Error ? e.message : 'unknown' }); throw e; }
  }
  const u = await repositories.users.findById(userId);
  if (!u) return;
  (u as any)[field] = v;
  await repositories.users.save(u);
}

/** Add to one number, leaving every other column alone. */
export async function addUserNumber(userId: string, field: keyof typeof NUMERIC_COLUMN, delta: number): Promise<void> {
  const col = NUMERIC_COLUMN[field];
  if (!col) throw new Error('addUserNumber: unknown field ' + String(field));
  const d = Math.round(Number(delta) || 0);
  if (!d) return;
  const pool = pgAvailable();
  if (pool) {
    try { await pool.query(`UPDATE users SET ${col} = GREATEST(0, ${col} + $2), updated_at = now() WHERE id = $1`, [userId, d]); return; }
    catch (e) { logger.error('user_number_add_failed', { userId, field, message: e instanceof Error ? e.message : 'unknown' }); throw e; }
  }
  const u = await repositories.users.findById(userId);
  if (!u) return;
  (u as any)[field] = Math.max(0, (Number((u as any)[field]) || 0) + d);
  await repositories.users.save(u);
}

/** Test seam. Kept as a no-op so callers need not care which driver is in use. */
export function _resetCoinLocks(): void { /* nothing is held between runs */ }
