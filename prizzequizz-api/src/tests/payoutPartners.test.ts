/* TAKING A PRIZE OUT AS SOMETHING THAT ISN'T CASH.
 *
 * A player can ask for their prize as a bank transfer or as credit with a
 * partner. The partner path hands out a code from a shelf the operator stocks,
 * and the things that must be true are all about that shelf:
 *
 *   - two players cannot be promised the same last code
 *   - a rejected request puts its code back rather than burning it
 *   - a code is not the player's until the payout is actually made
 *   - a partner with an empty shelf is never offered
 *
 * Run: npx tsx src/tests/payoutPartners.test.ts
 */
import assert from 'node:assert/strict';
import {
  savePartner, addCodes, stock, payoutOptions, reserveCode, issueForWithdraw,
  releaseForWithdraw, issuedCodeFor, listCodes, removePartner, PayoutError, _resetPayouts
} from '../services/payoutPartnerService.js';
import { postEntry, requestWithdraw, transitionWithdraw, getAccount, WalletError } from '../services/walletLedgerService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import { sendWithdrawOtp, _resetOtp } from '../services/withdrawOtpService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(prize = 0): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'po' + uid.slice(0, 8), displayName: 'po',
    phone: '09' + String(100000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0, status: 'active',
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  if (prize > 0) await postEntry({ userId: uid, entryType: 'match_reward', kind: 'credit', amount: prize, idempotencyKey: 'prize:' + id(), description: 'جایزه' });
  return uid;
}

/* The payout code is a real per-user code now, so a test has to ask for one
 * exactly as the game does. With SMS off it comes back in the response. */
async function otpFor(uid: string): Promise<string> {
  const r = await sendWithdrawOtp(uid, '09120000000');
  return r.testCode!;
}
const AMT = 200_000;

async function partnerWith(codes: string[], amount = AMT): Promise<string> {
  const p = await savePartner({ name: 'اسنپ ' + id().slice(0, 4), denominations: [amount], instructions: 'در اپلیکیشن وارد کن' });
  if (codes.length) await addCodes(p.id, amount, codes);
  return p.id;
}

async function run(): Promise<void> {
  _resetPayouts(); _resetOtp();

  /* ── the shelf ────────────────────────────────────────────────────── */

  await check('codes load, and loading the same list twice adds nothing', async () => {
    const pid = await partnerWith([]);
    const first = await addCodes(pid, AMT, ['AAA-1', 'AAA-2', 'AAA-3']);
    assert.deepEqual([first.added, first.skipped], [3, 0]);
    const again = await addCodes(pid, AMT, ['AAA-1', 'AAA-2', 'AAA-3']);
    assert.deepEqual([again.added, again.skipped], [0, 3], 'a re-paste does not double the shelf');
    assert.equal((await stock(pid))[AMT], 3);
  });

  await check('a partner with an empty shelf is not offered to anybody', async () => {
    _resetPayouts();
    await partnerWith([]);
    const opts = await payoutOptions();
    assert.equal(opts.length, 0, 'nothing to promise, so nothing is offered');
  });

  await check('a partner with stock is offered, with real counts', async () => {
    _resetPayouts();
    const pid = await partnerWith(['B-1', 'B-2']);
    const opts = await payoutOptions();
    assert.equal(opts.length, 1);
    assert.equal(opts[0]!.id, pid);
    assert.deepEqual(opts[0]!.amounts, [{ amount: AMT, available: 2 }]);
  });

  /* ── the race ─────────────────────────────────────────────────────── */

  await check('two claims on the last code: one wins, one is told it is gone', async () => {
    _resetPayouts();
    const pid = await partnerWith(['ONLY-ONE']);
    const a = await player(), b = await player();
    const results = await Promise.allSettled([
      reserveCode({ partnerId: pid, amount: AMT, userId: a, withdrawId: 'w-a' }),
      reserveCode({ partnerId: pid, amount: AMT, userId: b, withdrawId: 'w-b' })
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const no = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'exactly one got it');
    assert.equal(no.length, 1, 'and the other was refused');
    assert.equal((await stock(pid))[AMT] ?? 0, 0, 'the shelf is empty, not negative');
  });

  await check('an amount the partner does not offer is refused', async () => {
    _resetPayouts();
    const pid = await partnerWith(['C-1']);
    const uid = await player();
    await assert.rejects(
      () => reserveCode({ partnerId: pid, amount: 999_999, userId: uid, withdrawId: 'w' }),
      (e: unknown) => e instanceof PayoutError && e.code === 'AMOUNT_NOT_OFFERED'
    );
  });

  /* ── reserve → issue, reserve → release ───────────────────────────── */

  await check('a reserved code is NOT yet the player’s', async () => {
    _resetPayouts();
    const pid = await partnerWith(['D-1']);
    const uid = await player();
    await reserveCode({ partnerId: pid, amount: AMT, userId: uid, withdrawId: 'w-d' });
    assert.equal(await issuedCodeFor('w-d', uid), null, 'nothing to show before the payout');
  });

  await check('issuing hands it over, and issuing twice hands over the same one', async () => {
    _resetPayouts();
    const pid = await partnerWith(['E-1']);
    const uid = await player();
    await reserveCode({ partnerId: pid, amount: AMT, userId: uid, withdrawId: 'w-e' });
    const first = await issueForWithdraw('w-e');
    const second = await issueForWithdraw('w-e');
    assert.equal(first!.code, 'E-1');
    assert.equal(second!.code, 'E-1', 'a repeated payout shows the same code, not a new one');
    assert.equal((await issuedCodeFor('w-e', uid))!.code, 'E-1');
  });

  await check('releasing puts it back on the shelf for somebody else', async () => {
    _resetPayouts();
    const pid = await partnerWith(['F-1']);
    const uid = await player();
    await reserveCode({ partnerId: pid, amount: AMT, userId: uid, withdrawId: 'w-f' });
    assert.equal((await stock(pid))[AMT] ?? 0, 0);
    assert.equal(await releaseForWithdraw('w-f'), true);
    assert.equal((await stock(pid))[AMT], 1, 'back in stock');
  });

  await check('an issued code can never be released back', async () => {
    _resetPayouts();
    const pid = await partnerWith(['G-1']);
    const uid = await player();
    await reserveCode({ partnerId: pid, amount: AMT, userId: uid, withdrawId: 'w-g' });
    await issueForWithdraw('w-g');
    assert.equal(await releaseForWithdraw('w-g'), false);
    assert.equal((await stock(pid))[AMT] ?? 0, 0, 'a code given away is gone');
  });

  /* ── the whole journey, through the withdrawal ────────────────────── */

  await check('a partner payout: prize locked, code reserved, code issued on payout', async () => {
    _resetPayouts();
    const pid = await partnerWith(['H-1']);
    const uid = await player(AMT * 2);
    const wd = await requestWithdraw({ userId: uid, amount: AMT, payoutMethod: 'partner', partnerId: pid, otp: await otpFor(uid) });
    assert.equal(wd.payoutMethod, 'partner');
    assert.equal(wd.partnerId, pid);
    assert.equal((await getAccount(uid)).locked, AMT, 'the prize is held while it is in flight');
    assert.equal(await issuedCodeFor(wd.id, uid), null, 'not the player’s yet');

    await transitionWithdraw(wd.id, 'approve', { id: 'op' });
    await transitionWithdraw(wd.id, 'paid', { id: 'op' });
    const got = await issuedCodeFor(wd.id, uid);
    assert.equal(got!.code, 'H-1', 'the code is handed over when the payout is made');
    assert.equal((await getAccount(uid)).locked, 0, 'and the hold is settled');
  });

  await check('a rejected partner payout returns both the money and the code', async () => {
    _resetPayouts();
    const pid = await partnerWith(['I-1']);
    const uid = await player(AMT * 2);
    const wd = await requestWithdraw({ userId: uid, amount: AMT, payoutMethod: 'partner', partnerId: pid, otp: await otpFor(uid) });
    assert.equal((await stock(pid))[AMT] ?? 0, 0, 'held while the request is open');
    await transitionWithdraw(wd.id, 'reject', { id: 'op', reason: 'تست' });
    assert.equal((await getAccount(uid)).available, AMT * 2, 'the prize came back');
    assert.equal((await stock(pid))[AMT], 1, 'and so did the code');
  });

  await check('asking when the shelf is empty fails WITHOUT holding the prize', async () => {
    /* The nastiest version of this bug: a request that can never be paid,
       sitting on the player's balance forever. */
    _resetPayouts();
    const pid = await partnerWith([]);
    const uid = await player(AMT * 2);
    await assert.rejects(
      async () => requestWithdraw({ userId: uid, amount: AMT, payoutMethod: 'partner', partnerId: pid, otp: await otpFor(uid) }),
      (e: unknown) => e instanceof WalletError
    );
    const acct = await getAccount(uid);
    assert.equal(acct.locked, 0, 'nothing is held');
    assert.equal(acct.available, AMT * 2, 'and the prize is fully available again');
  });

  await check('a partner payout never asks for bank details', async () => {
    _resetPayouts();
    const pid = await partnerWith(['J-1']);
    const uid = await player(AMT * 2);
    const wd = await requestWithdraw({ userId: uid, amount: AMT, payoutMethod: 'partner', partnerId: pid, otp: await otpFor(uid) });
    assert.ok(wd.id, 'accepted with no card, no SHEBA, no national id');
  });

  await check('the bank door still works exactly as before', async () => {
    _resetPayouts();
    const uid = await player(AMT * 2);
    const wd = await requestWithdraw({ userId: uid, amount: AMT, destination: 'IR' + '1'.repeat(24), otp: await otpFor(uid) });
    assert.equal(wd.payoutMethod, 'bank');
    await transitionWithdraw(wd.id, 'approve', { id: 'op' });
    await transitionWithdraw(wd.id, 'paid', { id: 'op', paymentReference: 'REF-1' });
    assert.equal((await getAccount(uid)).available, AMT);
  });

  await check('a bank withdrawal still refuses a nonsense destination', async () => {
    const uid = await player(AMT * 2);
    const code = await otpFor(uid);
    await assert.rejects(
      () => requestWithdraw({ userId: uid, amount: AMT, destination: 'nope', otp: code }),
      (e: unknown) => e instanceof WalletError && e.code === 'DESTINATION_INVALID'
    );
  });

  await check('the wrong confirmation code stops everything, code included', async () => {
    _resetPayouts();
    const pid = await partnerWith(['K-1']);
    const uid = await player(AMT * 2);
    await otpFor(uid);   // a code was requested; the WRONG one is typed
    await assert.rejects(() => requestWithdraw({ userId: uid, amount: AMT, payoutMethod: 'partner', partnerId: pid, otp: '0000' }));
    assert.equal((await stock(pid))[AMT], 1, 'no code was taken off the shelf');
    assert.equal((await getAccount(uid)).locked, 0, 'and nothing was held');
  });

  /* ── the operator's shelf ─────────────────────────────────────────── */

  await check('deleting a partner keeps the codes players were given', async () => {
    _resetPayouts();
    const pid = await partnerWith(['L-1', 'L-2']);
    const uid = await player();
    await reserveCode({ partnerId: pid, amount: AMT, userId: uid, withdrawId: 'w-l' });
    await issueForWithdraw('w-l');
    await removePartner(pid);
    const left = await listCodes({ partnerId: pid });
    assert.equal(left.length, 1, 'the unused one is gone');
    assert.equal(left[0]!.status, 'issued', 'the record of what was paid out stays');
  });

  console.log(`[payoutPartners] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
