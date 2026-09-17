/* THE CODE, TYPED FOR THEM.
 *
 * «یه کاری کن وقتی کد میاد خودش کپی کنه بزنه اونجا و ورود رو بزنه اتوماتیک.»
 *
 * Four boxes with maxlength=1 have a trap in them: an autofill or a paste
 * delivers all four digits into ONE box, and a box that accepts one character
 * keeps the first and throws the rest away. So the player watches their phone
 * offer the code, taps it, and a single digit appears. That is the thing this
 * file exists to make impossible.
 *
 * Run: node src/tests/browser-otpauto.mjs */
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

const verified = [];
async function open() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let d = {};
    if (u.includes('/auth/login')) d = { otpRequired: true, requestId: 'rq1', ttlSeconds: 120, resendAfterSeconds: 60, phone: '09121234567', delivered: true, testMode: false };
    else if (u.includes('/auth/otp/verify')) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      verified.push(b);
      /* Refuse it: what matters here is THAT it was submitted, and refusing
         keeps the screen where it is so the next case can run. */
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'BAD', message: 'کد اشتباه' } }) });
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  /* Onto the code screen, the way a player gets there. */
  await page.evaluate(() => { (0, eval)("_rid='rq1'"); (0, eval)("go('otp')"); });
  await page.waitForTimeout(400);
  return { ctx, page, errs };
}
const boxes = (page) => page.evaluate(() => [...document.querySelectorAll('#otpBoxes input')].map((b) => b.value));

console.log('the code screen:');
{
  const { ctx, page, errs } = await open();
  const n = await page.evaluate(() => document.querySelectorAll('#otpBoxes input').length);
  ok('there are four boxes', n === 4, String(n));
  ok('the first one asks the phone for the code',
     await page.evaluate(() => document.querySelector('#otpBoxes input').getAttribute('autocomplete')) === 'one-time-code');

  /* ── THE TRAP: four digits into one box ────────────────────────────────── */
  const before = verified.length;
  await page.evaluate(() => {
    /* Exactly what an autofill does: the whole code, in the first box. */
    const b = document.querySelector('#otpBoxes input');
    b.value = '4271';
    b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  /* Read BEFORE the auto-submit lands: a refused code clears the boxes, which
     is right for the player and would hide what was in them a moment earlier. */
  await page.waitForTimeout(70);
  const filled = await boxes(page);
  ok('a code that lands in ONE box is spread across all four',
     filled.join('') === '4271', JSON.stringify(filled));
  await page.waitForTimeout(600);
  ok('and it submits itself, without the player pressing anything',
     verified.length === before + 1 && verified[before].code === '4271', JSON.stringify(verified.slice(before)));
  ok('the page threw nothing', errs.length === 0, errs.join(' | ').slice(0, 140));
  await ctx.close();
}
{
  /* ── PASTING ───────────────────────────────────────────────────────────── */
  const { ctx, page } = await open();
  const before = verified.length;
  await page.evaluate(() => {
    const b = document.querySelector('#otpBoxes input');
    const dt = new DataTransfer();
    dt.setData('text', 'کد شما 8135 است');       /* pasted out of the message */
    b.focus();
    b.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(70);
  const pasted = await boxes(page);
  ok('pasting the whole message takes the digits out of it',
     pasted.join('') === '8135', JSON.stringify(pasted));
  await page.waitForTimeout(600);
  ok('and submits', verified.length === before + 1 && verified[before].code === '8135', JSON.stringify(verified.slice(before)));
  await ctx.close();
}
{
  /* ── PERSIAN DIGITS ────────────────────────────────────────────────────── */
  const { ctx, page } = await open();
  const before = verified.length;
  await page.evaluate(() => {
    const b = document.querySelector('#otpBoxes input');
    b.value = '۹۴۰۶';                             /* what a Persian keyboard makes */
    b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  ok('a code in Persian digits is understood',
     verified.length === before + 1 && verified[before].code === '9406', JSON.stringify(verified.slice(before)));
  await ctx.close();
}
{
  /* ── TYPED BY HAND ─────────────────────────────────────────────────────── */
  const { ctx, page } = await open();
  const before = verified.length;
  for (const [i, d] of ['5', '0', '2', '8'].entries()) {
    await page.evaluate(([n, v]) => {
      const b = [...document.querySelectorAll('#otpBoxes input')][n];
      b.value = v; b.dispatchEvent(new Event('input', { bubbles: true }));
    }, [i, d]);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  ok('typing the last digit is enough — no button to find',
     verified.length === before + 1 && verified[before].code === '5028', JSON.stringify(verified.slice(before)));
  await ctx.close();
}
{
  /* ── AND NOT BEFORE IT IS COMPLETE ─────────────────────────────────────── */
  const { ctx, page } = await open();
  const before = verified.length;
  await page.evaluate(() => {
    const b = document.querySelector('#otpBoxes input');
    b.value = '77';                               /* half a code */
    b.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  ok('half a code is not sent anywhere', verified.length === before, JSON.stringify(verified.slice(before)));
  ok('but what there was of it is kept on screen',
     (await boxes(page)).join('') === '77', JSON.stringify(await boxes(page)));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`[otpauto] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
