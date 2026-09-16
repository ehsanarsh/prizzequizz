/* THE USERS SCREEN, DRIVEN IN A BROWSER.
 *
 * «باید تعداد بلیط‌های کاربر رو ببینم که هر کدوم چنتا داره… بتونم sort کنم طبق
 *  کیف پول، طبق بلیط سبز و آبی و قرمز، طبق بیشترین خرید، طبق تعداد برد و باخت،
 *  و هر موضوع کیا خوب زدن.»
 *
 * The claim under test is not «the table has columns». It is that clicking a
 * column ASKS THE SERVER for that order — over every account — instead of
 * rearranging the hundred rows that happen to be on screen. So the stub records
 * the query string of every request the panel makes, and the checks are about
 * what was ASKED FOR, not about what came back.
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
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

/* Three accounts, built so that no two orderings agree. `sara` is the richest
   and holds the most BLUE tickets; `nima` holds the most GREEN ones and has
   spent the most; `kian` has the best record on «فوتبال» and the most gold. */
const USERS = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', phone: '09120000001', username: 'sara', displayName: 'سارا',
    plan: 'free', role: 'user', status: 'active', level: 9, xp: 4200, weeklyScore: 30, wallet: 900000, coins: 120, hearts: 3,
    tickets: { green: 1, blue: 40, red: 0 }, ticketTotal: 41, spent: 0, played: 1, wins: 1, losses: 0, winRate: 100,
    invited: 2, invitesRewarded: 1, createdAt: Date.now() },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', phone: '09120000002', username: 'nima', displayName: 'نیما',
    plan: 'free', role: 'user', status: 'active', level: 4, xp: 800, weeklyScore: 5, wallet: 500000, coins: 0, hearts: 3,
    tickets: { green: 20, blue: 0, red: 0 }, ticketTotal: 20, spent: 300000, played: 4, wins: 3, losses: 1, winRate: 75,
    invited: 0, invitesRewarded: 0, createdAt: Date.now() },
  { id: 'cccccccc-3333-4333-8333-333333333333', phone: '09120000003', username: 'kian', displayName: 'کیان',
    plan: 'free', role: 'user', status: 'banned', level: 1, xp: 10, weeklyScore: 0, wallet: 10, coins: 7, hearts: 0,
    tickets: { green: 0, blue: 0, red: 3, gold: 2 }, ticketTotal: 5, spent: 1000000, played: 2, wins: 0, losses: 2, winRate: 0,
    invited: 0, invitesRewarded: 0, createdAt: Date.now() }
];
const TIERS = ['green', 'blue', 'red', 'bronze', 'silver', 'gold'];
const TOPIC_RATES = { sara: [1, 1, 100], nima: [4, 1, 25], kian: [2, 2, 100] };

const asked = [];          /* every /admin/users/table request, as parsed query */
let plainListCalls = 0;

const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
  if (u.hostname === '127.0.0.1' && u.port === String(PORT)) return route.continue();
  const p = u.pathname.replace(/^.*\/v1/, '');
  if (p === '/admin/users/table') {
    const q = Object.fromEntries(u.searchParams.entries());
    asked.push(q);
    const topic = q.topic || '';
    const rows = USERS.map((x) => {
      const r = { ...x };
      if (topic) { const t = TOPIC_RATES[x.username]; r.topicTotal = t[0]; r.topicCorrect = t[1]; r.topicRate = t[2]; }
      return r;
    });
    /* The stub does NOT sort. Any ordering the screen shows that the server was
       not asked for would be the browser doing it to one page — the exact bug
       this screen exists to remove. */
    return send({ rows, total: 342, sort: q.sort || 'recent', dir: q.dir || 'desc', tiers: TIERS });
  }
  if (p === '/admin/users') { plainListCalls++; return send([]); }
  if (p === '/admin/online-config') return send({ size: 10, refreshCost: 5, freeRefreshesPerDay: 1 });
  if (p === '/admin/config') return send({ version: '1.0.0', categories: [
    { name: 'فوتبال', icon: '⚽', enabled: true, order: 1 },
    { name: 'تاریخ', icon: '📜', enabled: true, order: 2 }
  ] });
  return send({});
});
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
await page.goto('http://127.0.0.1:' + PORT + '/pzadmin.html');
await page.waitForTimeout(900);
/* The panel opens on its login screen; the screen under test is inside the
   shell, and an element that is not laid out cannot be clicked. */
await page.evaluate(() => {
  document.getElementById('login').classList.add('hidden');
  document.getElementById('shell').classList.remove('hidden');
});
await page.evaluate(() => (0, eval)(
  "API='https://stub.test/v1'; KEY='k'; PERMS=['*']; CUR='users';" +
  "CFG={version:'1.0.0',categories:[{name:'فوتبال',icon:'⚽',enabled:true,order:1},{name:'تاریخ',icon:'📜',enabled:true,order:2}]};"));
await page.evaluate(() => (0, eval)('renderUsers()'));
await page.waitForTimeout(700);

const head = () => page.evaluate(() => [...document.querySelectorAll('#uhead th')].map((t) => t.innerText.trim()));
const cell = (user, col) => page.evaluate(([u, c]) => {
  const tr = [...document.querySelectorAll('#urows tr')].find((r) => r.innerText.includes(u));
  if (!tr) return null;
  const ths = [...document.querySelectorAll('#uhead th')].map((t) => t.innerText.trim().replace(/[▼▲]/g, '').trim());
  const i = ths.indexOf(c);
  return i < 0 ? null : (tr.children[i] ? tr.children[i].innerText.trim() : null);
}, [user, col]);
const clickTh = async (label) => {
  await page.evaluate((l) => {
    const th = [...document.querySelectorAll('#uhead th')].find((t) => t.innerText.trim().replace(/[▼▲]/g, '').trim() === l);
    if (th) th.click();
  }, label);
  await page.waitForTimeout(350);
};
const SARA = 'سارا', NIMA = 'نیما', KIAN = 'کیان';
const last = () => asked[asked.length - 1] || {};

/* ── 1. WHAT THE SCREEN ASKS FOR AT ALL ─────────────────────────────────── */
console.log('the users screen:');
ok('it asks the table endpoint, not the plain list', asked.length > 0 && plainListCalls === 0,
   'table=' + asked.length + ' list=' + plainListCalls);

const bare = (a) => a.map((h) => h.replace(/[▼▲]/g, '').trim());
const cols = await head();
ok('every ticket colour has a column of its own',
   ['سبز', 'آبی', 'قرمز'].every((c) => cols.some((h) => h.replace(/[▼▲]/g, '').trim() === c)), JSON.stringify(cols));
ok('and so does the total', cols.some((h) => /جمع بلیط/.test(h)));
ok('a tier nobody on this page holds stays off the table',
   !cols.some((h) => /برنز|نقره/.test(h)), JSON.stringify(cols.filter((h) => /برنز|نقره|طلا/.test(h))));
ok('but one somebody DOES hold gets a column', cols.some((h) => /طلا/.test(h)));
/* Counted rather than named: a percentage column is only meaningful once a
   topic has been chosen, so with none chosen there is exactly one — the win
   rate. A second one under any label at all is a column of numbers about a
   topic nobody asked for. */
const pct = (a) => bare(a).filter((h) => h.indexOf('٪') === 0);
ok('and no topic column until a topic is chosen', pct(cols).length === 1, JSON.stringify(pct(cols)));

ok('the ticket counts are the ones on the account',
   (await cell(SARA, 'آبی')) === '۴۰' && (await cell(NIMA, 'سبز')) === '۲۰' && (await cell(KIAN, 'قرمز')) === '۳',
   [await cell(SARA, 'آبی'), await cell(NIMA, 'سبز'), await cell(KIAN, 'قرمز')].join(' / '));
ok('a colour a player has none of reads as nothing, not as a zero',
   (await cell(SARA, 'قرمز')) === '—', String(await cell(SARA, 'قرمز')));

ok('money spent is a column, and it is not the wallet',
   (await cell(KIAN, 'خرید')) === '۱٬۰۰۰٬۰۰۰' && (await cell(KIAN, 'صندوق جایزه')) === '۱۰',
   (await cell(KIAN, 'خرید')) + ' / ' + (await cell(KIAN, 'صندوق جایزه')));
ok('wins and losses are both there', (await cell(NIMA, 'برد')) === '۳' && (await cell(NIMA, 'باخت')) === '۱',
   (await cell(NIMA, 'برد')) + ' / ' + (await cell(NIMA, 'باخت')));
ok('and the record as a percentage', (await cell(NIMA, '٪ برد')) === '۷۵٪', String(await cell(NIMA, '٪ برد')));

/* ── 2. THE ORDER IS ASKED OF THE SERVER ────────────────────────────────── */
console.log('sorting:');
await clickTh('صندوق جایزه');
ok('clicking the wallet column asks the server for that order',
   last().sort === 'wallet' && last().dir === 'desc', JSON.stringify(last()));
ok('and it starts again at the first page', last().offset === '0', String(last().offset));

await clickTh('صندوق جایزه');
ok('clicking it again turns it round', last().sort === 'wallet' && last().dir === 'asc', JSON.stringify(last()));
const marked = await page.evaluate(() => {
  const th = [...document.querySelectorAll('#uhead th.on')].map((t) => t.innerText.trim());
  return th;
});
ok('and the column says which way it is pointing', marked.length === 1 && /▲/.test(marked[0]), JSON.stringify(marked));

await clickTh('خرید');
ok('«most spent» is its own question', last().sort === 'spent' && last().dir === 'desc', JSON.stringify(last()));

await clickTh('آبی');
ok('a ticket colour sorts by THAT colour',
   last().sort === 'ticket' && last().tier === 'blue', JSON.stringify(last()));
await clickTh('سبز');
ok('and a different colour by a different one',
   last().sort === 'ticket' && last().tier === 'green', JSON.stringify(last()));
await clickTh('جمع بلیط');
ok('while the total is not any one of them', last().sort === 'tickets', JSON.stringify(last()));

await clickTh('برد');
ok('the number of wins can be ordered by', last().sort === 'wins', JSON.stringify(last()));
await clickTh('٪ برد');
ok('and the win RATE separately', last().sort === 'winRate', JSON.stringify(last()));
await clickTh('باخت');
ok('and losses too', last().sort === 'losses', JSON.stringify(last()));

/* ── 3. «کیا فوتبال رو خوب زدن» ─────────────────────────────────────────── */
console.log('a topic:');
await page.selectOption('#utopic', 'فوتبال');
await page.waitForTimeout(400);
ok('picking a topic asks for it, and orders by it',
   last().topic === 'فوتبال' && last().sort === 'topic' && last().dir === 'desc', JSON.stringify(last()));
const cols2 = await head();
ok('a column for that topic appears',
   cols2.some((h) => /٪ فوتبال/.test(h)) && pct(cols2).length === 2, JSON.stringify(pct(cols2)));
ok('showing the rate and how many were answered',
   /۲۵٪/.test(String(await cell(NIMA, '٪ فوتبال'))) && /۴/.test(String(await cell(NIMA, '٪ فوتبال'))),
   String(await cell(NIMA, '٪ فوتبال')));

await page.selectOption('#utopic', '');
await page.waitForTimeout(400);
const cols3 = await head();
/* Compared against the table as it stood BEFORE the topic was picked, not just
   searched for the topic's name: a column left behind under some other label is
   still a column of numbers about a topic nobody asked for. */
ok('and goes away again when no topic is chosen',
   JSON.stringify(bare(cols3)) === JSON.stringify(bare(cols)) && pct(cols3).length === 1,
   JSON.stringify(pct(cols3)));
ok('without leaving the screen ordered by a column that is gone',
   last().sort !== 'topic' && !last().topic, JSON.stringify(last()));

/* ── 4. THE WHOLE TABLE, NOT THIS PAGE ──────────────────────────────────── */
console.log('paging:');
const pager = await page.evaluate(() => (document.getElementById('upager') || {}).innerText || '');
ok('the pager says how many accounts there are in total', /۳۴۲/.test(pager), pager.replace(/\s+/g, ' '));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#upager button')].find((x) => /بعدی/.test(x.innerText));
  if (b) b.click();
});
await page.waitForTimeout(400);
ok('«بعدی» asks for the next hundred', last().offset === '100', JSON.stringify(last()));
ok('and keeps the ordering it was on', last().sort === asked[asked.length - 2].sort, last().sort);

/* Standing on page two and then choosing a new ordering must go back to the
   top: page two of the new order is a stretch of the middle of the list, which
   looks from the outside like the sort did nothing at all. */
await clickTh('خرید');
ok('and a fresh ordering starts again from the top of the list',
   last().sort === 'spent' && last().offset === '0', JSON.stringify(last()));

/* ── 5. NOTHING ELSE BROKE ──────────────────────────────────────────────── */
ok('the page threw nothing', errs.length === 0, errs.join(' | ').slice(0, 160));
const rowText = (name) => page.evaluate((n) => {
  const tr = [...document.querySelectorAll('#urows tr')].find((r) => r.innerText.includes(n));
  return tr ? tr.innerText : '';
}, name);
const acts = await rowText(SARA);
ok('the existing actions are still on every row', /مدیریت/.test(acts) && /حذف/.test(acts), acts.replace(/\s+/g, ' ').slice(0, 90));
ok('and a banned account still says so', /banned/.test(await rowText(KIAN)));

await browser.close(); server.close();
console.log(`[usertable] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
