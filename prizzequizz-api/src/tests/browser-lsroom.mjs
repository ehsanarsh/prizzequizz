/* LAST SURVIVOR — the room, as a player actually experiences it.
 *
 *   • A correct answer is the good news of the whole screen and it was a thin
 *     tint behind one line, next to a red card twice its weight.
 *   • Eliminations were stamped four at a time in whatever order the grid
 *     happened to list, and a player's own elimination was a cross on a
 *     thumbnail in the corner. The order is money now — when a round wipes the
 *     room, the LAST one out is the only player paid — so it has to be the
 *     server's order, played out one at a time.
 *   • The board showed the whole pot and never the player's own share, so in a
 *     room of forty you had to do the division yourself.
 *   • And the player paid on a wipe-out was never told why.
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
});
await ctx.route('**/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 180)));
await page.goto('http://127.0.0.1:' + PORT + '/');
await page.waitForTimeout(5200);

/* A room of `n` players with `outIds` knocked out this round. The shape is the
   server's real snapshot shape — anything else would be testing a fiction. */
function room({ n = 8, round = 2, phase = 'elimination', outIds = [], meStatus = 'alive', myShare = 0, pot = 500000, endsIn = 12000 } = {}) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const id = i === 0 ? 'me' : 'p' + i;
    const out = outIds.includes(id);
    players.push({
      userId: id, username: i === 0 ? 'ehsan' : 'بازیکن' + i, avatar: null, color: 'green',
      status: out ? 'eliminated' : (id === 'me' ? meStatus : 'alive'),
      shields: 0, payoutCash: 0, eliminatedRound: out ? round : null, cashedOutRound: null
    });
  }
  const alive = players.filter((p) => p.status === 'alive').length;
  return {
    room: { id: 'r1', topic: 'عمومی', status: 'running', phase, round, totalRounds: 8, capacity: 100, minUsers: 2,
      grossPool: pot, netPool: pot, phaseEndsAt: Date.now() + endsIn, startsAt: Date.now(), serverNow: Date.now(),
      chatEnabled: false, animationsEnabled: true, forfeited: 0, wipeout: null },
    stats: { totalPlayers: n, alive, eliminated: players.filter((p) => p.status === 'eliminated').length,
      cashedOut: 0, grossPot: pot, paidOut: 0, remainingPot: pot, activeUnits: alive },
    players,
    votes: 0,
    me: { userId: 'me', status: players[0].status, color: 'green', units: 1, payoutCash: 0,
      answeredThisRound: true, decisionThisRound: null, currentShare: myShare, eliminatedRound: players[0].eliminatedRound,
      shields: 0, shieldBroke: false, lifelinesUsed: [] }
  };
}

/* The LS screen has to be the VISIBLE one: an inactive screen lays out at zero
   height, and every measurement below is a measurement. */
const render = (snap) => page.evaluate((s) => {
  (0, eval)("showScreen('lsGame')");
  (0, eval)("lsRoomId='r1'; lsMyId='me'; lsEndShown=true; lsLastKey='';");
  (0, eval)('lsRender')(s);
}, snap);

/* ── 1. THE CORRECT ANSWER ──────────────────────────────────────────────── */
{
  console.log('answering correctly:');
  await render(room({ outIds: ['p3', 'p5'], meStatus: 'alive' }));
  await page.waitForTimeout(300);
  const v = await page.evaluate(() => {
    const el = document.querySelector('#lsBody .ls-verdict');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { text: el.innerText, cls: el.className, bg: cs.backgroundImage + ' ' + cs.backgroundColor, h: Math.round(r.height), w: Math.round(r.width) };
  });
  ok('there is a card, not a bare line', !!v && /ls-verdict/.test(v.cls) && v.h >= 44, JSON.stringify({ h: v && v.h, cls: v && v.cls }));
  ok('and it says «آفرین»', /آفرین/.test((v && v.text) || ''), (v && v.text || '').replace(/\n/g, ' '));
  ok('and that the answer was right', /جوابت درست بود/.test((v && v.text) || ''), (v && v.text || '').replace(/\n/g, ' '));
  /* GREEN — and a filled green, not a hint of one behind text. */
  const green = await page.evaluate(() => {
    const el = document.querySelector('#lsBody .ls-verdict');
    const cs = getComputedStyle(el);
    /* Paint it to a canvas so the actual pixel is read, gradient or not. */
    const m = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || [cs.backgroundColor]);
    const nums = m.map((c) => c.match(/[\d.]+/g).map(Number));
    return { first: nums[0], alpha: nums[0] && nums[0].length > 3 ? nums[0][3] : 1 };
  });
  ok('the card is filled green, not a faint tint',
     green.first && green.first[1] > green.first[0] + 40 && green.first[1] > green.first[2] + 40 && green.alpha > 0.8,
     JSON.stringify(green));
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 2. ELIMINATIONS, ONE AT A TIME, IN THE SERVER'S ORDER ──────────────── */
{
  console.log('the elimination sequence:');
  errs.length = 0;
  const outs = ['p2', 'p4', 'p6'];
  /* The server sends its order — deliberately NOT the order the grid lists
     them in, which is what the animation used to follow. */
  const serverOrder = ['p6', 'p2', 'p4'];
  await page.evaluate((o) => {
    (0, eval)("lsElimOrder=" + JSON.stringify({ round: 2, ids: o }));
  }, serverOrder);
  await render(room({ n: 8, round: 2, outIds: outs, meStatus: 'alive', endsIn: 12000 }));

  /* Watch which card lights up, and when. */
  /* WHAT «being eliminated on screen» ACTUALLY IS.
     The cards are BUILT carrying the eliminated styling, and the animation
     hides it again with `pending-out` and takes it off one at a time. So the
     moment a player is seen to go out is the moment `pending-out` LEAVES their
     card — watching for the eliminated class instead would see all of them at
     once, on the first frame, and prove nothing. */
  const seq = await page.evaluate(async () => {
    const seen = [];
    const t0 = performance.now();
    const grid = document.getElementById('lsElimGrid');
    const cells = [...grid.querySelectorAll('.ls-pl')];
    const names = cells.map((c) => (c.querySelector('small') || {}).textContent || '');
    const pending = cells.map((c) => c.classList.contains('pending-out'));
    const iv = setInterval(() => {
      cells.forEach((c, i) => {
        if (!pending[i]) return;
        if (!c.classList.contains('pending-out') && !seen.some((s) => s.i === i)) seen.push({ i, name: names[i], at: Math.round(performance.now() - t0) });
      });
    }, 25);
    await new Promise((r) => setTimeout(r, 4600));
    clearInterval(iv);
    return { seen, hiddenAtStart: pending.filter(Boolean).length };
  });
  ok('every card going out is hidden first, then revealed', seq.hiddenAtStart === 3, String(seq.hiddenAtStart));
  ok('all three are played out', seq.seen.length === 3, JSON.stringify(seq.seen.map((s) => s.name)));
  /* p6 is the 6th cell, p2 the 2nd, p4 the 4th — so the ORDER is the server's,
     not the grid's. If it followed the grid it would be 2, 4, 6. */
  ok('in the SERVER’s order, not the grid’s', seq.seen.map((s) => s.i).join(',') === '6,2,4', seq.seen.map((s) => s.i).join(','));
  const gaps = seq.seen.slice(1).map((s, i) => s.at - seq.seen[i].at);
  ok('about a second apart, not all at once', gaps.every((g) => g >= 800 && g <= 1400), JSON.stringify(gaps));
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 3. YOUR OWN ELIMINATION ────────────────────────────────────────────── */
{
  console.log('your own turn to go out:');
  errs.length = 0;
  await page.evaluate(() => { (0, eval)("lsElimOrder=" + JSON.stringify({ round: 3, ids: ['p3', 'me'] })); });
  await render(room({ n: 8, round: 3, outIds: ['p3', 'me'], meStatus: 'eliminated', endsIn: 12000 }));

  /* Nothing at first — the other player goes out before you. */
  await page.waitForTimeout(700);
  const early = await page.evaluate(() => !!document.getElementById('lsMeOut'));
  ok('it waits for your turn in the order', !early, String(early));

  await page.waitForTimeout(1400);
  const mine = await page.evaluate(() => {
    const box = document.getElementById('lsMeOut');
    if (!box) return null;
    const card = box.querySelector('.lsmo-card'), x = box.querySelector('.lsmo-x'), av = box.querySelector('.lsmo-av');
    const gridCell = document.querySelector('#lsElimGrid .ls-pl .av');
    const cr = card.getBoundingClientRect(), xr = x.getBoundingClientRect(), gr = gridCell.getBoundingClientRect();
    return {
      shown: !!box.offsetParent, went: box.classList.contains('go'),
      cardArea: Math.round(cr.width * cr.height), cellArea: Math.round(gr.width * gr.height),
      xFontPx: Math.round(parseFloat(getComputedStyle(x).fontSize)),
      xOverCard: xr.width > cr.width * 0.5 && xr.height > cr.height * 0.5,
      hasPicture: !!av, text: box.innerText.replace(/\s+/g, ' ').trim(),
      centred: Math.abs((cr.left + cr.width / 2) - window.innerWidth / 2) < 30
    };
  });
  ok('your own elimination comes forward', !!mine && mine.shown && mine.went, JSON.stringify(mine && { shown: mine.shown, went: mine.went }));
  ok('and it is your picture', !!mine && mine.hasPicture);
  /* «عکس پروفایلش از تو روم بیاد جلو بزرگ بشه» — measurably bigger than the
     little card it came from. */
  ok('much bigger than the card in the grid', !!mine && mine.cardArea > mine.cellArea * 6,
     mine && (mine.cardArea + 'px² vs ' + mine.cellArea + 'px²'));
  ok('in the middle of the screen', !!mine && mine.centred, JSON.stringify(mine && mine.centred));
  /* «یه ضربدر گنده روش بیاد» — over the picture, not a badge beside it. */
  ok('with a big cross over it', !!mine && mine.xFontPx >= 90 && mine.xOverCard, mine && (mine.xFontPx + 'px'));
  /* innerText reads hidden text too, so «is it there» proves nothing — the
     caption fades in after the cross and has to be checked once it has. */
  await page.waitForTimeout(900);
  const caption = await page.evaluate(() => {
    const t = document.querySelector('#lsMeOut .lsmo-txt');
    if (!t) return null;
    const r = t.getBoundingClientRect(), cs = getComputedStyle(t);
    return { text: t.textContent, opacity: Number(cs.opacity), onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.height > 8 };
  });
  ok('and it says so, in words you can actually see',
     !!caption && /حذف شدی/.test(caption.text) && caption.opacity > 0.9 && caption.onScreen,
     JSON.stringify(caption));

  /* It clears itself, or it would sit over the next round. */
  await page.waitForTimeout(2200);
  const gone = await page.evaluate(() => !!document.getElementById('lsMeOut'));
  ok('and it clears itself away', !gone, String(gone));
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 4. THE PLAYER'S OWN SHARE ──────────────────────────────────────────── */
{
  console.log('the player’s own share:');
  errs.length = 0;
  /* Round 4, not 2: the client REFUSES a snapshot older than the one on screen
     (a late poll must never drag the room backwards), and §3 above left it on
     round 3. Going backwards here would silently test the previous render. */
  await render(room({ n: 10, round: 4, phase: 'dashboard', outIds: ['p7'], meStatus: 'alive', myShare: 62500, pot: 500000 }));
  await page.waitForTimeout(300);
  const board = await page.evaluate(() => {
    const el = document.getElementById('lsMyShare');
    return { shown: !!el && !!el.offsetParent, value: el && el.textContent, all: document.getElementById('lsBody').innerText,
             dbg: (document.getElementById('lsBody')||{}).innerHTML.slice(0,260) };
  });
  if (!board.shown) console.log('      dbg:', board.dbg);
  ok('the board shows what the round is worth to YOU', board.shown, String(board.shown));
  ok('as the server’s own figure', /۶۲٬۵۰۰/.test(board.value || ''), board.value);
  ok('labelled as your share', /سهم تو/.test(board.all || ''), (board.all || '').match(/.{0,12}سهم تو.{0,12}/) ? (board.all.match(/.{0,12}سهم تو.{0,12}/) || [''])[0] : '');
  ok('beside the whole pot, not instead of it', /جایزه/.test(board.all || ''), '');

  /* A player who is out has no share, and must not be shown a figure. */
  await render(room({ n: 10, round: 5, phase: 'dashboard', outIds: ['me'], meStatus: 'eliminated', myShare: 0 }));
  await page.waitForTimeout(250);
  const out = await page.evaluate(() => {
    const el = document.getElementById('lsMyShare');
    return { shown: !!el && !!el.offsetParent };
  });
  ok('somebody who is out is offered no share', !out.shown, String(out.shown));
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 5. THE WIPE-OUT MESSAGE ────────────────────────────────────────────── */
{
  console.log('being the last one out of a wiped room:');
  errs.length = 0;
  const snap = room({ n: 6, round: 6, phase: 'finished', outIds: ['me', 'p1', 'p2', 'p3', 'p4', 'p5'], meStatus: 'eliminated' });
  snap.room.status = 'finished';
  snap.room.wipeout = { lastUserId: 'me', share: 41000, splitAmong: 6 };
  snap.me.payoutCash = 41000;
  snap.me.eliminatedRound = 6;
  await page.evaluate((s) => {
    (0, eval)("lsRoomId='r1'; lsMyId='me'; lsEndShown=false; lsForfeited=0; lsWipeout=null;");
    (0, eval)('lsFinish')(s);
  }, snap);
  await page.waitForTimeout(600);
  const end = await page.evaluate(() => ({
    title: document.getElementById('resultTitle').textContent,
    sub: document.getElementById('resultSub').textContent,
    amt: document.getElementById('resultAmt').textContent,
    amtShown: !!document.getElementById('resultAmt').parentElement.offsetParent
  }));
  ok('the last one out is told they were', /آخرین نفر/.test(end.title), end.title);
  ok('and why they are being paid', /همه اشتباه جواب دادند/.test(end.sub), end.sub);
  ok('naming how many the pot was split among', /۶/.test(end.sub), end.sub);
  ok('and their share is shown as a prize', end.amtShown && /۴۱٬۰۰۰/.test(end.amt), end.amt);

  /* Anybody ELSE from the same wiped room is not paid and is not told they were. */
  const snap2 = JSON.parse(JSON.stringify(snap));
  snap2.me.userId = 'me'; snap2.room.wipeout = { lastUserId: 'p4', share: 41000, splitAmong: 6 };
  snap2.me.payoutCash = 0;
  await page.evaluate((s) => {
    (0, eval)("lsEndShown=false; lsWipeout=null;");
    (0, eval)('lsFinish')(s);
  }, snap2);
  await page.waitForTimeout(500);
  const other = await page.evaluate(() => ({
    title: document.getElementById('resultTitle').textContent,
    amtShown: !!document.getElementById('resultAmt').parentElement.offsetParent
  }));
  ok('everyone else is simply out', !/آخرین نفر/.test(other.title), other.title);
  ok('and is shown no money', !other.amtShown, String(other.amtShown));
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
