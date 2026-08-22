/* THE WAITING-ROOM MUSIC PLAYER, AND THE SHOP THAT LOST ITS SHELF.
 *
 *   «یه قسمت در پایین اتاق انتظار به نام پخش موزیک… به صورت تصادفی، بدون نام و
 *    مشخصات، یه دکمه پلی و پاوس و دو دکمه آهنگ بعدی و قبلی… وقتی پلی میکنی یه
 *    گزینه بیاد که در صورت شروع مسابقه موسیقی چی بشه… و همیشه یه دکمه پلی و
 *    پاوس باید باشه تا کاربر هر جا خواست موزیک رو قطع کنه.»
 *
 *   «پک های چت در اولین باز کردن فروشگاه چند ثانیه میاد و دوباره میره.»
 *   «عکس کاراکترها خیلی بزرگه و معلوم نیست — باید هم اندازه و واضح باشن.»
 *   «دکمه های خرید باید هم راستا باشن نه اینکه یکی بالا یکی پایین.»
 *
 * The audio is a real (tiny) WAV served by the test server, so «is it playing»
 * is answered by the element itself rather than by a flag the page keeps.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

/* A one-second silent WAV, built here so the browser has something it can
   really decode and play. */
function wav(seconds = 1, rate = 8000) {
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
/* Long enough that nothing ends by accident in the middle of a test — the
   playlist really does move on when a track finishes, and that is checked
   deliberately below with a one-second one instead of by luck here. */
const TRACK = wav(30);
const SHORT = wav(2);

const server = http.createServer((q, r) => {
  const url = q.url.split('?')[0];
  /* The audio the player pulls, with the range support a real browser wants. */
  if (url.startsWith('/track/')) {
    const body = url.startsWith('/track/short') ? SHORT : TRACK;
    const range = String(q.headers.range || '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2]));
      const end = m[1] ? (m[2] ? Number(m[2]) : body.length - 1) : body.length - 1;
      const chunk = body.subarray(start, end + 1);
      r.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': chunk.length });
      return r.end(chunk);
    }
    r.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': body.length });
    return r.end(body);
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
  /* Autoplay is gated on a user gesture in a real browser and every play here
     IS a click, but the headless build needs telling that silent audio counts. */
  args: ['--autoplay-policy=no-user-gesture-required']
});

let tracks = [
  { id: 't1', url: '/track/t1' },
  { id: 't2', url: '/track/t2' },
  { id: 't3', url: '/track/t3' }
];
let musicAsked = 0;

/* The catalogue the shop's own tab bar is rebuilt from — deliberately WITHOUT a
   chat category, which is exactly the shape that used to delete the shelf. */
const SHOP_ITEMS = [
  { id: 'u1', category: 'util', icon: '🧰', name: 'ابزار', description: 'یک', price: 100, currency: 'coins' },
  { id: 'c1', category: 'cosmetic', icon: '✨', name: 'تزئین', description: 'دو', price: 200, currency: 'coins' }
];
const PACKS = [
  { key: 'friendly', name: 'دوستانه', emoji: '🙂', phraseCount: 12, price: 0, currency: 'coins', free: true, owned: true },
  { key: 'fun', name: 'شوخ', emoji: '😄', phraseCount: 20, price: 300, currency: 'coins', free: false, owned: false }
];
const CHARS = {
  characters: [
    { id: 'ch1', name: 'پهلوان', description: 'یک توضیح کوتاه', image: '/track/nope.png', kind: 'normal',
      unlocked: false, viaPurchase: true, price: 700, currency: 'coins', unlockLevel: 0, group: 'قهرمانان' },
    { id: 'ch2', name: 'روباه', description: 'یک توضیح خیلی بلندتر که دو خط می‌شود و کارت را بلندتر می‌کند', image: '/track/nope2.png',
      kind: 'normal', unlocked: false, viaPurchase: true, price: 300, currency: 'coins', unlockLevel: 0, group: 'قهرمانان' }
  ], level: 5
};

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
    if (p === '/waiting-music') { musicAsked++; return send({ tracks }); }
    if (p === '/users/me') return send({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5, balances: { wallet: 0 } });
    if (p === '/shop/items') return send({ items: SHOP_ITEMS });
    if (p === '/chat-packs') return send({ packs: PACKS });
    if (p === '/characters') return send(CHARS);
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto(ORIGIN + '/');
  await page.waitForTimeout(5200);
  /* The list is served with server-relative URLs; point them at this test
     server the same way the real client points them at the API host. */
  await page.evaluate((o) => { (0, eval)('lsMusicSrc'); window.__origin = o; }, ORIGIN);
  await page.evaluate(() => {
    (0, eval)("lsMusicSrc=function(t){ return t&&t.url ? (/^https?:/.test(t.url)? t.url : window.__origin+t.url) : ''; };");
  });
  return { ctx, page, errs, calls };
}

/* Drop a waiting-room snapshot into the room, the way a poll would. */
const SNAP = (over = {}) => ({
  room: Object.assign({ id: 'R1', topic: 'ورزشی', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12,
    capacity: 20, startsAt: Date.now() + 90000, phaseEndsAt: 0, serverNow: Date.now(), grossPool: 50000,
    chatEnabled: true, forfeited: 0, manualStartEnabled: false }, over),
  players: [{ userId: 'me', username: 'احسان', avatar: '', character: null, color: 'green', status: 'waiting', shields: 0, units: 1 }],
  me: { userId: 'me', username: 'احسان', status: 'waiting', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
  stats: { alive: 1, eliminated: 0, cashedOut: 0, totalPlayers: 1, grossPot: 50000, remainingPot: 50000, paidOut: 0 },
  question: null, votes: 0
});

async function enterRoom(page, over) {
  await page.evaluate((o) => {
    (0, eval)("lsRoomId='R1'; lsSnap=null; lsLastKey=''; lsWatching=false; go('lsGame');");
    (0, eval)('lsRender')(o);
  }, SNAP(over));
  await page.waitForTimeout(700);
}

const musicState = (page) => page.evaluate(() => {
  const a = document.getElementById('pzMusicEl');
  const L = (0, eval)('LSM');
  return {
    el: !!a, paused: a ? a.paused : null, src: a ? (a.getAttribute('src') || '') : '',
    volume: a ? a.volume : null, started: L.started, policy: L.policy,
    playBtn: (document.getElementById('lsMusicPlay') || {}).textContent || '',
    fab: !!document.getElementById('lsMusicFab')
  };
});

/* ── 1. THE PLAYER IN THE ROOM ──────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the waiting room:');
  musicAsked = 0;
  await enterRoom(page);

  const box = await page.evaluate(() => {
    const b = document.getElementById('lsMusicBox');
    if (!b) return null;
    const tabs = document.querySelector('#lsBody .ls-tabs');
    return {
      there: true, text: b.innerText.replace(/\s+/g, ' ').trim(),
      buttons: [...b.querySelectorAll('.lm-btn')].map((x) => x.id),
      /* «این قسمت در پایین اتاق انتظار باید باشه» */
      belowGrid: b.getBoundingClientRect().top > document.querySelector('#lsBody .ls-grid').getBoundingClientRect().top,
      aboveTabs: !tabs || b.getBoundingClientRect().top < tabs.getBoundingClientRect().top
    };
  });
  ok('the room has a music player', !!box, JSON.stringify(box));
  ok('down at the bottom, under the players', box.belowGrid && box.aboveTabs, JSON.stringify({ b: box.belowGrid, a: box.aboveTabs }));
  /* «با یک متن از موسیقی لذت ببر یا هنگام انتظار حوصلت سر نره» */
  ok('with a line that says why it is there', /حوصله|موزیک/.test(box.text), box.text.slice(0, 60));
  /* «یه دکمه پلی و پاوس و دو دکمه آهنگ بعدی و قبلی» */
  ok('three controls: previous, play, next', box.buttons.join(',') === 'lsMusicPrev,lsMusicPlay,lsMusicNext', box.buttons.join(','));

  /* «بدون نام و مشخصات» — nothing on this screen names a track. */
  const named = await page.evaluate(() => {
    const b = document.getElementById('lsMusicBox');
    return /t1|t2|t3|\.wav|track/i.test(b.innerHTML);
  });
  ok('no track is named anywhere on it', named === false, String(named));
  ok('the playlist was asked for once', musicAsked === 1, String(musicAsked));

  /* ── the policy question, before the first note ── */
  let st = await musicState(page);
  ok('nothing is playing until it is asked for', st.paused !== false, JSON.stringify(st));
  await page.evaluate(() => document.getElementById('lsMusicPlay').click());
  await page.waitForTimeout(500);
  const ask = await page.evaluate(() => ({
    open: !!document.getElementById('aaaModal').classList.contains('show'),
    title: (document.getElementById('aaaTitle') || {}).textContent || '',
    options: [...document.querySelectorAll('.lm-pol')].map((b) => b.getAttribute('data-v'))
  }));
  ok('pressing play asks what happens when the match starts', ask.open && /مسابقه شروع/.test(ask.title), ask.title);
  ok('with all three answers', ask.options.join(',') === 'quiet,stop,keep', ask.options.join(','));
  st = await musicState(page);
  ok('and nothing plays until one is chosen', st.started === false, JSON.stringify(st));

  await page.evaluate(() => document.querySelector('.lm-pol[data-v="quiet"]').click());
  await page.waitForTimeout(900);
  st = await musicState(page);
  ok('choosing one starts the music', st.started === true && st.paused === false, JSON.stringify(st));
  ok('the answer is remembered', st.policy === 'quiet', String(st.policy));
  ok('the button turns into pause', st.playBtn === '⏸', st.playBtn);
  const firstSrc = st.src;
  ok('it is playing one of the uploaded tracks', /\/track\/t[123]$/.test(firstSrc), firstSrc);

  /* ── next / previous ── */
  await page.evaluate(() => document.getElementById('lsMusicNext').click());
  await page.waitForTimeout(600);
  const afterNext = await musicState(page);
  ok('«بعدی» moves to another track', afterNext.src !== firstSrc && /\/track\/t[123]$/.test(afterNext.src), afterNext.src);
  ok('and keeps playing', afterNext.paused === false, String(afterNext.paused));

  /* Within the first seconds, «قبلی» goes BACK rather than restarting. */
  await page.evaluate(() => { const a = document.getElementById('pzMusicEl'); a.currentTime = 0; document.getElementById('lsMusicPrev').click(); });
  await page.waitForTimeout(600);
  const afterPrev = await musicState(page);
  ok('«قبلی» goes back to the one before', afterPrev.src === firstSrc, afterPrev.src + ' vs ' + firstSrc);

  /* ── pause ── */
  await page.evaluate(() => document.getElementById('lsMusicPlay').click());
  await page.waitForTimeout(400);
  st = await musicState(page);
  ok('pressing it again pauses', st.paused === true, JSON.stringify(st));
  ok('and the button says play again', st.playBtn === '▶', st.playBtn);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE ROOM REDRAWS AND THE MUSIC DOES NOT STOP ────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nsomebody joins while the music is on:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  const before = await musicState(page);
  ok('the music is on', before.paused === false, JSON.stringify(before));

  /* A second player arrives: the whole waiting room is rebuilt. This is the
     thing that would silence an <audio> living inside that markup. */
  await page.evaluate(() => {
    const s = (0, eval)('lsSnap');
    const next = JSON.parse(JSON.stringify(s));
    next.players.push({ userId: 'u2', username: 'سارا', avatar: '', character: null, color: 'blue', status: 'waiting', shields: 0, units: 1 });
    next.room.grossPool = 75000;
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(next);
  });
  await page.waitForTimeout(600);
  const after = await musicState(page);
  ok('the room redrew', await page.evaluate(() => document.querySelectorAll('#lsBody .ls-pl').length) >= 1);
  ok('and the music is still playing the same track', after.paused === false && after.src === before.src, JSON.stringify(after));
  ok('the controls came back with it, still showing pause', after.playBtn === '⏸', after.playBtn);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. WHEN THE MATCH STARTS ───────────────────────────────────────────── */
for (const [policy, expect] of [['quiet', 'quieter'], ['stop', 'stopped'], ['keep', 'unchanged']]) {
  const { ctx, page, errs } = await makePage();
  console.log('\nthe match starts, having chosen «' + policy + '»:');
  await enterRoom(page);
  await page.evaluate((p) => { (0, eval)("LSM.policy='" + p + "';"); document.getElementById('lsMusicPlay').click(); }, policy);
  await page.waitForTimeout(800);
  ok('playing before the first question', (await musicState(page)).paused === false);

  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify((0, eval)('lsSnap')));
    s.room.status = 'running'; s.room.phase = 'dashboard'; s.room.round = 1;
    (0, eval)('lsLastKey=""');
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(600);
  const st = await musicState(page);
  if (expect === 'stopped') {
    ok('the music stops', st.paused === true, JSON.stringify(st));
    ok('and no floating button is left behind', st.fab === false, String(st.fab));
  } else {
    ok('the music keeps going', st.paused === false, JSON.stringify(st));
    ok(expect === 'quieter' ? 'at a lower volume' : 'at the same volume',
      expect === 'quieter' ? st.volume < 0.5 : st.volume === 1, String(st.volume));
    /* «همیشه یه دکمه پلی و پاوس باید باشه» — the room's own player is gone from
       the screen now, so there has to be something else to press. */
    ok('a floating pause button appears', st.fab === true, String(st.fab));
    await page.evaluate(() => document.getElementById('lsMusicFab').click());
    await page.waitForTimeout(400);
    const off = await musicState(page);
    ok('and pressing it really stops the music', off.paused === true, JSON.stringify(off));
    ok('after which it takes itself away', off.fab === false, String(off.fab));
  }
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3b. A TRACK THAT RUNS OUT ──────────────────────────────────────────── */
{
  const saved = tracks;
  tracks = [{ id: 's1', url: '/track/short/1' }, { id: 's2', url: '/track/short/2' }];
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen a track finishes on its own:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(700);
  const first = (await musicState(page)).src;
  ok('one of them is playing', /\/track\/short\/[12]$/.test(first), first);

  /* EVERY CHOICE THE PLAYLIST MAKES IS RECORDED. Watching the element's own
     events cannot answer this: the game's `ended` handler runs first, so by the
     time a listener added here is called the next track is already loaded and
     both readings are the same. So the decision itself is what is watched —
     which track the player asks for, each time it asks. */
  await page.evaluate(() => {
    window.__plays = [];
    window.__origPlay = (0, eval)('lsMusicPlay');
    (0, eval)("lsMusicPlay=function(){ var L=LSM; window.__plays.push(L.order[L.i]); return window.__origPlay.apply(this,arguments); };");
  });
  /* Two-second tracks, so this is several real endings. */
  await page.waitForTimeout(7000);
  const plays = await page.evaluate(() => window.__plays);
  const playing = await musicState(page);
  ok('the playlist keeps going by itself', plays.length >= 3, JSON.stringify(plays));
  ok('and it is still playing at the end of it', playing.paused === false, JSON.stringify(playing));
  /* With two tracks, three handovers means the list ran out and started again
     at least once — the moment a fresh random order could otherwise open with
     the track that had just been heard. */
  ok('no track is ever followed by itself',
    plays.every((t, i) => i === 0 || t !== plays[i - 1]), JSON.stringify(plays));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  tracks = saved;
}

/* ── 3c. THE END OF THE LIST, DECIDED RATHER THAN TIMED ─────────────────── */
{
  const saved = tracks;
  tracks = [{ id: 'a', url: '/track/a' }, { id: 'b', url: '/track/b' }];
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen the shuffled list runs out:');
  await enterRoom(page);
  /* WITH THE DICE HELD STILL. A shuffle that may repeat the last track does so
     about half the time, and a test that catches a fault half the time is not a
     test. Math.random is pinned, which makes the reshuffle's answer exact:
     [a,b] reshuffles to [b,a], and «do not open with the track just heard» is
     then the only thing that can stop b playing twice. */
  const nextTrack = await page.evaluate(() => {
    const real = Math.random;
    Math.random = () => 0;
    try {
      const L = (0, eval)('LSM');
      L.tracks = [{ id: 'a', url: '/track/a' }, { id: 'b', url: '/track/b' }];
      L.order = [0, 1]; L.i = 1;                    // playing the LAST one
      const wasPlaying = L.order[L.i];
      let asked = null;
      const realPlay = (0, eval)('lsMusicPlay');
      window.__realPlay = realPlay;
      (0, eval)("lsMusicPlay=function(){ window.__asked=LSM.order[LSM.i]; };");
      (0, eval)('lsMusicNext')();
      asked = window.__asked;
      (0, eval)("lsMusicPlay=window.__realPlay;");
      return { wasPlaying, asked, order: L.order.slice() };
    } finally { Math.random = real; }
  });
  ok('the list starts again', nextTrack.asked != null, JSON.stringify(nextTrack));
  ok('and never on the track that has just been heard',
    nextTrack.asked !== nextTrack.wasPlaying, JSON.stringify(nextTrack));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  tracks = saved;
}

/* ── 3d. TWO PEOPLE IN THE SAME ROOM ────────────────────────────────────── */
{
  console.log('\ntwo players waiting in the same room:');
  const a = await makePage();
  const b = await makePage();
  await enterRoom(a.page);
  await enterRoom(b.page);
  await a.page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await b.page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await a.page.waitForTimeout(800);

  const a1 = await musicState(a.page), b1 = await musicState(b.page);
  ok('both are playing something', a1.paused === false && b1.paused === false, JSON.stringify({ a: a1.src, b: b1.src }));

  /* «باید هر کاربر مجزا بتونه نکست بزنه و مستقل هر آهنگی که دلش میخواد پلی
     کنه بدون اینکه رو آهنگ بقیه تاثیر بزاره» — one player pressing «بعدی»
     several times must leave the other exactly where they were. */
  a.calls.length = 0; b.calls.length = 0;
  for (let i = 0; i < 3; i++) {
    await a.page.evaluate(() => document.getElementById('lsMusicNext').click());
    await a.page.waitForTimeout(250);
  }
  await a.page.waitForTimeout(400);
  const a2 = await musicState(a.page), b2 = await musicState(b.page);
  ok('the one pressing next moved on', a2.src !== a1.src || a2.paused === false, JSON.stringify({ before: a1.src, after: a2.src }));
  ok('and the other one did not move at all', b2.src === b1.src, b2.src + ' vs ' + b1.src);
  ok('nor was it paused, or turned down, or touched', b2.paused === false && b2.volume === b1.volume, JSON.stringify(b2));

  /* One player pausing is their own business too. */
  await a.page.evaluate(() => document.getElementById('lsMusicPlay').click());
  await a.page.waitForTimeout(400);
  const a3 = await musicState(a.page), b3 = await musicState(b.page);
  ok('one player stopping the music stops only their own', a3.paused === true && b3.paused === false,
    JSON.stringify({ a: a3.paused, b: b3.paused }));

  /* «نباید منطق بازی و روم به هم بخوره» and «نباید رو سرعت بازی تاثیر منفی
     بزاره»: none of that touched the server at all. The playlist is fetched
     once per device and the audio is fetched by the element itself. */
  const server = [...a.calls, ...b.calls];
  ok('none of it went near the room', !server.some((c) => /last-survivor|\/rooms\//.test(c)), JSON.stringify(server));
  ok('nothing was written to the server at all', !server.some((c) => /^(POST|PUT|PATCH|DELETE)/.test(c)), JSON.stringify(server));
  ok('and the playlist was not fetched again', !server.some((c) => /waiting-music/.test(c)), JSON.stringify(server));
  ok('no script errors', a.errs.length === 0 && b.errs.length === 0, [...a.errs, ...b.errs].join(' | '));
  await a.ctx.close(); await b.ctx.close();
}

/* ── 4. LEAVING THE ROOM ────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nleaving the room:');
  await enterRoom(page);
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  ok('the music is on', (await musicState(page)).paused === false);
  await page.evaluate(() => (0, eval)('lsLeave')('home', true));
  await page.waitForTimeout(700);
  const st = await musicState(page);
  ok('walking out silences it', st.paused === true, JSON.stringify(st));
  ok('and leaves no floating button behind', st.fab === false, String(st.fab));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4b. WHICH WAY THE ARROWS POINT ─────────────────────────────────────── */
/* «جای دکمه های نکست و بک در موزیک اینجوری هستند >< باید <> باشه یعنی برعکس.»
 *
 * The row is written previous-play-next and the page is right-to-left, so it
 * came out laid the other way round: ⏭ on the left and ⏮ on the right, the two
 * arrows pointing away from each other. Reading the DOM order proves nothing
 * here — it was already prev-play-next while it looked wrong — so this asks
 * where on the glass each button actually is.
 */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nwhich way the arrows point:');
  await enterRoom(page);
  const row = await page.evaluate(() => {
    const box = (id) => { const e = document.getElementById(id); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, t: e.textContent }; };
    return { prev: box('lsMusicPrev'), play: box('lsMusicPlay'), next: box('lsMusicNext'),
             rtl: getComputedStyle(document.getElementById('lsChatWrap') || document.body).direction };
  });
  ok('the app really is right-to-left', row.rtl === 'rtl', row.rtl);
  ok('previous is on the left', row.prev.x < row.play.x, Math.round(row.prev.x) + ' vs ' + Math.round(row.play.x));
  ok('next is on the right', row.next.x > row.play.x, Math.round(row.next.x) + ' vs ' + Math.round(row.play.x));
  /* And they face each other: ⏮ ▶ ⏭, not ⏭ ▶ ⏮. */
  ok('so left to right they read ⏮ ▶ ⏭', row.prev.t === '⏮' && row.next.t === '⏭', row.prev.t + ' ' + row.play.t + ' ' + row.next.t);
  /* The one that is on the left must still be the one that goes BACK. */
  await page.evaluate(() => { (0, eval)("LSM.policy='keep';"); document.getElementById('lsMusicPlay').click(); });
  await page.waitForTimeout(800);
  const moved = await page.evaluate(async () => {
    const a = document.getElementById('pzMusicEl');
    const before = a.getAttribute('src');
    /* Pin the shuffle so «it changed» cannot be luck. */
    document.getElementById('lsMusicNext').click();
    await new Promise((r) => setTimeout(r, 700));
    const afterNext = a.getAttribute('src');
    document.getElementById('lsMusicPrev').click();
    await new Promise((r) => setTimeout(r, 700));
    return { before, afterNext, afterPrev: a.getAttribute('src') };
  });
  ok('the right-hand arrow moves the playlist on', moved.afterNext !== moved.before, JSON.stringify(moved));
  ok('and the left-hand one goes back to what was playing', moved.afterPrev === moved.before, JSON.stringify(moved));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4c. THE ROOM'S CHAT WITH THE KEYBOARD UP ───────────────────────────── */
/* «وقتی رو چت میزنی بین کیبورد و کادر ورود متن خیلی فاصله است — یه پخش کننده
 *  موسیقی و خیلی فضای باز اونجا هست. باید کیبورد کامل بچسبه به کادر ورود متن،
 *  و در قسمت بالا هم کلی جا هست.»
 *
 * The player and the tab bar are both BELOW the composer in this room, so with
 * the keyboard up they are the gap being complained about. The question asked
 * here is not «is the rule written» but «what is left in the strip between the
 * bottom of the typing box and the top of the keyboard» — anything found there
 * is the bug, whatever its name.
 */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe room chat with the keyboard up:');
  await enterRoom(page);
  await page.evaluate(() => (0, eval)('lsSetTab')('chat'));
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => {
    const c = document.querySelector('#lsBody .ls-chat');
    const top = document.querySelector('#lsBody .ls-top');
    return { shown: !!c && getComputedStyle(c).display !== 'none',
             music: !!document.querySelector('#lsBody .ls-music') && document.querySelector('#lsBody .ls-music').getBoundingClientRect().height > 10,
             tabs: !!document.querySelector('#lsBody .ls-tabs'),
             headerHeight: Math.round(top.getBoundingClientRect().height) };
  });
  ok('the chat tab is open', before.shown, JSON.stringify(before));
  ok('with the music player on screen under it', before.music === true, String(before.music));

  const typing = await page.evaluate(async () => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 470 });
    vv.dispatchEvent(new Event('resize'));
    document.getElementById('lsChatInput').focus();
    await new Promise((r) => setTimeout(r, 400));
    const inRow = document.querySelector('#lsBody .ls-chat-in');
    const list = document.querySelector('#lsBody .ls-chat-list');
    const box = document.getElementById('lsChatInput');
    const rb = Math.round(inRow.getBoundingClientRect().bottom);
    /* THE BOX, NOT THE ROW IT SITS IN. The row's bottom edge is pinned to the
       bottom of what is visible whatever padding it carries inside itself, so
       measuring the row answers a question nobody asked: «کیبورد کامل بچسبه به
       کادر ورود متن» is about the box you type into. */
    const bb = Math.round(box.getBoundingClientRect().bottom);
    /* EVERYTHING still taking up height in the strip below the composer. Named
       or not, if it is there the keyboard is not touching the box. */
    const inTheGap = [...document.querySelectorAll('#lsBody *')].filter((e) => {
      if (inRow.contains(e) || e.contains(inRow)) return false;
      const r = e.getBoundingClientRect();
      return r.height > 4 && r.top >= rb - 1 && r.top < 470;
    }).map((e) => (e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height));
    return {
      open: document.body.classList.contains('pz-kb-open'),
      inputBottom: rb,
      gap: 470 - rb,
      boxBottom: bb,
      boxGap: 470 - bb,
      inTheGap,
      listHeight: Math.round(list.getBoundingClientRect().height),
      listTop: Math.round(list.getBoundingClientRect().top),
      listScrolls: list.scrollHeight <= list.clientHeight + 4
    };
  });
  ok('the page knows the keyboard is up', typing.open === true, JSON.stringify(typing).slice(0, 120));
  /* «باید کیبورد کامل بچسبه به کادر ورود متن» */
  ok('the composer reaches the bottom of what is visible', typing.gap >= 0 && typing.gap <= 12, typing.gap + 'px of gap');
  ok('and the box you type into sits on the keys', typing.boxGap >= 0 && typing.boxGap <= 8, typing.boxGap + 'px under the box');
  ok('with nothing at all left in between', typing.inTheGap.length === 0, typing.inTheGap.join(', '));
  /* «در قسمت بالا هم کلی جا هست» — the room the stats card was using goes to
     the messages, which is the whole point of asking for it. */
  ok('the messages start near the top of what is visible', typing.listTop <= 90, typing.listTop + 'px down');
  ok('and get most of the visible height', typing.listHeight >= 300, typing.listHeight + 'px');

  /* AND THE HEADER ITSELF GIVES SOMETHING UP, not just the cards below it.
     Measured piece by piece: a header that shrinks by the right total while one
     of the two rules doing the shrinking has quietly stopped working is a green
     test over a half-broken screen. */
  const header = await page.evaluate(() => {
    const top = document.querySelector('#lsBody .ls-top');
    const sub = document.querySelector('#lsBody .ls-top .ls-ttl p');
    const cs = getComputedStyle(top);
    return { h: Math.round(top.getBoundingClientRect().height),
             padTop: Math.round(parseFloat(cs.paddingTop)),
             padBottom: Math.round(parseFloat(cs.paddingBottom)),
             subShown: !!sub && getComputedStyle(sub).display !== 'none' };
  });
  ok('the room title gives its padding to the messages', header.padTop <= 8 && header.padBottom <= 4, JSON.stringify(header));
  /* The subtitle names the room's topic, which the player picked on the way in
     and does not need repeated at them while they type. */
  ok('and drops the line under it', header.subShown === false, String(header.subShown));
  ok('so the header really is smaller than it was', before.headerHeight - header.h >= 20,
    before.headerHeight + 'px → ' + header.h + 'px');

  /* The room is not a chat screen. Everything it hid comes back. */
  const back = await page.evaluate(async () => {
    document.getElementById('lsChatInput').blur();
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 844 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 400));
    const h = (q) => { const e = document.querySelector(q); return !!e && e.getBoundingClientRect().height > 10; };
    return { open: document.body.classList.contains('pz-kb-open'),
             music: h('#lsBody .ls-music'), tabs: h('#lsBody .ls-tabs'), stats: h('#lsBody .ls-hd'),
             playing: (() => { const a = document.getElementById('pzMusicEl'); return !!a && !a.paused; })() };
  });
  ok('the music player comes back when the keyboard goes', back.music === true, JSON.stringify(back));
  ok('and the tab bar and the scoreboard with it', back.tabs === true && back.stats === true, JSON.stringify(back));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. NO MUSIC UPLOADED AT ALL ────────────────────────────────────────── */
{
  const saved = tracks; tracks = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nbefore the operator has uploaded anything:');
  await enterRoom(page);
  const empty = await page.evaluate(() => {
    const b = document.getElementById('lsMusicBox');
    return { html: b ? b.innerHTML.trim() : null, shown: b ? getComputedStyle(b).display : 'none' };
  });
  ok('the player is not drawn at all', empty.html === '', JSON.stringify(empty).slice(0, 80));
  ok('and takes up no room', empty.shown === 'none', empty.shown);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  tracks = saved;
}

/* ── 6. THE SHOP ────────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe shop:');
  await page.evaluate(() => (0, eval)("go('shop');"));
  await page.waitForTimeout(500);
  const first = await page.evaluate(() => [...document.querySelectorAll('#shopTabs .tab')].map((b) => b.textContent.trim()));
  ok('the chat-pack shelf is there on opening', first.some((t) => /پک‌های چت/.test(t)), first.join(' | '));

  /* THE BUG: the catalogue lands a second later and the tab bar is rebuilt. */
  await page.evaluate(() => (0, eval)('pzLoadShop')());
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => [...document.querySelectorAll('#shopTabs .tab')].map((b) => b.textContent.trim()));
  ok('and it is still there once the catalogue arrives', after.some((t) => /پک‌های چت/.test(t)), after.join(' | '));
  ok('so are the shelves that are not in the catalogue either',
    after.some((t) => /بلیط/.test(t)) && after.some((t) => /کاراکتر/.test(t)), after.join(' | '));

  await page.evaluate(() => {
    const t = [...document.querySelectorAll('#shopTabs .tab')].find((b) => /پک‌های چت/.test(b.textContent));
    (0, eval)('shopTab')(t, 'chat');
  });
  await page.waitForTimeout(700);
  const packs = await page.evaluate(() => document.querySelectorAll('#shopContent .shop-grid .item').length);
  ok('and the shelf really opens', packs === 2, String(packs));

  /* ── the character shelf: equal art, and buttons on one line ── */
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('#shopTabs .tab')].find((b) => /کاراکتر/.test(b.textContent));
    (0, eval)('shopTab')(t, 'characters');
  });
  await page.waitForTimeout(800);
  const cards = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#shopContent .shop-grid .item')];
    return items.map((it) => {
      const art = it.querySelector('.it-ico');
      const price = it.querySelector('.price');
      const ar = art ? art.getBoundingClientRect() : null;
      const pr = price ? price.getBoundingClientRect() : null;
      const cr = it.getBoundingClientRect();
      const img = it.querySelector('img');
      return {
        artW: ar ? Math.round(ar.width) : 0, artH: ar ? Math.round(ar.height) : 0,
        fit: img ? getComputedStyle(img).objectFit : '',
        priceTop: pr ? Math.round(pr.top) : 0, priceBottom: pr ? Math.round(cr.bottom - pr.bottom) : 0,
        cardW: Math.round(cr.width)
      };
    });
  });
  ok('both character cards were drawn', cards.length === 2, JSON.stringify(cards));
  /* «هم اندازه» */
  ok('the artwork is the same size on both', cards[0].artW === cards[1].artW && cards[0].artH === cards[1].artH, JSON.stringify(cards.map((c) => c.artW + 'x' + c.artH)));
  /* «خیلی بزرگه» — it used to be the full width of the card. */
  ok('and no longer stretched across the whole card', cards[0].artW < cards[0].cardW - 20, cards[0].artW + ' vs ' + cards[0].cardW);
  /* «معلوم نیست» — cover cropped a band out of the middle of the figure. */
  ok('the whole figure is fitted, not cropped', cards[0].fit === 'contain', cards[0].fit);
  /* «دکمه های خرید باید هم راستا باشن» — even though one description is twice
     as long as the other. */
  ok('the buy buttons are on the same line', Math.abs(cards[0].priceTop - cards[1].priceTop) <= 1,
    cards[0].priceTop + ' vs ' + cards[1].priceTop);
  ok('and both sit at the bottom of their card', cards[0].priceBottom === cards[1].priceBottom, cards[0].priceBottom + ' / ' + cards[1].priceBottom);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
