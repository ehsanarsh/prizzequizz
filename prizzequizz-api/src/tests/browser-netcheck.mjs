/* THE GAME ON A NETWORK THAT IS NOT THE OPEN INTERNET.
 *
 *   • «سایت فقط با فیلترشکن باز میشه» — the page had a render-blocking
 *     stylesheet on fonts.googleapis.com. A host that is unreachable is not
 *     skipped: the browser holds the paint until the request times out, which
 *     is why the same file opened on one phone, hung on the next, and always
 *     opened through a VPN. Nothing outside our own origin may be in the
 *     critical path.
 *   • «مینویسه اینترنت شما قطعه و میندازه بیرون» while Last Survivor plays
 *     fine on the same phone, in the same minute. Last Survivor talks over
 *     plain requests; the duel trusted the websocket. A socket that is being
 *     dropped rather than closed stays «open» — send() succeeds and the answer
 *     goes nowhere. So: the answer must reach the server anyway, and a dead
 *     socket alone must not be reported as a dead internet.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

/* Every request the page makes is answered here, and every request it makes to
   anywhere else is refused — this server IS the origin. */
const posts = [];
/* Who the server says is inside the match, flipped by the test. */
let presentUserIds = [];
const gets = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      posts.push({ path: u.pathname, body: (() => { try { return JSON.parse(body); } catch { return body; } })() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: {} }));
    });
    return;
  }
  if (/\/v1\/matches\/[^/]+$/.test(u.pathname)) {
    gets.push(u.pathname);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: { matchId: 'M9', phase: 'lobby', round: 0, players: [], presentUserIds } }));
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(ROOT, 'prizze-v643.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data: {} }));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const ORIGIN = () => 'http://' + HOST + ':' + PORT;

/* A REAL HOSTNAME, because the game decides where its server is by looking at
   the one it was opened from: a page on a real host talks to its own origin,
   and only a file:// or a localhost page falls back to the development IP.
   Serving this test from 127.0.0.1 would test the development path and prove
   nothing about the phone in someone's hand. */
const HOST = 'pz.test';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--host-resolver-rules=MAP ' + HOST + ' 127.0.0.1']
});

/* ── 1. NOTHING OUTSIDE OUR OWN ORIGIN ──────────────────────────────────── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const outside = [];
  /* Every third-party host is a black hole, exactly as it is on the networks
     this game is played on: the request is not refused, it simply never
     answers. A page that needs one would hang here. */
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith(ORIGIN()) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      outside.push(url);
      return;                                   // never resolved — a dead host
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));

  console.log('the page on a network with no way out:');
  const t0 = Date.now();
  await page.goto(ORIGIN() + '/', { waitUntil: 'domcontentloaded' });
  /* The splash sits for ~5.2s by design; the point is that something is PAINTED
     long before that and the wait is ours, not a timeout on a foreign host. */
  await page.waitForSelector('body', { state: 'attached' });
  const painted = await page.evaluate(() => {
    const b = document.body;
    return { ink: getComputedStyle(b).backgroundColor, kids: b.children.length };
  });
  const ms = Date.now() - t0;
  ok('it renders without waiting on anyone else', painted.kids > 0 && ms < 5000, ms + 'ms, ' + painted.kids + ' nodes');
  ok('and asked no third-party host for anything', outside.length === 0, outside.slice(0, 3).join(' | '));

  /* The Persian font must be the real one, carried by the page itself. */
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].map((f) => f.family);
    return { has: faces.includes('Vazirmatn'), count: faces.length,
             used: getComputedStyle(document.body).fontFamily,
             ready: document.fonts.check('700 16px Vazirmatn') };
  });
  ok('the Persian font travels with the page', font.has && font.ready, JSON.stringify(font));
  ok('and it is the font the game asks for', /Vazirmatn/.test(font.used), font.used);

  /* Not just the first paint. The splash runs for ~5.2s and then the home
     screen builds itself, pulling config, categories, wallet and avatars — if
     any of that reached outside our own origin, the game would still be broken
     on the same phones, just a few seconds later. */
  await page.waitForTimeout(6500);
  const shown = await page.evaluate(() => {
    const on = [...document.querySelectorAll('.screen')].filter((s) => s.classList.contains('active')).map((s) => s.id);
    return { on: on.join(','), body: (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) };
  });
  ok('it gets all the way to a real screen', !!shown.on || shown.body.length > 0, JSON.stringify(shown));
  ok('and still nothing outside our own origin', outside.length === 0, outside.slice(0, 3).join(' | '));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. A SOCKET THAT LIES ──────────────────────────────────────────────── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u0', username: 'p0', displayName: 'من', level: 3, coins: 50, hearts: 5 }));
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto(ORIGIN() + '/');
  await page.waitForTimeout(5200);
  console.log('a duel on a link that drops the live socket:');

  /* A socket that reports itself OPEN and swallows everything sent to it —
     the real failure, not a closed one. */
  const setup = await page.evaluate((round) => {
    const rt = (0, eval)('pzRt');
    rt.active = true; rt.finished = false; rt.matchId = 'M1'; rt.myId = 'u0';
    rt.ackByRound = {};
    window.__sent = [];
    rt.ws = { readyState: 1, send(s) { window.__sent.push(s); } };   // open, and a black hole
    (0, eval)('pzConn').lastPongAt = Date.now() - 60_000;             // no pong for a minute
    (0, eval)('pzConn').restOkAt = Date.now();                        // but requests work
    window._pzQs = window._pzQs || [];
    window._pzQs[round] = { _id: 'q-' + round, c: 0 };
    (0, eval)('duelRoundQs')[round] = { _id: 'q-' + round, c: 0 };
    return { live: (0, eval)('pzNetLive')() };
  }, 3);
  ok('the phone knows its own internet is fine', setup.live === true, JSON.stringify(setup));

  posts.length = 0;
  await page.evaluate(() => (0, eval)('pzWsSubmit')(3, 1));
  await page.waitForTimeout(400);
  const answer = posts.find((p) => /\/matches\/M1\/answer$/.test(p.path));
  const onSock = await page.evaluate(() => window.__sent.length);
  ok('the answer does not go into the silent socket', onSock === 0, 'ws sends: ' + onSock);
  ok('it goes to the server by the road that works', !!answer, answer ? answer.path : posts.map((p) => p.path).join(','));
  ok('carrying the round the player answered', !!answer && Number(answer.body.round) === 3, answer ? JSON.stringify(answer.body.round) : '');
  ok('and an idempotency key of their own', !!answer && /^a-M1-u0-3-/.test(String(answer.body.idempotencyKey || '')), answer ? String(answer.body.idempotencyKey) : '');

  /* The banner: a dead socket on a live phone is not «اینترنت شما قطع است». */
  const said = await page.evaluate(() => {
    (0, eval)('pzConnEvalMine')();
    return { state: (0, eval)('pzConn').mine, text: (document.getElementById('pzConnTxt') || {}).textContent || '' };
  });
  ok('and the player is not told their internet is gone', said.state === 'wsonly' && !/قطع شده است/.test(said.text), JSON.stringify(said));
  ok('but is told the match carries on', /پشتیبان/.test(said.text), said.text);

  /* AND THEN IT GOES AWAY. It is news, not a fault the player can act on, and
     on a network that never carries a socket it would otherwise sit across the
     screen for the whole match. */
  await page.waitForTimeout(5200);
  const gone = await page.evaluate(() => {
    const b = document.getElementById('pzConnBanner');
    return { shown: !!(b && b.classList.contains('show')), state: (0, eval)('pzConn').mine };
  });
  ok('and the notice does not camp on the screen', !gone.shown, JSON.stringify(gone));
  ok('while the state itself is unchanged', gone.state === 'wsonly', gone.state);

  /* Truly offline — no socket, no requests getting through — must still say so. */
  const dead = await page.evaluate(() => {
    (0, eval)('pzConn').restOkAt = Date.now() - 60_000;
    (0, eval)('pzConnEvalMine')();
    return { state: (0, eval)('pzConn').mine, text: (document.getElementById('pzConnTxt') || {}).textContent || '' };
  });
  ok('a phone that really is cut off is still told so', dead.state === 'down' && /قطع شده است/.test(dead.text), JSON.stringify(dead));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. A HEALTHY SOCKET IS STILL THE FAST PATH ─────────────────────────── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u0', username: 'p0', displayName: 'من', level: 3, coins: 50, hearts: 5 }));
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto(ORIGIN() + '/');
  await page.waitForTimeout(5200);
  console.log('a duel on a link that works:');

  await page.evaluate((round) => {
    const rt = (0, eval)('pzRt');
    rt.active = true; rt.finished = false; rt.matchId = 'M2'; rt.myId = 'u0'; rt.ackByRound = {};
    window.__sent = [];
    rt.ws = { readyState: 1, send(s) { window.__sent.push(s); } };
    (0, eval)('pzConn').lastPongAt = Date.now();                      // answering right now
    (0, eval)('duelRoundQs')[round] = { _id: 'q-' + round, c: 0 };
  }, 2);

  posts.length = 0;
  await page.evaluate(() => (0, eval)('pzWsSubmit')(2, 0));
  await page.waitForTimeout(300);
  const early = posts.filter((p) => /\/matches\/M2\/answer$/.test(p.path)).length;
  const sock = await page.evaluate(() => window.__sent.length);
  ok('the socket carries it', sock === 1, 'ws sends: ' + sock);
  ok('and nothing is sent twice while it is trusted', early === 0, 'http posts: ' + early);

  /* …unless the server never confirms it. Then the second road is taken. */
  await page.waitForTimeout(1600);
  const late = posts.filter((p) => /\/matches\/M2\/answer$/.test(p.path)).length;
  ok('an unconfirmed answer is re-sent the other way', late === 1, 'http posts: ' + late);

  /* And when the server DOES confirm it, the second copy is not sent. */
  await page.evaluate((round) => {
    const rt = (0, eval)('pzRt'); rt.matchId = 'M3'; rt.ackByRound = {};
    (0, eval)('pzConn').lastPongAt = Date.now();
    (0, eval)('duelRoundQs')[round] = { _id: 'q-' + round, c: 0 };
    (0, eval)('pzWsSubmit')(round, 0);
    /* the server's verdict on my own answer, arriving on the socket */
    (0, eval)('pzHandleWs')({ type: 'server:answer_result', payload: { userId: 'u0', round: round, questionId: 'q-' + round, correct: true, selectedIndex: 0, correctIndex: 0 } });
  }, 4);
  posts.length = 0;
  await page.waitForTimeout(1700);
  const acked = posts.filter((p) => /\/matches\/M3\/answer$/.test(p.path)).length;
  ok('a confirmed answer is not sent again', acked === 0, 'http posts: ' + acked);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE DUEL GATE WITH NO SOCKET AT ALL ─────────────────────────────── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u0', username: 'p0', displayName: 'من', level: 3, coins: 50, hearts: 5 }));
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto(ORIGIN() + '/');
  await page.waitForTimeout(5200);
  console.log('an opponent found on a network with no websocket:');

  /* The gate the duel cannot start without. No socket at all — not a closed
     one, none — which is the state a player is in on these networks. */
  presentUserIds = [];
  const alone = await page.evaluate(async () => {
    const rt = (0, eval)('pzRt');
    rt.active = true; rt.finished = false; rt.matchId = 'M9'; rt.myId = 'u0';
    rt.oppPresent = false; rt.presence = 1; rt.ws = null;
    const t0 = Date.now();
    const got = await (0, eval)('pzWaitOpponentPresent')(2500);
    return { got, ms: Date.now() - t0 };
  });
  ok('an opponent who never turns up is still a no-show', alone.got === false, JSON.stringify(alone));
  ok('and the game does not sit there for ever waiting', alone.ms < 4000, alone.ms + 'ms');

  /* Now the server says the opponent is in the room. The socket is STILL dead;
     this is the whole point — the duel used to be unable to learn this and sent
     every player home with «حریف به بازی متصل نشد». */
  presentUserIds = ['u7'];
  gets.length = 0;
  const together = await page.evaluate(async () => {
    const rt = (0, eval)('pzRt');
    rt.active = true; rt.finished = false; rt.matchId = 'M9'; rt.myId = 'u0';
    rt.oppPresent = false; rt.presence = 1; rt.ws = null;
    const t0 = Date.now();
    const got = await (0, eval)('pzWaitOpponentPresent')(8000);
    return { got, ms: Date.now() - t0, opp: rt.oppPresent };
  });
  ok('the opponent is found without a socket', together.got === true, JSON.stringify(together));
  ok('by asking the server directly', gets.length > 0, gets.length + ' reads of the match');
  ok('and quickly — this gate is in front of every duel', together.ms < 3000, together.ms + 'ms');

  /* THE ORDINARY CASE: I get there first and the opponent arrives a moment
     later. The gate has to keep asking — a single question at the start would
     only ever catch an opponent who was already waiting. */
  presentUserIds = [];
  const walksIn = setTimeout(() => { presentUserIds = ['u7']; }, 1200);   // the opponent turns up
  const arrives = await page.evaluate(async () => {
    const rt = (0, eval)('pzRt');
    rt.active = true; rt.finished = false; rt.matchId = 'M9'; rt.myId = 'u0';
    rt.oppPresent = false; rt.presence = 1; rt.ws = null;
    const t0 = Date.now();
    const got = await (0, eval)('pzWaitOpponentPresent')(8000);
    return { got, ms: Date.now() - t0 };
  });
  ok('an opponent who arrives a second late is still found', arrives.got === true, JSON.stringify(arrives));
  ok('and not before they actually arrive', arrives.ms > 900, arrives.ms + 'ms');
  clearTimeout(walksIn);

  /* And my own presence is not confused with the opponent's: a room containing
     only me is not an opponent. */
  presentUserIds = ['u0'];
  const onlyMe = await page.evaluate(async () => {
    const rt = (0, eval)('pzRt');
    rt.active = true; rt.finished = false; rt.matchId = 'M9'; rt.myId = 'u0';
    rt.oppPresent = false; rt.presence = 1; rt.ws = null;
    return await (0, eval)('pzWaitOpponentPresent')(2000);
  });
  ok('seeing only myself in the room is not an opponent', onlyMe === false, String(onlyMe));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
server.close();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
