/* THE LISTENER THAT IS STILL LISTENING WHEN YOU COME BACK.
 *
 * «کد هم یکبار کپی شد یکبار نشد.»
 *
 * Reading the message means leaving the app, and Android may drop a pending
 * WebOTP request while the page is hidden WITHOUT ever rejecting its promise.
 * The guard that skipped re-arming "when something is already listening" then
 * never fires again — a silently dropped request looks outstanding for ever —
 * so the player returns to a code screen that appears to be waiting and is not.
 * Once, at random, with nothing to see. That is what «یکبار شد یکبار نشد» is.
 *
 * `OTPCredential` does not exist in a headless browser, so it is stood in for.
 * What is being checked is OUR logic — do we ask again? — and the stand-in only
 * has to count the asks and honour an abort, which is all the real API
 * guarantees us here.
 *
 * Run: node src/tests/browser-otprearm.mjs */
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

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    /* THE STAND-IN. Every call is recorded and left PENDING on purpose — that
       is the state Android leaves behind when it drops a request quietly, and
       the state the old guard mistook for «still listening». */
    window.__otpAsks = [];
    Object.defineProperty(window, 'OTPCredential', { configurable: true, value: function () {} });
    const creds = navigator.credentials;
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      get: () => ({
        ...creds,
        get: (opts) => {
          const rec = { aborted: false, resolve: null };
          window.__otpAsks.push(rec);
          if (opts && opts.signal) opts.signal.addEventListener('abort', () => { rec.aborted = true; });
          return new Promise((res) => { rec.resolve = res; });
        }
      })
    });
    /* Delivering a code by hand, the way the phone would. */
    window.__otpDeliver = (code) => {
      const live = window.__otpAsks.filter((a) => !a.aborted).pop();
      if (live && live.resolve) live.resolve({ code });
    };
  });
  const verified = [];
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let d = {};
    if (u.includes('/auth/login')) d = { otpRequired: true, requestId: 'rq1', ttlSeconds: 120, resendAfterSeconds: 60, phone: '09121234567', testMode: false };
    else if (u.includes('/auth/otp/verify')) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      verified.push(b);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'BAD', message: 'کد اشتباه' } }) });
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  /* Onto the code screen the way a player gets there. */
  await page.fill('#phoneInput', '09121234567');
  await page.click('#login .btn-primary');
  await page.waitForTimeout(700);
  return { ctx, page, verified, errs };
}

const asks = (page) => page.evaluate(() => window.__otpAsks.length);
const liveAsks = (page) => page.evaluate(() => window.__otpAsks.filter((a) => !a.aborted).length);
const boxes = (page) => page.evaluate(() => [...document.querySelectorAll('#otpBoxes input')].map((b) => b.value));
/* Leaving to read the message, and coming back. */
const leaveAndReturn = async (page) => {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(350);
};

console.log('asking for a code:');
{
  const { ctx, page, errs } = await open();
  ok('the page starts listening for it', (await asks(page)) === 1, (await asks(page)) + ' asks');
  ok('and it is on the code screen', await page.evaluate(() => ((document.querySelector('.screen.active') || {}).id)) === 'otp');

  /* ── THE BUG: the first request is still pending, because Android dropped it
        without saying so. Coming back must ask AGAIN anyway. ─────────────── */
  await leaveAndReturn(page);
  ok('going away and coming back asks again', (await asks(page)) === 2, (await asks(page)) + ' asks');
  ok('and only one request is left alive', (await liveAsks(page)) === 1, (await liveAsks(page)) + ' alive');

  /* Twice more, because «once» could be a coincidence and the player may check
     their messages more than once while waiting. */
  await leaveAndReturn(page);
  await leaveAndReturn(page);
  ok('every return asks again', (await asks(page)) === 4, (await asks(page)) + ' asks');
  ok('and never leaves two listening at once', (await liveAsks(page)) === 1, (await liveAsks(page)) + ' alive');
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\nand the code that arrives after all that:');
{
  const { ctx, page, verified, errs } = await open();
  await leaveAndReturn(page);
  await page.evaluate(() => window.__otpDeliver('7391'));
  await page.waitForTimeout(120);
  ok('the code is typed in', (await boxes(page)).join('') === '7391', (await boxes(page)).join(','));
  await page.waitForTimeout(600);
  /* «خودشم تایید کنه» — and the re-armed listener still presses ورود. */
  ok('and ورود is pressed by itself', verified.length === 1 && verified[0].code === '7391', JSON.stringify(verified));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\nsomewhere else in the app:');
{
  const { ctx, page } = await open();
  const before = await asks(page);
  await page.evaluate(() => { try { (0, eval)("go('login')"); } catch (e) {} });
  await page.waitForTimeout(200);
  await leaveAndReturn(page);
  /* The listener belongs to the code screen. Re-arming from anywhere else would
     leave a request open across screens the player may never come back to. */
  ok('coming back does not start listening', (await asks(page)) === before, (await asks(page)) + ' vs ' + before);
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n[otprearm] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
