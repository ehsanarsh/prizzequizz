/* THE LEDGER REPORT, IN THE PANEL THAT SHOWS IT.
 *
 * «۲۸ حساب ۰ مغایرت — ولی وقتی مغایرت داشته باشه معلوم نیست کدوم حساب‌هاست و
 *  مغایرت برای چی هست.»
 *
 * The server has always sent the whole picture; the panel printed a count in a
 * toast and dropped the rest. What matters is therefore not what the API
 * returns — ledgerMismatch.test.ts holds that — but what an operator can read
 * off the screen after pressing the button. So this presses it.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'pzadmin.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/* Exactly the shape verifyConsistency returns, with both directions of gap. */
const REPORT = {
  checked: 28,
  mismatches: [
    { userId: 'aaaaaaaa-1111-4000-8000-000000000001', username: 'reza90', displayName: 'رضا محمدی', phone: '09121234567',
      account: { available: 107500, locked: 250 }, ledger: { available: 100000, locked: 0 },
      diff: { available: 7500, locked: 250 } },
    { userId: 'bbbbbbbb-2222-4000-8000-000000000002', username: 'sara', displayName: '', phone: '',
      account: { available: 40000, locked: 0 }, ledger: { available: 52500, locked: 0 },
      diff: { available: -12500, locked: 0 } }
  ]
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 120)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

/* Stub the one call the button makes; everything else is the real panel. */
await page.evaluate((report) => {
  window.__report = report;
  window.__toasts = [];
  const realToast = window.toast;
  window.toast = (m, k) => { window.__toasts.push({ m, k }); try { realToast && realToast(m, k); } catch (e) {} };
  window.__api = window.api;
  window.api = async (method, path2) => {
    if (String(path2).indexOf('/admin/wallet/consistency') >= 0) return window.__report;
    return {};
  };
}, REPORT);

console.log('when everything is in order:');
await page.evaluate(() => { window.__report = { checked: 28, mismatches: [] }; window.__toasts = []; });
await page.evaluate(() => (0, eval)('checkConsistency()'));
await page.waitForTimeout(400);
const clean = await page.evaluate(() => ({
  modal: !!document.querySelector('.modal-bg'),
  toast: (window.__toasts[0] || {}).m || '', kind: (window.__toasts[0] || {}).k || ''
}));
ok('it says so in a toast, with the count', /۲۸/.test(clean.toast) && /مغایرت/.test(clean.toast), clean.toast);
ok('and does not open a window with nothing in it', clean.modal === false);

console.log('when accounts are out of step:');
await page.evaluate((r) => { window.__report = r; window.__toasts = []; }, REPORT);
await page.evaluate(() => (0, eval)('checkConsistency()'));
await page.waitForTimeout(500);
const bad = await page.evaluate(() => {
  const bg = document.querySelector('.modal-bg');
  if (!bg) return { none: true };
  const txt = (bg.textContent || '').replace(/\s+/g, ' ');
  const rows = bg.querySelectorAll('tbody tr');
  return { none: false, txt, rows: rows.length,
           head: [...bg.querySelectorAll('th')].map((t) => t.textContent.trim()),
           buttons: bg.querySelectorAll('tbody button').length,
           onclicks: [...bg.querySelectorAll('tbody button')].map((b) => b.getAttribute('onclick')) };
});
ok('a report opens instead of a toast', bad.none === false, bad.none ? 'nothing opened' : bad.rows + ' rows');
ok('with one row per broken account', bad.rows === 2, String(bad.rows));
ok('it says how many of how many', /۲ حساب از ۲۸/.test(bad.txt || ''), (bad.txt || '').slice(0, 60));

console.log('what an operator can read off it:');
ok('WHO — by name', /رضا محمدی/.test(bad.txt) && /sara/.test(bad.txt));
ok('and by phone, for the one that has one', /۰۹۱۲۱۲۳۴۵۶۷/.test(bad.txt) || /09121234567/.test(bad.txt), 'phone');
ok('what the balance says', /۱۰۷٬۵۰۰/.test(bad.txt), 'account 107,500');
ok('what the ledger says', /۱۰۰٬۰۰۰/.test(bad.txt), 'ledger 100,000');
ok('the gap, as a figure', /۷٬۵۰۰/.test(bad.txt) && /۱۲٬۵۰۰/.test(bad.txt), 'both gaps');
ok('and its direction, so a windfall is not read as a shortfall',
  /\+۷٬۵۰۰/.test(bad.txt) && /−۱۲٬۵۰۰/.test(bad.txt), 'signs');
ok('the locked column is there too', bad.head.some((h) => /بلوکه/.test(h)), bad.head.join(' | '));

console.log('and what it explains:');
ok('it says what a mismatch actually is', /جمع.{0,12}دفترکل/.test(bad.txt) && /یکی نیست/.test(bad.txt), 'the definition');
ok('and which side is the authority', /دفترکل مرجع است/.test(bad.txt));

console.log('and where it can be taken next:');
ok('each row opens that account’s ledger', bad.onclicks.some((o) => /viewLedger\('aaaaaaaa/.test(o || '')), bad.onclicks[0] || '');
ok('and that account’s management screen', bad.onclicks.some((o) => /userDetail\('bbbbbbbb/.test(o || '')));

console.log(`\n[consistency] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
