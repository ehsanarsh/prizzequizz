/* LEAVING THE GAME TO PAY, AND COMING BACK WITH THE TICKET.
 *
 * The gateway used to be a stub on our own server, so `paymentUrl` was always
 * a RELATIVE path and the client could fetch it to settle. A card-to-card
 * gateway is not that: `paymentUrl` is BluPal's own page, absolute, on their
 * domain, and the player goes there, opens a banking app, transfers, and comes
 * back minutes later — sometimes in a different tab.
 *
 * The old code did `origin + paymentUrl` unconditionally. Switched on against
 * a real gateway it would have built `https://prizequiz.irhttps://blupal…`,
 * fetched nothing, polled eight times and told every single paying player
 * «پرداخت هنوز تأیید نشده» — while their money was gone. That is the bug this
 * file exists to make impossible.
 *
 * Run: node src/tests/browser-gatewaypay.mjs */
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

const GATEWAY_URL = 'https://blupal.net/pay/9001';

/** A fresh page with the session primed and every /v1 call recorded. */
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((o) => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
    if (o.pending) localStorage.setItem('pz_pay_pending', JSON.stringify(o.pending));
    window.__calls = [];
  }, opts);

  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    const url = req.url();
    let body = { ok: true, data: {} };
    if (url.includes('/orders/pay')) {
      body = { ok: true, data: { method: 'gateway', intentId: 'int-1', amount: 25000, status: 'pending', paymentUrl: GATEWAY_URL } };
    } else if (url.includes('/payments/gateway')) {
      body = { ok: true, data: opts.brand ?? { cardToCard: true, mode: 'live', live: true,
        logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        label: 'پرداخت امن با بلو پال' } };
    } else if (/\/payments\/intents\/[^/]+\/verify/.test(url)) {
      body = { ok: true, data: opts.verify ?? { id: 'int-1', status: 'paid', paid: true } };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const page = await ctx.newPage();
  const calls = [];
  page.on('request', (r) => { if (r.url().includes('/v1/')) calls.push(r.method() + ' ' + r.url()); });
  page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 120)));
  /* The gateway's own page is not ours to load; record the handoff instead. */
  const wentTo = [];
  await ctx.route('https://blupal.net/**', (route) => {
    wentTo.push(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>blupal</body></html>' });
  });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  return { ctx, page, calls, wentTo };
}

/* ── 1. leaving for the gateway ─────────────────────────────────────────── */
{
  const { ctx, page, calls, wentTo } = await open();
  ok('the client has a way out to an absolute gateway url',
     await page.evaluate(() => typeof (0, eval)('pzGatewayGo') === 'function'));
  /* The second sheet is gone: the door is chosen on the one payment sheet and
     the green button on it is the decision. Leaving the old function behind
     would be a second way to reach a screen nobody can get to any more. */
  ok('and the old second sheet is not still in the file',
     await page.evaluate(() => (0, eval)('typeof pzGatewayHandoff')) === 'undefined',
     await page.evaluate(() => (0, eval)('typeof pzGatewayHandoff')));

  await page.evaluate(() => { (0, eval)('pzPayOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'gateway', 'بلیط سبز'); });
  await page.waitForTimeout(900);
  /* «What was bought is written down before leaving» is checked in section 2,
     on the installed path: once this window has gone to the gateway there is no
     longer any of OUR origin's storage to read, and both paths write the note
     in the same place before they branch. */

  ok('and the player really goes to the gateway',
     wentTo.some((u) => u.startsWith('https://blupal.net/pay/')) || page.url().startsWith('https://blupal.net/'),
     wentTo[0] || page.url());

  /* THE OLD BUG. Nothing may be fetched at `origin + absoluteUrl`. */
  const glued = calls.concat(await page.evaluate(() => (window.__calls || []))).filter((c) => /127\.0\.0\.1:\d+https?:/.test(c) || c.includes('irhttps'));
  ok('the origin is never glued onto an absolute gateway url', glued.length === 0, glued.slice(0, 2).join(' ') || 'no glued url');

  const stubFetch = calls.filter((c) => c.includes('/payments/sandbox/'));
  ok('and the sandbox settle-by-fetch is not used for a real gateway', stubFetch.length === 0, stubFetch.join(' ') || 'none');
  await ctx.close();
}

/* ── 2. AN INSTALLED GAME IS NOT NAVIGATED AWAY FROM ────────────────────── */
/*
 * «وقتی بازی رو تو هوم‌اسکرین می‌کنی و پرداخت می‌کنی، دوباره از کروم باز می‌شه…
 *  و از اول ورود می‌کنه و کد و تلفن می‌خواد.»
 *
 * `location.href = url` points the app's OWN window at the gateway. The
 * gateway is outside the app's scope, so Android hands the window to Chrome and
 * the installed app — session and all — is gone; whatever the gateway redirects
 * to afterwards lands in a browser that has never seen this player. What is
 * checked here is that an installed game opens the gateway BESIDE itself and
 * stays where it is.
 */
async function installed(openResult, blocked) {
  await openResult.page.evaluate((b) => {
    Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
    window.__opens = [];
    window.open = (u) => { window.__opens.push(String(u)); return b ? null : { closed: false, focus() {} }; };
  }, blocked);
}
{
  const r = await open();
  await installed(r, false);
  await r.page.evaluate(() => { (0, eval)('pzPayOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'gateway', 'بلیط سبز'); });
  await r.page.waitForTimeout(900);
  const opens = await r.page.evaluate(() => window.__opens || []);
  ok('an installed game opens the gateway beside itself', opens.some((u) => u.startsWith('https://blupal.net/')), JSON.stringify(opens));
  ok('and does NOT hand its own window over', r.page.url().startsWith('http://127.0.0.1:'), r.page.url());
  const pending = await r.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('pz_pay_pending') || 'null'); } catch (e) { return null; } });
  /* THE ORDER OF EVENTS, checked where it can be seen: the note that says what
     is being bought is on disk before the player is sent anywhere. A navigation
     kills every variable in the frame, so a note written afterwards is a note
     that is never written at all. */
  ok('and what is being bought was written down BEFORE they were sent',
     !!pending && pending.intentId === 'int-1' && pending.name === 'بلیط سبز',
     pending ? pending.intentId + '/' + pending.name : 'nothing stored');
  await r.ctx.close();
}
{
  /* A blocked popup, or a webview that swallows it. Not being able to pay at
     all would be worse than coming back through Chrome, so the old navigation
     is still there underneath. */
  const r = await open();
  await installed(r, true);
  await r.page.evaluate(() => { (0, eval)('pzPayOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'gateway', 'بلیط سبز'); });
  await r.page.waitForTimeout(1200);
  ok('and when the browser refuses to open it, the player still gets there',
     r.wentTo.some((u) => u.startsWith('https://blupal.net/')) || r.page.url().startsWith('https://blupal.net/'),
     r.wentTo[0] || r.page.url());
  await r.ctx.close();
}

/* ── 3. COMING BACK TO A GAME THAT WAS NEVER CLOSED ─────────────────────── */
/*
 * The check used to run in exactly one place — 1.8 seconds after boot — which
 * was written for the only way back there used to be: the app had been
 * navigated away, so returning meant a fresh start. Now the app stays open
 * beside the payment page, and returning to it is not a boot at all. Without
 * this, a player who paid in the other tab comes back to a shop that does not
 * know it.
 */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
    localStorage.setItem('pz_pay_pending', JSON.stringify({ intentId: 'int-9', name: 'بلیط سبز', amount: 25000, at: Date.now() }));
  });
  /* The transfer has not landed yet — and then, while the game sits there, it
     does. Nothing about the page changes in between. */
  let paidNow = false;
  const verifies = [];
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let body = { ok: true, data: {} };
    if (/\/payments\/intents\/int-9\/verify/.test(u)) {
      verifies.push(Date.now());
      body = { ok: true, data: paidNow ? { id: 'int-9', status: 'paid', paid: true } : { id: 'int-9', status: 'pending', paid: false, reason: 'status_pending' } };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);          /* the boot check runs and finds nothing */
  const atBoot = verifies.length;
  ok('the boot check still runs', atBoot >= 1, atBoot + ' call(s)');
  ok('and an unfinished transfer is kept', await page.evaluate(() => !!localStorage.getItem('pz_pay_pending')));

  paidNow = true;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await page.waitForTimeout(2500);
  ok('returning to the game asks again, without a reload', verifies.length > atBoot,
     atBoot + ' → ' + verifies.length);
  ok('and the ticket is delivered on the spot',
     await page.evaluate(() => localStorage.getItem('pz_pay_pending')) === null,
     String(await page.evaluate(() => localStorage.getItem('pz_pay_pending'))));
  await ctx.close();
}

/* ── 3b. a return is not a reason to hammer the server ──────────────────── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
    localStorage.setItem('pz_pay_pending', JSON.stringify({ intentId: 'int-8', name: 'x', amount: 25000, at: Date.now() }));
  });
  const verifies = [];
  await ctx.route('**/v1/**', (route) => {
    if (/\/payments\/intents\/int-8\/verify/.test(route.request().url())) verifies.push(1);
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { id: 'int-8', status: 'pending', paid: false, reason: 'status_pending' } }) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  const before = verifies.length;
  /* Six taps back and forth in one second is one return, not six. */
  for (let i = 0; i < 6; i++) { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); }
  await page.waitForTimeout(1500);
  ok('flicking between apps does not fire a burst of checks',
     verifies.length - before <= 3, before + ' → ' + verifies.length);
  await ctx.close();
}

/* ── 4. coming back, paid ───────────────────────────────────────────────── */
{
  const { ctx, page, calls } = await open({
    pending: { intentId: 'int-1', name: 'بلیط سبز', amount: 25000, at: Date.now() },
    verify: { id: 'int-1', status: 'paid', paid: true }
  });
  await page.waitForTimeout(2600);
  const verified = calls.filter((c) => c.startsWith('POST') && c.includes('/payments/intents/int-1/verify'));
  ok('coming back asks the SERVER whether the transfer arrived', verified.length >= 1, verified.length + ' call(s)');

  const cleared = await page.evaluate(() => localStorage.getItem('pz_pay_pending'));
  ok('a confirmed payment is finished and not asked about again', cleared === null, String(cleared));
  await ctx.close();
}

/* ── 5. coming back too early ───────────────────────────────────────────── */
{
  const { ctx, page } = await open({
    pending: { intentId: 'int-1', name: 'بلیط سبز', amount: 25000, at: Date.now() },
    verify: { id: 'int-1', status: 'pending', paid: false, reason: 'status_pending' }
  });
  await page.waitForTimeout(9000);
  const still = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('pz_pay_pending') || 'null'); } catch (e) { return null; } });
  ok('a transfer still on its way is kept, not thrown away', !!still && still.intentId === 'int-1',
     still ? 'kept' : 'DROPPED — the player would lose the purchase they paid for');
  await ctx.close();
}

/* ── 6. an expired invoice ──────────────────────────────────────────────── */
{
  const { ctx, page } = await open({
    pending: { intentId: 'int-1', name: 'بلیط سبز', amount: 25000, at: Date.now() },
    verify: { id: 'int-1', status: 'pending', paid: false, reason: 'status_expired' }
  });
  await page.waitForTimeout(9000);
  const still = await page.evaluate(() => localStorage.getItem('pz_pay_pending'));
  ok('an expired invoice is cleared so the player can start again', still === null, String(still));
  await ctx.close();
}

/* ── 7. a payment forgotten for a day ───────────────────────────────────── */
{
  const { ctx, page, calls } = await open({
    pending: { intentId: 'old', name: 'x', amount: 1, at: Date.now() - 25 * 3600 * 1000 },
    verify: { id: 'old', status: 'paid', paid: true }
  });
  await page.waitForTimeout(2600);
  const asked = calls.filter((c) => c.includes('/payments/intents/old/verify'));
  ok('a payment left open since yesterday is not silently completed today', asked.length === 0, asked.length + ' call(s)');
  const gone = await page.evaluate(() => localStorage.getItem('pz_pay_pending'));
  ok('and the stale note is cleared rather than kept forever', gone === null, String(gone));
  await ctx.close();
}

/* ── 8. no session, no check ────────────────────────────────────────────── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { localStorage.setItem('pz_pay_pending', JSON.stringify({ intentId: 'int-1', name: 'x', amount: 1, at: Date.now() })); });
  const page = await ctx.newPage();
  const calls = [];
  page.on('request', (r) => { if (r.url().includes('/v1/')) calls.push(r.url()); });
  await ctx.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  ok('a logged-out visitor is not made to verify somebody\'s payment',
     calls.filter((c) => c.includes('/verify')).length === 0);
  await ctx.close();
}

/* The sheet itself — the doors, the balance, the one green button — is driven
   in browser-paysheet.mjs, which is where it now lives. */

await browser.close(); server.close();
console.log(`[browser-gatewaypay] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
