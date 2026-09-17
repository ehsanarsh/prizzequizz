/* NOBODY PLAYS WITHOUT A NAME.
 *
 * «باز مشکل ثبت نام کاربر با نام بازیکن جدید و user_1789659165304 بازم هست در
 *  پنل مدیریت من این اسامی رو میبینم در حالی که کاربر نوشته اسمشو.»
 *
 * The live database has ten accounts still called «بازیکن جدید», and four of
 * them have PLAYED or SPENT MONEY. An account is created the moment the SMS
 * code is verified — before a name is ever asked for — so six of the ten are
 * simply people who got a code and closed the app, and nothing was lost. The
 * other four got past the sign-up form and into the game, which should not be
 * possible.
 *
 * It was possible because the rule lived in exactly ONE place: an `if` at the
 * end of the splash. That check is correct and it is not enough — it sends a
 * nameless account to the login screen, and the moment anything at all calls
 * go('home') afterwards the player is in the game permanently, because nothing
 * ever asks a second time.
 *
 * So the rule now lives in go() itself, and this is what holds it there: not
 * "the splash sends them to the right place" but "there is no way in".
 *
 * Run: node src/tests/browser-mustregister.mjs */
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

/* The three shapes an unfinished account comes in, exactly as the server makes
   them: no name, the game's own placeholder name, and a placeholder username. */
const NAMELESS = { id: 'u1', username: 'user_1789659165304', displayName: 'بازیکن جدید', level: 1, xp: 0, balances: { wallet: 0, coins: 350, hearts: 5 } };
const NAMED = { ...NAMELESS, username: 'ehsan', displayName: 'احسان' };
/* HALF-FINISHED IS ALSO UNFINISHED, and it has to be tested as its own case.
   The first version of this used only the both-placeholder account — so either
   half of the rule could be deleted and every assertion still passed, because
   the other half was carrying it. These are the two shapes that tell them
   apart, and they are not hypothetical: the save writes the display name and
   the username in one call, and a username clash returns 409 with neither
   stored, so a retry that gets one and not the other is exactly this. */
const NO_DISPLAY_NAME = { ...NAMELESS, username: 'ehsan', displayName: 'بازیکن جدید' };
const NO_USERNAME = { ...NAMELESS, username: 'user_1789659165304', displayName: 'احسان رستمی' };

async function boot(usr, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(([u, noTok]) => {
    /* `noTok` is the state an expired session leaves behind: _pzAuthLost()
       drops the token and deliberately keeps the cached user. */
    if (u) { if (!noTok) { localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r'); } localStorage.setItem('pz_usr', JSON.stringify(u)); }
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  }, [usr, !!opts.noToken]);
  const patched = [];
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let d = {};
    if (u.includes('/auth/refresh')) d = { accessToken: 't2', refreshToken: 'r2' };
    else if (u.includes('/auth/login')) d = { otpRequired: true, requestId: 'rq1', ttlSeconds: 120, resendAfterSeconds: 60, phone: '09121234567', testMode: false };
    else if (u.includes('/auth/otp/verify')) d = { accessToken: 't', refreshToken: 'r', user: opts.verifyAs || NAMELESS };
    else if (route.request().method() === 'PATCH' && /\/users\/me$/.test(u)) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      patched.push(b);
      d = { ...NAMELESS, displayName: b.displayName, username: b.username, referral: { applied: false } };
    } else if (u.includes('/users/me')) d = usr || {};
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5600);
  return { ctx, page, patched, errs };
}
const screen = (page) => page.evaluate(() => ((document.querySelector('.screen.active') || {}).id) || '(none)');
const goTo = async (page, id) => { await page.evaluate((t) => { try { (0, eval)("go('" + t + "')"); } catch (e) {} }, id); await page.waitForTimeout(220); return screen(page); };

/* ── 1. THERE IS NO WAY IN ──────────────────────────────────────────────── */
console.log('an account that never chose a name:');
{
  const { ctx, page, errs } = await boot(NAMELESS);
  ok('the splash does not drop it into the game', (await screen(page)) === 'login', await screen(page));

  /* EVERY door, not just the one the splash happens to use. Each of these is a
     real call site in this file — the nav, a purchase returning the player, a
     result screen's home button, a deep link. */
  for (const target of ['home', 'shop', 'rankings', 'friends', 'mode-entry', 'wallet', 'profile', 'settings', 'leagues', 'missions', 'plans', 'support', 'stats']) {
    const landed = await goTo(page, target);
    ok(`go('${target}') lands on the sign-up form instead`, landed === 'register', landed);
  }
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. AND THE SIGN-UP ITSELF STILL WORKS ──────────────────────────────── */
console.log('\nthe sign-up screens are not caught by their own rule:');
{
  const { ctx, page } = await boot(NAMELESS);
  for (const target of ['login', 'otp', 'register', 'character']) {
    const landed = await goTo(page, target);
    ok(`'${target}' is still reachable`, landed === target, landed);
  }
  await ctx.close();
}

/* ── 3. A PLAYER WITH A NAME IS NOT TOUCHED ─────────────────────────────── */
console.log('\nan account that finished signing up:');
{
  const { ctx, page, errs } = await boot(NAMED);
  ok('goes straight in', (await screen(page)) === 'plans', await screen(page));
  for (const target of ['home', 'shop', 'rankings', 'wallet']) {
    const landed = await goTo(page, target);
    ok(`go('${target}') goes to '${target}'`, landed === target, landed);
  }
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3b. HALF A SIGN-UP IS NOT A SIGN-UP ────────────────────────────────── */
console.log('\nwhen only one half of the name was saved:');
for (const [label, who] of [['no display name', NO_DISPLAY_NAME], ['no username', NO_USERNAME]]) {
  const { ctx, page } = await boot(who);
  const landed = await goTo(page, 'home');
  ok(`${label} is still unfinished, and still gated`, landed === 'register', landed);
  await ctx.close();
}

/* ── 3c. A THIN ANSWER FROM THE SERVER MUST NOT STRAND ANYBODY ──────────── */
console.log('\nwhen the server hands back less than it used to:');
{
  /* `_usr` is replaced wholesale in five places, GET /users/me among them. An
     older server, a partial response, a shape that changes next year — any of
     them can leave it without a displayName. Reading that absence as «never
     registered» would bounce a paying player onto a sign-up form for an account
     they finished months ago, which is far worse than the hole being closed.
     The game's own placeholders are proof; a blank is not. */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((u) => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify(u));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  }, NAMED);
  /* Everything answers with an empty object — exactly what a stubbed or thinner
     /users/me does, and what several other suites in this folder already do. */
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    const d = u.includes('/auth/refresh') ? { accessToken: 't2', refreshToken: 'r2' } : {};
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5600);
  const thin = await page.evaluate(() => JSON.stringify((0, eval)('_usr')));
  /* This used to assert that `_usr` really HAD been thinned out — the state the
     gate had to survive. pzHydrateAll now merges instead of replacing, so the
     thinning cannot happen at all any more and the old assertion was left
     describing a hazard that had been removed rather than one being handled.
     What is still true, and still worth holding, is that the server sent a
     thin answer and the player kept their name through it. */
  ok('a thin answer did not take the name away', /displayName/.test(thin), thin.slice(0, 70));
  const landed = await goTo(page, 'home');
  ok('and a real player is still let into the game', landed === 'home', landed);
  await ctx.close();
}

/* ── 3d. A THIN ANSWER MUST NOT ERASE WHO THE PLAYER IS ─────────────────── */
console.log('\nafter a thin answer from the server:');
{
  /* pzHydrateAll took whatever /users/me returned and made it the WHOLE of
     `_usr`, then wrote that over the copy in localStorage. A response without
     an `id` therefore deleted the id — and not just for this page load, for
     every one after it. The app stopped knowing who it was: «بلاک کردن» was
     offered on the player's own profile, because the id it compares against
     was gone. A field the server did not send is a field it did not mention. */
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((u) => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify(u));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  }, { ...NAMED, id: 'u-42' });
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    /* What a real thin /users/me looks like: the fields it does carry, and
       nothing of the identity. */
    const d = u.includes('/auth/refresh') ? { accessToken: 't2', refreshToken: 'r2' }
      : u.includes('/users/me') ? { avatar: null, character: null } : {};
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5600);

  ok('the app still knows who it is', await page.evaluate(() => (0, eval)('pzMyId()')) === 'u-42',
    await page.evaluate(() => (0, eval)('pzMyId()')));
  ok('and the name did not vanish with it', await page.evaluate(() => ((0, eval)('_usr') || {}).username) === 'ehsan',
    JSON.stringify(await page.evaluate(() => (0, eval)('_usr'))));
  ok('what the server DID send is still applied', await page.evaluate(() => 'avatar' in ((0, eval)('_usr') || {})));
  /* And it survives the next load, which is the half that made this permanent. */
  const stored = await page.evaluate(() => localStorage.getItem('pz_usr'));
  ok('the remembered copy was not overwritten with the thin one', /u-42/.test(String(stored)), String(stored).slice(0, 80));
  await ctx.close();
}

/* ── 4. NOBODY LOGGED IN AT ALL IS NOT BOUNCED EITHER ───────────────────── */
console.log('\nwith no session at all:');
{
  const { ctx, page } = await boot(null);
  ok('the app opens on the login screen', (await screen(page)) === 'login', await screen(page));
  /* The rule is about an account with no NAME, not about being logged out —
     firing it here would trap a first-time visitor on a form for an account
     that does not exist yet. */
  const landed = await goTo(page, 'home');
  ok('and the rule does not fire', landed === 'home', landed);
  await ctx.close();
}
{
  /* AND THE HALFWAY STATE: the session expired but the browser still remembers
     who it was. _pzAuthLost() clears the token and keeps the cached user on
     purpose, so this is a state the app really passes through. Gating here
     would strand an unfinished account on a form it has no token to submit —
     a dead end with no way out but clearing the browser. */
  const { ctx, page } = await boot(NAMELESS, { noToken: true });
  const landed = await goTo(page, 'home');
  ok('an expired session is not trapped on the form', landed === 'home', landed);
  await ctx.close();
}

/* ── 5. FINISHING THE FORM LETS YOU THROUGH ─────────────────────────────── */
console.log('\nfilling the form in:');
{
  const { ctx, page, patched, errs } = await boot(NAMELESS);
  await goTo(page, 'register');
  await page.fill('#regFullName', 'احسان رستمی');
  await page.fill('#regUsername', 'ehsan');
  await page.selectOption('#regGender', 'male');
  await page.click('#register .btn-primary');
  await page.waitForTimeout(900);

  ok('the name is sent to the server', patched.length === 1 && patched[0].displayName === 'احسان رستمی', JSON.stringify(patched));
  ok('and so is the username', patched.length === 1 && patched[0].username === 'ehsan', JSON.stringify(patched[0] && patched[0].username));
  /* The gate must open the moment the name lands — a player who has just
     registered and is still bounced back to the form would be stuck for good. */
  const landed = await goTo(page, 'home');
  ok('the game opens once the name is saved', landed === 'home', landed);
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n[mustregister] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
