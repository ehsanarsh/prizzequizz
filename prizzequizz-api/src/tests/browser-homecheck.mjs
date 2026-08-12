/* THE NEW HOME, DRIVEN.
 *
 * Four modes behind one card is only better than four stacked cards if the
 * card actually turns. So this swipes it with a real finger path, checks the
 * mode changed, checks a small drag snaps BACK (a card left halfway is worse
 * than no gesture at all), and checks a vertical flick is still a scroll.
 */
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/* A logged-in session, or the app sits on the login screen and nothing lays out. */
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 'test-token');
  localStorage.setItem('pz_rtok', 'test-rtoken');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 3, xp: 120, wallet: 0, coins: 360, hearts: 5, weeklyScore: 92 }));
});
await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (p === '/leaderboards/weekly-winnings') return send({ entries: [
    { rank: 1, userId: 'a', username: 'زرگل', avatar: '', character: null, score: 2400000, highlighted: false },
    { rank: 2, userId: 'b', username: 'رضا', avatar: '', character: null, score: 1100000, highlighted: false },
    { rank: 3, userId: 'c', username: 'سینا', avatar: '', character: null, score: 750000, highlighted: true }
  ] });
  if (p === '/leaderboards/weekly') return send({ entries: [] });
  if (p.startsWith('/users/')) return send({ id: 'u1', username: 'ehsan', level: 3, xp: 120, weeklyScore: 92, balances: {}, matches: 0, wins: 0 });
  return send({});
});

const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);                     // splash routing
await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
await page.waitForTimeout(900);

const title = () => page.evaluate(() => document.querySelector('#mcard h2')?.textContent || '');
const idx = () => page.evaluate(() => (0, eval)('hmIdx'));

console.log('the card:');
{
  const t = await title();
  ok('home opens on the first mode', /دوئل/.test(t), t);
  const box = await page.evaluate(() => { const r = document.getElementById('mcard').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; });
  ok('the card is actually laid out', box.w > 150 && box.h > 200, box.w + '×' + box.h);
  const rails = await page.evaluate(() => ({ r: document.querySelectorAll('#hrailR .hside').length, l: document.querySelectorAll('#hrailL .hside').length }));
  ok('both rails carry their icons', rails.r === 3 && rails.l === 4, 'right ' + rails.r + ', left ' + rails.l);
  const dots = await page.evaluate(() => document.querySelectorAll('#mdots i').length);
  ok('there is one dot per mode', dots === 4, String(dots));
}

/* A real finger: press, move in steps, release. */
async function swipe(dx, dy = 0, steps = 12) {
  const b = await page.evaluate(() => { const r = document.getElementById('mcard').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; });
  await page.touchscreen.tap(b.x, b.y).catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x + (dx * i) / steps, y: b.y + (dy * i) / steps }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(350);
}

console.log('the swipe:');
{
  await swipe(160);
  ok('a swipe toward the right moves to the next mode', /بازمانده/.test(await title()), await title());
  await swipe(-160);
  ok('and back the other way returns', /دوئل/.test(await title()), await title());

  const before = await idx();
  await swipe(18);                                   // a nudge, not a swipe
  ok('a small drag snaps back instead of switching', (await idx()) === before, 'index ' + before + ' → ' + (await idx()));

  const t0 = await title();
  await swipe(0, 120);                               // a vertical flick
  ok('a vertical flick is a scroll, not a mode change', (await title()) === t0);
}

console.log('the rest:');
{
  await page.evaluate(() => { try { (0, eval)('hmSet')(0); } catch (e) {} });
  await page.waitForTimeout(200);
  const arrow = await page.evaluate(async () => {
    document.querySelector('#mcard .mk-arrow.next').click();
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector('#mcard h2').textContent;
  });
  ok('the arrow works too', /بازمانده/.test(arrow), arrow);

  const t3 = await page.evaluate(() => ({ n: document.querySelectorAll('#top3Row .t3p').length, txt: (document.getElementById('top3Row').textContent || '').replace(/\s+/g, ' ').slice(0, 60) }));
  ok('the week’s three biggest prizes are real rows', t3.n === 3, t3.txt);
  ok('and they show money, not cup points', /۲٬۴۰۰٬۰۰۰|2,400,000/.test(t3.txt), t3.txt);

  /* "still there" passed on ANY value, including the transparent rail a later
     !important block was still winning. Assert the colour it must actually be. */
  const cup = await page.evaluate(() => {
    const el = document.querySelector('#home .weekly-progress-line');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, flag: getComputedStyle(el.querySelector('.wpl-flag small')).color, marker: !!el.querySelector('.wpl-marker') };
  });
  ok('the cup rail is still there', !!cup && cup.marker, JSON.stringify(cup));
  ok('and it is a light card, readable on the forest', cup && cup.bg === 'rgb(247, 244, 236)', cup && cup.bg);
  ok('its league labels are dark enough to read on it', cup && cup.flag === 'rgb(61, 61, 61)', cup && cup.flag);
}

ok('no script errors on the new home', errs.length === 0, errs.slice(0, 2).join(' | '));
await page.screenshot({ path: '/tmp/claude-0/-home-user-prizzequizz/8e7dbfdd-7716-52fe-a640-0feaacd6599f/scratchpad/home-real.png' });
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
