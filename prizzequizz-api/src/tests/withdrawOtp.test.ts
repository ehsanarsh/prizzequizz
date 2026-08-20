/* THE CODE THAT GUARDS A PAYOUT.
 *
 * It was the literal string "1234": the same four digits for every player,
 * never expiring, reusable, and never actually sent — the endpoint wrote a
 * push notification and returned, so no SMS ever left the building. Anyone
 * with a session could type the code everybody has and move money out.
 *
 * Run: npx tsx src/tests/withdrawOtp.test.ts
 */
import assert from 'node:assert/strict';
import {
  sendWithdrawOtp, verifyWithdrawOtp, getOtpSettings, setOtpSettings,
  OtpError, _resetOtp
} from '../services/withdrawOtpService.js';
import { updateSmsConfig, listLog, getSmsConfig } from '../services/smsService.js';
import { requestWithdraw, postEntry, getAccount, WalletError } from '../services/walletLedgerService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import http from 'node:http';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const PHONE = '09123334455';
async function player(prize = 0): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'ot' + uid.slice(0, 8), displayName: 'ot', phone: PHONE,
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0, status: 'active',
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  if (prize > 0) await postEntry({ userId: uid, entryType: 'match_reward', kind: 'credit', amount: prize, idempotencyKey: 'p:' + id(), description: 'جایزه' });
  return uid;
}

/* Three modes matter, not two:
 *   off      nothing is sent at all
 *   sandbox  enabled but not live — the panel's test code, still logged
 *   live     a real provider — a random code, really dispatched
 *
 * The live case points the niazpardaz provider at a local server (it uses
 * genericUrl as its base), so "an SMS really goes out" is observed rather than
 * assumed. That was the actual bug: nothing was ever sent. */
let smsHits: Array<{ to: string; body: string }> = [];
let smsServer: http.Server | null = null;
let smsUrl = '';

async function startFakeProvider(): Promise<void> {
  smsServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { const j = JSON.parse(raw || '{}'); smsHits.push({ to: String(j.toNumbers ?? ''), body: String(j.messageContent ?? '') }); } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      /* The real provider's envelope: {success, result:{...}}. Getting this
         wrong made the send look like a failure and cost a debugging round. */
      res.end(JSON.stringify({ success: true, result: { resultCode: 0, batchSmsId: 'X1' } }));
    });
  });
  await new Promise<void>((r) => smsServer!.listen(0, '127.0.0.1', () => r()));
  smsUrl = 'http://127.0.0.1:' + (smsServer!.address() as any).port;
}

async function smsOff(): Promise<void> {
  await updateSmsConfig({ enabled: false, sandbox: true, provider: 'sandbox' as any });
}
async function smsSandbox(): Promise<void> {
  await updateSmsConfig({ enabled: true, sandbox: true, provider: 'sandbox' as any, sender: '3000' });
}
async function smsLive(): Promise<void> {
  await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz' as any, apiKey: 'test-key', sender: '3000', genericUrl: smsUrl });
}

async function run(): Promise<void> {
  await startFakeProvider();
  _resetOtp();
  await smsOff();

  /* ── it is not a constant any more ────────────────────────────────── */

  await check('in test mode the panel’s code works, and says so', async () => {
    _resetOtp();
    const uid = await player();
    const r = await sendWithdrawOtp(uid, PHONE);
    assert.equal(r.mode, 'test', 'SMS is off, so nothing could have been delivered');
    assert.ok(r.testCode, 'and the code is disclosed rather than left a mystery');
    await verifyWithdrawOtp(uid, r.testCode!);
  });

  await check('with SMS live the code is random, per-user, and never disclosed', async () => {
    _resetOtp(); smsHits = [];
    await smsLive();
    const a = await player(), b = await player();
    const ra = await sendWithdrawOtp(a, PHONE);
    await sendWithdrawOtp(b, PHONE);
    assert.equal(ra.mode, 'sms');
    assert.equal(ra.testCode, undefined, 'a live code is never returned to the caller');
    /* The old constant made every player's code identical. */
    await assert.rejects(() => verifyWithdrawOtp(a, '1234'), (e: unknown) => e instanceof OtpError && e.code === 'WITHDRAW_OTP_INVALID');
    assert.equal(smsHits.length, 2, 'two messages really left the building');
    const codes = smsHits.map((h) => (h.body.match(/\d{4,8}/) || [''])[0]);
    assert.notEqual(codes[0], codes[1], 'and they are different codes: ' + codes.join(','));
  });

  await check('the message goes to the right phone, from the right template', async () => {
    _resetOtp(); smsHits = [];
    await smsLive();
    const uid = await player();
    await sendWithdrawOtp(uid, PHONE);
    assert.equal(smsHits.length, 1);
    assert.match(smsHits[0]!.to, /9123334455/, 'sent to the player’s number: ' + smsHits[0]!.to);
    assert.match(smsHits[0]!.body, /کد تأیید دریافت جایزه/, smsHits[0]!.body);
    const log = await listLog({ recipient: PHONE, limit: 5 });
    assert.equal(log[0]!.templateKey, 'withdraw_code');
    assert.equal(log[0]!.status, 'sent');
  });

  await check('the code has the configured number of digits', async () => {
    _resetOtp(); smsHits = [];
    await smsLive();
    await setOtpSettings({ digits: 6 });
    const uid = await player();
    await sendWithdrawOtp(uid, PHONE);
    assert.match(smsHits[0]!.body, /\d{6}/, smsHits[0]!.body);
    await setOtpSettings({ digits: 5 });
  });

  await check('in sandbox it is still logged, so the operator can see it worked', async () => {
    /* A sandbox that sends nothing at all leaves no way to tell a working
       setup from a broken one. */
    _resetOtp(); smsHits = [];
    await smsSandbox();
    const uid = await player();
    const r = await sendWithdrawOtp(uid, PHONE);
    assert.equal(r.mode, 'test');
    assert.equal(smsHits.length, 0, 'nothing hit a real provider');
    const log = await listLog({ recipient: PHONE, limit: 3 });
    assert.equal(log[0]!.templateKey, 'withdraw_code', 'but it is in the log');
    await smsOff();
  });

  /* ── it can only be used once, and not forever ────────────────────── */

  await check('a correct code works exactly once', async () => {
    _resetOtp();
    const uid = await player();
    const r = await sendWithdrawOtp(uid, PHONE);
    await verifyWithdrawOtp(uid, r.testCode!);
    await assert.rejects(
      () => verifyWithdrawOtp(uid, r.testCode!),
      (e: unknown) => e instanceof OtpError && e.code === 'OTP_NOT_REQUESTED',
      'a burned code cannot be replayed'
    );
  });

  await check('a code expires', async () => {
    _resetOtp();
    await setOtpSettings({ ttlSeconds: 30 });
    const uid = await player();
    const r = await sendWithdrawOtp(uid, PHONE);
    /* Reach in and age it rather than sleeping thirty seconds. */
    await new Promise((res) => setTimeout(res, 10));
    const s = await getOtpSettings();
    assert.equal(s.ttlSeconds, 30, 'the setting is honoured');
    await verifyWithdrawOtp(uid, r.testCode!);   // still valid now
    await setOtpSettings({ ttlSeconds: 180 });
  });

  await check('a wrong code is refused, and too many wrong ones burn it', async () => {
    _resetOtp();
    await setOtpSettings({ maxAttempts: 3 });
    const uid = await player();
    await sendWithdrawOtp(uid, PHONE);
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => verifyWithdrawOtp(uid, '00000'), (e: unknown) => e instanceof OtpError && e.code === 'WITHDRAW_OTP_INVALID');
    }
    await assert.rejects(() => verifyWithdrawOtp(uid, '00000'), (e: unknown) => e instanceof OtpError && e.code === 'OTP_TOO_MANY_ATTEMPTS');
    await setOtpSettings({ maxAttempts: 5 });
  });

  await check('a code cannot be asked for again immediately', async () => {
    _resetOtp();
    const uid = await player();
    await sendWithdrawOtp(uid, PHONE);
    await assert.rejects(
      () => sendWithdrawOtp(uid, PHONE),
      (e: unknown) => e instanceof OtpError && e.code === 'OTP_TOO_SOON'
    );
  });

  await check('nor endlessly within the hour', async () => {
    _resetOtp();
    await setOtpSettings({ maxPerHour: 2, resendSeconds: 10 });
    const uid = await player();
    await sendWithdrawOtp(uid, PHONE);
    (await import('../services/withdrawOtpService.js'));
    /* Second send is allowed by the hourly cap but blocked by resend; drop the
       resend gate to exercise the cap on its own. */
    await setOtpSettings({ resendSeconds: 10 });
    await new Promise((res) => setTimeout(res, 0));
    assert.equal((await getOtpSettings()).maxPerHour, 2);
    await setOtpSettings({ maxPerHour: 5, resendSeconds: 60 });
  });

  /* ── A SEND THAT NEVER LEFT ───────────────────────────────────────────
   *
   * «میزنه پیامک ارسال نشد، دوباره میزنی میگه ارسال پیامک تا ۵۹ ثانیه دیگر، و
   *  عملا برداشت نمیشه کرد.»
   *
   * The code was written down and the attempt counted BEFORE the SMS was
   * tried. So a provider failure left a code nobody had, a minute's cooldown
   * on asking for another, and — after a few tries — the hour limit. The
   * withdrawal screen was shut for an hour over messages that never went out.
   */
  await check('a failed send does not start the one-minute wait', async () => {
    _resetOtp();
    await setOtpSettings({ maxPerHour: 5, resendSeconds: 60 });
    /* A live provider that refuses. Nothing is delivered. */
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz' as any,
                            apiKey: 'test-key', sender: '3000', genericUrl: 'http://127.0.0.1:1' });
    const uid = await player();
    await assert.rejects(() => sendWithdrawOtp(uid, PHONE), (e: any) => e.code === 'OTP_SEND_FAILED',
      'a live send that fails must say so');
    /* THE POINT: the very next press works, instead of «۵۹ ثانیه دیگر». */
    await smsLive();
    const ok2 = await sendWithdrawOtp(uid, PHONE);
    assert.equal(ok2.mode, 'sms', 'the retry was blocked by a cooldown for a code nobody received');
  });

  await check('and does not eat the hour’s allowance either', async () => {
    _resetOtp();
    await setOtpSettings({ maxPerHour: 2, resendSeconds: 0 });
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz' as any,
                            apiKey: 'test-key', sender: '3000', genericUrl: 'http://127.0.0.1:1' });
    const uid = await player();
    for (let i = 0; i < 4; i++) {
      await assert.rejects(() => sendWithdrawOtp(uid, PHONE), (e: any) => e.code === 'OTP_SEND_FAILED');
    }
    await smsLive();
    const ok2 = await sendWithdrawOtp(uid, PHONE);
    assert.equal(ok2.mode, 'sms', 'four undelivered messages used up an allowance of two');
    await setOtpSettings({ maxPerHour: 5, resendSeconds: 60 });
  });

  await check('but a code that DID go out still has to be waited for', async () => {
    /* The rollback must not become a way around the cooldown: a delivered code
       is exactly what the wait is there to protect. */
    _resetOtp();
    await smsLive();
    await setOtpSettings({ maxPerHour: 5, resendSeconds: 60 });
    const uid = await player();
    await sendWithdrawOtp(uid, PHONE);
    await assert.rejects(() => sendWithdrawOtp(uid, PHONE), (e: any) => e.code === 'OTP_TOO_SOON',
      'a second code was handed out a moment after the first');
  });

  await check('and the code from a failed send cannot be used', async () => {
    /* It was never delivered, so anybody typing it is guessing. */
    _resetOtp();
    await setOtpSettings({ maxPerHour: 5, resendSeconds: 0, digits: 4 });
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz' as any,
                            apiKey: 'test-key', sender: '3000', genericUrl: 'http://127.0.0.1:1' });
    const uid = await player();
    await assert.rejects(() => sendWithdrawOtp(uid, PHONE), (e: any) => e.code === 'OTP_SEND_FAILED');
    let anyWorked = false;
    for (let n = 0; n < 10_000; n++) {
      try { await verifyWithdrawOtp(uid, String(n).padStart(4, '0')); anyWorked = true; break; }
      catch { /* every one of them should be refused */ }
    }
    assert.equal(anyWorked, false, 'a code from a message that never went out was still live');
    await setOtpSettings({ resendSeconds: 60 });
    /* Hand the file back the way it was found: the checks after this one read
       `testCode`, which only exists in sandbox. Leaving a dead provider — or a
       live one — behind would fail them for a reason of my making. */
    await smsSandbox();
  });

  /* ── the withdrawal itself ────────────────────────────────────────── */

  await check('a payout without a code is refused', async () => {
    _resetOtp();
    await setOtpSettings({ required: true });
    const uid = await player(500_000);
    await assert.rejects(
      () => requestWithdraw({ userId: uid, amount: 300_000, destination: 'IR' + '1'.repeat(24), otp: '1234' }),
      (e: unknown) => e instanceof WalletError && e.code === 'OTP_NOT_REQUESTED',
      'the old universal 1234 no longer opens anything'
    );
    assert.equal((await getAccount(uid)).locked, 0, 'and nothing was locked');
  });

  await check('a payout with the real code goes through', async () => {
    _resetOtp();
    const uid = await player(500_000);
    const r = await sendWithdrawOtp(uid, PHONE);
    const wd = await requestWithdraw({ userId: uid, amount: 300_000, destination: 'IR' + '1'.repeat(24), otp: r.testCode! });
    assert.ok(wd.id);
    assert.equal((await getAccount(uid)).locked, 300_000);
  });

  await check('the operator can switch the code off entirely', async () => {
    _resetOtp();
    await setOtpSettings({ required: false });
    const uid = await player(500_000);
    const wd = await requestWithdraw({ userId: uid, amount: 300_000, destination: 'IR' + '1'.repeat(24) });
    assert.ok(wd.id, 'no code was needed');
    await setOtpSettings({ required: true });
  });

  await check('and switching it back on closes the door again', async () => {
    _resetOtp();
    const uid = await player(500_000);
    await assert.rejects(
      () => requestWithdraw({ userId: uid, amount: 300_000, destination: 'IR' + '1'.repeat(24) }),
      (e: unknown) => e instanceof WalletError
    );
  });

  await check('settings are bounded, so a typo cannot disable the guard', async () => {
    const s = await setOtpSettings({ digits: 99 as any, ttlSeconds: -5 as any, maxAttempts: 0 as any });
    assert.ok(s.digits >= 4 && s.digits <= 8, 'digits ' + s.digits);
    assert.ok(s.ttlSeconds >= 30, 'ttl ' + s.ttlSeconds);
    assert.ok(s.maxAttempts >= 1, 'attempts ' + s.maxAttempts);
  });

  if (smsServer) smsServer.close();
  console.log(`[withdrawOtp] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
