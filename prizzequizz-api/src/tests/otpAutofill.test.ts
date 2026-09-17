/* THE CODE THAT FILLS ITSELF IN.
 *
 * «یه کاری کن وقتی کد میاد خودش کپی کنه بزنه اونجا و ورود رو بزنه اتوماتیک.»
 *
 * Android hands a code straight to a page when — and only when — the message
 * ends with `@host #code` on its own last line. Get the shape wrong and nothing
 * happens, silently, for ever: there is no error and no way to tell from the
 * outside that it was ever meant to work. So the shape is what is checked.
 *
 * Run: npx tsx src/tests/otpAutofill.test.ts
 */
import assert from 'node:assert/strict';
import { webOtpLine } from '../services/smsService.js';

let pass = 0, fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const withUrl = (url: string, fn: () => void) => {
  const before = process.env.PUBLIC_APP_URL;
  if (url) process.env.PUBLIC_APP_URL = url; else delete process.env.PUBLIC_APP_URL;
  try { fn(); } finally { if (before === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = before; }
};

check('the line has the exact shape a phone will act on', () => {
  withUrl('https://www.prizequiz.ir', () => {
    const line = webOtpLine('1234');
    /* Newline, @host, one space, #code, and nothing after it. */
    assert.equal(line, '\n@www.prizequiz.ir #1234');
    assert.ok(/\n@[^\s]+ #\d+$/.test(line), 'the shape is wrong: ' + JSON.stringify(line));
  });
});

check('it carries the HOST, not the whole address', () => {
  /* `@https://www.prizequiz.ir/ #1234` is not a host and is silently ignored. */
  withUrl('https://www.prizequiz.ir/some/path?x=1', () => {
    assert.equal(webOtpLine('9876'), '\n@www.prizequiz.ir #9876');
  });
});

check('and a port stays, because a port is part of the origin', () => {
  withUrl('https://staging.prizequiz.ir:8443', () => {
    assert.equal(webOtpLine('4321'), '\n@staging.prizequiz.ir:8443 #4321');
  });
});

check('a developer machine gets no line at all', () => {
  /* Perfectly real as an origin, and meaningless on somebody's phone. */
  withUrl('http://localhost:4173', () => assert.equal(webOtpLine('1111'), ''));
  withUrl('http://127.0.0.1:5173', () => assert.equal(webOtpLine('1111'), ''));
});

check('nor does an origin nobody configured', () => {
  withUrl('', () => assert.equal(webOtpLine('1111'), ''));
});

check('nor one that is not an address', () => {
  withUrl('prizequiz', () => assert.equal(webOtpLine('1111'), ''));
});

check('the code in the line is the code that was sent', () => {
  withUrl('https://www.prizequiz.ir', () => {
    assert.ok(webOtpLine('5309').endsWith('#5309'));
    assert.ok(!webOtpLine('5309').includes('1234'));
  });
});

console.log(`[otpAutofill] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
