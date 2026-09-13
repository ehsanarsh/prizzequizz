/* WHAT A FAILED TOKEN REFRESH MEANS — AND THE THREE ANSWERS IT NEEDS.
 *
 * From the player's own console:
 *   POST https://prizequiz.ir/v1/auth/refresh 401 (Unauthorized)
 * and the game carried on into the lobby anyway. The boot took «I still have a
 * refresh token saved» as proof of a session, so a token the server had already
 * rejected was walked into the game and every later request refused it. Silent,
 * and indistinguishable from the game being broken.
 *
 * A 401 is knowledge: the token is dead, log in again. A timeout or a 502 is
 * the absence of knowledge, and throwing a live session away over a dropped
 * packet on these networks would be its own bug. Both directions are checked
 * here, because a fix for one that breaks the other is not a fix.
 *
 * Run: node src/tests/browser-authrefresh.mjs */
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

/** Boot the game with a saved session, answering /auth/refresh with `mode`. */
async function boot(mode) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 'stale-access-token');
    localStorage.setItem('pz_rtok', 'the-refresh-token');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'e', displayName: 'ا', level: 5, xp: 9, coins: 9, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  const hits = [];
  await ctx.route('**/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/auth/refresh')) {
      hits.push(mode);
      if (mode === 'dead') return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'TOKEN_INVALID' } }) });
      if (mode === 'down') return route.fulfill({ status: 502, contentType: 'text/plain', body: 'bad gateway' });
      if (mode === 'offline') return route.abort('failed');
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, data: { accessToken: 'fresh-token', refreshToken: 'fresh-refresh' } }) });
    }
    /* Everything else answers «no data», deliberately. A blanket
       {ok:true,data:{}} is not neutral: the hydrate calls apply what they are
       given, and an empty object OVERWRITES the saved player with a blank one —
       which sends the boot to the login screen for a reason that has nothing to
       do with the token being tested here. */
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'stub' } }) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6200);
  const state = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id || '(none)',
    tok: localStorage.getItem('pz_tok'),
    rtok: localStorage.getItem('pz_rtok')
  }));
  await ctx.close();
  return { ...state, hits: hits.length };
}

/* ── the token is dead: say so, and start again ─────────────────────────── */
const dead = await boot('dead');
ok('a rejected refresh token does not walk the player into the game',
   dead.screen === 'login', dead.screen);
ok('and the dead token is not left lying in storage', !dead.tok && !dead.rtok,
   JSON.stringify({ tok: dead.tok, rtok: dead.rtok }));

/* ── the token is fine ──────────────────────────────────────────────────── */
const good = await boot('ok');
ok('a refresh that works carries straight on', good.screen !== 'login', good.screen);
ok('and the fresh token replaces the stale one', good.tok === 'fresh-token', String(good.tok));

/* ── the server said nothing: keep the session ──────────────────────────── */
/* The half that a naive «treat every failure as logged out» would break: on the
   networks this game is played on, a 502 or a dropped connection is a Tuesday. */
const down = await boot('down');
ok('a server that answers 502 does not end the session', down.screen !== 'login', down.screen);
ok('and the token is kept to try again with', down.tok === 'stale-access-token' && down.rtok === 'the-refresh-token',
   JSON.stringify({ tok: down.tok, rtok: down.rtok }));

const offline = await boot('offline');
ok('nor does a phone with no connection at all', offline.screen !== 'login', offline.screen);
ok('and that session is kept too', offline.rtok === 'the-refresh-token', String(offline.rtok));

/* ── AND THE SAME THREE ANSWERS MID-SESSION ─────────────────────────────
   The boot is not the only place a token dies. pzApi meets a 401 on an ordinary
   request, refreshes once and retries — and it decides what to do from the same
   value. `'dead'` and `'unknown'` are both truthy STRINGS, so a plain `if
   (refreshed)` there would read a dead session as a successful refresh and
   retry into the same 401 for ever, never telling the player anything. */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 'stale-access-token');
    localStorage.setItem('pz_rtok', 'the-refresh-token');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'e', displayName: 'ا', level: 5, xp: 9, coins: 9, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  let refreshes = 0, protectedCalls = 0;
  await ctx.route('**/v1/**', (route) => {
    const url = route.request().url();
    if (url.includes('/auth/refresh')) {
      refreshes++;
      /* Alive at boot, dead by the time the player is in the game. */
      if (refreshes === 1) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { accessToken: 'fresh-token', refreshToken: 'the-refresh-token' } }) });
      }
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'TOKEN_INVALID' } }) });
    }
    if (url.includes('/wallet/balance')) {
      protectedCalls++;
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED' } }) });
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'stub' } }) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6200);
  const before = await page.evaluate(() => (document.querySelector('.screen.active') || {}).id || '(none)');
  ok('the player is in the game to start with', before === 'plans', before);

  /* Now the session dies under them. */
  const answered = await page.evaluate(async () => {
    const r = await (0, eval)('pzApi')('GET', '/wallet/balance');
    return r && r.ok === true;
  });
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id || '(none)',
    tok: localStorage.getItem('pz_tok')
  }));
  ok('a request whose refresh is refused does not come back as a success', answered === false, String(answered));
  ok('and the player is sent to log in rather than left in a dead game',
     after.screen === 'login', after.screen);
  ok('with the token that stopped working cleared', !after.tok, String(after.tok));
  ok('and it does not sit there retrying for ever', refreshes <= 3, refreshes + ' refresh attempts');
  await ctx.close();
}

await browser.close(); server.close();
console.log(`[browser-authrefresh] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
