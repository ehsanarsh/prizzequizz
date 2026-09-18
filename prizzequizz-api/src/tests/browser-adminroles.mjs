/* A JOB, INSTEAD OF FIFTY TICKS — THE END SOMEBODY TOUCHES.
 *
 * Giving a new person access meant ticking more than fifty boxes, once, by
 * hand. And a screen added the month after reached NOBODY, because every
 * account was saved with the tab list that existed the day it was made.
 *
 * The rule only holds if the role is STORED and resolved per request. If the
 * panel expands the role into the account's own ticks at save time, everything
 * still looks right on screen and the new-screen problem comes straight back —
 * silently. That is the property most of this file is about, and it is checked
 * where it can actually break: in what the save sends.
 *
 * Rendered through the real renderAccounts(). A screen the test assembles
 * itself proves the markup and says nothing about whether anyone can reach it.
 *
 * Run: node src/tests/browser-adminroles.mjs */
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

/* The roles exactly as the server sends them — the panel is never allowed to
   carry its own copy of the tab lists. */
const ROLES = [
  { key: 'owner', label: 'مدیر کل', about: 'همه‌چیز', tabs: ['*'] },
  { key: 'support', label: 'پشتیبانی', about: 'تیکت‌ها', tabs: ['dashboard', 'support', 'tickets', 'qreports', 'users', 'matches'] },
  { key: 'finance', label: 'مالی', about: 'درخواست جایزه', tabs: ['dashboard', 'wallet', 'withdrawals', 'payments'] },
  { key: 'dev', label: 'برنامه‌نویس', about: 'خطاها', tabs: ['dashboard', 'errors', 'logs', 'monitoring'] }
];
const ROWS = [
  { id: 'a-owner', username: 'owner', role: 'owner', perms: ['*'], effective: ['*'], isOwner: true, active: true },
  { id: 'a-sup', username: 'sara', role: 'support', perms: [], effective: ['dashboard', 'support', 'tickets', 'qreports', 'users', 'matches'], isOwner: false, active: true },
  { id: 'a-none', username: 'legacy', role: null, perms: ['shop'], effective: ['shop'], isOwner: false, active: true }
];

async function open() {
  const seen = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    seen.push({ method: req.method(), url: req.url(), body: req.postData() || '' });
    let d = {};
    if (req.url().includes('/admin/accounts')) d = { rows: ROWS, tabs: [], roles: ROLES };
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
  await page.evaluate(() => (0, eval)('renderAccounts()'));
  await page.waitForTimeout(400);
  return { ctx, page, errs, seen };
}

/* ── 1. THE LIST SAYS WHAT EACH PERSON IS ───────────────────────────────── */
console.log('the accounts screen:');
{
  const { ctx, page, errs } = await open();
  const txt = await page.evaluate(() => document.querySelector('#main').innerText.replace(/\s+/g, ' '));
  ok('each account shows its job, not just its ticks', /پشتیبانی/.test(txt), txt.slice(0, 120));
  ok('an account with no job says so plainly', /بدون نقش/.test(txt), txt.slice(0, 160));

  /* THE TRAP THIS REPLACES. `perms` now holds only the extras, so a support
     account — whose extras are empty — would read as «—», i.e. as somebody
     with no access at all, if the screen still printed `perms`. */
  const row = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#main tbody tr')].find((t) => /sara/.test(t.innerText));
    return tr ? tr.innerText.replace(/\s+/g, ' ') : '';
  });
  ok('and the screens it can really open, not its empty extras list', /تیکت|پشتیبان/.test(row) && !/^sara پشتیبانی — /.test(row), row.slice(0, 140));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. PICKING A JOB ───────────────────────────────────────────────────── */
console.log('giving somebody a job:');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => (0, eval)('accEdit()'));
  await page.waitForTimeout(250);
  const opts = await page.evaluate(() => [...document.querySelectorAll('#ac_role option')].map((o) => o.value));
  ok('every job is offered', opts.includes('support') && opts.includes('dev'), JSON.stringify(opts));
  ok('except the owner, which is not something you hand out', !opts.includes('owner'), JSON.stringify(opts));
  ok('and «no job at all» stays possible', opts.includes(''), JSON.stringify(opts));

  await page.selectOption('#ac_role', 'support');
  await page.waitForTimeout(200);
  const marked = await page.evaluate(() => [...document.querySelectorAll('#ac_perms .permchk')]
    .filter((c) => c.disabled && c.checked).map((c) => c.value));
  ok('the job’s own screens are ticked and locked', marked.includes('support') && marked.includes('users'), JSON.stringify(marked));
  ok('and they are labelled as coming from the job', await page.evaluate(() => /از نقش/.test(document.querySelector('#ac_perms').innerText)));

  const free = await page.evaluate(() => [...document.querySelectorAll('#ac_perms .permchk')].filter((c) => !c.disabled).map((c) => c.value));
  ok('everything else is still offered as an extra', free.includes('shop') && !free.includes('support'), JSON.stringify(free.slice(0, 6)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. WHAT THE SAVE ACTUALLY SENDS ────────────────────────────────────── */
console.log('saving:');
{
  const { ctx, page, errs, seen } = await open();
  await page.evaluate(() => (0, eval)("accEdit('a-sup')"));
  await page.waitForTimeout(250);
  await page.selectOption('#ac_role', 'support');
  await page.waitForTimeout(200);
  /* One extra screen for this one person — the whole reason extras exist. */
  await page.evaluate(() => { const c = [...document.querySelectorAll('#ac_perms .permchk')].find((x) => x.value === 'shop'); c.checked = true; });
  seen.length = 0;
  await page.evaluate(() => (0, eval)("accSave('a-sup')"));
  await page.waitForTimeout(400);

  const patch = seen.find((r) => r.method === 'PATCH');
  ok('it patches the account', !!patch, JSON.stringify(seen.map((r) => r.method)));
  const body = patch ? JSON.parse(patch.body || '{}') : {};
  ok('the job is sent as a job', body.role === 'support', JSON.stringify(body));

  /* THE WHOLE POINT. A disabled checkbox still matches `:checked`, so without
     care the save copies every screen the role grants into the account's own
     ticks — the role stops meaning anything, and a screen added to it next
     month never reaches this person again. */
  ok('and the job is NOT copied into the account’s own ticks',
     Array.isArray(body.perms) && !body.perms.includes('support') && !body.perms.includes('users'), JSON.stringify(body.perms));
  ok('only the extra that was actually ticked is sent',
     Array.isArray(body.perms) && body.perms.includes('shop') && body.perms.length === 1, JSON.stringify(body.perms));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. CHANGING THE JOB KEEPS THE EXTRA ────────────────────────────────── */
console.log('changing somebody’s job:');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => (0, eval)('accEdit()'));
  await page.waitForTimeout(250);
  await page.selectOption('#ac_role', 'support');
  await page.waitForTimeout(150);
  await page.evaluate(() => { const c = [...document.querySelectorAll('#ac_perms .permchk')].find((x) => x.value === 'shop'); c.checked = true; });
  await page.selectOption('#ac_role', 'finance');
  await page.waitForTimeout(200);
  const state = await page.evaluate(() => ({
    extra: [...document.querySelectorAll('#ac_perms .permchk:checked:not(:disabled)')].map((c) => c.value),
    locked: [...document.querySelectorAll('#ac_perms .permchk:disabled')].map((c) => c.value)
  }));
  /* Somebody moving from support to finance does not lose the one extra screen
     that was a decision about THEM — retyping it is how it ends up forgotten. */
  ok('the extra survives the change', state.extra.includes('shop'), JSON.stringify(state.extra));
  ok('the new job’s screens are locked in', state.locked.includes('withdrawals'), JSON.stringify(state.locked));
  ok('and the old job’s screens are not', !state.locked.includes('tickets'), JSON.stringify(state.locked));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n[adminroles] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
