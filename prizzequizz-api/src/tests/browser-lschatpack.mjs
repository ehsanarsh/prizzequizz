/* THE READY-MADE PHRASES, INSIDE A LAST SURVIVOR MATCH.
 *
 * «در قسمت بازی آخرین بازمانده بعد از ورود به مسابقه، به غیر از صفحه‌های اتاق
 *  انتظار و صفحهٔ پخش سوالات، باید دکمهٔ چت باشه که وقتی روش میزنی بتونی پک
 *  چت‌های آماده‌ای که در دوئل داریم رو بفرستی.»
 *
 * Two halves to get right: WHERE the button is (and where it must not be), and
 * WHERE the phrase goes once it is tapped — into the room's real chat, which
 * everybody in the room reads, not the duel's two-person floating bubble.
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

const PACKS = [
  { key: 'free', name: 'رایگان', emoji: '🙂', owned: true, locked: false, phraseCount: 3,
    phrases: ['سلام', 'موفق باشی', 'ایول'] },
  { key: 'gold', name: 'طلایی', emoji: '👑', owned: false, locked: true, phraseCount: 8,
    price: 20000, currency: 'cash', phrases: [] }
];

const posted = [];
let chatMsgs = [];

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 500, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (route.request().method() === 'POST') {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      posted.push({ path: p, body });
      if (/\/chat$/.test(p)) { chatMsgs = chatMsgs.concat([{ userId: 'me', username: 'احسان', body: body.body, createdAt: Date.now() }]); }
      return send({});
    }
    if (p === '/chat-packs') return send({ packs: PACKS });
    if (p === '/friends') return send([
      { id: 'f-sara', username: 'sara', displayName: 'سارا', avatar: '', character: null, level: 4, online: true, unread: 0, lastMessage: '' },
      { id: 'f-nima', username: 'nima', displayName: 'نیما', avatar: '', character: null, level: 2, online: false, unread: 0, lastMessage: '' }
    ]);
    if (p === '/users/online') return send({ players: [
      /* سارا is a friend AND in the lobby — one person, one row. */
      { userId: 'f-sara', username: 'سارا', level: 4, avatar: '', character: null, inMatch: false, invitePending: false, canInvite: true },
      { userId: 'o-1', username: 'غریبه', level: 7, avatar: '', character: null, inMatch: false, invitePending: false, canInvite: true }
    ], onlineTotal: 2, nextCost: 0, freeLeft: 3, coins: 500 });
    if (/\/last-survivor\/rooms\/[^/]+\/chat$/.test(p)) return send({ messages: chatMsgs });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

/* One room, driven through its phases exactly as the server drives it. */
const room = (over = {}, roomOver = {}) => {
  const now = Date.now();
  return Object.assign({
    room: Object.assign({ id: 'R9', topic: 'ورزشی', status: 'running', phase: 'dashboard', round: 3, totalRounds: 12,
            capacity: 20, startsAt: now - 60000, phaseEndsAt: now + 20000, serverNow: now,
            grossPool: 250000, chatEnabled: true, forfeited: 0 }, roomOver),
    players: [{ userId: 'me', username: 'احسان', avatar: '', character: null, color: 'green', status: 'alive', shields: 0, units: 1 },
              { userId: 'p1', username: 'سارا', avatar: '', character: null, color: 'blue', status: 'alive', shields: 0, units: 1 }],
    me: { userId: 'me', username: 'احسان', status: 'alive', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
    stats: { alive: 2, eliminated: 0, cashedOut: 0, totalPlayers: 2, grossPot: 250000, remainingPot: 250000, paidOut: 0 },
    question: null, votes: 0
  }, over);
};

const enter = (page, snap) => page.evaluate((sn) => {
  (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsRoomId='R9'; lsMyId='me'; lsSnap=null; lsLastKey=''; lsWatching=false; go('lsGame');");
  (0, eval)('lsRender')(sn);
}, snap);

const hasBtn = (page) => page.evaluate(() => {
  const b = document.getElementById('lsQuickChat');
  return { there: !!b, shown: !!b && b.offsetParent !== null, text: b ? b.textContent.trim() : '' };
});

/* ── WHERE THE BUTTON IS ─────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the chat button through a match:');

  await enter(page, room());
  await page.waitForTimeout(400);
  const dash = await hasBtn(page);
  ok('it is on the match dashboard', dash.there && dash.shown, JSON.stringify(dash));
  ok('and says what it is', /چت/.test(dash.text), dash.text);

  /* «باید زیر کادر بالا و سمت راست نوشتهٔ وضعیت مسابقه باشه» — on the heading's
     line, at the right-hand edge, not banished to a far corner. */
  const place = await page.evaluate(() => {
    const b = document.getElementById('lsQuickChat');
    const hd = document.querySelector('#lsBody .ls-elim-hd h2');
    const card = document.querySelector('#lsBody .ls-dash-mini');
    if (!b || !hd || !card) return null;
    const rb = b.getBoundingClientRect(), rh = hd.getBoundingClientRect();
    const vw = document.getElementById('vp').getBoundingClientRect();
    return { sameLine: Math.abs((rb.top + rb.height / 2) - (rh.top + rh.height / 2)) <= 26,
             fromRight: Math.round(vw.right - rb.right),
             belowCard: Math.round(rb.top - card.getBoundingClientRect().bottom),
             headingCentred: Math.abs((rh.left + rh.right) / 2 - (vw.left + vw.right) / 2) <= 8 };
  });
  ok('on the same line as the heading', !!place && place.sameLine, JSON.stringify(place));
  ok('at the right-hand side', place.fromRight >= 0 && place.fromRight <= 24, place.fromRight + 'px from the right');
  ok('below the card above it', place.belowCard >= 0 && place.belowCard <= 40, place.belowCard + 'px under the card');
  ok('and the heading is still centred', place.headingCentred, String(place.headingCentred));

  /* Each phase is entered fresh, not pushed on top of the last one: the room
     only ever moves forward, and lsRender rightly throws away a snapshot that
     goes backwards. */
  await enter(page, room({}, { phase: 'elimination' }));
  await page.waitForTimeout(500);
  const elim = await hasBtn(page);
  ok('and on the elimination grid', elim.there && elim.shown, JSON.stringify(elim));

  /* «به غیر از صفحهٔ پخش سوالات» — a sheet over a live question covers the
     options and is a way to lose the round. */
  await enter(page, room({ question: { id: 'q1', text: 'پایتخت؟', options: ['الف', 'ب', 'ج', 'د'] } },
    { phase: 'question', phaseEndsAt: Date.now() + 20000 }));
  await page.waitForTimeout(500);
  const q = await hasBtn(page);
  const opts = await page.evaluate(() => document.querySelectorAll('#lsOpts .ans').length);
  ok('the question really is the screen being shown', opts === 4, String(opts));
  ok('never while a question is on screen', q.there === false, JSON.stringify(q));

  /* And not behind the ready gate either, which is the same question a second
     earlier. */
  await enter(page, room({ question: { id: 'q1', text: 'پایتخت؟', options: ['الف', 'ب', 'ج', 'د'] } },
    { phase: 'ready', phaseEndsAt: Date.now() + 4000 }));
  await page.waitForTimeout(500);
  const ready = await hasBtn(page);
  ok('nor while everyone is being counted in', ready.there === false, JSON.stringify(ready));

  /* «به غیر از اتاق انتظار» — that screen already has a typing box. */
  await enter(page, room({}, { status: 'waiting', phase: 'waiting', startsAt: Date.now() + 90000 }));
  await page.waitForTimeout(500);
  const wait = await hasBtn(page);
  const typing = await page.evaluate(() => !!document.getElementById('lsChatInput'));
  ok('and not in the waiting room', wait.there === false, JSON.stringify(wait));
  ok('which has its own typing box instead', typing, String(typing));

  /* A room with chat switched off must not offer one. */
  await enter(page, room({}, { chatEnabled: false }));
  await page.waitForTimeout(400);
  const muted = await hasBtn(page);
  ok('a room with chat turned off does not get a button', muted.there === false, JSON.stringify(muted));

  /* The «چت سریع داخل بازی» switch is one switch for both games. */
  await page.evaluate(() => { (0, eval)('appSettings').quickChat = false; });
  await enter(page, room());
  await page.waitForTimeout(400);
  const offSetting = await hasBtn(page);
  ok('and the player can switch it off in settings', offSetting.there && offSetting.shown === false, JSON.stringify(offSetting));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── WHAT IT SENDS ───────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('sending a ready-made phrase from the match:');
  chatMsgs = []; posted.length = 0;
  await enter(page, room());
  await page.waitForTimeout(400);

  await page.evaluate(() => document.getElementById('lsQuickChat').click());
  await page.waitForTimeout(700);
  const sheet = await page.evaluate(() => {
    const sh = document.getElementById('qcpSheet');
    return { open: !!sh && sh.classList.contains('show'),
             tabs: [...document.querySelectorAll('#qcpTabs .qcp-tab')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()),
             phrases: [...document.querySelectorAll('#qcpBody .qcp-grid button')].map((b) => b.textContent.trim()) };
  });
  ok('the pack sheet opens', sheet.open, String(sheet.open));
  /* IT MUST BE ON SCREEN, not merely marked open. The sheet used to be a child
     of the duel screen — display:none everywhere else — so pressing «چت» in a
     room opened something nobody could see, and the player found it already
     open the next time they walked into a duel. */
  const seen = await page.evaluate(() => {
    const sh = document.getElementById('qcpSheet');
    const r = sh.getBoundingClientRect();
    const inside = document.getElementById('duel').contains(sh);
    return { visible: sh.offsetParent !== null && r.width > 100 && r.height > 100,
             insideDuel: inside, w: Math.round(r.width), h: Math.round(r.height) };
  });
  ok('and is actually on screen', seen.visible, JSON.stringify(seen));
  ok('because it does not belong to the duel screen', seen.insideDuel === false, String(seen.insideDuel));
  ok('with the packs the player owns', sheet.phrases.length === 3, sheet.phrases.join(' / '));
  ok('and the locked one still offered', sheet.tabs.length === 2, sheet.tabs.join(' | '));

  await page.evaluate(() => [...document.querySelectorAll('#qcpBody .qcp-grid button')][1].click());
  await page.waitForTimeout(700);
  const sent = posted.filter((x) => /\/chat$/.test(x.path));
  /* THE POINT: it goes into the ROOM's chat, where the other nineteen people
     can read it — not a bubble only the sender sees. */
  ok('the phrase is posted to the room chat', sent.length === 1, JSON.stringify(posted));
  ok('with the words that were on the button', sent[0] && sent[0].body.body === 'موفق باشی', JSON.stringify(sent[0] && sent[0].body));
  ok('to this room', sent[0] && /rooms\/R9\/chat$/.test(sent[0].path), sent[0] && sent[0].path);

  const after = await page.evaluate(() => ({
    open: document.getElementById('qcpSheet').classList.contains('show')
  }));
  ok('the sheet closes behind it', after.open === false, String(after.open));

  /* «باید همه ببینن و دقیقا زیر عکس پروفایل» — the sender's own words land on
     the sender's own card, where everybody else will see them too. */
  const mine = await page.evaluate(() => {
    const b = document.querySelector('#lsGame .ls-pl[data-uid="me"] .ls-say');
    return b ? b.textContent : null;
  });
  ok('and it appears under the sender’s own picture', mine === 'موفق باشی', String(mine));

  /* AND THE OTHER DIRECTION. Pushed over the socket, not waited for on the
     eight-second poll: a bubble that arrives eight seconds late is not a
     conversation. */
  const heard = await page.evaluate(async () => {
    document.querySelectorAll('.ls-say').forEach((e) => e.remove());
    (0, eval)('lsOnWs')('ls:chat', { userId: 'p1', username: 'سارا', body: 'ایول', createdAt: Date.now() });
    await new Promise((r) => setTimeout(r, 300));
    const b = document.querySelector('#lsGame .ls-pl[data-uid="p1"] .ls-say');
    return { text: b ? b.textContent : null,
             onMine: !!document.querySelector('#lsGame .ls-pl[data-uid="me"] .ls-say') };
  });
  ok('what somebody else says arrives at once', heard.text === 'ایول', JSON.stringify(heard));
  ok('on THEIR card, not mine', heard.onMine === false, String(heard.onMine));

  /* «چت دو نفر بغل هم روی هم نیوفته» — two neighbours talking at once. */
  const apart = await page.evaluate(async () => {
    (0, eval)('lsOnWs')('ls:chat', { userId: 'p1', username: 'سارا', body: 'من بردم', createdAt: Date.now() });
    (0, eval)('lsSayBubble')('me', 'نه من بردم');
    await new Promise((r) => setTimeout(r, 250));
    const a = document.querySelector('#lsGame .ls-pl[data-uid="me"] .ls-say');
    const b = document.querySelector('#lsGame .ls-pl[data-uid="p1"] .ls-say');
    if (!a || !b) return null;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const cellA = document.querySelector('#lsGame .ls-pl[data-uid="me"]').getBoundingClientRect();
    const overlap = !(ra.right <= rb.left + 0.5 || rb.right <= ra.left + 0.5)
                 && !(ra.bottom <= rb.top + 0.5 || rb.bottom <= ra.top + 0.5);
    return { overlap, insideOwnCell: ra.left >= cellA.left - 0.5 && ra.right <= cellA.right + 0.5,
             wa: Math.round(ra.width), wb: Math.round(rb.width) };
  });
  ok('two people talking at once do not land on top of each other', !!apart && apart.overlap === false, JSON.stringify(apart));
  ok('because each bubble stays inside its own card', apart.insideOwnCell, JSON.stringify(apart));

  /* One player, one bubble: the newest thing they said replaces the last. */
  const single = await page.evaluate(async () => {
    (0, eval)('lsSayBubble')('p1', 'دوباره');
    await new Promise((r) => setTimeout(r, 200));
    const all = document.querySelectorAll('#lsGame .ls-pl[data-uid="p1"] .ls-say');
    return { n: all.length, text: all[0] ? all[0].textContent : null };
  });
  ok('one player has one bubble, not a stack', single.n === 1 && single.text === 'دوباره', JSON.stringify(single));

  /* The room broadcasts to everybody, the sender included. My own words coming
     back must not be counted as an unread message from somebody else. */
  const echo = await page.evaluate(async () => {
    (0, eval)("lsTab='players'; lsChatUnread=0; lsChatBadgePaint();");
    (0, eval)('lsOnWs')('ls:chat', { userId: 'me', username: 'احسان', body: 'موفق باشی', createdAt: Date.now() });
    await new Promise((r) => setTimeout(r, 250));
    const b = document.getElementById('lsChatBadge');
    return { unread: (0, eval)('lsChatUnread'), shown: !!b && b.style.display !== 'none' };
  });
  ok('my own message coming back does not raise the badge', echo.unread === 0 && echo.shown === false, JSON.stringify(echo));

  const theirs = await page.evaluate(async () => {
    (0, eval)('lsOnWs')('ls:chat', { userId: 'p1', username: 'سارا', body: 'سلام', createdAt: Date.now() });
    await new Promise((r) => setTimeout(r, 250));
    return (0, eval)('lsChatUnread');
  });
  ok('but somebody else’s does', theirs === 1, String(theirs));

  /* The very first read is catching up with a room that was talking before the
     player arrived — forty old lines are not forty arriving now. */
  const backlog = await page.evaluate(async () => {
    document.querySelectorAll('.ls-say').forEach((e) => e.remove());
    (0, eval)('lsChatCount=0; lsChatFloated=false;');
    await (0, eval)('lsChatWatchTick')();
    await new Promise((r) => setTimeout(r, 500));
    return document.querySelectorAll('.ls-say').length;
  });
  ok('but the backlog does not', backlog === 0, String(backlog));

  /* Never over a question — the same rule the button obeys. */
  const overQ = await page.evaluate(async (sn) => {
    document.querySelectorAll('.ls-say').forEach((e) => e.remove());
    (0, eval)("lsSnap=null; lsLastKey='';");
    (0, eval)('lsRender')(sn);
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)('lsOnWs')('ls:chat', { userId: 'p1', username: 'سارا', body: 'الان', createdAt: Date.now() });
    await new Promise((r) => setTimeout(r, 300));
    return { bubbles: document.querySelectorAll('.ls-say').length,
             cells: document.querySelectorAll('#lsGame .ls-pl').length };
  }, room({ question: { id: 'q2', text: 'پایتخت؟', options: ['الف', 'ب', 'ج', 'د'] } },
     { round: 4, phase: 'question', phaseEndsAt: Date.now() + 20000 }));
  ok('and never across a live question', overQ.bubbles === 0, String(overQ.bubbles));
  /* Belt AND braces: the phase is checked, and there is no player grid on that
     screen for a bubble to attach to in the first place. Worth stating, because
     it is the second of the two that makes the first unable to fail. */
  ok('the question screen has no player cards to attach one to', overQ.cells === 0, String(overQ.cells));

  /* Turning quick chat off means off in both directions: somebody who does not
     want to be talked at during a match must not be. */
  const quiet = await page.evaluate(async (sn) => {
    (0, eval)("lsSnap=null; lsLastKey='';");
    (0, eval)('lsRender')(sn);
    await new Promise((r) => setTimeout(r, 300));
    document.querySelectorAll('.ls-say').forEach((e) => e.remove());
    (0, eval)('appSettings').quickChat = false;
    (0, eval)('lsOnWs')('ls:chat', { userId: 'p1', username: 'سارا', body: 'هوی', createdAt: Date.now() });
    await new Promise((r) => setTimeout(r, 300));
    const n = document.querySelectorAll('.ls-say').length;
    (0, eval)('appSettings').quickChat = true;
    return n;
  }, room({}, { round: 5, phase: 'dashboard' }));
  ok('and not at all for a player who turned quick chat off', quiet === 0, String(quiet));

  /* A locked pack is a locked pack, wherever it is opened from. */
  posted.length = 0;
  await page.evaluate(async () => {
    (0, eval)('qcOpen')();
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)('qcTab')('gold');
    await new Promise((r) => setTimeout(r, 200));
  });
  const locked = await page.evaluate(() => ({
    buy: !!document.getElementById('qcpBuyBtn'),
    phrases: document.querySelectorAll('#qcpBody .qcp-grid button').length
  }));
  ok('a pack that is not owned cannot be sent from here either', locked.buy && locked.phrases === 0, JSON.stringify(locked));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── IT DOES NOT FOLLOW THE PLAYER OUT ───────────────────────────────────── */
/* «وقتی خروج میکنی میری دوئل میبینی اتوماتیک دکمهٔ چت زده شده و متن‌ها رو نشون
   میده» — the sheet was left open behind the room and turned up by itself on
   the next screen. Leaving a screen closes it. */
{
  const { ctx, page, errs } = await makePage();
  console.log('walking out of the room with the sheet open:');
  chatMsgs = []; posted.length = 0;
  await enter(page, room());
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('lsQuickChat').click());
  await page.waitForTimeout(600);
  const wasOpen = await page.evaluate(() => document.getElementById('qcpSheet').classList.contains('show'));
  ok('it is open in the room', wasOpen, String(wasOpen));

  const after = await page.evaluate(async () => {
    (0, eval)("go('duel')");
    await new Promise((r) => setTimeout(r, 500));
    const sh = document.getElementById('qcpSheet');
    return { open: sh.classList.contains('show'), phrases: document.querySelectorAll('#qcpBody .qcp-grid button').length,
             visible: sh.offsetParent !== null };
  });
  ok('and shut the moment the player leaves', after.open === false, JSON.stringify(after));
  ok('so nothing greets them on the next screen', after.visible === false, String(after.visible));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── AND THE DUEL IS UNTOUCHED ───────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the same sheet in a duel:');
  chatMsgs = []; posted.length = 0;
  await page.evaluate(async () => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsRoomId=null; go('duel');");
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)('qcOpen')();
    await new Promise((r) => setTimeout(r, 600));
  });
  await page.evaluate(() => [...document.querySelectorAll('#qcpBody .qcp-grid button')][0].click());
  await page.waitForTimeout(500);
  const duel = await page.evaluate(() => document.querySelectorAll('.taunt').length);
  ok('still floats a bubble', duel > 0, String(duel));
  ok('and posts to no room', posted.filter((x) => /\/chat$/.test(x.path)).length === 0, JSON.stringify(posted));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE FIRST QUESTION IS NOT «THE NEXT QUESTION» ───────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the modal before the very first question:');
  await enter(page, room({ question: { id: 'q1', text: 'پایتخت؟', options: ['الف', 'ب', 'ج', 'د'], difficulty: 'easy' } },
    { round: 1, phase: 'ready', phaseEndsAt: Date.now() + 5000 }));
  await page.waitForTimeout(600);
  const first = await page.evaluate(() => {
    const t = document.getElementById('aaaTitle'), s = document.getElementById('aaaSub');
    const big = s && s.querySelector('.ls-first-line');
    return { title: t ? t.textContent.trim() : '', sub: s ? s.textContent.replace(/\s+/g, ' ').trim() : '',
             bigText: big ? big.textContent.trim() : null,
             bigPx: big ? Math.round(parseFloat(getComputedStyle(big).fontSize)) : 0,
             subPx: s ? Math.round(parseFloat(getComputedStyle(s).fontSize)) : 0 };
  });
  /* «نوشته سوال بعدی با اینکه این اولین سوال هست» */
  ok('it does not call the first question the next one', !/سوال بعدی/.test(first.sub) && !/سوال بعدی/.test(first.title), JSON.stringify(first));
  /* «باید متنی بزرگ بنویسه با هیجان که آماده اولین سوال بازی باش» */
  ok('it says the first question is coming', /اولین سوال/.test(first.bigText || ''), String(first.bigText));
  ok('and says it big', first.bigPx >= 17 && first.bigPx > first.subPx, first.bigPx + 'px vs ' + first.subPx + 'px');

  /* Round two goes back to the ordinary words. */
  const later = await page.evaluate(async (sn) => {
    (0, eval)("closeAaaModal(false); lsReadyShownRound=''; lsSnap=null; lsLastKey='';");
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)('lsRender')(sn);
    await new Promise((r) => setTimeout(r, 500));
    const s = document.getElementById('aaaSub');
    return { title: (document.getElementById('aaaTitle') || {}).textContent.trim(),
             big: !!(s && s.querySelector('.ls-first-line')),
             sub: s ? s.textContent.replace(/\s+/g, ' ').trim() : '' };
  }, room({ question: { id: 'q2', text: 'پایتخت؟', options: ['الف', 'ب', 'ج', 'د'], difficulty: 'easy' } },
     { round: 2, phase: 'ready', phaseEndsAt: Date.now() + 5000 }));
  ok('and round two is an ordinary round again', later.title === 'آماده‌ای؟' && later.big === false, JSON.stringify(later));
  ok('counted from two', /۲/.test(later.sub), later.sub);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── ASKING FRIENDS INTO THE WAITING ROOM ────────────────────────────────── */
/* «در اتاق انتظار به غیر از افراد آنلاین، دوستان رو هم بتونیم دعوت کنیم.» */
{
  const { ctx, page, errs } = await makePage();
  console.log('adding people to the waiting room:');
  await enter(page, room({}, { status: 'waiting', phase: 'waiting', startsAt: Date.now() + 90000 }));
  await page.waitForTimeout(400);
  await page.evaluate(async () => { await (0, eval)('lsInviteOpen')(); await new Promise((r) => setTimeout(r, 700)); });
  const sheet = await page.evaluate(() => ({
    heads: [...document.querySelectorAll('#lsInvList .pz-inv-head')].map((h) => h.textContent.trim()),
    rows: [...document.querySelectorAll('#lsInvList .pz-inv-row')].map((r) => ({
      name: r.querySelector('.n').childNodes[0].textContent.trim(),
      note: (r.querySelector('.n small') || {}).textContent || '',
      can: !!r.querySelector('button.go')
    }))
  }));
  ok('the sheet has a friends section', sheet.heads.indexOf('دوستان') >= 0, sheet.heads.join(' | '));
  ok('and the lobby section as before', sheet.heads.indexOf('افراد آنلاین') >= 0, sheet.heads.join(' | '));
  ok('friends come first', sheet.heads[0] === 'دوستان', sheet.heads.join(' | '));
  const names = sheet.rows.map((r) => r.name);
  ok('an online friend can be invited', sheet.rows.some((r) => r.name === 'سارا' && r.can), JSON.stringify(sheet.rows));
  /* An invite lasts a minute; somebody who is not there cannot answer it. */
  ok('an offline friend is shown but not offered', sheet.rows.some((r) => r.name === 'نیما' && !r.can && /آفلاین/.test(r.note)), JSON.stringify(sheet.rows));
  /* One person, one row: a friend who is also in the lobby is still one person. */
  ok('nobody is listed twice', new Set(names).size === names.length, names.join(' / '));
  ok('and a stranger in the lobby is still there', names.indexOf('غریبه') >= 0, names.join(' / '));

  posted.length = 0;
  await page.evaluate(() => [...document.querySelectorAll('#lsInvList button.go')]
    .find((b) => b.closest('.pz-inv-row').querySelector('.n').textContent.indexOf('سارا') >= 0).click());
  await page.waitForTimeout(600);
  const sent = posted.find((x) => x.path === '/invites');
  ok('inviting a friend sends a real invite into this room', !!sent && sent.body.roomId === 'R9', JSON.stringify(sent && sent.body));
  ok('as a Last Survivor invite', !!sent && sent.body.mode === 'ls', JSON.stringify(sent && sent.body));
  ok('to that friend', !!sent && sent.body.toUserId === 'f-sara', JSON.stringify(sent && sent.body));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
