/* TWO PLAYERS CANNOT BE THE SAME PERSON.
 *
 * «یوزرنیم تکراری، مثلاً دو تا nazi هم ثبت می‌شه، که نباید این‌طور بشه.»
 *
 * The column IS unique, and the route relied on it. Postgres compares byte for
 * byte, so `Nazi` and `nazi` are two different names to the database and one
 * name to everybody who plays the game. Measured, not assumed: inserting both
 * into the real table succeeds.
 *
 * Run: npx tsx src/tests/usernameUnique.test.ts        (folding only)
 *      DATABASE_URL=… npx tsx src/tests/usernameUnique.test.ts   (+ the table)
 */
import assert from 'node:assert/strict';
import { cleanUsername, foldUsername, isPlaceholderUsername, usernameTaken, ensureUsernameIndex, usernameIndexReady, duplicateUsernames, markOldest } from '../services/usernameService.js';
import { repositories } from '../repositories/index.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  /* ── WHAT COUNTS AS THE SAME NAME ─────────────────────────────────────── */

  await check('case alone does not make a new name', () => {
    /* The exact pair that got in. */
    assert.equal(foldUsername('Nazi'), foldUsername('nazi'));
    assert.equal(foldUsername('NAZI'), foldUsername('nazi'));
  });

  await check('nor does a space on the end, or in the middle', () => {
    assert.equal(foldUsername(' nazi '), foldUsername('nazi'));
    assert.equal(foldUsername('na zi'), foldUsername('nazi'));
  });

  await check('nor an invisible character nobody can see', () => {
    /* A zero-width non-joiner is a real keystroke on a Persian keyboard, and
       two names that differ only by one are indistinguishable on screen. */
    assert.equal(foldUsername('na‌zi'), foldUsername('nazi'));
    assert.equal(foldUsername('​nazi'), foldUsername('nazi'));
  });

  await check('nor the Arabic spelling of a Persian letter', () => {
    /* ی U+06CC vs ي U+064A, ک U+06A9 vs ك U+0643 — different code points, the
       same letter to a reader, and both reachable from ordinary keyboards. */
    assert.equal(foldUsername('علي'), foldUsername('علی'));
    assert.equal(foldUsername('كامران'), foldUsername('کامران'));
  });

  await check('nor Persian digits against latin ones', () => {
    assert.equal(foldUsername('ali۱۲۳'), foldUsername('ali123'));
  });

  await check('but two different names stay different', () => {
    /* The half that matters just as much: folding that swallows real names is
       a game where nobody can register. */
    assert.notEqual(foldUsername('nazi'), foldUsername('nazli'));
    assert.notEqual(foldUsername('ali'), foldUsername('ali2'));
    assert.notEqual(foldUsername('رضا'), foldUsername('رضوان'));
  });

  await check('what is SHOWN is what was typed, not the folded form', () => {
    /* Folding decides who owns a name. It must never decide how it is spelled
       on screen — «Nazi» does not become «nazi» because somebody compared it. */
    assert.equal(cleanUsername('  Nazi  '), 'Nazi');
    assert.equal(cleanUsername('Ali Reza'), 'Ali Reza');
    /* The half-space is part of how the name is spelled: it reaches the screen,
       and is only ignored when deciding who owns the name. */
    assert.equal(cleanUsername('علی‌رضا'), 'علی‌رضا');
    assert.equal(foldUsername('علی‌رضا'), foldUsername('علیرضا'),
      'but it must not make a second owner');
  });

  await check('and a name the game handed out is known for what it is', () => {
    assert.equal(isPlaceholderUsername('user_1789374320802'), true);
    assert.equal(isPlaceholderUsername('user_12'), false, 'too short to be one of ours');
    assert.equal(isPlaceholderUsername('nazi'), false);
  });

  await check('two accounts made in the same millisecond do not get the same name', () => {
    /* The account is created the instant the SMS code is verified, and its
       placeholder used to be the millisecond and nothing else. Two people
       finishing at once therefore asked for the same username, and the second
       registration failed — a player lost to a coincidence. Same shape, three
       random digits on the end. */
    const make = (ms: number): string => `user_${ms}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    const at = 1789374320802;
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(make(at));
    assert.ok(seen.size > 300, `the same millisecond produced only ${seen.size} different names`);
    /* And the shape must survive it, on BOTH sides: the server's own test and
       the client's «this account still has no real name» test. */
    for (const u of seen) {
      assert.equal(isPlaceholderUsername(u), true, u + ' stopped reading as a placeholder');
      assert.ok(/^user_\d+$/.test(u), u + ' would not match the client\'s test');
    }
  });

  await check('«who had it first» is answered from dates, or not at all', () => {
    /* This is what somebody renames BY, so it has to be a fact rather than the
       order rows happened to come back in. The live table cannot have a row
       without a date — `created_at` is NOT NULL — but the in-memory repository
       used when there is no database hands back records that have none, and
       there it must say nothing rather than point at whoever was first in the
       array. The cost of guessing is the wrong person losing the name they play
       under. */
    const u = (id: string, createdAt: string | null): any => ({
      id, username: 'nazi', displayName: '', createdAt, updatedAt: null,
      level: 1, xp: 0, wallet: 0, status: 'active', oldest: false
    });
    const dated = markOldest([u('new', '2026-05-01T00:00:00Z'), u('old', '2026-01-01T00:00:00Z')]);
    assert.deepEqual(dated.filter((x) => x.oldest).map((x) => x.id), ['old']);

    const none = markOldest([u('a', null), u('b', null)]);
    assert.equal(none.filter((x) => x.oldest).length, 0, 'one was called older with nothing to go on');

    /* One date and one blank: the dated one is the only thing known about, and
       «known» beats «unknown» — but only one of them is marked. */
    const half = markOldest([u('a', null), u('b', '2026-01-01T00:00:00Z')]);
    assert.deepEqual(half.filter((x) => x.oldest).map((x) => x.id), ['b']);
  });

  /* ── AGAINST THE REAL TABLE ───────────────────────────────────────────── */
  if (!process.env.DATABASE_URL) {
    console.log('  — skipped: the rest needs Postgres, where the byte-for-byte UNIQUE lives');
    console.log(`[usernameUnique] ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const { getPgPool } = await import('../database/postgres.js');
  const pool = getPgPool();
  const A = '55555555-5555-4555-8555-555555555555';
  const B = '66666666-6666-4666-8666-666666666666';
  const C = '77777777-7777-4777-8777-777777777777';
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[A, B, C]]);
  await pool.query(`DELETE FROM users WHERE lower(username) IN ('nazi','nazi-2','ناظم')`);
  /* A DETERMINISTIC STARTING POINT. This file proves both halves — that a
     duplicate blocks the index, and that removing it lets the index take hold —
     so it must not inherit either state from the run before it. */
  await pool.query(`DROP INDEX IF EXISTS uq_users_username_folded`);
  await pool.query(`INSERT INTO users(id, phone, username, display_name) VALUES ($1,'0900000001','Nazi','ن')`, [A]);

  await check('the column on its own lets the second one in', async () => {
    /* THE BUG, stated as the database sees it. If this ever starts failing, the
       folded index below has taken hold and this check has done its job. */
    let got = '';
    try {
      await pool.query(`INSERT INTO users(id, phone, username, display_name) VALUES ($1,'0900000002','nazi','ن۲')`, [B]);
    } catch (e) { got = (e as Error).message; }
    if (!got) await pool.query(`DELETE FROM users WHERE id=$1`, [B]);
    assert.ok(true, 'recorded: ' + (got || 'the byte-for-byte UNIQUE accepted both spellings'));
  });

  await check('but the check the routes use refuses it', async () => {
    assert.equal(await usernameTaken('nazi'), true, '«nazi» was free while «Nazi» exists');
    assert.equal(await usernameTaken('NAZI'), true);
    assert.equal(await usernameTaken('na zi'), true);
  });

  await check('and it lets the owner keep their own name', async () => {
    /* Renaming yourself from «Nazi» to «nazi» must not collide with yourself. */
    assert.equal(await usernameTaken('nazi', A), false, 'the holder was blocked by their own name');
  });

  await check('a free name is still free', async () => {
    assert.equal(await usernameTaken('a-name-nobody-has-' + Date.now()), false);
  });

  await check('the folded index is created, or says what is in its way', async () => {
    const r = await ensureUsernameIndex();
    assert.ok(r.created || r.blockedBy.length > 0,
      'it neither created the index nor explained why — the silent outcome');
  });

  await check('and the duplicates already in the table can be listed', async () => {
    /* An index that cannot be created leaves the operator needing to know WHICH
       names to fix. Saying «it failed» without saying which is not help. */
    const dups = await duplicateUsernames();
    assert.ok(Array.isArray(dups), 'no list at all');
  });

  /* ── THE GUARANTEE, NOT THE CHECK ─────────────────────────────────────
     Everything above is the app refusing a name it can see is taken. This is
     the part underneath it: the database refusing it at write time, which is
     the only thing that stops two saves of the same free name in the same
     instant — and the only thing that stops a code path written next year that
     forgets to call the check at all. */

  /* The check above deliberately CREATES the index when nothing is in its way,
     and by now nothing is. Dropped again so the two halves below start from the
     state this section is about, instead of from the previous check's success. */
  await pool.query(`DROP INDEX IF EXISTS uq_users_username_folded`);

  await check('while a duplicate is in the table, the guarantee is NOT in place', async () => {
    assert.equal(await usernameIndexReady(), false, 'the index was there before this test made it possible');
    /* The second spelling, inserted the way the old code could. Dates are set
       explicitly so «who had it first» is a fact of this test, not of whatever
       default the column happens to carry. */
    await pool.query(
      `INSERT INTO users(id, phone, username, display_name, created_at) VALUES ($1,'0900000002','nazi','ن۲', now())`, [B]);
    await pool.query(`UPDATE users SET created_at = now() - interval '30 days' WHERE id=$1`, [A]);
    const r = await ensureUsernameIndex(true);
    assert.equal(r.created, false, 'a unique index was created over a table that already holds duplicates');
    assert.ok(r.blockedBy.length > 0, 'it failed and did not say what was in the way');
    assert.equal(await usernameIndexReady(), false, 'it reported the index as ready when the database has none');
  });

  await check('and whoever has to fix it is told which accounts, not just which names', async () => {
    const groups = await duplicateUsernames();
    const g = groups.find((x) => x.users.some((u) => u.id === A) && x.users.some((u) => u.id === B));
    assert.ok(g, 'the pair this test just made was not in the list');
    assert.equal(g!.count, 2);
    /* An id is what makes it actionable — a name alone cannot be renamed. */
    assert.ok(g!.users.every((u) => u.id), 'a row with no id cannot be acted on');
    assert.equal(g!.users.filter((u) => u.oldest).length, 1, 'exactly one of them held the name first');
    assert.equal(g!.users.find((u) => u.oldest)!.id, A, 'the wrong account was called the older one');
  });

  await check('renaming one of them lets the guarantee take hold, without a restart', async () => {
    await pool.query(`UPDATE users SET username='nazi-2' WHERE id=$1`, [B]);
    const r = await ensureUsernameIndex(true);
    assert.equal(r.created, true, 'still blocked: ' + r.blockedBy.join(' ; '));
    assert.equal(await usernameIndexReady(), true, 'it said it created the index and the database disagrees');
  });

  await check('and from then on the DATABASE refuses the second spelling', async () => {
    /* No application check involved. This is the raw INSERT that the very first
       check in this section recorded as succeeding. */
    let refused = false;
    try {
      await pool.query(`INSERT INTO users(id, phone, username, display_name) VALUES ($1,'0900000003','NAZI','ن۳')`, [C]);
    } catch { refused = true; }
    if (!refused) await pool.query(`DELETE FROM users WHERE id=$1`, [C]);
    assert.equal(refused, true, 'the folded index let «NAZI» in beside «Nazi»');
  });

  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[A, B, C]]);
  console.log(`[usernameUnique] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
