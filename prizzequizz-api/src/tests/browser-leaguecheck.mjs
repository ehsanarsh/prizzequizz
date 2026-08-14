/* THE LEAGUE'S START BUTTON.
 *
 * «یه دکمه با عنوان شروع مسابقه لیگ باشه با تایمر معکوس و وقتی زمانش رسید فعال
 * بشه و هرکی روش زد بره داخل روم و روم‌ها یکی یکی بعد ورود تکمیل بشه.»
 *
 * Which room a player lands in is the server's decision and is tested there.
 * What is tested HERE is the promise the screen makes: a dead button with a
 * running countdown on its face, that comes alive by itself when the clock
 * reaches the door, and that spends exactly one press.
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

/* One league payload, shaped exactly like /leagues/me, with the two moments the
   screen turns on: when the doors open and when the first question is asked. */
function payload(over = {}) {
  const now = Date.now();
  return Object.assign({
    enabled: true, seasonId: '2026-W33', rank: 4, cup: 820,
    tiers: [
      { key: 'gold', label: 'لیگ طلایی', emoji: '🥇', fromRank: 1, toRank: 15, participationPrize: 50000, winnerPrize: 500000, prizeType: 'cash' },
      { key: 'silver', label: 'لیگ نقره‌ای', emoji: '🥈', fromRank: 16, toRank: 30, participationPrize: 25000, winnerPrize: 250000, prizeType: 'cash' }
    ],
    roomSize: 15,
    doorsOpenAt: now + 3600_000, kickoffAt: now + 4200_000,
    tier: { key: 'gold', label: 'لیگ طلایی', emoji: '🥇', fromRank: 1, toRank: 15, participationPrize: 50000, winnerPrize: 500000, prizeType: 'cash' },
    qualifiedTier: 'gold', tickets: { gold: 1 }, cutLines: [], room: null,
    canEnter: false, enterBlockedReason: 'هنوز زمان ورود نرسیده است.'
  }, over);
}

let league = payload();
const entries = [];
let enterReply = { roomId: 'R1', tier: 'gold', roomNo: 1, round: 1, startsAt: Date.now() + 8000, seats: 3, roomSize: 15, joined: true, full: false, room: null };

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 9, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/leagues/me') return send(league);
    if (p === '/leagues/enter') { entries.push(Date.now()); return send(enterReply); }
    if (/^\/leagues\/rooms\//.test(p)) return send({ roomId: 'R1', phase: 'lobby', players: [], you: {} });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

const openLeague = async (page) => {
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('leagues'); renderLeagueHub();"));
  await page.waitForTimeout(700);
};
const readBtn = (page) => page.evaluate(() => {
  const b = document.getElementById('lgStartBtn');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return {
    label: (document.getElementById('lgStartLabel') || {}).textContent || '',
    face: (document.getElementById('lgStartCount') || {}).textContent || '',
    why: (document.getElementById('lgStartWhy') || {}).textContent || '',
    disabled: b.disabled, primary: b.className.indexOf('btn-primary') >= 0,
    onScreen: r.width > 100 && r.height > 20
  };
});

/* ── 1. LOCKED, WITH THE WAIT ON ITS FACE ───────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('an hour before the doors open:');
  league = payload();
  await openLeague(page);
  const b = await readBtn(page);
  ok('the button exists and is on the screen', !!b && b.onScreen, JSON.stringify(b && { w: b.onScreen }));
  ok('and says what it is for', /شروع مسابقه لیگ/.test(b.label), b.label);
  ok('but cannot be pressed yet', b.disabled === true, String(b.disabled));
  ok('and carries the countdown on its own face', /ساعت|دقیقه|:/.test(b.face), b.face);
  ok('with the reason spelled out', /زمان ورود/.test(b.why), b.why);

  /* A countdown that does not count is a label. */
  const a = await readBtn(page); await page.waitForTimeout(2100); const c = await readBtn(page);
  ok('the countdown actually ticks', a.face !== c.face || /ساعت/.test(a.face), a.face + ' → ' + c.face);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE LAST MINUTES COUNT IN SECONDS ───────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('four minutes before the doors open:');
  league = payload({ doorsOpenAt: Date.now() + 245_000, kickoffAt: Date.now() + 845_000 });
  await openLeague(page);
  const a = await readBtn(page);
  ok('the face counts minutes and seconds, not «۴ دقیقه»', /^[۰-۹]+:[۰-۹]{2}$/.test(a.face.trim()), a.face);
  await page.waitForTimeout(2100);
  const b = await readBtn(page);
  ok('and it is falling', a.face !== b.face, a.face + ' → ' + b.face);
  ok('still locked', b.disabled === true);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. IT OPENS ITSELF WHEN THE CLOCK REACHES ZERO ─────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('as the doors open:');
  league = payload({ doorsOpenAt: Date.now() + 2500, kickoffAt: Date.now() + 602_500 });
  await openLeague(page);
  ok('locked to begin with', (await readBtn(page)).disabled === true);
  /* The server is what decides — so from this moment it answers yes. */
  league = payload({ doorsOpenAt: Date.now() - 1000, kickoffAt: Date.now() + 600_000, canEnter: true, enterBlockedReason: '' });
  await page.waitForTimeout(4200);
  const b = await readBtn(page);
  ok('the button comes alive by itself, with no reload', b.disabled === false, String(b.disabled));
  ok('and turns into the primary action', b.primary === true, String(b.primary));
  ok('with the wait no longer written on it', !b.face, b.face);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. PRESSING IT TAKES A SEAT, ONCE ──────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('pressing it:');
  entries.length = 0;
  league = payload({ doorsOpenAt: Date.now() - 60_000, kickoffAt: Date.now() + 540_000, canEnter: true, enterBlockedReason: '' });
  enterReply = { roomId: 'R7', tier: 'gold', roomNo: 2, round: 1, startsAt: Date.now() + 8000, seats: 4, roomSize: 15, joined: true, full: false, room: { roomId: 'R7', phase: 'lobby', players: [], you: {} } };
  await openLeague(page);
  const before = await readBtn(page);
  ok('it is live', before.disabled === false);

  const after = await page.evaluate(async () => {
    document.getElementById('lgStartBtn').click();
    await new Promise((r) => setTimeout(r, 1200));
    const t = document.getElementById('pzToast');
    return { screen: (document.querySelector('.screen.active') || {}).id, toast: t ? t.innerText.replace(/\s+/g, ' ') : '' };
  });
  ok('one press asks the server for a seat, once', entries.length === 1, String(entries.length));
  ok('and the player is taken into the room', after.screen === 'wta', after.screen);
  ok('being told which room and how full it is', /اتاق ۲/.test(after.toast) && /۴ از ۱۵/.test(after.toast), after.toast);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. A DOUBLE TAP IS NOT TWO SEATS ───────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('tapping it twice, fast:');
  entries.length = 0;
  league = payload({ doorsOpenAt: Date.now() - 60_000, kickoffAt: Date.now() + 540_000, canEnter: true, enterBlockedReason: '' });
  await openLeague(page);
  await page.evaluate(async () => {
    const b = document.getElementById('lgStartBtn');
    b.click(); b.click(); b.click();
    await new Promise((r) => setTimeout(r, 1400));
  });
  ok('the server is asked exactly once', entries.length === 1, String(entries.length));
  await ctx.close();
}

/* The button disables itself on the first press, so three taps on the button
   can only ever be one request. The guard inside is for the other way in —
   the handler being called again while the first is still in the air, which is
   what a re-render or a stray onclick does. */
{
  const { ctx, page, errs } = await makePage();
  console.log('calling the handler again while the first is still in flight:');
  entries.length = 0;
  league = payload({ doorsOpenAt: Date.now() - 60_000, kickoffAt: Date.now() + 540_000, canEnter: true, enterBlockedReason: '' });
  await openLeague(page);
  await page.evaluate(async () => {
    (0, eval)('lgEnterLeague(); lgEnterLeague(); lgEnterLeague();');
    await new Promise((r) => setTimeout(r, 1400));
  });
  ok('still exactly one seat is asked for', entries.length === 1, String(entries.length));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. NO TICKET, NO COUNTDOWN ─────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('somebody with no league ticket:');
  league = payload({ qualifiedTier: null, tickets: {}, tier: null, rank: 240, canEnter: false, enterBlockedReason: 'این هفته در جدول لیگ نیستی.' });
  await openLeague(page);
  const b = await readBtn(page);
  ok('the button is there but locked', b && b.disabled === true, String(b && b.disabled));
  /* Counting down to a door they cannot walk through would be a lie. */
  ok('and says why rather than counting to nothing', /بلیط/.test(b.face), b.face);
  ok('with the reason underneath', /جدول لیگ نیستی/.test(b.why), b.why);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
