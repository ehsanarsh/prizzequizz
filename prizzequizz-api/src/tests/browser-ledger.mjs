/* RIZ-E TRAKONESH-HA, ON THE SCREEN SOMEBODY OPENS.
 *
 * «در قسمت درگاه و یا مالی باید ریز تراکنش‌ها رو بتونم ببینم.»
 *
 * The finance screen has always shown totals. Totals are what you look at once
 * you already trust the rows underneath them — and there were no rows: the
 * ledger could be read one player at a time, and only if you already knew their
 * id.
 *
 * Three of the checks below are the difference between a screen that gets used
 * and one that gets opened once: the player's NAME rather than a uuid, totals
 * that describe the whole filter rather than the page, and an export that
 * carries the filters that are on screen.
 *
 * Run: node src/tests/browser-ledger.mjs */
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

const ROWS = [
  { id: 'e1', userId: 'u-reza', displayName: 'رضا محمدی', username: 'reza', phone: '09121111111',
    entryType: 'match_reward', kind: 'credit', amount: 50000, availableBefore: 0, availableAfter: 50000,
    refId: 'm-901', description: 'جایزهٔ مسابقه', createdAt: new Date(Date.now() - 3600e3).toISOString() },
  { id: 'e2', userId: 'u-reza', displayName: 'رضا محمدی', username: 'reza', phone: '09121111111',
    entryType: 'ticket_purchase', kind: 'debit', amount: 20000, availableBefore: 50000, availableAfter: 30000,
    refId: 't-77', description: 'خرید بلیط', createdAt: new Date(Date.now() - 1800e3).toISOString() },
  { id: 'e3', userId: 'u-sara', displayName: 'سارا کریمی', username: 'sara', phone: '09132222222',
    entryType: 'withdraw_lock', kind: 'lock', amount: 30000, availableBefore: 30000, availableAfter: 0,
    refId: 'w-12', description: 'رزرو برای دریافت', createdAt: new Date(Date.now() - 600e3).toISOString() }
];
/* Totals of EVERYTHING the filter matched, which is deliberately not the sum of
   the three rows on screen — a page-sum would agree by accident and the check
   would prove nothing. */
const TOTALS = { credit: 900000, debit: 410000, net: 490000, count: 128 };

async function open() {
  const seen = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    seen.push({ method: req.method(), url: req.url() });
    let d = {};
    if (req.url().includes('/admin/wallet/ledger')) d = { rows: ROWS, total: 128, page: 1, pageSize: 50, totals: TOTALS };
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
  /* Through the real router — that is what proves the nav key reaches a screen
     rather than the «در دست ساخت» placeholder. */
  await page.evaluate(() => { (0, eval)("CUR='ledger'"); return (0, eval)('render()'); });
  await page.waitForTimeout(500);
  return { ctx, page, errs, seen };
}
const body = (page) => page.evaluate(() => document.querySelector('#main').innerText.replace(/\s+/g, ' '));

/* ── 1. THE ROWS ────────────────────────────────────────────────────────── */
console.log('the itemised list:');
{
  const { ctx, page, errs } = await open();
  const txt = await body(page);
  ok('it is a real screen, not a placeholder', !/در دست ساخت/.test(txt), txt.slice(0, 80));
  ok('every player is in one list', /رضا محمدی/.test(txt) && /سارا کریمی/.test(txt), txt.slice(0, 200));
  /* A uuid is not a person: it cannot be matched against a ticket or a bank
     statement, which is the entire reason somebody opens this screen. */
  ok('and each row says who, not which uuid', !/u-reza/.test(txt), txt.slice(0, 200));
  ok('the username is there too, for looking someone up', /@reza/.test(txt), txt.slice(0, 220));
  ok('each movement says what it was, in Persian', /جایزهٔ مسابقه/.test(txt) && /خرید بلیط/.test(txt), txt.slice(0, 260));
  ok('and the balance it left behind', /۳۰٬۰۰۰|۳۰،۰۰۰/.test(txt), txt.slice(0, 300));

  const signs = await page.evaluate(() => [...document.querySelectorAll('#main tbody tr')].map((tr) => tr.children[4].textContent.trim().slice(0, 1)));
  ok('money in and money out are told apart at a glance', signs[0] === '+' && signs[1] === '−', JSON.stringify(signs));
  /* A lock leaves the spendable balance even though nothing has been paid out.
     Counting it as an inflow would make the screen disagree with the balance
     the player is looking at. */
  ok('and a reservation counts as money leaving', signs[2] === '−', JSON.stringify(signs));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE TOTALS ──────────────────────────────────────────────────────── */
console.log('the totals:');
{
  const { ctx, page, errs } = await open();
  const txt = await body(page);
  /* If these were computed from the page they would read 80,000 / 50,000. */
  ok('they are the server’s, over the whole filter', /۹۰۰٬۰۰۰|۹۰۰،۰۰۰/.test(txt), txt.slice(0, 300));
  ok('and the count is of everything matched, not of this page', /۱۲۸/.test(txt), txt.slice(0, 300));
  ok('and the screen says so out loud', /کلِ/.test(txt), txt.slice(0, 340));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE FILTERS REACH THE SERVER ────────────────────────────────────── */
console.log('narrowing it down:');
{
  const { ctx, page, errs, seen } = await open();
  seen.length = 0;
  await page.selectOption('#lg_type', 'match_reward');
  await page.waitForTimeout(400);
  let got = seen.filter((r) => r.url.includes('/admin/wallet/ledger')).pop();
  ok('a type is sent as a type', !!got && got.url.includes('type=match_reward'), got ? got.url.split('/v1')[1] : '(none)');

  seen.length = 0;
  await page.evaluate(() => { const e = document.querySelector('#lg_min'); e.value = '10000'; e.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(400);
  got = seen.filter((r) => r.url.includes('/admin/wallet/ledger')).pop();
  ok('and so is an amount floor, alongside it', !!got && got.url.includes('minAmount=10000') && got.url.includes('type=match_reward'),
     got ? got.url.split('/v1')[1] : '(none)');

  /* The row is the obvious place to ask «what else did this person do», and
     making somebody copy a uuid into a box instead is how the screen goes
     unused. */
  seen.length = 0;
  await page.evaluate(() => { document.querySelector('#main tbody tr a').click(); });
  await page.waitForTimeout(400);
  got = seen.filter((r) => r.url.includes('/admin/wallet/ledger')).pop();
  ok('and one tap on a name shows only that player', !!got && got.url.includes('userId=u-reza'), got ? got.url.split('/v1')[1] : '(none)');
  ok('with a visible way back out', /فقط این بازیکن/.test(await body(page)));

  /* NARROWING TAKES YOU BACK TO THE FIRST PAGE. Otherwise somebody on page
     nine filters down to two results, is left looking at an empty page nine,
     and reads it as «چیزی پیدا نشد» — the filter appears broken when it
     worked perfectly. */
  await page.evaluate(() => (0, eval)("lgSet('page',3)"));
  await page.waitForTimeout(400);
  seen.length = 0;
  await page.selectOption('#lg_kind', 'debit');
  await page.waitForTimeout(400);
  got = seen.filter((r) => r.url.includes('/admin/wallet/ledger')).pop();
  ok('and narrowing anything starts again from page one', !!got && /[?&]page=1(&|$)/.test(got.url),
     got ? got.url.split('/v1')[1] : '(none)');
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE EXPORT CARRIES THE FILTERS ──────────────────────────────────── */
console.log('the export:');
{
  const { ctx, page, errs, seen } = await open();
  await page.selectOption('#lg_kind', 'credit');
  await page.waitForTimeout(400);
  seen.length = 0;
  await page.evaluate(() => (0, eval)('lgCsv()'));
  await page.waitForTimeout(500);
  const got = seen.filter((r) => r.url.includes('/admin/wallet/ledger')).pop();
  ok('it asks for a file', !!got && got.url.includes('format=csv'), got ? got.url.split('/v1')[1] : '(none)');
  /* An export that silently ignores what is on screen hands back a different
     month than the one being looked at, and nobody notices until the numbers
     refuse to add up. */
  ok('for exactly what is on screen', !!got && got.url.includes('kind=credit'), got ? got.url.split('/v1')[1] : '(none)');
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. THE GATEWAY LIST, SAME COMPLAINT ────────────────────────────────── */
console.log('the gateway transactions:');
{
  const INTENTS = [
    { id: 'p1', userId: 'u-reza', displayName: 'رضا محمدی', username: 'reza', amount: 120000, provider: 'zarinpal',
      status: 'paid', providerReference: 'A-55', createdAt: new Date().toISOString(), metadata: {} },
    { id: 'p2', userId: 'u-sara', displayName: 'سارا کریمی', username: 'sara', amount: 40000, provider: 'zarinpal',
      status: 'failed', providerReference: '', createdAt: new Date().toISOString(), metadata: {} }
  ];
  const seen = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    seen.push({ url: req.url() });
    let d = {};
    if (req.url().includes('/admin/payments/intents')) d = INTENTS;
    else if (req.url().includes('/admin/payments/gateways')) d = { rows: [] };
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
  await page.evaluate(() => { (0, eval)("CUR='payments'"); (0, eval)("PAY_SUB='tx'"); return (0, eval)('render()'); });
  await page.waitForTimeout(600);
  const txt = await body(page);
  ok('it names the player who paid', /رضا محمدی/.test(txt), txt.slice(0, 200));
  ok('instead of eight characters of a uuid', !/u-reza/.test(txt), txt.slice(0, 200));
  ok('and says what came in successfully', /موفق/.test(txt), txt.slice(0, 240));

  seen.length = 0;
  await page.evaluate(() => { const i = document.querySelector('#ptxq'); i.value = 'سارا'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(900);
  ok('and it can be searched by that name', seen.some((r) => /q=/.test(r.url) && /intents/.test(r.url)),
     JSON.stringify(seen.map((r) => r.url.split('/v1')[1]).slice(0, 3)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n[ledger] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
