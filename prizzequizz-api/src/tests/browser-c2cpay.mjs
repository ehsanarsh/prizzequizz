/* THE PAYMENT SHEET AND THE CARD-TO-CARD PAGE, IN A REAL BROWSER.
 *
 * The server decides what may be paid with and what to say about each method;
 * this checks the client actually OBEYS that instead of deciding for itself.
 * Four things are worth a browser to verify:
 *
 *   - A method the server marked unselectable is SHOWN and disabled, carrying
 *     the server's own sentence. Hiding it would leave the player wondering
 *     where card-to-card went; writing our own sentence would go stale the day
 *     a new reason appears.
 *   - The copy button copies the RAW figure. «۱٬۰۰۰٬۰۴۷» pasted into a banking
 *     app's amount box is a rejected payment.
 *   - CLOSING THE PAGE IS NOT CANCELLING. The payment stays live and activates
 *     by itself, so the close button must not send a cancel.
 *   - The countdown runs off the SERVER's remaining seconds, not the phone's
 *     clock — a device an hour fast would otherwise show a dead deadline.
 *
 * Run: node src/tests/browser-c2cpay.mjs
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); }
};

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 'test-token');
  localStorage.setItem('pz_rtok', 'test-rtoken');
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(1200);

const syntax = errors.filter((m) => /SyntaxError|Unexpected token/i.test(m));
ok('the page still parses and runs', syntax.length === 0, syntax.slice(0, 2).join(' | ') || 'no script errors');

/* One fake API for the whole run. Every call is recorded, which is how
 * «closing does not cancel» is checked at all. */
await page.evaluate(() => {
  window.__calls = [];
  window.__sessionStatus = 'AWAITING';
  /* The fake server keeps the REAL clock, captured before anything can skew
   * the page's. Building its timestamps from a skewed Date.now() would move
   * the deadline along with the phone and quietly prove nothing. */
  const REAL = Date.now.bind(Date);
  window.__realNow = REAL;
  window.pzApi = async (method, path, body) => {
    window.__calls.push({ method, path, body });
    if (path === '/orders/quote') {
      return { ok: true, data: {
        order: body.order, amount: 100000, currency: 'cash', label: 'بلیط قرمز ×۲',
        vaultBalance: 12000, coinBalance: 0, canPayFromVault: false, canPayByGateway: true,
        paymentMethods: [
          { id: 'vault', kind: 'vault', label: 'صندوق جایزه', state: 'live', selectable: false, note: 'موجودی صندوق کافی نیست (۱۲٬۰۰۰ تومان)' },
          { id: 'gw_c2c', kind: 'card_to_card', label: 'کارت به کارت', state: 'live', selectable: true, note: 'تأیید خودکار پس از واریز' },
          { id: 'gw_bank', kind: 'gateway_redirect', label: 'درگاه بانکی', state: 'coming_soon', selectable: false, note: 'به‌زودی' }
        ]
      } };
    }
    if (path === '/orders/pay') {
      return { ok: true, data: {
        method: 'gateway', flow: 'card_to_card', sessionId: 'sess-1', intentId: 'int-1',
        status: 'AWAITING', trackingCode: 'PQ-7K3MQ',
        order: { label: 'بلیط قرمز ×۲', qty: 2 },
        amounts: {
          baseToman: 100000, discountToman: 0, finalToman: 100000, finalTomanText: '۱۰۰٬۰۰۰ تومان',
          payableRial: 1000047, payableRialText: '۱٬۰۰۰٬۰۴۷ ریال', payableRialRaw: '1000047'
        },
        card: { pan: '6274121777044256', panFormatted: '۶۲۷۴ ۱۲۱۷ ۷۷۰۴ ۴۲۵۶', holderName: 'مهدی', bankName: 'بانک سپه' },
        expiresAt: new Date(REAL() + 1200000).toISOString(),
        serverTime: new Date(REAL()).toISOString(), secondsLeft: 1200,
        notice: 'مبلغ را دقیقاً و بدون تغییر واریز کنید؛ حتی یک ریال اختلاف باعث می‌شود پرداخت شناسایی نشود.',
        autoActivate: 'بعد از واریز، خریدت خودکار فعال می‌شود. می‌توانی این صفحه را ببندی.'
      } };
    }
    if (/^\/c2c\/sessions\/[^/]+$/.test(path)) {
      return { ok: true, data: {
        sessionId: 'sess-1', status: window.__sessionStatus, trackingCode: 'PQ-7K3MQ',
        settled: window.__sessionStatus === 'PAID', expiresAt: new Date(REAL() + 1200000).toISOString(),
        serverTime: new Date(REAL()).toISOString(), secondsLeft: 1200,
        granted: window.__sessionStatus === 'PAID' ? [{ key: 'ticket-red', value: 2, label: 'بلیط قرمز' }] : null,
        message: window.__sessionStatus === 'PAID' ? 'پرداختت تأیید شد و خریدت فعال شد. ✅' : 'منتظر واریز شما هستیم.'
      } };
    }
    if (/\/cancel$/.test(path)) {
      window.__sessionStatus = 'CANCELLED';
      return { ok: true, data: {
        sessionId: 'sess-1', status: 'CANCELLED', trackingCode: 'PQ-7K3MQ', settled: false,
        expiresAt: new Date(REAL()).toISOString(), serverTime: new Date(REAL()).toISOString(), secondsLeft: 0,
        granted: null, message: 'این پرداخت لغو شد.'
      } };
    }
    return { ok: true, data: {} };
  };
});

await page.evaluate(() => { window.__buy = window.pzBuyOrder({ kind: 'ticket', tier: 'red', qty: 2 }, 'بلیط قرمز ×۲'); });
await page.waitForTimeout(250);

const sheet = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#pmList .pm-row')];
  return {
    open: document.getElementById('payMethodSheet').classList.contains('show'),
    count: rows.length,
    names: rows.map((r) => r.querySelector('.pm-name').textContent),
    notes: rows.map((r) => r.querySelector('.pm-note').textContent),
    disabled: rows.map((r) => r.hasAttribute('disabled'))
  };
});
ok('the method sheet opens', sheet.open);
ok('with every method the server listed, in that order', sheet.count === 3 && sheet.names[1] === 'کارت به کارت', sheet.names.join(' · '));
ok('the unselectable ones are shown and disabled, not hidden',
  sheet.disabled[0] === true && sheet.disabled[1] === false && sheet.disabled[2] === true,
  sheet.disabled.join(','));
ok('carrying the SERVER’s sentence, not one the client wrote',
  sheet.notes[0].includes('۱۲٬۰۰۰') && sheet.notes[2] === 'به‌زودی', sheet.notes.join(' | '));

/* NOT awaited inside the page: pzPickPayMethod resolves only when the payment
 * page closes, so awaiting it here would hang until the test times out. */
await page.evaluate(() => { window.pzPickPayMethod(1); });
await page.waitForTimeout(300);

const pay = await page.evaluate(() => ({
  open: document.getElementById('c2cSheet').classList.contains('show'),
  amount: document.getElementById('c2cAmount').textContent,
  toman: document.getElementById('c2cAmountToman').textContent,
  pan: document.getElementById('c2cPan').textContent,
  holder: document.getElementById('c2cHolder').textContent,
  bank: document.getElementById('c2cBank').textContent,
  track: document.getElementById('c2cTrack').textContent,
  notice: document.getElementById('c2cNotice').textContent,
  auto: document.getElementById('c2cAuto').textContent,
  clock: document.getElementById('c2cClock').textContent,
  gatewayIdSent: (window.__calls.find((c) => c.path === '/orders/pay') || {}).body
}));
ok('the payment page opens with the exact figure to send', pay.open && pay.amount === '۱٬۰۰۰٬۰۴۷ ریال', pay.amount);
ok('and the round Toman price beside it, so both are recognisable', pay.toman.includes('۱۰۰٬۰۰۰ تومان'), pay.toman);
ok('the destination card, its holder and its bank are all on screen',
  pay.pan.includes('۶۲۷۴') && pay.holder === 'مهدی' && pay.bank === 'بانک سپه');
ok('so is the tracking code to quote to support', pay.track === 'PQ-7K3MQ');
ok('the warning and the auto-activation note come from the server verbatim',
  pay.notice.includes('حتی یک ریال') && pay.auto.includes('خودکار فعال'));
ok('the countdown starts from the SERVER’s remaining seconds and stays zero-padded',
  /^(۲۰:۰۰|۱۹:۵\d)$/.test(pay.clock), pay.clock);
ok('and the chosen gateway id is sent back for re-checking',
  pay.gatewayIdSent && pay.gatewayIdSent.gatewayId === 'gw_c2c' && pay.gatewayIdSent.method === 'gateway',
  JSON.stringify(pay.gatewayIdSent));

/* The copy button is the one place the grouped figure would be a real bug. */
const copied = await page.evaluate(async () => {
  let got = null;
  /* navigator.clipboard is a read-only accessor on the prototype, so a plain
   * assignment silently does nothing and the real (permission-less) clipboard
   * answers instead. */
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: (t) => { got = t; return Promise.resolve(); } }
  });
  window.pzCopyC2c('amount');
  await new Promise((r) => setTimeout(r, 60));
  const amount = got;
  window.pzCopyC2c('pan');
  await new Promise((r) => setTimeout(r, 60));
  return { amount, pan: got };
});
ok('copying the amount gives the raw digits a banking app will accept',
  copied.amount === '1000047', String(copied.amount));
ok('and copying the card gives the bare number', copied.pan === '6274121777044256', String(copied.pan));

/* Closing is not cancelling: the money is still expected and the purchase
 * still activates by itself. */
await page.evaluate(() => { window.__calls.length = 0; window.pzCloseC2c(); });
await page.waitForTimeout(400);
const afterClose = await page.evaluate(() => ({
  cancels: window.__calls.filter((c) => /cancel/.test(c.path)).length,
  polls: window.__calls.filter((c) => /^\/c2c\/sessions/.test(c.path)).length,
  open: document.getElementById('c2cSheet').classList.contains('show')
}));
ok('closing the page cancels nothing', afterClose.cancels === 0);
ok('and asks the server nothing more', afterClose.polls === 0);
ok('the sheet is closed', !afterClose.open);

/* A LEAKED TIMER IS A SECOND POLL LOOP.
 * Closing must clear the pending poll, not just drop the session: an orphan
 * that fires after a NEW payment page is open joins in and schedules itself
 * again, so the page polls at twice the rate it thinks it does — forever. A
 * count is the only way to see that from outside; the timer handles are
 * module-scoped `let`s and deliberately not on window.
 * One loop at the 2s cadence makes 2 calls in 5 seconds; two make 4. */
await page.evaluate(async () => {
  window.__sessionStatus = 'AWAITING';
  const r = await window.pzApi('POST', '/orders/pay', { order: { kind: 'ticket', tier: 'red', qty: 2 } });
  /* Close and reopen WITHOUT a round trip between them, so a poll left pending
   * by the close is certain to fire inside the reopened session — the exact
   * condition that turns one loop into two. Leaving the gap up to the test
   * harness makes this a coin flip on timing. */
  window.pzOpenC2c(r.data, 'بلیط قرمز ×۲');
  await new Promise((res) => setTimeout(res, 300));
  window.pzCloseC2c();
  window.pzOpenC2c(r.data, 'بلیط قرمز ×۲');
  window.__calls.length = 0;
});
await page.waitForTimeout(5200);
const loops = await page.evaluate(() => window.__calls.filter((c) => /^\/c2c\/sessions/.test(c.path)).length);
ok('reopening after a close runs ONE poll loop, not two', loops >= 1 && loops <= 3, `${loops} polls in 5s`);
await page.evaluate(() => { window.pzCloseC2c(); });

/* Reopen and let the poll find a settled payment. */
await page.evaluate(async () => {
  window.__sessionStatus = 'AWAITING';
  const r = await window.pzApi('POST', '/orders/pay', { order: { kind: 'ticket', tier: 'red', qty: 2 } });
  window.pzOpenC2c(r.data, 'بلیط قرمز ×۲');   /* deliberately not awaited */
});
await page.waitForTimeout(300);
await page.evaluate(() => { window.__sessionStatus = 'PAID'; });
await page.waitForTimeout(2600);
const settled = await page.evaluate(() => ({
  live: document.getElementById('c2cLive').style.display,
  done: document.getElementById('c2cDone').style.display,
  msg: document.getElementById('c2cDoneMsg').textContent,
  track: document.getElementById('c2cDoneTrack').textContent
}));
ok('a payment that settles while the page is open switches to the receipt',
  settled.live === 'none' && settled.done === '', `live=${settled.live} done=${settled.done}`);
ok('showing the server’s confirmation and the tracking code',
  settled.msg.includes('تأیید شد') && settled.track === 'PQ-7K3MQ', settled.msg);

/* THE DEADLINE IS THE SERVER'S, NOT THE PHONE'S.
 * Reading the clock on an unskewed device proves nothing — expiresAt and
 * serverTime agree there. Move the device's clock an hour forward: a countdown
 * built from `expiresAt - Date.now()` would show 00:00 and declare the payment
 * dead; one built from the server's `secondsLeft` is unmoved. */
await page.evaluate(() => { window.pzCloseC2c(); });
await page.evaluate(async () => {
  Date.now = () => window.__realNow() + 3600000;
  const r = await window.pzApi('POST', '/orders/pay', { order: { kind: 'ticket', tier: 'red', qty: 2 } });
  window.pzOpenC2c(r.data, 'بلیط قرمز ×۲');
});
await page.waitForTimeout(250);
const skewed = await page.evaluate(() => {
  const c = document.getElementById('c2cClock').textContent;
  Date.now = window.__realNow;
  window.pzCloseC2c();
  return c;
});
ok('a phone whose clock is an hour fast still sees the real deadline',
  /^(۲۰:۰۰|۱۹:۵\d)$/.test(skewed), skewed);

/* faPad2 exists because fa() eats a leading zero — and three other countdowns
 * in the page (matchmaking, the character-call timer) were reading «۰:۵» for
 * the first ten seconds of every minute because of it. */
const pad = await page.evaluate(() => [window.faPad2(0), window.faPad2(5), window.faPad2(20), window.fa(5)]);
ok('a clock keeps its leading zero, where a plain number does not',
  pad[0] === '۰۰' && pad[1] === '۰۵' && pad[2] === '۲۰' && pad[3] === '۵', pad.join(' · '));

const runtime = errors.filter((m) => /is not defined|is not a function|Cannot read/i.test(m));
ok('nothing threw while all that ran', runtime.length === 0, runtime.slice(0, 2).join(' | ') || 'clean');

await browser.close();
server.close();
console.log(`[c2cpay] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
