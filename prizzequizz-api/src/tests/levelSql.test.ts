/* THE LEVEL, AS THE DATABASE COMPUTES IT.
 *
 * The friends list reads many people at once and cannot call playerLevel per
 * row, so the same rule is written a second time as SQL. Two copies of a rule
 * is exactly how this bug started — a header, a shelf and a browser each with
 * their own arithmetic — so the copies are held to each other here: for the
 * same account, the SQL and the TypeScript must return the same number.
 *
 * Postgres-only. Skips cleanly without a DATABASE_URL, because the rest of the
 * suite runs on the memory driver.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/levelSql.test.ts */
import assert from 'node:assert/strict';
import { playerLevel, playerLevelSqlExpr, levelForXp, levelXpBase } from '../services/scoringConfig.js';

const url = process.env.DATABASE_URL;
if (!url) { console.log('[levelSql] skipped — no DATABASE_URL'); process.exit(0); }

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url });

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); }
};

await pool.query('DROP TABLE IF EXISTS lvl_probe');
await pool.query('CREATE TABLE lvl_probe (id text primary key, level int, xp bigint)');

/* Every shape that matters: a rank banked above the curve, a curve that has run
   past a stale rank, a fresh account, and the broken rows a real table grows. */
const b = levelXpBase();
const rows: Array<{ id: string; level: number | null; xp: number | null; why: string }> = [
  { id: 'banked',  level: 18,   xp: 1000,      why: 'the rank is ahead of the curve' },
  { id: 'earned',  level: 1,    xp: 100 * b,   why: 'the curve is ahead of a stale rank' },
  { id: 'fresh',   level: 1,    xp: 0,         why: 'a new account' },
  { id: 'zeroed',  level: 0,    xp: 0,         why: 'a zeroed column' },
  { id: 'negative',level: -5,   xp: 0,         why: 'a negative column' },
  { id: 'nulls',   level: null, xp: null,      why: 'nulls, which a real table grows' },
  { id: 'exact',   level: 1,    xp: 4 * b,     why: 'XP sitting exactly on a level floor' }
];
for (const r of rows) await pool.query('INSERT INTO lvl_probe VALUES ($1,$2,$3)', [r.id, r.level, r.xp]);

const sql = `SELECT id, ${playerLevelSqlExpr('level', 'xp')} AS lvl FROM lvl_probe ORDER BY id`;
const { rows: got } = await pool.query(sql);
const byId = new Map(got.map((r: any) => [r.id, Number(r.lvl)]));

console.log('the SQL and the TypeScript answer the same question:');
for (const r of rows) {
  const ts = playerLevel({ level: r.level, xp: r.xp });
  ok(r.why, byId.get(r.id) === ts, 'sql ' + byId.get(r.id) + ' vs ts ' + ts);
}

/* And it is really the rule, not a constant that happens to match. */
console.log('and it is the rule, not a coincidence:');
ok('a banked rank wins over the curve', byId.get('banked') === 18, String(byId.get('banked')));
ok('the curve wins over a stale rank', byId.get('earned') === levelForXp(100 * b), String(byId.get('earned')));
ok('nothing ever comes back below 1',
  rows.every((r) => (byId.get(r.id) ?? 0) >= 1), [...byId.values()].join(','));

await pool.query('DROP TABLE lvl_probe');
await pool.end();
console.log(`[levelSql] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
