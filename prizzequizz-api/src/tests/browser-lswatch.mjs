/* OUT OF THE ROOM WHEN YOUR OWN MATCH IS OVER.
 *
 * «وقتی از آخرین بازمانده چه برداشت و چه بازنده میای بیرون ولی تو اون روم هنوز
 *  بازی جریان داره، مودال تایمر همون روم میاد رو صفحه … اگه تا ده ثانیه تماشای
 *  مسابقه رو نزنه دیگه اتومات از روم خارج بشه و دکمه غیرفعال بشه و همون تایمر
 *  ۱۰ ثانیه‌ای روی دکمه باشد.»
 *
 * Two faults, one cause. Leaving a Last Survivor room stopped the poll but
 * never dropped the socket subscription, so the room kept pushing its rounds at
 * a player who was no longer in it; and the ready gate is drawn by lsBuild,
 * which runs BEFORE the check that sends an eliminated player to their result
 * screen — so the countdown for a question they cannot answer went up, and the
 * result screen was drawn underneath it.
 *
 * Both are about what happens AFTER a call, in real time, so this drives the
 * game's own functions in a real browser rather than reading the source.
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان',
    level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));

const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/* A room that is STILL RUNNING, and a snapshot in which this player is out. */
const snapFor = (status) => ({
  room: { id: 'room-1', status: 'running', phase: 'ready', round: 4, totalRounds: 12,
          phaseEndsAt: Date.now() + 5000, serverNow: Date.now() },
  me: { userId: 'u1', status, payoutCash: status === 'cashed_out' ? 42000 : 0, units: 1, currentShare: 42000 },
  stats: { alive: 6, remainingPot: 500000 },
  players: [], question: { id: 'q9', round: 4, text: 'سؤال', options: ['a', 'b'] }
});

console.log('the ready gate:');
/* The gate must not go up for somebody whose own match is over — that is the
   modal that was landing on the result screen. */
const gate = await page.evaluate((snap) => {
  const out = {};
  const shown = () => { const m = document.getElementById('aaaModal'); return !!(m && getComputedStyle(m).display !== 'none'); };
  const close = () => { try { (0, eval)('closeAaaModal()'); } catch (e) {} };
  try {
    close();
    (0, eval)('lsWatching=false'); (0, eval)('lsEndShown=false'); (0, eval)('lsReadyShownRound=""');
    (0, eval)('lsReadyGate')(snap);           // eliminated
    out.eliminated = shown();
    close();
    const alive = JSON.parse(JSON.stringify(snap)); alive.me.status = 'alive';
    (0, eval)('lsReadyShownRound=""');
    (0, eval)('lsReadyGate')(alive);
    out.alive = shown();
    close();
    const waiting = JSON.parse(JSON.stringify(snap)); waiting.me.status = 'waiting';
    (0, eval)('lsReadyShownRound=""');
    (0, eval)('lsReadyGate')(waiting);
    out.waiting = shown();
    close();
    const cashed = JSON.parse(JSON.stringify(snap)); cashed.me.status = 'cashed_out';
    (0, eval)('lsReadyShownRound=""');
    (0, eval)('lsReadyGate')(cashed);
    out.cashed = shown();
    close();
    (0, eval)('lsWatching=true'); (0, eval)('lsReadyShownRound=""');
    (0, eval)('lsReadyGate')(snap);           // a spectator asked to be here
    out.watching = shown();
    close();
    (0, eval)('lsWatching=false'); (0, eval)('lsEndShown=true'); (0, eval)('lsReadyShownRound=""');
    (0, eval)('lsReadyGate')(alive);
    out.afterResult = shown();
    close(); (0, eval)('lsEndShown=false');
  } catch (e) { out.err = String(e).slice(0, 120); }
  return out;
}, snapFor('eliminated'));
ok('no timer modal for a player who is out', gate.eliminated === false, String(gate.err || gate.eliminated));
ok('but the players still in it are gated', gate.alive === true);
/* «waiting» is the status EVERY player holds until the room starts, so the
   first round of every match is asked for in that state. Reading it as «not
   alive, therefore out» left round one ungated: a card with its text hidden
   and a clock running, which is the blank screen that was reported. */
ok('and so is a player the match has not started for yet', gate.waiting === true, String(gate.waiting));
ok('a player who cashed out is not gated either', gate.cashed === false, String(gate.cashed));
ok('and so is a spectator, who asked to be there', gate.watching === true);
ok('none of it lands on the result screen', gate.afterResult === false);

console.log('the ten seconds:');
const start = await page.evaluate((snap) => {
  (0, eval)('lsWatching=false'); (0, eval)('lsEndShown=false');
  (0, eval)('lsRoomId="room-1"'); window.__snap = snap; (0, eval)('lsSnap=window.__snap');
  try { (0, eval)('lsFinish')(snap); } catch (e) { return { err: String(e).slice(0, 140) }; }
  const b = document.getElementById('lsWatchBtn');
  return { err: '', text: b ? b.textContent : '', disabled: b ? b.disabled : null,
           shown: b ? b.style.display !== 'none' : null, room: (0, eval)('lsWatchRoom') };
}, snapFor('eliminated'));
ok('the watch button is offered', start.shown === true, start.err || start.text);
ok('with the seconds counted on it', /\(/.test(start.text) && /[۰-۹]/.test(start.text), start.text);
ok('and it is live, not dead', start.disabled === false);
ok('the room is still held while the offer stands', start.room === 'room-1');

await page.waitForTimeout(3200);
const mid = await page.evaluate(() => {
  const b = document.getElementById('lsWatchBtn');
  return { text: b.textContent, left: (0, eval)('lsWatchLeft') };
});
ok('the number really counts down', mid.left > 0 && mid.left < 10, mid.text + ' left=' + mid.left);

/* Past ten seconds: out of the room, button dead, and it says why. */
await page.waitForTimeout(8000);
const after = await page.evaluate(() => {
  const b = document.getElementById('lsWatchBtn');
  return { text: b.textContent, disabled: b.disabled, room: (0, eval)('lsWatchRoom'),
           roomId: (0, eval)('lsRoomId'), poller: (0, eval)('lsPoller'), watching: (0, eval)('lsWatching') };
});
ok('the offer expires', after.disabled === true, after.text);
ok('and says the WATCHING window closed, not that the match ended', /مهلت/.test(after.text), after.text);
ok('the room is let go of', after.room === null && after.roomId === null, String(after.room) + '/' + String(after.roomId));
ok('and nothing is still polling it', after.poller === null && after.watching === false);

console.log('taking the offer instead:');
const took = await page.evaluate((snap) => {
  (0, eval)('lsEndShown=false'); (0, eval)('lsRoomId="room-2"');
  const s2 = JSON.parse(JSON.stringify(snap)); s2.room.id = 'room-2';
  try { (0, eval)('lsFinish')(s2); } catch (e) { return { err: String(e).slice(0, 140) }; }
  const before = (0, eval)('lsWatchTimer') !== null;
  (0, eval)('lsWatchMatch()');
  return { err: '', before, timer: (0, eval)('lsWatchTimer'), watching: (0, eval)('lsWatching'), room: (0, eval)('lsRoomId') };
}, snapFor('cashed_out'));
ok('a player who cashed out is offered it too', took.before === true, took.err);
ok('pressing it stops the countdown', took.timer === null);
ok('and puts them back in the room as a spectator', took.watching === true && took.room === 'room-2', String(took.room));

const stopped = await page.evaluate(() => {
  (0, eval)('lsStopWatching()');
  const b = document.getElementById('lsWatchBtn');
  return { room: (0, eval)('lsWatchRoom'), watching: (0, eval)('lsWatching'), disabled: b.disabled, text: b.textContent };
});
ok('leaving the watch leaves the room for good', stopped.room === null && stopped.watching === false);
ok('and the button does not offer a second visit', stopped.disabled === true, stopped.text);

/* A winner has no room left to watch, and must not be holding one. */
const winner = await page.evaluate(() => {
  (0, eval)('lsEndShown=false'); (0, eval)('lsRoomId="room-3"');
  const snap = { room: { id: 'room-3', status: 'finished', phase: 'finished', round: 9, totalRounds: 9 },
    me: { userId: 'u1', status: 'alive', payoutCash: 900000, units: 1 }, stats: { alive: 1, remainingPot: 0 }, players: [] };
  try { (0, eval)('lsFinish')(snap); } catch (e) { return { err: String(e).slice(0, 140) }; }
  const b = document.getElementById('lsWatchBtn');
  return { err: '', shown: b.style.display !== 'none', room: (0, eval)('lsWatchRoom'), text: b.textContent };
});
ok('a winner is offered nothing to watch', winner.shown === false, winner.err || winner.text);
ok('and holds no room open', winner.room === null);

console.log(`\n[lswatch] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
