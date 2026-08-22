/* THE KEYBOARD, THE BADGE, THE BANNER, AND THE ROOM YOU WERE INVITED TO.
 *
 *   • «صفحه چت وقتی کیبورد میاد به هم ریخته میشه» — `100vh` is the window as
 *     if no keyboard existed, so the box you type into ends up underneath it.
 *     Every typing screen had it: chat, registration, phone number, code.
 *   • «اگه اولین پیام به اتاق چت رفت یه badge روی چت بیوفته با تعداد پیام‌ها»
 *   • «وقتی به کسی که آنلاین است پیام میدی باید یه نوتیف بالای صفحه بیاد»
 *   • «کاربر باید تو همون موضوعی که روم ساخته شده بره، یه صفحه جلوتر»
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

let chatMsgs = [];
let notifs = [];
let friends = [];
let friendMsgs = [];
const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (/\/last-survivor\/rooms\/[^/]+\/chat$/.test(p)) return send({ messages: chatMsgs });
    if (/^\/notifications/.test(p)) return send(notifs);
    if (p === '/friends') return send(friends);
    if (p === '/friends/requests') return send({ incoming: [], outgoing: [] });
    if (/^\/friends\/[^/]+\/messages$/.test(p)) return send({ messages: friendMsgs });
    if (/^\/support\/tickets/.test(p)) return send([]);
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

const room = (over = {}) => {
  const now = Date.now();
  return Object.assign({
    room: { id: 'R9', topic: 'ورزشی', status: 'waiting', phase: 'waiting', round: 0, totalRounds: 12, capacity: 20,
            startsAt: now + 90000, phaseEndsAt: 0, serverNow: now, grossPool: 250000, chatEnabled: true, forfeited: 0 },
    players: [{ userId: 'me', username: 'احسان', avatar: '', character: null, color: 'green', status: 'alive', shields: 0, units: 1 },
              { userId: 'p1', username: 'سارا', avatar: '', character: null, color: 'blue', status: 'alive', shields: 0, units: 1 }],
    me: { userId: 'me', username: 'احسان', status: 'alive', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
    stats: { alive: 2, eliminated: 0, cashedOut: 0, totalPlayers: 2, grossPot: 250000, remainingPot: 250000, paidOut: 0 },
    question: null, votes: 0
  }, over);
};

/* ── 1. THE KEYBOARD ────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a keyboard opening:');

  const before = await page.evaluate(() => ({
    vh: getComputedStyle(document.documentElement).getPropertyValue('--pz-vh').trim(),
    phone: Math.round(document.querySelector('.phone').getBoundingClientRect().height),
    open: document.body.classList.contains('pz-kb-open')
  }));
  ok('the visible height is measured, not assumed', /px$/.test(before.vh), before.vh);
  ok('and the phone frame is that tall', Math.abs(before.phone - parseInt(before.vh, 10)) <= 2, before.phone + ' vs ' + before.vh);
  ok('with no keyboard flag while none is open', before.open === false, String(before.open));

  /* A keyboard is the visual viewport shrinking. Simulated exactly as the
     browser reports it, because that is the only signal there is. */
  const after = await page.evaluate(async () => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 500 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 250));
    return {
      vh: getComputedStyle(document.documentElement).getPropertyValue('--pz-vh').trim(),
      kb: getComputedStyle(document.documentElement).getPropertyValue('--pz-kb').trim(),
      phone: Math.round(document.querySelector('.phone').getBoundingClientRect().height),
      open: document.body.classList.contains('pz-kb-open')
    };
  });
  ok('the frame shrinks to what is left above the keyboard', after.phone <= 505 && after.phone >= 495, after.phone + 'px');
  ok('the keyboard height is published for anything that wants it', parseInt(after.kb, 10) > 300, after.kb);
  ok('and the page knows a keyboard is up', after.open === true, String(after.open));

  const back = await page.evaluate(async () => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 844 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 250));
    return { phone: Math.round(document.querySelector('.phone').getBoundingClientRect().height), open: document.body.classList.contains('pz-kb-open') };
  });
  ok('and it all comes back when the keyboard closes', back.phone >= 840 && back.open === false, JSON.stringify(back));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE TYPING BOX SITS ON THE KEYBOARD ─────────────────────────────── */
{
  /* A real conversation, opened the way a player opens one: the friend list
     comes from the server, the messages come from the server, and the chat is
     entered through openFriendChat. Forcing `chat-mode` on by hand tested the
     stylesheet against a screen the game never renders. */
  friends = [{ id: 'f1', username: 'sara', displayName: 'سارا', avatar: '', character: null, level: 4, online: true, unread: 2, lastMessage: 'بیا بازی' }];
  friendMsgs = Array.from({ length: 30 }, (_, i) => ({ mine: i % 2 === 0, body: 'پیام شماره ' + (i + 1) + ' برای اینکه گفتگو بلند باشد', at: Date.now() - (30 - i) * 60000 }));
  const { ctx, page, errs } = await makePage();
  console.log('the friends chat with a keyboard up:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('friends');"));
  await page.waitForTimeout(600);
  await page.evaluate(async () => { await (0, eval)('openFriendChat')('f1'); await new Promise((r) => setTimeout(r, 400)); });
  const opened = await page.evaluate(() => ({
    mode: document.getElementById('friends').classList.contains('chat-mode'),
    msgs: document.querySelectorAll('#friends .chat-body .msg').length,
    name: (document.querySelector('#friends .chat-head b') || {}).textContent
  }));
  ok('the conversation actually opened', opened.mode && opened.msgs === 30 && opened.name === 'سارا', JSON.stringify(opened));
  const shrunk = await page.evaluate(async () => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 480 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 300));
    const view = document.querySelector('#friends .chat-view');
    if (!view) return null;
    const r = view.getBoundingClientRect();
    const send = view.querySelector('.chat-send');
    const head = view.querySelector('.chat-head');
    const body = view.querySelector('.chat-body');
    return {
      viewBottom: Math.round(r.bottom),
      sendBottom: send ? Math.round(send.getBoundingClientRect().bottom) : -1,
      sendHeight: send ? Math.round(send.getBoundingClientRect().height) : -1,
      headTop: head ? Math.round(head.getBoundingClientRect().top) : -1,
      bodyScrolls: !!body && body.scrollHeight > body.clientHeight + 4,
      visible: 480
    };
  });
  ok('the chat view is on screen', !!shrunk, JSON.stringify(shrunk));
  /* «کادر تایپ حروف بچسبه به کیبورد» — not merely above the keyboard, ON it.
     Anything more than a hair of daylight is the bug the user reported. */
  ok('the typing box is not hidden under the keyboard', shrunk.sendBottom > 0 && shrunk.sendBottom <= shrunk.visible + 2, shrunk.sendBottom + ' vs ' + shrunk.visible);
  ok('and it sits right on it, with no dead strip between', shrunk.visible - shrunk.sendBottom <= 14, (shrunk.visible - shrunk.sendBottom) + 'px of gap');
  ok('and it is still a usable size, not squashed', shrunk.sendHeight >= 44, shrunk.sendHeight + 'px');
  ok('and the whole view fits in what is visible', shrunk.viewBottom <= shrunk.visible + 2, shrunk.viewBottom + ' vs ' + shrunk.visible);
  /* «اسم و عکس کاربر اون بالا بمونه و نره بالاتر» */
  ok('the header stays on screen', shrunk.headTop >= -2, String(shrunk.headTop));
  /* «فقط متن چت اسکرول بشه» — the messages give up the room, not the frame. */
  ok('only the messages scroll', shrunk.bodyScrolls === true, String(shrunk.bodyScrolls));

  /* Taking the nav away for the keyboard must not take it away for good. */
  const closed = await page.evaluate(async () => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 844 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 300));
    const nav = document.querySelector('#friends .bottomnav');
    const view = document.querySelector('#friends .chat-view');
    return { nav: !!nav && nav.getBoundingClientRect().height > 20,
             viewBottom: Math.round(view.getBoundingClientRect().bottom) };
  });
  ok('the navigation comes back when the keyboard goes', closed.nav === true, JSON.stringify(closed));
  ok('and the chat still fits above it', closed.viewBottom <= 844 - 60, String(closed.viewBottom));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2b. THE SCREENS YOU SIGN IN ON ─────────────────────────────────────── */
/* «مخصوصا ورود کد موبایل و ورود شماره موبایل» — the first two screens anyone
   ever sees, and the two where a hidden input means nobody gets in at all. */
{
  const { ctx, page, errs } = await makePage();
  console.log('typing on the sign-in screens:');
  const typeOn = async (screen, sel) => page.evaluate(async ([s, q]) => {
    (0, eval)("go('" + s + "')");
    await new Promise((r) => setTimeout(r, 350));
    const el = document.querySelector(q);
    if (!el) return null;
    el.focus();
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 420 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 450));
    const r = el.getBoundingClientRect();
    /* Put it back, so the next screen starts from a closed keyboard. */
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 844 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r2) => setTimeout(r2, 200));
    return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
  }, [screen, sel]);

  const phone = await typeOn('login', '#phoneInput');
  ok('the phone number box stays visible above the keyboard', !!phone && phone.top >= 0 && phone.bottom <= 420, JSON.stringify(phone));
  const code = await typeOn('otp', '#otpBoxes input');
  ok('and so does the box you type the code into', !!code && code.top >= 0 && code.bottom <= 420, JSON.stringify(code));
  const uname = await typeOn('register', '#regUsername');
  ok('and the username field on the sign-up form', !!uname && uname.top >= 0 && uname.bottom <= 420, JSON.stringify(uname));
  /* The last field on a long form is the one the keyboard buries: tapping it
     scrolls it into view while the window is still full height, and THEN the
     keyboard opens underneath it. Only a second scroll, after the viewport has
     shrunk, brings it back — which is what the focused-input rescue is for. */
  const ref = await typeOn('register', '#regReferral');
  ok('and the last field on the form, the one the keyboard lands on', !!ref && ref.top >= 0 && ref.bottom <= 420, JSON.stringify(ref));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2c. THE SUPPORT CHAT ───────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('writing to support with a keyboard up:');
  await page.evaluate(async () => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('support');");
    await new Promise((r) => setTimeout(r, 400));
    (0, eval)('openSupportTab')('chat');
    await new Promise((r) => setTimeout(r, 500));
  });
  const sup = await page.evaluate(async () => {
    const vv = window.visualViewport;
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 480 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 350));
    const box = document.querySelector('#support .sup-chat');
    const send = document.querySelector('#support .sup-chat-send');
    if (!box || !send) return null;
    return { mode: document.getElementById('support').classList.contains('chat-mode'),
             boxBottom: Math.round(box.getBoundingClientRect().bottom),
             sendBottom: Math.round(send.getBoundingClientRect().bottom) };
  });
  ok('the support chat is on screen', !!sup && sup.mode, JSON.stringify(sup));
  ok('its typing box is on the keyboard too', sup.sendBottom > 0 && 480 - sup.sendBottom <= 14, (480 - sup.sendBottom) + 'px of gap');
  ok('and it does not run off the bottom', sup.boxBottom <= 482, String(sup.boxBottom));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2d. A KEYBOARD THAT LEAVES NO MARK ON THE VIEWPORT ─────────────────── */
/* «بازم در قسمت دوستان هم در قسمت چت مابین کیبورد و کادر ورود متن دکمه های
   پایین هستند — فروشگاه و خانه و دوستان و رنکینگ و منو همبرگری.»
 *
 * The rule that hides them was already written, and section 2 above proves it
 * works — when the browser reports the keyboard by shrinking the visual
 * viewport. Not every browser does: where the whole page is resized instead,
 * window.innerHeight comes down WITH visualViewport.height, the difference
 * between them stays zero, and the flag never turns on. Nothing here is
 * wrong-looking in a test that shrinks one and not the other, which is why it
 * went unnoticed. So this one shrinks BOTH, exactly as such a browser does,
 * and asks the same questions.
 */
{
  friends = [{ id: 'f1', username: 'sara', displayName: 'سارا', avatar: '', character: null, level: 4, online: true, unread: 0, lastMessage: 'سلام' }];
  friendMsgs = Array.from({ length: 12 }, (_, i) => ({ mine: i % 2 === 0, body: 'پیام ' + (i + 1), at: Date.now() - (12 - i) * 60000 }));
  const { ctx, page, errs } = await makePage();
  console.log('a keyboard on a browser that resizes the whole page:');
  await page.evaluate(async () => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('friends');");
    await new Promise((r) => setTimeout(r, 500));
    await (0, eval)('openFriendChat')('f1');
    await new Promise((r) => setTimeout(r, 400));
  });

  const shrinkBoth = async () => page.evaluate(async () => {
    const vv = window.visualViewport;
    /* Both numbers move together — the keyboard is up and NOTHING in the
       measurements says so. */
    Object.defineProperty(vv, 'height', { configurable: true, get: () => 480 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => 480 });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 250));
    return Math.round(Number(getComputedStyle(document.documentElement).getPropertyValue('--pz-kb').replace('px', '')));
  });
  const kb = await shrinkBoth();
  ok('the measurement really does say «no keyboard»', kb === 0, kb + 'px');

  /* Now the second witness: the player taps the box and starts typing. */
  const typing = await page.evaluate(async () => {
    document.getElementById('chatInput').focus();
    await new Promise((r) => setTimeout(r, 300));
    const nav = document.querySelector('#friends .bottomnav');
    const bar = document.querySelector('#friends>.topbar');
    const send = document.querySelector('#friends .chat-send');
    const navBox = nav ? nav.getBoundingClientRect() : null;
    return {
      open: document.body.classList.contains('pz-kb-open'),
      navShown: !!navBox && navBox.height > 20,
      navTop: navBox ? Math.round(navBox.top) : -1,
      barShown: !!bar && bar.getBoundingClientRect().height > 8,
      sendBottom: send ? Math.round(send.getBoundingClientRect().bottom) : -1
    };
  });
  ok('the page still works out that a keyboard is up', typing.open === true, JSON.stringify(typing));
  /* The complaint itself: those buttons, sitting in the gap. */
  ok('the bottom nav is not between the composer and the keys', typing.navShown === false, JSON.stringify({ shown: typing.navShown, top: typing.navTop }));
  ok('the screen title bar gives its room to the messages', typing.barShown === false, String(typing.barShown));
  ok('and the composer sits on the keyboard', typing.sendBottom > 0 && 480 - typing.sendBottom <= 14, (480 - typing.sendBottom) + 'px of gap');

  /* And it is a keyboard, not a permanent state: let go of the box and the
     way out of the screen comes back. */
  const done = await page.evaluate(async () => {
    document.getElementById('chatInput').blur();
    await new Promise((r) => setTimeout(r, 300));
    const nav = document.querySelector('#friends .bottomnav');
    const bar = document.querySelector('#friends>.topbar');
    return { open: document.body.classList.contains('pz-kb-open'),
             navShown: !!nav && nav.getBoundingClientRect().height > 20,
             barShown: !!bar && bar.getBoundingClientRect().height > 8 };
  });
  ok('letting go of the box puts the navigation back', done.open === false && done.navShown === true, JSON.stringify(done));
  ok('and the title bar with it', done.barShown === true, String(done.barShown));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2e. A REAL KEYBOARD ON A DESKTOP IS NOT A SOFT ONE ─────────────────── */
/* The focus signal above is only trustworthy where focusing a field is what
   summons a keyboard. On a machine with a mouse and a keyboard already
   attached, clicking into the box covers nothing, and taking the navigation
   away would be a bug of my own making. */
{
  friends = [{ id: 'f1', username: 'sara', displayName: 'سارا', avatar: '', character: null, level: 4, online: true, unread: 0, lastMessage: 'سلام' }];
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/friends') return send(friends);
    if (p === '/friends/requests') return send({ incoming: [], outgoing: [] });
    if (/^\/friends\/[^/]+\/messages$/.test(p)) return send({ messages: friendMsgs });
    return send({});
  });
  const page = await ctx.newPage();
  console.log('clicking into the box on a desktop:');
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  const desk = await page.evaluate(async () => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('friends');");
    await new Promise((r) => setTimeout(r, 500));
    await (0, eval)('openFriendChat')('f1');
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('chatInput').focus();
    await new Promise((r) => setTimeout(r, 300));
    const nav = document.querySelector('#friends .bottomnav');
    return { coarse: matchMedia('(pointer:coarse)').matches,
             open: document.body.classList.contains('pz-kb-open'),
             navShown: !!nav && nav.getBoundingClientRect().height > 20 };
  });
  ok('the test really is running with a mouse', desk.coarse === false, String(desk.coarse));
  ok('no keyboard is assumed from focus alone', desk.open === false, JSON.stringify(desk));
  ok('and the navigation stays where it is', desk.navShown === true, String(desk.navShown));
  await ctx.close();
}

/* ── 3. THE CHAT BADGE ──────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('messages arriving in the room:');
  chatMsgs = [];
  await page.evaluate((sn) => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsRoomId='R9'; lsMyId='me'; lsSnap=null; lsLastKey=''; lsTab='players'; go('lsGame');");
    (0, eval)('lsRender')(sn);
  }, room());
  await page.waitForTimeout(600);
  const clean = await page.evaluate(() => {
    const b = document.getElementById('lsChatBadge');
    return { there: !!b, shown: !!b && b.style.display !== 'none' };
  });
  ok('there is no badge before anybody says anything', clean.there && clean.shown === false, JSON.stringify(clean));

  chatMsgs = [{ userId: 'p1', username: 'سارا', body: 'سلام', createdAt: Date.now() }];
  const one = await page.evaluate(async () => {
    await (0, eval)('lsChatWatchTick')();
    await new Promise((r) => setTimeout(r, 200));
    const b = document.getElementById('lsChatBadge');
    return { shown: b.style.display !== 'none', text: b.textContent };
  });
  ok('the first message puts one on the chat tab', one.shown, JSON.stringify(one));
  ok('with the number on it', one.text === '۱', one.text);

  chatMsgs = chatMsgs.concat([
    { userId: 'p1', username: 'سارا', body: 'کجایی', createdAt: Date.now() },
    { userId: 'p1', username: 'سارا', body: 'بیا', createdAt: Date.now() }
  ]);
  const three = await page.evaluate(async () => {
    await (0, eval)('lsChatWatchTick')();
    await new Promise((r) => setTimeout(r, 200));
    return (document.getElementById('lsChatBadge') || {}).textContent;
  });
  ok('and it counts up as more arrive', three === '۳', three);

  /* My own words are not news to me. */
  chatMsgs = chatMsgs.concat([{ userId: 'me', username: 'احسان', body: 'اومدم', createdAt: Date.now() }]);
  const mine = await page.evaluate(async () => {
    await (0, eval)('lsChatWatchTick')();
    await new Promise((r) => setTimeout(r, 200));
    return (document.getElementById('lsChatBadge') || {}).textContent;
  });
  ok('my own message does not count against me', mine === '۳', mine);

  const opened = await page.evaluate(async () => {
    (0, eval)('lsSetTab')('chat');
    await new Promise((r) => setTimeout(r, 300));
    const b = document.getElementById('lsChatBadge');
    return { shown: b && b.style.display !== 'none' };
  });
  ok('reading them clears it', opened.shown === false, JSON.stringify(opened));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. A MESSAGE WHILE THE GAME IS OPEN ────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a friend messaging somebody who is already in the game:');
  notifs = [{ id: 'n1', type: 'friend_message', title: 'سارا', body: 'سلام خوبی؟', readAt: null, data: { fromUserId: 'p1', fromName: 'سارا' } }];
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(300);
  await page.evaluate(async () => { await (0, eval)('pzInboxBadge')(); await new Promise((r) => setTimeout(r, 400)); });

  const note = await page.evaluate(() => {
    const el = document.getElementById('pzTopNote');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { shown: el.classList.contains('show'), text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
             top: Math.round(r.top), vpTop: Math.round((document.getElementById('vp') || document.body).getBoundingClientRect().top) };
  });
  ok('a banner drops across the top', !!note && note.shown, JSON.stringify(note));
  ok('naming who wrote', /سارا/.test(note.text), note.text);
  ok('and showing what they said', /سلام/.test(note.text), note.text);
  ok('at the top of the screen', note.top <= note.vpTop + 2, note.top + ' vs ' + note.vpTop);

  const tapped = await page.evaluate(async () => {
    document.getElementById('pzTopNote').click();
    await new Promise((r) => setTimeout(r, 700));
    return [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id;
  });
  ok('and tapping it opens that conversation', tapped === 'friends', tapped);

  /* Never over a live match. */
  const during = await page.evaluate(async () => {
    (0, eval)('pzTopNoticeHide')();
    (0, eval)("pzRt.active=true; pzRt.finished=false; go('duel');");
    (0, eval)('PZ_TOP_SEEN')['n1'] = 0;
    delete (0, eval)('PZ_TOP_SEEN')['n1'];
    await (0, eval)('pzInboxBadge')();
    await new Promise((r) => setTimeout(r, 400));
    const el = document.getElementById('pzTopNote');
    return !!(el && el.classList.contains('show'));
  });
  ok('but never on top of a live match', during === false, String(during));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. INVITED INTO A ROOM, NOT INTO A TOPIC LIST ──────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('accepting an invite into a room:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(300);
  const landed = await page.evaluate(async () => {
    (0, eval)('pzInviteGoNow')({ id: 'i1', mode: 'ls', roomId: 'R9', roomTopic: 'ورزشی' });
    await new Promise((r) => setTimeout(r, 700));
    return {
      screen: [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id,
      topic: (0, eval)('lsEntryTopic'),
      room: (0, eval)('lsInviteRoom')
    };
  });
  /* «باید تو همون موضوعی که روم ساخته شده بره، یعنی یه صفحه جلوتر: صفحه
     انتخاب بلیط» */
  ok('it goes straight to the ticket screen, not the topic list', landed.screen === 'lsEntry', JSON.stringify(landed));
  ok('for the room’s own topic', landed.topic === 'ورزشی', String(landed.topic));
  ok('and remembers which room they were asked into', landed.room === 'R9', String(landed.room));

  /* Without a topic there is nothing to open, so the old path still stands. */
  const fallback = await page.evaluate(async () => {
    (0, eval)("go('home')");
    await new Promise((r) => setTimeout(r, 200));
    (0, eval)('pzInviteGoNow')({ id: 'i2', mode: 'ls', roomId: 'R7', roomTopic: '' });
    await new Promise((r) => setTimeout(r, 700));
    return [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id;
  });
  ok('an invite with no topic still lands somewhere sensible', fallback === 'lsTopics', fallback);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
