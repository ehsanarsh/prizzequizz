/* THE RESULT SCREEN WHEN EVERYBODY WENT OUT TOGETHER.
 *
 * From four real two-player matches: «بازی اول برای هر دو کاربر باختی داد، بازی
 *  دوم برای یک کاربر نوشت چون همه اشتباه جواب دادند پول بین همه تقسیم شد ولی
 *  +۰ تومان.»
 *
 * Two separate faults behind that. The pot used to be paid to ONE of them, so
 * the other's screen had nothing true to say; and the news of the ending
 * (ls:ended) arrives on its own, ahead of the snapshot carrying what this
 * player was actually paid — so the screen could print the sharing message
 * beside «+۰», reporting a real payment as nothing.
 *
 * The pot is split among all of them now. What is left to hold is the screen:
 * a figure of zero is never shown as a prize, and the message matches it.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };
const faNum = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '٬').replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

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
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 0, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

const PAID = 22200;
const wiped = (payoutCash) => ({
  room: { id: 'r9', status: 'finished', phase: 'finished', round: 3, totalRounds: 12,
          wipeout: { splitAmong: 2, paidCount: 2, percent: 60, paid: PAID * 2 } },
  me: { userId: 'u1', status: 'eliminated', units: 1, payoutCash,
        reveal: { options: ['الف', 'ب'], correctIndex: 0, yourIndex: 1 } },
  stats: { alive: 0, eliminated: 2, cashedOut: 0, remainingPot: 0 },
  players: [{ userId: 'u1', status: 'eliminated', payoutCash }, { userId: 'u2', status: 'eliminated', payoutCash: PAID }]
});
const finish = async (snap) => {
  await page.evaluate((s) => {
    window.__s = s;
    (0, eval)('lsEndShown=false'); (0, eval)('_lsWaitedForPay=false'); (0, eval)('lsWipeout=null');
    (0, eval)('lsWatching=false'); (0, eval)('lsRoomId="r9"'); (0, eval)('lsSnap=window.__s');
    (0, eval)('lsFinish')(window.__s);
  }, snap);
  await page.waitForTimeout(500);
  return page.evaluate(() => ({
    title: (document.getElementById('resultTitle') || {}).textContent || '',
    sub: (document.getElementById('resultSub') || {}).textContent || '',
    amt: (document.getElementById('resultAmt') || {}).textContent || '',
    amtShown: (() => { const a = document.getElementById('resultAmt'); const b = a && a.parentElement;
      return !!(b && getComputedStyle(b).display !== 'none'); })()
  }));
};

/* «باید باختی رو بنویسه ولی بهشون بگه با اینکه باختی فلان مبلغ رو برنده شدی.
    بهشون نمی‌گیم که همه اشتباه جواب دادن.»
   Two halves, and the second is as load-bearing as the first: the arithmetic
   that produced the money is ours, and printing it turns a gift into an
   explanation of why they nearly got nothing. */
console.log('a player who lost but was paid anyway:');
const paid = await finish(wiped(PAID));
ok('is told plainly that they lost', /باختی/.test(paid.title), paid.title);
ok('and in the same breath, that they were paid', /جایزه/.test(paid.title), paid.title);
ok('the sentence names the figure they won', paid.sub.indexOf(faNum(PAID)) >= 0, paid.sub.slice(0, 80));
ok('and says it reached their prize fund', /صندوق جایزه/.test(paid.sub), paid.sub.slice(0, 80));
ok('it reads as a gift, not as an accident', /گاهی/.test(paid.sub), paid.sub.slice(0, 80));
ok('nothing tells them everyone answered wrongly', !/اشتباه/.test(paid.sub) && !/غلط/.test(paid.sub), paid.sub.slice(0, 80));
ok('and the split is not explained to them either',
  !/٪/.test(paid.sub) && !/تقسیم/.test(paid.sub) && !/حذف شدند/.test(paid.sub), paid.sub.slice(0, 80));
ok('their figure is shown', paid.amt === '+' + faNum(PAID), paid.amt);
ok('and it is not zero', paid.amtShown && !/\+۰$/.test(paid.amt));

console.log('a player whose payment has not landed on the snapshot yet:');
const racing = await page.evaluate((p) => {
  const s = {
    room: { id: 'r9', status: 'finished', phase: 'finished', round: 3, totalRounds: 12 },
    me: { userId: 'u1', status: 'eliminated', units: 1, payoutCash: 0 },
    stats: { alive: 0, eliminated: 2, cashedOut: 0, remainingPot: 0 },
    players: []
  };
  window.__s = s;
  (0, eval)('lsEndShown=false'); (0, eval)('_lsWaitedForPay=false');
  (0, eval)('lsWatching=false'); (0, eval)('lsRoomId="r9"'); (0, eval)('lsSnap=window.__s');
  window.__w = { splitAmong: 2, paidCount: 2, percent: 60, paid: p * 2 };
  (0, eval)('lsWipeout=window.__w');
  (0, eval)('lsFinish')(s);
  return { finalised: (0, eval)('lsEndShown'), waited: (0, eval)('_lsWaitedForPay') };
}, PAID);
ok('the screen is not finalised on it', racing.finalised === false, String(racing.finalised));
ok('it waits for the figure instead', racing.waited === true);

const settled = await finish(wiped(PAID));
ok('once it lands, the amount is real', settled.amt === '+' + faNum(PAID), settled.amt);
ok('and never «+۰»', !/\+۰$/.test(settled.amt));

console.log('a player in a shared wipe-out whose own share came to nothing:');
/* The room DID share the pot — the message about sharing is true of the room —
   but this particular player's share rounded to nothing, or their tier carries
   no units. Telling them «سهمت پرداخت شد» beside a blank is the same lie as
   «+۰», one step removed. */
const zeroShare = await page.evaluate(async () => {
  const s = {
    room: { id: 'r9', status: 'finished', phase: 'finished', round: 3, totalRounds: 12,
            wipeout: { splitAmong: 3, paidCount: 2, percent: 60, paid: 40000 } },
    me: { userId: 'u1', status: 'eliminated', units: 0, payoutCash: 0 },
    stats: { alive: 0, eliminated: 3, cashedOut: 0, remainingPot: 0 }, players: []
  };
  window.__s = s;
  (0, eval)('lsEndShown=false');
  /* The wait has already happened: this player really was paid nothing. */
  (0, eval)('_lsWaitedForPay=true'); (0, eval)('lsWipeout=null');
  (0, eval)('lsWatching=false'); (0, eval)('lsRoomId="r9"'); (0, eval)('lsSnap=window.__s');
  (0, eval)('lsFinish')(s);
  await new Promise((r) => setTimeout(r, 400));
  const a = document.getElementById('resultAmt'), b = a && a.parentElement;
  return { title: (document.getElementById('resultTitle') || {}).textContent || '',
           sub: (document.getElementById('resultSub') || {}).textContent || '',
           amt: a ? a.textContent : '', shown: !!(b && getComputedStyle(b).display !== 'none') };
});
ok('is not told they were paid', !/جایزه گرفتی/.test(zeroShare.title), zeroShare.title);
ok('and no figure is promised in the sentence', !/واریز شد/.test(zeroShare.sub), zeroShare.sub.slice(0, 60));
ok('no figure is shown', zeroShare.shown === false || zeroShare.amt === '', zeroShare.amt);

console.log('a player who genuinely got nothing:');
const nothing = await page.evaluate(async () => {
  const s = {
    room: { id: 'r9', status: 'finished', phase: 'finished', round: 3, totalRounds: 12, forfeited: 90000 },
    me: { userId: 'u1', status: 'eliminated', units: 1, payoutCash: 0 },
    stats: { alive: 0, eliminated: 2, cashedOut: 0, remainingPot: 0 }, players: []
  };
  window.__s = s;
  (0, eval)('lsEndShown=false'); (0, eval)('_lsWaitedForPay=true');
  (0, eval)('lsWipeout=null');
  (0, eval)('lsWatching=false'); (0, eval)('lsRoomId="r9"'); (0, eval)('lsSnap=window.__s');
  (0, eval)('lsFinish')(s);
  await new Promise((r) => setTimeout(r, 400));
  const a = document.getElementById('resultAmt'), b = a && a.parentElement;
  return { title: (document.getElementById('resultTitle') || {}).textContent || '',
           sub: (document.getElementById('resultSub') || {}).textContent || '',
           amt: a ? a.textContent : '', shown: !!(b && getComputedStyle(b).display !== 'none') };
});
/* For this player it WAS just a loss, and that is all they are told. The old
   screen used the forfeited pot to announce «کسی زنده نموند» — an explanation
   of the room's arithmetic, handed to the one person it did not benefit. */
ok('is told they lost, and nothing more', /باختی/.test(nothing.title), nothing.title);
ok('the room’s arithmetic is not read out to them',
  !/زنده نموند/.test(nothing.title) && !/برنده‌ای نداشت/.test(nothing.sub), nothing.sub.slice(0, 60));
ok('and is shown no figure at all', nothing.shown === false || nothing.amt === '', nothing.amt);

console.log(`\n[lsresult] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
