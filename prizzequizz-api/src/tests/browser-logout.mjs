/* LEAVING MEANS LEAVING.
 *
 * «وقتی خروج زدم و برنامه رو بستم و دوباره باز کردم بازم رفت تو حساب، انگار
 *  اصلاً از حسابم خارج نشده بودم.»
 *
 * «خروج» showed the login screen and did nothing else — the access token, the
 * refresh token and the cached user all stayed exactly where they were, so the
 * next splash found a whole session and walked straight back in. Everything
 * LOOKED right: the login screen appeared, a phone number could be typed, a
 * code even arrived. None of it meant anything.
 *
 * Which is why the assertion that matters here is not «the login screen is
 * shown» — that passed all along. It is: CLOSE THE APP AND OPEN IT AGAIN.
 * This test therefore uses two page loads in the same browser context, so the
 * second one sees whatever the first really left behind.
 *
 * Run: node src/tests/browser-logout.mjs */
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

const USER = { id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, balances: { wallet: 250000, coins: 100, hearts: 5 } };

/** One browser, one storage — so «close and open again» is a second goto. */
async function session(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((u) => {
    /* ONCE, NOT ON EVERY LOAD. addInitScript runs before every page in the
       context, so seeding unconditionally re-planted the session on the second
       load — «close and open again» was really «log in again», and the test
       reported a logout failure that was entirely its own doing. The whole
       point here is that the second load sees what the first LEFT. */
    if (!localStorage.getItem('pz_seeded')) {
      localStorage.setItem('pz_seeded', '1');
      localStorage.setItem('pz_tok', 'access-token-1'); localStorage.setItem('pz_rtok', 'refresh-token-1');
      localStorage.setItem('pz_usr', JSON.stringify(u));
      /* Something of the player's that is NOT the session, to prove logout does
         not sweep up things it never promised to touch. */
      localStorage.setItem('pz_bank_cards', '[{"last4":"4821"}]');
      localStorage.setItem('pz_music_onstart', '1');
    }
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  }, USER);
  const revoked = [];
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let d = {};
    if (u.includes('/auth/logout')) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      revoked.push(b);
      if (opts.logoutFails) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
      d = { revoked: true };
    } else if (u.includes('/auth/refresh')) d = { accessToken: 'access-token-2', refreshToken: 'refresh-token-2' };
    else if (u.includes('/users/me')) d = USER;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  return { ctx, revoked };
}
async function load(ctx) {
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5600);
  return { page, errs };
}
const screen = (page) => page.evaluate(() => ((document.querySelector('.screen.active') || {}).id) || '(none)');
const stored = (page) => page.evaluate(() => ({
  tok: localStorage.getItem('pz_tok'), rtok: localStorage.getItem('pz_rtok'), usr: localStorage.getItem('pz_usr'),
  cards: localStorage.getItem('pz_bank_cards'), music: localStorage.getItem('pz_music_onstart')
}));
/* Through the row in «تنظیمات» and the modal's own button, the way a player
   does it — not by calling the function. */
const logOut = async (page) => {
  await page.evaluate(() => { (0, eval)('confirmLogout()'); });
  await page.waitForTimeout(400);
  await page.click('#aaaPrimary');
  await page.waitForTimeout(1400);
};

console.log('signing out:');
{
  const { ctx, revoked } = await session();
  const { page, errs } = await load(ctx);
  ok('the session starts logged in', (await screen(page)) === 'plans', await screen(page));

  /* What the device is holding at the moment «خروج» is pressed — NOT the
     literal token seeded above. The splash refreshes the session on the way in,
     so by now both tokens have been rotated; asserting the original values
     tested the harness rather than the app. */
  const before = await stored(page);
  await logOut(page);
  ok('it goes to the login screen', (await screen(page)) === 'login', await screen(page));

  /* THE PART THAT WAS MISSING. */
  const st = await stored(page);
  ok('the access token is gone', st.tok === null, String(st.tok));
  ok('the refresh token is gone', st.rtok === null, String(st.rtok));
  ok('and the remembered account is gone', st.usr === null, String(st.usr));
  ok('the session is cleared in memory too', await page.evaluate(() => !(0, eval)('_tok') && !(0, eval)('_usr')));

  /* And the SERVER is told, with the token it can actually revoke — a device
     that merely forgets its keys has not logged out. */
  ok('the server is asked to revoke the session', revoked.length === 1, JSON.stringify(revoked));
  ok('with the refresh token the device actually held',
    revoked[0] && revoked[0].refreshToken === before.rtok, JSON.stringify(revoked[0]) + ' held ' + before.rtok);
  ok('and never the access token', revoked[0] && revoked[0].refreshToken !== before.tok, String(before.tok));

  /* «اطلاعات و تنظیمات ذخیره‌شده باقی می‌مانند» is what the modal promises. */
  ok('saved cards are left alone', st.cards === '[{"last4":"4821"}]', String(st.cards));
  ok('and so are settings', st.music === '1', String(st.music));

  /* ── CLOSE THE APP AND OPEN IT AGAIN ─────────────────────────────────── */
  await page.close();
  const again = await load(ctx);
  ok('reopening the app does NOT walk back into the account',
    (await screen(again.page)) === 'login', await screen(again.page));
  ok('and there is still nothing stored', (await stored(again.page)).tok === null);
  ok('nothing threw', errs.length === 0 && again.errs.length === 0, (errs.concat(again.errs)).join(' | '));
  await ctx.close();
}

console.log('\nwhen the phone has no signal:');
{
  /* A device that cannot reach the server must still be able to log out of
     itself. What it must not do is keep the keys. */
  const { ctx, revoked } = await session({ logoutFails: true });
  const { page } = await load(ctx);
  await logOut(page);
  ok('it still tried to tell the server', revoked.length === 1, JSON.stringify(revoked));
  ok('and the device is cleared anyway', (await stored(page)).tok === null, JSON.stringify(await stored(page)));
  ok('the login screen is shown', (await screen(page)) === 'login', await screen(page));

  await page.close();
  const again = await load(ctx);
  ok('and it stays logged out after reopening', (await screen(again.page)) === 'login', await screen(again.page));
  await ctx.close();
}

console.log('\nchanging your mind:');
{
  const { ctx, revoked } = await session();
  const { page } = await load(ctx);
  const before = await stored(page);
  await page.evaluate(() => { (0, eval)('confirmLogout()'); });
  await page.waitForTimeout(400);
  await page.click('#aaaSecondary');          // «انصراف»
  await page.waitForTimeout(700);
  const st = await stored(page);
  ok('«انصراف» leaves the session exactly as it was',
    st.tok === before.tok && st.rtok === before.rtok && st.usr === before.usr, JSON.stringify(st));
  ok('and there is still a session at all', !!st.tok && !!st.rtok, JSON.stringify(st));
  ok('and tells the server nothing', revoked.length === 0, JSON.stringify(revoked));

  /* And it survives closing the app — «انصراف» must not be a slow logout. */
  await page.close();
  const again = await load(ctx);
  ok('reopening still lands in the account', (await screen(again.page)) === 'plans', await screen(again.page));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n[logout] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
