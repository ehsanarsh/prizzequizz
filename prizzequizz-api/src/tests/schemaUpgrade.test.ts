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

/* ── waiting_music, and its bytes ────────────────────────────────────────── */
/* The music table is the newest of these, so it starts life in the shape a
   first release would have had — and the same round trip has to work on it.
   This is also the only test that puts a file through the service against a
   REAL database rather than the in-memory stand-in. */
console.log('a server booting on a music table from before the extra columns:');
await pool.query('DROP TABLE IF EXISTS waiting_music');
await pool.query(`CREATE TABLE waiting_music (
  id TEXT PRIMARY KEY,
  mime VARCHAR(32) NOT NULL,
  data TEXT NOT NULL)`);

const music = await import('../services/waitingMusicService.js');
const mp3 = (size: number) => {
  const buf = Buffer.alloc(size);
  buf.write('ID3', 0, 'ascii');
  for (let i = 3; i < size; i++) buf[i] = (i * 7) % 251;
  return 'data:audio/mpeg;base64,' + buf.toString('base64');
};

await check('a track can be uploaded at all', async () => {
  const t = await music.addTrack({ title: 'بی‌کلام', audio: mp3(2048) });
  assert.ok(t.id, 'no track came back');
  assert.strictEqual(t.bytes, 2048, 'the size column was lost');
  assert.strictEqual(t.enabled, true, 'the enabled column was lost');
});

await check('and its bytes come back byte for byte', async () => {
  const rows = await music.listTracks();
  const back = await music.getTrack(rows[0]!.id);
  assert.ok(back, 'the track vanished');
  assert.strictEqual(back!.data.length, 2048, 'the file changed size on the round trip');
  assert.strictEqual(back!.data.toString('ascii', 0, 3), 'ID3', 'the file came back corrupted');
});

/* THE FILE IS STORED AS BYTES NOW, and what was stored as base64 text before
   must keep playing — an operator's uploads cannot stop working because the
   storage underneath them changed. */
await check('a track written the old way, as base64 text, still plays', async () => {
  const raw = Buffer.alloc(1024);
  raw.write('ID3', 0, 'ascii');
  for (let i = 3; i < raw.length; i++) raw[i] = (i * 11) % 251;
  await pool.query(
    `INSERT INTO waiting_music(id,title,mime,bytes,data,etag,enabled,sort_order)
     VALUES ('legacy-1','قدیمی','audio/mpeg',$1,$2,'legacyetag',true,9)`,
    [raw.length, raw.toString('base64')]);
  const back = await music.getTrack('legacy-1');
  assert.ok(back, 'the old row cannot be read at all');
  assert.strictEqual(back!.data.length, raw.length, 'the old row came back the wrong size');
  assert.deepStrictEqual(back!.data, raw, 'the old row came back altered');
  await music.removeTrack('legacy-1');
});

await check('and a new one is written as bytes, not as text', async () => {
  const t = await music.addTrack({ title: 'بایتی', audio: mp3(4096) });
  const { rows } = await pool.query(`SELECT data, data_bin FROM waiting_music WHERE id=$1`, [t.id]);
  assert.ok(rows[0].data_bin, 'the bytes column is empty — it went in as text again');
  assert.strictEqual(rows[0].data_bin.length, 4096, 'the stored bytes are the wrong size');
  assert.ok(!rows[0].data, 'the text column was filled as well, which is the cost this avoids');
  await music.removeTrack(t.id);
});

await check('the players’ playlist is built from it, with no titles on it', async () => {
  const list = await music.playlistForPlayers();
  assert.strictEqual(list.length, 1, JSON.stringify(list));
  assert.deepStrictEqual(Object.keys(list[0]!).sort(), ['id', 'url']);
});

/* THE MUSIC MUST NOT COST THE GAME ANYTHING.
   A browser asks for an audio file in pieces, several requests per track, and
   fifteen megabytes decoded out of the database on each of those is work the
   match engine is sharing a process with. A decoded track is therefore kept.
   The proof: delete the ROW behind its back and ask again — an answer can only
   have come from memory. */
await check('a track is read from the database once, not once per range request', async () => {
  const rows = await music.listTracks();
  const tid = rows[0]!.id;
  await music.getTrack(tid);                                   // fills the cache
  assert.strictEqual(music._musicCacheStats().tracks, 1, 'nothing was kept');
  await pool.query(`DELETE FROM waiting_music WHERE id=$1`, [tid]);
  const again = await music.getTrack(tid);
  assert.ok(again, 'the second read went back to the database');
  assert.strictEqual(again!.data.length, 2048);
  /* Put it back for the rest of the file. */
  await pool.query(
    `INSERT INTO waiting_music(id,title,mime,bytes,data,etag,enabled,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,true,0)`,
    [tid, again!.title, again!.mime, again!.bytes, again!.data.toString('base64'), again!.etag]);
});

await check('and what is kept is dropped the moment the track changes', async () => {
  const rows = await music.listTracks();
  const tid = rows[0]!.id;
  await music.getTrack(tid);
  await music.setTrackEnabled(tid, false);
  assert.strictEqual(music._musicCacheStats().tracks, 0, 'a stale copy survived the change');
  const back = await music.getTrack(tid);
  assert.strictEqual(back!.enabled, false, 'the stale copy was served anyway');
  await music.setTrackEnabled(tid, true);
});

/* AND IT IS BOUNDED. Holding every track ever played would be a slow leak in a
   process that also runs matches — the whole point was to spend LESS on music,
   not to spend memory instead. */
await check('what is kept is bounded in bytes, and the oldest goes first', async () => {
  music._setMusicCacheCap(5000);                 // room for two 2048-byte tracks
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await music.addTrack({ title: 't' + i, audio: mp3(2048) })).id);
  /* addTrack keeps what it just wrote, so all three have been through the
     cache — and the cap must have thrown the earliest one out. */
  const stats = music._musicCacheStats();
  assert.ok(stats.bytes <= 5000, 'the cache grew past its cap: ' + JSON.stringify(stats));
  assert.ok(stats.tracks <= 2, 'more tracks are held than fit: ' + JSON.stringify(stats));
  /* The newest is still there; the oldest was dropped and has to be read again
     — which it can be, because the cache is not the source of truth. */
  const back = await music.getTrack(ids[0]!);
  assert.ok(back, 'a track that fell out of the cache became unreadable');
  assert.strictEqual(back!.data.length, 2048);
  for (const id of ids) await music.removeTrack(id);
  music._setMusicCacheCap(64 * 1024 * 1024);
});

await check('and when the track is deleted, so is its copy', async () => {
  const rows = await music.listTracks();
  const tid = rows[0]!.id;
  await music.getTrack(tid);
  await music.removeTrack(tid);
  assert.strictEqual(music._musicCacheStats().tracks, 0, 'the bytes of a deleted track were still being held');
  assert.strictEqual(await music.getTrack(tid), null, 'a deleted track still answers');
});

/* ── question_seen, as it would stand if it had shipped without ref_id ────── */
/* The column that makes the duel work is the one most likely to have been added
   later, so this is the exact shape the bug takes: a server that already has the
   table, upgrading into a build that reads a column it has never had. */
console.log('\na server booting on a question_seen table with no ref_id:');
await pool.query('DROP TABLE IF EXISTS question_seen');
await pool.query(`CREATE TABLE question_seen (
  user_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id))`);
/* A player's history from before the upgrade must survive it. */
await pool.query(`INSERT INTO question_seen(user_id, question_id) VALUES ('old-u','old-q')`);

const seenSvc = await import('../services/questionSeenService.js');
await check('an old row is still remembered after the upgrade', async () => {
  const s = await seenSvc.seenElsewhere(['old-u'], 'some-match');
  assert.ok(s.has('old-q'), 'the row that was already there was lost');
});
await check('and new sightings can still be written', async () => {
  await seenSvc.markSeen(['old-u'], 'new-q', 'match-1');
  const s = await seenSvc.seenElsewhere(['old-u'], '');
  assert.ok(s.has('new-q'), 'nothing was written');
});
await check('the game it was seen in is remembered too', async () => {
  const during = await seenSvc.seenElsewhere(['old-u'], 'match-1');
  assert.ok(!during.has('new-q'), 'ref_id is not being read');
  assert.ok(during.has('old-q'), 'the pre-upgrade row should still count');
});
await check('and counting across players works on the upgraded table', async () => {
  await seenSvc.markSeen(['other-u'], 'old-q', 'match-2');
  const counts = await seenSvc.seenCounts(['old-u', 'other-u'], '');
  assert.strictEqual(counts.get('old-q'), 2);
});
/* THE TWO PROPERTIES THE DUEL RESTS ON, against a real database. Both live in
   SQL, so an in-memory run cannot see them at all: the exclusion of the current
   match, and the fact that seeing a question again does not move it into the
   match that re-served it. Get either wrong and the two players stop being
   asked the same question. */
await check('a question served in this match is not «already seen»', async () => {
  await seenSvc.markSeen(['dp1', 'dp2'], 'q-live', 'match-live');
  const s = await seenSvc.seenElsewhere(['dp1', 'dp2'], 'match-live');
  assert.ok(!s.has('q-live'), 'the running match is counting its own questions as history');
});
await check('and re-serving an old question keeps it in the match it came from', async () => {
  await seenSvc.markSeen(['dp1'], 'q-old', 'match-earlier');
  await seenSvc.markSeen(['dp1'], 'q-old', 'match-live');     // served again, later
  const s = await seenSvc.seenElsewhere(['dp1'], 'match-live');
  assert.ok(s.has('q-old'), 'a re-served question was moved into the current match and stopped counting');
});
await check('pruning does not fall over on rows that predate seen_at', async () => {
  const gone = await seenSvc.prune('old-u');
  assert.ok(gone >= 0);
  const s = await seenSvc.seenElsewhere(['old-u'], '');
  assert.ok(s.has('old-q') && s.has('new-q'), 'pruning under the cap must delete nothing');
});

/* ── the rule, so the next column added does not repeat this ─────────────── */
console.log('every column a fresh database gets, an old one gets too:');
const fs = await import('node:fs');
const url = await import('node:url');
const here = url.fileURLToPath(new URL('.', import.meta.url));
/* The third number is how many migratable columns the table is expected to
   have — a guard on the PARSER, not on the table, so a regex that quietly
   matched nothing cannot pass as «no missing columns». It belongs per table
   because a four-column table legitimately has fewer than a fifteen-column one. */
for (const [file, table, atLeast] of [
  ['../services/gameInviteService.ts', 'game_invites', 5],
  ['../services/duelRunService.ts', 'duel_runs', 5],
  ['../services/waitingMusicService.ts', 'waiting_music', 5],
  ['../services/questionSeenService.ts', 'question_seen', 2]
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
    assert.ok(migratable.length >= atLeast, 'parsed too few columns to be believable: ' + migratable.join(','));
    const alters = [...src.matchAll(/ADD COLUMN IF NOT EXISTS \$\{col\}|`([a-z_]+) [A-Z]/g)].map((m) => m[1]).filter(Boolean);
    const missing = migratable.filter((c) => !alters.includes(c));
    assert.deepEqual(missing, [], 'added to the table but never migrated: ' + missing.join(', '));
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await pool.end?.();
process.exit(fail ? 1 : 0);
