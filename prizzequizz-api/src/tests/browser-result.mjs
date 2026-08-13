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

/* ── the layout ──────────────────────────────────────────────────────── */
for (const [w, h] of [[360, 640], [390, 844], [320, 568]]) {
  const { ctx, page, errs } = await makePage(w, h);
  console.log(`the duel result at ${w}×${h}:`);
  await showDuelResult(page, true);

  const bad = await overlapPairs(page);
  ok('nothing overlaps anything', bad.length === 0, bad.join(' | '));

  const geom = await page.evaluate(() => {
    const sec = document.getElementById('result');
    const btns = [...sec.querySelectorAll('.res-actions button')].filter((x) => x.offsetParent);
    const secR = sec.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(sec).overflowY,
      needsScroll: sec.scrollHeight > sec.clientHeight + 1,
      lastBtnBottom: btns.length ? Math.round(btns[btns.length - 1].getBoundingClientRect().bottom) : 0,
      secBottom: Math.round(secR.bottom),
      scrollHeight: sec.scrollHeight, clientHeight: sec.clientHeight,
      btnCount: btns.length
    };
  });
  /* The old screen clipped: content past the bottom simply did not exist. */
  ok('the screen scrolls rather than clipping', /auto|scroll/.test(geom.overflowY), geom.overflowY);
  ok('every button is present', geom.btnCount >= 3, String(geom.btnCount));
  /* It must FIT. overflow-y:auto stays as the guarantee that content can never
     be silently CLIPPED, but needing to scroll is itself the failure here. */
  ok('the whole screen fits — no scrolling needed', !geom.needsScroll, JSON.stringify(geom));
  ok('and the last button is on screen', geom.lastBtnBottom <= geom.secBottom + 2, JSON.stringify(geom));

  const content = await page.evaluate(() => {
    const sec = document.getElementById('result');
    return {
      faces: sec.querySelectorAll('#resultBoard .rb-face').length,
      board: (document.getElementById('resultBoard') || {}).innerText || '',
      statLabels: [...sec.querySelectorAll('.stat')].filter((x) => x.offsetParent).map((x) => (x.querySelector('span')||{}).textContent),
      charShown: !!(document.getElementById('resultCharSlot') || {}).offsetParent,
      charFrac: (document.getElementById('resultCharSlot')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height / window.innerHeight,
      statCards: sec.querySelectorAll('.res-stats').length,
      /* Only the cells that are actually SHOWN count. «رتبه» lives in this card
         too, hidden for every mode but Last Survivor, and a hidden cell is not
         a second card. */
      statsInOneCard: (function(){ const g=sec.querySelector('.res-stats'); if(!g) return false;
        const r=g.getBoundingClientRect(); const kids=[...g.querySelectorAll('.stat')].filter(k=>k.offsetParent);
        return kids.length>=4 && kids.every(k=>{const kr=k.getBoundingClientRect(); return kr.top>=r.top-1 && kr.bottom<=r.bottom+1;}); })(),
      /* THE ZONE ORDER the screen is built around: scoreboard on top, then the
         celebration (character + headline + prize), then the stats sitting on
         the buttons. Read as geometry, not as DOM order. */
      zones: (function(){ const y=(sel)=>{ const e=sec.querySelector(sel); if(!e||!e.offsetParent) return null;
          const r=e.getBoundingClientRect(); return { top:Math.round(r.top), bottom:Math.round(r.bottom) }; };
        return { board:y('#resultBoard'), char:y('#resultCharSlot'), title:y('.res-title'),
                 amt:y('.res-amt'), stats:y('.res-stats'), actions:y('.res-actions') }; })(),
      sides: (function(){ const ss=[...document.querySelectorAll('#resultBoard .rb-side')];
        return ss.map(x=>({ n:(x.querySelector('.rb-name')||{}).textContent||'', x:Math.round(x.getBoundingClientRect().left) })); })(),
      meIsRight: (function(){ const ss=[...document.querySelectorAll('#resultBoard .rb-side')];
        if(ss.length!==2) return false;
        const me=ss.find(x=>/ehsan|احسان/.test((x.querySelector('.rb-name')||{}).textContent||''));
        const op=ss.find(x=>x!==me);
        if(!me||!op) return false;
        return me.getBoundingClientRect().left > op.getBoundingClientRect().left; })(),
      crownOnFace: !!document.querySelector('#resultBoard .rb-face .rb-crown'),
      crownWhere: (function(){ const c=document.querySelector('#resultBoard .rb-crown');
        return c? (c.parentElement.className||'') : '(no crown)'; })(),
      avgTime: (document.getElementById('stat-time')||{}).textContent || '',
      hasProfileBtn: /پروفایل حریف/.test(sec.innerText),
      hasAddChip: !!document.getElementById('rbAddFriend'),
      titleCls: (document.getElementById('resultTitle')||{}).className || '',
      subShown: !!(document.getElementById('resultSub')||{}).offsetParent,
      actionsAtBottom: (function(){ const a=sec.querySelector('.res-actions'), m=sec.querySelector('.res-mid');
        if(!a||!m) return false; return a.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 1; })(),
      scoreCount: (sec.innerText.match(/۵\s*-\s*۳|۳\s*-\s*۵/g) || []).length
    };
  });
  ok('two faces flank the score', content.faces === 2, String(content.faces));
  /* The «حریف»/«تو» captions are gone — the two faces and the two names are
     what separate the sides now. */
  ok('both players are named, one per side', /زهرا/.test(content.board) && /ehsan|احسان/.test(content.board), content.board.replace(/\n/g, ' '));
  /* Whatever the outcome, YOUR face is on the right. A player should not have to
     work out which side they are on before reading the score. */
  ok('you are on the RIGHT of the board', content.meIsRight, JSON.stringify(content.sides));
  ok('the crown is on the winner’s picture', content.crownOnFace, content.crownWhere);
  ok('the character has real room', content.charShown && content.charFrac > 0.10, content.charFrac.toFixed(2));
  /* Bigger than it was (it used to be capped at 21vh) but still not the whole
     screen — the stats and the buttons have to keep their own height. */
  ok('without taking over the screen', content.charFrac < 0.34, content.charFrac.toFixed(2));
  ok('the headline is coloured by the outcome', /win|lose/.test(content.titleCls), content.titleCls);
  ok('and the line under it is gone', !content.subShown, String(content.subShown));
  /* One card now carries all four: right answers, real average time, XP, cup.
     «رتبه» is gone — in a duel it is only ever ۱ or ۲. */
  ok('the card carries XP and cup', content.statLabels.some((s) => /XP/.test(s)) && content.statLabels.some((s) => /کاپ/.test(s)), JSON.stringify(content.statLabels));
  ok('and no longer a rank', !content.statLabels.some((s) => /رتبه/.test(s)), JSON.stringify(content.statLabels));
  ok('the average answer time is not the hardcoded ۱۲ث', content.avgTime !== '۱۲ث', content.avgTime);
  ok('the opponent-profile button is gone from the panel', !content.hasProfileBtn);
  ok('a small ＋ sits beside the opponent’s name instead', content.hasAddChip);
  ok('the score is printed once, not twice', content.scoreCount <= 1, String(content.scoreCount));
  ok('the figures share ONE card, on one line', content.statsInOneCard && content.statCards === 1, String(content.statCards));
  /* THE ORDER THE SCREEN IS READ IN. The scoreboard answers "who won", the
     middle celebrates it, and the stats sit on top of the buttons. Anything
     else and the prize ends up above the fold's fold. */
  const z = content.zones;
  ok('the scoreboard is at the very top', z.board && z.char && z.board.bottom <= z.char.top + 1, JSON.stringify(z));
  ok('the character is in the middle, under the board', z.char && z.title && z.char.bottom <= z.title.top + 1, JSON.stringify(z));
  ok('the headline sits with it', z.title && z.amt && z.title.bottom <= z.amt.top + 1, JSON.stringify(z));
  ok('the prize is in the middle too, not at the top', z.amt && z.board && z.amt.top > z.board.bottom, JSON.stringify(z));
  ok('the stats card is below the prize', z.stats && z.amt && z.stats.top >= z.amt.bottom - 1, JSON.stringify(z));
  ok('and rests directly on the buttons', z.stats && z.actions && z.actions.top >= z.stats.bottom - 1 && z.actions.top - z.stats.bottom < 40, JSON.stringify(z));
  ok('and the buttons sit below everything else', content.actionsAtBottom);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
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

/* ── a mode with no opponent ─────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage(360, 640);
  console.log('a result with no opponent (record / last survivor):');
  await page.evaluate(() => {
    (0, eval)("gameType='arena'; qIndex=9; myScore=0; oppScore=0;");
    (0, eval)('endGame(true, 50000, false)');
    (0, eval)("showScreen('result')");
  });
  await page.waitForTimeout(300);
  const c = await page.evaluate(() => ({
    faces: document.querySelectorAll('#resultBoard .rb-face').length,
    solo: document.getElementById('resultBoard').classList.contains('solo'),
    text: document.getElementById('resultBoard').innerText
  }));
  ok('collapses to a single face', c.faces === 1, String(c.faces));
  ok('and does not invent an opponent', !/حریف/.test(c.text), c.text.replace(/\n/g, ' '));
  const bad2 = await overlapPairs(page);
  ok('still nothing overlaps', bad2.length === 0, bad2.join(' | '));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── the rematch button ──────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage(390, 844);
  /* ── the fake rematch ────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage(390, 844);
  console.log('the rematch button with no real match behind it:');
  /* Underneath sits a leftover simulation: it rolls a dice for the opponent's
     answer, DOUBLES the stake, charges it, and starts a local game off the
     whole topic list. In the prize plan that is a match nobody was invited to
     and money taken for it. */
  await showDuelResult(page, true);
  await page.evaluate(() => {
    (0, eval)("_pzRematchMid=null; _pzRematchBusy=false; userPlan='premium';");
    window.__paid = 0; window.__intro = 0;
    (0, eval)('pay = function(n){ window.__paid += n; return true; }');
    (0, eval)('duelIntro = function(){ window.__intro++; }');
    (0, eval)("duelStakeVal=12500;");
    (0, eval)('pzSyncRematchAvailability()');
  });
  let st = await page.evaluate(() => { const b = document.getElementById('rematchBtn'); return { text: b.textContent.trim(), disabled: b.disabled }; });
  ok('the button says the offer is not available', /در دسترس نیست/.test(st.text), st.text);
  ok('and is disabled', st.disabled === true, String(st.disabled));

  await page.evaluate(() => { const b = document.getElementById('rematchBtn'); b.disabled = false; b.click(); });
  await page.waitForTimeout(2200);
  const after = await page.evaluate(() => ({
    paid: window.__paid, intro: window.__intro, stake: (0, eval)('duelStakeVal'),
    text: document.getElementById('rematchBtn').textContent.trim()
  }));
  ok('tapping it takes no money', after.paid === 0, String(after.paid));
  ok('does not double the stake', after.stake === 12500, String(after.stake));
  ok('and starts no game', after.intro === 0, String(after.intro));
  ok('it just says the offer is gone', /در دسترس نیست/.test(after.text), after.text);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('the rematch button:');
  await showDuelResult(page, true);
  await page.evaluate(() => { (0, eval)("_pzRematchMid='m1'; _pzRematchBusy=false;"); (0, eval)("_pzRematchBtnState('idle')"); });

  const label = () => page.evaluate(() => {
    const b = document.getElementById('rematchBtn');
    return { text: b.textContent.trim(), disabled: b.disabled };
  });
  let st = await label();
  ok('starts as an offer', /بازی مجدد با همین حریف/.test(st.text) && !st.disabled, JSON.stringify(st));

  rematchState = { status: 'pending', by: 'me' };
  rematchCalls.length = 0;
  await page.evaluate(() => document.getElementById('rematchBtn').click());
  await page.waitForTimeout(400);
  st = await label();
  ok('one tap sends the request', rematchCalls.includes('REQUEST'), rematchCalls.join(','));
  ok('and the button says it is waiting', /منتظر پاسخ/.test(st.text), st.text);
  ok('and is disabled so it cannot be tapped again', st.disabled === true, String(st.disabled));

  /* A second tap while waiting must not send a second request. */
  const before = rematchCalls.filter((c) => c === 'REQUEST').length;
  await page.evaluate(() => { const b = document.getElementById('rematchBtn'); b.disabled = false; b.click(); });
  await page.waitForTimeout(300);
  ok('a second tap sends nothing', rematchCalls.filter((c) => c === 'REQUEST').length === before, String(rematchCalls.filter((c) => c === 'REQUEST').length));

  console.log('when the opponent refuses:');
  rematchState = { status: 'rejected' };
  await page.waitForTimeout(2200);
  st = await label();
  ok('the refusal is written on the button itself', /رد کرد/.test(st.text), st.text);
  ok('and it is not a toast that vanishes', /حریف درخواست شما را رد کرد/.test(st.text), st.text);

  await page.waitForTimeout(3600);
  st = await label();
  ok('then the button gives itself back', /بازی مجدد با همین حریف/.test(st.text), st.text);
  ok('enabled, so it can be tried again', st.disabled === false, String(st.disabled));

  console.log('when the opponent has moved on:');
  rematchState = { status: 'none', opponentBusy: true };
  await page.evaluate(() => { (0, eval)("_pzRematchBusy=false;"); (0, eval)('_pzWatchOpponentAvailability()'); });
  await page.waitForTimeout(4800);
  st = await label();
  ok('the button says so', /مسابقهٔ دیگری/.test(st.text), st.text);
  ok('and stays disabled — it cannot work', st.disabled === true, String(st.disabled));
  await page.waitForTimeout(3800);
  st = await label();
  ok('and does NOT quietly come back', /مسابقهٔ دیگری/.test(st.text), st.text);

  console.log('when the opponent accepts:');
  await page.evaluate(() => { (0, eval)("_pzRematchMid='m1'; _pzRematchBusy=false;"); (0, eval)("_pzRematchBtnState('idle')"); });
  rematchState = { status: 'pending', by: 'me' };
  let entered = null;
  await page.evaluate(() => { window.__entered = null; (0, eval)('pzEnterRematch = function(id){ window.__entered = id; }'); });
  await page.evaluate(() => document.getElementById('rematchBtn').click());
  await page.waitForTimeout(300);
  rematchState = { status: 'accepted', newMatchId: 'm2' };
  await page.waitForTimeout(2200);
  entered = await page.evaluate(() => window.__entered);
  ok('the new match is entered', entered === 'm2', String(entered));

  ok('no script errors through any of it', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
