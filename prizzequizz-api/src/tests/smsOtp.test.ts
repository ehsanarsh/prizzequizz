/* SMS + login OTP.
 *
 * The point of these is the seam that was missing entirely: the OTP used to be
 * minted and thrown away, so none of the SMS panel's settings had any effect on
 * logging in. Every assertion below is about that seam — which mode the panel
 * is in, what code that produces, whether a message is actually handed to the
 * provider, and what the player is told when the provider says no. */
import assert from 'node:assert/strict';
import {
  SMS_DEFAULT_CONFIG, getSmsConfig, updateSmsConfig, smsIsLive, listLog, listTemplates,
  renderTemplate, sendSms, sendOtp, otpAllowed, maskConfig, NIAZPARDAZ_BASE, niazpardazAccount
} from '../services/smsService.js';
import { MemoryOtpProvider, OtpError } from '../services/otpProvider.js';

let passed = 0, failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch((e) => { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); });
}

/* The provider is reached with fetch(), so a stub is enough to see exactly what
   would go over the wire — no network, no spent credit. */
type Call = { url: string; headers: Record<string, string>; body: any };
const realFetch = globalThis.fetch;
function stubFetch(reply: (call: Call) => { status?: number; json: any }): Call[] {
  const calls: Call[] = [];
  (globalThis as any).fetch = async (url: any, init: any) => {
    const call: Call = { url: String(url), headers: (init?.headers ?? {}) as any, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = reply(call);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.json), json: async () => r.json } as any;
  };
  return calls;
}
function restoreFetch() { (globalThis as any).fetch = realFetch; }

async function reset() {
  await updateSmsConfig({ ...SMS_DEFAULT_CONFIG, otp: { ...SMS_DEFAULT_CONFIG.otp } });
}

async function run() {
  // ---- mode detection ----------------------------------------------------
  await check('a fresh install is not live', async () => {
    await reset();
    assert.equal(smsIsLive(await getSmsConfig()), false);
  });
  await check('enabled alone is not live while sandbox is on', async () => {
    await updateSmsConfig({ enabled: true, sandbox: true, provider: 'niazpardaz' });
    assert.equal(smsIsLive(await getSmsConfig()), false);
  });
  await check('enabled + sandbox off + a real provider is live', async () => {
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz' });
    assert.equal(smsIsLive(await getSmsConfig()), true);
  });
  await check('enabled + sandbox off but provider still sandbox is NOT live', async () => {
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'sandbox' });
    assert.equal(smsIsLive(await getSmsConfig()), false);
  });

  // ---- test mode ---------------------------------------------------------
  await check('test mode issues the configured code and sends nothing', async () => {
    await reset();
    await updateSmsConfig({ otp: { ...SMS_DEFAULT_CONFIG.otp, testCode: '7788' } });
    const calls = stubFetch(() => ({ json: {} }));
    const p = new MemoryOtpProvider();
    const r = await p.createOtp('09120000001');
    assert.equal(r.testMode, true);
    assert.equal(r.delivered, false);
    assert.equal(calls.length, 0, 'no provider call may be made in test mode');
    assert.ok(await p.verifyOtp(r.requestId, '7788'), 'the configured test code must verify');
    restoreFetch();
  });
  await check('test mode falls back to 1234 when the field is emptied', async () => {
    await reset();
    await updateSmsConfig({ otp: { ...SMS_DEFAULT_CONFIG.otp, testCode: '' } });
    const p = new MemoryOtpProvider();
    const r = await p.createOtp('09120000002');
    assert.ok(await p.verifyOtp(r.requestId, '1234'));
  });
  await check('ttl comes from the panel, not from a constant', async () => {
    await reset();
    await updateSmsConfig({ otp: { ...SMS_DEFAULT_CONFIG.otp, expirySeconds: 300 } });
    const r = await new MemoryOtpProvider().createOtp('09120000003');
    assert.equal(r.ttlSeconds, 300);
  });

  // ---- live mode, niazpardaz --------------------------------------------
  await check('live mode posts SendBatchSms with the key, sender and code', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'KEY-123', sender: '10001234' });
    const calls = stubFetch(() => ({ json: { success: true, result: { resultCode: 0, batchSmsId: 909 } } }));
    const p = new MemoryOtpProvider();
    const r = await p.createOtp('09120000004');
    restoreFetch();
    assert.equal(r.testMode, false);
    assert.equal(r.delivered, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, NIAZPARDAZ_BASE + '/SendBatchSms');
    assert.equal((calls[0]!.headers as any)['X-API-Key'], 'KEY-123');
    assert.equal(calls[0]!.body.fromNumber, '10001234');
    assert.equal(calls[0]!.body.toNumbers, '09120000004');
    const sent = String(calls[0]!.body.messageContent);
    const code = (sent.match(/\d{4}/) || [])[0];
    assert.ok(code, 'the message must carry a four digit code');
    assert.ok(!/1234/.test(code!) || code !== '1234', 'a live code must not be the test code');
    assert.ok(await p.verifyOtp(r.requestId, code!), 'the code in the SMS is the one that verifies');
  });
  await check('the batch id is kept as the provider reference', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 0, batchSmsId: 5551212 } } }));
    const log = await sendSms('09120000005', 'سلام');
    restoreFetch();
    assert.equal(log.status, 'sent');
    assert.equal(log.providerRef, '5551212');
  });
  await check('a provider result code becomes a Persian reason, and login fails', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 8 } } }));   // NoCredit
    let err: any = null;
    try { await new MemoryOtpProvider().createOtp('09120000006'); } catch (e) { err = e; }
    restoreFetch();
    assert.ok(err instanceof OtpError, 'a refused send must not look like a successful login');
    assert.equal(err.code, 'OTP_SEND_FAILED');
    assert.match(err.message, /اعتبار/);
  });
  await check('an unknown result code still says something useful', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 99 } } }));
    const log = await sendSms('09120000007', 'x');
    restoreFetch();
    assert.equal(log.status, 'failed');
    assert.match(String(log.error), /99/);
  });
  await check('a missing sender is caught before the network', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '' });
    const calls = stubFetch(() => ({ json: {} }));
    const log = await sendSms('09120000008', 'x');
    restoreFetch();
    assert.equal(log.status, 'failed');
    assert.equal(calls.length, 0);
    assert.match(String(log.error), /فرستنده/);
  });
  await check('a missing api key is caught before the network', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: '', sender: '1000' });
    const calls = stubFetch(() => ({ json: {} }));
    const log = await sendSms('09120000009', 'x');
    restoreFetch();
    assert.equal(log.status, 'failed');
    assert.equal(calls.length, 0);
  });
  await check('an HTTP error from the panel is reported, not swallowed', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
    stubFetch(() => ({ status: 500, json: {} }));
    const log = await sendSms('09120000010', 'x');
    restoreFetch();
    assert.equal(log.status, 'failed');
    assert.match(String(log.error), /500/);
  });

  // ---- rate limiting -----------------------------------------------------
  await check('the hourly cap refuses a further code', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000',
      otp: { maxPerHour: 2, expirySeconds: 120, minIntervalSeconds: 0, testCode: '1234' } });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 0, batchSmsId: 1 } } }));
    const p = new MemoryOtpProvider();
    await p.createOtp('09121110000');
    await p.createOtp('09121110000');
    let err: any = null;
    try { await p.createOtp('09121110000'); } catch (e) { err = e; }
    restoreFetch();
    assert.ok(err instanceof OtpError);
    assert.equal(err.code, 'OTP_RATE_LIMIT');
    assert.equal(err.status, 429);
  });
  await check('the minimum interval refuses a rapid resend', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000',
      otp: { maxPerHour: 10, expirySeconds: 120, minIntervalSeconds: 90, testCode: '1234' } });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 0, batchSmsId: 1 } } }));
    const p = new MemoryOtpProvider();
    await p.createOtp('09121110001');
    let err: any = null;
    try { await p.createOtp('09121110001'); } catch (e) { err = e; }
    restoreFetch();
    assert.equal(err?.code, 'OTP_TOO_SOON');
  });
  await check('the resend delay handed to the client is the configured one', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000',
      otp: { maxPerHour: 10, expirySeconds: 180, minIntervalSeconds: 75, testCode: '1234' } });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 0, batchSmsId: 1 } } }));
    const r = await new MemoryOtpProvider().createOtp('09121110002');
    restoreFetch();
    assert.equal(r.resendAfterSeconds, 75);
    assert.equal(r.ttlSeconds, 180);
  });
  await check('rate limiting does not apply in test mode', async () => {
    await reset();
    await updateSmsConfig({ otp: { maxPerHour: 1, expirySeconds: 120, minIntervalSeconds: 600, testCode: '1234' } });
    const p = new MemoryOtpProvider();
    await p.createOtp('09121110003');
    const r = await p.createOtp('09121110003');   // must not throw
    assert.equal(r.testMode, true);
  });

  // ---- verification ------------------------------------------------------
  await check('a wrong code does not verify, and five tries burn the request', async () => {
    await reset();
    const p = new MemoryOtpProvider();
    const r = await p.createOtp('09121110004');
    for (let i = 0; i < 5; i++) assert.equal(await p.verifyOtp(r.requestId, '0000'), null);
    assert.equal(await p.verifyOtp(r.requestId, '1234'), null, 'the request must be spent after five wrong tries');
  });
  await check('an expired code does not verify', async () => {
    await reset();
    await updateSmsConfig({ otp: { ...SMS_DEFAULT_CONFIG.otp, expirySeconds: 30 } });
    const p = new MemoryOtpProvider();
    const r = await p.createOtp('09121110005');
    (p as any).records.get(r.requestId).expiresAt = Date.now() - 1;
    assert.equal(await p.verifyOtp(r.requestId, '1234'), null);
  });
  await check('a code is single use', async () => {
    await reset();
    const p = new MemoryOtpProvider();
    const r = await p.createOtp('09121110006');
    assert.ok(await p.verifyOtp(r.requestId, '1234'));
    assert.equal(await p.verifyOtp(r.requestId, '1234'), null);
  });
  await check('two requests do not share a code slot', async () => {
    await reset();
    const p = new MemoryOtpProvider();
    const a = await p.createOtp('09121110007');
    const b = await p.createOtp('09121110008');
    assert.notEqual(a.requestId, b.requestId);
    assert.ok(await p.verifyOtp(a.requestId, '1234'));
    assert.ok(await p.verifyOtp(b.requestId, '1234'));
  });

  // ---- log + templates ---------------------------------------------------
  await check('the login template carries the code', async () => {
    const tpls = await listTemplates();
    const t = tpls.find((x) => x.key === 'login_code');
    assert.ok(t, 'login_code template must exist');
    assert.match(renderTemplate(t!.text, { code: '4321' }), /4321/);
  });
  await check('every live send is written to the log', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 0, batchSmsId: 42 } } }));
    await sendOtp('09121119999', '4242', 'login', 'login_code');
    restoreFetch();
    const rows = await listLog({ recipient: '09121119999', limit: 10 });
    assert.ok(rows.length >= 1);
    assert.equal(rows[0]!.templateKey, 'login_code');
    assert.match(rows[0]!.body, /4242/);
  });
  await check('the api key is never returned to the panel in full', async () => {
    await reset();
    await updateSmsConfig({ apiKey: 'SUPERSECRETKEY9999' });
    const masked = maskConfig(await getSmsConfig());
    assert.equal(masked.apiKeySet, true);
    assert.ok(!masked.apiKey.includes('SUPERSECRET'));
  });
  await check('sandbox logs the message without calling the provider', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: true, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
    const calls = stubFetch(() => ({ json: {} }));
    const log = await sendSms('09121110011', 'متن آزمایشی');
    restoreFetch();
    assert.equal(log.status, 'sent');
    assert.equal(calls.length, 0);
    assert.match(String(log.providerRef), /^sandbox-/);
  });
  await check('a disabled panel refuses to send at all', async () => {
    await reset();
    const log = await sendSms('09121110012', 'x');
    assert.equal(log.status, 'disabled');
  });

  // ---- account check -----------------------------------------------------
  await check('the account check reads credit and sender lines', async () => {
    await reset();
    await updateSmsConfig({ provider: 'niazpardaz', apiKey: 'K' });
    stubFetch((c) => c.url.endsWith('/GetCredit')
      ? { json: { success: true, result: { resultCode: 0, credit: 125000 } } }
      : { json: { success: true, result: { resultCode: 0, senders: ['10001234', '3000123'] } } });
    const acc = await niazpardazAccount();
    restoreFetch();
    assert.equal(acc.credit, 125000);
    assert.deepEqual(acc.senders, ['10001234', '3000123']);
    assert.equal(acc.error, undefined);
  });
  await check('a bad key is reported as such, not as zero credit', async () => {
    await reset();
    await updateSmsConfig({ provider: 'niazpardaz', apiKey: 'WRONG' });
    stubFetch(() => ({ json: { success: true, result: { resultCode: -7 } } }));
    const acc = await niazpardazAccount();
    restoreFetch();
    assert.equal(acc.credit, null);
    assert.match(String(acc.error), /API/);
  });
  await check('a failed send does not burn the hourly quota', async () => {
    await reset();
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'niazpardaz', apiKey: 'K', sender: '1000',
      otp: { maxPerHour: 2, expirySeconds: 120, minIntervalSeconds: 0, testCode: '1234' } });
    stubFetch(() => ({ json: { success: true, result: { resultCode: 8 } } }));   // no credit
    const p = new MemoryOtpProvider();
    for (let i = 0; i < 4; i++) { try { await p.createOtp('09121115555'); } catch { /* expected */ } }
    // Now the account is topped up: the player must not be locked out over
    // messages that were never delivered.
    restoreFetch();
    stubFetch(() => ({ json: { success: true, result: { resultCode: 0, batchSmsId: 7 } } }));
    const r = await p.createOtp('09121115555');
    restoreFetch();
    assert.equal(r.delivered, true);
  });
  await check('otpAllowed agrees with the configured cap', async () => {
    await reset();
    await updateSmsConfig({ otp: { maxPerHour: 5, expirySeconds: 120, minIntervalSeconds: 0, testCode: '1234' } });
    const gate = await otpAllowed('09121110013');
    assert.equal(gate.allowed, true);
  });

  await reset();
  console.log(`[smsOtp] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
