/* THE PHRASE LIST, OVER A ROOM THAT IS STILL RUNNING.
 *
 * «وقتی باتوم‌شیت ادامه می‌دهم میاد و می‌زنم ادامه می‌دهم، دیگه پنجرهٔ چتی که باز
 *  کردم اسکرول نمی‌شه تا جمله انتخاب کنم … در تمام مراحل این صفحات باید چت خیلی
 *  روان باشه به غیر از پخش سوال.»
 *
 * The cash-out sheet keeps its full-width fixed bar after it is answered — it
 * becomes a «منتظر بقیه…» line, but it is still a bar across the bottom of the
 * screen at z-index 800, and the phrase sheet was at 60. So the list opened
 * BEHIND it and every touch along the bottom went to a strip with nothing left
 * to tap.
 *
 * Stacking and hit-testing are not readable from the source, so this asks the
 * browser what is actually on top and what actually receives a touch.
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

/* Enough sentences that the list must scroll to reach the last of them. */
const PHRASES = Array.from({ length: 40 }, (_, i) => 'جملهٔ شمارهٔ ' + (i + 1));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname;
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (/chat-packs/.test(p)) return send({ packs: [{ key: 'friendly', name: 'دوستانه', emoji: '🙂', owned: true, locked: false, phraseCount: PHRASES.length, phrases: PHRASES }] });
  return send({});
});

const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/* Put the room on screen with the cash-out sheet up, undecided. */
const snap = {
  room: { id: 'room-1', status: 'running', phase: 'cashout', round: 4, totalRounds: 12, phaseEndsAt: Date.now() + 20000, serverNow: Date.now(), chatEnabled: true },
  me: { userId: 'u1', status: 'alive', units: 1, currentShare: 42000, decisionThisRound: null },
  stats: { alive: 6, remainingPot: 500000 }, players: [{ userId: 'u1', status: 'alive', units: 1 }]
};
await page.evaluate((s) => {
  window.__s = s;
  (0, eval)('lsWatching=false'); (0, eval)('lsEndShown=false'); (0, eval)('lsRoomId="room-1"');
  (0, eval)('lsMyId="u1"'); (0, eval)('lsSnap=window.__s');
  try { showScreen('lsGame'); } catch (e) {}
  (0, eval)('lsOverlays')(window.__s);
}, snap);
await page.waitForTimeout(400);
ok('the cash-out sheet is up', await page.isVisible('#lsCashPop'));

console.log('after «ادامه می‌دهم»:');
await page.evaluate(() => {
  const s = window.__s; s.me.decisionThisRound = 'continue';
  (0, eval)('lsOverlays')(s);
});
await page.waitForTimeout(300);
const decided = await page.evaluate(() => {
  const c = document.getElementById('lsCashPop');
  return { has: c.classList.contains('decided'), pe: getComputedStyle(c).pointerEvents, txt: (c.textContent || '').trim().slice(0, 30) };
});
ok('the sheet becomes a status line', decided.has, decided.txt);
ok('and stops swallowing touches', decided.pe === 'none', decided.pe);

console.log('opening the phrase list over it:');
await page.evaluate(() => { try { (0, eval)('qcOpen()'); } catch (e) {} });
await page.waitForTimeout(900);
const open = await page.evaluate(() => {
  const sh = document.getElementById('qcpSheet');
  const body = document.getElementById('qcpBody');
  const cash = document.getElementById('lsCashPop');
  return {
    shown: sh.classList.contains('show'),
    z: Number(getComputedStyle(sh).zIndex || 0),
    cashZ: Number(getComputedStyle(cash).zIndex || 0),
    cashHidden: getComputedStyle(cash).display === 'none',
    bodyFlag: document.body.classList.contains('qcp-open'),
    count: body.querySelectorAll('button').length,
    scrollable: body.scrollHeight > body.clientHeight + 4,
    sh: body.scrollHeight, ch: body.clientHeight
  };
});
ok('the list opens', open.shown && open.count > 0, open.count + ' sentences');
ok('above the room’s own sheet', open.z > open.cashZ, open.z + ' vs ' + open.cashZ);
ok('and the status strip steps out of the way', open.cashHidden && open.bodyFlag);
ok('the list is long enough to need scrolling', open.scrollable, open.sh + ' / ' + open.ch);

/* THE ACTUAL COMPLAINT: a touch in the middle of the list has to reach the
   list, and dragging has to move it. */
const hit = await page.evaluate(() => {
  const body = document.getElementById('qcpBody');
  const r = body.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height - 12);
  return { id: (el && (el.id || el.className)) || '', inList: !!(el && body.contains(el)) };
});
ok('a touch near the bottom of the list lands in the list', hit.inList, String(hit.id).slice(0, 40));

const scrolled = await page.evaluate(async () => {
  const body = document.getElementById('qcpBody');
  const before = body.scrollTop;
  body.scrollTop = body.scrollHeight;
  await new Promise((r) => setTimeout(r, 120));
  return { before, after: body.scrollTop };
});
ok('and it really scrolls to the last sentence', scrolled.after > scrolled.before, scrolled.before + ' → ' + scrolled.after);

const last = await page.evaluate(() => {
  const body = document.getElementById('qcpBody');
  const btns = body.querySelectorAll('button');
  const b = btns[btns.length - 1];
  const r = b.getBoundingClientRect();
  const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { text: b.textContent, reachable: el === b || b.contains(el) };
});
ok('the last sentence can actually be tapped', last.reachable, last.text);

console.log('but never over a question:');
await page.evaluate(() => {
  const s = { room: { id: 'room-1', status: 'running', phase: 'ready', round: 5, totalRounds: 12, phaseEndsAt: Date.now() + 5000 },
    me: { userId: 'u1', status: 'alive' }, question: { id: 'q5', round: 5, text: 'x', options: ['a', 'b'] }, stats: { alive: 6 } };
  (0, eval)('lsReadyShownRound=""');
  (0, eval)('lsReadyGate')(s);
});
await page.waitForTimeout(400);
const gated = await page.evaluate(() => ({
  sheet: document.getElementById('qcpSheet').classList.contains('show'),
  flag: document.body.classList.contains('qcp-open'),
  modal: getComputedStyle(document.getElementById('aaaModal')).display !== 'none'
}));
ok('the ready gate closes the phrase list', gated.sheet === false && gated.flag === false);
ok('and the question gate is the thing on screen', gated.modal === true);

console.log(`\n[lschat] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
