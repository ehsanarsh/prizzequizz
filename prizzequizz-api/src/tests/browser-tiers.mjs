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
/* What the server has waiting for this player, and what this player sent it.
   Both are read by the «حریفت ادامه داد» cases at the bottom. */
let duelCalls = [];
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
    if (p === '/duel-calls' && route.request().method() === 'GET') return send({ calls: duelCalls });
    if (p === '/invites/incoming') return send({ invites: [] });
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
