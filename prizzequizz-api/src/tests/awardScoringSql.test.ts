/* THE AWARD STATEMENT, RUN AGAINST A REAL POSTGRES.
 *
 * awardScoring adds XP, adds cup, and recomputes the level in ONE statement,
 * and it now does two things it could not do before: it reads the level curve
 * from the panel instead of carrying its own hardcoded copy, and it returns the
 * row's xp from BEFORE the update so a level crossing can be spotted and paid.
 *
 * Neither can be checked on the memory repository — that path never executes
 * this SQL. And reading the string and asserting it "contains RETURNING" would
 * prove nothing: the mistakes available here (an ambiguous `xp`, a CTE joined
 * wrongly, a RETURNING that hands back the new value where the old was wanted)
 * are all valid-looking SQL that only a database rejects or, worse, quietly
 * answers wrongly.
 *
 * Needs a database. Set PGTEST_URL (or DATABASE_URL); without one it says so
 * and skips rather than passing silently.
 *
 * Run: PGTEST_URL=postgres://... npx tsx src/tests/awardScoringSql.test.ts
 */
import assert from 'node:assert/strict';
import { awardScoringSql } from '../services/matchEngine.js';
import { levelForXp } from '../services/scoringConfig.js';
import { gameConfig } from '../core/config.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

function withConfig<T>(patch: Record<string, any>, fn: () => T): T {
  const saved: Record<string, any> = {};
  for (const k of Object.keys(patch)) saved[k] = structuredClone((gameConfig as any)[k]);
  for (const k of Object.keys(patch)) (gameConfig as any)[k] = { ...((gameConfig as any)[k] ?? {}), ...patch[k] };
  try { return fn(); } finally { for (const k of Object.keys(patch)) (gameConfig as any)[k] = saved[k]; }
}

async function run(): Promise<void> {
  const url = process.env.PGTEST_URL || process.env.DATABASE_URL;
  if (!url) {
    console.log('[awardScoringSql] SKIPPED — no PGTEST_URL/DATABASE_URL. This test needs a real Postgres;');
    console.log('                  the memory repository never runs this statement.');
    return;
  }

  const { Pool } = await import('pg');
  const p = new Pool({ connectionString: url });
  const db = await p.connect();
  const schema = 'award_' + Math.random().toString(36).slice(2, 8);

  const ID = '11111111-1111-1111-1111-111111111111';
  async function reset(xp: number, cup: number, week: string): Promise<void> {
    await db.query(`TRUNCATE users`);
    await db.query(`INSERT INTO users (id, xp, weekly_score, weekly_week, level) VALUES ($1,$2,$3,$4,1)`,
      [ID, xp, cup, week]);
  }

  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    /* Production's column types, because the point of this test is the
       database's opinion, not TypeScript's. */
    await db.query(`CREATE TABLE users (
      id uuid PRIMARY KEY,
      xp integer NOT NULL DEFAULT 0,
      weekly_score integer NOT NULL DEFAULT 0,
      weekly_week varchar(8) NOT NULL DEFAULT '',
      level integer NOT NULL DEFAULT 1,
      updated_at timestamp NOT NULL DEFAULT now())`);

    await check('the statement is accepted by Postgres at all', async () => {
      await reset(0, 0, '2026-W10');
      const { rows } = await db.query(awardScoringSql(), [ID, 10, 5, '2026-W10']);
      assert.equal(rows.length, 1, 'the update matched no row');
    });

    await check('xp and cup both go up, in the same week', async () => {
      await reset(100, 20, '2026-W10');
      const { rows } = await db.query(awardScoringSql(), [ID, 30, 7, '2026-W10']);
      assert.equal(Number(rows[0].xp), 130);
      assert.equal(Number(rows[0].weekly_score), 27);
    });

    await check('a new week starts the cup again from this match alone', async () => {
      await reset(100, 900, '2026-W09');
      const { rows } = await db.query(awardScoringSql(), [ID, 0, 7, '2026-W10']);
      assert.equal(Number(rows[0].weekly_score), 7, 'last week’s 900 must not be carried in');
      assert.equal(Number(rows[0].xp), 100, 'but XP is permanent and must not reset');
    });

    /* THE FIELD THIS TEST EXISTS FOR: with weekly reset switched off in the
       panel, the SAME statement must add instead of replacing. */
    await check('with weekly reset off, a new week keeps adding to the running total', async () => {
      await reset(100, 900, '2026-W09');
      const sql = withConfig({ cup: { weeklyReset: false } }, () => awardScoringSql());
      const { rows } = await db.query(sql, [ID, 0, 7, '2026-W10']);
      assert.equal(Number(rows[0].weekly_score), 907, 'the panel switch did not reach the database');
    });

    await check('the level the database stores is the level the code computes', async () => {
      for (const [base, curve] of [[100, 'sqrt'], [25, 'sqrt'], [100, 'linear']] as const) {
        const sql = withConfig({ level: { xpPerLevelBase: base, curve } }, () => awardScoringSql());
        for (const xp of [0, 99, 100, 400, 2500]) {
          await reset(0, 0, '2026-W10');
          const { rows } = await db.query(sql, [ID, xp, 0, '2026-W10']);
          const expected = withConfig({ level: { xpPerLevelBase: base, curve } }, () => levelForXp(xp));
          assert.equal(Number(rows[0].level), expected,
            `base=${base} curve=${curve} xp=${xp}: db said ${rows[0].level}, code says ${expected}`);
        }
      }
    });

    /* Without this the level-up reward can never fire: a bare column in
       RETURNING is the value after the update, so old_xp has to be carried
       through the CTE. */
    await check('old_xp comes back as the value from BEFORE the award', async () => {
      await reset(350, 0, '2026-W10');
      const { rows } = await db.query(awardScoringSql(), [ID, 100, 0, '2026-W10']);
      assert.equal(Number(rows[0].old_xp), 350, 'old_xp is not the pre-update value');
      assert.equal(Number(rows[0].xp), 450, 'and the new value must still be the new one');
    });

    await check('a level crossing is visible from one row of the result', async () => {
      await reset(350, 0, '2026-W10');   // level 2 at base 100
      const { rows } = await db.query(awardScoringSql(), [ID, 100, 0, '2026-W10']);
      const before = levelForXp(Number(rows[0].old_xp));
      assert.equal(before, 2);
      assert.equal(Number(rows[0].level), 3, 'crossing 400 must be level 3');
    });

    await check('awarding nothing crosses nothing', async () => {
      await reset(400, 0, '2026-W10');
      const { rows } = await db.query(awardScoringSql(), [ID, 0, 0, '2026-W10']);
      assert.equal(levelForXp(Number(rows[0].old_xp)), Number(rows[0].level),
        'a zero award must not look like a level-up');
    });

    await check('a user who is not there is not invented', async () => {
      await reset(0, 0, '2026-W10');
      const { rows } = await db.query(awardScoringSql(),
        ['22222222-2222-2222-2222-222222222222', 50, 5, '2026-W10']);
      assert.equal(rows.length, 0);
    });

    await check('the level never falls below 1', async () => {
      await reset(0, 0, '2026-W10');
      const { rows } = await db.query(awardScoringSql(), [ID, 0, 0, '2026-W10']);
      assert.equal(Number(rows[0].level), 1);
    });
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    db.release();
    await p.end();
  }

  console.log(`[awardScoringSql] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
