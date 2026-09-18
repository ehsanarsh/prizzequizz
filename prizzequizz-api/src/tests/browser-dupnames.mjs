/* THE GUARANTEE, SAID WHERE SOMEBODY CAN ACT ON IT.
 *
 * «کلا نباید سرور اجازه بده تا نام کاربری که وجود داره دوباره ساخته بشه.»
 *
 * The server already refuses one — at registration and at admin edit, folded so
 * «Nazi», «NAZI» and «na zi» are one name. What was missing is the layer under
 * that: the unique index, the only thing that can stop two saves of the same
 * free name in the same instant. It could not be created, because the table
 * already held the duplicates it exists to prevent, and the ONLY place that
 * said so was a line in the API's boot log.
 *
 * So this pins the panel end: the state is visible on the users screen, the
 * accounts in the way are named with enough to choose between them, and the fix
 * is one tap from the same card. Rendered through the real renderUsers() — a
 * card assembled by the test itself would prove the markup and say nothing
 * about whether it is ever on screen.
 *
 * Run: node src/tests/browser-dupnames.mjs */
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

/* The exact pair that is in the live table, as the server reports it. */
const PAIR = {
  folded: 'nazi', names: ['Nazi', 'NAZI'], count: 2,
  users: [
    { id: 'u-old', username: 'Nazi', displayName: 'ناظم', createdAt: new Date(Date.now() - 90 * 864e5).toISOString(), updatedAt: null, level: 4, xp: 1200, wallet: 180000, status: 'active', oldest: true },
    { id: 'u-new', username: 'NAZI', displayName: 'نازی', createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), updatedAt: null, level: 1, xp: 0, wallet: 0, status: 'active', oldest: false }
  ]
};

/* `dup` is what GET /admin/users/duplicates answers with. Every call records the
   requests it saw, so «the button did something» can be told apart from «the
   button called the right endpoint with the right body». */
async function open(dup) {
  const seen = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    const u = req.url();
    seen.push({ method: req.method(), url: u, body: req.postData() || '' });
    let d = {};
    if (u.includes('/admin/users/duplicates')) d = dup;
    else if (u.includes('/admin/users/username-index')) d = { indexReady: true, blockedBy: [] };
    else if (u.includes('/admin/users/table')) d = { rows: [], total: 0, sort: 'recent', dir: 'desc', tiers: ['green', 'blue', 'red'] };
    else if (u.includes('/admin/categories')) d = { categories: [] };
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
  /* THE REAL SCREEN. If the card is not wired into renderUsers() nothing below
     finds it, which is the point. */
  await page.evaluate(() => (0, eval)('renderUsers()'));
  await page.waitForTimeout(500);
  return { ctx, page, errs, seen };
}

const cardText = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#main .card')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' ¶ '));

/* ── 1. DUPLICATES PRESENT ──────────────────────────────────────────────── */
console.log('when two accounts hold the same name:');
{
  const { ctx, page, errs } = await open({ indexReady: false, groups: [PAIR], total: 2 });
  const txt = await cardText(page);
  ok('the users screen says so on its own', /نام کاربری تکراری/.test(txt), txt.slice(0, 80));
  ok('and both spellings are named', /Nazi/.test(txt) && /NAZI/.test(txt));
  ok('and it says the guarantee is off, not just that names clash',
     /ایندکس یکتا ساخته نمی‌شود|تضمین/.test(txt), txt.slice(0, 140));

  const marks = await page.evaluate(() => [...document.querySelectorAll('#main .card .pill.ok')].map((e) => e.textContent.trim()));
  ok('exactly one of the two is marked as having had it first', marks.length === 1 && marks[0] === 'قدیمی‌تر', JSON.stringify(marks));

  /* Enough to CHOOSE between them — a name and nothing else is not a decision. */
  ok('each side shows what would be lost by renaming it', /سطح/.test(txt) && /XP/.test(txt) && /ساخته‌شده/.test(txt), txt.slice(0, 200));

  const btns = await page.evaluate(() => [...document.querySelectorAll('#main .card button')].map((b) => b.textContent.trim()));
  ok('and each account can be renamed from right here', btns.filter((b) => b === 'تغییر نام').length === 2, JSON.stringify(btns));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE RENAME ACTUALLY GOES SOMEWHERE ──────────────────────────────── */
console.log('renaming one of them:');
{
  const { ctx, page, errs, seen } = await open({ indexReady: false, groups: [PAIR], total: 2 });
  await page.evaluate(() => { window.prompt = () => 'nazi-2'; });
  await page.evaluate(() => (0, eval)("uDupRename('u-new','NAZI')"));
  await page.waitForTimeout(400);
  const patch = seen.find((r) => r.method === 'PATCH' && /\/admin\/users\/u-new$/.test(new URL(r.url).pathname));
  ok('it patches that one account', !!patch, JSON.stringify(seen.filter((r) => r.method === 'PATCH').map((r) => r.url.split('/v1')[1])));
  ok('with the new name and nothing else', !!patch && JSON.parse(patch.body || '{}').username === 'nazi-2', patch ? patch.body : '');

  /* Cancelling must not rename anybody — a prompt dismissed by mistake is the
     most likely way this gets used wrongly. */
  seen.length = 0;
  await page.evaluate(() => { window.prompt = () => null; });
  await page.evaluate(() => (0, eval)("uDupRename('u-old','Nazi')"));
  await page.waitForTimeout(300);
  ok('and a cancelled prompt renames nobody', !seen.some((r) => r.method === 'PATCH'), JSON.stringify(seen.map((r) => r.method)));

  /* The same name back is not a change, and must not be sent as one. */
  seen.length = 0;
  await page.evaluate(() => { window.prompt = () => 'Nazi'; });
  await page.evaluate(() => (0, eval)("uDupRename('u-old','Nazi')"));
  await page.waitForTimeout(300);
  ok('nor does typing the same name again', !seen.some((r) => r.method === 'PATCH'), JSON.stringify(seen.map((r) => r.method)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. NOTHING IN THE WAY, AND THE INDEX IS ON ─────────────────────────── */
console.log('when the guarantee is in place:');
{
  const { ctx, page, errs } = await open({ indexReady: true, groups: [], total: 0 });
  const txt = await cardText(page);
  ok('it says so plainly', /تکراری ممکن نیست/.test(txt), txt.slice(0, 80));
  ok('and says it is the database, not a check in the code', /پایگاه داده/.test(txt), txt.slice(0, 120));
  ok('and offers nothing to fix', !/تغییر نام/.test(txt));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. NOTHING IN THE WAY, AND THE INDEX IS STILL MISSING ──────────────── */
console.log('when nothing is in the way but the index is gone:');
{
  /* A restored dump, or an index dropped by hand. There are no duplicates to
     rename, so a screen that only listed duplicates would show nothing at all
     and the guarantee would stay off for ever. */
  const { ctx, page, errs, seen } = await open({ indexReady: false, groups: [], total: 0 });
  const txt = await cardText(page);
  ok('it does not pretend everything is fine', /فعال نیست/.test(txt), txt.slice(0, 90));
  seen.length = 0;
  await page.evaluate(() => (0, eval)('uDupFixIndex()'));
  await page.waitForTimeout(400);
  const post = seen.find((r) => r.method === 'POST' && /username-index$/.test(new URL(r.url).pathname));
  ok('and the button asks the server to create it', !!post, JSON.stringify(seen.map((r) => r.method + ' ' + r.url.split('/v1')[1])));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. THE SERVER SAID NOTHING ─────────────────────────────────────────── */
console.log('when the server does not answer at all:');
{
  /* An older API that has no such endpoint. The users screen must still be the
     users screen — a missing card is not a broken page. */
  const { ctx, page, errs } = await open(null);
  const has = await page.evaluate(() => !!document.querySelector('#urows') && !!document.querySelector('#uq'));
  ok('the users screen is still there', has);
  const txt = await cardText(page);
  ok('and nothing is claimed either way', !/تکراری ممکن نیست/.test(txt) && !/فعال نیست/.test(txt), txt.slice(0, 90));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n[dupnames] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
