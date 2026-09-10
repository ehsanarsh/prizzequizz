/* THE TOP-UP THAT IS NOT THERE ANY MORE.
 *
 * The صندوق جایزه fills with prizes and nothing else. The server has refused a
 * deposit at the ledger itself for a while now — but the screen that offered
 * one was still in the page: a sheet with amount chips, a «شارژ سریع» card at
 * the top of the wallet, and a submit handler that added the amount to the
 * balance IN THE BROWSER and wrote a fake «شارژ صندوق جایزه» line into the
 * statement. `openTopup()` had been reduced to a toast and `submitTopup` was
 * overridden further down the file, so nothing happened when tapped — but the
 * markup, the chips, the state and the original handler were all still there,
 * waiting for someone to wire them back up.
 *
 * This is also exactly where the card-to-card payment page will live, so the
 * removal comes before the building, not after.
 *
 * What is checked: the page still runs (a 23,000-line file is easy to break
 * with a delete), nothing top-up survives in markup or globals, the wallet
 * still shows its other three cards, and removing one of four did not leave a
 * hole in the grid.
 *
 * Run: node src/tests/browser-topupgone.mjs
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); }
};

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 'test-token');
  localStorage.setItem('pz_rtok', 'test-rtoken');
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(1200);

/* A deleted chunk in a file this size shows up as a syntax error, and a syntax
 * error means NOTHING on the page runs. Check that first — every assertion
 * below would otherwise pass for the wrong reason. */
const syntax = errors.filter((m) => /SyntaxError|Unexpected token|is not defined/i.test(m));
ok('the page still parses and runs', syntax.length === 0, syntax.slice(0, 2).join(' | ') || 'no script errors');

const gone = await page.evaluate(() => ({
  sheet: !!document.getElementById('topupSheet'),
  bg: !!document.getElementById('topupBg'),
  chips: !!document.getElementById('topupAmounts'),
  input: !!document.getElementById('topupAmount'),
  openFn: typeof window.openTopup,
  submitFn: typeof window.submitTopup,
  selectFn: typeof window.selectTopupAmount,
  html: document.documentElement.innerHTML
}));

ok('the top-up sheet is gone from the markup', !gone.sheet && !gone.bg, `sheet=${gone.sheet} bg=${gone.bg}`);
ok('so are its amount chips and input', !gone.chips && !gone.input);
ok('and the handlers are not globals any more',
  gone.openFn === 'undefined' && gone.submitFn === 'undefined' && gone.selectFn === 'undefined',
  `open=${gone.openFn} submit=${gone.submitFn} select=${gone.selectFn}`);
ok('no «شارژ سریع» card is left anywhere', !gone.html.includes('شارژ سریع'));
ok('and no fake top-up line in the statement seed', !gone.html.includes("type:'topup'"));

/* The wallet markup is built at start-up, so it is in the DOM from the first
 * frame — but the wallet SCREEN is not the active one, so it has no layout and
 * pixel widths would all read zero. `grid-column` resolves from the cascade
 * either way, which is the thing actually being checked: that removing one of
 * four cards did not leave the last one sitting beside a hole. */
const grid = await page.evaluate(() => {
  const g = document.querySelector('.wallet-grid');
  if (!g) return null;
  const kids = [...g.querySelectorAll('.wallet-mini')];
  const last = kids[kids.length - 1];
  const cs = last ? getComputedStyle(last) : null;
  return {
    count: kids.length,
    labels: kids.map((k) => ((k.querySelector('b') || {}).textContent || '').trim()),
    lastSpansRow: !!cs && cs.gridColumnStart === '1' && cs.gridColumnEnd === '-1'
  };
});

ok('the wallet grid still renders', grid !== null);
if (grid) {
  ok('with the three cards that are left', grid.count === 3, grid.labels.join(' · '));
  ok('and no «شارژ» among them', !grid.labels.some((l) => l.includes('شارژ')));
  ok('an odd last card spans the row rather than leaving a gap', grid.lastSpansRow);
}

await browser.close();
server.close();
console.log(`[topupgone] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
