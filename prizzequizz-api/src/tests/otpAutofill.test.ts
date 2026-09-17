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
import { webOtpLine, webOtpStatus, webOtpStatusFor, maskConfig, SMS_DEFAULT_CONFIG, warnIfNoWebOtp, _resetWebOtpWarning } from '../services/smsService.js';

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

/* ── AND WHY, WHEN IT DOES NOT HAPPEN ───────────────────────────────────── */
/* The line being absent is invisible from every side: the SMS looks normal, the
   send succeeds, and the phone just never offers the code. These pin the one
   thing that makes it diagnosable at all. */

check('a configured origin reports itself switched ON, with the host', () => {
  withUrl('https://www.prizequiz.ir', () => {
    const s = webOtpStatus();
    assert.equal(s.on, true);
    assert.equal(s.host, 'www.prizequiz.ir');
    assert.ok(s.reason.includes('www.prizequiz.ir'), s.reason);
  });
});

check('an unset PUBLIC_APP_URL says so by name', () => {
  withUrl('', () => {
    const s = webOtpStatus();
    assert.equal(s.on, false);
    /* By NAME: an operator has to know which knob to turn. «تنظیم نشده» alone
       would send them looking through the panel for a setting that is not in it. */
    assert.ok(s.reason.includes('PUBLIC_APP_URL'), s.reason);
  });
});

check('a localhost origin says localhost, not "not set"', () => {
  withUrl('http://localhost:4173', () => {
    const s = webOtpStatus();
    assert.equal(s.on, false);
    assert.ok(s.reason.includes('localhost'), s.reason);
    assert.ok(!s.reason.includes('تنظیم نشده'), 'wrong diagnosis: ' + s.reason);
  });
});

check('and a malformed one says it is malformed, and shows it', () => {
  withUrl('prizequiz', () => {
    const s = webOtpStatus();
    assert.equal(s.on, false);
    assert.ok(s.reason.includes('prizequiz'), s.reason);
  });
});

check('the reason never disagrees with the line', () => {
  for (const url of ['https://www.prizequiz.ir', 'http://localhost:4173', '', 'prizequiz', 'https://a.b:9']) {
    withUrl(url, () => {
      const s = webOtpStatus();
      const line = webOtpLine('1234');
      assert.equal(s.on, line !== '', 'status and line disagree for ' + JSON.stringify(url));
      if (s.on) assert.equal(line, '\n@' + s.host + ' #1234');
    });
  }
});

check('the panel is told, in the config it already asks for', () => {
  withUrl('https://www.prizequiz.ir', () => {
    const m = maskConfig(SMS_DEFAULT_CONFIG);
    assert.equal(m.webOtp.on, true);
    assert.equal(m.webOtp.host, 'www.prizequiz.ir');
  });
  withUrl('', () => {
    const m = maskConfig(SMS_DEFAULT_CONFIG);
    assert.equal(m.webOtp.on, false);
    assert.ok(m.webOtp.reason.includes('PUBLIC_APP_URL'), m.webOtp.reason);
  });
});

check('and telling the panel never leaks the api key', () => {
  withUrl('https://www.prizequiz.ir', () => {
    const m = maskConfig({ ...SMS_DEFAULT_CONFIG, apiKey: 'SECRETKEY9999', secret: 'shh' });
    assert.ok(!JSON.stringify(m).includes('SECRETKEY9999'), 'the key travelled to the panel');
    assert.ok(!JSON.stringify(m).includes('shh'));
    assert.equal(m.apiKeySet, true);
  });
});

check('the server log is told once, not on every login', () => {
  withUrl('', () => {
    _resetWebOtpWarning();
    assert.equal(warnIfNoWebOtp(), true, 'the first OTP with no line must say so');
    assert.equal(warnIfNoWebOtp(), false, 'and the second must not repeat it');
  });
});

check('and not at all when the line is going out', () => {
  withUrl('https://www.prizequiz.ir', () => {
    _resetWebOtpWarning();
    assert.equal(warnIfNoWebOtp(), false);
  });
});

/* ── AND A SWITCH, BECAUSE THE LINE CAN COST MORE THAN IT GIVES ──────────
   A service line («خط خدماتی») may only send an approved الگو. This line
   changes the message, so the template stops matching, the provider answers
   NotValidTemplateFound, and نیازپرداز blocks the IP of anyone who keeps
   sending requests it refuses. Whoever hits that has to be able to turn it off
   from the panel in ten seconds. */

check('switching it off in the panel really switches it off', () => {
  withUrl('https://www.prizequiz.ir', () => {
    const off = webOtpStatusFor({ ...SMS_DEFAULT_CONFIG, otp: { ...SMS_DEFAULT_CONFIG.otp, webOtpLine: false } });
    assert.equal(off.on, false, 'the switch did nothing');
    /* And says WHY it is off, so it does not read as the server being broken. */
    assert.match(off.reason, /خاموش/, off.reason);
  });
});

check('and leaving it on keeps it on', () => {
  withUrl('https://www.prizequiz.ir', () => {
    assert.equal(webOtpStatusFor({ ...SMS_DEFAULT_CONFIG, otp: { ...SMS_DEFAULT_CONFIG.otp, webOtpLine: true } }).on, true);
  });
});

check('a config saved before the switch existed behaves as it did', () => {
  /* Every stored config predates this field. Reading a missing value as «off»
     would silently turn the autofill off for everybody on the next deploy. */
  withUrl('https://www.prizequiz.ir', () => {
    const legacy: any = { ...SMS_DEFAULT_CONFIG, otp: { maxPerHour: 5, expirySeconds: 120, minIntervalSeconds: 60, testCode: '1234' } };
    assert.equal(webOtpStatusFor(legacy).on, true, 'an older config lost the autofill');
  });
});

check('the switch cannot conjure a line out of an unset origin', () => {
  /* Two different reasons for «off», and the one that is actually true has to
     be the one reported — otherwise an operator turns the switch on and waits
     for something that was never going to happen. */
  withUrl('', () => {
    const on = webOtpStatusFor({ ...SMS_DEFAULT_CONFIG, otp: { ...SMS_DEFAULT_CONFIG.otp, webOtpLine: true } });
    assert.equal(on.on, false);
    assert.match(on.reason, /PUBLIC_APP_URL/, on.reason);
  });
});

check('and the panel is told which of the two it is', () => {
  withUrl('https://www.prizequiz.ir', () => {
    const m = maskConfig({ ...SMS_DEFAULT_CONFIG, otp: { ...SMS_DEFAULT_CONFIG.otp, webOtpLine: false } });
    assert.equal(m.webOtp.on, false);
    assert.match(m.webOtp.reason, /خاموش/, m.webOtp.reason);
  });
});

console.log(`[otpAutofill] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
