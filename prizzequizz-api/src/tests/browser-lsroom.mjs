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
/* The room the poller reads. A spectator's whole existence is «keep polling
   this room», so the test has to be able to hand it new snapshots. */
let liveSnap = null;
const answerAttempts = [];
await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (/^\/last-survivor\/rooms\/[^/]+\/answer$/.test(p)) { answerAttempts.push(1); return send({ recorded: true }); }
  if (/^\/last-survivor\/rooms\/[^/]+$/.test(p)) return send(liveSnap || {});
  return send({});
});
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
  /* The share COUNTS UP to its new figure now, so reading it at once catches it
     part way through the climb. Waited out on purpose: the number under test is
     where it lands, not where it was passing. */
  await page.waitForTimeout(3400);
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

/* ── 6. WATCHING AFTER BEING KNOCKED OUT ────────────────────────────────── */
{
  console.log('watching the rest of the match:');
  errs.length = 0;

  /* Knocked out on round 3 of an eight-round match — the room plays on. */
  const out = room({ n: 8, round: 3, phase: 'dashboard', outIds: ['me', 'p5'], meStatus: 'eliminated' });
  out.me.eliminatedRound = 3;
  liveSnap = out;
  await page.evaluate((s) => {
    (0, eval)("lsRoomId='r1'; lsMyId='me'; lsEndShown=false; lsForfeited=0; lsWipeout=null; lsWatching=false; lsWatchRoomDone=false;");
    (0, eval)('lsFinish')(s);
  }, out);
  await page.waitForTimeout(500);

  const btn = await page.evaluate(() => {
    const b = document.getElementById('lsWatchBtn');
    return b ? { shown: !!b.offsetParent, text: b.textContent, disabled: b.disabled } : null;
  });
  ok('a knocked-out player is offered the match to watch', !!btn && btn.shown, JSON.stringify(btn));
  ok('and it is not disabled while the room is still playing', !!btn && !btn.disabled, String(btn && btn.disabled));
  ok('the button says what it does', /تماشا/.test((btn && btn.text) || ''), btn && btn.text);

  /* Pressing it puts them back in the room. */
  await page.evaluate(() => document.getElementById('lsWatchBtn').click());
  await page.waitForTimeout(1400);
  const watching = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id,
    on: (0, eval)('lsWatching'),
    bar: !!document.querySelector('#lsBody .ls-watchbar'),
    text: (document.getElementById('lsBody') || {}).innerText || ''
  }));
  ok('the room comes back', watching.screen === 'lsGame' && watching.on === true, JSON.stringify({ s: watching.screen, on: watching.on }));
  ok('with an unmistakable spectator banner', watching.bar, String(watching.bar));
  ok('that says they are out', /تماشاگر|حذف شدی/.test(watching.text), (watching.text.match(/.{0,26}تماشاگر.{0,26}/) || [''])[0]);

  /* A QUESTION GOES UP. They see it — and cannot answer it. */
  const q = room({ n: 8, round: 4, phase: 'question', outIds: ['me', 'p5'], meStatus: 'eliminated' });
  q.me.eliminatedRound = 3; q.me.answeredThisRound = false;
  q.question = { id: 'q4', round: 4, text: 'پایتخت ژاپن کجاست؟', options: ['توکیو', 'اوساکا', 'کیوتو', 'ناگویا'], difficulty: 'medium' };
  liveSnap = q;
  await page.evaluate((s) => { (0, eval)('lsRender')(s); }, q);
  await page.waitForTimeout(400);
  const seeing = await page.evaluate(() => {
    const opts = [...document.querySelectorAll('#lsOpts .ans')];
    return {
      question: (document.querySelector('.ls-qtext') || {}).textContent || '',
      options: opts.length,
      allDead: opts.length > 0 && opts.every((b) => b.disabled),
      anyOnclick: opts.some((b) => b.getAttribute('onclick')),
      bar: !!document.querySelector('#lsBody .ls-watchbar')
    };
  });
  ok('the spectator sees the question', /ژاپن/.test(seeing.question), seeing.question);
  ok('and all four options', seeing.options === 4, String(seeing.options));
  ok('but every one of them is dead', seeing.allDead, String(seeing.allDead));
  ok('and none of them is even wired to answer', !seeing.anyOnclick, String(seeing.anyOnclick));
  ok('the banner stays up over the question', seeing.bar, String(seeing.bar));

  /* Even forcing the call must not send an answer. */
  const before = answerAttempts.length;
  await page.evaluate(() => { try { (0, eval)('lsAnswer')(0); } catch (e) {} });
  await page.waitForTimeout(400);
  ok('and calling the answer path directly sends nothing', answerAttempts.length === before, String(answerAttempts.length - before));

  /* «حذف شدن هارو ببینه» — the eliminations play for them too. */
  const elim = room({ n: 8, round: 4, phase: 'elimination', outIds: ['me', 'p5', 'p2'], meStatus: 'eliminated' });
  elim.me.eliminatedRound = 3;
  liveSnap = elim;
  await page.evaluate((s) => { (0, eval)('lsRender')(s); }, elim);
  await page.waitForTimeout(400);
  const grid = await page.evaluate(() => ({
    cells: document.querySelectorAll('#lsElimGrid .ls-pl').length,
    marks: document.querySelectorAll('#lsElimGrid .ls-pl .xx').length
  }));
  ok('and watches the eliminations happen', grid.cells === 8 && grid.marks >= 2, JSON.stringify(grid));

  /* «ببینه کی برنده میشه» — the ending, named. */
  const done = room({ n: 8, round: 6, phase: 'finished', outIds: ['me', 'p5', 'p2', 'p3', 'p6', 'p7'], meStatus: 'eliminated' });
  done.room.status = 'finished';
  done.players.find((x) => x.userId === 'p1').payoutCash = 320000;
  done.me.eliminatedRound = 3;
  liveSnap = done;
  await page.evaluate((s) => { (0, eval)('lsRender')(s); }, done);
  await page.waitForTimeout(700);
  const ending = await page.evaluate(() => ({
    text: (document.getElementById('lsBody') || {}).innerText || '',
    still: (0, eval)('lsWatching'),
    doneFlag: (0, eval)('lsWatchRoomDone')
  }));
  ok('the winner is named', /بازیکن1/.test(ending.text), (ending.text.match(/.{0,30}بازیکن1.{0,20}/) || [''])[0]);
  ok('with what they won', /۳۲۰٬۰۰۰/.test(ending.text), (ending.text.match(/.{0,16}۳۲۰٬۰۰۰.{0,10}/) || [''])[0]);
  ok('and the room is marked finished', ending.doneFlag === true, String(ending.doneFlag));

  /* Back to their own result screen, and the button is now dead — there is
     nothing left to watch. «اگه آخرین نفر باشه این دکمه براش غیر فعال باشه» */
  await page.evaluate(() => { try { (0, eval)('lsStopWatching()'); } catch (e) {} });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const b = document.getElementById('lsWatchBtn');
    return { screen: (document.querySelector('.screen.active') || {}).id, watching: (0, eval)('lsWatching'),
             disabled: b && b.disabled, text: b && b.textContent };
  });
  ok('they are returned to their own result', after.screen === 'result' && after.watching === false, JSON.stringify(after));
  ok('and the button is dead once the match is over', after.disabled === true, String(after.disabled));
  ok('saying so', /تمام شد/.test(after.text || ''), after.text);
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 6b. WHAT A SPECTATOR MUST NEVER GET ────────────────────────────────── */
{
  console.log('what a spectator is spared:');
  errs.length = 0;
  /* A clean slate: an earlier block's modal still on screen would be read as
     this one's gate, and the room screen has to be the visible one. */
  await page.evaluate(() => {
    try { (0, eval)('closeAaaModal')(false); } catch (e) {}
    (0, eval)("showScreen('lsGame')");
    /* lsSnap still holds §6's FINISHED room, and the client quite rightly
       refuses to un-finish a room — every snapshot below would be dropped as
       stale. A new scenario starts from no snapshot at all. */
    (0, eval)("lsSnap=null; lsWatching=true; lsWatchRoom='r1'; lsWatchRoomDone=false; lsEndShown=true; lsReadyShownRound=0; lsRoomId='r1'; lsLastKey='';");
  });
  await page.waitForTimeout(300);

  /* «مودال تایمر سوال همان روم برای کاربر حذف شده … میاره بالا و تایمر تموم
     می‌شه و می‌ره» — the «آماده‌ای؟» countdown is a question asked of somebody
     about to answer, and a spectator is not.
     What that turned into: the spectator got NO countdown at all, and the
     question card behind it was already rendered — so a second device watching
     the same room could read the question before the people answering it. They
     wait the same wait as everyone else now; what they must not get is the
     wording that says they are about to answer. */
  const ready = room({ n: 8, round: 9, phase: 'ready', outIds: ['me'], meStatus: 'eliminated' });
  ready.me.eliminatedRound = 3;
  ready.question = { id: 'q9', round: 9, text: 'سوال آماده', options: ['یک', 'دو', 'سه', 'چهار'], difficulty: 'hard' };
  await page.evaluate((sn) => { (0, eval)('lsRender')(sn); }, ready);
  await page.waitForTimeout(500);
  const gate = await page.evaluate(() => {
    const m = document.getElementById('aaaModal');
    return { open: !!m && m.classList.contains('show') && getComputedStyle(m).display !== 'none',
             text: m ? (m.innerText || '').slice(0, 40) : '' };
  });
  ok('a spectator waits out the countdown like everyone else', gate.open, JSON.stringify(gate));
  ok('but is never asked «آماده‌ای؟»', !/آماده/.test(gate.text), gate.text);
  /* The point of making them wait: the question stays unreadable until the
     round opens for everybody. */
  const hidden = await page.evaluate(() => {
    const q = document.querySelector('#lsBody .ls-qtext');
    return { has: !!q, vis: q ? getComputedStyle(q).visibility : '',
             gate: (document.querySelector('#lsBody .ls-qwrap') || { dataset: {} }).dataset.gate };
  });
  ok('and the question is covered while they wait', hidden.vis === 'hidden' && hidden.gate === '1', JSON.stringify(hidden));

  /* AND THE WAY IT ACTUALLY HAPPENED. A knocked-out player is sent to the
     result screen, but the room's websocket pushes keep arriving — and one of
     them opened the «آماده‌ای؟» countdown on top of their result screen, which
     then ran out and closed itself. They are not in the round; nothing about it
     may be put in front of them. */
  const stray = await page.evaluate(async () => {
    try { (0, eval)('closeAaaModal')(false); } catch (e) {}
    (0, eval)("lsSnap=null; lsWatching=false; lsEndShown=true; lsReadyShownRound=0; lsLastKey='';");
    (0, eval)("showScreen('result')");
    await new Promise((r) => setTimeout(r, 200));
    return true;
  });
  const late = room({ n: 8, round: 13, phase: 'ready', outIds: ['me'], meStatus: 'eliminated' });
  late.me.eliminatedRound = 3;
  late.question = { id: 'q13', round: 13, text: 'سوال بعدی', options: ['یک', 'دو', 'سه', 'چهار'], difficulty: 'hard' };
  await page.evaluate((sn) => { (0, eval)('lsRender')(sn); }, late);
  await page.waitForTimeout(600);
  const strayGate = await page.evaluate(() => {
    const m = document.getElementById('aaaModal');
    return { open: !!m && m.classList.contains('show') && getComputedStyle(m).display !== 'none',
             text: m ? (m.innerText || '').replace(/\s+/g, ' ').slice(0, 40) : '' };
  });
  ok('nor on a knocked-out player still sitting on their result screen',
     !strayGate.open || !/آماده/.test(strayGate.text), JSON.stringify(strayGate));
  /* Back into the spectator's chair for the rest of this block — the check
     above deliberately took them out of it. */
  await page.evaluate(async () => {
    try { (0, eval)('closeAaaModal')(false); } catch (e) {}
    (0, eval)("showScreen('lsGame')");
    (0, eval)("lsSnap=null; lsWatching=true; lsWatchRoom='r1'; lsWatchRoomDone=false; lsEndShown=true; lsReadyShownRound=0; lsRoomId='r1'; lsLastKey='';");
    await new Promise((r) => setTimeout(r, 150));
  });

  /* And the room does not throw them back out to the result screen. The signal
     is lsEndShown: lsFinish sets it, so if it is still false the guard held and
     the spectator was left where they are. */
  const dash = room({ n: 8, round: 14, phase: 'dashboard', outIds: ['me'], meStatus: 'eliminated' });
  dash.me.eliminatedRound = 3;
  await page.evaluate((sn) => { (0, eval)("lsEndShown=false;"); (0, eval)('lsRender')(sn); }, dash);
  await page.waitForTimeout(400);
  const still = await page.evaluate(() => ({
    finished: (0, eval)('lsEndShown'),
    screen: (document.querySelector('.screen.active') || {}).id,
    bar: !!document.querySelector('#lsBody .ls-watchbar')
  }));
  ok('a spectator is not ejected back to their result screen', still.finished === false && still.screen === 'lsGame', JSON.stringify(still));
  ok('and keeps the banner', still.bar, String(still.bar));

  /* Their own elimination verdict from three rounds ago must not follow them
     around the rest of the match. */
  const elim = room({ n: 8, round: 15, phase: 'elimination', outIds: ['me', 'p4'], meStatus: 'eliminated' });
  elim.me.eliminatedRound = 3;
  await page.evaluate((sn) => { (0, eval)('lsRender')(sn); }, elim);
  await page.waitForTimeout(400);
  const verdict = await page.evaluate(() => ({
    has: !!document.querySelector('#lsBody .ls-verdict'),
    text: (document.getElementById('lsBody') || {}).innerText || ''
  }));
  ok('no stale «شما حذف شدید» card follows them', !verdict.has, String(verdict.has));
  await page.evaluate(() => { (0, eval)("lsWatching=false; lsEndShown=true;"); });
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 6c. THE ANSWER CLOCK IN LAST SURVIVOR ──────────────────────────────── */
{
  console.log('the average answer time in Last Survivor:');
  errs.length = 0;
  const t = await page.evaluate(async () => {
    (0, eval)("lsSnap=null; lsWatching=false; lsEndShown=true; lsRoomId='r1'; lsMyId='me'; lsAnswered=false; pzAnsTimes=[]; pzQShownAt=0; lsLastKey='';");
    return { before: (0, eval)('pzAvgAnswerText()') };
  });
  ok('with nothing answered it honestly says nothing', t.before === '—', t.before);

  /* A question goes up, the player thinks for a moment, then answers. */
  const q = room({ n: 6, round: 12, phase: 'question', outIds: [], meStatus: 'alive' });
  q.me.answeredThisRound = false;
  q.question = { id: 'q12', round: 12, text: 'دو بعلاوهٔ دو؟', options: ['۴', '۳', '۵', '۶'], difficulty: 'easy' };
  await page.evaluate((sn) => { (0, eval)("lsLastKey=''; lsAnswered=false;"); (0, eval)('lsRender')(sn); }, q);
  await page.waitForTimeout(1200);                      // thinking
  const after = await page.evaluate(async () => {
    const marked = (0, eval)('pzQShownAt') > 0;
    (0, eval)("lsSnap.room.phase='question'; lsSnap.me.status='alive';");
    await (0, eval)('lsAnswer')(0);
    await new Promise((r) => setTimeout(r, 200));
    return { marked, times: (0, eval)('pzAnsTimes.slice()'), text: (0, eval)('pzAvgAnswerText()') };
  });
  ok('the clock starts when the question appears', after.marked, String(after.marked));
  ok('and stops when the player answers', after.times.length === 1, JSON.stringify(after.times));
  ok('so the result card gets a real figure, not a dash', after.text !== '—' && /ث$/.test(after.text), after.text);
  ok('and the figure is roughly how long they took', after.times[0] >= 900 && after.times[0] <= 4000, after.times[0] + 'ms');
  /* And it has to reach the CARD — the whole complaint was «میانگین پاسخ - است»
     on the result screen, not that a function somewhere knew better. */
  const onCard = await page.evaluate((sn) => {
    (0, eval)("lsEndShown=false; lsWatching=false; lsWipeout=null;");
    (0, eval)('lsFinish')(sn);
    return (document.getElementById('stat-time') || {}).textContent;
  }, (() => { const f = room({ n: 6, round: 13, phase: 'finished', outIds: ['me'], meStatus: 'eliminated' }); f.room.status = 'finished'; f.me.eliminatedRound = 13; return f; })());
  await page.waitForTimeout(400);
  ok('and the result card prints it instead of a dash', onCard !== '—' && /ث/.test(onCard || ''), onCard);
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 7. THE LAST ONE OUT HAS NOTHING TO WATCH ───────────────────────────── */
{
  console.log('being the last one out:');
  errs.length = 0;
  const snap = room({ n: 5, round: 7, phase: 'finished', outIds: ['me', 'p1', 'p2', 'p3', 'p4'], meStatus: 'eliminated' });
  snap.room.status = 'finished';
  snap.room.wipeout = { lastUserId: 'me', share: 30000, splitAmong: 5 };
  snap.me.payoutCash = 30000; snap.me.eliminatedRound = 7;
  liveSnap = snap;
  await page.evaluate((s) => {
    (0, eval)("lsRoomId='r1'; lsMyId='me'; lsEndShown=false; lsWatching=false; lsWatchRoomDone=false; lsWipeout=null;");
    (0, eval)('lsFinish')(s);
  }, snap);
  await page.waitForTimeout(500);
  const b = await page.evaluate(() => {
    const el = document.getElementById('lsWatchBtn');
    return el ? { shown: !!el.offsetParent, disabled: el.disabled, text: el.textContent } : null;
  });
  ok('the button is there but dead', !!b && b.disabled === true, JSON.stringify(b));
  ok('and says the match is over', /تمام شد/.test((b && b.text) || ''), b && b.text);
  /* And pressing it anyway does nothing. */
  const moved = await page.evaluate(async () => {
    try { (0, eval)('lsWatchMatch()'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    return { screen: (document.querySelector('.screen.active') || {}).id, watching: (0, eval)('lsWatching') };
  });
  ok('and forcing it changes nothing', moved.screen !== 'lsGame' && moved.watching === false, JSON.stringify(moved));
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── 8. THE RESULT SCREEN'S OWN CHARACTER, IN LAST SURVIVOR ─────────────── */
{
  console.log('the character on the Last Survivor result screen:');
  errs.length = 0;
  const snap = room({ n: 6, round: 5, phase: 'finished', outIds: ['me'], meStatus: 'eliminated' });
  snap.room.status = 'finished'; snap.me.eliminatedRound = 5;
  await page.evaluate((s) => {
    (0, eval)("lsRoomId='r1'; lsMyId='me'; lsEndShown=false; lsWatching=false; lsWipeout=null;");
    (0, eval)('lsFinish')(s);
  }, snap);
  await page.waitForTimeout(900);
  const face = await page.evaluate(() => {
    const ms = document.getElementById('mascotResult');
    const rc = document.getElementById('resultChar');
    const emoji = document.getElementById('resultCharEmoji');
    return {
      mascotShown: !!(ms && ms.offsetParent),
      charShown: !!(rc && rc.offsetParent),
      emojiShown: !!(emoji && emoji.offsetParent),
      emoji: emoji && emoji.textContent,
      titleCls: document.getElementById('resultTitle').className
    };
  });
  /* «به جای عکس winchar/losechar عکس پروفایل کاربر نشون داده میشه» — the mascot
     slot is the player's own face, and it must not be what a result screen
     shows. With no losechar on this test server the honest fallback is the
     emoji; what must NOT happen is the profile picture. */
  ok('the player’s own face is not used as the result character', !face.mascotShown, JSON.stringify(face));
  ok('the win/lose slot is what fills it', face.charShown || face.emojiShown, JSON.stringify(face));
  ok('and a loss is coloured as one', /lose/.test(face.titleCls), face.titleCls);
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── THE WRONG ANSWER, SAID AS LOUDLY AS THE RIGHT ONE ─────────────────── */
/* «وقتی در آخرین بازمانده جواب غلط میدی یه نوشته قرمز میاد بدون کارت و بدون پس
 * زمینه. باید با پس زمینه باشه و حس جواب غلط رو به کاربر بده، نوشته ها خوانا و
 * بزرگ باشه.»
 *
 * Surviving got a filled green panel; being knocked out — the END of the match
 * for this player — got one thin tinted line with the correct answer, an
 * em-dash and the news all run together. */
{
  console.log('\nanswering wrong and going out:');
  errs.length = 0;
  const out = room({ n: 8, round: 3, outIds: ['me', 'p4'], meStatus: 'eliminated' });
  out.me.status = 'eliminated'; out.me.eliminatedRound = 3;
  out.me.reveal = { options: ['الف', 'ب', 'پ', 'ت'], correctIndex: 2, yourIndex: 0, timedOut: false };
  await render(out);
  await page.waitForTimeout(400);
  const v = await page.evaluate(() => {
    const el = document.querySelector('#lsBody .ls-verdict');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const head = el.querySelector('.lsv-head'), line = el.querySelector('.lsv-line'), gone = el.querySelector('.lsv-out');
    const px = (e) => (e ? parseFloat(getComputedStyle(e).fontSize) : 0);
    const m = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || [cs.backgroundColor]);
    const nums = m.map((c) => (c.match(/[\d.]+/g) || []).map(Number));
    return {
      cls: el.className, h: Math.round(el.getBoundingClientRect().height),
      text: el.innerText.replace(/\n/g, ' | '),
      fill: nums[0], alpha: nums[0] && nums[0].length > 3 ? nums[0][3] : 1,
      headPx: px(head), linePx: px(line), gonePx: px(gone),
      cross: !!el.querySelector('.lsv-x'),
      lines: { head: !!head, line: !!line, gone: !!gone }
    };
  });
  ok('there is a card at all', !!v && /ls-verdict/.test(v.cls), JSON.stringify(v && v.cls));
  /* «بدون کارت و بدون پس زمینه» was the complaint — a filled panel, not a tint. */
  ok('it is filled red, not a faint tint',
     v.fill && v.fill[0] > v.fill[1] + 60 && v.fill[0] > v.fill[2] + 60 && v.alpha > 0.8, JSON.stringify({ fill: v.fill, alpha: v.alpha }));
  ok('and it has real height, not one line', v.h >= 120, v.h + 'px');
  /* «نوشته ها خوانا و بزرگ باشه» */
  ok('what happened is said large', v.headPx >= 20, v.headPx + 'px');
  ok('the correct answer is readable', v.linePx >= 15, v.linePx + 'px');
  ok('and being out is said large too', v.gonePx >= 16, v.gonePx + 'px');
  /* «حس جواب غلط رو به کاربر بده» — three separate lines rather than one run-on
     sentence with a dash in the middle of it. */
  ok('the three pieces each have their own line', v.lines.head && v.lines.line && v.lines.gone, JSON.stringify(v.lines));
  ok('with a cross that lands on it', v.cross === true, String(v.cross));
  ok('it says the answer was wrong', /پاسخ اشتباه بود/.test(v.text), v.text);
  ok('it gives the right answer', /پاسخ درست/.test(v.text), v.text);
  ok('and that they are out of the match', /حذف شدی/.test(v.text), v.text);
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── RUNNING OUT OF TIME IS NOT ANSWERING WRONG ────────────────────────── */
{
  console.log('\nrunning out of time:');
  errs.length = 0;
  const out = room({ n: 8, round: 3, outIds: ['me'], meStatus: 'eliminated' });
  out.me.status = 'eliminated'; out.me.eliminatedRound = 3;
  out.me.reveal = { options: ['الف', 'ب', 'پ', 'ت'], correctIndex: 1, yourIndex: null, timedOut: true };
  await render(out);
  await page.waitForTimeout(400);
  const v = await page.evaluate(() => {
    const el = document.querySelector('#lsBody .ls-verdict');
    return el ? { text: el.innerText.replace(/\n/g, ' | '), cls: el.className,
                  h: Math.round(el.getBoundingClientRect().height) } : null;
  });
  ok('it is the same card', !!v && /ls-out/.test(v.cls) && v.h >= 120, JSON.stringify({ cls: v && v.cls, h: v && v.h }));
  ok('and says the time ran out', /زمان تمام شد/.test(v.text), v.text);
  ok('not that the answer was wrong', !/پاسخ اشتباه بود/.test(v.text), v.text);
  ok('still telling them they are out', /حذف شدی/.test(v.text), v.text);
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

/* ── AND A SPECTATOR CARRIES NO VERDICT ────────────────────────────────── */
{
  console.log('\nwatching after going out:');
  errs.length = 0;
  const out = room({ n: 8, round: 6, outIds: ['me', 'p2'], meStatus: 'eliminated' });
  out.me.status = 'eliminated'; out.me.eliminatedRound = 3;
  await page.evaluate(() => { (0, eval)('lsWatching=true;'); });
  await render(out);
  await page.waitForTimeout(400);
  const has = await page.evaluate(() => !!document.querySelector('#lsBody .ls-verdict'));
  ok('no verdict is shown to a spectator', has === false, String(has));
  await page.evaluate(() => { (0, eval)('lsWatching=false;'); });
  ok('no script errors', errs.length === 0, errs.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
