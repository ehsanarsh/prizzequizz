/* CLOCKS YOU CAN ACTUALLY READ.
 *
 * «همهٔ تایمرهای ریزی که در صفحات آخرین بازمانده هست بزرگ بشن و خوانا دیده بشن،
 *  و تایمر انتخاب موضوع در دوئل و حتی متنش هم بولدتر بشه و با رنگ زیباتر و
 *  شاداب‌تر.»
 *
 * A font-size is only real once the cascade has had its say, and this file has
 * already lost one round to exactly that — a rule written at the wrong strength
 * that changed nothing and looked right in the diff. So nothing here reads the
 * stylesheet: it measures what the browser computed, on the real screens, and
 * checks the layouts those clocks sit in did not grow to fit them.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };
const px = (v) => Math.round(parseFloat(v) * 10) / 10;

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

async function open(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
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
  return { ctx, page };
}

const { ctx, page } = await open(390);

const base = (over) => Object.assign({
  room: { id: 'r1', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12, capacity: 20,
          grossPool: 800000, startsAt: Date.now() + 95000, serverNow: Date.now(), chatEnabled: true },
  me: { userId: 'u1', status: 'alive', units: 1 },
  stats: { alive: 12, eliminated: 3, cashedOut: 1, remainingPot: 700000 },
  players: [{ userId: 'u1', status: 'alive', units: 1 }], votes: 0
}, over);

async function paint(snap) {
  await page.evaluate((s) => {
    window.__s = s;
    (0, eval)('lsWatching=false'); (0, eval)('lsEndShown=false'); (0, eval)('lsRoomId="r1"');
    (0, eval)('lsMyId="u1"'); (0, eval)('lsSnap=window.__s'); (0, eval)('lsLastKey=""');
    try { showScreen('lsGame'); } catch (e) {}
    (0, eval)('lsBuild')(window.__s);
    (0, eval)('lsLive')(window.__s);
  }, snap);
  await page.waitForTimeout(350);
}

console.log('the waiting room:');
await paint(base({}));
const wait = await page.evaluate(() => {
  const t = document.getElementById('lsTimer');
  const sib = document.querySelector('.ls-hd-row .c b:not(#lsTimer)');
  const card = document.querySelector('.ls-hd');
  return { fs: getComputedStyle(t).fontSize, sibFs: getComputedStyle(sib).fontSize,
           text: t.textContent, colour: getComputedStyle(t).color,
           cardH: Math.round(card.getBoundingClientRect().height),
           overflow: t.scrollWidth > t.clientWidth + 1 };
});
ok('the «تا شروع» clock is printed', /[۰-۹]/.test(wait.text), wait.text);
ok('and it is bigger than the counts beside it', px(wait.fs) > px(wait.sibFs), wait.fs + ' vs ' + wait.sibFs);
ok('big enough to read across a room', px(wait.fs) >= 22, wait.fs);
ok('it is not clipped by its own box', wait.overflow === false);
ok('and the card it sits in stays a card', wait.cardH <= 130, wait.cardH + 'px');

console.log('the dashboard, waiting for the others:');
/* This header is drawn on ONE screen: the question phase, once you have
   answered and are waiting. That is where its clock lives, so that is the state
   to put the room in — asking for phase 'dashboard' renders something else
   entirely and would have tested nothing. */
await paint(base({ room: Object.assign(base({}).room, { status: 'running', phase: 'question', round: 4, phaseEndsAt: Date.now() + 42000 }),
  me: { userId: 'u1', status: 'alive', units: 1, answeredThisRound: true },
  question: { id: 'q4', round: 4, text: 'سؤال', options: ['الف', 'ب'], difficulty: 'easy' } }));
const dash = await page.evaluate(() => {
  const t = document.getElementById('lsTimer');
  if (!t) return { missing: true };
  const line = t.closest('p');
  return { fs: getComputedStyle(t).fontSize, lineFs: getComputedStyle(line).fontSize,
           text: t.textContent, lineText: (line.textContent || '').replace(/\s+/g, ' ').trim() };
});
ok('the round clock is on the dashboard', !dash.missing && /[۰-۹]/.test(dash.text), dash.text || 'missing');
ok('it is no longer caption-sized', px(dash.fs) >= 18, dash.fs);
ok('and the words around it are readable too', px(dash.lineFs) >= 12.5, dash.lineFs);
ok('the line still says which round this is', /مرحله/.test(dash.lineText || ''), dash.lineText);

console.log('the answer clock:');
await paint(base({ room: Object.assign(base({}).room, { status: 'running', phase: 'question', round: 4, phaseEndsAt: Date.now() + 12000 }),
  question: { id: 'q4', round: 4, text: 'سؤال', options: ['الف', 'ب', 'ج', 'د'], difficulty: 'medium' } }));
const q = await page.evaluate(() => {
  const c = document.querySelector('#lsGame .pzm-timer-circle');
  const num = document.getElementById('lsTimerN');
  const wrap = document.querySelector('#lsGame .pzm-timer');
  const opts = document.querySelector('#lsOpts');
  const cb = c && c.getBoundingClientRect(), wb = wrap && wrap.getBoundingClientRect();
  return c ? { w: Math.round(cb.width), fs: getComputedStyle(c).fontSize,
               num: num ? num.textContent : '', wrapH: Math.round(wb.height),
               spare: Math.round(wb.height - cb.height),
               optsTop: opts ? Math.round(opts.getBoundingClientRect().top) : 0,
               fits: opts ? opts.getBoundingClientRect().top < 844 : false } : { missing: true };
});
ok('the answer clock is on the card', !q.missing && q.w > 0, q.missing ? 'missing' : q.w + 'px');
ok('its circle grew', q.w >= 58, q.w + 'px');
ok('and so did the number in it', px(q.fs) >= 26, q.fs);
/* A bigger circle in the same row is how a clock ends up sitting on the
   question above it. The row has to have grown too, with room to spare. */
ok('and the row it sits in grew with it', q.spare >= 4, q.wrapH + 'px row, ' + q.w + 'px circle');
ok('the options are still on the screen under it', q.fits, 'options top ' + q.optsTop + 'px');

console.log('the first question, before it has arrived:');
/* «مودال آماده‌ای میاد، صفحهٔ پخش سوال میاد ولی بدون نوشته و خالی، و بعد سوال
   اول ظاهر می‌شه.» The ready gate is timed by the server; the question comes on
   its own push. On round one they do not always land together, and what was
   underneath the gate was the question card built from nothing. */
await paint(base({ room: Object.assign(base({}).room, { status: 'running', phase: 'ready', round: 1, phaseEndsAt: Date.now() + 4000 }) }));
const waiting = await page.evaluate(() => {
  const wrap = document.querySelector('#lsBody .ls-qwrap');
  const card = document.querySelector('#lsBody .ls-qcard');
  const opts = document.querySelectorAll('#lsOpts .ans');
  return { has: !!wrap, txt: (card ? card.textContent : '').replace(/\s+/g, ' ').trim(),
           h: card ? Math.round(card.getBoundingClientRect().height) : 0,
           waitClass: !!document.querySelector('#lsBody .ls-qcard.ls-qwait'),
           dots: document.querySelectorAll('#lsBody .lsqw-dots i').length,
           opts: opts.length, clock: !!document.getElementById('lsTimer') };
});
ok('a card is on screen', waiting.has);
ok('and it says the question is coming, not nothing at all', /در راه است/.test(waiting.txt), waiting.txt.slice(0, 40));
ok('it does not show an empty question box', waiting.waitClass && waiting.opts === 0);
ok('it is animated, so it reads as waiting rather than stuck', waiting.dots === 3);
/* Not the height of a real question — that carries four options — but enough
   that it reads as a card rather than a sliver. */
ok('it is a card, not a sliver', waiting.h >= 120, waiting.h + 'px');
ok('and the clock still has somewhere to be drawn', waiting.clock);

/* The moment the question lands, the card is the question. */
await paint(base({ room: Object.assign(base({}).room, { status: 'running', phase: 'ready', round: 1, phaseEndsAt: Date.now() + 4000 }),
  question: { id: 'q1', round: 1, text: 'پایتخت ایران کجاست؟', options: ['تهران', 'شیراز', 'اصفهان', 'تبریز'], difficulty: 'easy' } }));
const arrived = await page.evaluate(() => ({
  txt: (document.querySelector('#lsBody .ls-qtext') || {}).textContent || '',
  opts: document.querySelectorAll('#lsOpts .ans').length,
  waiting: !!document.querySelector('#lsBody .ls-qcard.ls-qwait')
}));
ok('the question replaces it', /پایتخت/.test(arrived.txt), arrived.txt);
ok('with all of its options', arrived.opts === 4, String(arrived.opts));
ok('and no trace of the waiting card', arrived.waiting === false);

console.log('and on a narrow phone:');
await ctx.close();
const small = await open(360);
await small.page.evaluate((s) => {
  window.__s = s; (0, eval)('lsRoomId="r1"'); (0, eval)('lsMyId="u1"'); (0, eval)('lsSnap=window.__s'); (0, eval)('lsLastKey=""');
  try { showScreen('lsGame'); } catch (e) {}
  (0, eval)('lsBuild')(window.__s); (0, eval)('lsLive')(window.__s);
}, base({ room: Object.assign(base({}).room, { status: 'running', phase: 'question', round: 4, phaseEndsAt: Date.now() + 12000 }),
  question: { id: 'q4', round: 4, text: 'سؤال', options: ['الف', 'ب', 'ج', 'د'], difficulty: 'medium' } }));
await small.page.waitForTimeout(350);
const narrow = await small.page.evaluate(() => {
  const c = document.querySelector('#lsGame .pzm-timer-circle');
  const bars = document.querySelectorAll('#lsGame .pzm-timer-bar');
  const wrap = document.querySelector('#lsGame .pzm-timer');
  const cb = c.getBoundingClientRect(), wb = wrap.getBoundingClientRect();
  return { w: Math.round(cb.width), fs: getComputedStyle(c).fontSize,
           row: Math.round(wb.width), spare: Math.round(wb.height - cb.height),
           bars: [...bars].map((b) => Math.round(b.getBoundingClientRect().width)) };
});
ok('the clock still fits a 360px screen', narrow.w + narrow.bars[0] + narrow.bars[1] <= narrow.row + 2,
  narrow.w + ' + ' + narrow.bars.join(' + ') + ' in ' + narrow.row);
ok('with the same room to spare as on a wide one', narrow.spare >= 4, narrow.spare + 'px');
ok('and is still bigger than it was', narrow.w >= 50 && px(narrow.fs) >= 22, narrow.w + 'px / ' + narrow.fs);

console.log('the duel’s topic clock:');
await small.page.evaluate(() => { try { showScreen('topic-pick'); } catch (e) {} });
await small.page.waitForTimeout(350);
const tp = await small.page.evaluate(() => {
  const b = document.getElementById('tpCount');
  const line = document.querySelector('#topic-pick .tp-clock');
  const cs = getComputedStyle(b), ls = getComputedStyle(line);
  return { numFs: cs.fontSize, numW: cs.fontWeight, bg: cs.backgroundImage, anim: cs.animationName,
           lineFs: ls.fontSize, lineW: ls.fontWeight, lineColour: ls.color,
           text: (line.textContent || '').replace(/\s+/g, ' ').trim(),
           grid: document.querySelector('#topic-pick .topic-grid') ? Math.round(document.querySelector('#topic-pick .topic-grid').getBoundingClientRect().top) : 0 };
});
ok('the sentence is still the sentence', /حق انتخاب/.test(tp.text) && /ثانیه/.test(tp.text), tp.text);
ok('and it is bolder than the grey it was', Number(tp.lineW) >= 700 && px(tp.lineFs) >= 13, tp.lineW + ' @ ' + tp.lineFs);
ok('in a warmer colour, not muted grey', tp.lineColour !== 'rgb(139, 148, 167)' && /2[0-9][0-9]|1[0-9][0-9]/.test(tp.lineColour), tp.lineColour);
ok('the number is a chip, not a word', /gradient/.test(tp.bg), tp.bg.slice(0, 40));
ok('bigger and heavier than the line', px(tp.numFs) > px(tp.lineFs) && Number(tp.numW) >= 800, tp.numFs + ' / ' + tp.numW);
ok('and it beats, so the hurry is visible', tp.anim && tp.anim !== 'none', tp.anim);
ok('the topics are still right under it', tp.grid > 0 && tp.grid < 500, tp.grid + 'px');

console.log(`\n[lstimers] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
