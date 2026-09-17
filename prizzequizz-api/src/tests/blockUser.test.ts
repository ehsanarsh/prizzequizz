/* BLOCKING SOMEBODY, AND WHAT THAT HAS TO MEAN.
 *
 * «یه بلاک هم بزاریم تا کاربرا بتونن بلاک کنن تا بلاک‌شده نتونه بهشون پیام و
 *  دعوت به بازی بفرسته.»
 *
 * A block that only hides messages is a mute, and the person who asked for it
 * finds out the difference the first time an invitation arrives. So what is
 * pinned here is that the SENDING is refused — not that a list is kept.
 *
 * Run: DATABASE_URL=… npx tsx src/tests/blockUser.test.ts
 */
import assert from 'node:assert/strict';
import { blockUser, unblockUser, blockedBetween, iBlocked, listBlocked, blockedAmong, BlockError, _resetBlocks } from '../services/blockService.js';
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

if (!process.env.DATABASE_URL) {
  /* Loudly, not quietly. A block is a row two people depend on; exercising it only against the in-memory map would prove nothing about the table that actually holds it. */
  console.log('  — skipped: this needs Postgres');
  console.log('[blockUser] 0 passed, 0 failed');
  process.exit(0);
}

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  const pool = getPgPool();
  _resetBlocks();
  /* THE ROWS THIS MAKES ARE CLEANED UP, and the numbers do not collide with a
     previous run's. A fixed base ran straight into `users_phone_key` the second
     time this file was run, which reads as a failure of the code under test and
     is nothing of the sort. */
  const made: string[] = [];
  const mk = async (tag: string): Promise<string> => {
    const uid = id();
    made.push(uid);
    await pool.query(
      `INSERT INTO users(id, phone, username, display_name, wallet_balance, coins, tickets)
       VALUES ($1,$2,$3,$4,0,0,'{}'::jsonb)`,
      [uid, '09' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), 'blk_' + uid.slice(0, 10), tag]);
    return uid;
  };
  const A = await mk('alef'), B = await mk('be'), C = await mk('jim');

  await check('nobody is blocked to begin with', async () => {
    assert.equal(await blockedBetween(A, B), false);
  });

  await check('blocking somebody blocks them', async () => {
    await blockUser(A, B);
    assert.equal(await blockedBetween(A, B), true);
  });

  await check('AND IT WORKS THE OTHER WAY TOO', async () => {
    /* A one-way block lets somebody block a person and carry on messaging
       them, which is a way of making sure the other cannot answer back. That
       is not a safety feature; it is a weapon, and the direction of the check
       is what decides which one this is. */
    assert.equal(await blockedBetween(B, A), true, 'the blocker could still reach the blocked');
  });

  await check('but only between those two', async () => {
    assert.equal(await blockedBetween(A, C), false);
    assert.equal(await blockedBetween(B, C), false);
  });

  await check('blocking twice is not an error', async () => {
    /* A double-tapped button must not be a failure the player has to read. */
    await blockUser(A, B);
    assert.equal(await blockedBetween(A, B), true);
  });

  await check('unblocking lets them through again', async () => {
    await unblockUser(A, B);
    assert.equal(await blockedBetween(A, B), false);
    assert.equal(await blockedBetween(B, A), false);
  });

  await check('unblocking somebody who was never blocked is quiet', async () => {
    await unblockUser(A, C);
    assert.equal(await blockedBetween(A, C), false);
  });

  await check('you cannot block yourself', async () => {
    /* Letting this through would quietly cut somebody off from their own chat. */
    await assert.rejects(() => blockUser(A, A), (e: any) => e instanceof BlockError && e.code === 'SELF_BLOCK');
  });

  await check('the list says who I blocked, with their name', async () => {
    await blockUser(A, B);
    await blockUser(A, C);
    const rows = await listBlocked(A);
    assert.equal(rows.length, 2, JSON.stringify(rows));
    assert.ok(rows.every((r) => r.username), 'a list of ids is not a list a person can read');
    assert.deepEqual(rows.map((r) => r.id).sort(), [B, C].sort());
  });

  await check('and NOT who blocked me', async () => {
    /* Telling somebody they have been blocked tells them who did it, which is
       the one thing a person blocking somebody is usually trying to avoid. */
    const theirs = await listBlocked(B);
    assert.equal(theirs.length, 0, 'the blocked person can see who blocked them: ' + JSON.stringify(theirs));
    assert.equal(await iBlocked(B, A), false, 'iBlocked answered the wrong direction');
    assert.equal(await iBlocked(A, B), true);
  });

  await check('a whole list is answered in one go', async () => {
    /* A friends page asking once per row is how a block check becomes a reason
       not to have one. */
    const D = await mk('dal');
    const set = await blockedAmong(A, [B, C, D]);
    assert.equal(set.has(B), true);
    assert.equal(set.has(C), true);
    assert.equal(set.has(D), false);
    assert.equal(set.size, 2);
  });

  await check('and that list sees blocks pointing the other way too', async () => {
    const E = await mk('he');
    await blockUser(E, A);                       // E blocked A, not the reverse
    const set = await blockedAmong(A, [E]);
    assert.equal(set.has(E), true, 'a block by somebody else was invisible to them');
  });

  await pool.query(`DELETE FROM user_blocks WHERE blocker_id = ANY($1) OR blocked_id = ANY($1)`, [made]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [made]);
  console.log(`[blockUser] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
