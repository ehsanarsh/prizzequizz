/* «باید ریز تراکنش‌ها رو بتونم ببینم.»
 *
 * The ledger could be read one player at a time, and only if you already knew
 * their id. So the question somebody actually asks — «چه پولی امروز جابه‌جا
 * شد» — had no answer anywhere in the panel. The finance screen shows totals,
 * and totals are what you look at once you already trust the rows under them.
 *
 * What is pinned here is what makes the rows usable rather than merely present:
 * the player's NAME instead of a uuid, one search box over every field a person
 * might know, and totals that describe the WHOLE filter rather than the page
 * being shown. A sum that changes when you turn the page cannot be reconciled
 * against anything, and a list you cannot reconcile is a list nobody opens
 * twice.
 *
 * Run: DATABASE_URL=… npx tsx src/tests/adminLedger.test.ts
 */
import assert from 'node:assert/strict';
import { listAllEntries, ledgerAsCsv, postEntry } from '../services/walletLedgerService.js';
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

if (!process.env.DATABASE_URL) {
  /* The join to `users` is the point of this file, and an in-memory list has
     nothing to join to. Saying so beats passing on a shape. */
  console.log('  — skipped: this needs Postgres, where the ledger and the players live');
  console.log('[adminLedger] 0 passed, 0 failed');
  process.exit(0);
}

(async () => {
  const pool = getPgPool();
  const A = id(), B = id();
  const tag = 'lgtest-' + Date.now();
  const made = [A, B];

  const mk = async (uid: string, username: string, displayName: string, phone: string): Promise<void> => {
    await pool.query(
      `INSERT INTO users(id, phone, username, display_name) VALUES ($1,$2,$3,$4)`,
      [uid, phone, username, displayName]);
  };
  /* Random-ish phones and names: a fixed pair collides with the previous run on
     `users_phone_key`, which reads as a failure of the code under test and is
     nothing of the sort. */
  const n = String(Date.now()).slice(-8);
  await mk(A, 'reza' + n, 'رضا محمدی', '0912' + n);
  await mk(B, 'sara' + n, 'سارا کریمی', '0913' + n);

  const post = (uid: string, entryType: any, kind: any, amount: number, description: string): Promise<unknown> =>
    postEntry({ userId: uid, entryType, kind, amount, idempotencyKey: tag + ':' + id(), description, refType: 'test', refId: tag });

  await post(A, 'match_reward', 'credit', 50000, tag + ' جایزهٔ مسابقه');
  await post(A, 'ticket_purchase', 'debit', 20000, tag + ' خرید بلیط');
  await post(B, 'match_reward', 'credit', 30000, tag + ' جایزهٔ مسابقه');
  /* A LOCK IS MONEY LEAVING. It is taken out of what the player can spend even
     though nothing has been paid out yet, so counting it as an inflow — or as
     neither — makes the totals disagree with the balance the player is looking
     at. It is here because that mapping lives in this service and nowhere else
     tests it. */
  await post(B, 'withdraw_lock', 'lock', 10000, tag + ' رزرو برای دریافت');

  const mine = async (extra: Record<string, unknown> = {}): Promise<any> =>
    listAllEntries({ q: tag, pageSize: 100, ...extra } as any);

  await check('every player’s movements are in one list, not one player’s', async () => {
    const r = await mine();
    const users = new Set(r.rows.map((x: any) => x.userId));
    assert.equal(r.rows.length, 4, 'expected the four this test wrote, got ' + r.rows.length);
    assert.equal(users.size, 2, 'the list covered only one player');
  });

  await check('each row says WHO, not which uuid', async () => {
    /* Eight characters of a uuid cannot be matched against a support ticket, a
       bank statement, or a person. */
    const r = await mine();
    const row = r.rows.find((x: any) => x.userId === A)!;
    assert.equal(row.displayName, 'رضا محمدی', JSON.stringify(row.displayName));
    assert.equal(row.username, 'reza' + n);
    assert.ok(row.phone, 'no phone to match a caller against');
  });

  await check('the totals describe the whole filter, not the page on screen', async () => {
    /* A sum that changes when you turn the page is worse than no sum: it looks
       like an answer. */
    const r = await mine({ pageSize: 1 });
    assert.equal(r.rows.length, 1, 'the page itself should be one row');
    assert.equal(r.totals.count, 4, 'the count followed the page size');
    assert.equal(r.totals.credit, 80000, JSON.stringify(r.totals));
    /* 20,000 spent plus 10,000 locked. A lock that did not count here would
       leave the net 10,000 too high, for ever. */
    assert.equal(r.totals.debit, 30000, JSON.stringify(r.totals));
    assert.equal(r.totals.net, 50000, JSON.stringify(r.totals));
  });

  await check('one box searches the player’s name as well as the entry', async () => {
    /* Whoever is looking knows a name, or a phone, or a reference — not which
       column their word lives in. */
    const byName = await listAllEntries({ q: 'رضا محمدی', pageSize: 100 });
    assert.ok(byName.rows.some((x: any) => x.userId === A), 'a player’s display name found nothing');
    const byPhone = await listAllEntries({ q: '0913' + n, pageSize: 100 });
    assert.ok(byPhone.rows.length > 0 && byPhone.rows.every((x: any) => x.userId === B), 'a phone number found the wrong rows');
    const byUser = await listAllEntries({ q: 'sara' + n, pageSize: 100 });
    assert.ok(byUser.rows.every((x: any) => x.userId === B));
  });

  await check('and it still searches the entry itself', async () => {
    const byDesc = await listAllEntries({ q: tag + ' خرید بلیط', pageSize: 100 });
    assert.equal(byDesc.rows.length, 1, JSON.stringify(byDesc.rows.map((r: any) => r.description)));
    const byType = await listAllEntries({ q: 'ticket_purchase', pageSize: 100 });
    assert.ok(byType.rows.length > 0);
  });

  await check('one player can be singled out', async () => {
    const r = await listAllEntries({ q: tag, userId: A, pageSize: 100 });
    assert.equal(r.rows.length, 2);
    assert.ok(r.rows.every((x: any) => x.userId === A));
    assert.equal(r.totals.net, 30000, JSON.stringify(r.totals));
  });

  await check('and so can one kind of movement, or one size of it', async () => {
    const credits = await mine({ kind: 'credit' });
    assert.equal(credits.rows.length, 2);
    const big = await mine({ minAmount: 40000 });
    assert.equal(big.rows.length, 1, JSON.stringify(big.rows.map((r: any) => r.amount)));
    const small = await mine({ maxAmount: 15000 });
    assert.equal(small.rows.length, 1, JSON.stringify(small.rows.map((r: any) => r.amount)));
    assert.equal(small.rows[0].amount, 10000);
    const byType = await mine({ type: 'match_reward' });
    assert.equal(byType.rows.length, 2);
    const locks = await mine({ kind: 'lock' });
    assert.equal(locks.rows.length, 1, 'a reservation is its own kind of movement');
  });

  await check('a date range cuts off at both ends', async () => {
    const future = new Date(Date.now() + 864e5).toISOString();
    assert.equal((await mine({ from: future })).rows.length, 0, 'rows from after tomorrow');
    const past = new Date(Date.now() - 864e5).toISOString();
    assert.equal((await mine({ to: past })).rows.length, 0, 'rows from before yesterday');
    assert.equal((await mine({ from: past, to: future })).rows.length, 4);
  });

  await check('newest first, unless asked otherwise', async () => {
    const desc = await mine();
    const asc = await mine({ sort: 'asc' });
    assert.equal(desc.rows[0].id, asc.rows[asc.rows.length - 1].id, 'the two orders are not reverses of each other');
  });

  await check('the export is the whole filter, and opens as Persian in Excel', async () => {
    const r = await mine();
    const csv = ledgerAsCsv(r.rows);
    /* Without the BOM, Excel reads a UTF-8 file as mojibake — and the one
       person who needs this file is the one who opens it in Excel. */
    assert.ok(csv.startsWith('﻿'), 'no BOM: the file opens as mojibake');
    assert.equal(csv.trim().split('\n').length, 5, 'header plus four rows');
    assert.ok(csv.includes('رضا محمدی'), 'the export dropped the name it exists to carry');
  });

  await check('a name with a comma in it does not break the export', async () => {
    /* One unquoted comma shifts every column after it, and a spreadsheet full
       of shifted columns still opens — it is simply wrong. */
    const csv = ledgerAsCsv([{ ...(await mine()).rows[0], displayName: 'محمدی, رضا "رضی"' } as any]);
    const line = csv.trim().split('\n')[1]!;
    assert.ok(line.includes('"محمدی, رضا ""رضی"""'), line);
  });

  /* NOTHING IS CLEANED UP, ON PURPOSE. `wallet_ledger` has a trigger that
     refuses UPDATE and DELETE — an append-only ledger is the reason any of
     these numbers can be trusted, and a test that disabled it to tidy after
     itself would be teaching the opposite of what the table is for. So the
     rows stay, and isolation is done the other way round: every run writes
     under its own `tag` and its own player names, and every query above is
     filtered by them. A second run counts its own three rows, not six. */
  void made;
  console.log(`[adminLedger] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
