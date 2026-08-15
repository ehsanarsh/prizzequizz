/* THE MISSIONS SCREEN, REWORKED.
 *
 *   «روزانه سه ماموریت می‌دیم. اگه هر سه انجام شد یه جعبه جایزه می‌گیره و باید
 *    روی جعبه ضربه بزنه تا باز بشه. اگه انجام نده ماموریت‌ها عوض نمی‌شن، ۱۰ روز
 *    هم بگذره عوض نمی‌شن. هر ماموریت کاپ و ایکس پی داشته باشه.»
 *
 * Which missions are dealt, when they turn over and what the box holds are all
 * the server's, and tested there. This is the screen's half: that the three
 * are shown, that the box has three distinct faces, that it is a TAP that
 * opens it, and that it is only ever opened once.
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

const mission = (i, o = {}) => Object.assign({
  id: 'dl_3_' + i, kind: 'daily', metric: 'questionsAnswered', scope: '', target: 20,
  title: 'به ۲۰ سؤال جواب بده', description: '', icon: '❓', rarity: 'common', rarityLabel: '🟢 معمولی',
  rewards: [{ type: 'cup', amount: 6 }, { type: 'xp', amount: 64 }, { type: 'coins', amount: 96 }],
  enabled: true, minLevel: 3, maxLevel: 3, weight: 10, chainId: '', chainStep: 0,
  progress: 0, completed: false, claimed: false
}, o);

let board = null;
const opens = [];
let openReply = { period: '2026-08-14', rewards: [{ type: 'coins', amount: 300 }, { type: 'cup', amount: 15 }] };
let openFails = null;

function makeBoard(over = {}) {
  return Object.assign({
    daily: [mission(1), mission(2, { id: 'dl_3_2', title: '۳ مسابقه ببر', metric: 'matchesWon', target: 3 }),
            mission(3, { id: 'dl_3_3', title: '۴۰۰ XP بگیر', metric: 'xpEarned', target: 400 })],
    /* A weekly and an achievement really are in the payload — the server still
       keeps them — so «only the three dailies are shown» is a claim that can
       actually fail. With empty lists it could not. */
    weekly: [mission(9, { id: 'w_x', kind: 'weekly', title: '۳۰ مسابقه انجام بده', target: 30 })],
    achievements: [mission(8, { id: 'a_x', kind: 'achievement', title: 'اولین برد', target: 1 })],
    chain: null,
    resetsAt: { daily: Date.now() + 3600_000, weekly: Date.now() + 86_400_000 },
    dailyRotates: false, nextSetAt: 0,
    box: { period: '2026-08-14', done: 0, total: 3, ready: false, opened: false,
           title: 'جعبهٔ جایزهٔ روزانه', rewards: [{ type: 'coins', amount: 300 }, { type: 'cup', amount: 15 }] }
  }, over);
}

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/missions') return send(board);
    if (p === '/missions/box/open') {
      opens.push(Date.now());
      if (openFails) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: openFails, message: 'هنوز هر سه مأموریت امروز را کامل نکرده‌ای.', status: 422 } }) });
      return send(openReply);
    }
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

const openMissions = async (page) => {
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; missionActiveTab='daily'; go('missions'); renderMissions();"));
  await page.waitForTimeout(900);
  /* The screen shows its one-time tutorial in the same modal the box uses, so
     it is dismissed here — otherwise every assertion about that modal is
     really an assertion about the tutorial. */
  await page.evaluate(() => { try { (0, eval)('closeAaaModal(true)'); } catch (e) {} });
  await page.waitForTimeout(250);
};
const readScreen = (page) => page.evaluate(() => {
  const c = document.getElementById('missionsContent');
  const box = c.querySelector('.ms-box');
  return {
    cards: c.querySelectorAll('.mission-card').length,
    rewards: [...c.querySelectorAll('.mission-reward')].map((e) => e.textContent.trim()),
    box: box ? {
      cls: box.className, text: box.innerText.replace(/\s+/g, ' '),
      tag: (box.querySelector('.ms-box-tag') || {}).textContent || '',
      tappable: !!box.getAttribute('onclick'),
      bar: (box.querySelector('.ms-box-bar b') || {}).style?.width || ''
    } : null,
    note: (c.querySelector('.ms-box-note') || {}).textContent || ''
  };
});

/* ── 1. THREE, AND A BOX THAT IS NOT READY ──────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a fresh day:');
  board = makeBoard();
  await openMissions(page);
  const s = await readScreen(page);
  ok('three missions, not five', s.cards === 3, String(s.cards));
  /* And they are the DAILY three — not the dailies plus whatever else the
     server happened to send. */
  const titles = await page.evaluate(() => [...document.querySelectorAll('#missionsContent .mission-card b')].map((b) => b.textContent.trim()));
  ok('and the weekly pile is not among them', !titles.some((t) => /۳۰ مسابقه/.test(t)), JSON.stringify(titles));
  ok('nor the achievements', !titles.some((t) => /اولین برد/.test(t)), JSON.stringify(titles));
  /* «هر ماموریت کاپ و ایکس پی داشته باشه» — on the card, in Persian. */
  ok('each one shows its cup and its XP', s.rewards.every((r) => /کاپ/.test(r) && /XP/.test(r)), JSON.stringify(s.rewards));
  ok('the box is on the screen', !!s.box, '');
  ok('but locked, showing how far along the set is', /۰\/۳/.test(s.box.tag) && !/ready/.test(s.box.cls), s.box.tag + ' ' + s.box.cls);
  ok('and it cannot be tapped yet', !s.box.tappable, String(s.box.tappable));
  ok('it says what is inside before it opens', /۳۰۰ سکه/.test(s.box.text) && /۱۵ کاپ/.test(s.box.text), s.box.text.slice(0, 90));
  /* «تا انجام نده عوض نمی‌شن، ۱۰ روز هم بگذره عوض نمی‌شن» — said on the screen,
     because a player who comes back to the same three needs to know it is the
     rule and not a bug. */
  ok('and that the three do not change until they are done', /عوض نمی‌شوند/.test(s.note), s.note.slice(0, 60));

  /* «اونهمه دکمه روزانه و ماهانه و هفتگی و دکمه‌هایی که به درد نمی‌خورن باید
     حذف بشه» — the screen deals one set, so it shows one set. */
  const chrome = await page.evaluate(() => {
    const sec = document.getElementById('missions');
    const btns = [...sec.querySelectorAll('button')].filter((b) => b.offsetParent).map((b) => b.textContent.trim());
    return {
      tabs: sec.querySelectorAll('.mission-tab').length,
      tabBar: !!document.getElementById('missionTabs'),
      buttons: btns,
      stats: (document.getElementById('missionStats') || {}).innerText || ''
    };
  });
  ok('there are no daily/weekly/achievement tabs left', chrome.tabs === 0 && !chrome.tabBar, JSON.stringify(chrome.tabs));
  ok('and no «دریافت همه جوایز» or «بروزرسانی» buttons', !chrome.buttons.some((b) => /همه جوایز|بروزرسانی/.test(b)), JSON.stringify(chrome.buttons));
  /* The stats chip counted three hundred achievements before; now it counts
     the three on the screen. */
  /* «۰ از ۳» — three, not «۰ از ۵» with the weekly and the achievement in it. */
  ok('the chip counts the three, not the whole game', /۰ از ۳/.test(chrome.stats) && !/از ۵/.test(chrome.stats), chrome.stats.replace(/\n/g, ' '));
  ok('and says the three are frozen until they are done', /عوض نمی‌شوند/.test(chrome.stats), chrome.stats.replace(/\n/g, ' '));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 1b. THE 24-HOUR WAIT ───────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the day after finishing all three:');
  const b = makeBoard();
  b.daily.forEach((m) => { m.progress = m.target; m.completed = true; m.claimed = true; });
  b.box.done = 3; b.box.opened = true; b.dailyRotates = true;
  /* «وقتی انجام داد ۲۴ ساعت بعد ۳ تا دیگه فعال بشه» — the server says when. */
  b.nextSetAt = Date.now() + 5 * 3600_000 + 20 * 60_000;
  board = b;
  await openMissions(page);
  const s = await readScreen(page);
  /* Minutes tick while the page paints, so 5:20 may render as 5:19 — the shape
     is the assertion, not the second it was read. */
  ok('the wait is shown in hours and minutes', /۵ ساعت و [۰-۹]+ دقیقه/.test(s.note), s.note);
  const stats = await page.evaluate(() => (document.getElementById('missionStats') || {}).innerText || '');
  ok('and the chip counts it down too', /سه تای بعدی/.test(stats) && /۵ ساعت/.test(stats), stats.replace(/\n/g, ' '));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. TWO OF THREE ────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('two of the three done:');
  const b = makeBoard();
  b.daily[0].progress = 20; b.daily[0].completed = true;
  b.daily[1].progress = 3; b.daily[1].completed = true;
  b.box.done = 2;
  board = b;
  await openMissions(page);
  const s = await readScreen(page);
  ok('the box counts two of three', /۲\/۳/.test(s.box.tag), s.box.tag);
  ok('with the bar two thirds along', s.box.bar === '67%' || s.box.bar === '66%', s.box.bar);
  ok('still not tappable', !s.box.tappable, String(s.box.tappable));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. READY, AND OPENED BY A TAP ──────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('all three done:');
  opens.length = 0; openFails = null;
  const b = makeBoard();
  b.daily.forEach((m) => { m.progress = m.target; m.completed = true; });
  b.box.done = 3; b.box.ready = true; b.dailyRotates = true;
  board = b;
  await openMissions(page);
  const s = await readScreen(page);
  ok('the box says it is ready', /ready/.test(s.box.cls) && /آماده است/.test(s.box.text), s.box.text.slice(0, 60));
  ok('and asks to be tapped', s.box.tappable && /باز کن/.test(s.box.tag), s.box.tag);

  /* The box only opens on the tap — «کاربر باید روی جعبه ضربه بزنه تا باز بشه» —
     so nothing may have been paid before it. */
  ok('nothing was claimed just by looking at it', opens.length === 0, String(opens.length));

  /* After it opens the server says it is opened, and the screen repaints. */
  const after = await page.evaluate(async () => {
    document.querySelector('.ms-box').click();
    await new Promise((r) => setTimeout(r, 900));
    const m = document.getElementById('aaaModal');
    return { modal: !!m && m.classList.contains('show'), text: (m ? m.innerText : '').replace(/\s+/g, ' ') };
  });
  ok('one tap opens it', opens.length === 1, String(opens.length));
  ok('and the prize is shown', after.modal && /۳۰۰ سکه/.test(after.text) && /۱۵ کاپ/.test(after.text), after.text.slice(0, 80));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. A BOX ALREADY OPENED ────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('coming back after opening it:');
  opens.length = 0;
  const b = makeBoard();
  b.daily.forEach((m) => { m.progress = m.target; m.completed = true; m.claimed = true; });
  b.box.done = 3; b.box.ready = false; b.box.opened = true; b.dailyRotates = true;
  board = b;
  await openMissions(page);
  const s = await readScreen(page);
  ok('the box shows as taken', /opened/.test(s.box.cls) && /گرفتی/.test(s.box.tag), s.box.cls + ' ' + s.box.tag);
  ok('with what came out of it', /۳۰۰ سکه/.test(s.box.text), s.box.text.slice(0, 60));
  ok('and cannot be opened again', !s.box.tappable, String(s.box.tappable));
  await page.evaluate(async () => { document.querySelector('.ms-box').click(); await new Promise((r) => setTimeout(r, 500)); });
  ok('tapping it sends nothing', opens.length === 0, String(opens.length));
  /* Once the set is done, tomorrow is a new one — and only then. */
  ok('and it says nothing about tomorrow when there is no time yet', !/فردا/.test(s.note), s.note);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. THE SERVER STILL HAS THE LAST WORD ──────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a box the server refuses:');
  opens.length = 0; openFails = 'BOX_NOT_READY';
  const b = makeBoard();
  b.box.done = 3; b.box.ready = true;      // the screen believes it is ready…
  board = b;
  await openMissions(page);
  const shown = await page.evaluate(async () => {
    document.querySelector('.ms-box').click();
    await new Promise((r) => setTimeout(r, 900));
    const t = document.getElementById('pzToast');
    const m = document.getElementById('aaaModal');
    return { toast: t ? t.textContent : '', modal: !!m && m.classList.contains('show') };
  });
  ok('the refusal is passed on, in the server’s words', /کامل نکرده/.test(shown.toast), shown.toast);
  ok('and no celebration is shown', !shown.modal, String(shown.modal));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
