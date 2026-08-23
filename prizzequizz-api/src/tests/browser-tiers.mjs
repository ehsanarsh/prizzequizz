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
  ok('and the ticket that reaches them', /بلیط آبی/.test(sheet.sub), sheet.sub.slice(0, 90));
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
