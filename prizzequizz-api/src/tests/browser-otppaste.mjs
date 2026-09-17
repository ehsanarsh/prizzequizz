/* THE CODE, WITHOUT DEPENDING ON ANYTHING OUTSIDE THIS FILE.
 *
 * «کد بازم کپی نمیشه.»
 *
 * There were two routes to the four digits and BOTH of them can be dead while
 * everything on screen looks perfectly normal:
 *
 *   · the keyboard's own suggestion needs the phone to have recognised the
 *     message, which is not ours to arrange;
 *   · WebOTP needs the SMS to end with `@host #code`, which needs
 *     PUBLIC_APP_URL set on the server — and when it is not, `webOtpLine`
 *     returns an empty string, the message goes out looking ordinary, and
 *     nothing anywhere says the autofill was ever meant to happen.
 *
 * So there is a third route that needs neither: Android's SMS notification
 * offers «Copy 1234», and a tap on this button is the user gesture the
 * clipboard wants before it will be read.
 *
 * Everything here goes through the BUTTON. Calling pzOtpPaste() from a script
 * would prove the function works and say nothing about whether a player can
 * reach it — which is exactly how the reply-to bug survived its first test.
 *
 * Run: node src/tests/browser-otppaste.mjs */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

/** @param clip what is on the clipboard; `null` means reading is refused,
 *              `false` means the browser has no clipboard read at all. */
async function open(clip) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((c) => {
    /* Stood in for, because a headless browser has no phone and no notification
       shade. What is being checked is what the PAGE does with each answer. */
    if (c === false) { try { delete navigator.clipboard; } catch (e) {} 
      try { Object.defineProperty(navigator, 'clipboard', { get: () => undefined, configurable: true }); } catch (e) {}
      return; }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => ({ readText: () => (c === null ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : Promise.resolve(c)) })
    });
  }, clip);
  const verified = [];
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let d = {};
    if (u.includes('/auth/login')) d = { otpRequired: true, requestId: 'rq1', ttlSeconds: 120, resendAfterSeconds: 60, phone: '09121234567', delivered: true, testMode: false };
    else if (u.includes('/auth/otp/verify')) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      verified.push(b);
      /* Refused on purpose: what matters is THAT it was submitted, and refusing
         keeps the screen where it is. */
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'BAD', message: 'کد اشتباه' } }) });
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  /* THE WAY A PLAYER GETS THERE: a number typed into the login screen and the
     button pressed. Jumping straight to the code screen would skip the very
     code that decides whether the button is on it. */
  await page.fill('#phoneInput', '09121234567');
  await page.click('#login .btn-primary');
  await page.waitForTimeout(700);
  return { ctx, page, verified, errs };
}

const boxes = (page) => page.evaluate(() => [...document.querySelectorAll('#otpBoxes input')].map((b) => b.value));
const btnShown = (page) => page.evaluate(() => {
  const b = document.getElementById('otpPasteBtn');
  if (!b) return 'MISSING';
  const r = b.getBoundingClientRect();
  return getComputedStyle(b).display !== 'none' && r.width > 0 && r.height > 0 ? 'shown' : 'hidden';
});
/* A REAL TAP. Not .click() from a script on a hidden element — the button has
   to be somewhere a thumb could land.
   The boxes are read at +60ms and the value RETURNED, because a complete code
   presses ورود at +160ms and a refused code clears the boxes again. Reading
   them afterwards showed four empty boxes for a paste that had worked
   perfectly — the test watching the wrong moment, not the code failing. */
const tapPaste = async (page) => {
  await page.click('#otpPasteBtn');
  await page.waitForTimeout(60);
  const filled = await boxes(page);
  await page.waitForTimeout(600);
  return filled;
};
const toastText = (page) => page.evaluate(() => (document.getElementById('pzToast') || {}).textContent || '');

/* ── 1. THE ORDINARY CASE ───────────────────────────────────────────────── */
console.log('a code on the clipboard:');
{
  const { ctx, page, verified, errs } = await open('4821');
  ok('the paste button is on the code screen', (await btnShown(page)) === 'shown', await btnShown(page));
  ok('and the boxes start empty', (await boxes(page)).join('') === '', (await boxes(page)).join(','));

  const typed = await tapPaste(page);
  ok('tapping it types the code in', typed.join('') === '4821', typed.join(','));
  /* «خودشم تایید کنه» — filling the boxes and then waiting for a second tap is
     half the job. */
  ok('and presses ورود without being asked', verified.length === 1 && verified[0].code === '4821', JSON.stringify(verified));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE WHOLE MESSAGE, WHICH IS WHAT PEOPLE ACTUALLY COPY ───────────── */
console.log('\nthe whole SMS on the clipboard:');
{
  const { ctx, page, verified } = await open('پرایز کوییز\nکد ورود شما: 7350\n@www.prizequiz.ir #7350');
  const typed = await tapPaste(page);
  ok('the code is found inside the message', typed.join('') === '7350', typed.join(','));
  ok('and submitted once, not twice', verified.length === 1 && verified[0].code === '7350', JSON.stringify(verified));
  await ctx.close();
}
{
  /* A run of exactly four wins over the digits that come first — otherwise
     «۲ پیام نو، کد: 1234» would be read as «2123». */
  const { ctx, page } = await open('2 new · code 1234');
  const typed = await tapPaste(page);
  ok('a stray digit before the code does not shift it', typed.join('') === '1234', typed.join(','));
  await ctx.close();
}
{
  const { ctx, page, verified } = await open('کد ورود شما: ۹۰۴۶');
  const typed = await tapPaste(page);
  ok('Persian digits are read as digits', typed.join('') === '9046', typed.join(','));
  ok('and that is what is sent', verified.length === 1 && verified[0].code === '9046', JSON.stringify(verified));
  await ctx.close();
}

/* ── 3. WHEN THERE IS NOTHING TO PASTE ──────────────────────────────────── */
console.log('\nwhen the clipboard cannot help:');
{
  const { ctx, page, verified, errs } = await open('سلام خوبی؟');
  const typed = await tapPaste(page);
  ok('no digits means the boxes are left alone', typed.join('') === '', typed.join(','));
  ok('and nothing is sent to the server', verified.length === 0, JSON.stringify(verified));
  ok('the player is told why, not left guessing', /حافظه/.test(await toastText(page)), await toastText(page));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const { ctx, page, verified } = await open('12');
  const typed = await tapPaste(page);
  /* Half a code still goes on screen — the player can see what was found and
     finish it, which beats being told nothing happened. */
  ok('half a code is shown rather than discarded', typed.join('') === '12', typed.join(','));
  ok('but half a code is never submitted', verified.length === 0, JSON.stringify(verified));
  /* AND THE PLAYER IS TOLD WHAT WAS FOUND.
     Submitting is refused twice over — pzOtpAutoSubmit checks the length too —
     so removing the guard here breaks nothing about the SEND, and a test that
     only watched the server passed with it gone. What the guard is actually
     for is this sentence: two digits in the boxes and no explanation is a
     player wondering whether they tapped it properly. */
  ok('and told how much of a code there was', /رقم/.test(await toastText(page)), await toastText(page));
  await ctx.close();
}
{
  const { ctx, page, verified, errs } = await open(null);   // permission refused
  await tapPaste(page);
  ok('a refusal is not an error the player has to read twice', /اجازه/.test(await toastText(page)), await toastText(page));
  ok('and nothing is submitted', verified.length === 0, JSON.stringify(verified));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}
{
  const { ctx, page } = await open(false);                  // no clipboard at all
  /* A button that cannot work should not be on the screen at all. */
  ok('a browser with no clipboard is shown no button', (await btnShown(page)) === 'hidden', await btnShown(page));
  await ctx.close();
}

/* A fourth section stood here — «the button survives going to the login screen
   and back». It could not fail: the button is shown when the code is requested
   and nothing ever hides it, so both the case and the extra pzOtpPasteSync()
   calls it was written to protect were removed rather than left looking like
   coverage. A mutation surviving is how that was found. */

await browser.close(); server.close();
console.log(`\n[otppaste] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
