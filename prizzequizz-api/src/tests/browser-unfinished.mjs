/* HALF-OPEN DOORS, TOLD APART FROM PLAYERS.
 *
 * «مشکل ثبت نام کاربر با نام بازیکن جدید و user_1789659165304 بازم هست در پنل
 *  مدیریت من این اسامی رو میبینم.»
 *
 * The live database answered: of 103 accounts, 10 still carry the game's own
 * placeholder name, and none of them lost anything. An account is created the
 * MOMENT the SMS code is verified — before a name is ever asked for — so
 * everyone who got a code and closed the app left a row behind. Four of them
 * even played, which is the hole `_pzGateRegister` now closes.
 *
 * What is left is the thing actually being looked at: ten rows sitting in the
 * users list among real players, indistinguishable. They are not deleted —
 * a row is somebody's phone number and their history — they are LABELLED, and
 * they can be filtered out or looked at on their own.
 *
 * Run: node src/tests/browser-unfinished.mjs */
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

/* The shapes the live table really holds, as the server marks them. */
const ROWS = [
  { id: 'aaaaaaaa-1', username: 'ehsan', displayName: 'احسان رستمی', phone: '09121111111', unfinished: false, level: 5, xp: 900, wallet: 250000, coins: 100, tickets: { green: 2, blue: 0, red: 0 }, ticketTotal: 2, spent: 250000, played: 12, wins: 5, losses: 7, winRate: 42, invited: 0, createdAt: Date.now() - 9e8 },
  { id: 'bbbbbbbb-2', username: 'sara_k', displayName: 'سارا کریمی', phone: '09122222222', unfinished: false, level: 3, xp: 400, wallet: 0, coins: 50, tickets: { green: 0, blue: 1, red: 0 }, ticketTotal: 1, spent: 0, played: 4, wins: 1, losses: 3, winRate: 25, invited: 0, createdAt: Date.now() - 8e8 },
  { id: 'cccccccc-3', username: 'user_1789659165304', displayName: 'بازیکن جدید', phone: '09123333333', unfinished: true, level: 1, xp: 0, wallet: 0, coins: 350, tickets: { green: 0, blue: 0, red: 0 }, ticketTotal: 0, spent: 0, played: 3, wins: 0, losses: 3, winRate: 0, invited: 0, createdAt: Date.now() - 6e9 },
  { id: 'dddddddd-4', username: 'user_1789659165999', displayName: 'بازیکن جدید', phone: '09124444444', unfinished: true, level: 1, xp: 0, wallet: 0, coins: 350, tickets: { green: 0, blue: 0, red: 0 }, ticketTotal: 0, spent: 0, played: 0, wins: 0, losses: 0, winRate: 0, invited: 0, createdAt: Date.now() - 6e9 }
];

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let d = {};
    if (u.includes('/admin/users/table')) d = { rows: ROWS, total: ROWS.length, sort: 'recent', dir: 'desc', tiers: ['green', 'blue', 'red'] };
    else if (u.includes('/admin/categories')) d = { categories: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  /* THE PANEL BOOTS ON ITS LOGIN SCREEN — without revealing the shell the
     markup reads fine and nothing is clickable. */
  await page.evaluate(() => {
    document.getElementById('login').classList.add('hidden');
    document.getElementById('shell').classList.remove('hidden');
  });
  await page.evaluate((rows) => {
    window._UALL = rows;
    (0, eval)('U_ROWS_TOTAL=' + rows.length);
    document.getElementById('main').innerHTML =
      '<div class="toolbar"><input id="uq" value=""><select id="ushow" onchange="uShowPick(this.value)">' +
      ['all', 'done', 'unfinished'].map((k) => '<option value="' + k + '">' + k + '</option>').join('') +
      '</select><span class="note" id="uqnote"></span></div>' +
      '<div class="tbl-wrap"><table><thead><tr id="uhead"></tr></thead><tbody id="urows"></tbody></table></div><div id="upager"></div>';
    (0, eval)('uPaintHead()'); (0, eval)('uPaintRows()');
  }, ROWS);
  await page.waitForTimeout(250);
  return { ctx, page, errs };
}

const shown = (page) => page.evaluate(() => [...document.querySelectorAll('#urows tr')].map((tr) => ({
  text: tr.innerText.replace(/\s+/g, ' ').trim().slice(0, 40),
  badge: !!tr.querySelector('.pill.pend'),
  visible: tr.getBoundingClientRect().height > 0
})));
const noteText = (page) => page.evaluate(() => (document.getElementById('uqnote') || {}).textContent || '');
const pick = async (page, v) => { await page.selectOption('#ushow', v); await page.waitForTimeout(250); };

console.log('the users list:');
{
  const { ctx, page, errs } = await open();
  let r = await shown(page);
  ok('every account is listed to begin with', r.length === 4, r.length + ' rows');
  ok('and every row is really drawn', r.every((x) => x.visible));

  /* THE POINT: an operator can tell them apart without reading the name. */
  const badged = r.map((x, i) => (x.badge ? i : -1)).filter((i) => i >= 0);
  ok('the unfinished sign-ups are marked', JSON.stringify(badged) === '[2,3]', JSON.stringify(badged));
  ok('and real players are not', !r[0].badge && !r[1].badge);
  ok('the count is said out loud', /۲ ثبت‌نام ناتمام/.test(await noteText(page)), await noteText(page));

  await pick(page, 'done');
  r = await shown(page);
  ok('«ثبت‌نام کامل» hides them', r.length === 2 && r.every((x) => !x.badge), r.length + ' rows');
  ok('and keeps the real players', /احسان/.test(r[0].text) && /سارا/.test(r[1].text), r.map((x) => x.text).join(' | '));
  /* Still counted while hidden — otherwise filtering them away is also how you
     forget they exist. */
  ok('they are still counted while hidden', /۲ ثبت‌نام ناتمام/.test(await noteText(page)), await noteText(page));

  await pick(page, 'unfinished');
  r = await shown(page);
  ok('«ثبت‌نام ناتمام» shows only them', r.length === 2 && r.every((x) => x.badge), r.length + ' rows');

  await pick(page, 'all');
  r = await shown(page);
  ok('and «همه» brings everyone back', r.length === 4, r.length + ' rows');

  /* NOT DELETED. A row is somebody's phone number and their history; a filter
     must never be the thing that throws those away. */
  ok('nothing was removed from the data', await page.evaluate(() => window._UALL.length) === 4);
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\nsearching inside a filter:');
{
  const { ctx, page } = await open();
  await pick(page, 'done');
  await page.evaluate(() => { (0, eval)("U_Q='احسان'"); (0, eval)('uPaintRows()'); });
  await page.waitForTimeout(200);
  const r = await shown(page);
  /* The two rules are AND, not one replacing the other — a search inside
     «ثبت‌نام کامل» must not quietly bring an unfinished row back. */
  ok('the search and the filter both apply', r.length === 1 && /احسان/.test(r[0].text), r.map((x) => x.text).join(' | '));

  await page.evaluate(() => { (0, eval)("U_Q='بازیکن'"); (0, eval)('uPaintRows()'); });
  await page.waitForTimeout(200);
  const r2 = await shown(page);
  /* NOT «no rows»: an empty table draws one row of its own saying so, and
     counting that as data made this fail on behaviour that was correct. What
     matters is that the searched-for unfinished account is not among them. */
  ok('and a search cannot reach past the filter',
    !r2.some((x) => /بازیکن|user_/.test(x.text)), r2.map((x) => x.text).join(' | '));
  ok('the table says it found nothing, rather than going blank',
    r2.length === 1 && /پیدا نشد/.test(r2[0].text), r2.map((x) => x.text).join(' | '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n[unfinished] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
