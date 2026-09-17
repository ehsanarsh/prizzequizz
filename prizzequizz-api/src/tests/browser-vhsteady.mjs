/* THE FRAME THAT STOPPED RESIZING UNDER THE FINGER.
 *
 * «موقع خروج از بازی دیدم وقتی میری به منو بیشتر و تنظیمات، وقتی اسکرول می‌کنی
 *  می‌روی تا آخر، موقع اسکرول کلاً یه لحظه نظم صفحه به هم می‌ریزه.»
 *
 * On Android, scrolling hides the browser's URL bar, so the window grows by
 * forty-odd pixels MID-GESTURE. The viewport handler listened to every visual
 * viewport scroll and wrote `--pz-vh` each time — and `--pz-vh` is the height
 * of `.phone` and of several `calc(var(--pz-vh) - N)` panes. So the whole app
 * frame was being re-laid-out under the thumb, which is what «نظم صفحه به هم
 * می‌ریزه» looks like.
 *
 * The frame now keeps the TALLEST height it has seen and only shrinks for a
 * real keyboard. What is checked is that a scroll that changes the viewport
 * height does not change `--pz-vh`, and that a keyboard still does.
 *
 * Run: node src/tests/browser-vhsteady.mjs */
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

/* A FAKE visualViewport, because a headless browser has no URL bar to hide.
   It is installed before the page's own script runs, so the app binds to this
   one and nothing else has to be stubbed. What is simulated is the only thing
   Android actually does: the height changes and a `resize`+`scroll` is fired. */
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}

  const listeners = { resize: [], scroll: [] };
  /* 784, NOT 844. The page loads with the URL bar still showing, so the very
     first thing the app measures is the SHORT viewport. Starting this at the
     full height hid a real hole: remembering only the tallest height SEEN was
     enough to pass, when what the frame must actually be pinned to is the
     window. A mutation surviving is how that was found. */
  const vv = {
    height: 784, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1, pageTop: 0, pageLeft: 0,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: () => {}
  };
  Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
  window.__vv = (h, offsetTop = 0) => {
    vv.height = h; vv.offsetTop = offsetTop;
    for (const t of ['resize', 'scroll']) for (const fn of (listeners[t] || [])) { try { fn(); } catch (e) {} }
  };
});
await ctx.route('**/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

const vh = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pz-vh').trim());
/* COUNTING THE WRITES, not just reading the value.
   Half of this fix is that `--pz-vh` is written only when it CHANGED: a custom
   property on <html> invalidates layout for the whole page, and paying that on
   every scroll event is the cost even when the number is identical. Reading the
   value cannot see that — the value is the same either way — so the setter is
   counted instead. */
const armWriteCount = () => page.evaluate(() => {
  window.__vhWrites = 0;
  const orig = CSSStyleDeclaration.prototype.setProperty;
  CSSStyleDeclaration.prototype.setProperty = function (k, v, p) {
    if (k === '--pz-vh') window.__vhWrites++;
    return orig.call(this, k, v, p);
  };
});
const writeCount = () => page.evaluate(() => window.__vhWrites);
const kb = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pz-kb').trim());
const phoneH = () => page.evaluate(() => Math.round(document.querySelector('.phone').getBoundingClientRect().height));
const bump = async (h, top = 0) => { await page.evaluate(([x, t]) => window.__vv(x, t), [h, top]); await page.waitForTimeout(120); };

console.log('the app frame while scrolling:');
{
  /* THE GESTURE, AS ANDROID ACTUALLY DOES IT.
     The first draft of this simulated the visual viewport growing PAST
     window.innerHeight, and the test failed — on something that cannot happen.
     In Chrome for Android `window.innerHeight` is the LAYOUT viewport: it is
     the height with the URL bar hidden and it does not move. What moves is
     `visualViewport.height`, which sits BELOW it while the bar is showing and
     rises to meet it as the bar slides away. So the scroll is 784 → 844, not
     844 → 884, and the whole point is that the frame is 844 the entire time. */
  await bump(784);                       // the bar is showing
  const settled = await vh();
  ok('the frame has a height to begin with', /^\d+px$/.test(settled), settled);
  ok('and it is the full window, not the part left over by the URL bar',
    parseInt(settled, 10) === 844, settled);
  const startPhone = await phoneH();

  await armWriteCount();
  const seen = [];
  for (const h of [790, 800, 816, 830, 844, 830, 812, 796, 784]) {
    await bump(h);
    seen.push(await vh());
  }
  ok('every step of the scroll leaves the frame the same height',
    new Set(seen).size === 1, seen.join(' → '));
  /* Nine viewport changes, and the app frame is not rewritten once. */
  ok('and the frame is not even re-written during the gesture',
    (await writeCount()) === 0, (await writeCount()) + ' writes over 9 steps');
  ok('and .phone itself never moves', (await phoneH()) === startPhone,
    startPhone + ' → ' + (await phoneH()));
  ok('the frame stays the full window throughout',
    parseInt(await vh(), 10) === 844, await vh());
}

console.log('\nand when a keyboard really is in the way:');
{
  /* 844 → 520 with the page pinned to the top is a keyboard, not a URL bar:
     324px is far more than a toolbar and the app has to give way to it. */
  await bump(520);
  ok('the frame does shrink for a keyboard', parseInt(await vh(), 10) === 520, await vh());
  ok('and says how much is covered', parseInt(await kb(), 10) > 90, await kb());
  ok('the body is marked, so anything that must lift itself can',
    await page.evaluate(() => document.body.classList.contains('pz-kb-open')));

  await bump(844);
  ok('and it comes back when the keyboard goes', parseInt(await vh(), 10) === 844, await vh());
  ok('with nothing left covered', parseInt(await kb(), 10) === 0, await kb());
  ok('and the mark removed', await page.evaluate(() => !document.body.classList.contains('pz-kb-open')));
}

console.log('\na toolbar is not a keyboard:');
{
  /* The line between them is 90px. A 60px browser toolbar must NOT be treated
     as a keyboard — that was the whole bug, one gesture at a time. */
  await bump(784);
  ok('a 60px toolbar leaves the frame alone', parseInt(await vh(), 10) === 844, await vh());
  ok('and is not called a keyboard', await page.evaluate(() => !document.body.classList.contains('pz-kb-open')));
}

ok('nothing threw', errs.length === 0, errs.join(' | '));
await browser.close(); server.close();
console.log(`\n[vhsteady] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
