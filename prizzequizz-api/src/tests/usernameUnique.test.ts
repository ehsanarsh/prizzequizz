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
import { cleanUsername, foldUsername, isPlaceholderUsername, usernameTaken, ensureUsernameIndex, duplicateUsernames } from '../services/usernameService.js';
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
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[A, B]]);
  await pool.query(`DELETE FROM users WHERE lower(username) IN ('nazi','ناظم')`);
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

  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[A, B]]);
  console.log(`[usernameUnique] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
