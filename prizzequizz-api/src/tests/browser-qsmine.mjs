/* «سؤال‌های من» IN THE QUIZ MAKER, AND THE SHELL THAT MUST NOT MOVE.
 *
 * «وقتی در قسمت کوییزساز می‌ری به سؤالات من، کل صفحه قاطی می‌کنه و کار نمی‌کنه.»
 *
 * Every `.screen` is its own scroll container — position:absolute, inset:0,
 * overflow-y:auto — and the phone shell around them is fixed. `scrollIntoView()`
 * has no way to know that: it walks up EVERY scrollable ancestor, so for an
 * element sitting in a screen that is not on display it gives up on the inner
 * container and drags the outer one. Measured: the whole app moved 581px off
 * the top of the window, and STAYED there through every screen afterwards.
 * Nothing on the page worked again until it was reloaded.
 *
 * The shell's own position is therefore the test, before and after.
 *
 * Run: node src/tests/browser-qsmine.mjs */
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 7, xp: 900, wallet: 0, coins: 500, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
/* Enough questions that the list is taller than the screen — a short list has
   nothing to scroll to and would hide the fault. */
const MINE = Array.from({ length: 14 }, (_, i) => ({
  id: 'q' + i, text: 'سؤال شمارهٔ ' + (i + 1) + ' با متنی به قدر کافی بلند برای یک ردیف کامل',
  status: ['pending', 'approved', 'rejected'][i % 3],
  reward: i % 3 === 1 ? { icon: '🎁', amount: 5000, label: 'تومان' } : null
}));
await ctx.route('**/v1/**', (r) => {
  const u = r.request().url();
  const send = (d) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (/\/questions\/mine/.test(u)) return send({ rows: MINE });
  if (/maker-topics/.test(u)) return send({ topics: [{ name: 'فوتبال', icon: '⚽', questionCount: 12 }, { name: 'سینما', icon: '🎬', questionCount: 5 }] });
  return send({});
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 110)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/** Where the phone shell sits. It is fixed: this must never change. */
const shell = () => page.evaluate(() => {
  const v = document.getElementById('vp') || document.querySelector('.phone');
  const r = v.getBoundingClientRect();
  const scr = document.querySelector('.screen.active');
  return { top: Math.round(r.top), left: Math.round(r.left),
           screen: scr ? scr.id : '', screenTop: scr ? Math.round(scr.getBoundingClientRect().top) : 0,
           screenScroll: scr ? Math.round(scr.scrollTop) : 0 };
});

const at0 = await shell();
console.log('the shell starts where it belongs:');
ok('at the top of the window', at0.top === 0, 'top ' + at0.top);

/* THE REPORTED PATH. Enter the maker, choose a topic, ask for «سؤال‌های من». */
await page.evaluate(() => { (0, eval)('hmQuizMaker')(); });
await page.waitForTimeout(700);
await page.evaluate(() => { (0, eval)('qsPickCat')('فوتبال'); });
await page.waitForTimeout(700);
const before = await shell();
await page.evaluate(() => { (0, eval)('qsLoadMine')(true); });
await page.waitForTimeout(1200);
const after = await shell();

console.log('after «سؤال‌های من» on the maker:');
ok('the shell has not moved', after.top === 0, 'top ' + after.top);
ok('and is still square with the window', after.left === before.left, after.left + ' vs ' + before.left);
ok('the screen itself did the scrolling', after.screenScroll > 0, 'scrollTop ' + after.screenScroll);
ok('the list is on the screen the player is on', after.screen === 'qsubmit', after.screen);
ok('and it really is their questions', await page.evaluate(() => /سؤال‌های من/.test((document.getElementById('qsMine') || {}).textContent || '')));

/* THE CASE THAT BROKE IT: asking while the list's screen is NOT on display.
   Both ways into the maker do exactly this — they load the list and land the
   player on the topic picker, which is a different screen. */
await page.evaluate(() => { (0, eval)('go')('qstopics'); });
await page.waitForTimeout(600);
await page.evaluate(() => { (0, eval)('qsLoadMine')(true); });
await page.waitForTimeout(1200);
const hidden = await shell();

console.log('and when the list is on a screen that is not showing:');
ok('the shell STILL has not moved', hidden.top === 0, 'top ' + hidden.top);
ok('the player is left on the screen they were on', hidden.screen === 'qstopics', hidden.screen);
ok('which is not scrolled somewhere odd', hidden.screenScroll === 0, 'scrollTop ' + hidden.screenScroll);

/* AND IT LEAVES THAT SCREEN ALONE. Nothing resets a screen's scroll when it is
   shown, so quietly scrolling one that is out of sight means the player opens
   the form somewhere in its middle next time they walk into it. */
await page.evaluate(() => { (0, eval)('qsPickCat')('سینما'); });
await page.waitForTimeout(800);
const opened = await page.evaluate(() => {
  const scr = document.getElementById('qsubmit');
  return { scroll: Math.round(scr.scrollTop), active: scr.classList.contains('active') };
});
console.log('and the form opens where a form should:');
ok('the maker is showing', opened.active === true);
ok('at the top, not part way down it', opened.scroll === 0, 'scrollTop ' + opened.scroll);

/* AND IT DOES NOT LEAVE A MESS BEHIND. The old fault outlived the screen it
   happened on: every screen after it was displaced too. */
await page.evaluate(() => { (0, eval)('go')('home'); });
await page.waitForTimeout(700);
const later = await shell();
console.log('and afterwards, on another screen entirely:');
ok('the shell is where it started', later.top === 0, 'top ' + later.top);
ok('the home screen is drawn in the window, not above it', later.screenTop === 0, 'screen top ' + later.screenTop);

console.log(`\n[qsmine] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
