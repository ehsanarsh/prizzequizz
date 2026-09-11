/* THE APP AND THE SERVER MUST AGREE.
 *
 * Two pieces of the forwarder are written twice — once in Kotlin on the phone
 * and once in TypeScript here — and both copies are load-bearing:
 *
 *   THE CREDENTIAL FILTER. The app's copy stops a رمز پویا leaving the
 *   operator's daily phone; the server's copy exists because the app's might
 *   not have run (a stolen phone, an old build, something else speaking the
 *   same protocol). If they drift apart, the weaker one decides — and the
 *   failure is silent: a credential in a payments database, noticed by nobody.
 *
 *   THE REQUEST SIGNATURE. Get it wrong and every request the app makes is
 *   rejected on contact. There is no Android SDK in this environment, so the
 *   app cannot be compiled here — which makes it MORE important to check what
 *   can be checked from the Kotlin source itself.
 *
 * This reads the actual Kotlin files. It is not a copy of them: a test that
 * restated the patterns would agree with itself forever.
 *
 * Run: npx tsx src/tests/forwarderParity.test.ts
 */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { inspectSensitive, SENSITIVE_PATTERNS } from '../services/c2c/smsSensitive.js';
import { normalizeSms } from '../services/c2c/templateCompiler.js';
import { signPayload } from '../services/c2c/deviceAuth.js';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const APP = '/home/user/prizzequizz/prizzequizz-sms-forwarder/app/src/main/java/ir/prizequiz/forwarder';
const filterKt = existsSync(`${APP}/SensitiveFilter.kt`) ? readFileSync(`${APP}/SensitiveFilter.kt`, 'utf8') : '';
const apiKt = existsSync(`${APP}/ApiClient.kt`) ? readFileSync(`${APP}/ApiClient.kt`, 'utf8') : '';

/**
 * The app's credential patterns — and ONLY those.
 *
 * Scoped to the PATTERNS list rather than every `Regex(` in the file: the
 * normaliser has its own, and counting those made an earlier version of this
 * check pass for the wrong reason.
 */
function appPatterns(): RegExp[] {
  const block = /private val PATTERNS = listOf\(([\s\S]*?)\n {4}\)/.exec(filterKt);
  assert.ok(block, 'could not find the PATTERNS list in SensitiveFilter.kt');
  return [...block![1]!.matchAll(/Regex\("((?:[^"\\]|\\.)*)"(\s*,\s*RegexOption\.IGNORE_CASE)?\)/g)]
    .map((m) => new RegExp(m[1]!.replace(/\\\\/g, '\\'), m[2] ? 'i' : ''));
}

/* Real bank messages the operator sent, and the credentials they sit beside
 * in the same inbox. */
const CREDENTIALS = [
  'رمز پویا: 483920', 'رمز دوم کارت شما: 88213', 'کد تایید شما 55321 است',
  'Your OTP is 118822', 'CVV2: 419', 'your one-time code is 4821',
  'verification code 99210', 'رمز پويا: ۴۸۳۹۲۰', 'كد تاييد شما ۵۵۳۲۱',
  'رمز يکبار مصرف: 7781', 'PIN: 4421'
];
const BANK_MESSAGES = [
  'بانک سپه\nواريز:250,000ريال\nحساب:49302749612\nمانده:59,719,997\n2/23-20:43',
  'بانک رفاه\nحساب292555271\nکارت625,893+\nمانده14,591,760\n06/19-22:07',
  'بانک تجارت حساب: 0151039084019 واریز: 12,000,000 ریال از طريق: شتاب\nمانده:\n89,579,894 ریال 1405/06/19 13:30',
  'بانک سپه\nبرداشت:6,009,000\nحساب :‪49302749612‬\nمانده:61,528,853'
];

check('the app ships the same number of credential patterns as the server', () => {
  assert.equal(appPatterns().length, SENSITIVE_PATTERNS.length,
    `app has ${appPatterns().length}, server has ${SENSITIVE_PATTERNS.length} — one of them was changed alone`);
});

check('and the two agree on every credential', () => {
  const app = appPatterns();
  for (const s of CREDENTIALS) {
    const norm = normalizeSms(s);
    assert.equal(inspectSensitive(norm).sensitive, true, 'the server let one through: ' + s);
    assert.ok(app.some((r) => r.test(norm)), 'the APP would forward a credential: ' + s);
  }
});

check('and on every real bank message, which neither may drop', () => {
  const app = appPatterns();
  for (const s of BANK_MESSAGES) {
    const norm = normalizeSms(s);
    assert.equal(inspectSensitive(norm).sensitive, false, 'the server dropped a deposit: ' + s.slice(0, 30));
    assert.equal(app.some((r) => r.test(norm)), false, 'the APP would drop a deposit: ' + s.slice(0, 30));
  }
});

check('the app normalises the same way, or the filters see different text', () => {
  /* «رمز پويا» with the Arabic ي must reach both filters as «رمز پویا». If
   * the app's normaliser missed that, its filter would never fire on it —
   * and the whole point of the app's copy is that it fires FIRST. */
  for (const pair of [['واريز', 'واریز'], ['كارت', 'کارت'], ['۱۲۳٬۴۵۶', '123,456']]) {
    assert.equal(normalizeSms(pair[0]!), normalizeSms(pair[1]!),
      'the server does not fold ' + pair[0]);
  }
  for (const bit of ['[يى]', '"ك"', "'۰'..'۹'", "'٠'..'٩'"]) {
    assert.ok(filterKt.includes(bit), `the app's normaliser is missing ${bit}`);
  }
  assert.ok(/replace\(Regex\("\[[\s\S]{0,40}\]"\), ""\)/.test(filterKt),
    "the app does not strip the invisible direction marks the bank inserts");
});

check('the app signs exactly what the server verifies', () => {
  /* Verified against a real JVM separately; this pins the FORMULA as written
   * in the Kotlin, so a later edit to the app cannot quietly change it. */
  assert.ok(apiKt.includes('"$deviceId\\n$timestamp\\n$nonce\\n$bodyHash"'),
    'the app no longer signs deviceId, timestamp, nonce and the body hash, in that order');
  assert.ok(apiKt.includes('HmacSHA256') && apiKt.includes('SHA-256'),
    'the app changed algorithm');
  assert.ok(apiKt.includes('Charsets.UTF_8'), 'the app is not signing UTF-8 bytes');

  /* And the server's own implementation still matches that description. */
  const secret = 's3cr3t', deviceId = 'dev-1', ts = '1789200000000', nonce = 'n-1';
  const body = '{"messages":[]}';
  const expected = createHmac('sha256', secret)
    .update(`${deviceId}\n${ts}\n${nonce}\n${createHash('sha256').update(body, 'utf8').digest('hex')}`)
    .digest('hex');
  assert.equal(signPayload(secret, deviceId, ts, nonce, body), expected);
});

check('the app sends the body it signed, not a rebuilt one', () => {
  /* Re-serialising the JSON anywhere between signing and sending changes the
   * hash, and every honest request fails. The Kotlin builds the string once
   * and uses that same variable for both. */
  assert.ok(/val body = JSONObject\(\)[\s\S]{0,400}\.toString\(\)/.test(apiKt),
    'the request body is not built as one string');
  assert.ok(apiKt.includes('sign(secret, deviceId, timestamp, nonce, body)'),
    'the signature is computed over something other than the body being sent');
  assert.ok(apiKt.includes('it.write(body.toByteArray(Charsets.UTF_8))'),
    'the bytes written are not the bytes signed');
});

check('the app only forwards what a bank sent', () => {
  const senders = existsSync(`${APP}/BankSenders.kt`) ? readFileSync(`${APP}/BankSenders.kt`, 'utf8') : '';
  assert.ok(senders.includes('sepah') && senders.includes('refah') && senders.includes('tejarat'),
    "the operator's own three banks are not in the allowlist");
  const receiver = readFileSync(`${APP}/SmsReceiver.kt`, 'utf8');
  assert.ok(receiver.includes('if (!BankSenders.isBank(sender)) continue'),
    'the receiver does not filter by sender — a daily phone would forward private messages');
  assert.ok(receiver.includes('if (SensitiveFilter.isSensitive(body))'),
    'the receiver does not filter credentials before queueing');
  /* Order matters: a credential must be dropped BEFORE it is written down. */
  assert.ok(receiver.indexOf('SensitiveFilter.isSensitive') < receiver.indexOf('queue.add'),
    'a credential would be queued to disk before being checked');
});

check('a queued message is only forgotten once the SERVER has it', () => {
  const worker = readFileSync(`${APP}/ForwardWorker.kt`, 'utf8');
  assert.ok(worker.includes('val accepted = results.filterValues { it }.keys'),
    'the app does not read the per-message answer');
  assert.ok(worker.includes('queue.remove(accepted)'),
    'the app drops messages the server did not confirm — that loses deposits');
});

console.log(`[forwarderParity] ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
