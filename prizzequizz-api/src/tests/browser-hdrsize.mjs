/* THE MONEY, BIG ENOUGH TO READ — IN A HEADER THAT DOES NOT MOVE.
 *
 * «اندازهٔ مبلغ صندوق جایزه رو بزرگ کن با آیکون کیف، طوری که کامل خوانا بشه، و
 *  اندازهٔ بلیط‌ها رو هم بزرگ‌تر کن، بدون اینکه هدر ذره‌ای بزرگ‌تر بشه.»
 *
 * Two demands that pull against each other, so the test measures both halves.
 * The second half is not «is the header 180 pixels» — a number copied out of one
 * run and pasted into a test says nothing about why. What is checked is the
 * PROPERTY that makes it safe: the row's height does not depend on what is
 * written in it. A balance of nine digits, a ticket count of three, and the row
 * is the same height as when they were one — which is the only version of «does
 * not grow» that survives somebody actually earning money.
 *
 * Run: node src/tests/browser-hdrsize.mjs */
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
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { available: 0, locked: 0, tickets: {} } }) }));
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);
await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
await page.waitForTimeout(400);

/** Put a balance and a ticket count in the header and measure what happened. */
async function show(money, tks) {
  await page.evaluate(([m, t]) => {
    (0, eval)('wallet = ' + Number(m));
    (0, eval)('mTickets = ' + JSON.stringify(t));
    try { (0, eval)('updateWalletUI')(); } catch (e) {}
    try { (0, eval)('renderHeaderTickets')(); } catch (e) {}
  }, [money, tks]);
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const px = (e) => (e ? Math.round(e.getBoundingClientRect().height * 10) / 10 : null);
    const fs_ = (e) => (e ? Math.round(parseFloat(getComputedStyle(e).fontSize) * 10) / 10 : null);
    const row = document.querySelector('#home .pz-header .pzh-wallets');
    const pills = [...(row ? row.querySelectorAll('.pzh-pill') : [])];
    const mb = document.getElementById('hdrWallet');
    const tkb = document.querySelector('#hdrTickets .pzh-pill b');
    const icon = document.querySelector('#home .p-money .pzi');
    return {
      header: px(document.querySelector('#home .pz-header')),
      row: px(row),
      pills: pills.map(px),
      widest: Math.max(0, ...pills.map((p) => Math.round(p.getBoundingClientRect().width))),
      moneyFont: fs_(mb), moneyText: mb ? mb.textContent : '',
      moneyClipped: mb ? mb.scrollWidth > mb.clientWidth + 1 : null,
      ticketFont: fs_(tkb), ticketCount: document.querySelectorAll('#hdrTickets .pzh-pill').length,
      iconThere: !!icon, iconH: icon ? Math.round(icon.getBoundingClientRect().height) : 0
    };
  });
}

console.log('the header:');
const small = await show(0, { green: 1, blue: 0, red: 0 });

/* ── 1. BIG ENOUGH TO READ ──────────────────────────────────────────────── */
ok('the صندوق figure is big enough to read at a glance', small.moneyFont >= 15, small.moneyFont + 'px');
ok('and it is the largest number on the row — it is the one that is money',
   small.moneyFont > small.ticketFont, small.moneyFont + ' vs ' + small.ticketFont);
ok('the ticket figures grew too', small.ticketFont >= 14, small.ticketFont + 'px');
ok('the wallet icon is still beside the money', small.iconThere && small.iconH >= 12,
   small.iconThere ? small.iconH + 'px' : 'missing');

/* ── 2. AND THE HEADER DOES NOT MOVE ────────────────────────────────────── */
/* Not «is it 180px» — that is a number copied from one run. What matters is
   that the height does not depend on what is written in the row. */
const big = await show(999999999, { green: 128, blue: 999, red: 64 });
ok('a nine-digit balance does not make the header taller',
   big.header === small.header, small.header + ' → ' + big.header);
ok('nor three-digit ticket counts', big.row === small.row, small.row + ' → ' + big.row);
ok('and every pill in the row is exactly the row\'s height',
   big.pills.length > 0 && big.pills.every((h) => h === big.row),
   JSON.stringify(big.pills) + ' in ' + big.row);

/* The money must be READABLE, which means all of it is there — a figure cut off
   by its own pill is worse than a small one. */
ok('the whole figure is shown, not cut off', big.moneyClipped === false,
   big.moneyText + (big.moneyClipped ? ' (clipped)' : ''));
ok('it really is the long number', /۹۹۹٬۹۹۹٬۹۹۹/.test(big.moneyText), big.moneyText);

/* ── 3. ON A NARROW PHONE TOO ───────────────────────────────────────────── */
await page.setViewportSize({ width: 320, height: 720 });
await page.waitForTimeout(300);
const narrow = await show(999999999, { green: 128, blue: 999, red: 64 });
ok('a 320px phone does not get a taller header either',
   narrow.header <= small.header, small.header + ' → ' + narrow.header);
ok('and the figure is still whole', narrow.moneyClipped === false, narrow.moneyText);
ok('the row scrolls sideways rather than wrapping onto a second line',
   narrow.row === small.row, small.row + ' → ' + narrow.row);

ok('the page threw nothing', errs.length === 0, errs.join(' | ').slice(0, 140));

await browser.close(); server.close();
console.log(`[hdrsize] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
