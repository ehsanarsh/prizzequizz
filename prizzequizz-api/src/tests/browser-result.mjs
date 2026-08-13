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
const boxes = (page) => page.evaluate(() => {
  const sec = document.getElementById('result');
  const out = [];
  sec.querySelectorAll('button, .stat, .rb-side, .rb-score, .res-amt, .res-title').forEach((el) => {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    out.push({ tag: (el.textContent || '').trim().slice(0, 20), x: r.left, y: r.top, w: r.width, h: r.height });
  });
  return out;
});
function overlaps(list) {
  const bad = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    /* A couple of px of rounding is not an overlap; a real collision is not. */
    if (ix > 2 && iy > 2) bad.push(a.tag + ' × ' + b.tag);
  }
  return bad;
}

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

  const b = await boxes(page);
  const bad = overlaps(b);
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
      statLabels: [...sec.querySelectorAll('.stat span')].map((x) => x.textContent),
      charShown: !!(document.getElementById('resultCharSlot') || {}).offsetParent,
      charFrac: (document.getElementById('resultCharSlot')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height / window.innerHeight,
      statCards: sec.querySelectorAll('.res-stats').length,
      statsInOneCard: (function(){ const g=sec.querySelector('.res-stats'); if(!g) return false;
        const r=g.getBoundingClientRect(); const kids=[...g.querySelectorAll('.stat')];
        return kids.length===3 && kids.every(k=>{const kr=k.getBoundingClientRect(); return kr.top>=r.top-1 && kr.bottom<=r.bottom+1;}); })(),
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
  ok('the character has real room', content.charShown && content.charFrac > 0.10, content.charFrac.toFixed(2));
  ok('without taking over the screen', content.charFrac < 0.26, content.charFrac.toFixed(2));
  ok('the headline is coloured by the outcome', /win|lose/.test(content.titleCls), content.titleCls);
  ok('and the line under it is gone', !content.subShown, String(content.subShown));
  ok('there is no second XP figure among the stats', !content.statLabels.some((s) => /XP|امتیاز/.test(s)), JSON.stringify(content.statLabels));
  ok('the score is printed once, not twice', content.scoreCount <= 1, String(content.scoreCount));
  ok('the three figures share ONE card, on one line', content.statsInOneCard, String(content.statCards));
  ok('and the buttons sit below everything else', content.actionsAtBottom);
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
  const bad = overlaps(await boxes(page));
  ok('still nothing overlaps', bad.length === 0, bad.join(' | '));
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
