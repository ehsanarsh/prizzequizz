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
  await postEntry({ userId: u2, entryType: 'match_reward', kind: 'credit', amount: 1_000_000, idempotencyKey: 't2:seed' });
  // no / wrong mobile code rejected — nothing is locked or recorded
  await assert.rejects(() => requestWithdraw({ userId: u2, amount: 300_000, destination: 'IR012345678901234567890123' }),
    (e: unknown) => e instanceof WalletError && e.code === 'WITHDRAW_OTP_INVALID');
  await assert.rejects(() => requestWithdraw({ userId: u2, amount: 300_000, destination: 'IR012345678901234567890123', otp: '0000' }),
    (e: unknown) => e instanceof WalletError && e.code === 'WITHDRAW_OTP_INVALID');
  // below-min rejected
  await assert.rejects(() => requestWithdraw({ userId: u2, amount: 1000, destination: 'IR012345678901234567890123', otp: '1234' }),
    (e: unknown) => e instanceof WalletError && e.code === 'WITHDRAW_BELOW_MIN');
  // bad destination rejected
  await assert.rejects(() => requestWithdraw({ userId: u2, amount: 300_000, destination: 'nonsense', otp: '1234' }),
    (e: unknown) => e instanceof WalletError && e.code === 'DESTINATION_INVALID');
  // request (with valid code) → funds locked; KYC fields captured
  const wd = await requestWithdraw({ userId: u2, amount: 300_000, destination: 'IR012345678901234567890123', otp: '1234', nationalId: '0012345678', holderName: 'کاربر تست' });
  assert.equal(wd.nationalId, '0012345678', 'national id stored on request');
  assert.equal(wd.holderName, 'کاربر تست', 'holder name stored on request');
  let a2 = await getAccount(u2);
  assert.deepEqual([a2.available, a2.locked], [700_000, 300_000], 'withdraw locks funds');
  // reject → funds released with reason recorded
  const rejected = await transitionWithdraw(wd.id, 'reject', { id: u1, reason: 'اطلاعات شبا ناقص' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectReason, 'اطلاعات شبا ناقص');
  a2 = await getAccount(u2);
  assert.deepEqual([a2.available, a2.locked], [1_000_000, 0], 'reject releases funds');
  // request again → approve → paid (settle) with operator + reference
  const wd2 = await requestWithdraw({ userId: u2, amount: 400_000, destination: 'IR012345678901234567890123', otp: '1234' });
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

  // ---------- 5) Top-ups are gone: a payment must be FOR something ----------
  /* This used to prove a deposit settled exactly once. There are no deposits
     any more: a bare payment intent is refused, and a payment that carries an
     order delivers the order instead of crediting the صندوق. The detailed
     behaviour lives in prizeVault.test.ts; what is checked here is that the
     door this file used to walk through is shut. */
  const u3 = await makeUser('3');
  await assert.rejects(() => createPaymentIntent({ userId: u3, amount: 50_000 } as any),
    (e: unknown) => e instanceof WalletError && e.code === 'DEPOSIT_REMOVED');
  assert.equal((await getAccount(u3)).available, 0, 'no balance appeared');
  await assert.rejects(() => postEntry({ userId: u3, entryType: 'deposit', kind: 'credit', amount: 50_000, idempotencyKey: 't3:dep' }),
    (e: unknown) => e instanceof WalletError && e.code === 'DEPOSIT_REMOVED');
  console.log('\u2714 top-ups removed: no intent without an order, no deposit in the ledger');

  // ---------- 6) Concurrency: parallel spends can never overspend ----------
  const u4 = await makeUser('4');
  await postEntry({ userId: u4, entryType: 'match_reward', kind: 'credit', amount: 1000, idempotencyKey: 't4:seed' });
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
  /* The seed is a prize now, so it lands in totalPrizes; totalDeposits is a
     legacy figure that must read zero on an account created after the change. */
  assert.equal(dash.totalPrizes, 1_000_000);
  assert.equal(dash.totalDeposits, 0);
  assert.equal(dash.totalWithdrawn, 400_000);
  assert.ok(dash.lastTransactionAt, 'last transaction date present');
  assert.equal(dash.accountStatus, 'active');
  console.log('✔ dashboard aggregates');

  // ---------- 9) Match reward applies the platform rake (net credit + fee) ----------
  const { gameConfig } = await import('../core/config.js');
  (gameConfig as any).economy = { ...(gameConfig as any).economy, paid: { ...(gameConfig as any).economy?.paid, rakePercent: 5 } };
  const { getRakePercent } = await import('../services/economyConfig.js');
  assert.equal(getRakePercent(), 5, 'rake read from live config');
  const { applyReward } = await import('../services/rewardEngine.js');
  const u5 = await makeUser('5');
  // gross 50,000 → 5% fee (2,500) → net 47,500
  await applyReward({ id: u5 } as any, { type: 'cash', amount: 50_000, status: 'granted' } as any, 'match-rake-1');
  assert.equal((await getAccount(u5)).available, 47_500, 'winner nets gross minus 5% rake');
  const led = await listEntries(u5, { sort: 'asc' });
  assert.ok(led.rows.some((e) => e.entryType === 'match_reward' && e.amount === 50_000), 'gross reward entry recorded');
  assert.ok(led.rows.some((e) => e.entryType === 'fee' && e.amount === 2_500), 'platform fee entry recorded');
  // Idempotent: replaying the same match reward does not pay twice.
  await applyReward({ id: u5 } as any, { type: 'cash', amount: 50_000, status: 'granted' } as any, 'match-rake-1');
  assert.equal((await getAccount(u5)).available, 47_500, 'reward is paid exactly once');
  // Live rake change takes effect immediately (10% → net 45,000).
  (gameConfig as any).economy.paid.rakePercent = 10;
  const u6 = await makeUser('6');
  await applyReward({ id: u6 } as any, { type: 'cash', amount: 50_000, status: 'granted' } as any, 'match-rake-2');
  assert.equal((await getAccount(u6)).available, 45_000, 'rake change applies live');
  console.log('✔ match reward rake: net credit + fee entry + idempotent + live-configurable');

  // ---------- 10) Tickets: DB-backed asset, separate from the wallet ----------
  const { gameConfig: gc2 } = await import('../core/config.js');
  (gc2 as any).economy = { ...(gc2 as any).economy, wallet: { ...(gc2 as any).economy?.wallet, ticketPrices: { green: 12500, blue: 25000, red: 50000 } } };
  const { purchaseTicket, consumeTicket, refundTicket, getTickets, TicketError } = await import('../services/ticketService.js');
  const u7 = await makeUser('7');
  await postEntry({ userId: u7, entryType: 'match_reward', kind: 'credit', amount: 100_000, idempotencyKey: 't7:seed' });
  // buy blue (25,000) → wallet debited, ticket granted
  const buy = await purchaseTicket({ userId: u7, tier: 'blue', idempotencyKey: 't7:buyblue' });
  assert.equal(buy.balance, 75_000, 'ticket purchase debits wallet');
  assert.equal((await getTickets(u7)).blue, 1, 'ticket granted in DB');
  // replay purchase = idempotent (no second debit, no second ticket)
  const buyDup = await purchaseTicket({ userId: u7, tier: 'blue', idempotencyKey: 't7:buyblue' });
  assert.equal(buyDup.duplicate, true);
  assert.equal((await getAccount(u7)).available, 75_000, 'idempotent purchase does not double-debit');
  // buy red (50,000) → 25,000 left; a SECOND red (50,000) can't be afforded
  await purchaseTicket({ userId: u7, tier: 'red', idempotencyKey: 't7:buyred1' });
  assert.equal((await getAccount(u7)).available, 25_000);
  await assert.rejects(() => purchaseTicket({ userId: u7, tier: 'red', idempotencyKey: 't7:buyred2' }),
    (e: unknown) => e instanceof WalletError && e.code === 'INSUFFICIENT_FUNDS');
  assert.equal((await getTickets(u7)).red, 1, 'failed purchase grants no extra ticket');
  // consume the blue ticket for a match — wallet UNCHANGED (stays 25,000)
  const balBefore = (await getAccount(u7)).available;
  await consumeTicket(u7, 'blue');
  assert.equal((await getTickets(u7)).blue, 0, 'consume removes the ticket');
  assert.equal((await getAccount(u7)).available, balBefore, 'consuming a ticket never touches the wallet');
  // consuming with none left is rejected
  await assert.rejects(() => consumeTicket(u7, 'blue'), (e: unknown) => e instanceof TicketError && e.code === 'NO_TICKET');
  // refund gives it back
  await refundTicket(u7, 'blue');
  assert.equal((await getTickets(u7)).blue, 1, 'refund restores the ticket');
  // concurrency: buy 3, fire 10 parallel consumes → exactly 3 succeed
  const u8 = await makeUser('8');
  await postEntry({ userId: u8, entryType: 'match_reward', kind: 'credit', amount: 1_000_000, idempotencyKey: 't8:seed' });
  for (let i = 0; i < 3; i++) await purchaseTicket({ userId: u8, tier: 'green', idempotencyKey: `t8:g${i}` });
  const consumes = await Promise.allSettled(Array.from({ length: 10 }, () => consumeTicket(u8, 'green')));
  assert.equal(consumes.filter((r) => r.status === 'fulfilled').length, 3, 'exactly 3 of 10 parallel consumes succeed');
  assert.equal((await getTickets(u8)).green, 0, 'no negative tickets under concurrency');
  console.log('✔ tickets: DB-backed, wallet-separate, atomic purchase/consume/refund, no double-consume');

  console.log('\nALL WALLET TESTS PASSED');
}

main().then(() => process.exit(0)).catch((e) => { console.error('WALLET TEST FAILED:', e); process.exit(1); });
