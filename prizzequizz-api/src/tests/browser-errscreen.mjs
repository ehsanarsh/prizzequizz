/* THE QUEUE THE PROGRAMMERS ACTUALLY WORK.
 *
 * A crash-report screen that lists occurrences is unreadable the first time
 * anything loops: one bug fills it and every other bug is on page forty —
 * including the rare one that loses somebody's payment. So the unit here is the
 * BUG, not the occurrence, and the triage buttons work on the bug too, because
 * nobody is going to mark four thousand rows one at a time.
 *
 * Run: node src/tests/browser-errscreen.mjs */
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
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

const now = Date.now();
/* The second one carries a quote and a backslash ON PURPOSE. A fingerprint is a
   crash message with the digits removed — it can contain anything a programmer
   ever typed into a string — and pasting one into an onclick attribute is how a
   button silently stops working for exactly the crashes that matter. */
const GROUPS = [
  { fingerprint: 'typeerror: fit of undefined at line n', message: "TypeError: fit of undefined at lsPotHeroFit (index.html:4120)",
    count: 120, users: 41, firstAt: new Date(now - 6 * 3600e3).toISOString(), lastAt: new Date(now - 12 * 60e3).toISOString(),
    source: 'frontend', severity: 'error', appVersions: ['643'], sampleId: 's1', route: '/#lastsurvivor', stack: 'at fit (index.html:4120)' },
  { fingerprint: "cannot read 'x' of null \\ at a", message: "TypeError: cannot read 'x' of null \\ at pay",
    count: 3, users: 3, firstAt: new Date(now - 2 * 3600e3).toISOString(), lastAt: new Date(now - 90 * 60e3).toISOString(),
    source: 'backend', severity: 'fatal', appVersions: [], sampleId: 's2', route: '/v1/wallet/withdraw', stack: '' }
];
const DIAG = { open: 123, triaged: 4, resolved: 9, ignored: 1, fatal: 3, frontend: 120, backend: 3, last24h: 60, topMessages: [] };

async function open(groups = GROUPS) {
  const seen = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    seen.push({ method: req.method(), url: req.url(), body: req.postData() || '' });
    let d = {};
    if (req.url().includes('/admin/monitoring/groups')) d = { groups, diagnostics: DIAG };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.getElementById('login').classList.add('hidden');
    document.getElementById('shell').classList.remove('hidden');
  });
  /* Through the real router, not by calling renderErrors() directly: that is
     what proves the nav key reaches the screen, and it is what the status
     buttons themselves use when they re-render. */
  await page.evaluate(() => { (0, eval)("CUR='errors'"); return (0, eval)('render()'); });
  await page.waitForTimeout(500);
  return { ctx, page, errs, seen };
}

/* ── 1. WHAT A PROGRAMMER SEES ──────────────────────────────────────────── */
console.log('the error queue:');
{
  const { ctx, page, errs } = await open();
  const txt = await page.evaluate(() => document.querySelector('#main').innerText.replace(/\s+/g, ' '));
  ok('the crash is shown once, with how often it happened', /۱۲۰ بار/.test(txt), txt.slice(0, 200));
  ok('and how many different players hit it', /۴۱ بازیکن/.test(txt), txt.slice(0, 220));
  /* «only version 643» is the difference between «we have a bug» and a bug
     somebody can actually go and find. */
  ok('and which build it came from', /نسخهٔ ۶۴۳/.test(txt), txt.slice(0, 260));
  ok('and whether it was the game or the server', /سرور/.test(txt) && /بازی/.test(txt), txt.slice(0, 260));
  ok('and when it last happened, in words', /پیش/.test(txt), txt.slice(0, 260));
  ok('the message itself is there to read', /lsPotHeroFit/.test(txt), txt.slice(0, 300));
  ok('and where it happened', /lastsurvivor|wallet\/withdraw/.test(txt), txt.slice(0, 300));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. TRIAGE, BY BUG ──────────────────────────────────────────────────── */
console.log('marking one:');
{
  const { ctx, page, errs, seen } = await open();
  seen.length = 0;
  await page.evaluate(() => (0, eval)('errSet(0,"triaged")'));
  await page.waitForTimeout(400);
  const patch = seen.find((r) => r.method === 'PATCH');
  ok('it tells the server which bug and what happened to it', !!patch, JSON.stringify(seen.map((r) => r.method)));
  const b = patch ? JSON.parse(patch.body || '{}') : {};
  ok('by the group, not by one occurrence of it', b.fingerprint === GROUPS[0].fingerprint, JSON.stringify(b));
  ok('with the status that was pressed', b.status === 'triaged', JSON.stringify(b));
  await ctx.close();
}

/* ── 3. THE CRASH WHOSE TEXT FIGHTS THE MARKUP ──────────────────────────── */
console.log('a crash message containing a quote and a backslash:');
{
  const { ctx, page, errs, seen } = await open();
  seen.length = 0;
  /* Pressing the real button, not calling the function — the attribute is the
     thing under test. */
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#main .card')];
    const card = cards.find((c) => /of null/.test(c.innerText));
    [...card.querySelectorAll('button')].find((b) => b.textContent.includes('حل شد')).click();
  });
  await page.waitForTimeout(400);
  const patch = seen.find((r) => r.method === 'PATCH');
  ok('the button still works', !!patch, JSON.stringify(seen.map((r) => r.method)));
  const b = patch ? JSON.parse(patch.body || '{}') : {};
  ok('and the fingerprint arrives exactly as it was', b.fingerprint === GROUPS[1].fingerprint, JSON.stringify(b.fingerprint));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. AN EMPTY QUEUE IS NOT GOOD NEWS BY ITSELF ───────────────────────── */
console.log('when there is nothing in it:');
{
  /* This screen was empty for a completely different reason than «no crashes»:
     the game never posted one. Saying «all clear» would have been wrong for
     every day the pipe was disconnected. */
  const { ctx, page, errs } = await open([]);
  const txt = await page.evaluate(() => document.querySelector('#main').innerText.replace(/\s+/g, ' '));
  ok('it does not claim there are no bugs', /نمی‌فرستد/.test(txt), txt.slice(0, 220));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. THE OTHER STATUSES ARE REACHABLE ────────────────────────────────── */
console.log('looking at what was already dealt with:');
{
  const { ctx, page, errs, seen } = await open();
  seen.length = 0;
  await page.evaluate(() => {
    [...document.querySelectorAll('#main button')].find((b) => b.textContent.trim() === 'حل‌شده').click();
  });
  await page.waitForTimeout(500);
  const got = seen.find((r) => r.url.includes('status=resolved'));
  ok('the list can be switched to resolved', !!got, JSON.stringify(seen.map((r) => r.url.split('/v1')[1]).slice(0, 4)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n[errscreen] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
