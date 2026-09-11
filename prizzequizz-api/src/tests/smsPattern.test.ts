/* READING A BANK'S OWN WORDS.
 *
 * The operator adds banks from the panel, so text they type becomes the thing
 * that decides whether money arrived. Four properties have to hold, and each
 * one is a way this hands out free tickets if it does not:
 *
 *   - THE REAL MESSAGES PARSE. All three, exactly as the bank sent them —
 *     Arabic ي, a bare «+», a line break through the middle of a value, and
 *     invisible direction marks around account numbers.
 *   - A WITHDRAWAL IS NOT A DEPOSIT. At Refah the only difference is one
 *     character, and that character must survive compilation as itself.
 *   - A TEMPLATE CANNOT HANG THE SERVER. Every quantifier is bounded, so
 *     linear time is structural rather than likely.
 *   - A CREDENTIAL IS NEVER STORED. Not redacted — dropped, before a row
 *     exists, on the server as well as in the forwarder.
 *
 * Run: npx tsx src/tests/smsPattern.test.ts
 */
import assert from 'node:assert/strict';
import {
  compileTemplate, matchTemplate, normalizeSms, toRial, TemplateError, MAX_SMS_LENGTH
} from '../services/c2c/templateCompiler.js';
import { inspectSensitive } from '../services/c2c/smsSensitive.js';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* The operator's real messages, character for character. */
const SEPAH_DEPOSIT = 'بانک سپه\nواريز:250,000ريال\nحساب:49302749612\nمانده:59,719,997\n2/23-20:43';
const SEPAH_WITHDRAWAL = 'بانک سپه\nبرداشت:6,009,000\nحساب :‪49302749612‬\nمانده:61,528,853';
const REFAH_DEPOSIT = 'بانک رفاه\nحساب292555271\nکارت625,893+\nمانده14,591,760\n06/19-22:07';
const TEJARAT_DEPOSIT = 'بانک تجارت حساب: 0151039084019 واریز: 12,000,000 ریال از طريق: شتاب\nمانده:\n89,579,894 ریال 1405/06/19 13:30';

const SEPAH_TPL = 'بانک سپه\nواريز:{amount}[ريال]\nحساب:{account}\nمانده:{balance}\n{datetime}';
const REFAH_TPL = 'بانک رفاه\nحساب{account}\nکارت{amount}+\nمانده{balance}\n{datetime}';
const TEJARAT_TPL = 'بانک تجارت حساب: {account} واریز: {amount} [ریال]\nاز طريق: {*}\nمانده: {balance} [ریال] {datetime}';

check('Sepah’s real deposit is read, figure and account and all', () => {
  const m = matchTemplate(compileTemplate(SEPAH_TPL), SEPAH_DEPOSIT);
  assert.ok(m, 'the template did not match the message it was written from');
  assert.equal(m!.values.amount, '250,000');
  assert.equal(m!.values.account, '49302749612');
  assert.equal(toRial(m!.amountRaw, 'rial'), 250_000);
});

check('and its real WITHDRAWAL is not', () => {
  /* The one test that stops free tickets: «برداشت» where the template says
   * «واريز». The sample also carries U+202A/U+202C around the account and a
   * space before the colon that the deposit does not have. */
  assert.equal(matchTemplate(compileTemplate(SEPAH_TPL), SEPAH_WITHDRAWAL), null);
});

check('a deposit that omits the unit still parses', () => {
  /* The real withdrawal proves Sepah does not always print «ريال», so the
   * unit is optional in the template rather than required. */
  const m = matchTemplate(compileTemplate(SEPAH_TPL), SEPAH_DEPOSIT.replace('ريال', ''));
  assert.ok(m);
  assert.equal(m!.values.amount, '250,000');
});

check('Refah’s «+» is the deposit marker, and it survives compilation', () => {
  const c = compileTemplate(REFAH_TPL);
  assert.ok(matchTemplate(c, REFAH_DEPOSIT), 'the deposit did not match');
  /* Unescaped, «+» would be a quantifier and this would match too — which is
   * a withdrawal delivering goods. */
  assert.equal(matchTemplate(c, REFAH_DEPOSIT.replace('+', '-')), null, 'a withdrawal matched the deposit template');
});

check('Tejarat’s message parses even though it breaks mid-value', () => {
  const m = matchTemplate(compileTemplate(TEJARAT_TPL), TEJARAT_DEPOSIT);
  assert.ok(m, 'every boundary must be «space, newline, or nothing»');
  assert.equal(m!.values.amount, '12,000,000');
  assert.equal(m!.values.account, '0151039084019', 'the leading zero is part of the account, not a number to trim');
});

check('invisible direction marks cannot break a match', () => {
  /* The bank wraps account numbers in U+202A/U+202C. They show up nowhere, so
   * a comparison that fails because of them fails for no visible reason. */
  const withMarks = SEPAH_DEPOSIT.replace('49302749612', '‪49302749612‬');
  const m = matchTemplate(compileTemplate(SEPAH_TPL), withMarks);
  assert.ok(m);
  assert.equal(m!.values.account, '49302749612');
});

check('Persian digits and the Arabic ي are the same as their plain forms', () => {
  assert.equal(normalizeSms('۱۲۳٬۴۵۶'), '123,456');
  assert.equal(normalizeSms('واريز'), normalizeSms('واریز'), 'ي and ی are the same word');
  assert.equal(normalizeSms('كارت'), normalizeSms('کارت'));
  /* A message written entirely in Persian digits must still parse. */
  const faDeposit = SEPAH_DEPOSIT.replace('250,000', '۲۵۰٬۰۰۰');
  const m = matchTemplate(compileTemplate(SEPAH_TPL), faDeposit);
  assert.equal(toRial(m!.amountRaw, 'rial'), 250_000);
});

check('the unit comes from the pattern, never from the message', () => {
  /* Refah prints no unit at all. A parser that read one out of the text would
   * be guessing, and the guess is a factor of ten. */
  assert.equal(toRial('12,000', 'rial'), 12_000);
  assert.equal(toRial('12,000', 'toman'), 120_000);
});

check('a template with no {amount} is refused', () => {
  assert.throws(() => compileTemplate('بانک سپه\nحساب:{account}'),
    (e: any) => e instanceof TemplateError && e.code === 'TEMPLATE_NO_AMOUNT');
});

check('so is an unknown field, a duplicate one, and an unclosed brace', () => {
  assert.throws(() => compileTemplate('{amount} {iban}'), (e: any) => e.code === 'TEMPLATE_UNKNOWN_FIELD');
  assert.throws(() => compileTemplate('{amount} {amount}'), (e: any) => e.code === 'TEMPLATE_DUPLICATE_FIELD');
  assert.throws(() => compileTemplate('{amount'), (e: any) => e.code === 'TEMPLATE_UNCLOSED');
});

check('a template cannot smuggle a regex through', () => {
  /* Literals are escaped, so «.*» is two characters the bank has to actually
   * send — not a wildcard that swallows the message and reads any amount. */
  const c = compileTemplate('واریز:{amount}.*هرچه');
  assert.equal(matchTemplate(c, 'واریز:1,000 و بعد هر متنی که بخواهی هرچه'), null,
    'the «.*» was treated as a wildcard');
  assert.ok(matchTemplate(c, 'واریز:1,000.*هرچه'), 'and as literal text it still matches');
});

check('adjacent placeholders cannot multiply into a hang', () => {
  /* Bounded classes cannot take exponential time — but side by side they still
   * MULTIPLY: three `{*}` capped at 64 is a quarter of a million ways to split
   * the same text, which measured at 300ms per message before the placeholders
   * were made atomic. Fifty of those in one forwarder batch is a denial of
   * service. Atomic, the same case is ~0.01ms, so this threshold is three
   * orders of magnitude of headroom and still catches that regression. */
  for (const tpl of ['واریز:{amount}{*}{*}{*}پایان', '{*}{amount}{*}{account}{*}{balance}{*}پایان']) {
    const c = compileTemplate(tpl);
    const hostile = 'واریز:' + '1'.repeat(200) + 'x'.repeat(200);
    const t0 = Date.now();
    matchTemplate(c, hostile);
    const ms = Date.now() - t0;
    assert.ok(ms < 25, `${tpl} took ${ms}ms — a placeholder is backtracking again`);
  }
});

check('an over-long message is cut before matching, not after', () => {
  const c = compileTemplate('واریز:{amount}پایان');
  const padded = 'x'.repeat(MAX_SMS_LENGTH) + 'واریز:1,000پایان';
  assert.equal(matchTemplate(c, padded), null, 'the cap is not applied to the input');
});

/* ── credentials ──────────────────────────────────────────────────────── */

check('a one-time password is recognised in every form it arrives in', () => {
  const samples = [
    'رمز پویا: 483920',
    'رمز دوم کارت شما: 88213',
    'کد تایید شما 55321 است',
    'Your OTP is 118822',
    'CVV2: 419',
    'your one-time code is 4821',
    'verification code 99210'
  ];
  for (const s of samples) {
    assert.equal(inspectSensitive(normalizeSms(s)).sensitive, true, 'not caught: ' + s);
  }
});

check('and the bank’s own deposit notifications are not', () => {
  for (const s of [SEPAH_DEPOSIT, REFAH_DEPOSIT, TEJARAT_DEPOSIT, SEPAH_WITHDRAWAL]) {
    assert.equal(inspectSensitive(normalizeSms(s)).sensitive, false,
      'a real bank message was treated as a credential: ' + s.slice(0, 30));
  }
});

check('the filter runs on normalised text, so Arabic spellings do not slip past', () => {
  /* «رمز پويا» with the Arabic ي is the same words and must be caught. A
   * filter that only knows one spelling is not a filter. */
  assert.equal(inspectSensitive(normalizeSms('رمز پويا: ۴۸۳۹۲۰')).sensitive, true);
  assert.equal(inspectSensitive(normalizeSms('كد تاييد شما ۵۵۳۲۱')).sensitive, true);
});

console.log(`[smsPattern] ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
