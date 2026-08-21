/* THE STATS SCREEN, AND THE THREE SCREENS WITH NO WAY OUT.
 *
 *   «در قسمت آمار و ارقام تب روند با تمامی مخلفات داخلش حذف بشه، تب مودها هم
 *    حذف بشه، دکمه بروزرسانی حذف بشه، به جای دکمه دانلود که در بالای سمت چپ هست
 *    دکمه ضربدر قرمز باشه برای خروج، و پشت نوشته آمار و ارقام در بالا یه کارت
 *    باشه تا وقتی این صفحه رو اسکرول میکنی کلمات روی هم نیفتند.»
 *
 *   «در قسمت دوستان و فروشگاه و رنکینگ دکمه ضربدر قرمز باید باشه و دکمه + در
 *    دوستان باید حذف بشه چون یه دکمه افزودن داریم اونجا.»
 *
 * The overlap one is the reason this is a browser test and not a source scan:
 * it is a question about where two boxes are on the screen after a scroll, and
 * only a real layout can answer it.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

/* Real-shaped stats, including the per-mode table and recent matches the two
   deleted tabs used to draw — if anything still reads them, it shows here. */
const STATS = {
  matches: 24, wins: 15, winRate: 62, accuracy: 71, level: 7,
  totalPrize: 480000, bestPrize: 120000, weeklyPrize: 60000,
  last5: ['W', 'L', 'W', 'W', 'D'],
  perMode: [{ modeId: 'duel', played: 18, wins: 11, winRate: 61 }, { modeId: 'lastSurvivor', played: 6, wins: 4, winRate: 66 }],
  topTopics: [{ category: 'فوتبال', pct: 84, count: 40 }, { category: 'تاریخ', pct: 61, count: 22 }],
  recentMatches: [
    { modeId: 'duel', result: 'W', at: Date.now() - 3600_000 },
    { modeId: 'lastSurvivor', result: 'L', at: Date.now() - 7200_000 }
  ]
};

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 7, xp: 900 }));
  localStorage.setItem('pq_user_plan', 'premium');
});
await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (/\/users\/[^/]+\/stats$/.test(p)) return send(STATS);
  /* The session is refreshed from here on boot; answering with a body that has
     no id leaves the client with no user to ask stats for. */
  if (p === '/users/me') return send({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 7, xp: 900, balances: { wallet: 0 } });
  if (p === '/leaderboards/weekly') return send({ entries: [{ rank: 3, highlighted: true }] });
  if (p === '/friends') return send([]);
  if (p === '/friends/requests') return send({ incoming: [], outgoing: [] });
  return send({});
});
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
await page.goto('http://127.0.0.1:' + PORT + '/');
await page.waitForTimeout(5200);

/* ── 1. THE TABS THAT WENT ──────────────────────────────────────────────── */
console.log('the stats screen:');
await page.evaluate(async () => { (0, eval)("go('stats');"); try { await (0, eval)('pzHydrateStats')(); } catch (e) {} });
await page.waitForTimeout(900);

/* The summary must be showing the SERVER's numbers — otherwise «the page is not
   blank» could be satisfied by an empty template. */
ok('the stub reached the screen', await page.evaluate(() => (0, eval)('PLAYER_STATS').matches) === 24,
  String(await page.evaluate(() => (0, eval)('PLAYER_STATS').matches)));

const tabs = await page.evaluate(() => [...document.querySelectorAll('#statsTabs .stats-tab')].map((b) => ({ t: b.getAttribute('data-tab'), txt: b.textContent.trim() })));
ok('two tabs are left', tabs.length === 2, JSON.stringify(tabs));
ok('«روند» is gone', !tabs.some((x) => x.t === 'history' || /روند/.test(x.txt)), JSON.stringify(tabs.map((x) => x.txt)));
ok('«مودها» is gone', !tabs.some((x) => x.t === 'modes' || /مودها/.test(x.txt)), JSON.stringify(tabs.map((x) => x.txt)));
ok('«خلاصه» and «موضوعات» stay', tabs.map((x) => x.t).join(',') === 'overview,topics', tabs.map((x) => x.t).join(','));

/* «با تمامی مخلفات داخلش» — not just the tab button. */
const gone = await page.evaluate(() => ({
  modes: typeof (0, eval)('window.renderStatsModes'),
  hist: typeof (0, eval)('window.renderStatsHistory'),
  fnModes: (() => { try { (0, eval)('renderStatsModes'); return 'there'; } catch (e) { return 'gone'; } })(),
  fnHist: (() => { try { (0, eval)('renderStatsHistory'); return 'there'; } catch (e) { return 'gone'; } })(),
  state: (() => { const s = (0, eval)('PLAYER_STATS'); return { modes: 'modes' in s, history: 'history' in s }; })()
}));
ok('the modes view is gone with it', gone.fnModes === 'gone', gone.fnModes);
ok('and so is the timeline view', gone.fnHist === 'gone', gone.fnHist);
ok('nothing is kept for a screen that no longer exists',
  gone.state.modes === false && gone.state.history === false, JSON.stringify(gone.state));

/* Asking for a tab that no longer exists must not leave a blank page. */
await page.evaluate(() => (0, eval)('openStatsTab')('history'));
await page.waitForTimeout(300);
const afterOld = await page.evaluate(() => (document.getElementById('statsContent') || {}).textContent || '');
ok('an old tab name falls back to the summary rather than emptying the page',
  /مسابقه انجام‌شده/.test(afterOld) && /۲۴/.test(afterOld), afterOld.trim().slice(0, 60));
await page.evaluate(() => (0, eval)('openStatsTab')('overview'));
await page.waitForTimeout(300);

/* ── 2. THE BUTTONS ─────────────────────────────────────────────────────── */
const btns = await page.evaluate(() => {
  const bar = document.querySelector('#stats .topbar');
  const x = bar ? bar.querySelector('.iconbtn.ib-close') : null;
  const cs = x ? getComputedStyle(x) : null;
  return {
    refresh: !!document.querySelector('#stats [onclick*="refreshStats"]'),
    download: !!document.querySelector('#stats [onclick*="exportStatsReport"]'),
    share: !!document.querySelector('#stats [onclick*="shareStatsReport"]'),
    x: !!x, xText: x ? x.textContent.trim() : '',
    xColour: cs ? cs.backgroundImage + '|' + cs.backgroundColor : '',
    /* Left in RTL is the far side from the back arrow. */
    xOnLeft: x && bar ? (x.getBoundingClientRect().left < bar.getBoundingClientRect().left + 80) : false,
    back: !!bar?.querySelector('.iconbtn.ib-back')
  };
});
ok('the refresh button is gone', btns.refresh === false, String(btns.refresh));
ok('the download button is gone', btns.download === false, String(btns.download));
ok('sharing is still there', btns.share === true, String(btns.share));
ok('there is a ✕ in its place', btns.x === true && btns.xText === '✕', btns.xText);
ok('and it is red', /255,\s*122,\s*107|e5484d|229,\s*72,\s*77|#FF7A6B/i.test(btns.xColour), btns.xColour.slice(0, 70));
ok('sitting where the download button was, on the left', btns.xOnLeft === true, String(btns.xOnLeft));
ok('the back arrow is still on the other side', btns.back === true, String(btns.back));

/* Pressing it leaves the screen — a way OUT, not a decoration. */
await page.evaluate(() => document.querySelector('#stats .topbar .iconbtn.ib-close').click());
await page.waitForTimeout(500);
ok('pressing it leaves the stats screen',
  await page.evaluate(() => (document.querySelector('.screen.active') || {}).id) !== 'stats',
  await page.evaluate(() => (document.querySelector('.screen.active') || {}).id));

/* ── 3. THE TITLE, AFTER A SCROLL ───────────────────────────────────────── */
await page.evaluate(async () => { (0, eval)("go('stats');"); try { await (0, eval)('pzHydrateStats')(); } catch (e) {} });
await page.waitForTimeout(700);

const bar = await page.evaluate(() => {
  const b = document.querySelector('#stats .topbar');
  const cs = getComputedStyle(b);
  const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
  const parts = m ? m[1].split(',').map((x) => parseFloat(x)) : [];
  return { pos: cs.position, bg: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius,
           alpha: parts.length === 4 ? parts[3] : 1, img: cs.backgroundImage };
});
/* OPAQUE is the whole point: the old bar was a see-through gradient, so a card
   scrolling underneath it showed through the title. */
ok('the title bar has a card behind it', bar.bg !== 'rgba(0, 0, 0, 0)' && bar.bg !== 'transparent', bar.bg);
ok('and it is solid, not see-through', bar.alpha === 1, String(bar.alpha));
ok('with an edge of its own', parseFloat(bar.border) > 0 && parseFloat(bar.radius) > 0, bar.border + ' / ' + bar.radius);
ok('and it stays put while the page moves', bar.pos === 'sticky', bar.pos);

/* THE ACTUAL COMPLAINT: after scrolling, do the words sit on top of each other?
   Scroll the screen and check that nothing is drawn over the title's box. */
const overlap = await page.evaluate(async () => {
  const sc = document.getElementById('stats');
  sc.scrollTop = 0;
  const before = sc.scrollTop;
  sc.scrollTop = 400;
  await new Promise((r) => setTimeout(r, 320));
  const moved = sc.scrollTop > before;
  const h1 = sc.querySelector('.topbar h1');
  const r = h1.getBoundingClientRect();
  /* What is painted at the middle of the title, ignoring anything floating over
     the whole app (a toast, a modal veil)? The first thing INSIDE the stats
     screen at that point has to belong to the bar — if a card has scrolled up
     under a see-through bar, that card is what is there. */
  const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const inScreen = stack.find((el) => el.closest('#stats'));
  return { moved, scrollTop: sc.scrollTop,
           inBar: !!(inScreen && inScreen.closest('.topbar')),
           what: inScreen ? (inScreen.className || inScreen.tagName) : 'none',
           stack: stack.slice(0, 4).map((el) => el.className || el.tagName).join(' > ') };
});
ok('the page really scrolled', overlap.moved === true, String(overlap.scrollTop));
ok('and the title is still the thing you see there, not a card behind it', overlap.inBar === true, overlap.stack);
ok('no script errors', errs.length === 0, errs.join(' | '));

/* ── 4. THE THREE SCREENS WITH NO WAY OUT ───────────────────────────────── */
console.log('\nfriends, the shop and the rankings:');
for (const [id, name] of [['friends', 'دوستان'], ['shop', 'فروشگاه'], ['rankings', 'رنکینگ']]) {
  await page.evaluate((i) => (0, eval)("go('" + i + "');"), id);
  await page.waitForTimeout(450);
  const seen = await page.evaluate((i) => {
    const bar = document.querySelector('#' + i + ' .topbar');
    const x = bar ? bar.querySelector('.iconbtn.ib-close') : null;
    const cs = x ? getComputedStyle(x) : null;
    return {
      x: !!x, txt: x ? x.textContent.trim() : '',
      colour: cs ? cs.backgroundImage + '|' + cs.backgroundColor : '',
      plus: !!(bar && /＋|\+/.test(bar.textContent || '')),
      onScreen: !!x && x.getBoundingClientRect().width > 20
    };
  }, id);
  ok(name + ' has a way out', seen.x === true && seen.txt === '✕', seen.txt);
  ok('and it is red', /255,\s*122,\s*107|e5484d|229,\s*72,\s*77/i.test(seen.colour), seen.colour.slice(0, 60));
  ok('and big enough to hit', seen.onScreen === true, String(seen.onScreen));
  if (id === 'friends') {
    /* «دکمه + در دوستان باید حذف بشه چون یه دکمه افزودن داریم اونجا» */
    ok('the ＋ is gone from the friends bar', seen.plus === false, JSON.stringify(seen));
    const addTab = await page.evaluate(() => !!document.querySelector('#friends [onclick*="openFriendTab(\'add\')"]'));
    ok('and the add tab it duplicated is still there', addTab === true, String(addTab));
  }
  /* It has to actually go somewhere. */
  await page.evaluate((i) => document.querySelector('#' + i + ' .topbar .iconbtn.ib-close').click(), id);
  await page.waitForTimeout(450);
  ok('pressing it leaves ' + name,
    await page.evaluate(() => (document.querySelector('.screen.active') || {}).id) === 'home',
    await page.evaluate(() => (document.querySelector('.screen.active') || {}).id));
}
ok('no script errors', errs.length === 0, errs.join(' | '));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await ctx.close(); await browser.close(); server.close();
process.exit(fail ? 1 : 0);
