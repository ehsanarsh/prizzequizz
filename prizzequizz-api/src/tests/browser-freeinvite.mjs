/* THE FRIENDLY SECTION HAS ONE GAME AND NO TICKETS.
 *
 * «در قسمت دوستانه وقتی از قسمت دوستان دعوت بازی میخوای ارسال کنی میاره آخرین
 * بازمانده یا دوئل — آخرین بازمانده رو انتخاب میکنی میره داخل و با تم آبی با
 * دوست خود با بلیط بازی میکنه. در قسمت دوستانه فقط درخواست دوئل میتونی بدی اونم
 * نه با بلیط بلکه با سکهٔ انتخابی کاربر که بتونه حتی تعداد سکه رو بنویسه و یک
 * قلب.»
 *
 * So: in the friendly plan there is no game to choose between, the sheet asks
 * for a NUMBER OF COINS the player writes themselves, the invite carries that
 * number instead of a ticket tier, and both ends of it — the sender waiting and
 * the friend accepting — arrive at an entry screen that is asking for exactly
 * that many coins and one heart, with no ticket anywhere on it.
 *
 * The prize half is checked too, in the same file, because the whole risk of
 * this change is breaking the half that was working.
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

const posted = [];
let incoming = [];
let inviteStatus = { id: 'inv1', status: 'pending', secondsLeft: 55 };

async function makePage(plan) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((p) => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3 }));
    localStorage.setItem('pq_user_plan', p);
    localStorage.setItem('pq_practice_coins', '400');
  }, plan);
  await ctx.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const pth = url.pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (route.request().method() === 'POST') {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      posted.push({ path: pth, body });
      if (/^\/invites$/.test(pth)) return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { id: 'inv1', status: 'pending' } }) });
      return send({});
    }
    if (pth === '/friends') return send([
      { id: 'u1', username: 'sara', displayName: 'سارا', level: 5, online: true, unread: 0 },
      { id: 'u2', username: 'reza', displayName: 'رضا', level: 7, online: true, unread: 0 }
    ]);
    if (pth === '/friends/requests') return send({ incoming: [], outgoing: [] });
    if (pth === '/last-survivor/topics') return send({
      tickets: { green: { value: 12500 }, blue: { value: 25000 }, red: { value: 50000 } },
      topics: [{ name: 'ورزشی', playable: true, questionCount: 40, icon: '⚽' }] });
    if (pth === '/invites/incoming') return send({ invites: incoming });
    if (/^\/invites\/[^/]+$/.test(pth)) return send(inviteStatus);
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  await page.evaluate(() => { (0, eval)('mTickets={green:2,blue:2,red:2};'); });
  return { ctx, page, errs };
}

const modal = (page) => page.evaluate(() => {
  const ov = document.getElementById('aaaModal');
  return {
    open: !!(ov && ov.classList.contains('show')),
    title: (document.getElementById('aaaTitle') || {}).textContent || '',
    sub: (document.getElementById('aaaSub') || {}).textContent || '',
    subHTML: (document.getElementById('aaaSub') || {}).innerHTML || '',
    primary: (document.getElementById('aaaPrimary') || {}).textContent || ''
  };
});

/* Open the friends list and press «دعوت» on the first friend. */
async function inviteFirstFriend(page) {
  await page.evaluate(() => { (0, eval)("go('friends');"); (0, eval)('friendsLoad')(); });
  await page.waitForTimeout(700);
  const found = await page.evaluate(() => {
    const b = document.querySelector('#friendsContent button[onclick*="inviteFriend"]');
    if (!b) return false; b.click(); return true;
  });
  await page.waitForTimeout(500);
  return found;
}

/* ── 1. THE FRIENDLY INVITE ─────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage('free');
  console.log('inviting a friend in the friendly section:');

  const themed = await page.evaluate(() => (0, eval)("userPlan+'|'+document.querySelector('.phone').classList.contains('theme-free')"));
  ok('the friendly plan is on', themed === 'free|true', themed);

  posted.length = 0;
  ok('the friend row has an invite button', await inviteFirstFriend(page));

  const m = await modal(page);
  /* «فقط درخواست دوئل میتونی بدی» — there is no room to choose. */
  ok('no game chooser appears', !/کدام بازی/.test(m.title), m.title);
  const lsOption = await page.evaluate(() => !!document.querySelector('.pz-inv-mode[data-mode="ls"]'));
  ok('and Last Survivor is not offered at all', lsOption === false, String(lsOption));
  ok('the coin sheet opens instead', /سکه/.test(m.title), m.title);
  /* «نه با بلیط» */
  const tierBtns = await page.evaluate(() => document.querySelectorAll('.pz-inv-tk').length);
  ok('no ticket picker is anywhere near it', tierBtns === 0, String(tierBtns));
  ok('and the sheet says there is no ticket', /بدون بلیط|بلیطی در کار نیست/.test(m.sub), m.sub.slice(0, 90));
  ok('one heart is named as the rest of the entry', /قلب/.test(m.sub), m.sub.slice(0, 90));

  /* «بتونه حتی تعداد سکه رو بنویسه» — a box, not three buttons. */
  const box = await page.evaluate(() => {
    const i = document.getElementById('pzInvCoins');
    return i ? { tag: i.tagName, type: i.getAttribute('type'), val: i.value, min: i.getAttribute('min') } : null;
  });
  ok('there is a box to write the number in', !!box && box.tag === 'INPUT', JSON.stringify(box));
  ok('it takes numbers', !!box && box.type === 'number', box ? box.type : '');
  ok('and it opens on the amount already in use', box.val === '25', box.val);
  ok('nothing is sent while the sheet is still open', posted.filter((x) => x.path === '/invites').length === 0, JSON.stringify(posted));

  /* The chips are a shortcut INTO the box, not a replacement for it. */
  await page.evaluate(() => document.querySelector('.pz-inv-coin[data-n="50"]').click());
  await page.waitForTimeout(150);
  ok('a shortcut chip fills the box', await page.evaluate(() => document.getElementById('pzInvCoins').value) === '50');
  ok('and does not send by itself', posted.filter((x) => x.path === '/invites').length === 0, String(posted.length));

  /* A number that is nobody's preset — the whole point of the box. */
  await page.evaluate(() => { document.getElementById('pzInvCoins').value = '33'; document.getElementById('aaaPrimary').click(); });
  await page.waitForTimeout(700);
  const sent = posted.find((x) => x.path === '/invites');
  ok('sending posts one invite', !!sent, JSON.stringify(posted.map((p) => p.path)));
  ok('to that friend', !!sent && sent.body.toUserId === 'u1', sent ? String(sent.body.toUserId) : '');
  ok('for a duel', !!sent && sent.body.mode === 'duel', sent ? String(sent.body.mode) : '');
  ok('with the number that was typed', !!sent && sent.body.coinStake === 33, sent ? String(sent.body.coinStake) : '');
  ok('and no ticket tier on it', !!sent && !sent.body.ticketTier, sent ? JSON.stringify(sent.body) : '');
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. A NUMBER THAT CANNOT BE PLAYED ──────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage('free');
  console.log('a coin amount that will not do:');
  await page.evaluate(() => (0, eval)('practiceCoins=40;'));
  posted.length = 0;
  await inviteFirstFriend(page);

  const tries = [
    ['empty', ''],
    ['zero', '0'],
    ['more coins than the player owns', '90']
  ];
  for (const [what, v] of tries) {
    await page.evaluate((x) => { document.getElementById('pzInvCoins').value = x; document.getElementById('aaaPrimary').click(); }, v);
    await page.waitForTimeout(350);
    const st = await modal(page);
    ok('refuses ' + what, posted.filter((x) => x.path === '/invites').length === 0, v);
    /* And the sheet stays, so nothing else they chose is thrown away. */
    ok('and keeps the sheet open (' + what + ')', st.open === true, String(st.open));
  }
  /* A SLIPPED KEY, FROM SOMEBODY RICH ENOUGH THAT THE BALANCE WOULD NOT CATCH
     IT. The server caps a stake at ten thousand, so anything above that would
     be sent as one figure and stored as another — the two players would be told
     different numbers. Checked with a balance big enough that this guard is the
     only thing standing in the way. */
  await page.evaluate(() => (0, eval)('practiceCoins=50000;'));
  await page.evaluate(() => { document.getElementById('pzInvCoins').value = '20000'; document.getElementById('aaaPrimary').click(); });
  await page.waitForTimeout(350);
  ok('refuses more than the server would keep', posted.filter((x) => x.path === '/invites').length === 0, '20000');
  ok('and keeps the sheet open (over the cap)', (await modal(page)).open === true);

  /* The real one still goes. */
  await page.evaluate(() => { document.getElementById('pzInvCoins').value = '40'; document.getElementById('aaaPrimary').click(); });
  await page.waitForTimeout(600);
  ok('a number they can afford goes through', posted.filter((x) => x.path === '/invites').length === 1, String(posted.length));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE SENDER, WHEN IT IS ACCEPTED ─────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage('free');
  console.log('the sender walks in for the amount they arranged:');
  inviteStatus = { id: 'inv1', status: 'pending', secondsLeft: 55 };
  posted.length = 0;
  await inviteFirstFriend(page);
  await page.evaluate(() => { document.getElementById('pzInvCoins').value = '33'; document.getElementById('aaaPrimary').click(); });
  await page.waitForTimeout(600);
  ok('the wait sheet is up', /منتظر جواب/.test((await modal(page)).title));

  inviteStatus = { id: 'inv1', status: 'accepted', secondsLeft: 40 };
  await page.waitForTimeout(3200);

  const seen = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id || '',
    stake: (0, eval)('practiceCoinStake'),
    note: (document.getElementById('mePlanNote') || {}).textContent || '',
    btn: (document.getElementById('meStartBtn') || {}).textContent || '',
    ticketCard: (() => { const c = document.getElementById('ticketSelectCard'); return c ? getComputedStyle(c).display : 'none'; })(),
    chip: (() => { const a = document.querySelector('#coinStakeGrid .tab.active'); return a ? a.textContent.trim() : ''; })()
  }));
  ok('they land on the entry screen', seen.screen === 'mode-entry', seen.screen);
  ok('for the number they arranged', seen.stake === 33, String(seen.stake));
  /* «۳۳» in Persian digits — the screen must not be quoting some other figure. */
  ok('the start button says one heart and that many coins', /۳۳/.test(seen.btn) && /قلب/.test(seen.btn), seen.btn);
  ok('the note says the same', /۳۳/.test(seen.note), seen.note.slice(0, 80));
  ok('the amount is the one highlighted', /۳۳/.test(seen.chip), seen.chip);
  /* «نه با بلیط» — the ticket counter is not on this screen. */
  ok('and there is no ticket counter', seen.ticketCard === 'none', seen.ticketCard);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE FRIEND WHO IS ASKED ─────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage('free');
  console.log('the friend on the other end:');
  incoming = [{ id: 'inv9', fromName: 'سارا', fromUserId: 'u1', mode: 'duel', ticketTier: '', coinStake: 33, roomId: '', roomTopic: '', status: 'pending', secondsLeft: 50 }];
  posted.length = 0;
  await page.evaluate(() => { (0, eval)("go('home');"); (0, eval)('pzInvitePoll')(); });
  await page.waitForTimeout(900);

  const ask = await modal(page);
  ok('the invite is put in front of them', ask.open === true, ask.title);
  ok('named as a friendly duel', /دوستانه/.test(ask.sub), ask.sub.slice(0, 80));
  ok('quoted in coins and a heart', /۳۳/.test(ask.sub) && /قلب/.test(ask.sub), ask.sub.slice(0, 80));
  ok('with no ticket named', !/بلیط\s*(طلایی|نقره|برنز)/.test(ask.sub) && !/تومان/.test(ask.sub), ask.sub.slice(0, 100));

  await page.evaluate(() => document.getElementById('aaaPrimary').click());
  await page.waitForTimeout(1200);
  const answered = posted.find((x) => /respond/.test(x.path));
  ok('accepting answers the server', !!answered && answered.body.accept === true, JSON.stringify(answered || {}));
  const landed = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id || '',
    stake: (0, eval)('practiceCoinStake'),
    plan: (0, eval)('userPlan'),
    btn: (document.getElementById('meStartBtn') || {}).textContent || '',
    ticketCard: (() => { const c = document.getElementById('ticketSelectCard'); return c ? getComputedStyle(c).display : 'none'; })()
  }));
  ok('they land on the entry screen too', landed.screen === 'mode-entry', landed.screen);
  ok('still in the friendly half', landed.plan === 'free', landed.plan);
  ok('playing for the same number of coins', landed.stake === 33, String(landed.stake));
  ok('their button says so', /۳۳/.test(landed.btn), landed.btn);
  ok('and no ticket counter for them either', landed.ticketCard === 'none', landed.ticketCard);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. A COIN INVITE REACHING SOMEBODY IN THE PRIZE HALF ───────────────── */
{
  const { ctx, page, errs } = await makePage('premium');
  console.log('a friendly invite arriving in the prize half:');
  incoming = [{ id: 'inv8', fromName: 'سارا', fromUserId: 'u1', mode: 'duel', ticketTier: '', coinStake: 20, roomId: '', roomTopic: '', status: 'pending', secondsLeft: 50 }];
  posted.length = 0;
  await page.evaluate(() => { (0, eval)("go('home');"); (0, eval)('pzInvitePoll')(); });
  await page.waitForTimeout(900);

  const ask = await modal(page);
  /* Not a surprise: the change of half is on the sheet, before the tap. */
  ok('the sheet says they will move to the friendly section', /حالت دوستانه می‌روی/.test(ask.sub), ask.sub.slice(0, 140));
  await page.evaluate(() => document.getElementById('aaaPrimary').click());
  await page.waitForTimeout(1200);
  const landed = await page.evaluate(() => ({
    plan: (0, eval)('userPlan'),
    themed: document.querySelector('.phone').classList.contains('theme-free'),
    stake: (0, eval)('practiceCoinStake'),
    ticketCard: (() => { const c = document.getElementById('ticketSelectCard'); return c ? getComputedStyle(c).display : 'none'; })()
  }));
  /* The two of them must be paying the same thing — one on coins and one on a
     ticket is the very mix-up this batch is about. */
  ok('they are moved to the friendly half', landed.plan === 'free', landed.plan);
  ok('and the screen is the friendly one', landed.themed === true, String(landed.themed));
  ok('for the coins that were arranged', landed.stake === 20, String(landed.stake));
  ok('so no ticket is asked of them', landed.ticketCard === 'none', landed.ticketCard);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. THE PRIZE HALF IS UNTOUCHED ─────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage('premium');
  console.log('the prize half still works the way it did:');
  incoming = [];
  posted.length = 0;
  await inviteFirstFriend(page);
  const m = await modal(page);
  ok('the game chooser still comes first', /کدام بازی/.test(m.title), m.title);
  const modes = await page.evaluate(() => [...document.querySelectorAll('.pz-inv-mode')].map((b) => b.getAttribute('data-mode')));
  ok('with both games on it', modes.join(',') === 'duel,ls', modes.join(','));

  await page.evaluate(() => document.querySelector('.pz-inv-mode[data-mode="duel"]').click());
  await page.waitForTimeout(500);
  const pick = await modal(page);
  ok('a duel still asks which ticket', /بلیط/.test(pick.title), pick.title);
  const coinBox = await page.evaluate(() => !!document.getElementById('pzInvCoins'));
  ok('and never asks for coins', coinBox === false, String(coinBox));

  await page.evaluate(() => document.querySelector('.pz-inv-tk[data-tk="blue"]').click());
  await page.waitForTimeout(600);
  const sent = posted.find((x) => x.path === '/invites');
  ok('the invite carries the tier', !!sent && sent.body.ticketTier === 'blue', JSON.stringify(sent && sent.body));
  ok('and carries no coin stake', !!sent && !sent.body.coinStake, JSON.stringify(sent && sent.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
