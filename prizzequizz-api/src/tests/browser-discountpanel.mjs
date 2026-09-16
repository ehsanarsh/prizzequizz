/* THE OPERATOR'S SIDE OF A DISCOUNT CODE.
 *
 * «و کد تخفیف هم باید باشه.»
 *
 * The rule this screen must never break: it writes a RULE, not a price. What
 * any given order comes to is the server's to work out — a discount arrived at
 * in a browser is a price arrived at by the person paying it. So what is
 * checked is what the panel SENDS, and that a date typed by a human reaches the
 * server as the moment that human meant.
 *
 * Run: node src/tests/browser-discountpanel.mjs */
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

const DAY = 86400000;
const rows = [
  { id: 'd1', code: 'Eid1404', kind: 'percent', value: 20, minAmount: 50000, maxDiscount: 20000,
    startsAt: 0, expiresAt: Date.now() + 5 * DAY, usageLimit: 100, perUserLimit: 1, usedCount: 7, enabled: true, note: 'کمپین عید', createdAt: Date.now() },
  { id: 'd2', code: 'OLD', kind: 'amount', value: 5000, minAmount: 0, maxDiscount: 0,
    startsAt: 0, expiresAt: Date.now() - DAY, usageLimit: 0, perUserLimit: 0, usedCount: 3, enabled: true, note: '', createdAt: Date.now() },
  { id: 'd3', code: 'FULL', kind: 'amount', value: 9000, minAmount: 0, maxDiscount: 0,
    startsAt: 0, expiresAt: 0, usageLimit: 10, perUserLimit: 1, usedCount: 10, enabled: true, note: '', createdAt: Date.now() },
  { id: 'd4', code: 'OFF', kind: 'percent', value: 10, minAmount: 0, maxDiscount: 0,
    startsAt: 0, expiresAt: 0, usageLimit: 0, perUserLimit: 1, usedCount: 0, enabled: false, note: '', createdAt: Date.now() }
];
const saved = [];
const deleted = [];

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === '127.0.0.1' && u.port === String(PORT)) return route.continue();
  const p = u.pathname.replace(/^.*\/v1/, '');
  const m = route.request().method();
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
  if (p === '/admin/discounts') {
    if (m === 'POST') { try { saved.push(JSON.parse(route.request().postData() || '{}')); } catch (e) {} return send({ id: 'new' }); }
    return send({ rows });
  }
  if (/^\/admin\/discounts\//.test(p)) { deleted.push(p.split('/').pop()); return send({ deleted: true }); }
  return send({});
});
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
page.on('dialog', (d) => d.accept());
await page.goto('http://127.0.0.1:' + PORT + '/pzadmin.html');
await page.waitForTimeout(900);
await page.evaluate(() => {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('shell').classList.remove('hidden');
  (0, eval)("API='https://stub.test/v1'; KEY='k'; PERMS=['*']; CUR='discounts';");
});
await page.evaluate(() => (0, eval)('renderDiscounts()'));
await page.waitForTimeout(600);

console.log('the discount screen:');
const table = () => page.evaluate(() => [...document.querySelectorAll('#main tbody tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));

{
  const t = await table();
  ok('every code is listed', t.length === 4, t.length + ' rows');
  ok('with what it is worth said in its own terms',
     /۲۰٪/.test(t[0]) && /تا سقف ۲۰٬۰۰۰/.test(t[0]), t[0].slice(0, 60));
  ok('a fixed-amount code says a mount, not a percentage', /۵٬۰۰۰ تومان/.test(t[1]), t[1].slice(0, 40));

  /* THE STATES, because «why is my code not working» is the question this
     screen exists to answer without anybody having to read a database. */
  ok('a live code says so', /فعال/.test(t[0]), t[0].slice(-30));
  ok('an expired one says expired, not «off»', /منقضی/.test(t[1]), t[1].slice(-30));
  ok('one that ran out says its capacity is gone', /ظرفیت تمام/.test(t[2]), t[2].slice(-30));
  ok('and one switched off says that', /خاموش/.test(t[3]), t[3].slice(-30));
  ok('how much of the capacity is used is shown', /۷ \/ ۱۰۰/.test(t[0]), t[0]);
  ok('and «no limit» is shown as such, not as zero', /۳ \/ ∞/.test(t[1]), t[1]);
}

/* ── MAKING ONE ─────────────────────────────────────────────────────────── */
{
  await page.evaluate(() => (0, eval)('dcEdit')(''));
  await page.waitForTimeout(300);
  await page.fill('#dc_code', 'nowruz-1405');
  await page.selectOption('#dc_kind', 'percent');
  await page.fill('#dc_value', '30');
  await page.fill('#dc_cap', '50000');
  await page.fill('#dc_min', '100000');
  await page.fill('#dc_cap_all', '500');
  await page.fill('#dc_per', '1');
  await page.fill('#dc_note', 'نوروز');
  /* A date a person typed, in their own clock. */
  await page.fill('#dc_to', '2026-03-25T23:59');
  await page.evaluate(() => (0, eval)('dcSave')(''));
  await page.waitForTimeout(500);

  ok('saving sends the code as typed', saved.length === 1 && saved[0].code === 'nowruz-1405', JSON.stringify(saved[0] || {}).slice(0, 80));
  ok('with the RULE, not a price',
     saved[0].kind === 'percent' && saved[0].value === 30 && saved[0].maxDiscount === 50000,
     JSON.stringify({ k: saved[0].kind, v: saved[0].value, cap: saved[0].maxDiscount }));
  ok('and the limits it was given', saved[0].usageLimit === 500 && saved[0].perUserLimit === 1 && saved[0].minAmount === 100000,
     JSON.stringify({ all: saved[0].usageLimit, per: saved[0].perUserLimit, min: saved[0].minAmount }));

  /* THE DATE. A box speaks the browser's local clock and the server counts in
     epoch milliseconds; getting that wrong makes a code that «ends at midnight»
     end at half past three, and nobody can see why from either side. */
  const wanted = new Date('2026-03-25T23:59').getTime();
  ok('a date typed by a person reaches the server as the moment they meant',
     Math.abs(saved[0].expiresAt - wanted) < 60000,
     new Date(saved[0].expiresAt).toString().slice(0, 24) + ' vs ' + new Date(wanted).toString().slice(0, 24));
  ok('and a date left empty is «never», not 1970', saved[0].startsAt === 0, String(saved[0].startsAt));
}

/* ── WHAT IT REFUSES TO SEND ────────────────────────────────────────────── */
{
  const before = saved.length;
  await page.evaluate(() => (0, eval)('dcEdit')(''));
  await page.waitForTimeout(300);
  await page.fill('#dc_code', 'BAD');
  await page.selectOption('#dc_kind', 'percent');
  await page.fill('#dc_value', '150');
  await page.evaluate(() => (0, eval)('dcSave')(''));
  await page.waitForTimeout(400);
  ok('a discount of more than 100% is not sent anywhere', saved.length === before, JSON.stringify(saved.slice(before)));

  await page.fill('#dc_value', '20');
  await page.fill('#dc_from', '2026-05-02T10:00');
  await page.fill('#dc_to', '2026-05-01T10:00');
  await page.evaluate(() => (0, eval)('dcSave')(''));
  await page.waitForTimeout(400);
  ok('nor a window that ends before it starts', saved.length === before, JSON.stringify(saved.slice(before)));
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach((m) => m.remove()));
}

/* ── A CEILING ONLY MEANS SOMETHING ON A PERCENTAGE ─────────────────────── */
{
  await page.evaluate(() => (0, eval)('dcEdit')(''));
  await page.waitForTimeout(300);
  await page.selectOption('#dc_kind', 'amount');
  await page.evaluate(() => (0, eval)('dcKindSync')());
  await page.waitForTimeout(200);
  const hidden = await page.evaluate(() => {
    const r = document.getElementById('dc_caprow');
    return { capShown: r ? r.style.display !== 'none' : true, label: (document.getElementById('dc_vlabel') || {}).textContent || '' };
  });
  ok('a fixed amount hides the ceiling, which could not change anything', !hidden.capShown);
  ok('and the value box says what it wants', /مبلغ/.test(hidden.label), hidden.label);
  await page.selectOption('#dc_kind', 'percent');
  await page.evaluate(() => (0, eval)('dcKindSync')());
  await page.waitForTimeout(200);
  const shown = await page.evaluate(() => ({
    capShown: document.getElementById('dc_caprow').style.display !== 'none',
    label: document.getElementById('dc_vlabel').textContent
  }));
  ok('a percentage brings it back', shown.capShown);
  ok('and asks for a percentage', /درصد/.test(shown.label), shown.label);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach((m) => m.remove()));
}

/* ── EDITING AND DELETING ───────────────────────────────────────────────── */
{
  await page.evaluate(() => (0, eval)('dcEdit')('d1'));
  await page.waitForTimeout(300);
  const f = await page.evaluate(() => ({
    code: document.getElementById('dc_code').value,
    locked: document.getElementById('dc_code').disabled,
    value: document.getElementById('dc_value').value,
    cap: document.getElementById('dc_cap').value,
    note: document.getElementById('dc_note').value
  }));
  ok('editing opens the code as it stands', f.code === 'Eid1404' && f.value === '20' && f.cap === '20000', JSON.stringify(f));
  ok('and the code itself cannot be retyped — that would be a different code', f.locked, String(f.locked));
  ok('its note comes back too', /عید/.test(f.note), f.note);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach((m) => m.remove()));

  await page.evaluate(() => (0, eval)('dcDelete')('d2', 'OLD'));
  await page.waitForTimeout(500);
  ok('deleting asks the server to delete that one', deleted.includes('d2'), JSON.stringify(deleted));
}

ok('the page threw nothing', errs.length === 0, errs.join(' | ').slice(0, 160));

await browser.close(); server.close();
console.log(`[discountpanel] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
