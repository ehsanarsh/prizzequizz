/* The site's database handle.
 *
 * Deliberately its own pool, with its own `application_name`, even though it
 * points at the same Postgres as the game. Two reasons: a slow query on the
 * site can never eat a connection the game needed, and `pg_stat_activity`
 * shows at a glance which process is responsible for what.
 *
 * The site only ever touches its own three tables — site_pages, site_posts,
 * site_settings. It reads nothing from the game's schema and writes nothing to
 * it, which is what makes it safe to run beside a live game.
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
