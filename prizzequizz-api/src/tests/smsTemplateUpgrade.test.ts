/* THE PAYOUT THAT COULD NOT ASK FOR A CODE.
 *
 * «بازم در موقع درخواست برداشت جایزه بازم پیامک کد نمیاد و مینویسه ارسال پیامک
 * ناموفق بود دوباره تلاش کن و درخواست برداشت ثبت نمیشه.»
 *
 * The lock-out was fixed; the send itself still failed, every time, for one
 * reason: the built-in message templates were written into `sms_templates` only
 * when that table was COMPLETELY EMPTY. A server that had been running since
 * before `withdraw_code` existed had rows — so the new key was never inserted,
 * `sendTemplate` threw TEMPLATE_NOT_FOUND before touching the provider, and the
 * player was told the SMS had failed. The login code kept working the whole
 * time, because its row was there from day one, which is what made this look
 * like a withdrawal bug rather than a template one.
 *
 * This test starts from that exact database and asks for a withdrawal code.
 *
 * Run: DATABASE_URL=postgres://… npx tsx src/tests/smsTemplateUpgrade.test.ts
 */
import assert from 'node:assert/strict';

if (!process.env.DATABASE_URL) {
  console.log('smsTemplateUpgrade: needs DATABASE_URL (a throwaway database) — skipped');
  process.exit(0);
}

let pass = 0, fail = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e: any) { fail++; console.log('  FAIL ' + name + '\n       ' + (e?.message || e)); }
}

const { getPgPool } = await import('../database/postgres.js');
const pool = getPgPool();

/* The store as it stands on a server that started before the withdrawal code
   template was written — some rows, but not that one. */
await pool.query('DROP TABLE IF EXISTS sms_templates');
await pool.query(`CREATE TABLE sms_templates (
  key TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
/* The wording is deliberately NOT the built-in one: an operator who has edited
   their messages is the whole reason this table has rows, and a re-seed that
   quietly restored the defaults would be a second bug wearing the first one's
   clothes. Text identical to the default would prove nothing here. */
await pool.query(`INSERT INTO sms_templates(key,title,text) VALUES
  ('login_code','ورود','کد ورود اپراتوری: {code} — پرایزکوییز'),
  ('signup_code','ثبت‌نام','ثبت‌نام اپراتوری: {code}')`);

const sms = await import('../services/smsService.js');
const otp = await import('../services/withdrawOtpService.js');

console.log('a server that has been running since before the template existed:');

await check('the withdrawal template is put back', async () => {
  const keys = (await sms.listTemplates()).map((t) => t.key);
  assert.ok(keys.includes('withdraw_code'), 'still missing: ' + keys.join(','));
});

await check('and so is every other message the game sends', async () => {
  const keys = new Set((await sms.listTemplates()).map((t) => t.key));
  const missing = sms.SMS_DEFAULT_TEMPLATES.filter((t) => !keys.has(t.key)).map((t) => t.key);
  assert.deepEqual(missing, [], 'missing: ' + missing.join(','));
});

await check('the wording the operator already had is not touched', async () => {
  await sms.listTemplates();                     // the re-seed runs on every listing
  const { rows } = await pool.query(`SELECT title, text FROM sms_templates WHERE key='login_code'`);
  assert.equal(rows[0].text, 'کد ورود اپراتوری: {code} — پرایزکوییز', 'the stored wording was replaced by the default');
  assert.equal(rows[0].title, 'ورود', 'the stored title was replaced by the default');
});

await check('and a message really goes out with the operator’s wording, not the built-in one', async () => {
  await sms.updateSmsConfig({ enabled: true, sandbox: true, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
  const log = await sms.sendTemplate('09121230009', 'login_code', { code: '7788' });
  assert.equal(log.body, 'کد ورود اپراتوری: 7788 — پرایزکوییز', log.body);
});

/* THE THING THE PLAYER WAS ACTUALLY TRYING TO DO. */
console.log('\nasking for a withdrawal code on that same server:');
await check('a code is sent instead of «ارسال پیامک ناموفق بود»', async () => {
  otp._resetOtp();
  await sms.updateSmsConfig({ enabled: true, sandbox: true, provider: 'niazpardaz', apiKey: 'K', sender: '1000' });
  const r = await otp.sendWithdrawOtp('u-withdraw-1', '09121230000');
  assert.equal(r.sent, true, 'the send did not happen');
});

await check('and the message is in the panel log, on that template', async () => {
  const rows = await sms.listLog({ recipient: '09121230000', limit: 5 });
  assert.ok(rows.length >= 1, 'nothing was even attempted');
  assert.equal(rows[0]!.templateKey, 'withdraw_code');
  assert.equal(rows[0]!.status, 'sent', 'status ' + rows[0]!.status + ' / ' + rows[0]!.error);
  assert.match(rows[0]!.body, /کد تأیید دریافت جایزه/, rows[0]!.body);
});

/* An operator editing the withdrawal wording must keep it — the re-seed runs on
   every listing, so this is the assertion that stops it becoming a reset. */
await check('an edited withdrawal message survives the next send', async () => {
  await sms.saveTemplate({ key: 'withdraw_code', title: 'کد برداشت', text: 'کد برداشت شما {code} است' });
  otp._resetOtp();
  await otp.sendWithdrawOtp('u-withdraw-2', '09121230001');
  const rows = await sms.listLog({ recipient: '09121230001', limit: 5 });
  assert.match(rows[0]!.body, /^کد برداشت شما \d+ است$/, rows[0]!.body);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await pool.end?.();
process.exit(fail ? 1 : 0);
