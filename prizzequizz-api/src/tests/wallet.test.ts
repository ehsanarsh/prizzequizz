/* Wallet ledger financial tests: postings math, idempotency (anti double
 * spend/pay), withdraw lifecycle, signature-gated deposits, concurrency, and
 * ledger↔account consistency. Runs standalone on the memory driver:
 *   node dist/tests/wallet.test.js
 * With DATABASE_URL set it exercises the SAME code paths against Postgres.
 */
import { strict as assert } from 'node:assert';

process.env.REPOSITORY_DRIVER = process.env.REPOSITORY_DRIVER || 'memory';
if (!process.env.DATABASE_URL) delete process.env.DATABASE_URL;

const { repositories } = await import('../repositories/index.js');
const {
  postEntry, getAccount, getDashboard, listEntries, requestWithdraw, transitionWithdraw,
  verifyConsistency, WalletError, findEntryByIdempotencyKey
} = await import('../services/walletLedgerService.js');
const { createPaymentIntent, settlePaymentIntent, paymentSignature } = await import('../services/paymentService.js');

async function makeUser(idSuffix: string): Promise<string> {
  const uid = `00000000-0000-4000-8000-00000000000${idSuffix}`;
  await repositories.users.save({
    id: uid, phone: `+9891200000${idSuffix}`, username: `wallet_test_${idSuffix}`, displayName: `تستی ${idSuffix}`,
    plan: 'premium', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return uid;
}

async function main(): Promise<void> {
  // ---------- 1) Posting math: credit / debit / lock / release / settle ----------
  const u1 = await makeUser('1');
  await postEntry({ userId: u1, entryType: 'bonus', kind: 'credit', amount: 1000, idempotencyKey: 't1:credit' });
  await postEntry({ userId: u1, entryType: 'fee', kind: 'debit', amount: 300, idempotencyKey: 't1:debit' });
  let acc = await getAccount(u1);
  assert.equal(acc.available, 700, 'credit+debit math');
  await postEntry({ userId: u1, entryType: 'withdraw_lock', kind: 'lock', amount: 500, idempotencyKey: 't1:lock' });
  acc = await getAccount(u1);
  assert.deepEqual([acc.available, acc.locked], [200, 500], 'lock moves available→locked');
  await postEntry({ userId: u1, entryType: 'withdraw_release', kind: 'release', amount: 200, idempotencyKey: 't1:release' });
  await postEntry({ userId: u1, entryType: 'withdraw_paid', kind: 'settle', amount: 300, idempotencyKey: 't1:settle' });
  acc = await getAccount(u1);
  assert.deepEqual([acc.available, acc.locked], [400, 0], 'release+settle math');
  // users.wallet mirror follows the ledger
  assert.equal((await repositories.users.findById(u1))!.wallet, 400, 'users.wallet mirrors available');
  // balance_before/after recorded on each row
  const hist = await listEntries(u1, { sort: 'asc' });
  assert.equal(hist.rows[0]!.availableBefore, 0);
  assert.equal(hist.rows[0]!.availableAfter, 1000);
  console.log('✔ posting math + mirror + before/after');

  // ---------- 2) Idempotency: same key replayed → exactly one entry ----------
  const dup = await postEntry({ userId: u1, entryType: 'bonus', kind: 'credit', amount: 999, idempotencyKey: 't1:credit' });
  assert.equal(dup.duplicate, true, 'replay flagged duplicate');
  assert.equal((await getAccount(u1)).available, 400, 'replay does not credit again');
  console.log('✔ idempotency (anti double post)');

  // ---------- 3) Insufficient funds rejected, balance untouched ----------
  await assert.rejects(
    () => postEntry({ userId: u1, entryType: 'match_stake', kind: 'debit', amount: 100000, idempotencyKey: 't1:overdraft' }),
    (e: unknown) => e instanceof WalletError && e.code === 'INSUFFICIENT_FUNDS');
  assert.equal((await getAccount(u1)).available, 400, 'failed debit leaves balance intact');
  assert.equal(await findEntryByIdempotencyKey('t1:overdraft'), null, 'no ledger row for failed debit');
  console.log('✔ overdraft rejected atomically');

  // ---------- 4) Withdraw lifecycle ----------
  const u2 = await makeUser('2');
  await postEntry({ userId: u2, entryType: 'deposit', kind: 'credit', amount: 1_000_000, idempotencyKey: 't2:seed' });
  // below-min rejected
  await assert.rejects(() => requestWithdraw({ userId: u2, amount: 1000, destination: 'IR012345678901234567890123' }),
    (e: unknown) => e instanceof WalletError && e.code === 'WITHDRAW_BELOW_MIN');
  // bad destination rejected
  await assert.rejects(() => requestWithdraw({ userId: u2, amount: 300_000, destination: 'nonsense' }),
    (e: unknown) => e instanceof WalletError && e.code === 'DESTINATION_INVALID');
  // request → funds locked
  const wd = await requestWithdraw({ userId: u2, amount: 300_000, destination: 'IR012345678901234567890123' });
  let a2 = await getAccount(u2);
  assert.deepEqual([a2.available, a2.locked], [700_000, 300_000], 'withdraw locks funds');
  // reject → funds released with reason recorded
  const rejected = await transitionWithdraw(wd.id, 'reject', { id: u1, reason: 'اطلاعات شبا ناقص' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectReason, 'اطلاعات شبا ناقص');
  a2 = await getAccount(u2);
  assert.deepEqual([a2.available, a2.locked], [1_000_000, 0], 'reject releases funds');
  // request again → approve → paid (settle) with operator + reference
  const wd2 = await requestWithdraw({ userId: u2, amount: 400_000, destination: 'IR012345678901234567890123' });
  await transitionWithdraw(wd2.id, 'approve', { id: u1 });
  const paid = await transitionWithdraw(wd2.id, 'paid', { id: u1, paymentReference: 'BANK-REF-1234' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paymentReference, 'BANK-REF-1234');
  assert.ok(paid.paidAt, 'paid_at recorded');
  a2 = await getAccount(u2);
  assert.deepEqual([a2.available, a2.locked], [600_000, 0], 'paid settles locked funds');
  // double-pay replay is idempotent (ledger key wd_paid:{id})
  await assert.rejects(() => transitionWithdraw(wd2.id, 'paid', { id: u1 }),
    (e: unknown) => e instanceof WalletError && e.code === 'WITHDRAW_BAD_STATE');
  console.log('✔ withdraw lifecycle (lock/reject-release/approve/paid + no double pay)');

  // ---------- 5) Deposit settle: signature-gated, double-payment safe ----------
  const u3 = await makeUser('3');
  const intent = await createPaymentIntent({ userId: u3, amount: 50_000 });
  // forged signature rejected
  await assert.rejects(() => settlePaymentIntent(intent.id, 'deadbeef'.repeat(8), 'paid'),
    (e: unknown) => e instanceof WalletError && e.code === 'PAYMENT_SIGNATURE_INVALID');
  assert.equal((await getAccount(u3)).available, 0, 'forged callback credits nothing');
  // valid signature settles exactly once
  const sig = paymentSignature(intent.id, intent.amount, 'paid');
  await settlePaymentIntent(intent.id, sig, 'paid');
  await settlePaymentIntent(intent.id, sig, 'paid'); // replayed callback
  assert.equal((await getAccount(u3)).available, 50_000, 'replayed callback does not double credit');
  console.log('✔ deposit: signature required + double payment blocked');

  // ---------- 6) Concurrency: parallel spends can never overspend ----------
  const u4 = await makeUser('4');
  await postEntry({ userId: u4, entryType: 'deposit', kind: 'credit', amount: 1000, idempotencyKey: 't4:seed' });
  const attempts = await Promise.allSettled(
    Array.from({ length: 30 }, (_, i) => postEntry({ userId: u4, entryType: 'match_stake', kind: 'debit', amount: 100, idempotencyKey: `t4:spend:${i}` })));
  const okCount = attempts.filter((r) => r.status === 'fulfilled').length;
  assert.equal(okCount, 10, `exactly 10 of 30 parallel 100-debits succeed (got ${okCount})`);
  assert.equal((await getAccount(u4)).available, 0, 'final balance exactly 0, never negative');
  console.log('✔ concurrency: 30 parallel debits → no double spend');

  // ---------- 7) Financial consistency: ledger sums == account balances ----------
  const consistency = await verifyConsistency();
  assert.equal(consistency.mismatches.length, 0, `ledger/account mismatch: ${JSON.stringify(consistency.mismatches)}`);
  assert.ok(consistency.checked >= 4, 'all test accounts checked');
  console.log(`✔ consistency: ${consistency.checked} accounts, 0 mismatches`);

  // ---------- 8) Dashboard totals ----------
  const dash = await getDashboard(u2) as any;
  assert.equal(dash.totalDeposits, 1_000_000);
  assert.equal(dash.totalWithdrawn, 400_000);
  assert.ok(dash.lastTransactionAt, 'last transaction date present');
  assert.equal(dash.accountStatus, 'active');
  console.log('✔ dashboard aggregates');

  console.log('\nALL WALLET TESTS PASSED');
}

main().then(() => process.exit(0)).catch((e) => { console.error('WALLET TEST FAILED:', e); process.exit(1); });
