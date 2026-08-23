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

/* THE MEDAL ARTWORK, WHEN IT IS THERE.
   The repository carries no medal files — they are uploaded to the server
   beside index.html — so by default every request for one 404s and the podium
   falls all the way down its ladder to the emoji. That is worth testing, and
   so is the other half: with the files in place the podium must actually SHOW
   them. Without this, deleting the call to pzMedalHTML() and going back to
   bare emoji passes every test, because every test would be looking at the
   fallback either way. One gold pixel is enough — the size comes from CSS. */
const ONE_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4f0n+PwAHtALwCdbNDwAAAABJRU5ErkJggg==', 'base64');
/* WHAT THE SITE-ADMIN PANEL HANDS BACK. Not a folder and not a filename:
   every upload gets an address of its own, a code with no name in it and no
   extension — so a picture's address has to be LOOKED UP, never guessed. The
   medals that are in the game's table are here; the ones that are not fall
   back to its own folder, which is what «uploaded=root» stands for. */
const MEDIA_URL = { 'medal-bronze': '/media/mt69rmlc-jwpizbiq', logo: '/media/msi929ll-52a9mhwm' };
const MEDIA_OWNER = Object.fromEntries(Object.entries(MEDIA_URL).map(([k, v]) => [v, k]));
/* '' = nothing uploaded · 'media' = uploaded through the panel · 'root' =
   sitting beside index.html instead. */
let artUploaded = '';
let artAsked = [];

const server = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]);
  if (MEDIA_OWNER[rel]) {
    artAsked.push(rel);
    if (artUploaded !== 'media') { r.writeHead(404); return r.end('no'); }
    r.writeHead(200, { 'content-type': 'image/png' }); return r.end(ONE_PIXEL);
  }
  const art = /^\/([a-z0-9-]+)\.(webp|png|jpg)$/.exec(rel);
  if (art && /^(medal-[a-z]+|logo)$/.test(art[1])) {
    artAsked.push(rel);
    if (artUploaded !== 'root') { r.writeHead(404); return r.end('no'); }
    r.writeHead(200, { 'content-type': 'image/png' }); return r.end(ONE_PIXEL);
  }
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

let waitingByTier = {};
/* What the server has waiting for this player, and what this player sent it.
   Both are read by the «حریفت ادامه داد» cases at the bottom. */
let duelCalls = [];
/* What the server says another look costs — the button is what has to say it. */
let onlineCost = 0;
/* What the server says about the invitation the sender is waiting on. */
let inviteStatus = { id: 'inv-w', status: 'pending', secondsLeft: 50 };
/* A board with the three kinds of name that broke the old podium: a long
   Persian one, a long Latin one, and a short one. */
let board = [
  { userId: 'a', username: 'محمدرضا حسین‌زاده', score: 1840, avatar: '', character: null },
  { userId: 'b', username: 'Ali_TheDestroyer_99', score: 1610, avatar: '', character: null },
  { userId: 'c', username: 'سارا', score: 1455, avatar: '', character: null },
  { userId: 'd', username: 'رضا', score: 1200, avatar: '', character: null, highlighted: true }
];
let posted = [];

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
    let body = null;
    try { body = JSON.parse(route.request().postData() || 'null'); } catch { body = null; }
    posted.push({ method: route.request().method(), path: p, body });
    if (p === '/matchmaking/stats') return send({ queued: 0, matched: 0, waitingByTier, analytics: {} });
    if (p === '/users/me/referral') return send({ code: 'K7XQ2MW', invites: 4, rewardTier: 'green', rewardCount: 1 });
    if (p === '/users/online') return send({ players: [], onlineTotal: 0, nextCost: onlineCost, freeLeft: 0, coins: 900 });
    if (p.startsWith('/leaderboards/')) return send({ entries: board });
    if (p === '/duel-calls' && route.request().method() === 'GET') return send({ calls: duelCalls });
    /* The server resolves WHO lost the match and answers with their id — the
       winner's next enqueue quotes it back to keep their seat. */
    if (p === '/duel-calls' && route.request().method() === 'POST') return send({ called: true, call: { id: 'c-new', toUserId: 'them', tier: 'blue', stage: 2, secondsLeft: 170 } });
    if (p === '/invites/incoming') return send({ invites: [] });
    if (p === '/invites' && route.request().method() === 'POST') return send({ id: 'inv-s', status: 'pending', secondsLeft: 55 });
    if (/^\/invites\/[^/]+$/.test(p) && route.request().method() === 'GET') return send(inviteStatus);
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
    disabled: b.getAttribute('aria-disabled') === 'true',
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
  /* A locked pair with no explanation is indistinguishable from a broken
     screen — but the explanation must not be a paragraph. «اندازه تصویر بنر رو
     به حداکثرترین حالت ممکن برسون» is a rule about this exact screen, and a
     note under the tickets was paid for out of the picture. So the padlock
     carries the reason, in the row already reserved for it. */
  const meta = await page.evaluate(() =>
    [...document.querySelectorAll('#tkSelGrid .tk-opt')].map((b) => (b.querySelector('.tk-opt-meta') || {}).textContent || ''));
  ok('the locked ones say why on the tile', /🔒/.test(meta[1]) && /منتظر/.test(meta[1]), JSON.stringify(meta));
  ok('and the open one says nothing', meta[0].trim() === '', JSON.stringify(meta));
  ok('no paragraph is spent on it', (await page.evaluate(() => !document.querySelector('#ticketSelectCard .tk-note'))) === true);
  /* AND THE REASON COSTS NOTHING. The padlock rides in the row already
     reserved for it — left free to grow, it took three pixels off every ticket
     tile, and on this screen every pixel a tile takes comes out of the banner.
     Measured on the ROW, not on the tile: the tiles are grid cells and grid
     cells stretch to match each other, so comparing one tile to another can
     never fail however tall the padlock's line gets. */
  const metaH = await page.evaluate(() =>
    [...document.querySelectorAll('#tkSelGrid .tk-opt-meta')].map((e) => Math.round(e.getBoundingClientRect().height)));
  ok('the padlock row is the height it reserved', metaH.every((h) => h === 11), JSON.stringify(metaH));
  ok('the locked row is no taller than the empty one', metaH[1] === metaH[0] && metaH[2] === metaH[0], JSON.stringify(metaH));
  /* Tapping one says the whole sentence, where it costs no room at all. */
  const why = await page.evaluate(async () => {
    [...document.querySelectorAll('#tkSelGrid .tk-opt')][1].click();
    await new Promise((r) => setTimeout(r, 300));
    return (document.getElementById('pzToast') || {}).textContent || '';
  });
  ok('and tapping it says why in full', /منتظر حریف/.test(why), why.slice(0, 70));

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
 * would put two different stakes into one match.
 *
 * And «اگه گیرنده بلیط داشت مستقیم وارد رادار و روم بازی میشه، دیگه انتخاب
 * بلیط رو نمیبینه»: with the ticket agreed and in hand there is nothing left
 * to choose, so there is no screen to choose it on. */
{
  waitingByTier = { red: 5 }; posted = [];               // red is busy, and still must not be offered
  const { ctx, page, errs } = await makePage();
  console.log('\naccepting an invitation sent with a blue ticket, holding one:');
  const after = await page.evaluate(async () => {
    (0, eval)('pzInviteGoNow')({ id: 'inv-1', mode: 'duel', ticketTier: 'blue', coinStake: 0 });
    await new Promise((r) => setTimeout(r, 1200));
    return {
      screen: (document.querySelector('.screen.active') || {}).id || '',
      ticket: (0, eval)('selectedTicket'),
      held: (0, eval)('duelTicket'),
      value: window.matchValue
    };
  });
  /* The pairing is SPENT at the enqueue — left lying about it would quietly
     capture the next ordinary search — so what proves it travelled is the
     request, not what is left in the variable afterwards. */
  const enq1 = posted.filter((x) => x.path === '/matchmaking/enqueue').pop();
  ok('the search starts straight away', after.screen === 'matchmaking', after.screen);
  ok('no ticket screen in between', after.screen !== 'mode-entry', after.screen);
  ok('on the tier the invitation named', after.ticket === 'blue', after.ticket);
  ok('and that is the ticket being spent', after.held === 'blue', String(after.held));
  ok('meeting only the person who invited them', enq1 && enq1.body.pairKey === 'inv-1', JSON.stringify(enq1 && enq1.body));
  ok('playing for that tier’s value', after.value === 25000, String(after.value));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. INVITED, AND WITHOUT THE TICKET ────────────────────────────────── */
/* «ولی اگه بلیط انتخابی کاربر فرستنده رو نداشته باشه و قبول کنه باید مستقیم بره
 * به صفحه خرید بلیط، و بعد از خرید بلیط مستقیم به روم بازی هدایت بشه.» */
{
  waitingByTier = {}; posted = [];
  const { ctx, page, errs } = await makePage();
  console.log('\naccepting one for a ticket they do not hold:');
  const toShop = await page.evaluate(async () => {
    (0, eval)('mTickets={green:1,blue:0,red:0};');
    (0, eval)('pzInviteGoNow')({ id: 'inv-2', mode: 'duel', ticketTier: 'blue', coinStake: 0 });
    await new Promise((r) => setTimeout(r, 1200));
    return {
      screen: (document.querySelector('.screen.active') || {}).id || '',
      tab: (document.querySelector('#shopTabTickets') || {}).className || '',
      toast: (document.getElementById('pzToast') || {}).textContent || ''
    };
  });
  ok('the shop opens, not the ticket screen', toShop.screen === 'shop', toShop.screen);
  ok('on the tickets shelf', /on|active/.test(toShop.tab), toShop.tab);
  ok('and they are told which one they need', /بلیط آبی/.test(toShop.toast), toShop.toast.slice(0, 70));

  /* THE PURCHASE LANDS AND THE MATCH BEGINS. The ticket arriving is what the
     server would send back; what is under test is where the player is put next. */
  const back = await page.evaluate(async () => {
    (0, eval)('mTickets.blue=1;');
    (0, eval)('pzShopReturnAfterBuy')();
    await new Promise((r) => setTimeout(r, 1800));
    return {
      screen: (document.querySelector('.screen.active') || {}).id || '',
      held: (0, eval)('duelTicket')
    };
  });
  const enq2 = posted.filter((x) => x.path === '/matchmaking/enqueue').pop();
  ok('buying it goes straight into the match', back.screen === 'matchmaking', back.screen);
  ok('spending the ticket that was just bought', back.held === 'blue', String(back.held));
  ok('still meeting only the person who invited them', enq2 && enq2.body.pairKey === 'inv-2', JSON.stringify(enq2 && enq2.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. THE SENDER, WHO USED TO BE LEFT ON GREEN ───────────────────────── */
/* «وقتی با بلیطی به غیر از سبز دعوت میکنی، گیرنده میتونه با اون بلیط وارد بازی
 * بشه ولی فرستنده نه — برای فرستنده فقط بلیط سبز فعاله.»
 *
 * The sender's side never told the entry screen an arrangement was in force,
 * so the screen judged their tier by the open queue like anybody else's, found
 * it empty, and quietly put them back on green — while the person they invited
 * stood on blue. The two could never meet. */
{
  waitingByTier = {}; posted = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe sender, once their invitation is accepted:');
  const sent = await page.evaluate(async () => {
    (0, eval)("PZ_INV_WAIT={id:'inv-3',tier:'red',coins:0,until:Date.now()+60000};");
    (0, eval)('pzPairEnter')('red', 'inv-3', 0);
    await new Promise((r) => setTimeout(r, 1200));
    return {
      screen: (document.querySelector('.screen.active') || {}).id || '',
      ticket: (0, eval)('selectedTicket'),
      held: (0, eval)('duelTicket'),
      lock: (0, eval)('_pzInviteTier')
    };
  });
  const enq3 = posted.filter((x) => x.path === '/matchmaking/enqueue').pop();
  ok('they go in on the tier they invited with', sent.ticket === 'red', sent.ticket);
  ok('not on green', sent.ticket !== 'green', sent.ticket);
  ok('the arrangement locks their screen too', sent.lock === 'red', String(sent.lock));
  ok('and the search starts', sent.screen === 'matchmaking', sent.screen);
  ok('spending the red ticket', sent.held === 'red', String(sent.held));
  ok('paired to the invitation', enq3 && enq3.body.pairKey === 'inv-3', JSON.stringify(enq3 && enq3.body));
  ok('and no chained-winner label rides along', enq3 && !enq3.body.waitTier, JSON.stringify(enq3 && enq3.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 7. THE LOCK ITSELF, WHEREVER A SCREEN STILL OPENS ─────────────────── */
/* A friendly duel is arranged for coins and still has an entry screen, and the
 * shop fallback lands on one too. Wherever one opens under an arrangement, the
 * agreed tier is the only one on it — green included, which is the part nobody
 * would guess. */
{
  waitingByTier = { red: 5 };
  const { ctx, page, errs } = await makePage();
  console.log('\nthe entry screen under an arrangement:');
  const tiers = await page.evaluate(async () => {
    (0, eval)("pzPairKey='inv-4'; _pzInviteTier='blue'; selectedTicket='blue';");
    (0, eval)("curMode='survivor'; enterMode('survivor',true);");
    await new Promise((r) => setTimeout(r, 600));
    (0, eval)('renderTicketSelect')();
    await new Promise((r) => setTimeout(r, 200));
    return [...document.querySelectorAll('#tkSelGrid .tk-opt')].map((b) => b.classList.contains('shut'));
  });
  ok('the invited tier is the one open', tiers[1] === false, JSON.stringify(tiers));
  ok('green is shut, even though it is always open otherwise', tiers[0] === true, JSON.stringify(tiers));
  ok('and red is shut, even though people are waiting in it', tiers[2] === true, JSON.stringify(tiers));
  /* THE ONE CASE THAT STILL NEEDS SAYING OUTRIGHT. Green is locked, and green
     is never locked — nobody would guess that from a padlock. */
  const note = await page.evaluate(() => (document.querySelector('#ticketSelectCard .tk-note') || {}).textContent || '');
  ok('and the screen says it is because of the invitation', /دعوت/.test(note), note.slice(0, 70));
  ok('naming the ticket it was sent with', /بلیط آبی/.test(note), note.slice(0, 70));

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

/* ── 5. WHICH TIER A STAKE IS ──────────────────────────────────────────── */
/* The ladder doubles the stake on every win, and a doubled stake lands exactly
 * on the next tier's value. Above red it lands on 100,000, which no ticket is
 * sold at — and everything that needs a ticket to name has to stay quiet
 * there rather than invent one. */
{
  waitingByTier = {};
  const { ctx, page, errs } = await makePage();
  console.log('\nreading a stake back as a ticket:');
  const m = await page.evaluate(() => {
    const f = (0, eval)('pzTierForValue');
    return { g: f(12500), b: f(25000), r: f(50000), over: f(100000), zero: f(0), junk: f('nonsense') };
  });
  ok('12,500 is the green ticket', m.g === 'green', m.g);
  ok('25,000 is the blue one', m.b === 'blue', m.b);
  ok('50,000 is the red one', m.r === 'red', m.r);
  ok('and 100,000 is no ticket at all', m.over === '', JSON.stringify(m.over));
  ok('nor is nothing', m.zero === '' && m.junk === '', JSON.stringify([m.zero, m.junk]));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. THE WINNER PRESSES «ادامه میدهم» ───────────────────────────────── */
/* «اگه در دوئل بازیکنی باخت و برنده دکمه ادامه میدهم رو زد و ادامه داد، به
 * بازنده اطلاع بده.» Until now the whole chain happened here and the person who
 * lost was told nothing at all. */
{
  waitingByTier = {}; posted = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen the winner carries on:');
  await page.evaluate(async () => {
    (0, eval)("startMatchmaking=function(){};");         // stay on this screen
    (0, eval)("duelStage=1; duelStakeVal=12500; userPlan='premium'; pzRt.matchId='m-42';");
    (0, eval)('duelContinue')();
    await new Promise((r) => setTimeout(r, 300));
  });
  const sent = posted.filter((x) => x.method === 'POST' && x.path === '/duel-calls');
  ok('the server is told, once', sent.length === 1, JSON.stringify(sent));
  ok('about the match that was just won', sent[0] && sent[0].body.matchId === 'm-42', JSON.stringify(sent[0] && sent[0].body));
  /* A green winner is now playing for 25,000, and 25,000 is the blue ticket —
     which is the tier the person they beat has to buy to come and find them. */
  ok('naming the tier they are now standing in', sent[0] && sent[0].body.tier === 'blue', JSON.stringify(sent[0] && sent[0].body));
  ok('and the stage they have gone on to', sent[0] && sent[0].body.stage === 2, JSON.stringify(sent[0] && sent[0].body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 7. ABOVE RED THERE IS NO TICKET TO NAME ───────────────────────────── */
/* A red winner plays on for 100,000 and nothing in the shop reaches that. The
 * message is «با بلیط … حقتو ازش بگیری» — with no ticket to put in it there is
 * no message, and sending one anyway would be pointing somebody at a door that
 * does not exist. */
{
  waitingByTier = {}; posted = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen a red winner carries on:');
  await page.evaluate(async () => {
    (0, eval)("startMatchmaking=function(){};");
    (0, eval)("duelStage=1; duelStakeVal=50000; userPlan='premium'; pzRt.matchId='m-99';");
    (0, eval)('duelContinue')();
    await new Promise((r) => setTimeout(r, 300));
  });
  ok('nothing is sent', posted.filter((x) => x.method === 'POST' && x.path === '/duel-calls').length === 0, JSON.stringify(posted.map((x) => x.path)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 8. THE LOSER IS TOLD — A SHEET, NOT AN INBOX LINE ─────────────────── */
/* «نه پیام به صندوق اعلان، یه مودال بیاد و بنویسه حریفت ادامه داد میتونی با
 * بلیط آبی حقتو ازش بگیری، و دو دکمه بیخیال و پیداش کن.» */
{
  waitingByTier = { blue: 1 }; posted = [];
  duelCalls = [{ id: 'c-1', fromUserId: 'them', fromName: 'رضا', tier: 'blue', matchId: 'm-42', stage: 2, secondsLeft: 170 }];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe person who lost, back at home:');
  await page.evaluate(async () => { await (0, eval)('pzDuelCallPoll')(); await new Promise((r) => setTimeout(r, 400)); });
  const sheet = await page.evaluate(() => {
    const ov = document.getElementById('aaaModal');
    return {
      shown: !!(ov && ov.classList.contains('show')),
      title: (document.getElementById('aaaTitle') || {}).textContent || '',
      sub: (document.getElementById('aaaSub') || {}).textContent || '',
      primary: (document.getElementById('aaaPrimary') || {}).textContent || '',
      secondary: (document.getElementById('aaaSecondary') || {}).textContent || '',
      secondaryShown: getComputedStyle(document.getElementById('aaaSecondary')).display !== 'none'
    };
  });
  ok('a sheet opens', sheet.shown === true, JSON.stringify(sheet));
  ok('it names the person who carried on', /رضا/.test(sheet.title) && /ادامه داد/.test(sheet.title), sheet.title);
  /* BOTH HALVES. The sheet says two things — where they are standing now, and
     what it would take to reach them — and each needs the ticket in it. One
     of them alone lets the other go missing without anything noticing. */
  ok('it says which tier they are standing in', /حالا با بلیط آبی/.test(sheet.sub), sheet.sub.slice(0, 60));
  ok('and what it takes to reach them', /با بلیط آبی حقتو/.test(sheet.sub), sheet.sub.slice(0, 120));
  ok('the ticket named is the one the call carried', !/بلیط سبز|بلیط قرمز/.test(sheet.sub), sheet.sub.slice(0, 120));
  ok('«پیداش کن» is the first button', /پیداش کن/.test(sheet.primary), sheet.primary);
  ok('«بی‌خیال» is the second, and really there', /بی.?خیال/.test(sheet.secondary) && sheet.secondaryShown, JSON.stringify([sheet.secondary, sheet.secondaryShown]));
  /* Read the moment it is shown, or the same sheet reopens every twelve
     seconds for the next three minutes. */
  ok('the server is told it has been shown', posted.some((x) => x.method === 'POST' && x.path === '/duel-calls/c-1/seen'), JSON.stringify(posted.map((x) => x.path)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 9. «بی‌خیال» ──────────────────────────────────────────────────────── */
{
  waitingByTier = { blue: 1 }; posted = [];
  duelCalls = [{ id: 'c-2', fromUserId: 'them', fromName: 'رضا', tier: 'blue', matchId: 'm-42', stage: 2, secondsLeft: 170 }];
  const { ctx, page, errs } = await makePage();
  console.log('\nand if they would rather not:');
  const after = await page.evaluate(async () => {
    await (0, eval)('pzDuelCallPoll')();
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('aaaSecondary').click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      shown: document.getElementById('aaaModal').classList.contains('show'),
      screen: (document.querySelector('.screen.active') || {}).id || '',
      ticket: (0, eval)('selectedTicket')
    };
  });
  ok('the sheet closes', after.shown === false, JSON.stringify(after));
  ok('nothing is entered', after.screen !== 'mode-entry', after.screen);
  ok('and no ticket is chosen for them', after.ticket === 'green', after.ticket);
  /* The flag has to clear, or the NEXT call could never open. */
  ok('a later call can still open', (await page.evaluate(() => (0, eval)('PZ_CALL_OPEN'))) === null, String(await page.evaluate(() => (0, eval)('PZ_CALL_OPEN'))));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 10. «پیداش کن» ────────────────────────────────────────────────────── */
{
  waitingByTier = { blue: 1 }; posted = [];
  duelCalls = [{ id: 'c-3', fromUserId: 'them', fromName: 'رضا', tier: 'blue', matchId: 'm-42', stage: 2, secondsLeft: 170 }];
  const { ctx, page, errs } = await makePage();
  console.log('\nand if they want their revenge:');
  const after = await page.evaluate(async () => {
    await (0, eval)('pzDuelCallPoll')();
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('aaaPrimary').click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      screen: (document.querySelector('.screen.active') || {}).id || '',
      ticket: (0, eval)('selectedTicket'),
      pair: (0, eval)('pzPairKey'),
      shut: [...document.querySelectorAll('#tkSelGrid .tk-opt')].map((b) => b.classList.contains('shut'))
    };
  });
  ok('the ticket screen opens', after.screen === 'mode-entry', after.screen);
  ok('with their tier already chosen', after.ticket === 'blue', after.ticket);
  ok('and that tier is open', after.shut[1] === false, JSON.stringify(after.shut));
  /* NOT a private pairing: the person is in the open queue at that value, and
     locking to a pair key would stop them ever being met. */
  ok('no private pairing is claimed', !after.pair, String(after.pair));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 11. …BUT THEY WERE GONE BY THE TIME IT WAS READ ───────────────────── */
/* Sending somebody into a tier that has emptied, with no word why, is the
 * fault this whole batch started from — so the queue is asked again between
 * the tap and the screen. */
{
  waitingByTier = {}; posted = [];
  duelCalls = [{ id: 'c-4', fromUserId: 'them', fromName: 'رضا', tier: 'blue', matchId: 'm-42', stage: 2, secondsLeft: 4 }];
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen they were matched while the sheet was being read:');
  const after = await page.evaluate(async () => {
    await (0, eval)('pzDuelCallPoll')();
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('aaaPrimary').click();
    await new Promise((r) => setTimeout(r, 1200));
    return {
      screen: (document.querySelector('.screen.active') || {}).id || '',
      ticket: (0, eval)('selectedTicket'),
      toast: (document.getElementById('pzToast') || {}).textContent || ''
    };
  });
  ok('they are not sent into an empty tier', after.screen !== 'mode-entry', after.screen);
  ok('no ticket is chosen for them', after.ticket === 'green', after.ticket);
  ok('and they are told why', /منتظر نیست/.test(after.toast), after.toast.slice(0, 70));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 12. THE ORDINARY POLL CARRIES IT ──────────────────────────────────── */
/* One tick, one sheet: an invitation and a call arriving together must not
 * stack two sheets on each other. */
{
  waitingByTier = { blue: 1 }; posted = [];
  duelCalls = [{ id: 'c-5', fromUserId: 'them', fromName: 'رضا', tier: 'blue', matchId: 'm-42', stage: 2, secondsLeft: 170 }];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe poll that already runs:');
  const shown = await page.evaluate(async () => {
    (0, eval)("go('home');");
    await new Promise((r) => setTimeout(r, 300));
    await (0, eval)('pzInvitePoll')();
    await new Promise((r) => setTimeout(r, 500));
    return (document.getElementById('aaaTitle') || {}).textContent || '';
  });
  ok('reaches the call with no timer of its own', /ادامه داد/.test(shown), shown);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 13. THE CHAINED WINNER'S OWN QUEUE ENTRY ──────────────────────────── */
/* They spend no ticket, so nothing named their tier and the blue door stayed
 * shut over a queue with somebody standing in it — which is exactly the case
 * the whole rule was written around. The label says where they are standing;
 * it must never appear when a real ticket is being spent, because then it
 * would be a second name for a thing that already has one. */
{
  waitingByTier = {}; posted = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nwhat the chained winner sends to the queue:');
  await page.evaluate(async () => {
    (0, eval)("userPlan='premium'; duelTicket=null; window.matchValue=25000; curStake=25000;");
    (0, eval)('startMatchmaking')();
    await new Promise((r) => setTimeout(r, 900));
  });
  const enq = posted.filter((x) => x.path === '/matchmaking/enqueue').pop();
  ok('the enqueue goes out', !!enq, JSON.stringify(posted.map((x) => x.path)));
  ok('with no ticket, because none is being spent', enq && !enq.body.ticketTier, JSON.stringify(enq && enq.body));
  ok('but saying which tier they are waiting in', enq && enq.body.waitTier === 'blue', JSON.stringify(enq && enq.body));
  ok('and playing for the doubled stake', enq && enq.body.economyType === 'v25000', JSON.stringify(enq && enq.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 14. A REAL TICKET NEEDS NO LABEL ──────────────────────────────────── */
{
  waitingByTier = {}; posted = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nand what somebody entering on a real ticket sends:');
  await page.evaluate(async () => {
    (0, eval)("userPlan='premium'; duelTicket='red'; window.matchValue=50000; curStake=50000;");
    (0, eval)('startMatchmaking')();
    await new Promise((r) => setTimeout(r, 900));
  });
  const enq = posted.filter((x) => x.path === '/matchmaking/enqueue').pop();
  ok('the ticket is named', enq && enq.body.ticketTier === 'red', JSON.stringify(enq && enq.body));
  ok('and no label rides along with it', enq && !enq.body.waitTier, JSON.stringify(enq && enq.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 15. FREE PLAY IS IN NO TIER ───────────────────────────────────────── */
/* The friendly half has no tickets and no tiers. Counting a friendly player
 * into a tier would open a paid door over a queue nobody paid to be in. */
{
  waitingByTier = {}; posted = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nand what a friendly player sends:');
  await page.evaluate(async () => {
    (0, eval)("userPlan='free'; duelTicket=null; window.matchValue=12500; curStake=12500;");
    (0, eval)('startMatchmaking')();
    await new Promise((r) => setTimeout(r, 900));
  });
  const enq = posted.filter((x) => x.path === '/matchmaking/enqueue').pop();
  ok('no ticket', enq && !enq.body.ticketTier, JSON.stringify(enq && enq.body));
  ok('and no tier either', enq && !enq.body.waitTier, JSON.stringify(enq && enq.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE FRIENDLY HALF STILL CHOOSES ON A SCREEN ───────────────────────── */
/* A friendly duel is arranged for a number of coins and a heart, and BOTH of
 * those are chosen on the entry screen — so that half keeps its screen. Sending
 * a coin duel straight to the radar would skip the two things it is played
 * for, and would go looking for a ticket nobody agreed to spend. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\naccepting a friendly duel arranged for coins:');
  const after = await page.evaluate(async () => {
    (0, eval)('pzInviteGoNow')({ id: 'inv-c', mode: 'duel', ticketTier: '', coinStake: 300 });
    await new Promise((r) => setTimeout(r, 1200));
    return {
      screen: (document.querySelector('.screen.active') || {}).id || '',
      plan: (0, eval)('userPlan'),
      stake: (0, eval)('practiceCoinStake'),
      held: (0, eval)('duelTicket')
    };
  });
  ok('the entry screen opens, because there is still something to choose', after.screen === 'mode-entry', after.screen);
  ok('not the radar', after.screen !== 'matchmaking', after.screen);
  ok('in the friendly half', after.plan === 'free', String(after.plan));
  ok('asking for the coins that were agreed', Number(after.stake) === 300, String(after.stake));
  ok('and no ticket is held for it', !after.held, String(after.held));
  ok('no enqueue was started', posted.every((x) => x.path !== '/matchmaking/enqueue'), JSON.stringify(posted.map((x) => x.path)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE SHEET THAT ASKS WHICH TICKET TO INVITE WITH ───────────────────── */
/* «در مودال دعوت به دوئل رنگ دکمه انتخاب بلیط باید با بلیط ها ست باشه و آیکون
 * بلیط ها هم باید رو دکمه باشه، و تعداد بلیط های موجود رو روی دکمه ها ببینه، و
 * اگه ۰ بود نتونه با اون بلیط دعوت کنه.»
 *
 * Three identical grey rows told the sender nothing — least of all whether
 * they own the ticket they are about to promise to play for. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nchoosing which ticket to invite with:');
  const sheet = await page.evaluate(async () => {
    (0, eval)('mTickets={green:3,blue:0,red:2};');
    (0, eval)('pzInvitePickTicket')({ id: 'u9', username: 'رضا' }, () => {});
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelectorAll('.pz-inv-tk')].map((b) => ({
      key: b.getAttribute('data-tk'),
      colour: getComputedStyle(b).getPropertyValue('--tkc').trim(),
      border: getComputedStyle(b).borderTopColor,
      art: !!b.querySelector('.tk-opt-art'),
      count: (b.querySelector('.tk-opt-n') || {}).textContent || '',
      meta: (b.querySelector('.tk-opt-meta') || {}).textContent || '',
      shut: b.classList.contains('shut'),
      aria: b.getAttribute('aria-disabled')
    }));
  });
  ok('all three tickets are offered', sheet.length === 3, JSON.stringify(sheet.map((t) => t.key)));
  /* «رنگ دکمه انتخاب بلیط باید با بلیط ها ست باشه» */
  const colours = sheet.map((t) => t.colour);
  ok('each carries its own colour', new Set(colours).size === 3 && colours.every(Boolean), JSON.stringify(colours));
  ok('and wears it on its edge', new Set(sheet.map((t) => t.border)).size === 3, JSON.stringify(sheet.map((t) => t.border)));
  /* «آیکون بلیط ها هم باید رو دکمه باشه» */
  ok('and its own picture', sheet.every((t) => t.art), JSON.stringify(sheet.map((t) => t.art)));
  /* «تعداد بلیط های موجود رو روی دکمه ها ببینه» */
  ok('green shows the three they hold', /۳/.test(sheet[0].count), sheet[0].count);
  ok('blue shows none', /۰/.test(sheet[1].count), sheet[1].count);
  ok('red shows the two they hold', /۲/.test(sheet[2].count), sheet[2].count);
  /* «اگه ۰ بود نتونه با اون بلیط دعوت کنه» */
  ok('the one they have none of is locked', sheet[1].shut === true && sheet[1].aria === 'true', JSON.stringify(sheet[1]));
  ok('and says so on the tile', /نداری/.test(sheet[1].meta), sheet[1].meta);
  ok('the ones they hold are not locked', sheet[0].shut === false && sheet[2].shut === false, JSON.stringify([sheet[0].shut, sheet[2].shut]));
  ok('and those quote what they are worth', /ت/.test(sheet[0].meta), sheet[0].meta);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── AND TAPPING ONE ───────────────────────────────────────────────────── */
{
  waitingByTier = {}; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\ntapping a ticket on that sheet:');
  const picked = await page.evaluate(async () => {
    (0, eval)('mTickets={green:3,blue:0,red:2};');
    window.__picked = null;
    (0, eval)('pzInvitePickTicket')({ id: 'u9', username: 'رضا' }, (k) => { window.__picked = k; });
    await new Promise((r) => setTimeout(r, 300));
    /* The one they hold none of, first. */
    [...document.querySelectorAll('.pz-inv-tk')][1].click();
    await new Promise((r) => setTimeout(r, 400));
    const afterLocked = { picked: window.__picked, toast: (document.getElementById('pzToast') || {}).textContent || '',
                          open: document.getElementById('aaaModal').classList.contains('show') };
    [...document.querySelectorAll('.pz-inv-tk')][2].click();
    await new Promise((r) => setTimeout(r, 500));
    return { afterLocked, picked: window.__picked };
  });
  /* An invitation is a promise to play for that stake — one they cannot pay is
     one they cannot make. */
  ok('a ticket they do not hold cannot be invited with', picked.afterLocked.picked === null, String(picked.afterLocked.picked));
  ok('and the tap says why rather than doing nothing', /نداری/.test(picked.afterLocked.toast), picked.afterLocked.toast.slice(0, 70));
  ok('the sheet stays open so they can pick another', picked.afterLocked.open === true, String(picked.afterLocked.open));
  ok('a ticket they do hold is chosen', picked.picked === 'red', String(picked.picked));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── A SHEET IS ANSWERED, NOT TAPPED AWAY ──────────────────────────────── */
/* «مودال ها هم نباید با تاچ به اطراف مودال حذف بشه، باید با دکمه هاش حذف بشه —
 * یعنی باید تا دکمه هاشو تاچ نکردی و جواب ندادی نره.» */
{
  waitingByTier = {}; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\ntapping beside a sheet that asked a question:');
  const r = await page.evaluate(async () => {
    let answered = null;
    (0, eval)('showAaaModal')({
      icon: '❓', title: 'یک سؤال', sub: 'جواب بده',
      dismissible: true,                       // asked for, and no longer granted
      primaryText: 'بله', secondaryText: 'نه',
      onPrimary: () => { answered = 'yes'; (0, eval)('closeAaaModal')(false); },
      onSecondary: () => { answered = 'no'; (0, eval)('closeAaaModal')(false); }
    });
    await new Promise((res) => setTimeout(res, 300));
    const ov = document.getElementById('aaaModal');
    const box = ov.getBoundingClientRect();
    /* The corner of the backdrop — as far from the card as the sheet allows. */
    ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 3, clientY: box.top + 3 }));
    await new Promise((res) => setTimeout(res, 400));
    const stillOpen = ov.classList.contains('show');
    /* Read WHILE it is open: closing resets the flag to its default, so a read
       afterwards is the reset value and not the one under test. */
    const flag = ov.dataset.dismissible;
    document.getElementById('aaaSecondary').click();
    await new Promise((res) => setTimeout(res, 400));
    return { stillOpen, answered, closed: !ov.classList.contains('show'), flag };
  });
  ok('the sheet does not go', r.stillOpen === true, String(r.stillOpen));
  ok('and nothing was answered for them', r.answered === null || r.answered === 'no', String(r.answered));
  ok('the backdrop is marked as no way out', r.flag === '0', String(r.flag));
  ok('its own button still closes it', r.closed === true, String(r.closed));
  ok('and that button is what answers', r.answered === 'no', String(r.answered));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── …UNLESS THERE IS NO WAY OUT AT ALL ────────────────────────────────── */
/* A sheet with no button and no countdown has only the backdrop. Taking that
 * away would strand the player on a screen they cannot leave, which is a worse
 * fault than the one being fixed. */
{
  waitingByTier = {}; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\na sheet with nothing to press:');
  const r = await page.evaluate(async () => {
    (0, eval)('showAaaModal')({ icon: '💳', title: 'در حال پرداخت', sub: 'صبر کن…', primaryText: '', secondaryText: '' });
    await new Promise((res) => setTimeout(res, 300));
    const ov = document.getElementById('aaaModal');
    const primary = getComputedStyle(document.getElementById('aaaPrimary')).display;
    const secondary = getComputedStyle(document.getElementById('aaaSecondary')).display;
    const box = ov.getBoundingClientRect();
    const flag = ov.dataset.dismissible;
    ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 3, clientY: box.top + 3 }));
    await new Promise((res) => setTimeout(res, 400));
    return { flag, gone: !ov.classList.contains('show'), primary, secondary };
  });
  ok('an explicitly empty primary really is hidden', r.primary === 'none', r.primary);
  ok('and so is the secondary', r.secondary === 'none', r.secondary);
  ok('the backdrop stays the way out', r.flag === '1', String(r.flag));
  ok('and it works', r.gone === true, String(r.gone));

  /* A SHEET THAT NEVER MENTIONS ITS PRIMARY STILL HAS ONE. Only an EXPLICIT
     empty label means «no primary action» — undefined means «use the default»,
     and a sheet that has always had a button must not lose it. */
  const dflt = await page.evaluate(async () => {
    (0, eval)('showAaaModal')({ icon: '✅', title: 'خبر', sub: 'یک خبر' });
    await new Promise((res) => setTimeout(res, 300));
    const p = document.getElementById('aaaPrimary');
    const ov = document.getElementById('aaaModal');
    const out = { display: getComputedStyle(p).display, label: p.textContent, flag: ov.dataset.dismissible };
    p.click();
    await new Promise((res) => setTimeout(res, 300));
    out.closed = !ov.classList.contains('show');
    return out;
  });
  ok('a sheet that never mentioned a primary keeps one', dflt.display !== 'none', dflt.display);
  ok('with the default label on it', /متوجه شدم/.test(dflt.label), dflt.label);
  ok('so it counts as having its own way out', dflt.flag === '0', String(dflt.flag));
  ok('and that button closes it', dflt.closed === true, String(dflt.closed));

  /* A COUNTDOWN IS A WAY OUT TOO — it closes the sheet itself when it runs
     down, so the backdrop is not needed and must not be offered. */
  const timed = await page.evaluate(async () => {
    (0, eval)('showAaaModal')({ icon: '⏳', title: 'آماده‌ای؟', sub: 'شروع…', seconds: 3, hideActions: true });
    await new Promise((res) => setTimeout(res, 300));
    const ov = document.getElementById('aaaModal');
    const out = { flag: ov.dataset.dismissible, timed: ov.dataset.timed, actions: getComputedStyle(document.getElementById('aaaActions')).display };
    const box = ov.getBoundingClientRect();
    ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 3, clientY: box.top + 3 }));
    await new Promise((res) => setTimeout(res, 400));
    out.stillOpen = ov.classList.contains('show');
    return out;
  });
  ok('a countdown sheet shows no buttons at all', timed.actions === 'none', timed.actions);
  ok('yet it is marked as having its own way out', timed.flag === '0', String(timed.flag));
  ok('and is marked as timed', timed.timed === '1', String(timed.timed));
  ok('so tapping beside it does nothing', timed.stillOpen === true, String(timed.stillOpen));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE SHEET AFTER THE INVITATION GOES OUT ───────────────────────────── */
/* «متن اون باید اینطوری باشه: دعوت ارسال شد، به محض پذیرفتن وارد بازی میشوید.
 * و دکمه بیخیال باید بشه متوجه شدم و با رنگ زرد.» */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nwaiting for an answer:');
  const sheet = await page.evaluate(async () => {
    (0, eval)('pzInviteWait')({ id: 'inv-w' }, 'blue', 0);
    await new Promise((r) => setTimeout(r, 400));
    const sec = document.getElementById('aaaSecondary');
    const cs = getComputedStyle(sec);
    return {
      title: (document.getElementById('aaaTitle') || {}).textContent || '',
      sub: (document.getElementById('aaaSub') || {}).textContent || '',
      label: sec.textContent,
      cls: sec.className,
      bg: (cs.backgroundImage.match(/\d+/g) || []).map(Number),
      fg: (cs.color.match(/\d+/g) || []).map(Number),
      shown: getComputedStyle(sec).display !== 'none',
      primaryShown: getComputedStyle(document.getElementById('aaaPrimary')).display !== 'none'
    };
  });
  ok('it says the invitation went out', /دعوت ارسال شد/.test(sheet.sub), sheet.sub);
  ok('and what happens when they accept', /به محض پذیرفتن وارد بازی می‌شوید/.test(sheet.sub), sheet.sub);
  /* The old wording described sitting and waiting; there is nothing to decide
     here, so «بی‌خیال» read as an offer to call it off. */
  ok('the button no longer says «بی‌خیال»', !/بی.?خیال/.test(sheet.label), sheet.label);
  ok('it says «متوجه شدم»', /متوجه شدم/.test(sheet.label), sheet.label);
  ok('and it is yellow', sheet.bg[0] > 200 && sheet.bg[1] > 170 && sheet.bg[2] < 130, JSON.stringify(sheet.bg));
  ok('with dark text on it, so it can be read', sheet.fg[0] + sheet.fg[1] + sheet.fg[2] < 250, JSON.stringify(sheet.fg));
  ok('the button is really there', sheet.shown === true, String(sheet.shown));
  ok('and it is the only one', sheet.primaryShown === false, String(sheet.primaryShown));
  ok('and it says the sheet can be put away', /می‌توانی این پیام را ببندی/.test(sheet.sub), sheet.sub.slice(0, 120));
  /* «متوجه شدم» PUTS THE SHEET AWAY AND KEEPS LISTENING. It used to cancel the
     invitation and stop the poll, which is how the sender ended up never
     hearing anything at all. */
  const closed = await page.evaluate(async () => {
    document.getElementById('aaaSecondary').click();
    await new Promise((r) => setTimeout(r, 500));
    return { open: document.getElementById('aaaModal').classList.contains('show'), waiting: !!(0, eval)('PZ_INV_WAIT') };
  });
  ok('pressing it closes the sheet', closed.open === false, String(closed.open));
  ok('but the answer is still being waited for', closed.waiting === true, String(closed.waiting));
  ok('and the invitation is NOT called off', !posted.some((x) => /\/invites\/inv-w\/cancel/.test(x.path)), JSON.stringify(posted.map((x) => x.path)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── SENDING IT, THE WHOLE WAY THROUGH ─────────────────────────────────── */
/* The cases below drive pzInviteWait() by hand, which is how they can be
   precise about what each ending says — but it leaves the one line that
   connects the two untested, and dropping the invited player's name there
   turns every notice back into «حریف» with nothing to notice it. So this one
   starts where the sender starts: at the button. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  inviteStatus = { id: 'inv-s', status: 'pending', secondsLeft: 50 };
  const { ctx, page, errs } = await makePage();
  console.log('\nsending an invitation, from the button:');
  const sent = await page.evaluate(async () => {
    await (0, eval)('pzInviteSend')({ userId: 'them', username: 'نگار' }, 'duel', { ticketTier: 'blue', coinStake: 0 });
    await new Promise((r) => setTimeout(r, 400));
    const w = (0, eval)('PZ_INV_WAIT');
    return { id: w ? w.id : null, name: w ? w.name : null, tier: w ? w.tier : null,
             shown: document.getElementById('aaaModal').classList.contains('show') };
  });
  ok('the invitation really went out', posted.some((x) => x.method === 'POST' && x.path === '/invites'),
     JSON.stringify(posted.map((x) => x.method + ' ' + x.path)));
  ok('and the sheet waits on that one', sent.id === 'inv-s', String(sent.id));
  ok('with the ticket it was sent on', sent.tier === 'blue', String(sent.tier));
  ok('and it knows who was invited', sent.name === 'نگار', String(sent.name));
  ok('the sheet is up', sent.shown === true, String(sent.shown));

  /* And the name survives all the way to the answer. */
  const refused = await page.evaluate(async () => {
    document.getElementById('aaaSecondary').click();
    await new Promise((r) => setTimeout(r, 300));
  });
  void refused;
  inviteStatus = { id: 'inv-s', status: 'rejected', secondsLeft: 40 };
  const notice = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 3200));
    return { title: (document.getElementById('aaaTitle') || {}).textContent || '',
             sub: (document.getElementById('aaaSub') || {}).textContent || '' };
  });
  ok('the refusal names the player who was invited', /نگار/.test(notice.sub), notice.sub.slice(0, 90));
  ok('and does not fall back to «حریف»', !/^\s*حریف\s/.test(notice.sub), notice.sub.slice(0, 60));
  ok('it is called a refusal', /رد شد/.test(notice.title), notice.title);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── BEING TURNED DOWN ─────────────────────────────────────────────────── */
/* «اگه نیومد و رد کرد دیگه معلوم نمیشه که رد کرده یا اصلا به دستش نرسیده — اگه
 * رد کرد باید اطلاع بده که حریف درخواست شما را رد کرد.» The two look identical
 * from the sender's side, and telling them apart is the whole question. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  inviteStatus = { id: 'inv-r', status: 'pending', secondsLeft: 50 };
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen the invitation is refused:');
  await page.evaluate(async () => {
    (0, eval)('pzInviteWait')({ id: 'inv-r' }, 'green', 0, 'رضا');
    await new Promise((r) => setTimeout(r, 400));
    /* The sender puts the sheet away, as they are told they may. */
    document.getElementById('aaaSecondary').click();
    await new Promise((r) => setTimeout(r, 400));
  });
  inviteStatus = { id: 'inv-r', status: 'rejected', secondsLeft: 40 };
  const told = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 3200));
    return {
      shown: document.getElementById('aaaModal').classList.contains('show'),
      title: (document.getElementById('aaaTitle') || {}).textContent || '',
      sub: (document.getElementById('aaaSub') || {}).textContent || '',
      waiting: !!(0, eval)('PZ_INV_WAIT')
    };
  });
  ok('the sender is told, on a sheet of its own', told.shown === true, JSON.stringify(told).slice(0, 120));
  ok('that the invitation was refused', /رد شد/.test(told.title), told.title);
  ok('and by whom', /رضا/.test(told.sub), told.sub.slice(0, 90));
  ok('the waiting is over', told.waiting === false, String(told.waiting));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── TURNED DOWN BY SOMEBODY WHOSE NAME WE NEVER HAD ───────────────────── */
/* An invitation can be sent from a place that knows only an id. The notice
   still has to read as a sentence, so the blank becomes «حریف» — leaving it
   empty gives «‌ درخواست بازی تو را رد کرد», which reads as a bug. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  inviteStatus = { id: 'inv-n', status: 'rejected', secondsLeft: 40 };
  const { ctx, page, errs } = await makePage();
  console.log('\nrefused by someone whose name we never had:');
  const told = await page.evaluate(async () => {
    (0, eval)('pzInviteWait')({ id: 'inv-n' }, 'green', 0);
    await new Promise((r) => setTimeout(r, 3200));
    return { title: (document.getElementById('aaaTitle') || {}).textContent || '',
             sub: (document.getElementById('aaaSub') || {}).textContent || '' };
  });
  ok('it is still called a refusal', /رد شد/.test(told.title), told.title);
  ok('and the blank reads «حریف»', /حریف\s*درخواست/.test(told.sub), told.sub.slice(0, 90));
  ok('so the sentence does not start on a gap', !/^\s*درخواست/.test(told.sub), told.sub.slice(0, 60));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── AND WHEN NOBODY ANSWERS AT ALL ────────────────────────────────────── */
/* The other half of «رد کرده یا اصلا به دستش نرسیده» — said in different
 * words, because it is a different thing and the sender's next move differs. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  inviteStatus = { id: 'inv-e', status: 'expired', secondsLeft: 0 };
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen nobody answers:');
  const quiet = await page.evaluate(async () => {
    (0, eval)('pzInviteWait')({ id: 'inv-e' }, 'green', 0, 'سارا');
    await new Promise((r) => setTimeout(r, 3200));
    return {
      shown: document.getElementById('aaaModal').classList.contains('show'),
      title: (document.getElementById('aaaTitle') || {}).textContent || '',
      sub: (document.getElementById('aaaSub') || {}).textContent || ''
    };
  });
  ok('the sender is told about that too', quiet.shown === true, JSON.stringify(quiet).slice(0, 120));
  ok('and it is not called a refusal', !/رد شد/.test(quiet.title), quiet.title);
  ok('it says no answer came', /جوابی نیامد/.test(quiet.title), quiet.title);
  ok('and allows that it may never have arrived', /به دستش نرسیده/.test(quiet.sub), quiet.sub.slice(0, 120));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── AND WHEN THE MINUTE SIMPLY RUNS OUT ───────────────────────────────── */
/* There are two different ways to hear nothing, and only one of them comes
   from the server. The case above is the server saying «expired»; this is the
   sender's own minute lapsing while the server is still saying «pending» —
   which is also what happens when the poll cannot reach it at all. Same
   silence, different branch, and it was the untested one. The deadline is
   pushed into the past rather than waited out. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  inviteStatus = { id: 'inv-t', status: 'pending', secondsLeft: 0 };
  const { ctx, page, errs } = await makePage();
  console.log('\nwhen the minute runs out and the server is still saying «pending»:');
  const lapsed = await page.evaluate(async () => {
    (0, eval)('pzInviteWait')({ id: 'inv-t' }, 'green', 0, 'مهسا');
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)('PZ_INV_WAIT').until = Date.now() - 1;
    await new Promise((r) => setTimeout(r, 3400));
    return {
      shown: document.getElementById('aaaModal').classList.contains('show'),
      title: (document.getElementById('aaaTitle') || {}).textContent || '',
      sub: (document.getElementById('aaaSub') || {}).textContent || '',
      waiting: !!(0, eval)('PZ_INV_WAIT')
    };
  });
  ok('the sender is told, on a sheet of its own', lapsed.shown === true, JSON.stringify(lapsed).slice(0, 120));
  ok('it says no answer came', /جوابی نیامد/.test(lapsed.title), lapsed.title);
  ok('and it is not called a refusal', !/رد شد/.test(lapsed.title), lapsed.title);
  ok('it names who was invited', /مهسا/.test(lapsed.sub), lapsed.sub.slice(0, 90));
  ok('and allows that it may never have arrived', /به دستش نرسیده/.test(lapsed.sub), lapsed.sub.slice(0, 120));
  ok('the waiting is over', lapsed.waiting === false, String(lapsed.waiting));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE SEAT KEPT FOR THE PLAYER WHO LOST ─────────────────────────────── */
/* «حریف باید تا ۱۰ ثانیه نتونه با کسی مچ بشه… ولی کاربر نباید این معطلی رو
 * ببینه و بدونه، باید حس کنه سیستم در حال یافتن حریفه براش.» The window itself
 * is the queue's business; what this device has to do is NAME the person, and
 * do it without the winner noticing. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe winner carrying on:');
  const t0 = Date.now();
  await page.evaluate(async () => {
    (0, eval)("duelStage=1; duelStakeVal=12500; userPlan='premium'; pzRt.matchId='m-77';");
    (0, eval)('duelContinue')();
    await new Promise((r) => setTimeout(r, 2600));
  });
  const enq = posted.filter((x) => x.path === '/matchmaking/enqueue').pop();
  const call = posted.find((x) => x.method === 'POST' && x.path === '/duel-calls');
  ok('the loser is told', !!call, JSON.stringify(posted.map((x) => x.path)));
  ok('and the search goes out', !!enq, JSON.stringify(posted.map((x) => x.path)));
  /* The server named them; this device quotes the name back. */
  ok('naming the player the seat is kept for', enq && enq.body.holdFor === 'them', JSON.stringify(enq && enq.body));
  ok('and the radar is what they are looking at', (await page.evaluate(() => (document.querySelector('.screen.active') || {}).id)) === 'matchmaking');
  /* «کاربر نباید این معطلی رو ببینه» — the wait for the name rides behind the
     radar animation, which was already on screen. */
  ok('the search was not held up noticeably', Date.now() - t0 < 4000, (Date.now() - t0) + 'ms');
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── AND THE CLAIM IS SPENT ONCE ───────────────────────────────────────── */
/* Left lying about it would hold up the NEXT ordinary search too — the same
 * fault the pairing key was fixed for. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nsearching again afterwards:');
  await page.evaluate(async () => {
    (0, eval)("duelStage=1; duelStakeVal=12500; userPlan='premium'; pzRt.matchId='m-78';");
    (0, eval)('duelContinue')();
    await new Promise((r) => setTimeout(r, 2600));
    /* An ordinary search, later, with nothing arranged. */
    (0, eval)("go('home'); duelTicket='green'; window.matchValue=12500;");
    (0, eval)('startMatchmaking')();
    await new Promise((r) => setTimeout(r, 1400));
  });
  const enqs = posted.filter((x) => x.path === '/matchmaking/enqueue');
  ok('both searches went out', enqs.length === 2, String(enqs.length));
  ok('the first kept the seat', enqs[0] && enqs[0].body.holdFor === 'them', JSON.stringify(enqs[0] && enqs[0].body));
  ok('and the second kept nothing', enqs[1] && !enqs[1].body.holdFor, JSON.stringify(enqs[1] && enqs[1].body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── MY REFERRAL CODE ──────────────────────────────────────────────────── */
/* «هر کاربر یه کد داشته باشه… خودم یه کد دارم که هر کی با اون وارد بشه برای من
 * یه بلیط سبز میده.» And, just as firmly: «بعد از ثبت نام دیگه جایی نباشه که
 * بتونی وارد کنی» — so this screen shows a code and offers nowhere to type one. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nmy referral code:');
  const scr = await page.evaluate(async () => {
    (0, eval)("menuGo('referral')");
    await new Promise((r) => setTimeout(r, 900));
    const sec = document.getElementById('referral');
    return {
      active: (document.querySelector('.screen.active') || {}).id || '',
      code: (document.getElementById('refCode') || {}).textContent || '',
      count: (document.getElementById('refCount') || {}).textContent || '',
      inputs: sec ? sec.querySelectorAll('input,textarea').length : -1,
      text: sec ? sec.innerText : '',
      title: sec ? (sec.querySelector('.topbar h1') || {}).textContent || '' : ''
    };
  });
  ok('the screen opens', scr.active === 'referral', scr.active);
  ok('showing the code the server gave', /K7XQ2MW/.test(scr.code), scr.code);
  ok('and how many have used it', /۴/.test(scr.count), scr.count);
  /* THE HALF THAT IS A RULE, NOT A DECORATION. */
  ok('there is nowhere to type a code', scr.inputs === 0, String(scr.inputs));
  ok('it says what the reward is', /بلیط سبز/.test(scr.text), scr.text.slice(0, 120));
  ok('and that the code goes in at sign-up', /ثبت‌نام/.test(scr.text), scr.text.slice(0, 200));
  ok('the title rides its own card', /کد معرف/.test(scr.title), scr.title);

  /* Copying is the point of the screen — a copy button that quietly does
     nothing is worse than none. */
  const copied = await page.evaluate(async () => {
    let got = null;
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { got = t; return Promise.resolve(); } }, configurable: true }); } catch (e) {}
    (0, eval)('refCopy')();
    await new Promise((r) => setTimeout(r, 400));
    return { got, toast: (document.getElementById('pzToast') || {}).textContent || '' };
  });
  ok('the copy button copies the code', copied.got === 'K7XQ2MW', String(copied.got));
  ok('and says so', /کپی/.test(copied.toast), copied.toast);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE NOTIFICATIONS SCREEN ──────────────────────────────────────────── */
/* «توضیحات اول صفحه اعلان رو حذف — کاربر باید فقط روشن و خاموش کنه، به کاربر
 * ربط نداره گوشی روی سرور ثبت شده یا نه. و یه قسمت هم بزار برای خاموش و روشن
 * کردن دریافت دعوت به بازی که پیش فرض روشن باشه.» */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe notifications screen:');
  const scr = await page.evaluate(async () => {
    (0, eval)("openSettingDetail('notifications')");
    await new Promise((r) => setTimeout(r, 600));
    const box = document.getElementById('settingDetailContent');
    return {
      text: box ? box.innerText : '',
      notes: box ? box.querySelectorAll('.set-note').length : -1,
      pushStatus: !!document.getElementById('pzPushStatus'),
      switches: box ? [...box.querySelectorAll('.set-row')].map((r) => (r.querySelector('b') || {}).textContent || '') : [],
      invitesOn: (0, eval)('appSettings').notifGameInvites,
      pushOn: (0, eval)('appSettings').notifPush
    };
  });
  /* The two things that used to open the screen. */
  ok('the explanation is gone', !/نوع اعلان‌هایی که از بازی/.test(scr.text), scr.text.slice(0, 100));
  ok('and so is the report on whether the handset is registered', scr.pushStatus === false, String(scr.pushStatus));
  ok('nothing is left explaining the screen to the player', scr.notes === 0, String(scr.notes));
  /* «یه قسمت هم بزار برای… دریافت دعوت به بازی» */
  ok('there is a switch for game invitations', scr.switches.some((t) => /دریافت دعوت به بازی/.test(t)), JSON.stringify(scr.switches));
  ok('and it starts on', scr.invitesOn === true, String(scr.invitesOn));
  /* Registering the handset is what the switch DOES, rather than a row you
     tap next to a paragraph reporting whether it worked. */
  ok('the push row is a switch now', scr.switches.some((t) => /اعلان روی گوشی/.test(t)), JSON.stringify(scr.switches));
  ok('and it starts on too', scr.pushOn === true, String(scr.pushOn));

  /* AND THE SWITCH MEANS IT. The sheet is what an invitation is on this
     screen, so turning it off has to stop the sheet. */
  const off = await page.evaluate(async () => {
    (0, eval)("appSettings.notifGameInvites=false;");
    (0, eval)("go('home'); PZ_INV_OPEN=null;");
    /* The app raises prompts of its own on the way in; a sheet already on
       screen would answer this question for us. */
    for (let i = 0; i < 4; i++) {
      const ov = document.getElementById('aaaModal');
      if (!ov || !ov.classList.contains('show')) break;
      const sec = document.getElementById('aaaSecondary');
      const b = (sec && getComputedStyle(sec).display !== 'none') ? sec : document.getElementById('aaaPrimary');
      if (b) b.click(); else break;
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, 200));
    (0, eval)('pzInviteAsk')({ id: 'inv-x', mode: 'duel', ticketTier: 'green', coinStake: 0, fromName: 'رضا' });
    await new Promise((r) => setTimeout(r, 500));
    return document.getElementById('aaaModal').classList.contains('show');
  });
  ok('turned off, no invitation sheet opens', off === false, String(off));
  const on = await page.evaluate(async () => {
    (0, eval)("appSettings.notifGameInvites=true; PZ_INV_OPEN=null;");
    (0, eval)('pzInviteAsk')({ id: 'inv-y', mode: 'duel', ticketTier: 'green', coinStake: 0, fromName: 'رضا' });
    await new Promise((r) => setTimeout(r, 500));
    return { shown: document.getElementById('aaaModal').classList.contains('show'),
             title: (document.getElementById('aaaTitle') || {}).textContent || '' };
  });
  ok('turned back on, it opens again', on.shown === true && /رضا/.test(on.title), JSON.stringify(on));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE «SHOW MORE PLAYERS» BUTTON ────────────────────────────────────── */
/* «دکمه نمایش افراد دیگر در صفحه افراد آنلاین رنگش سبز بشه و قیمتشم روش نوشته
 * بشه، مثلا ۵۰۰ سکه.» */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe «show more players» button:');
  const read = () => page.evaluate(() => {
    const el = document.getElementById('onRefresh');
    const cs = getComputedStyle(el);
    return { text: el.textContent, bg: (cs.backgroundImage.match(/\d+/g) || []).map(Number), cls: el.className };
  });

  /* Before it has been drawn at all — the markup itself has to be green, or
     the first paint of the screen is a grey button that turns green. */
  await page.evaluate(async () => { (0, eval)("go('online')"); await new Promise((r) => setTimeout(r, 300)); });
  const first = await read();
  ok('it is green from the markup', /btn-green/.test(first.cls), first.cls);
  ok('and not a ghost button', !/btn-ghost/.test(first.cls), first.cls);

  onlineCost = 500;
  await page.evaluate(async () => { await (0, eval)('onlineLoad')(false); await new Promise((r) => setTimeout(r, 300)); });
  const paid = await read();
  ok('once the server names a price, it is green', paid.bg[1] > paid.bg[0] + 40 && paid.bg[1] > paid.bg[2] + 40, JSON.stringify(paid.bg));
  ok('and the price is written on it', /۵۰۰/.test(paid.text) && /سکه/.test(paid.text), paid.text);

  /* And when it costs nothing, it says THAT — a button that only sometimes
     says what it costs is one you have to press to find out. */
  onlineCost = 0;
  await page.evaluate(async () => { (0, eval)('ONLINE_BUSY=false'); await (0, eval)('onlineLoad')(false); await new Promise((r) => setTimeout(r, 300)); });
  const free = await read();
  ok('a free look says so', /رایگان/.test(free.text), free.text);
  ok('and it is still green', /btn-green/.test(free.cls), free.cls);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE PODIUM ────────────────────────────────────────────────────────── */
/* «سکوی اول دوم و سوم صفحهٔ رنکینگ رو باز طراحی کن، و اسم افراد واضح دیده بشه،
 * و سکو خیلی خوشگل‌تر از این باید باشه با رنگ واضح، و متن هر هفته ریست میشود و
 * نفرات برتر به لیگ هفتگی راه پیدا می‌کنند.» */
const openRank = async (page, tab) => page.evaluate(async (t) => {
  for (let i = 0; i < 5; i++) {
    const ov = document.getElementById('aaaModal');
    if (!ov || !ov.classList.contains('show')) break;
    const s = document.getElementById('aaaSecondary');
    const b = (s && getComputedStyle(s).display !== 'none') ? s : document.getElementById('aaaPrimary');
    if (b) b.click(); else break;
    await new Promise((r) => setTimeout(r, 300));
  }
  (0, eval)("go('rankings')");
  await new Promise((r) => setTimeout(r, 300));
  await (0, eval)('rankTab')(null, t);
  await new Promise((r) => setTimeout(r, 600));
}, tab);

{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe rankings podium:');
  await openRank(page, 'cup');

  const pods = await page.evaluate(() => {
    const box = (e) => { const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }; };
    return [...document.querySelectorAll('.podium .pod')].map((p) => {
      const n = p.querySelector('.pod-name');
      const base = p.querySelector('.base');
      return {
        cls: p.className,
        name: n ? n.textContent : null,
        nameBox: n ? box(n) : null,
        /* Does the whole name actually fit, or is part of it hidden? */
        nameClipped: n ? (n.scrollHeight > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2) : null,
        score: (p.querySelector('.pod-score') || {}).textContent || '',
        medal: (p.querySelector('.pod-medal') || {}).textContent || '',
        crown: !!p.querySelector('.pod-crown'),
        base: base ? box(base) : null,
        baseBg: base ? getComputedStyle(base).backgroundImage : ''
      };
    });
  });

  ok('all three places are on it', pods.length === 3, String(pods.length));
  /* The centre column is FIRST place — a podium reads 2·1·3, not 1·2·3. */
  ok('first place stands in the middle', /p1/.test(pods[1].cls), pods.map((p) => p.cls).join(' | '));
  ok('with the crown', pods[1].crown === true && !pods[0].crown && !pods[2].crown, JSON.stringify(pods.map((p) => p.crown)));

  /* «اسم افراد واضح دیده بشه» — the whole name, not its first word. */
  ok('the winner’s full name is shown', pods[1].name === 'محمدرضا حسین‌زاده', pods[1].name);
  ok('not just the first word of it', !/^محمدرضا$/.test(pods[1].name), pods[1].name);
  ok('a long Latin name is shown in full too', pods[0].name === 'Ali_TheDestroyer_99', pods[0].name);
  ok('and none of the three is cut off', pods.every((p) => p.nameClipped === false), JSON.stringify(pods.map((p) => p.nameClipped)));
  /* It has real room: the column's width, and two lines when it needs them. */
  ok('the name gets the whole column', pods.every((p) => p.nameBox.w >= 80), JSON.stringify(pods.map((p) => p.nameBox.w)));
  ok('with room for two lines', pods.every((p) => p.nameBox.h >= 30), JSON.stringify(pods.map((p) => p.nameBox.h)));
  /* A two-line name must not lift its own column out of line with the rest —
     the columns share a baseline and that is what makes it a podium. */
  ok('every plinth stands on the same floor', pods[0].base.b === pods[1].base.b && pods[1].base.b === pods[2].base.b,
     JSON.stringify(pods.map((p) => p.base.b)));

  /* «با رنگ واضح» — gold, silver and bronze, told apart by colour and not by
     height alone. */
  const rgb = (s) => (s.match(/\d+/g) || []).map(Number).slice(0, 3);
  const gold = rgb(pods[1].baseBg), silver = rgb(pods[0].baseBg), bronze = rgb(pods[2].baseBg);
  ok('first place is gold', gold[0] > 200 && gold[1] > 170 && gold[2] < 160, JSON.stringify(gold));
  ok('second is silver — no colour of its own', Math.abs(silver[0] - silver[2]) < 30 && silver[0] > 200, JSON.stringify(silver));
  ok('third is bronze', bronze[0] > 200 && bronze[1] > 120 && bronze[1] < bronze[0] - 40 && bronze[2] < bronze[1], JSON.stringify(bronze));
  ok('the three are really different', new Set([pods[0].baseBg, pods[1].baseBg, pods[2].baseBg]).size === 3);
  /* The winner's plinth is the tallest — the shape of a podium. */
  ok('the plinths step down from the middle', pods[1].base.h > pods[0].base.h && pods[0].base.h > pods[2].base.h,
     JSON.stringify(pods.map((p) => p.base.h)));
  /* A podium of three faces and no numbers says nothing about why they are
     standing there. */
  ok('each place shows its score', pods.every((p) => /[۰-۹]/.test(p.score)), JSON.stringify(pods.map((p) => p.score)));
  ok('and the winner’s is the biggest of them', /۱٬۸۴۰|۱۸۴۰/.test(pods[1].score), pods[1].score);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE MEDALS ARE THE GAME'S OWN, NOT THE PHONE'S ────────────────────── */
/* «این مدال‌ها رو به جای مدال‌های ایموجی در رنکینگ بزار، فقط به صورت webp و
 * کم‌حجم.» An emoji medal is whatever the handset's font decides it is; three
 * phones draw three different things and none of them is the game's. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe medals on the podium:');
  await openRank(page, 'cup');

  /* The MARKUP the podium asks for, read from the builder rather than off the
     page: this harness serves no medal files, so by the time a rendered podium
     can be inspected the fallback ladder has already run to the end — which is
     the ladder working, not the request being wrong. */
  const asked = await page.evaluate(() => ({
    gold: (0, eval)('pzMedalHTML')('p1', '🥇'),
    silver: (0, eval)('pzMedalHTML')('p2', '🥈'),
    bronze: (0, eval)('pzMedalHTML')('p3', '🥉'),
    unknown: (0, eval)('pzMedalHTML')('p9', '🎖️')
  }));
  ok('each place asks for a picture, not a glyph', /<img /.test(asked.gold) && /<img /.test(asked.silver) && /<img /.test(asked.bronze),
     JSON.stringify(asked).slice(0, 140));
  /* A medal that has been uploaded is asked for by the address the panel gave
     it; one that has not is asked for by name, «فقط به صورت webp» first. */
  ok('an uploaded medal is asked for by its own address', asked.bronze.includes('src="' + MEDIA_URL['medal-bronze'] + '"'), asked.bronze.slice(0, 120));
  ok('one that is not uploaded is asked for by name', asked.gold.includes('src="./medal-gold.webp"'), asked.gold.slice(0, 120));
  ok('silver too', asked.silver.includes('src="./medal-silver.webp"'), asked.silver.slice(0, 120));
  /* A place with no artwork name of its own is not left with a broken tag. */
  ok('anything else is just the glyph', !/<img /.test(asked.unknown) && /🎖️/.test(asked.unknown), asked.unknown);

  /* Sized by CSS, so the emoji and the artwork occupy the same space and the
     podium does not jump when the files finally land. */
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.podium .pod-medal')]
    .map((m) => ({ w: Math.round(m.getBoundingClientRect().width), h: Math.round(m.getBoundingClientRect().height) })));
  ok('the space is reserved whatever fills it', boxes.every((b) => b.w >= 24 && b.h >= 24), JSON.stringify(boxes));

  /* THE LADDER ITSELF, rung by rung. A picture that is not uploaded yet must
     not leave a broken-image icon on the podium — and one uploaded through the
     panel must be found without anything being moved by hand. Media folder
     first, the game's own folder second, WebP before PNG in each, emoji last. */
  const fell = await page.evaluate(async () => {
    const host = document.createElement('span');
    host.innerHTML = (0, eval)('pzMedalHTML')('p1', '🥇');
    document.body.appendChild(host);
    const span = host.firstChild;
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const img = span.querySelector('img');
      if (!img) break;
      seen.push(img.getAttribute('src'));
      (0, eval)('pzArtNext')(img, '🥇');
    }
    const out = { seen, text: span.textContent, stillImg: !!span.querySelector('img') };
    host.remove();
    return out;
  });
  ok('a name with no upload starts beside the game', fell.seen[0] === './medal-gold.webp', String(fell.seen[0]));
  ok('and works through the formats', fell.seen[1] === './medal-gold.png' && fell.seen[2] === './medal-gold.jpg',
     JSON.stringify(fell.seen));
  ok('three addresses, no more', fell.seen.length === 3, JSON.stringify(fell.seen));
  ok('and with none of them, the emoji comes back', fell.text === '🥇' && fell.stillImg === false, JSON.stringify(fell));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── AND WITH THE FILES UPLOADED, THE PODIUM WEARS THEM ────────────────── */
/* The tests above ask the BUILDER what markup it wants. This one asks the
   podium what it actually put on the page, with the files answering — the only
   way to notice if the podium ever stops calling the builder at all. */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  artUploaded = 'root'; artAsked = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nonce the medal files are on the server:');
  await openRank(page, 'cup');
  const worn = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 400));
    return [...document.querySelectorAll('.podium .pod')].map((p) => {
      const m = p.querySelector('.pod-medal');
      const img = m ? m.querySelector('img') : null;
      const box = m ? m.getBoundingClientRect() : null;
      return {
        cls: p.className,
        src: img ? (img.getAttribute('src') || '') : null,
        loaded: img ? img.naturalWidth > 0 : false,
        w: box ? Math.round(box.width) : 0,
        text: m ? m.textContent : ''
      };
    });
  });
  ok('the podium shows the artwork, not the glyph', worn.every((p) => p.src && p.loaded), JSON.stringify(worn));
  ok('gold in the middle', /medal-gold\./.test(worn[1].src || ''), String(worn[1].src));
  ok('silver to one side of it', /medal-silver\./.test(worn[0].src || ''), String(worn[0].src));
  ok('bronze to the other', /medal-bronze\./.test(worn[2].src || ''), String(worn[2].src));
  ok('and no glyph left sitting behind it', worn.every((p) => p.text.trim() === ''), JSON.stringify(worn.map((p) => p.text)));
  ok('each keeps the space the CSS reserved', worn.every((p) => p.w >= 24), JSON.stringify(worn.map((p) => p.w)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  artUploaded = '';
}

{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nand the emoji each place falls back to:');
  await openRank(page, 'cup');
  const pods = await page.evaluate(() => [...document.querySelectorAll('.podium .pod')].map((p) => {
    const m = p.querySelector('.pod-medal');
    const img = m.querySelector('img');
    if (img) img.dispatchEvent(new Event('error'));
    if (m.querySelector('img')) m.querySelector('img').dispatchEvent(new Event('error'));
    return { cls: p.className, medal: m.textContent };
  }));
  ok('each wears its own medal', pods[1].medal === '🥇' && pods[0].medal === '🥈' && pods[2].medal === '🥉',
     JSON.stringify(pods.map((p) => p.medal)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE LINE UNDER IT ─────────────────────────────────────────────────── */
/* «متن هر هفته ریست میشود و نفرات برتر به لیگ هفتگی راه پیدا می‌کنند» */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nwhat the podium says about the week:');
  await openRank(page, 'cup');
  const note = await page.evaluate(() => {
    const n = document.querySelector('.pod-note');
    if (!n) return null;
    const pod = document.querySelector('.podium');
    return { text: n.innerText.replace(/\n/g, ' '),
             top: Math.round(n.getBoundingClientRect().top),
             podBottom: Math.round(pod.getBoundingClientRect().bottom) };
  });
  ok('there is a line under the podium', !!note, String(note));
  ok('it says the board resets every week', /هر هفته ریست می‌شود/.test(note.text), note.text);
  ok('and that the top players reach the weekly league', /به لیگ هفتگی راه پیدا می‌کنند/.test(note.text), note.text);
  /* Not «به لیگ بالاتر می‌روند» — the wording was corrected. */
  ok('in those words and not the old ones', !/لیگ بالاتر/.test(note.text), note.text);
  /* Under the three people it is about, joined to the floor they stand on. */
  ok('it sits directly under the plinths', Math.abs(note.top - note.podBottom) <= 2, note.top + ' vs ' + note.podBottom);

  /* A board that does NOT reset must not claim to. */
  await openRank(page, 'overall');
  const perm = await page.evaluate(() => ({
    note: !!document.querySelector('.pod-note'),
    podium: !!document.querySelector('.podium')
  }));
  ok('the lifetime board still has a podium', perm.podium === true, String(perm.podium));
  ok('but says nothing about resetting', perm.note === false, String(perm.note));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── AND ON A SHORT PHONE ──────────────────────────────────────────────── */
{
  waitingByTier = {}; posted = []; duelCalls = [];
  const ctx = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5 }));
    localStorage.setItem('pq_user_plan', 'premium');
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p.startsWith('/leaderboards/')) return send({ entries: board });
    if (p === '/invites/incoming') return send({ invites: [] });
    if (p === '/duel-calls') return send({ calls: [] });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  console.log('\non a narrow phone:');
  await openRank(page, 'cup');
  const small = await page.evaluate(() => {
    const pods = [...document.querySelectorAll('.podium .pod')];
    const sec = document.getElementById('rankings');
    return {
      count: pods.length,
      clipped: pods.map((p) => { const n = p.querySelector('.pod-name'); return n.scrollHeight > n.clientHeight + 2 || n.scrollWidth > n.clientWidth + 2; }),
      widest: Math.max(...pods.map((p) => Math.round(p.getBoundingClientRect().width))),
      /* The page may scroll down; it must not scroll sideways. */
      sideways: sec.scrollWidth > sec.clientWidth + 2
    };
  });
  ok('all three still fit', small.count === 3, String(small.count));
  ok('no name is cut off', small.clipped.every((c) => c === false), JSON.stringify(small.clipped));
  ok('and nothing runs off the side of the screen', small.sideways === false, String(small.sideways));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
