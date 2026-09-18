/* THE GAME SAYS WHAT BROKE, INSTEAD OF NOTHING AT ALL.
 *
 * The server has had a crash-report table all along and the game never posted
 * to it once — so every crash on every player's phone happened in silence, and
 * the only way one was ever learned about was a player opening a ticket about
 * it in their own words.
 *
 * What this holds, in the browser where it actually runs:
 *   — it sends at all, and the first thing checked is that it sends NOTHING
 *     private: a message and a URL carry whatever was in scope.
 *   — one crash in a loop does not become a thousand posts.
 *   — the reporter cannot become a bug of its own: it never throws, and it
 *     never reports itself.
 *
 * Run: node src/tests/browser-errsend.mjs */
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
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

async function open() {
  const posted = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 1 }));
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    if (req.url().includes('/monitoring/reports')) {
      let b = {}; try { b = JSON.parse(req.postData() || '{}'); } catch (e) {}
      posted.push({ body: b, auth: req.headers()['authorization'] || '' });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) });
    }
    const d = req.url().includes('/auth/refresh') ? { accessToken: 't2', refreshToken: 'r2' } : {};
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  return { ctx, page, posted };
}

/* ── 1. IT SENDS, AND IT SENDS NOTHING PRIVATE ──────────────────────────── */
console.log('when the game throws:');
{
  const { ctx, page, posted } = await open();
  await page.evaluate(() => {
    /* A message shaped exactly the way a real one is: the thing that failed,
       and the player's own details dragged along with it. */
    setTimeout(() => { throw new Error('login failed for 09121234567 token=at_' + 'ab12cd34'.repeat(4) + ' otp=4209'); }, 0);
  });
  await page.waitForTimeout(600);
  ok('it reaches the server at all', posted.length >= 1, String(posted.length));
  const b = (posted[0] || {}).body || {};
  ok('the phone number did not go with it', !JSON.stringify(b).includes('09121234567'), String(b.message).slice(0, 60));
  ok('nor the token', !JSON.stringify(b).includes('at_ab12'), String(b.message).slice(0, 80));
  ok('nor the SMS code', !/4209/.test(JSON.stringify(b)), String(b.message).slice(0, 80));
  ok('but the crash is still recognisable', /login failed/.test(String(b.message)), String(b.message).slice(0, 60));
  ok('and it says which build it came from', String(b.appVersion || '').length > 0, String(b.appVersion));
  ok('and which screen the player was on', /#/.test(String(b.route || '')), String(b.route));
  ok('it is attributed to the player, so «how many people» is answerable',
     /^Bearer /.test((posted[0] || {}).auth || ''), (posted[0] || {}).auth || '(none)');
  await ctx.close();
}

/* ── 2. A CRASH IN A LOOP IS STILL ONE REPORT ───────────────────────────── */
console.log('when the same crash happens over and over:');
{
  const { ctx, page, posted } = await open();
  await page.evaluate(() => {
    /* What a bug inside a render loop really looks like — the line number
       moves, the crash does not. Posting each one would bury every other bug
       and fill the table by morning. */
    for (let i = 0; i < 40; i++) setTimeout(() => { throw new Error('TypeError: fit of undefined at line ' + i); }, 0);
  });
  await page.waitForTimeout(900);
  ok('it is sent once, not forty times', posted.length === 1, String(posted.length));

  /* A DIFFERENT crash must still get through — deduping by «anything already
     sent» would silence the second bug of the session for ever. */
  await page.evaluate(() => { setTimeout(() => { throw new Error('RangeError: something else entirely'); }, 0); });
  await page.waitForTimeout(500);
  ok('and a different crash is not swallowed with it', posted.length === 2, String(posted.length));

  /* A page can also fail in many DIFFERENT ways at once — a bad deploy, a
     missing global, everything downstream of it throwing something new. Each
     one passes the per-kind check, so without a ceiling on the session the
     first minute after a bad release is a flood. */
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) setTimeout(() => { throw new Error('distinct failure kind ' + String.fromCharCode(65 + i)); }, 0);
  });
  await page.waitForTimeout(900);
  ok('and twenty different crashes at once still stop at a handful', posted.length <= 8, String(posted.length));
  await ctx.close();
}

/* ── 3. A PROMISE NOBODY CAUGHT ─────────────────────────────────────────── */
console.log('when a promise rejects with nobody listening:');
{
  /* Most of this app is async. An unhandled rejection is the ordinary way a
     failure escapes here, and window.onerror does not see one. */
  const { ctx, page, posted } = await open();
  await page.evaluate(() => { Promise.reject(new Error('ReferenceError: pzThing is not defined')); });
  await page.waitForTimeout(600);
  ok('that is reported too', posted.length === 1, String(posted.length));
  ok('with its own message', /pzThing/.test(String((posted[0] || {}).body?.message || '')), JSON.stringify((posted[0] || {}).body?.message));
  await ctx.close();
}

/* ── 4. THE REPORTER IS NOT A SECOND BUG ────────────────────────────────── */
console.log('when the reporting itself cannot work:');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 1 }));
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  /* Every call fails, including the reporter's own. A reporter that throws on a
     failed send would report THAT, fail again, and never stop. */
  await ctx.route('**/v1/**', (route) => route.abort());
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  const before = errs.length;
  await page.evaluate(() => { setTimeout(() => { throw new Error('boom with no server'); }, 0); });
  await page.waitForTimeout(700);
  ok('the page does not spiral', errs.length - before <= 1, errs.slice(before).join(' | '));
  const st = await page.evaluate(() => window._pzErrState());
  ok('and it recorded the one kind it tried to send', st.total === 1, JSON.stringify(st));
  await ctx.close();
}

/* ── 5. A BROKEN IMAGE IS NOT A CRASH ───────────────────────────────────── */
console.log('when an image fails to load:');
{
  /* Resource errors fire on the same event. They are a network story — a photo
     that did not arrive — and posting them would fill the programmers' queue
     with things no programmer can fix. */
  const { ctx, page, posted } = await open();
  await page.evaluate(() => {
    const i = document.createElement('img');
    i.src = '/definitely-not-here-' + Date.now() + '.png';
    document.body.appendChild(i);
  });
  await page.waitForTimeout(700);
  ok('it is not reported as a crash', posted.length === 0, JSON.stringify(posted.map((p) => p.body.message)));
  await ctx.close();
}

console.log(`\n[errsend] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
