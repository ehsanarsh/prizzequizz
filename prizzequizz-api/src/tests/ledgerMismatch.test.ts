/* WHEN THE LEDGER AND THE BALANCE DISAGREE, WHO AND BY HOW MUCH.
 *
 * «یه دکمه بررسی و سازگاری دفتر کل رو می‌زنی می‌نویسه ۲۸ حساب ۰ مغایرت، ولی
 *  وقتی مغایرت داشته باشه معلوم نیست کدوم حساب‌هاست و مغایرت برای چی هست.»
 *
 * The healthy answer was already tested — wallet.test.ts asserts zero
 * mismatches — which is the one case that proves nothing about the report. This
 * is the other case: a balance deliberately pushed out of step with its own
 * ledger, and then the question the operator actually asks. Who is it, what
 * does each side say, and how far apart are they.
 *
 * The gap can only be created by writing a balance WITHOUT a ledger row, which
 * no exported function will do — and rightly so. That is done here in SQL, so
 * this needs a database. Set PGTEST_URL (or DATABASE_URL); without one it says
 * so and skips rather than passing silently.
 *
 * Run: PGTEST_URL=postgres://... npx tsx src/tests/ledgerMismatch.test.ts
 */
import assert from 'node:assert/strict';

const URL_ = process.env.PGTEST_URL || process.env.DATABASE_URL;
if (!URL_) {
  console.log('[ledgerMismatch] SKIPPED — no PGTEST_URL/DATABASE_URL, and a mismatch cannot be staged without one');
  process.exit(0);
}
process.env.DATABASE_URL = URL_;
process.env.REPOSITORY_DRIVER = 'postgres';

const { repositories } = await import('../repositories/index.js');
const { postEntry, verifyConsistency } = await import('../services/walletLedgerService.js');
const { getPgPool } = await import('../database/postgres.js');

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const UID = '00000000-0000-4000-8000-0000000000f1';
const CLEAN = '00000000-0000-4000-8000-0000000000f2';

async function run(): Promise<void> {
  const pool = getPgPool()!;
  for (const [id, n] of [[UID, '1'], [CLEAN, '2']] as const) {
    await repositories.users.save({
      id, phone: '+98912000009' + n, username: 'mismatch_test_' + n, displayName: 'حسابدار ' + n,
      plan: 'premium', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5, tickets: {}
    } as any);
  }
  await postEntry({ userId: UID, entryType: 'bonus', kind: 'credit', amount: 100_000, idempotencyKey: 'mm:seed:' + Date.now() });
  await postEntry({ userId: CLEAN, entryType: 'bonus', kind: 'credit', amount: 40_000, idempotencyKey: 'mm:clean:' + Date.now() });

  await check('with nothing wrong, nothing is reported', async () => {
    const r = await verifyConsistency(UID);
    assert.equal(r.mismatches.length, 0, JSON.stringify(r.mismatches));
    assert.ok(r.checked >= 1, 'the account was not even looked at');
  });

  /* The gap: money on the balance that no ledger row put there. */
  await pool.query('UPDATE wallet_accounts SET available = available + 7500, locked = locked + 250 WHERE user_id = $1', [UID]);

  let m: any;
  await check('a broken account is found', async () => {
    const r = await verifyConsistency();
    assert.ok(r.checked >= 2, 'only ' + r.checked + ' accounts were checked');
    m = r.mismatches.find((x) => x.userId === UID);
    assert.ok(m, 'the account whose balance was moved is not in the report');
  });

  await check('and a healthy one is not dragged in with it', async () => {
    const r = await verifyConsistency();
    assert.ok(!r.mismatches.some((x) => x.userId === CLEAN), 'a correct account was reported as broken');
  });

  await check('it says WHO, not just an id', async () => {
    assert.equal(m.username, 'mismatch_test_1');
    assert.equal(m.displayName, 'حسابدار 1');
    assert.equal(m.phone, '+989120000091');
  });

  await check('it says what each side thinks the balance is', async () => {
    assert.equal(m.account.available, 107_500, 'the stored balance');
    assert.equal(m.ledger.available, 100_000, 'the sum of the ledger rows');
    assert.equal(m.account.locked, 250);
    assert.equal(m.ledger.locked, 0);
  });

  await check('and how far apart they are, with the sign that says which way', async () => {
    /* account − ledger. Positive = the balance is holding money nothing posted,
       which is the direction that costs real money if it is paid out. */
    assert.equal(m.diff.available, 7_500);
    assert.equal(m.diff.locked, 250);
  });

  await check('asking about one account answers about that account only', async () => {
    const r = await verifyConsistency(UID);
    assert.equal(r.checked, 1, 'checked ' + r.checked);
    assert.equal(r.mismatches.length, 1);
    assert.equal(r.mismatches[0]!.userId, UID);
  });

  /* A shortfall is the other direction and must read as such — a report that
     shows every gap as positive cannot tell a missing payout from a windfall. */
  await pool.query('UPDATE wallet_accounts SET available = available - 20000 WHERE user_id = $1', [UID]);
  await check('a balance that is SHORT reads as negative', async () => {
    const r = await verifyConsistency(UID);
    const b = r.mismatches[0]!;
    assert.equal(b.diff.available, -12_500, JSON.stringify(b.diff));
    assert.ok(b.account.available < b.ledger.available, 'the account should be behind the ledger');
  });

  /* Put it back, so a test run leaves no broken money behind. */
  await pool.query('UPDATE wallet_accounts SET available = $2, locked = 0 WHERE user_id = $1', [UID, 100_000]);
  await check('and the cleanup really cleaned up', async () => {
    const r = await verifyConsistency(UID);
    assert.equal(r.mismatches.length, 0, JSON.stringify(r.mismatches));
  });

  console.log(`[ledgerMismatch] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
