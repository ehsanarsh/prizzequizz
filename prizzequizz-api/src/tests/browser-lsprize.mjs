/* THE PRIZE NOBODY KNOWS UNTIL SOMEBODY GOES OUT.
 *
 * «در قسمت آخرین بازمانده تا لحظهٔ حذف مبلغ جایزه رو کسی ندونه، یعنی جایزه با
 *  اولین حذفی نمایش داده بشه، عین فیلم بازی مرکب: در موقع هر حذف عدد بزرگ نوشته
 *  بشه و با حذف‌های بیشتر بزرگ‌تر بشه، و در انتها آروم آروم وایسته و سه بار
 *  چشمک بزنه و پنجرهٔ ادامه یا برداشت بیاد، و بعد از ادامه همون عدد سوال قبلی
 *  بیاد و با هر حذف مبلغ بزرگ‌تر بشه.»
 *
 * The part that is easy to get wrong is not the animation — it is the leak. A
 * figure that is masked by lsLive but printed by the builder is on screen for a
 * frame, and one frame is enough. So this checks the built markup as well as
 * the painted screen, on every screen that carries the pot.
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
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

const POT = 740000;
const snap = (elim, phase) => ({
  room: { id: 'r1', status: 'running', phase, round: elim + 1, totalRounds: 12, capacity: 20,
          grossPool: POT, phaseEndsAt: Date.now() + 30000, serverNow: Date.now(), chatEnabled: true },
  me: { userId: 'u1', status: 'alive', units: 1, currentShare: 120000, decisionThisRound: null },
  stats: { alive: 20 - elim, eliminated: elim, cashedOut: 0, remainingPot: POT },
  players: [{ userId: 'u1', status: 'alive', units: 1 }], votes: 0
});
async function paint(s) {
  await page.evaluate((x) => {
    window.__s = x;
    (0, eval)('lsWatching=false'); (0, eval)('lsEndShown=false'); (0, eval)('lsRoomId="r1"');
    (0, eval)('lsMyId="u1"'); (0, eval)('lsSnap=window.__s'); (0, eval)('lsLastKey=""');
    try { showScreen('lsGame'); } catch (e) {}
    (0, eval)('lsBuild')(window.__s); (0, eval)('lsLive')(window.__s);
  }, s);
  await page.waitForTimeout(300);
}

console.log('before anybody is out:');
await page.evaluate(() => { try { (0, eval)('lsPotReset()'); } catch (e) {} });
await paint(snap(0, 'dashboard'));
const dark = await page.evaluate((pot) => {
  const el = document.getElementById('lsRemain');
  const body = document.getElementById('lsBody');
  const fa = (0, eval)('lsFa')(pot);
  return { txt: el ? el.textContent : '(none)', leaks: (body.textContent || '').includes(fa), fa };
}, POT);
ok('the prize is not a number yet', dark.txt === '؟؟؟', dark.txt);
ok('and it is nowhere else on the screen either', dark.leaks === false, 'looking for ' + dark.fa);

/* The BUILDER must not print it either — masking it a frame later is a leak. */
const built = await page.evaluate((pot) => {
  const s = window.__s;
  const fa = (0, eval)('lsFa')(pot);
  const strip = (0, eval)('lsDashStrip')(s);
  const cells = (0, eval)('lsDashCells')(s);
  const mini = (0, eval)('lsDashHtml')(s, true);
  return { strip: strip.includes(fa), cells: cells.includes(fa), mini: mini.includes(fa),
           masked: strip.includes('؟؟؟') && cells.includes('؟؟؟') && mini.includes('؟؟؟') };
}, POT);
ok('the strip does not print it', built.strip === false);
ok('the dashboard cells do not print it', built.cells === false);
ok('the elimination mini-board does not print it', built.mini === false);
ok('all three show the mask instead', built.masked);

console.log('the first elimination turns the lights on:');
/* Read in the SAME turn that fires it: the climb is 2.2s long, so anything
   that waits first is reading the middle of it and not the start. */
const hero1 = await page.evaluate(() => {
  window.__s.stats.eliminated = 1; window.__s.stats.alive = 19;
  (0, eval)('lsLive')(window.__s);
  const h = document.getElementById('lsPotHero');
  if (!h) return { none: true };
  const num = h.querySelector('.lph-num');
  return { none: false, k: h.style.getPropertyValue('--lph-k'), fs: getComputedStyle(num).fontSize,
           start: num.textContent, w: Math.round(num.getBoundingClientRect().width) };
});
ok('the big number arrives in the middle of the screen', hero1.none === false, hero1.none ? 'no hero' : hero1.start);
ok('and it opens on nothing, so the whole pot is seen arriving', hero1.start === '۰', hero1.start);
ok('it fits the screen', hero1.w <= 390, hero1.w + 'px');

/* It climbs, turns green, blinks three times, and only then flies home. */
await page.waitForTimeout(2600);
const green = await page.evaluate((pot) => {
  const h = document.getElementById('lsPotHero');
  if (!h) return { gone: true };
  const num = h.querySelector('.lph-num');
  const cs = getComputedStyle(num);
  return { gone: false, txt: num.textContent, want: (0, eval)('lsFa')(pot),
           green: h.classList.contains('lph-green'), anim: cs.animationName,
           count: cs.animationIterationCount };
}, POT);
ok('it climbs to the real figure', green.txt === green.want, green.txt + ' vs ' + green.want);
ok('turns green', green.green === true);
ok('and blinks exactly three times', green.anim === 'lphBlink' && green.count === '3', green.anim + ' × ' + green.count);

await page.waitForTimeout(2800);
const landed = await page.evaluate((pot) => ({
  hero: !!document.getElementById('lsPotHero'),
  small: (document.getElementById('lsRemain') || {}).textContent,
  want: (0, eval)('lsFa')(pot)
}), POT);
ok('then it goes home', landed.hero === false);
ok('and the small figure has the number now', landed.small === landed.want, landed.small + ' vs ' + landed.want);

console.log('every elimination is louder than the last:');
const sizes = [];
for (const n of [2, 5, 9]) {
  const got = await page.evaluate((e) => {
    (0, eval)('lsPotReset()');
    window.__s.stats.eliminated = 0; (0, eval)('lsLive')(window.__s);
    window.__s.stats.eliminated = e; window.__s.stats.alive = 20 - e;
    window.__s.stats.remainingPot = 740000 + e * 1000;
    (0, eval)('lsLive')(window.__s);
    const h = document.getElementById('lsPotHero');
    const num = h && h.querySelector('.lph-num');
    return { k: h ? Number(h.style.getPropertyValue('--lph-k')) : 0,
             fs: num ? parseFloat(getComputedStyle(num).fontSize) : 0,
             w: num ? Math.round(num.getBoundingClientRect().width) : 0 };
  }, n);
  sizes.push({ n, ...got });
  await page.waitForTimeout(150);
}
ok('the number grows with the body count', sizes[0].fs < sizes[1].fs && sizes[1].fs < sizes[2].fs,
  sizes.map((x) => x.n + '→' + x.fs + 'px').join('  '));
ok('but never off the edge of the phone', sizes.every((x) => x.w <= 390), sizes.map((x) => x.w).join(','));
ok('and the growth is capped, not unbounded', sizes[2].k <= 1.55, 'k=' + sizes[2].k);

console.log('the continue/withdraw sheet comes after the announcement, not over it:');
/* The loop above left an announcement mid-flight; it has to finish before this
   can ask what happens when nothing is being announced. */
await page.waitForFunction(() => !document.getElementById('lsPotHero'), null, { timeout: 12000 });
const order = await page.evaluate(() => {
  const s = window.__s;
  const drop = () => { const c = document.getElementById('lsCashPop'); if (c) c.remove(); };

  /* With nothing being announced, the sheet goes up the moment the phase asks
     for it — the delay must be about the announcement, not about the sheet. */
  (0, eval)('lsPotReset()'); drop();
  s.room.phase = 'cashout'; s.stats.eliminated = 0; s.me.decisionThisRound = null;
  (0, eval)('lsLive')(s); (0, eval)('lsOverlays')(s);
  const before = !!document.getElementById('lsCashPop');

  /* THE REAL ORDER: somebody goes out, the number is announced, and only then
     does the room reach the cash-out phase. */
  (0, eval)('lsPotReset()'); drop();
  s.room.phase = 'elimination'; s.stats.eliminated = 0;
  (0, eval)('lsLive')(s);
  s.stats.eliminated = 1; s.stats.alive = 19;
  (0, eval)('lsLive')(s);                       // the announcement starts
  s.room.phase = 'cashout';
  (0, eval)('lsOverlays')(s);                   // and the sheet asks to go up
  return { before, hero: !!document.getElementById('lsPotHero'), sheet: !!document.getElementById('lsCashPop') };
});
ok('the sheet is there when nothing is being announced', order.before === true);
ok('the announcement is running', order.hero === true);
ok('and the sheet is held back while it runs', order.sheet === false);

await page.waitForTimeout(6000);
const after = await page.evaluate(() => ({
  hero: !!document.getElementById('lsPotHero'),
  sheet: !!document.getElementById('lsCashPop'),
  txt: (document.getElementById('lsCashPop') || {}).textContent || ''
}));
ok('when the number has landed the sheet goes up by itself', after.hero === false && after.sheet === true);
ok('and it offers both ways out', /ادامه می‌دهم/.test(after.txt) && /برداشت/.test(after.txt), after.txt.replace(/\s+/g, ' ').slice(0, 60));

/* The sheet's own figures are NOT masked: it is the one place the number is a
   decision rather than decoration. */
const honest = await page.evaluate(() => {
  (0, eval)('lsPotReset()');
  const s = window.__s;
  s.stats.eliminated = 0; s.room.phase = 'cashout'; s.me.decisionThisRound = null;
  document.getElementById('lsCashPop') && document.getElementById('lsCashPop').remove();
  (0, eval)('lsOverlays')(s);
  const c = document.getElementById('lsCashPop');
  return { txt: (c ? c.textContent : '').replace(/\s+/g, ' '), share: (0, eval)('lsFa')(120000) };
});
ok('a player deciding is told the real number, never «؟؟؟»',
  honest.txt.includes(honest.share) && !honest.txt.includes('؟؟؟'), honest.txt.slice(0, 70));

console.log(`\n[lsprize] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
