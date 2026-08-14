/* FOUR MORE THINGS FROM A REAL GAME.
 *
 *   1. THE CUP RAIL. The three league badges were pinned at 19% / 50% / 96% —
 *      positions typed into the stylesheet, not read from the thresholds — so a
 *      badge did not stand where its league begins, and the player at the top of
 *      the board sat at 96% with the gold badge still ahead of them. And the one
 *      thing worth knowing (how many cups to the next league) was nowhere on it.
 *
 *   2. THE CONNECTION WARNINGS. Two players on the same Wi-Fi were each told the
 *      other's internet was unstable. The rule was «no answer for ten seconds =
 *      their connection is bad», against a ten-second answer clock — so anyone
 *      who used their thinking time tripped it, and the faster player always saw
 *      it. Meanwhile «اینترنت شما ناپایدار است» fired after one missed 5-second
 *      ping, which a phone throttling its timers produces on its own.
 *
 *   3. THE LOSS SCREEN printed «−۵۰٬۰۰۰ تومان». No toman ever left the wallet —
 *      the entry was a ticket.
 *
 *   4. And it had nothing to say afterwards.
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

async function makePage(w = 390, h = 844) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 300, hearts: 5, wallet: 0 }));
  });
  await ctx.route('**/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 160)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

/* ── 1. THE CUP RAIL ────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the weekly cup rail:');
  await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
  await page.waitForTimeout(800);

  /* Everything is measured in page pixels, because the whole defect was that
     the drawn positions and the real thresholds were two different things. */
  const read = async (score) => {
    await page.evaluate((v) => {
      (0, eval)('leagueTargets={bronze:500,silver:1500,gold:3000}');
      (0, eval)('weeklyScore=' + v);
      (0, eval)('renderWeeklyProgress()');
    }, score);
    await page.waitForTimeout(850);
    return page.evaluate(() => {
      const mid = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { c: r.left + r.width / 2, l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; };
      const tube = (() => { const e = document.querySelector('#weeklyProgress .wpl-track'); if (!e) return null;
        const cs = getComputedStyle(e, '::before'); return { h: parseFloat(cs.height), top: parseFloat(cs.top) }; })();
      const lit = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        return { done: e.classList.contains('done'), grey: /grayscale\(0?\.\d+\)|grayscale\(1\)/.test(getComputedStyle(e.querySelector('img')).filter) }; };
      return {
        text: (document.getElementById('wpInside') || {}).textContent || '',
        bronze: mid('#wpBronze'), silver: mid('#wpSilver'), gold: mid('#wpGold'),
        token: mid('#wpMarker'), fill: mid('#wpFill'), track: mid('#weeklyProgress .wpl-track'),
        tube,
        litB: lit('#wpBronze'), litS: lit('#wpSilver'), litG: lit('#wpGold')
      };
    });
  };

  const zero = await read(0);
  /* «پهن‌تر»: it has to be a tube you can write inside, not a hairline. */
  ok('the bar is wide enough to write in', zero.tube && zero.tube.h >= 22, JSON.stringify(zero.tube));
  ok('and the sentence is inside it', zero.text.length > 0 && /کاپ تا لیگ/.test(zero.text), zero.text);
  ok('with nothing left to reach, it names the FIRST league', /برنز/.test(zero.text), zero.text);
  ok('and counts the cups exactly', /۵۰۰/.test(zero.text), zero.text);

  /* THE BADGES STAND IN ORDER, AND WHERE THEIR THRESHOLDS ARE — not at three
     numbers typed into a stylesheet. Bronze 500, silver 1500, gold 3000 on one
     scale means silver sits about three times as far along as bronze. */
  ok('the badges stand in league order', zero.bronze.c < zero.silver.c && zero.silver.c < zero.gold.c,
     [zero.bronze.c, zero.silver.c, zero.gold.c].map(Math.round).join(' < '));
  const span = (x) => (x - zero.track.l) / zero.track.h;
  const ratio = (zero.silver.c - zero.track.l) / (zero.bronze.c - zero.track.l);
  ok('and at distances that match the thresholds, not fixed percents', ratio > 2.2 && ratio < 4.0, 'silver/bronze = ' + ratio.toFixed(2));
  /* The old stylesheet put them at 19 / 50 / 96 percent of the track. */
  const pctOf = (x) => Math.round(((x - zero.track.l) / (zero.track.r - zero.track.l)) * 100);
  ok('they are NOT at the old 19% / 50% / 96%', !(pctOf(zero.bronze.c) === 19 && pctOf(zero.silver.c) === 50),
     [pctOf(zero.bronze.c), pctOf(zero.silver.c), pctOf(zero.gold.c)].join(' / '));

  /* THE BADGES ARE ON THE BAR. */
  const onBar = (b) => b.b > zero.track.t + zero.tube.top - 6 && b.b <= zero.track.t + zero.tube.top + zero.tube.h;
  ok('each badge stands ON the bar, not floating above it', onBar(zero.bronze) && onBar(zero.silver) && onBar(zero.gold),
     JSON.stringify({ tubeTop: Math.round(zero.track.t + zero.tube.top), bronzeBottom: Math.round(zero.bronze.b) }));

  /* NOBODY HAS REACHED ANYTHING YET. */
  ok('a league not yet reached is drained of colour', zero.litB.grey && zero.litG.grey, JSON.stringify(zero.litB));
  ok('and not marked as done', !zero.litB.done && !zero.litG.done);

  const bronzeIn = await read(500);
  ok('landing exactly on the line enters the league', bronzeIn.litB.done, JSON.stringify(bronzeIn.litB));
  ok('the badge lights up', !bronzeIn.litB.grey, JSON.stringify(bronzeIn.litB));
  ok('and the sentence moves on to the next one', /نقره/.test(bronzeIn.text), bronzeIn.text);
  ok('counting from where the player now is', /۱٬۰۰۰/.test(bronzeIn.text), bronzeIn.text);
  /* A badge is at the LAST player in, so standing exactly on it means you are
     level with the badge, not past it. */
  ok('and the player stands level with the badge they just reached',
     Math.abs(bronzeIn.token.c - bronzeIn.bronze.c) < 6, Math.round(bronzeIn.token.c - bronzeIn.bronze.c) + 'px');

  const mid2 = await read(1900);
  ok('past silver, the silver badge is behind the player', mid2.token.c > mid2.silver.c, Math.round(mid2.token.c - mid2.silver.c) + 'px');
  ok('and gold is still ahead', mid2.token.c < mid2.gold.c, Math.round(mid2.gold.c - mid2.token.c) + 'px');
  ok('the sentence names gold', /طلایی/.test(mid2.text), mid2.text);
  ok('bronze and silver are lit, gold is not', mid2.litB.done && mid2.litS.done && !mid2.litG.done);

  /* THE HEADLINE CASE: the top player in the game. «اگه من نفر اول کاپ هستم
     نباید روی آیکون کاپ طلایی باشم — باید ردش کرده باشم». */
  const top = await read(4200);
  ok('the best player in the game is PAST the gold badge', top.token.c > top.gold.c + 10, Math.round(top.token.c - top.gold.c) + 'px');
  ok('and not pinned to the end of the rail', top.token.r <= top.track.r + 2 && top.token.c > top.silver.c,
     JSON.stringify({ token: Math.round(top.token.c), trackEnd: Math.round(top.track.r) }));
  ok('every badge is lit', top.litB.done && top.litS.done && top.litG.done);
  ok('and the tube says the league is theirs', /طلایی/.test(top.text) && !/تا لیگ/.test(top.text), top.text);
  /* And the bar itself is filled past the gold badge, not stopped at it. */
  ok('the bar is filled past gold too', top.fill.r > top.gold.c, Math.round(top.fill.r - top.gold.c) + 'px');

  /* The rail must not silently break when the admin moves the lines. */
  const moved = await page.evaluate(async () => {
    (0, eval)('leagueTargets={bronze:100,silver:200,gold:400}');
    (0, eval)('weeklyScore=150'); (0, eval)('renderWeeklyProgress()');
    await new Promise((r) => setTimeout(r, 800));
    const c = (s) => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return r.left + r.width / 2; };
    return { text: document.getElementById('wpInside').textContent, bronze: c('#wpBronze'), token: c('#wpMarker'), silver: c('#wpSilver') };
  });
  ok('moving the thresholds moves the badges', moved.token > moved.bronze && moved.token < moved.silver,
     JSON.stringify({ bronze: Math.round(moved.bronze), token: Math.round(moved.token), silver: Math.round(moved.silver) }));
  ok('and the sentence follows the new numbers', /۵۰ کاپ تا لیگ نقره/.test(moved.text), moved.text);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE CONNECTION WARNINGS ─────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the connection warnings:');

  /* A live duel with a healthy socket, in the state the real game is in. */
  const setup = () => page.evaluate(() => {
    (0, eval)("pzRt.active=true; pzRt.finished=false; pzRt.matchId='m1'; pzRt.myId='me'; pzRt.oppId='op';");
    (0, eval)("pzRt.ws={readyState:1,close:function(){this.readyState=3;},send:function(){}};");
    (0, eval)('pzConnStart()');
  });

  await setup();
  /* TIMER THROTTLING, NOT A BAD LINK. A phone that dimmed its screen for nine
     seconds comes back with one missed ping. That used to say «اینترنت شما
     ناپایدار است» on a perfect connection. */
  const oneMissed = await page.evaluate(async () => {
    (0, eval)('pzConn.lastPongAt=Date.now()-9000');
    (0, eval)('pzConnEvalMine()');
    return { state: (0, eval)('pzConn.mine'), shown: document.getElementById('pzConnBanner').classList.contains('show') };
  });
  ok('one missed ping says nothing', oneMissed.state === 'ok' && !oneMissed.shown, JSON.stringify(oneMissed));

  /* Two missed pings, twice in a row, IS worth saying. */
  const reallyWeak = await page.evaluate(async () => {
    (0, eval)('pzConn.lastPongAt=Date.now()-13000');
    (0, eval)('pzConnEvalMine()');
    const afterOne = (0, eval)('pzConn.mine');
    (0, eval)('pzConn.lastPongAt=Date.now()-13000');
    (0, eval)('pzConnEvalMine()');
    return { afterOne, afterTwo: (0, eval)('pzConn.mine'), txt: (document.getElementById('pzConnTxt') || {}).textContent };
  });
  ok('one bad reading is still not enough', reallyWeak.afterOne === 'ok', reallyWeak.afterOne);
  ok('two in a row is', reallyWeak.afterTwo === 'weak', reallyWeak.afterTwo);
  ok('and then it says so', /ناپایدار/.test(reallyWeak.txt || ''), reallyWeak.txt);

  /* A REAL drop is still instant — a closed socket needs no streak. */
  const dropped = await page.evaluate(() => {
    (0, eval)('pzConnStart()');
    (0, eval)('pzRt.ws.readyState=3');
    (0, eval)('pzConn.startAt=Date.now()-9000');
    (0, eval)('pzConnEvalMine()');
    return { state: (0, eval)('pzConn.mine'), txt: (document.getElementById('pzConnTxt') || {}).textContent };
  });
  ok('a genuinely closed socket is reported at once', dropped.state === 'down', dropped.state);
  ok('with the reconnecting message', /قطع شده/.test(dropped.txt || ''), dropped.txt);

  /* A HIDDEN PAGE IS A THROTTLED PAGE. Nothing may be judged while it is away,
     and coming back must not be read as a bad link. */
  const hidden = await page.evaluate(async () => {
    (0, eval)('pzConnStart()');
    (0, eval)("pzRt.ws={readyState:1,close:function(){},send:function(){}}");
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    (0, eval)('pzConn.lastPongAt=Date.now()-40000');
    (0, eval)('pzConnEvalMine()'); (0, eval)('pzConnEvalMine()');
    const whileAway = (0, eval)('pzConn.mine');
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 1400));
    return { whileAway, onReturn: (0, eval)('pzConn.mine') };
  });
  ok('nothing is judged while the app is in the background', hidden.whileAway === 'ok', hidden.whileAway);
  ok('and coming back is not read as a bad connection', hidden.onReturn === 'ok', hidden.onReturn);

  /* THE ONE THE USER SAW: a slow opponent is not a broken opponent. */
  const slowOpp = await page.evaluate(async () => {
    (0, eval)('pzConnStart()');
    (0, eval)("pzRt.ws={readyState:1,close:function(){},send:function(){}}");
    (0, eval)("pzRt.oppByRound={}; pzRt.oppLeft=false; pzRt.oppPresent=true; pzRt.presence=2;");
    let resolved = false;
    (0, eval)('pzWaitOpp')(3, () => { resolved = true; });
    /* Rewind the waiter's clock so its next tick is 14 seconds in — longer than
       the whole answer clock, which is precisely the case that misfired. */
    await new Promise((r) => setTimeout(r, 300));
    return null;
  });
  /* Drive the waiter's own interval by inspecting what it writes. */
  const waitTxt = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { topic: (document.getElementById('dTopic') || {}).textContent, opp: (0, eval)('pzConn.opp') };
  });
  ok('waiting says it is waiting', /در انتظار پاسخ حریف/.test(waitTxt.topic || ''), waitTxt.topic);
  ok('and does not accuse the opponent’s internet', waitTxt.opp === 'ok', waitTxt.opp);
  /* The source itself must no longer contain the rule that caused it. */
  const src = fs.readFileSync(path.join(ROOT, 'prizze-v643.html'), 'utf8');
  ok('the ten-second rule is gone from the waiter', !/waited>10000&&typeof pzSetOppConn/.test(src));
  ok('and the waiting label no longer claims a connection fault',
     !/const SLOW='📶 اتصال حریف ناپایدار/.test(src));

  /* WHAT REPLACED IT: the server's own presence. Told the opponent has left the
     room, the client says so; told nothing, it says nothing. */
  const presence = await page.evaluate(() => {
    (0, eval)('pzConnStart()');
    (0, eval)("pzRt.active=true; pzRt.finished=false; pzRt.myId='me'; pzRt.oppPresent=true;");
    (0, eval)("pzHandleWs({type:'server:presence',payload:{users:[{userId:'me'}]}})");
    const gone = { opp: (0, eval)('pzConn.opp'), present: (0, eval)('pzRt.oppPresent'), txt: (document.getElementById('pzConnTxt') || {}).textContent };
    (0, eval)("pzHandleWs({type:'server:presence',payload:{users:[{userId:'me'},{userId:'op'}]}})");
    const back = { opp: (0, eval)('pzConn.opp'), present: (0, eval)('pzRt.oppPresent') };
    return { gone, back };
  });
  ok('the server saying they left IS reported', presence.gone.opp === 'down', JSON.stringify(presence.gone));
  ok('with the opponent-disconnected message', /اتصال حریف قطع/.test(presence.gone.txt || ''), presence.gone.txt);
  ok('and presence is cleared, not only ever set', presence.gone.present === false, String(presence.gone.present));
  ok('their coming back clears it again', presence.back.opp === 'ok' && presence.back.present === true, JSON.stringify(presence.back));

  /* A player who has not joined yet is not a player who left. */
  const joining = await page.evaluate(() => {
    (0, eval)('pzConnStart()');
    (0, eval)("pzRt.active=true; pzRt.finished=false; pzRt.myId='me'; pzRt.oppPresent=false;");
    (0, eval)("pzHandleWs({type:'server:presence',payload:{users:[{userId:'me'}]}})");
    return (0, eval)('pzConn.opp');
  });
  ok('an opponent who has not arrived yet is not "disconnected"', joining === 'ok', joining);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3 & 4. THE LOSS SCREEN ─────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the screen after a loss:');
  const show = (won) => page.evaluate((w) => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; gameType='duel'; duelStage=1; curStake=50000; duelStakeVal=50000; oppName='زهرا';");
    (0, eval)(w ? 'myScore=5; oppScore=3;' : 'myScore=2; oppScore=6;');
    (0, eval)('endGame(' + (w ? 'true' : 'false') + ', ' + (w ? '22500' : '0') + ', false)');
    (0, eval)("showScreen('result')");
  }, won);

  await show(false);
  await page.waitForTimeout(400);
  const lose = await page.evaluate(() => {
    const amt = document.getElementById('resultAmt'), box = amt.parentElement;
    const sec = document.getElementById('result');
    return {
      title: document.getElementById('resultTitle').textContent,
      sub: document.getElementById('resultSub').textContent,
      subShown: !!document.getElementById('resultSub').offsetParent,
      amtText: amt.textContent, amtShown: !!box.offsetParent,
      all: sec.innerText
    };
  });
  /* «کاربر پول نداده، بلیط داده.» */
  ok('no money figure anywhere on the loss screen', !/۵۰٬۰۰۰|−|-\s*۵۰/.test(lose.amtText), JSON.stringify(lose.amtText));
  ok('and the prize slot is not left standing empty', !lose.amtShown, String(lose.amtShown));
  ok('the whole screen never mentions the stake', !/۵۰٬۰۰۰/.test(lose.all), (lose.all.match(/.{0,20}۵۰٬۰۰۰.{0,20}/) || [''])[0]);
  ok('the headline is the one word', /باختی/.test(lose.title), lose.title);
  ok('and there is a line under it', lose.subShown && lose.sub.length > 6, lose.sub);
  ok('which is encouragement, not an explanation of the score',
     !/این مرحله رو برد|پاسخ اشتباه بود/.test(lose.sub), lose.sub);

  /* It is a different line each time, or it stops being read. */
  const lines = new Set();
  for (let i = 0; i < 25; i++) { const l = await page.evaluate(() => (0, eval)('pzLoseLine()')); lines.add(l); }
  ok('and not the same sentence every time', lines.size >= 3, lines.size + ' different lines');
  const winLines = new Set();
  for (let i = 0; i < 25; i++) { const l = await page.evaluate(() => (0, eval)('pzWinLine()')); winLines.add(l); }
  ok('the win has its own set', winLines.size >= 3 && ![...winLines].some((w) => lines.has(w)), winLines.size + ' different lines');

  /* THE WIN KEEPS ITS PRIZE. */
  await show(true);
  await page.waitForFunction(() => { const t = (document.getElementById('resultAmt') || {}).textContent || ''; return /۲۲٬۵۰۰/.test(t); }, null, { timeout: 12000 }).catch(() => {});
  const win = await page.evaluate(() => {
    const amt = document.getElementById('resultAmt');
    return {
      title: document.getElementById('resultTitle').textContent,
      sub: document.getElementById('resultSub').textContent,
      subShown: !!document.getElementById('resultSub').offsetParent,
      amtText: amt.textContent, amtShown: !!amt.parentElement.offsetParent
    };
  });
  ok('the win still shows the prize', win.amtShown && /۲۲٬۵۰۰/.test(win.amtText), win.amtText);
  ok('and says so', /برنده شدی/.test(win.title), win.title);
  ok('with a line of its own', win.subShown && win.sub.length > 6, win.sub);

  /* Losing after winning must not leave the prize on screen. */
  await show(false);
  await page.waitForTimeout(400);
  const again = await page.evaluate(() => ({ shown: !!document.getElementById('resultAmt').parentElement.offsetParent, txt: document.getElementById('resultAmt').textContent }));
  ok('a loss straight after a win clears the prize away', !again.shown && !/۲۲/.test(again.txt), JSON.stringify(again));

  /* And nothing overlaps now that a line came back. */
  const bad = await page.evaluate(() => {
    const sec = document.getElementById('result');
    const els = [...sec.querySelectorAll('button, .stat, .rb-side, .res-amt, .res-title, .res-sub')]
      .filter((el) => el.offsetParent).filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; });
    const out = [];
    for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
      const A = els[i], B = els[j]; if (A.contains(B) || B.contains(A)) continue;
      const a = A.getBoundingClientRect(), b = B.getBoundingClientRect();
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2)
        out.push((A.textContent || '').trim().slice(0, 14) + ' × ' + (B.textContent || '').trim().slice(0, 14));
    }
    const s = document.getElementById('result');
    return { out, scrolls: s.scrollHeight > s.clientHeight + 1 };
  });
  ok('nothing overlaps with the line back', bad.out.length === 0, bad.out.join(' | '));
  ok('and the screen still fits', !bad.scrolls, String(bad.scrolls));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
