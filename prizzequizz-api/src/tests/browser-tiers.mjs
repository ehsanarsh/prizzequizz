/* WHICH TICKET THE GAME OFFERS, AND WHY.
 *
 *   «بلیط سبز همیشه فعال، بلیط آبی زمانی فعال که یک نفر از بلیط سبز دکمه ادامه
 *    میدهم را میزند و منتظر حریف با بلیط آبی است، و بلیط قرمز هم زمانی که یک
 *    نفر دنبال حریف با بلیط قرمز هست. اینجوری همه میتونن با هم بازی کنن — الان
 *    یکی با بلیط سبز دنبال حریفه یکی با بلیط قرمز و هیچ وقت همدیگرو پیدا
 *    نمیکنن.»
 *
 *   «وقتی کسی تو رو با بلیط سبز دعوت کرد، باید همون بلیطی که دعوت کرده فعال
 *    باشه و اون دوتای دیگه غیر فعال. و دکمه هر بلیط به رنگ خودش باشه.»
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

let waitingByTier = {};

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5 }));
    localStorage.setItem('pq_user_plan', 'premium');
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/matchmaking/stats') return send({ queued: 0, matched: 0, waitingByTier, analytics: {} });
    if (p === '/users/me') return send({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5, balances: { wallet: 0 } });
    if (p === '/wallet') return send({ available: 0, locked: 0, tickets: { green: 3, blue: 2, red: 2 } });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  /* Real tickets in hand, so «locked» can only be about the queue. */
  await page.evaluate(() => { (0, eval)("mTickets={green:3,blue:2,red:2}; userPlan='premium'; planExplicitlyChosen=true;"); });
  return { ctx, page, errs };
}

const openPicker = (page) => page.evaluate(async () => {
  (0, eval)("enterMode('survivor',true);");
  await new Promise((r) => setTimeout(r, 700));
});

const readTiers = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#tkSelGrid .tk-opt')].map((b) => ({
    name: (b.querySelector('b') || {}).textContent || '',
    shut: b.classList.contains('shut'),
    disabled: !!b.disabled,
    colour: getComputedStyle(b).getPropertyValue('--tkc').trim(),
    borderColour: getComputedStyle(b).borderTopColor,
    art: !!b.querySelector('.tk-opt-art')
  })));

/* ── 1. NOBODY WAITING ANYWHERE ────────────────────────────────────────── */
{
  waitingByTier = {};
  const { ctx, page, errs } = await makePage();
  console.log('with nobody waiting in any tier:');
  await openPicker(page);
  const tiers = await readTiers(page);
  ok('all three tickets are shown', tiers.length === 3, JSON.stringify(tiers.map((t) => t.name)));
  /* «بلیط سبز همیشه فعال» */
  ok('green is open', tiers[0].shut === false && tiers[0].disabled === false, JSON.stringify(tiers[0]));
  ok('blue is shut', tiers[1].shut === true && tiers[1].disabled === true, JSON.stringify(tiers[1]));
  ok('and red is shut', tiers[2].shut === true && tiers[2].disabled === true, JSON.stringify(tiers[2]));
  /* «دکمه هر بلیط به رنگ خودش باشه و آیکون خودش» */
  const colours = tiers.map((t) => t.colour);
  ok('each ticket carries its own colour', new Set(colours).size === 3 && colours.every(Boolean), JSON.stringify(colours));
  ok('and its own picture', tiers.every((t) => t.art), JSON.stringify(tiers.map((t) => t.art)));
  /* A locked pair with no explanation is indistinguishable from a broken screen. */
  const note = await page.evaluate(() => (document.querySelector('#ticketSelectCard .tk-note') || {}).textContent || '');
  ok('and the screen says why the others are locked', /منتظر حریف/.test(note), note.slice(0, 70));

  /* Tapping a shut one must not select it. */
  const tapped = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('#tkSelGrid .tk-opt')][2];
    b.click();
    await new Promise((r) => setTimeout(r, 200));
    return (0, eval)('selectedTicket');
  });
  ok('tapping a locked ticket does not choose it', tapped === 'green', tapped);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. SOMEBODY IS WAITING ON RED ─────────────────────────────────────── */
{
  waitingByTier = { red: 1 };
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen somebody is waiting on red:');
  await openPicker(page);
  const tiers = await readTiers(page);
  ok('green stays open', tiers[0].shut === false);
  ok('blue is still shut, because nobody is in it', tiers[1].shut === true, JSON.stringify(tiers[1]));
  /* This is the fix: the tier with a real opponent in it is the one offered. */
  ok('red opens, because there is somebody to meet', tiers[2].shut === false, JSON.stringify(tiers[2]));
  const chosen = await page.evaluate(async () => {
    [...document.querySelectorAll('#tkSelGrid .tk-opt')][2].click();
    await new Promise((r) => setTimeout(r, 200));
    return (0, eval)('selectedTicket');
  });
  ok('and it can be chosen', chosen === 'red', chosen);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. A TIER THAT EMPTIES WHILE YOU LOOK AT IT ───────────────────────── */
/* The one they were about to pick can be taken by somebody else a second
 * later. Leaving it selected would send them in to wait alone — which is the
 * thing this is all for. */
{
  waitingByTier = { blue: 1 };
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen the tier empties while the screen is open:');
  await openPicker(page);
  await page.evaluate(async () => {
    [...document.querySelectorAll('#tkSelGrid .tk-opt')][1].click();
    await new Promise((r) => setTimeout(r, 200));
  });
  ok('blue was chosen while somebody was in it', (await page.evaluate(() => (0, eval)('selectedTicket'))) === 'blue');

  waitingByTier = {};                                   // they got matched, or gave up
  const after = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 5000));       // the picker refreshes every 4s
    return { chosen: (0, eval)('selectedTicket'),
             blueShut: [...document.querySelectorAll('#tkSelGrid .tk-opt')][1].classList.contains('shut') };
  });
  ok('the emptied tier locks itself again', after.blueShut === true, JSON.stringify(after));
  ok('and the choice falls back to green', after.chosen === 'green', after.chosen);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. INVITED WITH A PARTICULAR TICKET ───────────────────────────────── */
/* «باید همون بلیطی که دعوت کرده فعال باشه و اون دوتای دیگه غیر فعال» — the
 * person who invited has already staked that tier, so entering on another one
 * would put two different stakes into one match. */
{
  waitingByTier = { red: 5 };                            // red is busy, and still must not be offered
  const { ctx, page, errs } = await makePage();
  console.log('\nafter accepting an invitation sent with a blue ticket:');
  await page.evaluate(async () => {
    (0, eval)('pzInviteGoNow')({ id: 'inv-1', mode: 'duel', ticketTier: 'blue', coinStake: 0 });
    await new Promise((r) => setTimeout(r, 900));
  });
  const tiers = await readTiers(page);
  ok('the invited tier is the one open', tiers[1].shut === false, JSON.stringify(tiers[1]));
  ok('green is shut, even though it is always open otherwise', tiers[0].shut === true, JSON.stringify(tiers[0]));
  ok('and red is shut, even though people are waiting in it', tiers[2].shut === true, JSON.stringify(tiers[2]));
  ok('the invited ticket is the chosen one', (await page.evaluate(() => (0, eval)('selectedTicket'))) === 'blue');
  const note = await page.evaluate(() => (document.querySelector('#ticketSelectCard .tk-note') || {}).textContent || '');
  ok('and the screen says it is because of the invitation', /دعوت/.test(note), note.slice(0, 70));

  /* THE LOCK MUST NOT OUTLIVE THE INVITATION. Walking back in on their own,
     every tier is judged by the queue again. */
  const later = await page.evaluate(async () => {
    (0, eval)('pzPairKey=null;');
    (0, eval)('renderTicketSelect')();
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll('#tkSelGrid .tk-opt')].map((b) => b.classList.contains('shut'));
  });
  ok('once the pairing is over, green is open again', later[0] === false, JSON.stringify(later));
  ok('and red is open because people are waiting there', later[2] === false, JSON.stringify(later));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
