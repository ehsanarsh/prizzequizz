/* INVITING SOMEBODY TO PLAY, FROM THE SCREENS IT IS SENT FROM.
 *
 *   • «در قسمت افراد آنلاین باید کاربر بتونه درخواست بازی بده و نوع بلیط رو
 *     مشخص کنی» — and only to people who are actually free.
 *   • «جلوی تیتر اتاق انتظار یه دکمه با رنگ زرد: افزودن افراد آنلاین به این
 *     اتاق» — and the list it opens must refuse anyone mid-match.
 *   • «مودال باید فقط با دو دکمه قبول و رد بسته بشه» — a finger landing beside
 *     the sheet was answering for the player.
 *   • «در افراد آنلاین باید عکس کاراکتر باشه» and the same face beside every
 *     line of Last Survivor chat.
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
const CHAR = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="#c33"/></svg>').toString('base64');
const PHOTO = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#39c"/></svg>').toString('base64');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

/* The server's word on who is free — the client must not decide this itself. */
let onlinePlayers = [];
const posted = [];
/* What the sender's poll gets back while they wait. */
let inviteStatus = { id: 'inv1', status: 'pending', secondsLeft: 55 };
/* Flipped on to make the next entry fail the way a real one fails: no ticket. */
let joinFails = false;

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 500, hearts: 5 }));
  });
  await ctx.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (route.request().method() === 'POST') {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      posted.push({ path: p, body });
      if (/^\/invites$/.test(p)) return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { id: 'inv1', status: 'pending' } }) });
      if (p === '/last-survivor/rooms') return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { roomId: 'R-PRIV', topic: body.topic, isPrivate: true, startsAt: Date.now() + 90000, capacity: 20, minUsers: 2 } }) });
      if (p === '/last-survivor/join' && joinFails) return route.fulfill({ status: 409, contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: { code: 'NO_TICKET', message: 'بلیط سبز نداری.', status: 409 } }) });
      if (p === '/last-survivor/join') return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { room: { id: body.roomId || 'R-PUB', topic: body.topic, status: 'waiting', phase: 'waiting', round: 0,
          totalRounds: 12, capacity: 20, startsAt: Date.now() + 60000, phaseEndsAt: 0, serverNow: Date.now(), grossPool: 12500, chatEnabled: true, forfeited: 0 },
          players: [], me: { userId: 'me', status: 'waiting', shields: 0, units: 1, lifelinesUsed: [] },
          stats: { alive: 1, eliminated: 0, cashedOut: 0, totalPlayers: 1, grossPot: 12500, remainingPot: 12500, paidOut: 0 }, question: null, votes: 0 } }) });
      return send({});
    }
    /* TICKETS IN HAND. «باید فرستنده بلیط داشته باشه تا بتونه با اون بلیط دعوت
       کنه» — an invitation is a promise to play for that stake, so a player
       with an empty wallet cannot send one at all. Every case below is about
       somebody who CAN invite, which means somebody who owns tickets. */
    if (p === '/wallet') return send({ available: 0, locked: 0, tickets: { green: 2, blue: 2, red: 2, bronze: 0, silver: 0, gold: 0 } });
    if (p === '/users/online') return send({ players: onlinePlayers, onlineTotal: onlinePlayers.length, nextCost: 0, freeLeft: 3, coins: 500 });
    /* The room poll answers with a real snapshot. The server's own route 404s
       when there is no room rather than handing back an empty object, so a stub
       that returns `{}` here is testing a reply the game never sends. */
    if (/^\/last-survivor\/rooms\/[^/]+$/.test(p)) {
      const rid = p.split('/').pop();
      const now = Date.now();
      return send({ room: { id: rid, topic: 'ورزشی', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12,
        capacity: 20, startsAt: now + 60000, phaseEndsAt: 0, serverNow: now, grossPool: 12500, chatEnabled: true, forfeited: 0 },
        players: [{ userId: 'me', username: 'احسان', avatar: '', character: null, color: 'green', status: 'waiting', shields: 0, units: 1 }],
        me: { userId: 'me', username: 'احسان', status: 'waiting', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
        stats: { alive: 1, eliminated: 0, cashedOut: 0, totalPlayers: 1, grossPot: 12500, remainingPot: 12500, paidOut: 0 },
        question: null, votes: 0 });
    }
    if (p === '/last-survivor/topics') return send({
      tickets: { green: { value: 12500 }, blue: { value: 25000 }, red: { value: 50000 } },
      topics: [{ name: 'ورزشی', playable: true, questionCount: 40, icon: '⚽' },
               { name: 'تاریخ', playable: true, questionCount: 25, icon: '🏛️' },
               { name: 'قفل', playable: false, questionCount: 0, icon: '🔒' }] });
    if (p === '/invites/incoming') return send({ invites: [] });
    if (/^\/invites\/[^/]+$/.test(p)) return send(inviteStatus);
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
    dismissible: ov ? ov.dataset.dismissible : '',
    title: (document.getElementById('aaaTitle') || {}).textContent || '',
    primary: (document.getElementById('aaaPrimary') || {}).textContent || '',
    secondary: (document.getElementById('aaaSecondary') || {}).textContent || '',
    primaryCls: (document.getElementById('aaaPrimary') || {}).className || '',
    secondaryCls: (document.getElementById('aaaSecondary') || {}).className || ''
  };
});

/* ── 1. THE ONLINE LIST ─────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the online list:');
  onlinePlayers = [
    { userId: 'u1', username: 'سارا', level: 5, avatar: PHOTO, character: { id: 'c1', name: 'پهلوان', image: CHAR, kind: 'normal' }, inMatch: false, invitePending: false, canInvite: true },
    { userId: 'u2', username: 'رضا', level: 7, avatar: PHOTO, character: null, inMatch: true, invitePending: false, canInvite: false },
    { userId: 'u3', username: 'مینا', level: 2, avatar: PHOTO, character: null, inMatch: false, invitePending: true, canInvite: false }
  ];
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('online'); onlineLoad(false);"));
  await page.waitForTimeout(900);

  const rows = await page.evaluate(() => [...document.querySelectorAll('#onList .online-card')].map((c) => ({
    name: (c.querySelector('.nm') || {}).textContent || '',
    lv: (c.querySelector('.lv') || {}).textContent || '',
    img: (c.querySelector('.av img') || {}).getAttribute?.('src') || '',
    invite: !!c.querySelector('button[onclick*="onlineInvite"]')
  })));
  ok('everyone online is listed', rows.length === 3, JSON.stringify(rows.map((r) => r.name)));
  /* «باید عکس کاراکتر باشه نه عکس دیگه‌ای» */
  ok('a player with a character is drawn with it, not their photo', rows[0].img.length > 40 && rows[0].img !== '', rows[0].img.slice(0, 30));
  ok('and it really is the character image', await page.evaluate((c) => (document.querySelector('#onList .online-card .av img') || {}).src === c, CHAR), 'character');

  ok('somebody free can be challenged', rows[0].invite === true, String(rows[0].invite));
  /* «دکمه دعوت به بازی سبز باشه» */
  const green = await page.evaluate(() => {
    const b = document.querySelector('#onList .online-card button[onclick*="onlineInvite"]');
    return b ? getComputedStyle(b).backgroundImage + '|' + getComputedStyle(b).backgroundColor : '';
  });
  ok('and the challenge button is green', /61,\s*220,\s*132|3ddc84|31,\s*157,\s*85/i.test(green), green.slice(0, 70));
  /* «فقط به افرادی که داخل هیچ مسابقه‌ای نشده‌اند» */
  ok('somebody mid-match cannot', rows[1].invite === false, String(rows[1].invite));
  ok('and the row says why', /مسابقه/.test(rows[1].lv), rows[1].lv);
  ok('nor can somebody who already has an invite waiting', rows[2].invite === false, String(rows[2].invite));
  ok('which the row also says', /دعوت/.test(rows[2].lv), rows[2].lv);

  /* «در هنگام ارسال درخواست بازی باید نوع بلیط رو مشخص کنی و ارسال کنی» */
  posted.length = 0;
  await page.evaluate(() => { document.querySelector('#onList .online-card button[onclick*="onlineInvite"]').click(); });
  await page.waitForTimeout(500);
  const pick = await modal(page);
  ok('challenging opens the ticket picker first', /بلیط/.test(pick.title), pick.title);
  const tiers = await page.evaluate(() => [...document.querySelectorAll('.pz-inv-tk')].map((b) => b.getAttribute('data-tk')));
  ok('with every tier on it', tiers.join(',') === 'green,blue,red', tiers.join(','));
  ok('and nothing is sent before one is chosen', posted.length === 0, JSON.stringify(posted));

  await page.evaluate(() => { document.querySelector('.pz-inv-tk[data-tk="blue"]').click(); });
  await page.waitForTimeout(600);
  const sent = posted.find((x) => x.path === '/invites');
  ok('picking a tier sends the invite', !!sent, JSON.stringify(posted));
  ok('to that player', !!sent && sent.body.toUserId === 'u1', sent ? sent.body.toUserId : '');
  ok('for a duel, at the tier chosen', !!sent && sent.body.mode === 'duel' && sent.body.ticketTier === 'blue', JSON.stringify(sent && sent.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE WAITING ROOM'S YELLOW BUTTON ────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the Last Survivor waiting room:');
  onlinePlayers = [
    { userId: 'u1', username: 'سارا', level: 5, avatar: PHOTO, character: { id: 'c1', name: 'پهلوان', image: CHAR, kind: 'normal' }, inMatch: false, invitePending: false, canInvite: true },
    { userId: 'u2', username: 'رضا', level: 7, avatar: PHOTO, character: null, inMatch: true, invitePending: false, canInvite: false }
  ];
  await page.evaluate(() => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsRoomId='R9'; lsSnap=null; lsLastKey=''; lsWatching=false; go('lsGame');");
    const now = Date.now();
    (0, eval)('lsRender')({
      room: { id: 'R9', topic: 'ورزشی', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12, capacity: 20,
              startsAt: now + 90000, phaseEndsAt: 0, serverNow: now, grossPool: 250000, chatEnabled: true, forfeited: 0 },
      players: [{ userId: 'me', username: 'احسان', avatar: '', character: null, color: 'green', status: 'alive', shields: 0, units: 1 }],
      me: { userId: 'me', username: 'احسان', status: 'alive', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
      stats: { alive: 1, eliminated: 0, cashedOut: 0, totalPlayers: 1, grossPot: 250000, remainingPot: 250000, paidOut: 0 },
      question: null, votes: 0
    });
  });
  await page.waitForTimeout(700);

  const btn = await page.evaluate(() => {
    const b = document.querySelector('#lsBody .ls-invite-btn');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const ttl = document.querySelector('#lsBody .ls-ttl h1');
    return { text: b.textContent.trim(), bg: cs.backgroundImage + cs.backgroundColor,
             nextToTitle: !!ttl && Math.abs(b.getBoundingClientRect().top - ttl.getBoundingClientRect().top) < 60 };
  });
  ok('the room has an add-people button', !!btn, JSON.stringify(btn));
  ok('named for what it does', /افزودن افراد آنلاین/.test(btn.text), btn.text);
  /* «با رنگ زرد» — the game's own yellow. */
  ok('and it is yellow', /255,\s*210,\s*31|#FFD21F/i.test(btn.bg), btn.bg.slice(0, 60));
  ok('sitting up by the title', btn.nextToTitle, String(btn.nextToTitle));

  await page.evaluate(() => (0, eval)('lsInviteOpen')());
  await page.waitForTimeout(900);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#lsInvList .pz-inv-row')].map((r) => ({
    name: (r.querySelector('.n') || {}).textContent || '',
    go: !!r.querySelector('button.go'),
    img: (r.querySelector('.f img') || {}).getAttribute?.('src') || ''
  })));
  ok('it opens the list of who is online', rows.length === 2, JSON.stringify(rows.map((r) => r.name)));
  ok('the free one can be added', rows[0].go === true, String(rows[0].go));
  ok('and shows their character', rows[0].img === CHAR, rows[0].img.slice(0, 30));
  /* «نه اونایی که داخل مسابقه هستند» */
  ok('the one mid-match cannot be added', rows[1].go === false, String(rows[1].go));
  ok('and the row says so', /مسابقه/.test(rows[1].name), rows[1].name.replace(/\s+/g, ' '));

  posted.length = 0;
  await page.evaluate(() => { document.querySelector('#lsInvList button.go').click(); });
  await page.waitForTimeout(700);
  const sent = posted.find((x) => x.path === '/invites');
  ok('adding somebody invites them to THIS room', !!sent && sent.body.mode === 'ls' && sent.body.roomId === 'R9', JSON.stringify(sent && sent.body));
  ok('and says which room it came from, so the room cannot pile on', !!sent && sent.body.fromRoomId === 'R9', JSON.stringify(sent && sent.body.fromRoomId));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE INVITE THAT ARRIVES ─────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('an invite arriving:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(400);
  await page.evaluate(() => (0, eval)('pzInviteAsk')({ id: 'inv9', fromName: 'سارا', mode: 'duel', ticketTier: 'blue' }));
  await page.waitForTimeout(500);

  const m = await modal(page);
  ok('it asks with a modal', m.open, JSON.stringify(m));
  ok('naming who sent it', /سارا/.test(m.title), m.title);
  ok('with an accept button', /پذیرفتن/.test(m.primary), m.primary);
  ok('and a refuse button', /رد/.test(m.secondary), m.secondary);
  ok('the accept one green', /btn-green/.test(m.primaryCls), m.primaryCls);
  ok('the refuse one red', /btn-red/.test(m.secondaryCls), m.secondaryCls);
  /* «انگشتت به اطراف مودال که تاچ میشه، مودال بدون قبول یا رد میره» */
  ok('and no way out except those two', m.dismissible === '0', m.dismissible);

  const stuck = await page.evaluate(async () => {
    const ov = document.getElementById('aaaModal');
    ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return ov.classList.contains('show');
  });
  ok('tapping beside it does not answer for the player', stuck === true, String(stuck));

  posted.length = 0;
  await page.evaluate(async () => {
    document.getElementById('aaaPrimary').click();
    await new Promise((r) => setTimeout(r, 1200));
  });
  const answer = posted.find((x) => /\/invites\/inv9\/respond/.test(x.path));
  ok('accepting answers the server', !!answer && answer.body.accept === true, JSON.stringify(answer));
  await page.waitForTimeout(900);
  const where = await page.evaluate(() => ({
    screen: [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id,
    tier: (0, eval)('selectedTicket'),
    held: (0, eval)('duelTicket')
  }));
  /* «اگه گیرنده بلیط داشت مستقیم وارد رادار و روم بازی میشه، دیگه انتخاب بلیط
     رو نمیبینه» — the ticket was agreed when the invitation was sent and they
     hold one, so there is nothing left to choose and no screen to choose it on. */
  ok('and takes them straight to the radar', where.screen === 'matchmaking', JSON.stringify(where));
  ok('on the tier the sender picked', where.tier === 'blue', String(where.tier));
  ok('spending that ticket', where.held === 'blue', String(where.held));
  /* The accepter's half of the arrangement. Without the key they walk into the
     open queue and are handed to whichever stranger is searching — which is
     exactly the report: the two who agreed never meet. It is SPENT at the
     enqueue, so the request is what proves it travelled. */
  const enqA = posted.filter((x) => /matchmaking\/enqueue/.test(x.path)).pop();
  ok('and carrying the invite as their private pairing key', !!enqA && enqA.body.pairKey === 'inv9', JSON.stringify(enqA && enqA.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. REFUSING IT ─────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('refusing one:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(400);
  await page.evaluate(() => (0, eval)('pzInviteAsk')({ id: 'inv8', fromName: 'رضا', mode: 'ls', roomId: 'R3' }));
  await page.waitForTimeout(500);
  posted.length = 0;
  await page.evaluate(async () => { document.getElementById('aaaSecondary').click(); await new Promise((r) => setTimeout(r, 500)); });
  const answer = posted.find((x) => /\/invites\/inv8\/respond/.test(x.path));
  ok('the server is told it was refused', !!answer && answer.body.accept === false, JSON.stringify(answer));
  const stayed = await page.evaluate(() => [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id);
  ok('and the player is not dragged anywhere', stayed === 'home', stayed);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. THE PERMISSION SHEET, WHICH HAD THE SAME FAULT ──────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the notification-permission sheet:');
  await page.evaluate(() => {
    Object.defineProperty(window, 'Notification', { configurable: true, value: Object.assign(function () {}, { permission: 'default', requestPermission: () => Promise.resolve('default') }) });
  });
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home'); try{sessionStorage.removeItem('pz_push_asked_visit');}catch(e){}"));
  await page.waitForTimeout(300);
  await page.evaluate(() => (0, eval)('pzAskPushOnInstall')());
  await page.waitForTimeout(500);
  const m = await modal(page);
  ok('it opens', m.open, JSON.stringify(m));
  ok('and can no longer be dismissed by a stray tap', m.dismissible === '0', m.dismissible);
  const stuck = await page.evaluate(async () => {
    const ov = document.getElementById('aaaModal');
    ov.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return ov.classList.contains('show');
  });
  ok('a finger beside it leaves it standing', stuck === true, String(stuck));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. FACES IN THE ROOM'S CHAT ────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('Last Survivor chat:');
  await ctx.route('**/v1/last-survivor/rooms/*/chat', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, data: { messages: [
      { userId: 'p1', username: 'سارا', body: 'سلام', createdAt: Date.now() },
      { userId: 'me', username: 'احسان', body: 'سلام به تو', createdAt: Date.now() }
    ] } })
  }));
  await page.evaluate((c) => { window.__CHAR = c; }, CHAR);
  await page.evaluate(() => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsRoomId='R9'; lsMyId='me'; lsSnap=null; lsLastKey=''; go('lsGame');");
    const now = Date.now();
    (0, eval)('lsRender')({
      room: { id: 'R9', topic: 'ورزشی', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12, capacity: 20,
              startsAt: now + 90000, phaseEndsAt: 0, serverNow: now, grossPool: 250000, chatEnabled: true, forfeited: 0 },
      players: [
        { userId: 'p1', username: 'سارا', avatar: '', character: { id: 'c1', name: 'پهلوان', image: window.__CHAR, kind: 'normal' }, color: 'green', status: 'alive', shields: 0, units: 1 },
        { userId: 'me', username: 'احسان', avatar: '', character: null, color: 'blue', status: 'alive', shields: 0, units: 1 }
      ],
      me: { userId: 'me', username: 'احسان', status: 'alive', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
      stats: { alive: 2, eliminated: 0, cashedOut: 0, totalPlayers: 2, grossPot: 250000, remainingPot: 250000, paidOut: 0 },
      question: null, votes: 0
    });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => (0, eval)('lsLoadChat')());
  await page.waitForTimeout(700);

  const msgs = await page.evaluate(() => [...document.querySelectorAll('#lsChatList .ls-msg')].map((m) => ({
    text: (m.textContent || '').replace(/\s+/g, ' ').trim(),
    face: !!m.querySelector('.ls-msg-face'),
    hasImg: !!m.querySelector('.ls-msg-face img, .ls-msg-face .mascot, .ls-msg-face svg')
  })));
  ok('the messages are there', msgs.length === 2, JSON.stringify(msgs.map((m) => m.text)));
  /* «کنار اسم و متن، عکس کاربر هم باشه» */
  ok('each one carries a face beside the name', msgs.every((m) => m.face), JSON.stringify(msgs));
  ok('and the face is drawn, not an empty box', msgs[0].hasImg, JSON.stringify(msgs[0]));
  ok('the name and body are still there', /سارا/.test(msgs[0].text) && /سلام/.test(msgs[0].text), msgs[0].text);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 7. THE SENDER IS TAKEN TO THE SAME GAME ────────────────────────────
   «فرستنده با گیرنده وصل نمیشن — فقط درخواست ارسال میشه و کاربر به رادار میره
    و اگه در اون لحظه شخص دیگری هم جستجوی حریف بزنه با اون مچ میشه». */
{
  const { ctx, page, errs } = await makePage();
  console.log('the sender waiting for an answer:');
  onlinePlayers = [{ userId: 'u1', username: 'سارا', level: 5, avatar: PHOTO, character: null, inMatch: false, invitePending: false, canInvite: true }];
  inviteStatus = { id: 'inv1', status: 'pending', secondsLeft: 55 };
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('online'); onlineLoad(false);"));
  await page.waitForTimeout(800);

  posted.length = 0;
  await page.evaluate(() => { document.querySelector('#onList .online-card button[onclick*="onlineInvite"]').click(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelector('.pz-inv-tk[data-tk="green"]').click(); });
  await page.waitForTimeout(900);

  const waiting = await modal(page);
  ok('the sender is held on a «waiting» sheet, not dropped', /منتظر جواب/.test(waiting.title), waiting.title);
  const stillHome = await page.evaluate(() => [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id);
  ok('and is not sent searching before there is an answer', stillHome === 'online', stillHome);

  /* The other side accepts. */
  inviteStatus = { id: 'inv1', status: 'accepted', secondsLeft: 40 };
  await page.waitForTimeout(3200);
  const landed = await page.evaluate(() => ({
    screen: [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id,
    tier: (0, eval)('selectedTicket'),
    held: (0, eval)('duelTicket'),
    lock: (0, eval)('_pzInviteTier')
  }));
  /* The sender walks the same walk as the person who accepted. Their side used
     to be dropped on the entry screen with the tier they had just invited with
     SHUT — nothing told that screen an arrangement was in force, so it judged
     the tier by the open queue, found it empty, and put them back on green
     while the other one stood on blue. */
  ok('once accepted, the sender goes straight to the radar too', landed.screen === 'matchmaking', JSON.stringify(landed));
  ok('at the tier they offered', landed.tier === 'green', String(landed.tier));
  ok('the arrangement locks their screen too', landed.lock === 'green', String(landed.lock));
  ok('spending that ticket', landed.held === 'green', String(landed.held));
  /* THE POINT: the pair carry the same private key, so the queue can only put
     them together — a stranger searching at that moment cannot take the seat. */
  const enq = posted.filter((x) => /matchmaking\/enqueue/.test(x.path)).pop();
  ok('carrying the invite as a private pairing key', !!enq && enq.body.pairKey === 'inv1', JSON.stringify(enq && enq.body));
  const spent = await page.evaluate(() => (0, eval)('pzPairKey'));
  ok('the key is spent once, so it cannot capture the next ordinary search', spent === null, String(spent));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── FROM THE FRIENDS LIST ──────────────────────────────────────────────── */
/* «در قسمت دوستان هم دعوت به بازی داشته باشیم» — the same real invite, from
   the list where you already know the person. */
{
  const { ctx, page, errs } = await makePage();
  console.log('inviting a friend from the friends list:');
  const seed = (online) => page.evaluate((on) => {
    const D = (0, eval)('FRIENDS_DATA');
    D.length = 0;
    D.push({ id: 'u-sara', a: '', ch: null, n: 'سارا', u: 'sara', lvl: 4, on: on, seen: null,
             unread: 0, fav: false, s: 'دیروز', league: 'سطح ۴', last: '', m: [] });
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; frActiveChat=null; frActiveTab='friends'; go('friends');");
    (0, eval)('renderFriendsHub')();
  }, online);

  await seed(true);
  await page.waitForTimeout(400);
  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#friendsContent .friend-card .btn')].find((x) => /دعوت/.test(x.textContent));
    if (!b) return null;
    return { text: b.textContent.trim(), green: b.className.indexOf('btn-green') >= 0 };
  });
  ok('there is an invite button on a friend’s row', !!btn, JSON.stringify(btn));
  ok('and it is green', btn.green, btn.className);

  posted.length = 0;
  await page.evaluate(() => (0, eval)('inviteFriend')('u-sara'));
  await page.waitForTimeout(500);
  /* «اول مود بازی‌ها بیاد انتخاب کنی» — the game comes before the ticket. */
  const modes = await page.evaluate(() => [...document.querySelectorAll('.pz-inv-mode')].map((b) => b.getAttribute('data-mode')));
  ok('it asks which game first', modes.length === 2, modes.join(','));
  ok('a duel', modes.indexOf('duel') >= 0, modes.join(','));
  ok('or Last Survivor', modes.indexOf('ls') >= 0, modes.join(','));
  ok('and nothing is sent while it is still asking', posted.length === 0, JSON.stringify(posted));

  await page.evaluate(() => document.querySelector('.pz-inv-mode[data-mode="duel"]').click());
  await page.waitForTimeout(500);
  const tiers = await page.evaluate(() => [...document.querySelectorAll('.pz-inv-tk')].map((b) => b.getAttribute('data-tk')));
  /* «نوع بلیط رو مشخص کنی» — it must ask, not assume. */
  ok('picking a duel then asks which ticket', tiers.length > 0, tiers.join(','));
  ok('and still nothing sent', posted.length === 0, JSON.stringify(posted));

  await page.evaluate(() => { const b = document.querySelector('.pz-inv-tk[data-tk="green"]') || document.querySelector('.pz-inv-tk'); b.click(); });
  await page.waitForTimeout(600);
  const sent = posted.find((x) => x.path === '/invites');
  ok('picking one sends a real invite to the server', !!sent, JSON.stringify(posted));
  ok('addressed to that friend', !!sent && sent.body.toUserId === 'u-sara', JSON.stringify(sent && sent.body));
  ok('for a duel, with the tier that was picked', !!sent && sent.body.mode === 'duel' && !!sent.body.ticketTier, JSON.stringify(sent && sent.body));

  /* An invite lives sixty seconds; somebody who is not there cannot answer it. */
  await page.evaluate(() => { try { (0, eval)('closeAaaModal')(false); } catch (e) {} });
  await seed(false);
  await page.waitForTimeout(300);
  posted.length = 0;
  await page.evaluate(() => (0, eval)('inviteFriend')('u-sara'));
  await page.waitForTimeout(400);
  const offline = await page.evaluate(() => ({
    asked: document.querySelectorAll('.pz-inv-tk').length,
    said: (document.getElementById('pzToast') || {}).textContent || ''
  }));
  ok('an offline friend is not invited into a minute they cannot answer', posted.length === 0 && offline.asked === 0, JSON.stringify(offline));
  ok('and the player is told why', /آنلاین نیست/.test(offline.said), offline.said);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── A ROOM OF YOUR OWN ──────────────────────────────────────────────────── */
/* «اگه آخرین بازمانده رو انتخاب کردی بتونی روم اختصاصی داشته باشی و بتونی
   دوستانت رو به بازی دعوت کنی.» */
{
  const { ctx, page, errs } = await makePage();
  console.log('asking a friend into a private room:');
  await page.evaluate(() => {
    const D = (0, eval)('FRIENDS_DATA');
    D.length = 0;
    D.push({ id: 'u-sara', a: '', ch: null, n: 'سارا', u: 'sara', lvl: 4, on: true, seen: null,
             unread: 0, fav: false, s: '', league: '', last: '', m: [] });
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; frActiveChat=null; frActiveTab='friends'; go('friends');");
    (0, eval)('renderFriendsHub')();
  });
  await page.waitForTimeout(400);
  posted.length = 0;
  await page.evaluate(() => (0, eval)('inviteFriend')('u-sara'));
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('.pz-inv-mode[data-mode="ls"]').click());
  await page.waitForTimeout(800);

  const topics = await page.evaluate(() => [...document.querySelectorAll('.pz-inv-topic')].map((b) => b.getAttribute('data-t')));
  ok('it asks which topic the room is for', topics.length > 0, topics.join(' / '));
  /* A topic with nothing behind it is not a room anybody can play. */
  ok('and only offers ones the game can play', topics.indexOf('قفل') < 0 && topics.every(Boolean), topics.join(' / '));
  ok('nothing sent yet', posted.length === 0, JSON.stringify(posted));

  await page.evaluate(() => document.querySelector('.pz-inv-topic').click());
  await page.waitForTimeout(900);

  const made = posted.find((x) => x.path === '/last-survivor/rooms');
  ok('picking one opens a private room on the server', !!made, JSON.stringify(posted.map((p) => p.path)));
  ok('for that topic', !!made && made.body.topic === topics[0], JSON.stringify(made && made.body));

  const inv = posted.find((x) => x.path === '/invites');
  ok('and the friend is invited into it', !!inv, JSON.stringify(inv && inv.body));
  ok('as a Last Survivor invite, not a duel', !!inv && inv.body.mode === 'ls', JSON.stringify(inv && inv.body));
  ok('carrying the room that was just made', !!inv && inv.body.roomId === 'R-PRIV', JSON.stringify(inv && inv.body));
  /* The room is what locks everybody else out of asking the same person. */
  ok('and the room it was sent from', !!inv && inv.body.fromRoomId === 'R-PRIV', JSON.stringify(inv && inv.body));

  const landed = await page.evaluate(() => ({
    screen: [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id,
    topic: (0, eval)('lsEntryTopic'),
    room: (0, eval)('lsInviteRoom')
  }));
  ok('the owner is taken to their own room’s ticket screen', landed.screen === 'lsEntry', JSON.stringify(landed));
  ok('for the topic they chose', landed.topic === topics[0], String(landed.topic));
  ok('and will be put in that room, not another one', landed.room === 'R-PRIV', String(landed.room));

  /* THE POINT OF THE WHOLE THING: paying takes them into THAT room. */
  posted.length = 0;
  await page.evaluate(async () => { await (0, eval)('lsDoJoin')((0, eval)('lsEntryTopic'), 'green'); await new Promise((r) => setTimeout(r, 400)); });
  const joined = posted.find((x) => x.path === '/last-survivor/join');
  ok('and the entry names the room', !!joined && joined.body.roomId === 'R-PRIV', JSON.stringify(joined && joined.body));
  const spent = await page.evaluate(() => (0, eval)('lsInviteRoom'));
  ok('the room is spent once, so the next ordinary game is not hijacked', spent === null, String(spent));

  /* A FAILED ENTRY MUST NOT BURN THE INVITATION. Out of tickets, a slow
     network, a room that filled up while they were choosing — the player fixes
     it and tries again, and must still be going to the room they were asked
     into rather than a public one. */
  joinFails = true;
  await page.evaluate(() => { (0, eval)("lsInviteRoom='R-PRIV';"); });
  posted.length = 0;
  await page.evaluate(async () => { await (0, eval)('lsDoJoin')('ورزشی', 'green'); await new Promise((r) => setTimeout(r, 400)); });
  const kept = await page.evaluate(() => (0, eval)('lsInviteRoom'));
  ok('a refused entry leaves the invitation standing', kept === 'R-PRIV', String(kept));
  joinFails = false;
  posted.length = 0;
  await page.evaluate(async () => { await (0, eval)('lsDoJoin')('ورزشی', 'green'); await new Promise((r) => setTimeout(r, 400)); });
  const retried = posted.find((x) => x.path === '/last-survivor/join');
  ok('so trying again still goes to that room', !!retried && retried.body.roomId === 'R-PRIV', JSON.stringify(retried && retried.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
