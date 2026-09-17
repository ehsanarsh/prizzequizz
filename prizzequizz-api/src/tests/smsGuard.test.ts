/* NOTHING HALF-FILLED LEAVES THIS MACHINE.
 *
 * نیازپرداز, on why the server was blocked after twenty messages:
 *
 *   «یکی از دلایلی که آی‌پی بلاک شده بود NotValidTemplateFound بوده است. برخی
 *    از ریکوئست‌ها نیز بدون پسورد سمت شرکت ارسال شده‌اند… در صورت ارسال ریکوئست
 *    اشتباه، آی‌پی مسدود می‌گردد.»
 *
 * So it was never a rate limit — it was MALFORMED requests. The panel would
 * hold a provider with an empty password and `dispatch` sent it anyway: once
 * per recipient, five hundred times, each one another reason for the provider
 * to stop accepting anything from this address. «به ۲۰ تاش میفرسته، بعد بلاک
 * میشه، به ۷۰ تای دیگه نمیفرسته.»
 *
 * Two rules come out of that, and both are here:
 *   1. a request that cannot possibly be accepted is never sent;
 *   2. a run that has clearly hit a settings problem STOPS, rather than
 *      repeating the same bad request until the account is banned.
 *
 * Run: npx tsx src/tests/smsGuard.test.ts
 */
import assert from 'node:assert/strict';
import { missingFor, niazpardazBase, effectiveBase, NIAZPARDAZ_BASE, SMS_DEFAULT_CONFIG, type SmsConfig } from '../services/smsService.js';

let pass = 0, fail = 0;
/* AWAITED, because one of these is async.
   The first version of this was `fn()` with no await: an async body's rejection
   never reached the catch, `pass++` ran on the spot, and the assertion inside
   could not fail the run. A test that cannot fail is not a test. */
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}
const cfg = (o: Partial<SmsConfig>): SmsConfig => ({ ...SMS_DEFAULT_CONFIG, enabled: true, sandbox: false, ...o });

await check('a provider with everything it needs is not complained about', () => {
  assert.deepEqual(missingFor(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000x' })), []);
  assert.deepEqual(missingFor(cfg({ provider: 'melipayamak', apiKey: 'u', secret: 'p', sender: '3000x' })), []);
});

await check('a password-taking provider with NO password is named as incomplete', () => {
  /* This is the exact shape the provider complained about. */
  const m = missingFor(cfg({ provider: 'melipayamak', apiKey: 'u', secret: '', sender: '3000x' }));
  assert.equal(m.length, 1, JSON.stringify(m));
  assert.match(m[0]!, /رمز/, String(m[0]));
});

await check('and so is one with no key, or no sender line', () => {
  assert.deepEqual(missingFor(cfg({ provider: 'niazpardaz', apiKey: '', sender: '3000x' })), ['کلید API']);
  assert.deepEqual(missingFor(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '' })), ['شمارهٔ فرستنده']);
});

await check('whitespace is not a password', () => {
  /* «   » in a form field looks filled in and is not. */
  const m = missingFor(cfg({ provider: 'farazsms', apiKey: 'u', secret: '   ', sender: '3000x' }));
  assert.match(m.join(''), /رمز/, JSON.stringify(m));
});

await check('every missing field is listed, not just the first', () => {
  const m = missingFor(cfg({ provider: 'generic', apiKey: '', secret: '', genericUrl: '' }));
  assert.equal(m.length, 3, JSON.stringify(m));
});

await check('the sandbox provider needs nothing, because it sends nothing', () => {
  assert.deepEqual(missingFor(cfg({ provider: 'sandbox' })), []);
});

/* ── AND IT GOES WHERE THE OPERATOR CAN SEE IT GOING ─────────────────────
   «یکی از دلایلی که آی‌پی بلاک شده بود NotValidTemplateFound بوده است.» That is
   the answer of an API that was never asked a niazpardaz question — one call
   going to somebody else's service because a URL was left in the shared
   «آدرس سفارشی» box from trying another provider.

   The first attempt at this refused any host that was not niazpardaz.ir, and it
   broke a real case on the first run: the withdrawal-code tests point this at a
   LOCAL STUB SERVER, and so would any staging or mirror setup. A deliberate
   override and a leftover look exactly alike from here. So the override stands,
   and what is checked is that it is never invisible. */

await check('a custom address is honoured, whoever it belongs to', () => {
  /* Refusing this is what broke withdrawOtp: a stub on 127.0.0.1 is the only
     way to test an SMS path without sending real messages. */
  const stub = 'http://127.0.0.1:41547';
  assert.equal(niazpardazBase(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: stub })), stub);
});

await check('an empty box means the default, not an empty base', () => {
  assert.equal(niazpardazBase(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: '' })), NIAZPARDAZ_BASE);
  assert.equal(niazpardazBase(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: '   ' })), NIAZPARDAZ_BASE);
});

await check('an override is REPORTED, which is the whole defence', () => {
  const stray = cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: 'https://ippanel.com/api/select' });
  const e = effectiveBase(stray);
  assert.equal(e.overridden, true, 'a redirected provider must not look normal');
  assert.equal(e.url, 'https://ippanel.com/api/select', 'and the operator is told exactly where it goes');
});

await check('and an untouched provider is not flagged for nothing', () => {
  const plain = cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: '' });
  assert.equal(effectiveBase(plain).overridden, false);
  assert.equal(effectiveBase(plain).url, NIAZPARDAZ_BASE);
});

await check('a provider that IGNORES the box still says the box is filled', () => {
  /* kavenegar has a fixed endpoint, so a URL sitting there changes nothing and
     explains nothing — which is exactly how it survives to confuse the next
     person looking for why messages stopped. */
  const k = cfg({ provider: 'kavenegar', apiKey: 'k', sender: '3000', genericUrl: 'https://ippanel.com/api/select' });
  assert.equal(effectiveBase(k).overridden, true);
  /* AND THE OTHER HALF, without which «always true» passes just as well — this
     line is here because a mutation returning a constant survived the one
     above. A warning that is always on is a warning nobody reads. */
  const clean = cfg({ provider: 'kavenegar', apiKey: 'k', sender: '3000', genericUrl: '' });
  assert.equal(effectiveBase(clean).overridden, false, 'an untouched provider must not be flagged');
  const melli = cfg({ provider: 'melipayamak', apiKey: 'u', secret: 'p', sender: '3000', genericUrl: '' });
  assert.equal(effectiveBase(melli).overridden, false);
});

await check('and the generic provider is not flagged for using its own field', () => {
  const g = cfg({ provider: 'generic', apiKey: 'u', secret: 'p', genericUrl: 'https://example.test/sms' });
  assert.equal(effectiveBase(g).overridden, false, 'the box belongs to this provider');
  assert.equal(effectiveBase(g).url, 'https://example.test/sms');
});

/* ── AND THE REQUEST REALLY IS NOT SENT ──────────────────────────────────
   The rule above is only worth anything if `dispatch` obeys it. A network call
   here would be a real one, so the test watches `fetch` instead: the whole
   point is that it is NEVER REACHED. */
await check('an incomplete provider never opens a socket', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  (globalThis as any).fetch = async () => { calls++; throw new Error('should not have been called'); };
  try {
    const { sendSms, updateSmsConfig } = await import('../services/smsService.js');
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'melipayamak', apiKey: 'u', secret: '', sender: '3000x' });
    const entry = await sendSms('09121234567', 'سلام', null);
    assert.equal(calls, 0, 'a malformed request was sent to the provider anyway');
    assert.equal(entry.status, 'failed');
    assert.match(String(entry.error), /ناقص|رمز/, String(entry.error));
  } finally { (globalThis as any).fetch = realFetch; }
});

console.log(`[smsGuard] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
