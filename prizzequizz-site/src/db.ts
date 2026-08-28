/* The site's database handle.
 *
 * Deliberately its own pool, with its own `application_name`, even though it
 * points at the same Postgres as the game. Two reasons: a slow query on the
 * site can never eat a connection the game needed, and `pg_stat_activity`
 * shows at a glance which process is responsible for what.
 *
 * The site WRITES only its own three tables — site_pages, site_posts,
 * site_settings. It also READS a few of the game's (users, matches) to show the
 * real leaderboard and recent winners on the home page; every one of those
 * statements is a SELECT inside a READ ONLY transaction with its own timeout,
 * and they all live in live.ts. Nothing here writes to the game's schema, which
 * is what makes it safe to run beside a live game.
 */
import pg from 'pg';

const { Pool } = pg;
let pool: pg.Pool | null = null;

export function getPgPool(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  pool ??= new Pool({
    connectionString: process.env.DATABASE_URL,
    /* Small on purpose. This process serves pages, not a game loop; leaving
     * headroom in the shared server's connection limit matters more than the
     * site's own throughput. */
    max: Number(process.env.SITE_PG_POOL_MAX ?? 4),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'prizzequizz-site'
  });
  return pool;
}

export async function closePgPool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
