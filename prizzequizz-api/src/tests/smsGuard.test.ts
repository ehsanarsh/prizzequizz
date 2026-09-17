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
import { missingFor, niazpardazBase, NIAZPARDAZ_BASE, SMS_DEFAULT_CONFIG, type SmsConfig } from '../services/smsService.js';

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

/* ── AND IT GOES TO THE RIGHT COMPANY ────────────────────────────────────
   «یکی از دلایلی که آی‌پی بلاک شده بود NotValidTemplateFound بوده است.»
   That is the answer of an API that was never asked a niazpardaz question. The
   panel's «آدرس سفارشی (Generic)» box is for the generic provider, but it was
   used as the base for niazpardaz too — so a URL left behind from trying
   another provider silently sent every niazpardaz call to somebody else's
   service, which refuses them, which blocks the IP. */

await check('a leftover Generic URL does not redirect niazpardaz', () => {
  const stray = cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: 'https://ippanel.com/api/select' });
  assert.equal(niazpardazBase(stray), NIAZPARDAZ_BASE, 'niazpardaz traffic went to another provider');
});

await check('nor does a box with something that is not a URL in it', () => {
  for (const junk of ['ippanel', '   ', 'http://', 'select']) {
    assert.equal(niazpardazBase(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: junk })),
      NIAZPARDAZ_BASE, 'accepted junk as a base: ' + JSON.stringify(junk));
  }
});

await check('but a real niazpardaz address is still honoured', () => {
  /* A staging or mirror host of theirs is a legitimate reason to set this. */
  const own = 'https://login.niazpardaz.ir/api/v3/RestWebApi';
  assert.equal(niazpardazBase(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: own })), own);
});

await check('and an empty box means the default, not an empty base', () => {
  assert.equal(niazpardazBase(cfg({ provider: 'niazpardaz', apiKey: 'k', sender: '3000', genericUrl: '' })), NIAZPARDAZ_BASE);
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
