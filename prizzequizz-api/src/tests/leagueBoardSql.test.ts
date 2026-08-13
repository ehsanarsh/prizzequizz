/* THE WEEKLY BOARD QUERY, RUN AGAINST A REAL POSTGRES.
 *
 * Production logged «league_board_failed: operator does not exist: uuid !~~
 * unknown» on every request. The cause: the query filtered bots with
 * `id NOT LIKE 'bot\_%'`, and `users.id` is a uuid column — Postgres has no
 * NOT LIKE for uuid. It threw every time, the board fell through to the
 * in-memory path, and a warn line was the only sign.
 *
 * None of the existing league tests caught it, and none could have: they all
 * run on the memory repository, where this SQL is never executed. So this test
 * executes the REAL exported string against a REAL database. Reading the source
 * and asserting it contains `::text` would prove nothing — the mistake was
 * valid TypeScript and valid-looking SQL.
 *
 * Needs a database. Set PGTEST_URL (or DATABASE_URL) to run it; without one it
 * says so and skips rather than passing silently.
 *
 * Run: PGTEST_URL=postgres://... npx tsx src/tests/leagueBoardSql.test.ts
 */
import assert from 'node:assert/strict';
import { WEEKLY_BOARD_SQL } from '../services/leagueService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function run(): Promise<void> {
  const url = process.env.PGTEST_URL || process.env.DATABASE_URL;
  if (!url) {
    console.log('[leagueBoardSql] SKIPPED — no PGTEST_URL/DATABASE_URL. This test needs a real Postgres;');
    console.log('                 the bug it covers is invisible on the memory repository.');
    return;
  }

  const { Pool } = await import('pg');
  const p = new Pool({ connectionString: url });
  /* ONE connection for the whole test: `SET search_path` is per-session, and a
     pool hands out a different session per query — which silently sent later
     queries to a schema that has no users table. */
  const pool = await p.connect();
  const schema = 'lbsql_' + Math.random().toString(36).slice(2, 8);

  try {
    /* A throwaway schema with the exact column types production uses — id is a
       uuid, which is the whole point of the test. */
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`SET search_path TO ${schema}`);
    await pool.query(`CREATE TABLE users (
      id uuid PRIMARY KEY,
      weekly_week text,
      weekly_score integer NOT NULL DEFAULT 0)`);
    await pool.query(`INSERT INTO users (id, weekly_week, weekly_score) VALUES
      (gen_random_uuid(), '2026-W33', 120),
      (gen_random_uuid(), '2026-W33', 80),
      (gen_random_uuid(), '2026-W33', 0),
      (gen_random_uuid(), '2026-W01', 999)`);

    await check('the weekly-board query runs on a uuid id column', async () => {
      /* If this throws, the board is broken in production and every request
         quietly falls back — which is exactly what was happening. */
      const { rows } = await pool.query(WEEKLY_BOARD_SQL, ['2026-W33', 500]);
      assert.ok(Array.isArray(rows), 'no rows returned');
    });

    await check('it returns this week’s scorers, best first', async () => {
      const { rows } = await pool.query(WEEKLY_BOARD_SQL, ['2026-W33', 500]);
      assert.equal(rows.length, 2, 'expected the two scorers of this week, got ' + rows.length);
      assert.equal(Number(rows[0].cup), 120, 'best first');
      assert.equal(Number(rows[1].cup), 80);
    });

    await check('a player with no cup this week is not on the board', async () => {
      const { rows } = await pool.query(WEEKLY_BOARD_SQL, ['2026-W33', 500]);
      assert.ok(rows.every((r: any) => Number(r.cup) > 0), 'a zero-cup player slipped in');
    });

    await check('another week’s board is a different board', async () => {
      const { rows } = await pool.query(WEEKLY_BOARD_SQL, ['2026-W01', 500]);
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].cup), 999);
    });

    await check('the limit is honoured', async () => {
      const { rows } = await pool.query(WEEKLY_BOARD_SQL, ['2026-W33', 1]);
      assert.equal(rows.length, 1);
      assert.equal(Number(rows[0].cup), 120, 'and it keeps the best one');
    });

    await check('the bot filter is what broke, so it is exercised on purpose', async () => {
      /* The uncast version of this exact predicate is the production error.
         Asserting it still fails keeps the reason for the cast on the record. */
      await assert.rejects(
        () => pool.query(`SELECT id FROM users WHERE id NOT LIKE 'bot\\_%'`),
        (e: any) => /operator does not exist/.test(String(e.message)),
        'uncast NOT LIKE on uuid should still be a Postgres error'
      );
      const { rows } = await pool.query(`SELECT id FROM users WHERE id::text NOT LIKE 'bot\\_%'`);
      assert.equal(rows.length, 4, 'and the cast version returns every row');
    });
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    pool.release();
    await p.end().catch(() => undefined);
  }

  console.log(`[leagueBoardSql] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
