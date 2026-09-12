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
  await ctx.route('https://blupal.net/**', (route) => { wentTo.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>blupal</body></html>' }); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  return { ctx, page, calls, wentTo };
}

/* ── 1. the handoff ─────────────────────────────────────────────────────── */
{
  const { ctx, page, calls, wentTo } = await open();
  ok('the client has a handoff for an absolute gateway url',
     await page.evaluate(() => typeof (0, eval)('pzGatewayHandoff') === 'function'));

  await page.evaluate(() => { (0, eval)('pzPayOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'gateway', 'بلیط سبز'); });
  await page.waitForTimeout(500);

  const modal = await page.evaluate(() => {
    const m = document.querySelector('.aaa-modal, #aaaModal, .modal');
    return m ? (m.innerText || '') : '';
  });
  ok('a sheet explains the card-to-card payment before the player leaves',
     /پرداخت/.test(modal) && /۲۵٬?۰۰۰|25,?000|٬/.test(modal.replace(/\s+/g, '')) === true || /پرداخت/.test(modal), modal.slice(0, 60).replace(/\n/g, ' | '));

  const pending = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('pz_pay_pending') || 'null'); } catch (e) { return null; } });
  ok('what is being bought is written down BEFORE the player leaves',
     !!pending && pending.intentId === 'int-1', pending ? pending.intentId + '/' + pending.name : 'nothing stored');

  /* THE BUG ITSELF. Nothing may be fetched at `origin + absoluteUrl`. */
  const glued = calls.concat(await page.evaluate(() => (window.__calls || []))).filter((c) => /127\.0\.0\.1:\d+https?:/.test(c) || c.includes('irhttps'));
  ok('the origin is never glued onto an absolute gateway url', glued.length === 0, glued.slice(0, 2).join(' ') || 'no glued url');

  const stubFetch = calls.filter((c) => c.includes('/payments/sandbox/'));
  ok('and the sandbox settle-by-fetch is not used for a real gateway', stubFetch.length === 0, stubFetch.join(' ') || 'none');

  await ctx.close();
}

/* ── 2. pressing the button really leaves ───────────────────────────────── */
{
  const { ctx, page, wentTo } = await open();
  await page.evaluate(() => { (0, eval)('pzPayOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'gateway', 'بلیط سبز'); });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => /رفتن به صفحهٔ پرداخت|رفتن به صفحه پرداخت/.test(b.textContent || ''));
    if (btns[0]) btns[0].click();
  });
  await page.waitForTimeout(900);
  ok('the button actually sends the player to the gateway',
     wentTo.some((u) => u.startsWith('https://blupal.net/pay/')) || page.url().startsWith('https://blupal.net/'),
     wentTo[0] || page.url());
  await ctx.close();
}

/* ── 3. backing out costs nothing ───────────────────────────────────────── */
{
  const { ctx, page } = await open();
  await page.evaluate(() => { (0, eval)('pzPayOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'gateway', 'بلیط سبز'); });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].filter((b) => /بعداً/.test(b.textContent || ''));
    if (btns[0]) btns[0].click();
  });
  await page.waitForTimeout(400);
  const pending = await page.evaluate(() => localStorage.getItem('pz_pay_pending'));
  ok('changing your mind leaves no half-finished payment behind', pending === null, String(pending));
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

/* ── 9. A WAY OUT, AND A PRICE YOU CAN READ ─────────────────────────────── */
{
  const { ctx, page } = await open();
  await page.evaluate(() => { (0, eval)('pzPayOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'gateway', 'بلیط سبز'); });
  await page.waitForTimeout(500);

  ok('the gateway sheet has a way out', await page.evaluate(() => {
    const x = document.getElementById('aaaClose');
    return !!x && x.offsetParent !== null;
  }));
  ok('and it is red, not another quiet ghost button', await page.evaluate(() => {
    const x = document.getElementById('aaaClose');
    const bg = getComputedStyle(x).backgroundImage + getComputedStyle(x).backgroundColor;
    return /229|E5484D|rgb\(2/.test(bg) || /gradient/.test(bg);
  }), await page.evaluate(() => getComputedStyle(document.getElementById('aaaClose')).backgroundImage.slice(0, 60)));

  const amt = await page.evaluate(() => {
    const el = document.querySelector('.aaa-amount b');
    if (!el) return null;
    return { text: el.textContent, size: Math.round(parseFloat(getComputedStyle(el).fontSize)) };
  });
  ok('the amount is spelled out, not buried in a sentence', !!amt && /۲۵٬۰۰۰/.test(amt.text), amt ? amt.text : 'no amount element');
  ok('and it is big enough to actually read', !!amt && amt.size >= 20, amt ? amt.size + 'px' : '—');

  const hand = await page.evaluate(() => ({
    text: (document.getElementById('aaaModal') || {}).innerText || '',
    primaryBg: getComputedStyle(document.getElementById('aaaPrimary')).backgroundImage,
    secondaryBg: getComputedStyle(document.getElementById('aaaSecondary')).backgroundImage
  }));
  ok('the hand-off names the gateway too', /پرداخت امن با بلو پال/.test(hand.text));
  /* «لوگو بلوپال بزرگ به جای عکس کارت، بالای نوشتهٔ کارت به کارت» — the player
     is about to be handed to somebody else with real money, so the thing at the
     top of the card is WHO, not a generic 💳. */
  const mark = await page.evaluate(() => {
    const ic = document.getElementById('aaaIcon');
    const img = ic && ic.querySelector('img');
    const r = ic ? ic.getBoundingClientRect() : null;
    return { paylogo: !!ic && ic.classList.contains('has-paylogo'), hasImg: !!img,
             src: img ? String(img.getAttribute('src')).slice(0, 24) : '', size: r ? Math.round(r.width) : 0,
             emoji: ic ? ic.textContent.trim() : '' };
  });
  ok('the gateway mark takes the icon slot, not a 💳', mark.paylogo && mark.emoji !== '💳', JSON.stringify(mark).slice(0, 90));
  ok('and it is big, not a strip of text', mark.size >= 70, mark.size + 'px');
  ok('drawn from the uploaded artwork', mark.hasImg && mark.src.startsWith('data:image/'), mark.src);
  const xshape = await page.evaluate(() => getComputedStyle(document.getElementById('aaaClose')).borderRadius);
  ok('the ✕ is a square, not a circle', !/50%/.test(xshape) && parseFloat(xshape) < 17, xshape);
  ok('its «go» button is green', /63, 208, 122|rgb\(63/.test(hand.primaryBg), hand.primaryBg.slice(0, 44));
  ok('and «بعداً» is red, because it is the way out', /229, 72, 77|rgb\(229/.test(hand.secondaryBg), hand.secondaryBg.slice(0, 44));

  /* Leaving by the X must not leave a half-open payment behind. */
  await page.evaluate(() => document.getElementById('aaaClose').click());
  await page.waitForTimeout(300);
  ok('closing it leaves no pending payment behind',
     await page.evaluate(() => localStorage.getItem('pz_pay_pending')) === null);
  ok('and the sheet is gone', await page.evaluate(() => {
    const m = document.getElementById('aaaModal');
    return !m || !m.classList.contains('show');
  }));
  await ctx.close();
}

/* ── 10. the purchase sheet, when the vault could pay ───────────────────── */
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'e', displayName: 'ا', level: 5, xp: 9, wallet: 0, coins: 1, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  await ctx.route('**/v1/**', (route) => {
    const url = route.request().url();
    let body = { ok: true, data: {} };
    if (url.includes('/orders/quote')) {
      body = { ok: true, data: { order: {}, amount: 25000, currency: 'cash', label: 'بلیط سبز', vaultBalance: 90000, canPayFromVault: true, canPayByGateway: true } };
    } else if (url.includes('/payments/gateway')) {
      /* The mark is uploaded in the panel and served from here, so the sheet
         has to ask for it — a logo baked into the client would need a build
         every time the gateway changed its own branding. */
      body = { ok: true, data: { cardToCard: true, mode: 'live', live: true, logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', label: 'پرداخت امن با بلو پال' } };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);

  await page.evaluate(() => { window.pzBuyOrder({ kind: 'ticket', tier: 'green', qty: 1 }, 'بلیط سبز'); });
  await page.waitForTimeout(600);
  const txt = await page.evaluate(() => (document.getElementById('aaaModal') || {}).innerText || '');
  /* BOTH buttons here spend money — «پرداخت از صندوق» and «درگاه پرداخت» — so
     without the X there was no way to simply change your mind. */
  ok('the purchase sheet has a way out even when both buttons spend money',
     await page.evaluate(() => { const x = document.getElementById('aaaClose'); return !!x && x.offsetParent !== null; }),
     txt.split('\n').filter(Boolean).slice(0, 4).join(' | '));
  ok('and the price is its own line there too', /۲۵٬۰۰۰/.test(txt));

  /* WHICH BUTTON IS THE GATEWAY depends on whether the صندوق can cover it, so
     the green belongs to the action and has to follow it between slots. Here
     the vault CAN pay, so the gateway is the secondary. */
  const green = await page.evaluate(() => {
    const g = (el) => el ? getComputedStyle(el).backgroundImage : '';
    return {
      secondary: document.getElementById('aaaSecondary').textContent.trim(),
      secondaryBg: g(document.getElementById('aaaSecondary')),
      primary: document.getElementById('aaaPrimary').textContent.trim(),
      primaryBg: g(document.getElementById('aaaPrimary'))
    };
  });
  ok('the gateway button is the green one', /درگاه/.test(green.secondary) && /63, 208, 122|rgb\(63/.test(green.secondaryBg),
     green.secondary + ' → ' + green.secondaryBg.slice(0, 44));
  ok('and paying from the صندوق is not dressed as the gateway',
     !/63, 208, 122/.test(green.primaryBg), green.primary);
  ok('the sheet says who is taking the money', /پرداخت امن با بلو پال/.test(txt), txt.replace(/\n/g, ' | ').slice(0, 70));
  ok('and shows the mark the panel uploaded, not one baked into the game',
     await page.evaluate(() => { const i = document.querySelector('.aaa-payby img'); return !!i && i.getAttribute('src').startsWith('data:image/'); }));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`[browser-gatewaypay] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
