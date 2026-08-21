/* THE DATABASE THAT WAS ALREADY THERE.
 *
 * `CREATE TABLE IF NOT EXISTS` is not a migration. It does nothing whatsoever
 * to a table that already exists — it does not look at the columns. So the day
 * `room_topic` was added to game_invites, every server that had already created
 * that table carried on without the column, and every single invite died with
 *
 *     column "room_topic" of relation "game_invites" does not exist
 *
 * Nobody could invite anybody, from anywhere in the game. A fresh database was
 * fine, which is exactly why it passed every test: the tests always started
 * from nothing, and production never does.
 *
 * So these tests start where production starts — from the OLD table — and check
 * that a server booting on it can still do its job. Run with a real database:
 *
 *     DATABASE_URL=postgres://... npx tsx src/tests/schemaUpgrade.test.ts
 */
import assert from 'node:assert';

const DB = process.env.DATABASE_URL || '';
if (!DB) {
  console.log('schemaUpgrade: SKIPPED — needs a real database (set DATABASE_URL).');
  console.log('This test is about what Postgres does to an existing table, so an');
  console.log('in-memory stand-in would be testing the stand-in, not the bug.');
  process.exit(0);
}

let pass = 0, fail = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e: any) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}

const { getPgPool } = await import('../database/postgres.js');
const pool = getPgPool();

/* ── game_invites, as it stood before room_topic existed ─────────────────── */
console.log('a server booting on the invite table it shipped with:');
await pool.query('DROP TABLE IF EXISTS game_invites');
await pool.query(`CREATE TABLE game_invites (
  id TEXT PRIMARY KEY,
  from_user_id TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  to_user_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'duel',
  ticket_tier TEXT NOT NULL DEFAULT '',
  room_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL)`);
/* An invite already in flight when the new build lands — upgrading must not
   throw the existing rows away. */
await pool.query(
  `INSERT INTO game_invites (id, from_user_id, from_name, to_user_id, mode, ticket_tier, room_id, status, created_at, expires_at)
   VALUES ('old-1','u-a','قدیمی','u-b','duel','green','', 'pending', $1, $2)`,
  [Date.now(), Date.now() + 60_000]
);

const invites = await import('../services/gameInviteService.js');

await check('an invite can still be sent at all', async () => {
  const inv = await invites.createInvite({
    fromUserId: 'u-1', fromName: 'احسان', toUserId: 'u-2', mode: 'duel', ticketTier: 'green'
  });
  assert.ok(inv.id, 'no invite came back');
});

await check('and one carrying a room topic — the column that was missing', async () => {
  const inv = await invites.createInvite({
    fromUserId: 'u-3', fromName: 'سارا', toUserId: 'u-4', mode: 'ls',
    roomId: 'R9', roomTopic: 'ورزشی', fromRoomId: 'R9'
  });
  const back = await invites.getInvite(inv.id);
  assert.equal(back?.roomTopic, 'ورزشی', 'the topic did not survive the round trip');
  assert.equal(back?.roomId, 'R9');
});

/* The column added for friendly duels — the same trap one release later. */
await check('and one carrying a coin stake, the column added after that', async () => {
  const inv = await invites.createInvite({
    fromUserId: 'u-7', fromName: 'مینا', toUserId: 'u-8', mode: 'duel', coinStake: 33
  });
  const back = await invites.getInvite(inv.id);
  assert.equal(back?.coinStake, 33, 'the coin stake did not survive the round trip');
});

await check('the invites that were already in the table are still there', async () => {
  const { rows } = await pool.query(`SELECT id, room_topic FROM game_invites WHERE id = 'old-1'`);
  assert.equal(rows.length, 1, 'the upgrade dropped a live invite');
  assert.equal(rows[0].room_topic, '', 'an old row should read as no topic, not null');
});

/* ── duel_runs, the same trap ────────────────────────────────────────────── */
console.log('a server booting on the ladder table it shipped with:');
await pool.query('DROP TABLE IF EXISTS duel_runs');
await pool.query(`CREATE TABLE duel_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  stage INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

const runs = await import('../services/duelRunService.js');

await check('a ladder run can still be opened', async () => {
  const r = await runs.startRun('u-5', 'green', 12_500);
  assert.ok(r.id, 'no run came back');
  assert.equal(r.stake, 12_500, 'the stake was lost');
  assert.equal(r.entryTier, 'green');
});

await check('and a win still parks the money on it', async () => {
  const r = await runs.startRun('u-6', 'green', 12_500);
  const won = await runs.recordWin(r.id, 25_000);
  assert.equal(won?.pendingGross, 25_000, 'the pot did not stick to the run');
  const back = await runs.getRun(r.id);
  assert.equal(back?.pendingGross, 25_000, 'and it is not in the database either');
});

/* ── the rule, so the next column added does not repeat this ─────────────── */
console.log('every column a fresh database gets, an old one gets too:');
const fs = await import('node:fs');
const url = await import('node:url');
const here = url.fileURLToPath(new URL('.', import.meta.url));
for (const [file, table] of [
  ['../services/gameInviteService.ts', 'game_invites'],
  ['../services/duelRunService.ts', 'duel_runs']
] as const) {
  await check(table + ' says every optional column twice', async () => {
    const src = fs.readFileSync(here + file, 'utf8');
    const create = src.match(new RegExp('CREATE TABLE IF NOT EXISTS ' + table + ' \\(([\\s\\S]*?)\\)`'));
    assert.ok(create, 'could not find the CREATE TABLE for ' + table);
    const lines = (create![1] ?? '').split('\n').map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
    /* Which columns COULD have been added after the table shipped? Exactly the
       ones Postgres will let you add to a table with rows in it: a column with
       a DEFAULT, or a nullable one. A NOT NULL column with no default cannot be
       added to an existing table at all, so it must have been there on day one
       and needs no ALTER. Every other column does — whether or not it happens
       to be new today, because the point is the next one somebody adds. */
    const migratable = lines
      .filter((l) => /DEFAULT/i.test(l) || !/NOT NULL/i.test(l))
      .map((l) => l.split(/\s+/)[0] ?? '')
      .filter((c) => /^[a-z_]+$/.test(c) && c !== 'id');
    assert.ok(migratable.length >= 5, 'parsed too few columns to be believable: ' + migratable.join(','));
    const alters = [...src.matchAll(/ADD COLUMN IF NOT EXISTS \$\{col\}|`([a-z_]+) [A-Z]/g)].map((m) => m[1]).filter(Boolean);
    const missing = migratable.filter((c) => !alters.includes(c));
    assert.deepEqual(missing, [], 'added to the table but never migrated: ' + missing.join(', '));
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await pool.end?.();
process.exit(fail ? 1 : 0);
