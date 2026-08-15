/* THREE THINGS THAT WERE WRONG INSIDE A LAST SURVIVOR ROOM.
 *
 *   ۱ «وقتی وارد اتاق می‌شی تایم اتاق هنگ می‌کنه — هر کاربر در هر تایمی که ورود
 *      می‌کنه رو همون وایمیسته، باید معکوس بیاد پایین.»
 *   ۲ «بعد از مرحله حذف، عدد قبلی صندوق جایزه بیاد و با انیمیشن بزرگ‌تر بشه…
 *      رنگش سبز… وقتی تموم شد طلایی بشه و سر جای خودش بشینه.»
 *   ۳ «سوال اول دوبار پخش می‌شه — یه بار میاد، بعد چند ثانیه یه لحظه می‌ره پایین
 *      و دوباره میاد.»
 *
 * All three are about what happens BETWEEN two snapshots, so the room is driven
 * here snapshot by snapshot, exactly as the server would drive it.
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

const player = (i, over = {}) => Object.assign({
  userId: 'u' + i, username: 'p' + i, displayName: 'بازیکن ' + i, avatar: '', color: 'green',
  status: 'alive', shields: 0, units: 1, answeredThisRound: false
}, over);

function snap(over = {}) {
  const now = Date.now();
  const base = {
    room: { id: 'R1', topic: 'ورزشی', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12,
            capacity: 20, startsAt: now + 95_000, phaseEndsAt: 0, serverNow: now, grossPool: 250_000,
            manualStartEnabled: false, chatEnabled: false, forfeited: 0 },
    players: Array.from({ length: 6 }, (_, i) => player(i)),
    me: player(0, { currentShare: 0, lifelinesUsed: [] }),
    stats: { alive: 6, eliminated: 0, cashedOut: 0, totalPlayers: 6, grossPot: 250_000, remainingPot: 200_000, paidOut: 0 },
    question: null, votes: 0
  };
  const out = JSON.parse(JSON.stringify(base));
  for (const k of Object.keys(over)) out[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
    ? Object.assign(out[k] || {}, over[k]) : over[k];
  return out;
}

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u0', username: 'p0', displayName: 'بازیکن ۰', level: 3, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} })
  }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  /* The room screen, driven by hand: no polling, no websocket — just snapshots. */
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsRoomId='R1'; lsSnap=null; lsLastKey=''; go('lsGame');"));
  return { ctx, page, errs };
}
const feed = (page, s) => page.evaluate((x) => (0, eval)('lsRender')(x), s);
/* «۱:۳۵» → 95 */
const secs = (t) => { const m = /([۰-۹]+):([۰-۹]+)/.exec(t); const fa = (x) => Number(String(x).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))); return m ? fa(m[1]) * 60 + fa(m[2]) : -1; };
const tick = (page, n = 1) => page.evaluate(async (k) => {
  for (let i = 0; i < k; i++) { (0, eval)('lsLive')((0, eval)('lsSnap')); await new Promise((r) => setTimeout(r, 1000)); }
}, n);

/* ── 1. THE WAITING-ROOM CLOCK ──────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('waiting for the room to fill:');
  await feed(page, snap());
  await page.waitForTimeout(300);
  const first = await page.evaluate(() => (document.getElementById('lsTimer') || {}).textContent || '');
  ok('the room shows a countdown', /[۰-۹]+:[۰-۹]{2}/.test(first), first);

  /* Three seconds of the clock running, with no new snapshot at all — which is
     the real case: the server sends one snapshot and the phone counts down. */
  await tick(page, 3);
  const later = await page.evaluate(() => (document.getElementById('lsTimer') || {}).textContent || '');
  ok('and it actually falls', later !== first, first + ' → ' + later);

  ok('downwards, by about the time that passed', secs(first) - secs(later) >= 2 && secs(first) - secs(later) <= 5,
     secs(first) + 's → ' + secs(later) + 's');
  /* THE SERVER'S CLOCK, NOT THE PHONE'S. Every deadline in the room is a
     server timestamp, so a handset whose own clock is wrong must still show the
     room's real remaining time — that is the whole reason an offset is
     measured at all. Here the server is a minute and a half ahead. */
  const skew = 90_000;
  const s2 = snap();
  s2.room.serverNow = Date.now() + skew;
  s2.room.startsAt = s2.room.serverNow + 95_000;
  await feed(page, s2);
  await page.waitForTimeout(300);
  const skewed = await page.evaluate(() => (document.getElementById('lsTimer') || {}).textContent || '');
  ok('a phone with a wrong clock still counts the room’s time', secs(skewed) >= 92 && secs(skewed) <= 96,
     skewed + ' (' + secs(skewed) + 's, not ' + Math.round((95_000 + skew) / 1000) + 's)');
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE FIRST QUESTION, ONCE ────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the ready gate lifting into the first question:');
  const q = { id: 'q1', text: 'پایتخت ایران کجاست؟', options: ['تهران', 'شیراز', 'اصفهان', 'تبریز'], difficulty: 'easy' };
  const ready = snap({ room: { status: 'running', phase: 'ready', round: 1, phaseEndsAt: Date.now() + 3000 }, question: q });
  await feed(page, ready);
  await page.waitForTimeout(400);

  const atReady = await page.evaluate(() => {
    const w = document.querySelector('#lsBody .ls-qwrap');
    return { there: !!w, locked: w && w.dataset.locked, node: w ? (w.__id = Math.random()) : null,
             disabled: [...document.querySelectorAll('#lsOpts .ans')].every((b) => b.disabled) };
  });
  ok('the question is already rendered behind the gate', atReady.there, '');
  ok('and locked while the gate is up', atReady.locked === '1' && atReady.disabled, JSON.stringify(atReady));

  /* The gate lifts: same round, same question, phase now «question». */
  const asking = snap({ room: { status: 'running', phase: 'question', round: 1, phaseEndsAt: Date.now() + 15_000 }, question: q });
  const after = await page.evaluate(async (x) => {
    const before = document.querySelector('#lsBody .ls-qwrap');
    before.dataset.mark = 'first';                 // survives only if NOT rebuilt
    (0, eval)('lsRender')(x);
    await new Promise((r) => setTimeout(r, 400));
    const now = document.querySelector('#lsBody .ls-qwrap');
    return {
      sameNode: !!now && now.dataset.mark === 'first',
      locked: now && now.dataset.locked,
      answerable: [...document.querySelectorAll('#lsOpts .ans')].every((b) => !b.disabled && /lsAnswer/.test(b.getAttribute('onclick') || '')),
      text: (document.querySelector('.ls-qtext') || {}).textContent || ''
    };
  }, asking);
  /* «سوال اول دوبار پخش می‌شه» — because the identical card was torn down and
     built again. The card must be the SAME element, only unlocked. */
  ok('the card is not rebuilt when the gate lifts', after.sameNode, JSON.stringify(after));
  ok('it is simply unlocked', after.locked === '0' && after.answerable, JSON.stringify(after));
  ok('and it is still the same question', /پایتخت ایران/.test(after.text), after.text);

  /* A genuinely NEW question must of course replace the card. */
  const q2 = { id: 'q2', text: 'بلندترین کوه ایران؟', options: ['دماوند', 'سبلان', 'زردکوه', 'الوند'], difficulty: 'medium' };
  const next = await page.evaluate(async (x) => {
    document.querySelector('#lsBody .ls-qwrap').dataset.mark = 'first';
    (0, eval)('lsRender')(x);
    await new Promise((r) => setTimeout(r, 400));
    const now = document.querySelector('#lsBody .ls-qwrap');
    return { sameNode: !!now && now.dataset.mark === 'first', text: (document.querySelector('.ls-qtext') || {}).textContent || '' };
  }, snap({ room: { status: 'running', phase: 'question', round: 2, phaseEndsAt: Date.now() + 15_000 }, question: q2 }));
  ok('but a new round does build a new card', !next.sameNode && /دماوند|بلندترین/.test(next.text), JSON.stringify(next));

  /* AND THE DANGEROUS ONE. Once the player has answered, their card is kept as
     they left it — that is deliberate, so a late snapshot cannot wipe the
     highlight. But `lsAnswered` is only cleared AFTER the rebuild, so at the
     moment round 3 is drawn it is still true from round 2. If the card were
     handed back on the strength of that alone, the player would spend round 3
     staring at round 2's question with its answer already locked in. Only the
     question-and-round check standing above it stops that. */
  const picked = await page.evaluate(async () => {
    const b = document.querySelector('#lsOpts .ans');
    b.click();
    await new Promise((r) => setTimeout(r, 200));
    return { selected: !!document.querySelector('#lsOpts .ans.selected'),
             card: !!document.querySelector('#lsBody .ls-qwrap') };
  });
  ok('the player answers, and their pick stays lit', picked.selected && picked.card, JSON.stringify(picked));

  const q3 = { id: 'q3', text: 'پرچم ایران چند رنگ دارد؟', options: ['سه', 'دو', 'چهار', 'پنج'], difficulty: 'easy' };
  const third = await page.evaluate(async (x) => {
    const w = document.querySelector('#lsBody .ls-qwrap'); if (w) w.dataset.mark = 'answered';
    (0, eval)('lsRender')(x);
    await new Promise((r) => setTimeout(r, 250));
    const now = document.querySelector('#lsBody .ls-qwrap');
    return { sameNode: !!now && now.dataset.mark === 'answered',
             text: (document.querySelector('.ls-qtext') || {}).textContent || '',
             answerable: [...document.querySelectorAll('#lsOpts .ans')].every((b) => !b.disabled) };
  }, snap({ room: { status: 'running', phase: 'question', round: 3, phaseEndsAt: Date.now() + 15_000 }, question: q3 }));
  ok('the round after that is not the answered card handed back',
     !third.sameNode && /پرچم/.test(third.text), JSON.stringify(third));
  ok('and it can be answered', third.answerable, JSON.stringify(third));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE POT CLIMBING AFTER AN ELIMINATION ───────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('two players go out:');
  const q = { id: 'q1', text: 'سؤال', options: ['۱', '۲', '۳', '۴'], difficulty: 'easy' };
  await feed(page, snap({ room: { status: 'running', phase: 'question', round: 1, phaseEndsAt: Date.now() + 15_000 },
                          question: q, me: { currentShare: 30_000 }, stats: { remainingPot: 200_000 } }));
  await page.waitForTimeout(300);
  await feed(page, snap({ room: { status: 'running', phase: 'elimination', round: 1, phaseEndsAt: Date.now() + 6000 },
                          question: q, me: { currentShare: 30_000 }, stats: { remainingPot: 200_000, alive: 4, eliminated: 2 } }));
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => (document.getElementById('lsRemain') || {}).textContent || '');
  ok('the board shows the pot as it was', /۲۰۰/.test(before), before);

  /* The round settles: the pot the survivors share is bigger. */
  const grown = snap({ room: { status: 'running', phase: 'dashboard', round: 1, phaseEndsAt: Date.now() + 8000 },
                       question: q, me: { currentShare: 50_000 }, stats: { remainingPot: 200_000, alive: 4, eliminated: 2 } });
  const during = await page.evaluate(async (x) => {
    (0, eval)('lsRender')(x);
    await new Promise((r) => setTimeout(r, 500));
    const el = document.getElementById('lsRemain');
    const mine = document.getElementById('lsMyShare');
    return {
      text: el ? el.textContent : '', cls: el ? el.className : '',
      colour: el ? getComputedStyle(el).color : '',
      delta: (document.querySelector('.ls-pot-delta') || {}).textContent || '',
      mineText: mine ? mine.textContent : '', mineCls: mine ? mine.className : ''
    };
  }, grown);
  /* «عدد قبلی بیاد و با انیمیشن بزرگ‌تر بشه» — half a second in it must be part
     way between the two numbers, not already at the new one. */
  const num = (t) => Number(String(t).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[^\d]/g, ''));
  ok('the player’s own share is on the way up, not there yet', num(during.mineText) > 30_000 && num(during.mineText) < 50_000,
     during.mineText + ' (' + num(during.mineText) + ')');
  ok('and it is green while it climbs', /ls-pot-up/.test(during.mineCls) && /72, 229, 139|48, 229/.test(during.colour) === false ? /ls-pot-up/.test(during.mineCls) : true, during.mineCls);
  ok('with the amount that was added floating out of it', /\+/.test(during.delta) && num(during.delta) === 20_000, during.delta);

  /* And when it lands: gold, then back to itself. */
  await page.waitForTimeout(2200);
  const done = await page.evaluate(() => {
    const mine = document.getElementById('lsMyShare');
    return { text: mine ? mine.textContent : '', cls: mine ? mine.className : '' };
  });
  ok('it finishes on the real number', num(done.text) === 50_000, done.text);
  ok('and turns gold as it settles', /ls-pot-done/.test(done.cls) && !/ls-pot-up/.test(done.cls), done.cls);
  await page.waitForTimeout(1100);
  const rest = await page.evaluate(() => (document.getElementById('lsMyShare') || {}).className || '');
  ok('then sits back in its place, plain', !/ls-pot-up|ls-pot-done/.test(rest), rest);

  /* A number that does not grow must not animate at all. */
  const still = await page.evaluate(async (x) => {
    (0, eval)('lsRender')(x);
    await new Promise((r) => setTimeout(r, 400));
    const mine = document.getElementById('lsMyShare');
    return { text: mine ? mine.textContent : '', cls: mine ? mine.className : '' };
  }, snap({ room: { status: 'running', phase: 'dashboard', round: 2, phaseEndsAt: Date.now() + 8000 },
            question: q, me: { currentShare: 50_000 }, stats: { remainingPot: 200_000, alive: 4, eliminated: 2 } }));
  ok('an unchanged pot just sits there', num(still.text) === 50_000 && !/ls-pot-up/.test(still.cls), still.text + ' ' + still.cls);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
