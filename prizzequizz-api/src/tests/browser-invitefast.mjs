/* «هیچ دعوتی نمیره و اگه بره هم با خیلی تاخیر میره.»
 *
 * Both halves of that sentence were true, and they had different causes.
 *
 * NEVER: the listener was started by one timer, four seconds after the page
 * loaded, and only if a token already existed. Somebody signing in for the
 * first time has no token at that moment — so for the whole of that session
 * nothing ever asked the server whether anybody had invited them. They were not
 * ignoring invitations; they were never told about any.
 *
 * LATE: when it did run, it asked every twelve seconds about an invite that
 * lives sixty. The socket now carries a nudge the instant one exists, and the
 * poll stays underneath as the floor.
 *
 * The WebSocket here is real — Playwright's route interception does not touch
 * sockets — so what is measured is the client actually connecting, listening,
 * and reacting.
 *
 * Run: node src/tests/browser-invitefast.mjs */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import wspkg from '/home/user/prizzequizz/prizzequizz-api/node_modules/ws/index.js';
const { WebSocketServer } = wspkg;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
/* The same path the API serves it on, so the client's own URL derivation is
   what is under test rather than a URL the test handed it. */
const wss = new WebSocketServer({ server, path: '/v1/realtime' });
let sockets = [];
wss.on('connection', (s) => { sockets.push(s); s.on('close', () => { sockets = sockets.filter((x) => x !== s); }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
/* SERVED UNDER A REAL-LOOKING HOSTNAME, on purpose. The client works out its
   own API base from `location`, and deliberately falls back to the production
   IP for `localhost` and `127.0.0.1` — so a page served from the loopback
   address would send its socket to the live server and this test would measure
   nothing. Chromium is told to resolve one invented name to the loopback, and
   the client then derives exactly the URL it derives in production. */
const HOST = 'pz.test';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  /* --no-proxy-server: this machine has an outbound proxy configured, and
     Chromium sends the WebSocket handshake through it, which answers 403. The
     page itself loads either way, so without this the socket silently never
     connects and the test would be measuring nothing. */
  args: ['--no-sandbox', `--host-resolver-rules=MAP ${HOST} 127.0.0.1`, '--no-proxy-server']
});

const USER = { id: 'u-me', username: 'ehsan', displayName: 'احسان', level: 3, xp: 100, balances: { wallet: 0, coins: 50, hearts: 5 } };

/* `signedIn` false is the state a first-time player is really in: no token at
   all when the page loads. */
async function open({ signedIn = true, invites = [] } = {}) {
  const hits = [];
  sockets = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((yes) => {
    if (yes) {
      localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
      localStorage.setItem('pz_usr', JSON.stringify({ id: 'u-me', username: 'ehsan', displayName: 'احسان', level: 3 }));
    }
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  }, signedIn);
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    hits.push({ url: u, at: Date.now() });
    let d = {};
    if (u.includes('/auth/otp/request')) d = { requestId: 'rq-1' };
    else if (u.includes('/auth/otp/verify')) d = { accessToken: 'tok-new', refreshToken: 'ref-new', user: USER };
    else if (u.includes('/auth/refresh')) d = { accessToken: 't2', refreshToken: 'r2' };
    else if (u.includes('/invites/incoming')) d = { invites };
    else if (u.includes('/duel-calls')) d = { calls: [] };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://${HOST}:${PORT}/`, { waitUntil: 'domcontentloaded' });
  return { ctx, page, errs, hits, polls: () => hits.filter((h) => h.url.includes('/invites/incoming')) };
}

/* ── 1. THE ONE THAT MADE INVITES LOOK IGNORED ──────────────────────────── */
console.log('somebody signing in for the first time:');
{
  const { ctx, page, errs, polls } = await open({ signedIn: false });
  /* Past the four-second timer that used to be the only chance to start
     listening — with no token, because they have not signed in yet. */
  await page.waitForTimeout(6000);
  ok('nothing is listened for while signed out', polls().length === 0, String(polls().length));

  await page.evaluate(() => { (0, eval)("_rid='rq-1'"); (0, eval)("go('otp')"); });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelectorAll('#otpBoxes input').forEach((b, i) => { b.value = String(i + 1); });
    return (0, eval)('realVerifyOtp()');
  });
  await page.waitForTimeout(3000);
  /* Before the fix this was zero for the rest of the session, however long the
     player stayed. Not late — never. */
  ok('but signing in starts it', polls().length > 0, String(polls().length));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. AN ALREADY-SIGNED-IN SESSION ────────────────────────────────────── */
console.log('somebody who was already signed in:');
{
  const { ctx, page, errs, polls } = await open();
  await page.waitForTimeout(7000);
  ok('it starts on its own', polls().length > 0, String(polls().length));
  ok('and the socket is connected, not only the poll', sockets.length > 0, String(sockets.length));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE NUDGE ───────────────────────────────────────────────────────── */
console.log('when the server says one is waiting:');
{
  const { ctx, page, errs, polls } = await open();
  await page.waitForTimeout(7000);
  const before = polls().length;
  ok('a socket is open to be nudged over', sockets.length > 0, String(sockets.length));
  sockets.forEach((s) => s.send(JSON.stringify({ type: 'server:nudge', payload: { kind: 'invite', inviteId: 'inv-9' } })));
  /* Well inside the twelve-second poll, which is the entire point: a second is
     not a twelfth of an invite's life. */
  await page.waitForTimeout(1200);
  ok('it asks at once, without waiting for the next tick', polls().length > before, before + ' → ' + polls().length);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. AND THE INVITE ACTUALLY APPEARS ─────────────────────────────────── */
console.log('and the invitation itself:');
{
  const inv = [{ id: 'inv-9', fromUserId: 'u-rez', fromName: 'رضا', mode: 'duel', ticketTier: 'green', coinStake: 0, roomId: '', roomTopic: '' }];
  const { ctx, page, errs } = await open({ invites: inv });
  await page.waitForTimeout(7000);
  sockets.forEach((s) => s.send(JSON.stringify({ type: 'server:nudge', payload: { kind: 'invite' } })));
  await page.waitForTimeout(1500);
  const shown = await page.evaluate(() => {
    const m = document.getElementById('aaaModal');
    return m && m.classList.contains('show') ? m.innerText.replace(/\s+/g, ' ') : '';
  });
  ok('the player is asked, by name', /رضا/.test(shown), shown.slice(0, 90));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. COMING BACK TO THE APP ──────────────────────────────────────────── */
console.log('coming back to the tab:');
{
  /* The phone was in a pocket: the browser drops the socket and freezes the
     timers, so the moment of return is exactly when something is most likely to
     be waiting and least likely to be heard. */
  const { ctx, page, errs, polls } = await open();
  await page.waitForTimeout(7000);
  const before = polls().length;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(800);
  ok('it asks straight away rather than waiting out the tick', polls().length > before, before + ' → ' + polls().length);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. AFTER A REFUSAL, THE BUTTON IS NOT THERE ────────────────────────── */
console.log('somebody who already said no:');
{
  /* The server refuses a repeat invite either way. This is so the person is not
     left pressing a button that can only ever refuse them — and so they are
     told WHY, because a button that is simply gone reads as a broken app and
     the obvious next move is to try again. */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u-me', username: 'ehsan', displayName: 'احسان', level: 3 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let d = {};
    if (u.includes('/users/online')) d = { onlineTotal: 2, coins: 100, nextCost: 0, charged: 0, players: [
      { userId: 'u-free', username: 'sara', displayName: 'سارا', level: 2, avatar: null, character: null,
        inMatch: false, invitePending: false, recentlyRefused: false, canInvite: true, lastSeen: new Date().toISOString() },
      { userId: 'u-said-no', username: 'reza', displayName: 'رضا', level: 4, avatar: null, character: null,
        inMatch: false, invitePending: false, recentlyRefused: true, canInvite: false, lastSeen: new Date().toISOString() }
    ] };
    else if (u.includes('/auth/refresh')) d = { accessToken: 't2', refreshToken: 'r2' };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://${HOST}:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5600);
  await page.evaluate(() => { (0, eval)("go('online')"); return (0, eval)('onlineLoad()'); });
  await page.waitForTimeout(700);
  const cards = await page.evaluate(() => [...document.querySelectorAll('#onList .online-card')].map((c) => ({
    text: c.innerText.replace(/\s+/g, ' ').trim(),
    invite: !!c.querySelector('.pz-invite-go')
  })));
  /* The card prints the USERNAME, which is how the game names people
     everywhere; matching on the display name finds nothing. */
  const said = cards.find((c) => /reza/.test(c.text));
  const free = cards.find((c) => /sara/.test(c.text));
  ok('the one who is free can still be invited', !!free && free.invite, JSON.stringify(free));
  ok('the one who said no cannot', !!said && !said.invite, JSON.stringify(said));
  ok('and is told why, rather than left with a gap', !!said && /رد کرده/.test(said.text), JSON.stringify(said));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n[invitefast] ${pass} passed, ${fail} failed`);
await browser.close(); wss.close(); server.close();
process.exit(fail ? 1 : 0);
