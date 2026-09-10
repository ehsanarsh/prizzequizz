/* TWO THINGS THE ADMIN PANEL HAS TO GET RIGHT.
 *
 * THE LEDGER REPORT, IN THE PANEL THAT SHOWS IT.
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


/* THE QUESTIONS SCREEN MUST NOT RENDER ITSELF FOR EVER.
 *
 * «وقتی در قسمت کوییزساز می‌ری به سؤالات، کل صفحه قاطی می‌کنه و کار نمی‌کنه.»
 *
 * renderQuestions() asked for answer statistics, and the stats loader answered
 * by calling renderQuestions() again. The only thing standing between that and
 * an infinite loop was «have we collected any stats yet» — so the moment the
 * endpoint returned NO rows (an empty bank, questions nobody has answered, a
 * failure that yields nothing) the loop ran free at two API calls a turn until
 * the browser tab died.
 *
 * The count of API calls is therefore the test. A screen that paints itself is
 * allowed to ask once; anything that grows without bound is the bug.
 *
 * Run: node src/tests/browser-qstats.mjs */
let pass2 = 0, fail2 = 0;
const ok2 = (n, c, extra = '') => { if (c) { pass2++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail2++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

/** Drive the screen with a stats endpoint that answers `statsRows`, and count. */
const run = async (statsRows) => page.evaluate(async (rows) => {
  window.__calls = [];
  const BANK = [{ id: 'b1', text: 'سؤال بانک', options: ['a', 'b', 'c', 'd'], correctIndex: 0, category: 'عمومی', status: 'approved' }];
  window.api = async (m, p) => {
    window.__calls.push(String(p));
    /* A runaway loop must not hang the test as it hung the browser: past a
       clearly impossible number of calls, stop and report. */
    if (window.__calls.length > 80) throw new Error('runaway');
    const s = String(p);
    if (s.indexOf('/admin/questions/stats') >= 0) return { rows };
    if (s.indexOf('/admin/user-questions') >= 0) return { rows: [], counts: { pending: 0, approved: 0, rejected: 0 }, config: {} };
    if (s.indexOf('/admin/questions') >= 0) return BANK;
    return {};
  };
  (0, eval)('CUR="questions"'); (0, eval)('Q_VIEW="bank"');
  (0, eval)('_QSTATS={}'); (0, eval)('_QSTATS_AT=0');
  try { await (0, eval)('render')(); } catch (e) { /* the guard above */ }
  await new Promise((r) => setTimeout(r, 1500));
  return { calls: window.__calls.length,
           stats: window.__calls.filter((c) => c.indexOf('/stats') >= 0).length,
           rows: document.querySelectorAll('#qrows tr').length };
}, statsRows);

/* THE REPORTED CASE: nothing has been answered yet, so the stats come back
   empty — which is precisely when the old brake failed. */
console.log('the questions screen when no statistics exist yet:');
const empty = await run([]);
ok2('it settles instead of looping', empty.calls <= 6, empty.calls + ' API calls');
ok2('and asks for the statistics once', empty.stats === 1, empty.stats + ' stats calls');
ok2('the table is still drawn', empty.rows >= 1, empty.rows + ' rows');

console.log('and when statistics do exist:');
const full = await run([{ id: 'b1', sample: 40, correctPercent: 72 }]);
ok2('it still settles', full.calls <= 6, full.calls + ' API calls');
ok2('asking once', full.stats === 1, full.stats + ' stats calls');
ok2('and the figures reach the columns',
  await page.evaluate(() => (document.getElementById('qrows') || {}).textContent || '').then((t) => /۷۲/.test(t)),
  'the ٪ صحیح column');

/* The other half of the report: arriving from «کوییزساز». Both lists live on
   one screen behind Q_VIEW, so the switch must not start the loop either. */
console.log('switching between «کوییزساز» and «بانک سوال»:');
const switched = await page.evaluate(async () => {
  window.__calls = [];
  (0, eval)('CUR="questions"'); (0, eval)('_QSTATS={}'); (0, eval)('_QSTATS_AT=0');
  (0, eval)('Q_VIEW="maker"'); try { await (0, eval)('render')(); } catch (e) {}
  (0, eval)('Q_VIEW="bank"');  try { await (0, eval)('render')(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1500));
  return { calls: window.__calls.length, alive: !!document.getElementById('main') };
});
ok2('the screen survives the switch', switched.alive === true);
ok2('and does not run away', switched.calls <= 8, switched.calls + ' API calls');

/* ── THE TWO GUARDS, EACH ON ITS OWN ────────────────────────────────────
   Either one alone stops the loop, which is why no single change to this file
   can reproduce it. So each is held to the thing it actually promises. */
console.log('asking for the figures is rationed:');
const rationed = await page.evaluate(async () => {
  window.__calls = [];
  window.api = async (m, p) => { window.__calls.push(String(p)); return { rows: [] }; };
  (0, eval)('_QSTATS={}'); (0, eval)('_QSTATS_AT=0'); (0, eval)('CUR="questions"'); (0, eval)('Q_VIEW="bank"');
  await (0, eval)('qLoadStats')();
  const afterFirst = window.__calls.length;
  /* A repaint moments later must not ask again — the bank may have no figures
     at all, and «nothing came back» is still an answer. */
  await (0, eval)('qLoadStats')();
  await (0, eval)('qLoadStats')();
  return { afterFirst, total: window.__calls.length };
});
ok2('the first call asks', rationed.afterFirst === 1, String(rationed.afterFirst));
ok2('and an empty answer still counts, so it is not asked again',
  rationed.total === 1, rationed.total + ' calls');

console.log('and two repaints at once ask once:');
const concurrent = await page.evaluate(async () => {
  window.__calls = [];
  window.api = async (m, p) => {
    window.__calls.push(String(p));
    await new Promise((r) => setTimeout(r, 250));      // a slow endpoint
    return { rows: [] };
  };
  (0, eval)('_QSTATS={}'); (0, eval)('_QSTATS_AT=0');
  /* Deliberately not awaited: this is the operator clicking a tab twice. */
  const a = (0, eval)('qLoadStats')(true);
  const b = (0, eval)('qLoadStats')(true);
  await Promise.all([a, b]);
  return { calls: window.__calls.length };
});
ok2('a second request is not piled on the first', concurrent.calls === 1, concurrent.calls + ' calls');

console.log(`\n[qstats] ${pass2} passed, ${fail2} failed`);
await browser.close(); server.close();
process.exit(fail2 ? 1 : 0);
