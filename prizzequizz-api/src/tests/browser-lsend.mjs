/* WHAT HAPPENS WHEN A LAST SURVIVOR MATCH ENDS.
 *
 *   • «وقتی کاربر مسابقه اش تمام شد اگر موزیک برای کاربر روشن بود — چه با
 *      برداشت چه با برد چه با حذف — بپرسه که میخوای موزیک ادامه پیدا کنه یا
 *      تموم بشه. اگه گفت ادامه یه دکمه کوچیک پلی در صفحه شناور میمونه که وقتی
 *      روش میزنی از بغلش یه دکمه نکست هم میزنه بیرون… تا هر موقع خواست استوپ
 *      کنه. و اگه دوباره خواست موزیک گوش بده باید بره آخرین بازمانده.»
 *   • «وقتی کاربر تنها در روم میمونه و وقت تموم میشه مینویسه مسابقه تمام شد و
 *      همونجا میمونه… باید اونو بندازه بیرون و بهش بگه فعلا حریفی برای تو وجود
 *      نداره.»
 *   • «وقتی کسی حذف میشه و جایزه با موشن عددش بالا میره، اون عدد اول باید
 *      بصورت بزرگ با موشن بیاد وسط صفحه… رنگش سبز بشه سه بار چشمک بزنه… و بعد
 *      بره سر جای خودش اون بالا.»
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };
/* The figures on screen are in Persian digits; these tests care about the
   number, not the script it is written in. */
const en = (s) => Number(String(s || '').replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[^\d]/g, ''));

/* A real, long-enough WAV so «is it playing» is answered by the element. */
function wav(seconds = 30, rate = 8000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate, 28);
  buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44);
  return buf;
}
const TRACK = wav(30);

const server = http.createServer((q, r) => {
  const url = q.url.split('?')[0];
  if (url.startsWith('/track/')) {
    const range = String(q.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, TRACK.length - Number(m[2]));
      const end = m[1] ? (m[2] ? Number(m[2]) : TRACK.length - 1) : TRACK.length - 1;
      const chunk = TRACK.subarray(start, end + 1);
      r.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${TRACK.length}`, 'content-length': chunk.length });
      return r.end(chunk);
    }
    r.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': TRACK.length });
    return r.end(TRACK);
  }
  const f = path.join(ROOT, url === '/' ? 'prizze-v643.html' : decodeURIComponent(url));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = 'http://127.0.0.1:' + PORT;

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--autoplay-policy=no-user-gesture-required']
});

const tracks = [{ id: 't1', url: '/track/t1' }, { id: 't2', url: '/track/t2' }, { id: 't3', url: '/track/t3' }];

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5 }));
    localStorage.setItem('pq_user_plan', 'premium');
  });
  const calls = [];
  await ctx.route('**/v1/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^.*\/v1/, '');
    calls.push(route.request().method() + ' ' + p);
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/waiting-music') return send({ tracks });
    if (p === '/users/me') return send({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5, balances: { wallet: 0 } });
    if (p === '/wallet') return send({ available: 0, locked: 0, tickets: { green: 2, blue: 0, red: 0 } });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(5200);
  await page.evaluate((o) => { window.__origin = o; }, ORIGIN);
  await page.evaluate(() => {
    (0, eval)("lsMusicSrc=function(t){ return t&&t.url ? (/^https?:/.test(t.url)? t.url : window.__origin+t.url) : ''; };");
  });
  return { ctx, page, errs, calls };
}

const SNAP = (over = {}) => ({
  room: Object.assign({ id: 'R1', topic: 'ورزشی', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12,
    capacity: 20, startsAt: Date.now() + 90000, phaseEndsAt: 0, serverNow: Date.now(), grossPool: 50000,
    chatEnabled: true, animationsEnabled: true, forfeited: 0, manualStartEnabled: false, noOpponents: false }, over),
  players: [{ userId: 'me', username: 'احسان', avatar: '', character: null, color: 'green', status: 'waiting', shields: 0, units: 1 }],
  me: { userId: 'me', username: 'احسان', status: 'waiting', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
  stats: { alive: 1, eliminated: 0, cashedOut: 0, totalPlayers: 1, grossPot: 50000, remainingPot: 50000, paidOut: 0 },
  question: null, votes: 0
});

async function enterRoom(page, over) {
  await page.evaluate((o) => {
    (0, eval)("lsRoomId='R1'; lsSnap=null; lsLastKey=''; lsWatching=false; lsEndShown=false; _lsGoneShown=false; go('lsGame');");
    (0, eval)('lsRender')(o);
  }, SNAP(over));
  await page.waitForTimeout(700);
}

const musicState = (page) => page.evaluate(() => {
  const a = document.getElementById('pzMusicEl');
  const L = (0, eval)('LSM');
  const fab = document.getElementById('lsMusicFab');
  const nx = document.getElementById('lsMusicFabNext');
  return {
    paused: a ? a.paused : null, src: a ? (a.getAttribute('src') || '') : '',
    started: L.started, freed: L.freed, fabOpen: L.fabOpen,
    fab: !!fab, fabText: fab ? fab.textContent.trim() : '',
    next: !!nx, nextText: nx ? nx.textContent.trim() : ''
  };
});

const modal = (page) => page.evaluate(() => {
  const m = document.getElementById('aaaModal');
  return { open: !!m && m.classList.contains('show'),
           title: (document.getElementById('aaaTitle') || {}).textContent || '',
           sub: (document.getElementById('aaaSub') || {}).textContent || '',
           primary: (document.getElementById('aaaPrimary') || {}).textContent || '',
           secondary: (document.getElementById('aaaSecondary') || {}).textContent || '' };
});

/* THE RESULT SCREEN HAS ITS OWN THINGS TO SAY. A finished match can put up a
   notification prompt of its own, and there is one modal slot — so the music
   question waits its turn rather than talking over it. That is deliberate, and
   it means a test cannot simply look up 1.6 seconds later: it has to clear what
   is in the way, exactly as a player would, and then see what arrives. */
async function settleModals(page, ms = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = await modal(page);
    if (!m.open) { await page.waitForTimeout(300); continue; }
    if (/موزیک/.test(m.title)) return m;
    await page.evaluate(() => {
      const s = document.getElementById('aaaSecondary');
      const p = document.getElementById('aaaPrimary');
      const el = (s && getComputedStyle(s).display !== 'none') ? s : p;
      if (el) el.click();
    });
    await page.waitForTimeout(400);
  }
  return await modal(page);
}

/* Put the player through the ending they asked about: knocked out of a running
   room, which is the path lsRender takes to lsFinish. */
async function eliminateMe(page) {
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'running'; s.room.phase = 'dashboard'; s.room.round = 2;
    s.me.status = 'eliminated'; s.me.payoutCash = 0; s.me.eliminatedRound = 2;
    s.players[0].status = 'eliminated';
    s.stats = { alive: 0, eliminated: 1, cashedOut: 0, totalPlayers: 1, grossPot: 50000, remainingPot: 50000, paidOut: 0 };
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
}

/* ── 1. THE MUSIC IS ASKED ABOUT WHEN THE MATCH ENDS ───────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the match ends with the music on:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  ok('the music is playing before the ending', (await musicState(page)).paused === false);

  await eliminateMe(page);
  await page.waitForTimeout(900);
  const screen = await page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
  ok('the player is taken to their result', screen === 'result', String(screen));

  const q = await settleModals(page);
  ok('and is asked about the music', q.open && /موزیک/.test(q.title), q.title);
  ok('with both answers offered', /ادامه/.test(q.primary) && /تموم/.test(q.secondary), q.primary + ' / ' + q.secondary);
  let st = await musicState(page);
  ok('nothing has been decided for them yet', st.paused === false && st.freed === false, JSON.stringify(st));

  /* «اگه گفت ادامه یه دکمه کوچیک پلی در صفحه شناور میمونه» */
  await page.evaluate(() => document.getElementById('aaaPrimary').click());
  await page.waitForTimeout(500);
  st = await musicState(page);
  ok('saying «ادامه بده» keeps it playing', st.paused === false, JSON.stringify(st));
  ok('and leaves a floating button behind', st.fab === true, String(st.fab));
  ok('one button, until it is reached for', st.next === false, String(st.next));

  /* «وقتی روش میزنی از بغلش یه دکمه نکست هم میزنه بیرون» */
  const before = st.src;
  await page.evaluate(() => { const b = document.getElementById('lsMusicFab'); if (b) b.click(); });
  await page.waitForTimeout(350);
  st = await musicState(page);
  ok('pressing it pops a next button out beside it', st.next === true, JSON.stringify(st));
  const where = await page.evaluate(() => {
    const fa = document.getElementById('lsMusicFab'), fb = document.getElementById('lsMusicFabNext');
    if (!fa || !fb) return { gap: -999, sameRow: false };
    const a = fa.getBoundingClientRect(), b = fb.getBoundingClientRect();
    return { gap: Math.round(b.left - a.right), sameRow: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) < 8 };
  });
  ok('right beside it, on the same line', where.sameRow && where.gap >= 0 && where.gap < 40, JSON.stringify(where));
  ok('and the music has not been interrupted by the tap', st.paused === false && st.src === before, JSON.stringify(st));

  /* «هم میتونی نکست کنی» */
  await page.evaluate(() => { const b = document.getElementById('lsMusicFabNext'); if (b) b.click(); });
  await page.waitForTimeout(800);
  st = await musicState(page);
  ok('the next button really moves the playlist on', st.src !== before, before + ' → ' + st.src);
  ok('and it is still playing', st.paused === false, JSON.stringify(st));
  ok('with the controls still there', st.fab === true && st.next === true, JSON.stringify(st));

  /* «هم پاوس تا هر موقع خواست استوپ کنه» */
  await page.evaluate(() => { const b = document.getElementById('lsMusicFab'); if (b) b.click(); });
  await page.waitForTimeout(400);
  st = await musicState(page);
  ok('pressing the main button again stops the music', st.paused === true, JSON.stringify(st));
  ok('and both controls go away with it', st.fab === false && st.next === false, JSON.stringify(st));
  /* «اگه دوباره خواست موزیک گوش بده باید بره آخرین بازمانده» — there is nothing
     left on the result screen to start it again with. */
  ok('and nothing is left to start it again from here', st.started === false && st.freed === false, JSON.stringify(st));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. «تمومش کن» ─────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe match ends and they say stop:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  await eliminateMe(page);
  await page.waitForTimeout(900);
  const q = await settleModals(page);
  ok('the question is up', q.open === true && /موزیک/.test(q.title), q.title);
  await page.evaluate(() => document.getElementById('aaaSecondary').click());
  await page.waitForTimeout(500);
  const st = await musicState(page);
  ok('the music stops', st.paused === true, JSON.stringify(st));
  ok('and no floating control is left', st.fab === false && st.next === false, JSON.stringify(st));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. NOTHING WAS PLAYING, SO NOTHING IS ASKED ───────────────────────── */
/* «اگر موزیک برای کاربر روشن بود» — the question belongs only to the player
   who had music on. Everybody else's result screen is left alone. */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe match ends with no music on:');
  await enterRoom(page);
  await eliminateMe(page);
  /* Long enough that a question queued behind another modal would have had
     every chance to arrive. */
  const q = await settleModals(page, 6000);
  ok('no music question is asked', !(q.open && /موزیک/.test(q.title)), q.title);
  const st = await musicState(page);
  ok('and nothing is playing', st.paused !== false, JSON.stringify(st));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3b. THE QUESTION WAITS ITS TURN ───────────────────────────────────── */
/* There is one modal slot in this app, and a win puts its own celebration in
 * it. A music question that walked straight over that would erase the one
 * screen the player was waiting for. Rather than depend on which prompt the
 * result screen happens to raise, this puts a known one up itself and checks
 * it is still there afterwards.
 */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nsomething else is already on screen when the match ends:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  await eliminateMe(page);
  /* Up immediately, so it is unmistakably first. */
  await page.evaluate(() => (0, eval)('showAaaModal')({ icon: '🏆', title: 'یک پیام دیگر', sub: 'این باید سر جایش بماند', primaryText: 'باشه', secondaryText: '' }));
  await page.waitForTimeout(2500);
  const held = await modal(page);
  ok('the other message is still the one on screen', held.open && /یک پیام دیگر/.test(held.title), held.title);
  const st1 = await musicState(page);
  ok('and the music is still playing while it waits', st1.paused === false && st1.freed === false, JSON.stringify(st1));

  /* Dismissed — now the question may have its turn. */
  await page.evaluate(() => { const b = document.getElementById('aaaPrimary'); if (b) b.click(); });
  const q = await settleModals(page);
  ok('once it is gone, the music question arrives', q.open && /موزیک/.test(q.title), q.title);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3c. MUSIC THAT WAS STOPPED AT KICK-OFF IS LET GO OF ───────────────── */
/* A player who chose «با شروع مسابقه: قطع» has a paused element with a track
 * still loaded in it when the match ends. There is nothing to ask them about,
 * but there IS something to clean up — and a client that keeps `started` set
 * would show the floating control again the moment anything repainted.
 */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe match ends after the music was stopped at kick-off:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='stop';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  ok('it played in the room', (await musicState(page)).paused === false);
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'running'; s.room.phase = 'dashboard'; s.room.round = 1;
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(600);
  const mid = await musicState(page);
  ok('and stopped when the first question came', mid.paused === true && mid.started === true, JSON.stringify(mid));

  await eliminateMe(page);
  const q = await settleModals(page, 6000);
  ok('nothing is asked, because nothing was playing', !(q.open && /موزیک/.test(q.title)), q.title);
  const end = await musicState(page);
  /* «فقط در صورت بازی کردن بتونه گوش بده» — the element is released, not left
     paused with a track in it waiting to be resumed by a stray repaint. */
  ok('and the player is let go of entirely', end.started === false, JSON.stringify(end));
  ok('with the track unloaded', end.src === '', end.src);
  ok('and no floating control anywhere', end.fab === false && end.next === false, JSON.stringify(end));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. PLAYING IN THE ROOM AND WALKING OUT WITHOUT A MATCH ────────────── */
/* «اگه بره موزیک پلی کنه و بیاد بیرون بدون اینکه بازی کنه موزیک قطع بشه — فقط
   در صورت بازی کردن بتونه گوش بده و نکست کنه.» */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nplaying a track and leaving without playing a match:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  ok('the music is on in the room', (await musicState(page)).paused === false);
  await page.evaluate(() => (0, eval)('lsLeave')('home', true));
  await page.waitForTimeout(700);
  const st = await musicState(page);
  ok('walking out stops it', st.paused === true, JSON.stringify(st));
  ok('and leaves no floating player behind', st.fab === false && st.freed === false, JSON.stringify(st));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. ALONE IN THE ROOM WHEN THE CLOCK RUNS OUT ──────────────────────── */
{
  const { ctx, page, errs, calls } = await makePage();
  console.log('\nalone in the room when the wait ends:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(700);
  ok('in the room, with music on', (await musicState(page)).paused === false);

  /* What the server sends once it has shown them the door: a finished room they
     are no longer a player in. The poll is running, as it would be in a real
     lobby, so that stopping it is something this test can actually see. */
  calls.length = 0;
  await page.evaluate(() => { (0, eval)('lsPoller=setInterval(function(){},1000);'); });
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'finished'; s.room.phase = 'finished'; s.room.noOpponents = true;
    s.players = []; s.me = null;
    s.stats = { alive: 0, eliminated: 0, cashedOut: 0, totalPlayers: 0, grossPot: 0, remainingPot: 0, paidOut: 0 };
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(900);

  const out = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id,
    body: (document.getElementById('lsBody') || {}).innerHTML || '',
    roomId: (0, eval)('lsRoomId'),
    polling: !!(0, eval)('lsPoller')
  }));
  /* «باید کامل برنامه رو ببندی تا بیاد بیرون» */
  ok('the player is put back on the home screen', out.screen === 'home', String(out.screen));
  ok('and is not left looking at a finish line', !/پایان مسابقه/.test(out.body), out.body.slice(0, 60));
  ok('the room is let go of', !out.roomId, String(out.roomId));
  ok('and the polling stops', out.polling === false, String(out.polling));

  const q = await modal(page);
  /* «بهش بگه فعلا حریفی برای تو وجود نداره» */
  ok('and is told why, in those words', q.open && /حریفی برای تو وجود نداره/.test(q.title), q.title);
  ok('with the ticket accounted for', /بلیط/.test(q.sub), q.sub.slice(0, 70));
  ok('and the header refreshed from the server', calls.some((c) => c === 'GET /wallet'), JSON.stringify(calls));
  const st = await musicState(page);
  ok('the room’s music goes with the room', st.paused === true, JSON.stringify(st));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5b. A FINISHED ROOM WE ARE SIMPLY NOT IN ──────────────────────────── */
/* The same dead end by another road: a snapshot with no personal block used to
   send lsFinish back to poll again, forever. */
{
  const { ctx, page, errs } = await makePage();
  console.log('\na finished room with no seat in it:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)('lsPoller=setInterval(function(){},1000);'); });
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'finished'; s.room.phase = 'finished'; s.room.noOpponents = false;
    s.players = []; s.me = null;
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(900);
  const out = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id,
    polling: !!(0, eval)('lsPoller'),
    title: (document.getElementById('aaaTitle') || {}).textContent || ''
  }));
  ok('the player is let out rather than parked', out.screen === 'home', String(out.screen));
  ok('and the polling stops', out.polling === false, String(out.polling));
  /* But NOT told there was no opponent — this room may well have had a match. */
  ok('without being told a story about opponents', !/حریفی/.test(out.title), out.title);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5c. A ROOM THAT IS STILL WAITING IS NOT LEFT ──────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\na room that is still filling:');
  await enterRoom(page);
  await page.waitForTimeout(300);
  const out = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id,
    room: (0, eval)('lsRoomId'),
    hasPlayer: !!document.getElementById('lsMusicBox')
  }));
  ok('the player stays in the lobby', out.screen === 'lsGame' && out.room === 'R1', JSON.stringify(out));
  ok('with the room fully drawn', out.hasPlayer === true, String(out.hasPlayer));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. THE PRIZE COMES TO THE MIDDLE FIRST ────────────────────────────── */
/* «اون عدد اول باید بصورت بزرگ با موشن بیاد وسط صفحه و با موشن عددش بیشتر بشه
 *  و رنگش سبز بشه سه بار چشمک بزنه رنگ سبز و ثابت بشه و بعد بره سر جای خودش
 *  اون بالا سمت چپ.» */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe prize when somebody is eliminated:');
  await enterRoom(page);
  /* Into a running match, on the dashboard where the prize figure lives. */
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'running'; s.room.phase = 'dashboard'; s.room.round = 1;
    s.me.status = 'alive'; s.me.currentShare = 20000;
    s.players = [{ userId: 'me', username: 'احسان', color: 'green', status: 'alive', shields: 0, units: 1 },
                 { userId: 'p2', username: 'سارا', color: 'blue', status: 'alive', shields: 0, units: 1 }];
    s.stats = { alive: 2, eliminated: 0, cashedOut: 0, totalPlayers: 2, grossPot: 60000, remainingPot: 40000, paidOut: 0 };
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(600);
  const started = await page.evaluate(() => ({
    remain: (document.getElementById('lsRemain') || {}).textContent || '',
    share: (document.getElementById('lsMyShare') || {}).textContent || '',
    hero: !!document.getElementById('lsPotHero')
  }));
  ok('the prize is on the board', started.remain !== '', started.remain);
  ok('and the player’s own share beside it', started.share !== '', started.share);
  ok('with nothing announced yet', started.hero === false, String(started.hero));

  /* Somebody goes out: the pot grows — AND SO DOES THE PLAYER'S OWN SHARE,
     because that is what an elimination does to both figures. Only one of them
     was asked to be announced: «جایزه». Two of these thrown at the middle of
     the screen would fight over it, and the second would replace the first. */
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.players[1].status = 'eliminated';
    s.me.currentShare = 30000;
    s.stats = { alive: 1, eliminated: 1, cashedOut: 0, totalPlayers: 2, grossPot: 60000, remainingPot: 60000, paidOut: 0 };
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(400);

  /* THE ROOM KEEPS POLLING WHILE THE ANNOUNCEMENT CLIMBS. Once a second, a
     snapshot arrives carrying the new total and repaints the board — and if
     that repaint writes the figure straight into its slot, the big number is
     still on its way to a place that already has it. Same total in two places
     at once, and the flight lands on nothing. */
  await page.evaluate(() => { (0, eval)('lsRender')(JSON.parse(JSON.stringify((0, eval)('lsSnap')))); });
  await page.waitForTimeout(150);

  const mid = await page.evaluate(() => {
    const h = document.getElementById('lsPotHero');
    if (!h) return null;
    const card = h.querySelector('.lph-card');
    const num = h.querySelector('.lph-num');
    const r = card.getBoundingClientRect();
    const small = document.getElementById('lsRemain');
    const sr = small ? small.getBoundingClientRect() : null;
    return {
      text: num.textContent,
      size: Math.round(parseFloat(getComputedStyle(num).fontSize)),
      smallSize: sr ? Math.round(parseFloat(getComputedStyle(small).fontSize)) : 0,
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      vw: window.innerWidth, vh: window.innerHeight,
      green: h.classList.contains('lph-green'),
      smallText: small ? small.textContent : '',
      heroes: document.querySelectorAll('.ls-pot-hero').length
    };
  });
  ok('the number comes to the middle of the screen', !!mid, JSON.stringify(mid));
  ok('and there is exactly one of them', mid.heroes === 1, String(mid.heroes));
  ok('horizontally centred', Math.abs(mid.cx - mid.vw / 2) < 30, mid.cx + ' of ' + mid.vw);
  ok('vertically centred', Math.abs(mid.cy - mid.vh / 2) < 60, mid.cy + ' of ' + mid.vh);
  /* «بصورت بزرگ» */
  ok('and it is big, not the board’s own size', mid.size >= 34 && mid.size > mid.smallSize * 1.6, mid.size + 'px vs ' + mid.smallSize + 'px');
  /* «با موشن عددش بیشتر بشه» — part way through a climb from 40,000 to 60,000
     the figure has to be between the two, not already at either end. */
  const midVal = en(mid.text);
  ok('it is mid-climb, not already arrived', midVal > 40000 && midVal < 60000, String(midVal));
  ok('not green yet, because it is still counting', mid.green === false, String(mid.green));
  /* The board holds its old figure while the big one is still climbing, so the
     same total is never in two places at once. */
  ok('the board has not jumped ahead', mid.smallText === started.remain, mid.smallText + ' vs ' + started.remain);

  const climbed = await page.evaluate(async () => {
    const num = document.querySelector('#lsPotHero .lph-num');
    const a = num.textContent;
    await new Promise((r) => setTimeout(r, 900));
    return { a, b: document.querySelector('#lsPotHero .lph-num').textContent };
  });
  ok('the number really climbs', climbed.a !== climbed.b, climbed.a + ' → ' + climbed.b);

  /* «رنگش سبز بشه سه بار چشمک بزنه» */
  const green = await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const h = document.getElementById('lsPotHero');
      if (h && h.classList.contains('lph-green')) {
        const num = h.querySelector('.lph-num');
        const cs = getComputedStyle(num);
        return { on: true, colour: cs.color, anim: cs.animationName,
                 count: cs.animationIterationCount, dur: cs.animationDuration, text: num.textContent };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { on: false };
  });
  ok('when it lands it turns green', green.on === true && /rgb\(107, 224, 138\)|rgb\(1?0?7/.test(green.colour), JSON.stringify(green));
  ok('and blinks exactly three times', green.count === '3', String(green.count));
  ok('a blink you can see, not a flicker', parseFloat(green.dur) >= 0.3, green.dur);

  /* «ثابت بشه و بعد بره سر جای خودش اون بالا» */
  const landed = await page.evaluate(async () => {
    for (let i = 0; i < 80; i++) {
      if (!document.getElementById('lsPotHero')) {
        const small = document.getElementById('lsRemain');
        return { gone: true, smallText: small ? small.textContent : '', flash: small ? small.className : '' };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { gone: false };
  });
  ok('then it goes away', landed.gone === true, JSON.stringify(landed));
  ok('and the board is holding the new total', en(landed.smallText) === 60000, landed.smallText);
  /* «جایزه» — the pot, not the player's share. The share grew at the same
     moment and takes the ordinary climb in its own corner. */
  ok('it was the prize that was announced, not the share', en(green.text) === 60000, green.text);
  const share = await page.evaluate(() => (document.getElementById('lsMyShare') || {}).textContent || '');
  ok('and the share arrived quietly at its own new figure', en(share) === 30000, share);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6b. WITH ANIMATIONS TURNED OFF ────────────────────────────────────── */
/* The operator can switch the room's animations off, and a phone can ask for
   less motion. Neither may be left without the figure. */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe same elimination with animations off:');
  await enterRoom(page, { animationsEnabled: false });
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'running'; s.room.phase = 'dashboard'; s.room.round = 1;
    s.room.animationsEnabled = false;
    s.me.status = 'alive'; s.me.currentShare = 20000;
    s.stats = { alive: 2, eliminated: 0, cashedOut: 0, totalPlayers: 2, grossPot: 60000, remainingPot: 40000, paidOut: 0 };
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.stats = { alive: 1, eliminated: 1, cashedOut: 0, totalPlayers: 2, grossPot: 60000, remainingPot: 60000, paidOut: 0 };
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => ({ hero: !!document.getElementById('lsPotHero') }));
  ok('nothing is thrown at the middle of the screen', st.hero === false, String(st.hero));
  const end = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 2600));
    return (document.getElementById('lsRemain') || {}).textContent || '';
  });
  ok('and the board still reaches the new total', en(end) === 60000, end);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6c. IT OPENS ON THE OLD NUMBER ────────────────────────────────────── */
/* «اون عدد اول… با موشن عددش بیشتر بشه» — it has to START where the board was
 * and climb from there. Written into the markup as the final total instead, the
 * first animation frame overwrites it about sixteen milliseconds later, so
 * every measurement taken afterwards looks identical and only a one-frame flash
 * of the wrong number gives it away. Read in the same task that creates it,
 * before any frame has run, which is the one moment the difference exists.
 */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe first frame of the announcement:');
  await enterRoom(page);
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'running'; s.room.phase = 'dashboard'; s.room.round = 1;
    s.me.status = 'alive'; s.me.currentShare = 20000;
    s.stats = { alive: 2, eliminated: 0, cashedOut: 0, totalPlayers: 2, grossPot: 60000, remainingPot: 40000, paidOut: 0 };
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(500);
  const opened = await page.evaluate(() => {
    (0, eval)('lsPotHero')('lsRemain', 11111, 99999);
    /* No await, no timeout: requestAnimationFrame cannot have run yet. */
    const n = document.querySelector('#lsPotHero .lph-num');
    const add = document.querySelector('#lsPotHero .lph-add');
    return { first: n ? n.textContent : '', add: add ? add.textContent : '' };
  });
  ok('it opens on the number the board was showing', en(opened.first) === 11111, opened.first);
  ok('and says what is being added', en(opened.add) === 88888, opened.add);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── ONE ROOM, ONE WINNER, ONE FACE ────────────────────────────────────── */
/* «در قسمت صفحه آخر برد یا باخت در آخرین بازمانده، در کارت بالا عکس دو نفر هست
 * مثل دوئل. در بازی ۲۰ نفره چرا باید عکس ۲ نفر بیاد؟»
 *
 * Nothing ever told the result screen it was not a duel. `gameType` is set by
 * each mode as it starts and Last Survivor never set it, so after one duel it
 * stayed 'duel' for the rest of the session — and the room of twenty was
 * summed up with two portraits and a «۵ - ۳». */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe result screen after a room of twenty:');
  /* A duel first, so `gameType` really is stale by the time the room ends —
     which is the only way the fault ever appeared. */
  await page.evaluate(() => { (0, eval)("gameType='duel';"); });
  await enterRoom(page);
  await eliminateMe(page);
  await page.waitForTimeout(900);
  await settleModals(page);
  const board = await page.evaluate(() => {
    const b = document.getElementById('resBoard') || document.querySelector('.res-board');
    return {
      type: (0, eval)('gameType'),
      faces: b ? b.querySelectorAll('.rb-face').length : -1,
      solo: b ? b.classList.contains('solo') : null,
      score: (document.getElementById('resultDuelScore') || {}).textContent || '',
      /* The row itself stays — Last Survivor puts «مرور مسابقه» in it — but the
         rematch button in it belongs to a duel and to nothing else. */
      rematch: (document.getElementById('rematchBtn') || {}).style.display,
      review: (document.getElementById('reviewBtn') || {}).style.display
    };
  });
  ok('the mode is no longer «duel»', board.type === 'lastSurvivor', String(board.type));
  ok('one face, not two', board.faces === 1, String(board.faces));
  ok('and the board knows it is a lone result', board.solo === true, String(board.solo));
  /* A «۵ - ۳» belongs to two players. */
  ok('no duel scoreline', board.score.trim() === '', JSON.stringify(board.score));
  /* «بازی مجدد با همین حریف» in a room of twenty has no «همین حریف»; the
     «ادامه» beside it would have run duelContinue on a room with no rungs. */
  ok('no rematch offer', board.rematch === 'none', String(board.rematch));
  ok('but the match is still there to look back at', board.review === 'block', String(board.review));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE PRIZE ARRIVES AS A NUMBER, NOT AS A NOTICE ────────────────────── */
/* «اون سهم جایزه الان داخل یه کادر فقط نوشته میشه، اصلا حس هیجان به کاربر
 * نمیده. باید فقط اون عدد بیاد جلو وسط بزرگ با موشن، بعد ثابت بشه، بعد با موشن
 * بره سر جای خودش.» */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe shape of the announcement:');
  await enterRoom(page);
  const look = await page.evaluate(async () => {
    (0, eval)('lsPotHero')('lsRemain', 10000, 40000);
    await new Promise((r) => setTimeout(r, 200));
    const card = document.querySelector('#lsPotHero .lph-card');
    const num = document.querySelector('#lsPotHero .lph-num');
    const add = document.querySelector('#lsPotHero .lph-add');
    const cs = card ? getComputedStyle(card) : null;
    const ns = num ? getComputedStyle(num) : null;
    const as = add ? getComputedStyle(add) : null;
    return {
      size: ns ? parseFloat(ns.fontSize) : 0,
      addSize: as ? parseFloat(as.fontSize) : 0,
      addAnim: as ? as.animationName : '',
      border: cs ? parseFloat(cs.borderTopWidth) : -1,
      bg: cs ? cs.backgroundColor : '',
      centred: num ? Math.abs((num.getBoundingClientRect().left + num.getBoundingClientRect().right) / 2 - window.innerWidth / 2) : 999
    };
  });
  /* «بزرگ» is the whole request — it has to dwarf ordinary text, not merely
     be a little larger than it. */
  ok('the number is enormous', look.size >= 48, look.size + 'px');
  /* «داخل یه کادر فقط نوشته میشه» was the complaint: a frame turns a number
     arriving into a notice to be read. */
  ok('there is no box around it', look.border <= 0, String(look.border));
  ok('and no panel behind it', /rgba\(0, 0, 0, 0\)|transparent/.test(look.bg), look.bg);
  ok('it lands in the middle of the screen', look.centred < 12, look.centred + 'px off centre');
  /* The «+N» is what makes it read as money landing rather than a figure
     being swapped for another. */
  ok('what is being added is big enough to see', look.addSize >= 18, look.addSize + 'px');
  ok('and it moves', /lphAdd/.test(look.addAnim), look.addAnim);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE SPECTATOR'S ENDING ────────────────────────────────────────────── */
/* «وقتی کسی حذف میشه و تماشای مسابقه رو میزنه، بعد از پایان متن برنده مسابقه
 * فلانی شد و مبلغ فلان قدر برنده شد خیلی به هم ریخته نشون داده میشه.»
 *
 * A username of unknown direction, an em-dash and a run of digits, all on one
 * right-to-left line, is exactly the shape the bidirectional algorithm
 * reorders into nonsense — a Latin name jumps to the wrong end of the sentence
 * and takes the dash with it. */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nwatching somebody else finish:');
  await enterRoom(page);
  const w = await page.evaluate(async () => {
    (0, eval)('_lsWatchEndShown=false;');
    (0, eval)('lsShowWatchEnding')({
      room: { status: 'finished' },
      players: [{ userId: 'a', username: 'Reza_77', payoutCash: 250000 },
                { userId: 'b', username: 'مهدی', payoutCash: 90000 }],
      stats: {}
    });
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('.ls-watchend .lwe-win')];
    const first = rows[0];
    const who = first ? first.querySelector('.lwe-who') : null;
    const amt = first ? first.querySelector('.lwe-amt') : null;
    return {
      rows: rows.length,
      heading: (document.querySelector('.ls-watchend .lwe-line') || {}).textContent || '',
      whoTag: who ? who.tagName : '',
      whoTxt: who ? who.textContent : '',
      amtTxt: amt ? amt.textContent : '',
      /* Separate lines is the fix: nothing is mixed, so nothing is reordered. */
      sameLine: (who && amt) ? Math.abs(who.getBoundingClientRect().top - amt.getBoundingClientRect().top) < 4 : null,
      col: first ? getComputedStyle(first).flexDirection : ''
    };
  });
  ok('both winners are listed', w.rows === 2, String(w.rows));
  ok('and the heading is in the plural', /برندگان/.test(w.heading), w.heading);
  /* <bdi> is the one element whose whole job is «do not let this text reorder
     the sentence around it». */
  ok('the name is isolated from the sentence', w.whoTag === 'BDI', w.whoTag);
  ok('the name is the name', w.whoTxt === 'Reza_77', w.whoTxt);
  /* THE AMOUNT AND NOTHING ELSE. The line that was complained about read
     «Reza_77 — ۲۵۰٬۰۰۰ تومان», and the em-dash was half the problem: a
     separator belonging to neither piece, sitting between a Latin name and a
     run of digits, is the exact join the bidirectional algorithm picks up and
     moves. Splitting the line is only half the fix if the dash rides along
     into the amount. */
  ok('the amount is its own piece', /۲۵۰٬۰۰۰|250,000/.test(w.amtTxt) && /تومان/.test(w.amtTxt), w.amtTxt);
  ok('and carries no separator with it', !/[—–-]/.test(w.amtTxt), JSON.stringify(w.amtTxt));
  ok('it is only the number and the unit', /^[\s]*[۰-۹0-9٬,]+\s*تومان\s*$/.test(w.amtTxt), JSON.stringify(w.amtTxt));
  ok('and it sits under the name, not beside it', w.sameLine === false, String(w.sameLine));
  ok('the row really is stacked', w.col === 'column', w.col);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── ONE WINNER, AND NOBODY AT ALL ─────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe other two endings:');
  await enterRoom(page);
  const one = await page.evaluate(async () => {
    (0, eval)('_lsWatchEndShown=false;');
    (0, eval)('lsShowWatchEnding')({ room: {}, players: [{ userId: 'a', username: 'Ali', payoutCash: 50000 }], stats: {} });
    await new Promise((r) => setTimeout(r, 200));
    return { heading: (document.querySelector('.ls-watchend .lwe-line') || {}).textContent || '',
             rows: document.querySelectorAll('.ls-watchend .lwe-win').length };
  });
  ok('one winner is announced in the singular', /برندهٔ این اتاق/.test(one.heading), one.heading);
  ok('with one row', one.rows === 1, String(one.rows));

  const wipe = await page.evaluate(async () => {
    (0, eval)('_lsWatchEndShown=false;');
    (0, eval)('lsShowWatchEnding')({
      room: { wipeout: { lastUserId: 'z' } },
      players: [{ userId: 'z', username: 'Sara', payoutCash: 30000 }], stats: {} });
    await new Promise((r) => setTimeout(r, 200));
    const lines = [...document.querySelectorAll('.ls-watchend .lwe-line')].map((e) => e.textContent);
    const who = document.querySelector('.ls-watchend .lwe-who');
    return { lines, who: who ? who.textContent : '', tag: who ? who.tagName : '' };
  });
  /* The sentence and the name used to share a line here too, with the name in
     the middle of it — the worst case of all for reordering. */
  ok('a wipeout says so plainly', /برنده‌ای نداشت/.test(wipe.lines.join(' ')), JSON.stringify(wipe.lines));
  ok('and the name it names is on its own', wipe.tag === 'BDI' && wipe.who === 'Sara', wipe.tag + ':' + wipe.who);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE WALLET IS CALLED THE PRIZE BOX ────────────────────────────────── */
/* «در منو بیشتر اسم کیف پول تغییر پیدا کنه به صندوق جایزه و بغیر اونم هر اسمی
 * کیف پول هست تغییر کنه به صندوق جایزه.» */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nwhat the wallet is called:');
  const words = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    /* The whole document, not just what is on screen: every screen's markup is
       in the page, and one missed label is the one the player finds. */
    const html = document.documentElement.innerHTML;
    return { old: (html.match(/کیف پول/g) || []).length, neu: (html.match(/صندوق جایزه/g) || []).length, seen: /کیف پول/.test(txt) };
  });
  ok('nothing is called a wallet any more', words.old === 0, String(words.old));
  ok('and the prize box is named all over', words.neu > 10, String(words.neu));
  ok('nothing on screen says the old word', words.seen === false, String(words.seen));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
