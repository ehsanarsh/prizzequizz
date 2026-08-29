/* THE HELPS ON THE QUESTION SCREEN.
 *
 * «رنگ کمکی‌ها در صفحه پخش سوال در همه مودهای بازی باید سبز یا زرد بشه و
 *  اندازه‌اش هم یکم کوچیک‌تر بشه چون بعضی مواقع بالاش می‌ره زیر گزینهٔ ۴.»
 *
 * Two complaints, and they are about the same row. It wore the card's own dark
 * tile with a grey label, so nothing on the screen said «these are yours to
 * spend»; and it was tall enough that on a phone the question card ran out of
 * room and the strip ended up pressed against the fourth answer.
 *
 * Every mode paints the same `.pu` tile — the duel and Last Survivor build it
 * from different code but style it from one place — so this drives BOTH and
 * asserts the same things about each, which is what «در همه مودهای بازی» means.
 *
 * Run: node src/tests/browser-lifelines.mjs */
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 110)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/** rgb(...) → [r,g,b]. */
const rgb = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
/* Green means green: the channel leads BOTH of the others by a clear margin.
   A looser rule («more green than blue») passes the warm grey the labels used
   to be — #B9B4A6 has more green in it than blue — which is exactly how a
   colour requirement gets quietly ignored. */
const looksGreen = ([r, g, b]) => g > r + 20 && g > b + 20;

/* ── LAST SURVIVOR ─────────────────────────────────────────────────────── */
const LS_SNAP = {
  room: { id: 'r1', status: 'running', phase: 'question', round: 3, totalRounds: 12, capacity: 20,
          grossPool: 800000, phaseEndsAt: Date.now() + 14000, serverNow: Date.now(), chatEnabled: true },
  question: { id: 'q1', round: 3, difficulty: 'medium',
              text: 'پایتخت کشور استرالیا کدام شهر است و چرا همان شهر انتخاب شد؟',
              options: ['سیدنی', 'ملبورن', 'کانبرا', 'بریزبن'] },
  me: { userId: 'u1', status: 'alive', units: 1, currentShare: 45000 },
  stats: { alive: 12, eliminated: 3, cashedOut: 1, remainingPot: 700000 },
  players: [{ userId: 'u1', status: 'alive', units: 1 }], votes: 0
};

const lsRow = await page.evaluate((s) => {
  window.__s = s;
  (0, eval)('lsWatching=false'); (0, eval)('lsEndShown=false'); (0, eval)('lsRoomId="r1"');
  (0, eval)('lsMyId="u1"'); (0, eval)('lsSnap=window.__s'); (0, eval)('lsLastKey=""');
  /* A stocked help and a spent one, side by side — the two states have to be
     told apart by more than opacity. */
  (0, eval)('pzLL').inv = { p5050: 2, psecond: 1, pstats: 0 };
  (0, eval)('lsPuUsed')['second'] = true;
  try { showScreen('lsGame'); } catch (e) {}
  (0, eval)('lsBuild')(window.__s);
  (0, eval)('lsLive')(window.__s);
  return true;
}, LS_SNAP);
await page.waitForTimeout(450);

const ls = await page.evaluate(() => {
  const slot = document.querySelector('#lsBody [data-ls-pwslot]');
  const tiles = slot ? [...slot.querySelectorAll('.pu')] : [];
  const live = tiles.find((t) => !t.classList.contains('disabled'));
  const spent = tiles.find((t) => t.classList.contains('disabled'));
  const opts = [...document.querySelectorAll('#lsOpts .ans')];
  const last = opts[opts.length - 1];
  const read = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const lbl = el.querySelector('.pu-l');
    return { bg: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor,
             label: lbl ? getComputedStyle(lbl).color : '',
             h: Math.round(el.getBoundingClientRect().height) };
  };
  return {
    count: tiles.length,
    live: read(live), spent: read(spent),
    rowTop: slot ? Math.round(slot.getBoundingClientRect().top) : 0,
    rowBottom: slot ? Math.round(slot.getBoundingClientRect().bottom) : 0,
    lastOptBottom: last ? Math.round(last.getBoundingClientRect().bottom) : 0,
    cardTop: (() => { const c = document.querySelector('#lsBody .ls-qcard'); return c ? Math.round(c.getBoundingClientRect().top) : 0; })(),
    vh: window.innerHeight
  };
});

console.log('Last Survivor — the question screen:');
ok('the row is on the card', ls.count === 3, String(ls.count) + ' tiles');
/* THE COLOUR. A tile you can spend is green; the label goes with it, because a
   grey label on a green tile is the same unreadable strip in a new coat. */
const liveBg = rgb((ls.live || {}).bg || ''); const liveLbl = rgb((ls.live || {}).label || '');
ok('an available help is green, not the card’s own dark tile', looksGreen(liveBg), ((ls.live || {}).bg || '').slice(0, 60));
ok('and its label is green too, not muted grey', looksGreen(liveLbl), (ls.live || {}).label);
/* AND THE TWO STATES DIFFER IN COLOUR. Opacity alone was the old answer and it
   is why a spent help and an available one read the same at a glance. */
ok('a spent help is not green', !looksGreen(rgb((ls.spent || {}).bg || '')), ((ls.spent || {}).bg || '').slice(0, 60));
ok('so «can use» and «cannot» are different colours, not one colour twice',
  String((ls.live || {}).bg) !== String((ls.spent || {}).bg));

/* THE SIZE. The number is not decoration: at 60px+ per tile the card ran off
   the top of a 390×844 phone, which is «بالاش می‌ره زیر گزینهٔ ۴». */
ok('the tile is short enough to leave the card room', ls.live.h <= 54, ls.live.h + 'px');
ok('the strip clears the last answer instead of sitting on it', ls.rowTop >= ls.lastOptBottom, ls.rowTop + ' vs ' + ls.lastOptBottom);
ok('and the whole card fits the phone', ls.cardTop >= 0 && ls.rowBottom <= ls.vh, 'top ' + ls.cardTop + ', bottom ' + ls.rowBottom + ' of ' + ls.vh);

/* ── THE DUEL / ARENA ROW ──────────────────────────────────────────────── */
/* Built by different code — renderPowerups() over [data-pwslot] — from the
   admin catalogue. One rule, so both rows must land on it. */
const duel = await page.evaluate(async () => {
  (0, eval)('pzLL').catalog = [
    { key: 'p5050', icon: '✂️', label: '۵۰:۵۰', seconds: 0, description: '' },
    { key: 'psecond', icon: '🔁', label: 'انتخاب دوم', seconds: 0, description: '' },
    { key: 'pstats', icon: '📊', label: 'درصد بقیه', seconds: 0, description: '' }
  ];
  (0, eval)('pzLL').inv = { p5050: 2, psecond: 1, pstats: 0 };
  (0, eval)('puUsed')['psecond'] = true;
  /* The duel row, not Last Survivor's: renderPowerups skips the seconds help
     while an LS room is open, so the room is cleared first. */
  (0, eval)('lsRoomId=null');
  try { showScreen('q-screen'); } catch (e) {}
  (0, eval)('renderPowerups')();
  await new Promise((r) => setTimeout(r, 250));
  const slot = document.querySelector('#q-screen [data-pwslot]');
  const tiles = slot ? [...slot.querySelectorAll('.pu')] : [];
  const live = tiles.find((t) => !t.classList.contains('disabled'));
  const spent = tiles.find((t) => t.classList.contains('disabled'));
  const read = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const lbl = el.querySelector('.pu-l');
    return { bg: cs.backgroundImage !== 'none' ? cs.backgroundImage : cs.backgroundColor,
             label: lbl ? getComputedStyle(lbl).color : '',
             h: Math.round(el.getBoundingClientRect().height) };
  };
  return { count: tiles.length, live: read(live), spent: read(spent) };
});

console.log('the duel — the same row, built by other code:');
ok('the row is painted', duel.count === 3, String(duel.count) + ' tiles');
ok('an available help is green here too', looksGreen(rgb((duel.live || {}).bg || '')), ((duel.live || {}).bg || '').slice(0, 60));
ok('with a green label', looksGreen(rgb((duel.live || {}).label || '')), (duel.live || {}).label);
ok('a spent help is not green', !looksGreen(rgb((duel.spent || {}).bg || '')), ((duel.spent || {}).bg || '').slice(0, 60));
ok('and the tile is the same short one', duel.live.h <= 54, duel.live.h + 'px');
/* One rule means one answer: if the two rows ever disagree, a player crossing
   from a duel to a room sees the helps change colour for no reason. */
ok('both modes agree, to the pixel and to the colour',
  duel.live.h === ls.live.h && String(duel.live.bg) === String(ls.live.bg),
  duel.live.h + 'px vs ' + ls.live.h + 'px');

console.log(`\n[lifelines] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
