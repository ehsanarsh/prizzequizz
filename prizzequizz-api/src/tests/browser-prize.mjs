/* THE RESULT SCREEN, REBUILT.
 *
 * It used to be a fixed column with overflow:hidden: on a short phone the
 * buttons and the stats were pushed into each other and whatever did not fit
 * was silently cut off. The character portrait ate the top third, and the XP
 * was printed twice — once guessed locally, once from the server.
 *
 * So the checks here are geometric, not cosmetic: nothing overlaps, nothing is
 * unreachable, and the numbers appear once each. Plus the rematch button's
 * state machine, which is the only interactive thing on the screen.
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

/* The rematch handshake the client polls. The test drives it. */
let rematchState = { status: 'none' };
const rematchCalls = [];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function makePage(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 300, hearts: 5, wallet: 0 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const u = new URL(route.request().url()); const p = u.pathname.replace(/^.*\/v1/, '');
    const send = (d, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
    if (/\/rematch$/.test(p) && route.request().method() === 'GET') { rematchCalls.push('GET'); return send({ ok: true, data: rematchState }); }
    if (/\/rematch\/request$/.test(p)) { rematchCalls.push('REQUEST'); return send({ ok: true, data: { status: 'pending', by: 'me' } }); }
    return send({ ok: true, data: {} });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

/* Every visible box inside the result screen, so overlaps can be looked for
   rather than eyeballed. Only leaf-ish boxes: a parent containing a child is
   not an overlap. */
/* Overlap is computed IN the page, because deciding it needs the elements
   themselves: a child sitting inside its parent's box is nesting, not a
   collision, and comparing bare rectangles cannot tell the two apart. */
const overlapPairs = (page) => page.evaluate(() => {
  const sec = document.getElementById('result');
  const els = [...sec.querySelectorAll('button, .stat, .rb-side, .rb-score, .res-amt, .res-title')]
    .filter((el) => (el.offsetParent || getComputedStyle(el).position === 'fixed'))
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; });
  const bad = [];
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const A = els[i], B = els[j];
    if (A.contains(B) || B.contains(A)) continue;          // nesting
    const a = A.getBoundingClientRect(), b = B.getBoundingClientRect();
    const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    /* A couple of px of rounding is not an overlap; a real collision is. */
    if (ix > 2 && iy > 2) bad.push((A.textContent || '').trim().slice(0, 16) + ' × ' + (B.textContent || '').trim().slice(0, 16));
  }
  return bad;
});

async function showDuelResult(page, won = true) {
  await page.evaluate((w) => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; gameType='duel'; duelStage=2; oppName='زهرا'; oppAv=''; myResults=['ok','ok','no'];");
    (0, eval)(w ? 'myScore=5; oppScore=3;' : 'myScore=2; oppScore=6;');
    (0, eval)('endGame(' + (w ? 'true' : 'false') + ', 180000, false)');
    (0, eval)("showScreen('result')");
  }, won);
  await page.waitForTimeout(350);
}

/* ── THE PRIZE IS THE TAKE-HOME FIGURE ───────────────────────────────────
   A ۱۲٬۵۰۰ ticket makes a ۲۵٬۰۰۰ pot, and the screen used to print exactly
   that — the pot, with the commission still in it. The winner was paid less.
   The server sends the after-commission figure per tier (GET /economy/prizes)
   and it is that number the player must be shown, everywhere. */
{
  const { ctx, page, errs } = await makePage(390, 844);
  console.log('the prize the winner is shown:');
  /* The server's own table: a ۱۲٬۵۰۰ ticket pays ۲۲٬۵۰۰ (a 10% commission on
     the ۲۵٬۰۰۰ pot). Nothing here tells the client the percentage. */
  await page.evaluate(() => {
    /* `red` is deliberately NOT a flat percentage of its pot: the only way to
       print ۱۷٬۷۷۷ is to read the server's own figure for that tier rather
       than to work one out. */
    (0, eval)("PZ_PRIZES={green:{value:12500,prize:22500},blue:{value:25000,prize:45000},red:{value:9000,prize:17777}};");
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; curStake=12500; duelStakeVal=12500; duelStage=1;");
  });
  const money = await page.evaluate(() => ({
    now: (0, eval)('pzDuelPrizeNow()'),
    net25: (0, eval)('pzNetPrize(25000)'),
    net50: (0, eval)('pzNetPrize(50000)'),      // the doubled stage: a tier the server priced
    net70: (0, eval)('pzNetPrize(70000)'),      // not a tier at all — same commission
    net18: (0, eval)('pzNetPrize(18000)')       // a tier the server priced its own way
  }));
  ok('the commission comes off the pot', money.now === 22500, String(money.now));
  ok('it is NOT the gross pot', money.now !== 25000, String(money.now));
  ok('the server figure is used verbatim for a tier', money.net25 === 22500, String(money.net25));
  ok('and for the tier above it', money.net50 === 45000, String(money.net50));
  ok('a pot that is not a tier gets the SAME commission', money.net70 === 63000, String(money.net70));
  /* The server is the authority even when its figure is not a round percentage
     — the client reads it, it does not recompute it. */
  ok('a tier the server priced its own way is not recomputed', money.net18 === 17777, String(money.net18));

  /* And it reaches the screen — the duel's «جایزه» line and the result card. */
  await page.evaluate(() => { (0, eval)('updateDuelVs()'); });
  const shown = await page.evaluate(() => (document.getElementById('duelWin') || {}).textContent || '');
  ok('the duel screen quotes the take-home figure', /۲۲/.test(shown) && !/۲۵٬۰۰۰/.test(shown), shown);

  await page.evaluate(() => {
    (0, eval)("gameType='duel'; oppName='زهرا'; myScore=5; oppScore=3; prize=pzDuelPrizeNow();");
    (0, eval)('endGame(true, prize, true)');       // a withdrawal — still a win
    (0, eval)("showScreen('result')");
  });
  /* The prize lands on the screen at the END of the chest animation (which
     auto-skips) and is then counted up — so the figure has to be read after all
     of that, not while the placeholder is still there. */
  await page.waitForFunction(() => {
    const t = (document.getElementById('resultAmt') || {}).textContent || '';
    return t && !/۱۸۰/.test(t);
  }, null, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1400);
  const res = await page.evaluate(() => ({
    amt: (document.getElementById('resultAmt') || {}).textContent || '',
    title: (document.getElementById('resultTitle') || {}).textContent || ''
  }));
  ok('and so does the result screen', /۲۲٬۵۰۰/.test(res.amt), res.amt);
  ok('the pot is never what is printed', !/۲۵٬۰۰۰/.test(res.amt), res.amt);
  /* «جایزه‌ت رو برداشتی» and «برنده شدی» were two headlines for one outcome. */
  ok('a withdrawal says «برنده شدی» like any other win', /برنده شدی/.test(res.title), res.title);
  ok('and never «برداشتی»', !/برداشتی/.test(res.title), res.title);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── «رتبه» BELONGS TO LAST SURVIVOR ALONE ───────────────────────────────
   In a duel a rank is «۱ or ۲», which the scoreboard beside it already says.
   In آخرین بازمانده you finish somewhere among many players, and that is the
   one place the figure carries information. */
{
  const { ctx, page, errs } = await makePage(390, 844);
  console.log('«رتبه» on the stats card:');
  await showDuelResult(page, true);
  let labels = await page.evaluate(() =>
    [...document.querySelectorAll('#result .stat')].filter((x) => x.offsetParent).map((x) => (x.querySelector('span') || {}).textContent));
  ok('a duel win shows no rank', !labels.some((t) => /رتبه/.test(t)), JSON.stringify(labels));
  await showDuelResult(page, false);
  labels = await page.evaluate(() =>
    [...document.querySelectorAll('#result .stat')].filter((x) => x.offsetParent).map((x) => (x.querySelector('span') || {}).textContent));
  ok('nor does a duel loss', !labels.some((t) => /رتبه/.test(t)), JSON.stringify(labels));

  /* Last Survivor: the winner is ۱, and a player knocked out with three others
     still standing finished ۴th. */
  const lsRank = await page.evaluate(() => {
    const snapWin = { room: { phase: 'finished', round: 7 }, me: { userId: 'me', status: 'cashed_out', payoutCash: 90000 },
      players: [{ userId: 'me', status: 'cashed_out' }, { userId: 'b', status: 'eliminated' }] };
    (0, eval)('lsEndShown=false; lsForfeited=0;');
    (0, eval)('lsFinish(' + JSON.stringify(snapWin) + ')');
    const win = { shown: !!document.getElementById('stat-rank-cell').offsetParent,
                  value: document.getElementById('stat-rank').textContent,
                  title: document.getElementById('resultTitle').textContent };
    const snapOut = { room: { phase: 'finished', round: 4 }, me: { userId: 'me', status: 'eliminated', payoutCash: 0, eliminatedRound: 4 },
      players: [{ userId: 'me', status: 'eliminated' }, { userId: 'b', status: 'alive' }, { userId: 'c', status: 'alive' }, { userId: 'd', status: 'alive' }] };
    (0, eval)('lsEndShown=false; lsForfeited=0;');
    (0, eval)('lsFinish(' + JSON.stringify(snapOut) + ')');
    const out = { shown: !!document.getElementById('stat-rank-cell').offsetParent,
                  value: document.getElementById('stat-rank').textContent };
    return { win, out };
  });
  await page.waitForTimeout(200);
  ok('Last Survivor DOES show a rank', lsRank.win.shown, JSON.stringify(lsRank.win));
  ok('and the winner is ۱', lsRank.win.value === '۱', lsRank.win.value);
  /* Cashing out is winning — one headline for both. */
  ok('cashing out says «برنده شدی» too', /برنده شدی/.test(lsRank.win.title), lsRank.win.title);
  ok('a player out with three still standing is ۴th', lsRank.out.shown && lsRank.out.value === '۴', JSON.stringify(lsRank.out));

  /* And it goes away again when the screen is handed back to the duel. */
  const back = await page.evaluate(() => { (0, eval)('lsResetResultButtons()');
    return !!document.getElementById('stat-rank-cell').offsetParent; });
  ok('and it leaves with Last Survivor', !back, String(back));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}


/* ── ZONE ORDER ─────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage(390, 844);
  console.log('the zone order:');
  await page.evaluate(() => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; gameType='duel'; duelStage=2; oppName='زهرا'; myScore=5; oppScore=3;");
    (0, eval)('endGame(true, 180000, false)');
    (0, eval)("showScreen('result')");
  });
  await page.waitForTimeout(350);
  const z = await page.evaluate(() => { const sec=document.getElementById('result');
    const y=(sel)=>{ const e=sec.querySelector(sel); if(!e||!e.offsetParent) return null;
      const r=e.getBoundingClientRect(); return { top:Math.round(r.top), bottom:Math.round(r.bottom) }; };
    return { board:y('#resultBoard'), char:y('#resultCharSlot'), title:y('.res-title'),
             amt:y('.res-amt'), stats:y('.res-stats'), actions:y('.res-actions') }; });
  ok('the scoreboard is at the very top', z.board && z.char && z.board.bottom <= z.char.top + 1, JSON.stringify(z));
  ok('the character is in the middle, under the board', z.char && z.title && z.char.bottom <= z.title.top + 1, JSON.stringify(z));
  ok('the prize is in the middle too, not at the top', z.amt && z.board && z.amt.top > z.board.bottom, JSON.stringify(z));
  ok('the stats card is below the prize', z.stats && z.amt && z.stats.top >= z.amt.bottom - 1, JSON.stringify(z));
  ok('and rests directly on the buttons', z.stats && z.actions && z.actions.top >= z.stats.bottom - 1 && z.actions.top - z.stats.bottom < 40, JSON.stringify(z));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
