/* FOUR THINGS THAT WERE WRONG ON A REAL PHONE.
 *
 *   1. A replaced picture kept showing the old one. The web server marks
 *      artwork fresh for thirty days, so a phone that had already seen the old
 *      winchar never asked again — while a laptop that had never loaded it got
 *      the new one. So the test serves an image, lets the page load it, serves
 *      DIFFERENT bytes under the same name, and asks whether the page now shows
 *      the new ones. Byte-for-byte, not "did it call fetch".
 *
 *   2. The game has to run fullscreen — the phone's status bar and its
 *      home/back bar out of the way.
 *
 *   3. Sent to the shop from a locked door («بلیط نداری»), the first purchase
 *      has to put the player back at that door, not leave them in the shop.
 *
 *   4. The shop panel showed nine items and the game showed thirteen: the four
 *      helps are prepended by the game and were nowhere on the shop page, so
 *      they could not be removed.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

/* A 1×1 PNG in two colours. Same name on the server, different bytes — which is
   exactly what copying a new winchar over the old one does. */
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/* THE SERVER THAT CAUSED THE BUG: artwork is fresh for thirty days, and it
   carries an ETag so a revalidating request can be answered with a 304. */
let artBody = PNG_A;
let artETag = '"a"';
let artRequests = 0, art304s = 0;

/* losechar is the file NOBODY touches — the ordinary case, and the one that
   has to stay cheap. */
let stillRequests = 0, still304s = 0;

const server = http.createServer((q, r) => {
  const url = q.url.split('?')[0];
  if (url === '/losechar.png') {
    stillRequests++;
    if (q.headers['if-none-match'] === '"still"') { still304s++; r.writeHead(304, { ETag: '"still"', 'Cache-Control': 'public, max-age=2592000' }); return r.end(); }
    r.writeHead(200, { 'Content-Type': 'image/png', ETag: '"still"', 'Cache-Control': 'public, max-age=2592000', 'Content-Length': PNG_A.length });
    return r.end(PNG_A);
  }
  if (url === '/winchar.png') {
    artRequests++;
    if (q.headers['if-none-match'] === artETag) { art304s++; r.writeHead(304, { ETag: artETag, 'Cache-Control': 'public, max-age=2592000' }); return r.end(); }
    /* Content-Length matters: a chunked response is not stored, and then there
       is nothing to revalidate against. Real servers send it. */
    r.writeHead(200, { 'Content-Type': 'image/png', ETag: artETag, 'Cache-Control': 'public, max-age=2592000', 'Content-Length': artBody.length });
    return r.end(artBody);
  }
  /* Only .png exists for these two, so the .webp attempt must 404 first. */
  if (/^\/(winchar|losechar)\.(webp|jpg)$/.test(url)) { r.writeHead(404); return r.end('no'); }

  const f = path.join(ROOT, url === '/' ? 'prizze-v643.html' : decodeURIComponent(url));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

/* Every purchase the client can make goes through /orders/quote + /orders/pay,
   so the test drives those and counts what was asked for. */
const orders = [];
/* `routes:false` leaves the context WITHOUT request interception. That matters
   for the artwork block and nowhere else: Playwright's interception bypasses
   the browser's HTTP cache entirely, so a 304 could never be observed through
   it — the very thing being measured would be switched off by the measuring. */
async function makePage(routes = true) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 900, hearts: 5, wallet: 900000 }));
  });
  if (routes) await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    if (p === '/orders/quote') return send({ amount: 12500, currency: 'cash', label: 'بلیط سبز', canPayFromVault: true, vaultBalance: 900000 });
    if (p === '/orders/pay') { orders.push(body.order || {}); return send({ granted: [{ key: 'ticket_green', value: 1, label: 'بلیط سبز' }], amount: 12500 }); }
    if (p === '/economy/prizes') return send({ tickets: [{ key: 'green', ticketValue: 12500, duelPrize: 22500 }] });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 160)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

/* ── 1. A REPLACED PICTURE REPLACES THE OLD ONE ─────────────────────────── */
{
  const { ctx, page, errs } = await makePage(false);
  console.log('artwork that was replaced on the server:');

  /* The bytes the page is actually showing, read back off a canvas — the src
     attribute proves nothing when the browser is serving its own cached copy. */
  const pixel = () => page.evaluate(async () => {
    const img = document.getElementById('resultChar');
    if (!img || !img.src) return null;
    await new Promise((r) => { if (img.complete && img.naturalWidth) return r(); img.addEventListener('load', r, { once: true }); setTimeout(r, 1500); });
    if (!img.naturalWidth) return null;
    const c = document.createElement('canvas'); c.width = 1; c.height = 1;
    c.getContext('2d').drawImage(img, 0, 0, 1, 1);
    const d = c.getContext('2d').getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]].join(',');
  });

  await page.evaluate(() => (0, eval)("pzTryArt(document.getElementById('resultChar'),'winchar',function(){})"));
  await page.waitForTimeout(700);
  const first = await pixel();
  ok('the picture on the server is the one shown', first !== null, String(first));
  const reqAfterFirst = artRequests;

  /* The operator copies a NEW file over the old one, same name. */
  artBody = PNG_B; artETag = '"b"';
  await page.evaluate(() => (0, eval)("pzTryArt(document.getElementById('resultChar'),'winchar',function(){})"));
  await page.waitForTimeout(900);
  const second = await pixel();
  ok('a replaced file is shown without clearing anything', second !== null && second !== first, first + ' → ' + second);
  ok('and the server was actually asked', artRequests > reqAfterFirst, String(artRequests - reqAfterFirst));

  const third = await pixel();
  ok('and it still shows the right picture', third === second, String(third));

  /* THE OTHER HALF: asking has to be CHEAP, or the fix would trade a stale
     picture for a re-download of every picture on every launch. A file nobody
     has touched — which is what almost every picture almost always is — is
     answered with a 304 and no body. That is the difference between
     revalidating and hanging a `?v=` on the URL. */
  for (let k = 0; k < 3; k++) {
    await page.evaluate(() => (0, eval)("pzTryArt(document.getElementById('resultChar'),'losechar',function(){})"));
    await page.waitForTimeout(450);
  }
  ok('an untouched file is asked about every time', stillRequests >= 3, String(stillRequests));
  ok('and answered with a 304, not a download', still304s >= stillRequests - 1,
     'requests ' + stillRequests + ', of which 304: ' + still304s);

  /* A picture that is genuinely not on the server still reports failure, which
     is what every fallback in the app is built on. */
  const missing = await page.evaluate(async () => {
    const img = document.createElement('img'); document.body.appendChild(img);
    return await new Promise((res) => { (0, eval)('pzTryArt')(img, 'no-such-art', (okk) => res(okk)); setTimeout(() => res('timeout'), 4000); });
  });
  ok('a picture that was never uploaded still reports failure', missing === false, String(missing));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. FULLSCREEN ──────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('running fullscreen:');
  const head = await page.evaluate(() => ({
    viewport: (document.querySelector('meta[name=viewport]') || {}).content || '',
    webapp: !!document.querySelector('meta[name="mobile-web-app-capable"][content="yes"]'),
    apple: !!document.querySelector('meta[name="apple-mobile-web-app-capable"][content="yes"]'),
    statusBar: (document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') || {}).content || '',
    manifest: (document.querySelector('link[rel=manifest]') || {}).href || ''
  }));
  /* Without viewport-fit=cover the page cannot draw under the system bars, so
     fullscreen leaves black strips where they used to be. */
  ok('the page may draw under the system bars', /viewport-fit\s*=\s*cover/.test(head.viewport), head.viewport);
  ok('Android is told this is an app', head.webapp, String(head.webapp));
  ok('iOS is told the same', head.apple, String(head.apple));
  ok('and to let the app own the status bar', head.statusBar === 'black-translucent', head.statusBar);
  ok('a manifest is linked', /manifest\.webmanifest$/.test(head.manifest), head.manifest);

  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  ok('the installed app opens fullscreen', mf.display === 'fullscreen', String(mf.display));
  ok('and says so in display_override too', Array.isArray(mf.display_override) && mf.display_override[0] === 'fullscreen', JSON.stringify(mf.display_override));

  /* In a plain browser tab only the Fullscreen API can hide the system bars,
     and only from a user gesture. So a tap has to ask for it. */
  const asked = await page.evaluate(async () => {
    let n = 0;
    const e = document.documentElement;
    e.requestFullscreen = function () { n++; return Promise.resolve(); };
    Object.defineProperty(document, 'fullscreenElement', { get: () => null, configurable: true });
    (0, eval)('pzFullscreenBoot()');
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    return n;
  });
  ok('the first touch asks for fullscreen', asked >= 1, String(asked));

  /* And it must not fight a browser that is already fullscreen. */
  const again = await page.evaluate(async () => {
    let n = 0;
    const e = document.documentElement;
    e.requestFullscreen = function () { n++; return Promise.resolve(); };
    Object.defineProperty(document, 'fullscreenElement', { get: () => e, configurable: true });
    (0, eval)('pzGoFullscreen()');
    await new Promise((r) => setTimeout(r, 40));
    return n;
  });
  ok('already fullscreen asks for nothing', again === 0, String(again));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. BACK TO THE DOOR YOU WERE TURNED AWAY FROM ──────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('sent to the shop with no ticket:');

  /* The duel's entry screen, with no tickets in hand. */
  const flow = await page.evaluate(async () => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; curMode='survivor'; mTickets={green:0,blue:0,red:0}; selectedTicket='green';");
    (0, eval)("go('mode-entry')");
    (0, eval)('ticketEnterDuel()');
    await new Promise((r) => setTimeout(r, 200));
    const modal = (document.querySelector('.aaa-modal, #aaaModal') || document.body).innerText || '';
    return { modal: modal.slice(0, 60), screen: (document.querySelector('.screen.active') || {}).id };
  });
  ok('it says you have no ticket', /بلیط نداری/.test(flow.modal), flow.modal.replace(/\n/g, ' '));

  const wentToShop = await page.evaluate(async () => {
    (0, eval)("goShopTickets('mode-entry')");
    await new Promise((r) => setTimeout(r, 300));
    return { screen: (document.querySelector('.screen.active') || {}).id, remembered: (0, eval)('_pzShopReturn') };
  });
  ok('and takes you to the shop', wentToShop.screen === 'shop', wentToShop.screen);
  ok('remembering the door you came from', wentToShop.remembered === 'mode-entry', String(wentToShop.remembered));

  /* A cash purchase asks how to pay first, so the sheet has to be answered —
     the same two taps the player makes. */
  const buy = async () => page.evaluate(async () => {
    (0, eval)("pzBuyOrder({kind:'ticket',tier:'green',qty:1},'بلیط سبز')");
    await new Promise((r) => setTimeout(r, 400));
    const b = document.getElementById('aaaPrimary');
    const label = b ? b.textContent : '(no sheet)';
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 2100));
    return label;
  });
  const payLabel = await buy();
  ok('the purchase really went through the payment sheet', /صندوق|درگاه/.test(payLabel), payLabel);
  const afterBuy = await page.evaluate(() => ({
    screen: (document.querySelector('.screen.active') || {}).id, remembered: (0, eval)('_pzShopReturn')
  }));
  ok('the first purchase takes you back to that door', afterBuy.screen === 'mode-entry', afterBuy.screen);
  ok('and the errand is finished, not repeated', afterBuy.remembered === null, String(afterBuy.remembered));

  /* The errand is finished the MOMENT it is acted on, not later when the
     navigation happens to clear it: two purchases in the same breath must not
     both try to move the player. */
  const atOnce = await page.evaluate(async () => {
    (0, eval)("goShopTickets('mode-entry')");
    await new Promise((r) => setTimeout(r, 250));
    const acted = (0, eval)('pzShopReturnAfterBuy()');
    const immediately = (0, eval)('_pzShopReturn');
    const again = (0, eval)('pzShopReturnAfterBuy()');
    await new Promise((r) => setTimeout(r, 1500));
    return { acted, immediately, again };
  });
  ok('acting on the errand reports that it did', atOnce.acted === true, String(atOnce.acted));
  ok('and clears it immediately, not on the way out', atOnce.immediately === null, String(atOnce.immediately));
  ok('so a second purchase moves nobody a second time', atOnce.again === false, String(atOnce.again));

  /* A SECOND purchase, made because the player chose to go shopping, must not
     teleport them anywhere. */
  await page.evaluate(async () => { (0, eval)("go('shop')"); await new Promise((r) => setTimeout(r, 250)); });
  await buy();
  const second = await page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
  ok('shopping on purpose leaves you in the shop', second === 'shop', second);

  /* Walking out of the shop without buying cancels the errand too. */
  const forgot = await page.evaluate(async () => {
    (0, eval)("mTickets={green:0,blue:0,red:0}; goShopTickets('lsEntry')");
    await new Promise((r) => setTimeout(r, 250));
    (0, eval)("go('home')");
    await new Promise((r) => setTimeout(r, 200));
    const f = (0, eval)('_pzShopReturn');
    (0, eval)("go('shop')");
    await new Promise((r) => setTimeout(r, 250));
    return f;
  });
  await buy();
  const walkedOutScreen = await page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
  ok('leaving the shop forgets the errand', forgot === null, String(forgot));
  ok('so a later purchase moves nobody', walkedOutScreen === 'shop', walkedOutScreen);

  /* Last Survivor's door is remembered the same way. */
  await page.evaluate(async () => { (0, eval)("mTickets={green:0,blue:0,red:0}; goShopTickets('lsEntry')"); await new Promise((r) => setTimeout(r, 300)); });
  await buy();
  const ls = await page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
  ok('Last Survivor’s door is remembered too', ls === 'lsEntry', ls);
  ok('every purchase really reached the server', orders.length >= 4, String(orders.length));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE SHOP PANEL SHOWS WHAT THE SHOP SHOWS ────────────────────────── */
/* The complaint, exactly: nine items were added in the panel's shop page and
   thirteen cards appeared in the game's «کاربردی» tab, and the extra four could
   not be removed because nothing in the panel mentioned them. So the panel is
   OPENED, with nine shop items and four sellable helps behind it, and the two
   counts are compared against the count the game itself would render. */
{
  console.log('the shop panel and the «کاربردی» shelf:');
  const SHOP_ITEMS = Array.from({ length: 9 }, (_, i) => ({
    id: 'it' + i, name: 'آیتم ' + (i + 1), description: '', icon: '🧰', category: 'util',
    price: 1000 * (i + 1), currency: 'cash', effectKey: 'coin', effectValue: 1, sortOrder: i, enabled: true, rewards: []
  }));
  const LIFELINES = [
    { key: 'p5050', icon: '✂️', label: '۵۰:۵۰', description: '', enabled: true, startingGrant: 2, price: 20000, sellable: true, awardable: true, seconds: 0, sortOrder: 1 },
    { key: 'psecond', icon: '🔁', label: 'انتخاب دوم', description: '', enabled: true, startingGrant: 1, price: 30000, sellable: true, awardable: true, seconds: 0, sortOrder: 2 },
    { key: 'pstats', icon: '📊', label: 'درصد بقیه', description: '', enabled: true, startingGrant: 5, price: 25000, sellable: true, awardable: true, seconds: 0, sortOrder: 3 },
    { key: 'ptime', icon: '⏱️', label: 'وقت اضافه', description: '', enabled: true, startingGrant: 2, price: 15000, sellable: true, awardable: true, seconds: 8, sortOrder: 4 },
    /* A help that is NOT for sale. The game never puts it on the shelf, so the
       panel must not count it either — otherwise the two numbers disagree
       again, in the other direction. */
    { key: 'pskip', icon: '⏭️', label: 'رد کردن سؤال', description: '', enabled: true, startingGrant: 0, price: 18000, sellable: false, awardable: true, seconds: 0, sortOrder: 5 }
  ];
  let savedRows = null;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (/\/admin\/shop\/items$/.test(u.pathname)) return send({ rows: SHOP_ITEMS });
    if (/\/admin\/lifelines$/.test(u.pathname)) {
      if (route.request().method() === 'PUT') { try { savedRows = JSON.parse(route.request().postData() || '{}').rows; } catch (e) {} return send({ rows: savedRows }); }
      return send({ rows: savedRows || LIFELINES });
    }
    if (u.hostname === '127.0.0.1' && u.port === String(PORT)) return route.continue();
    return send({});
  });
  const pp = await ctx.newPage();
  const perrs = []; pp.on('pageerror', (e) => perrs.push(String(e.message || e).slice(0, 160)));
  await pp.goto('http://127.0.0.1:' + PORT + '/pzadmin.html');
  await pp.waitForTimeout(900);
  await pp.evaluate(() => { (0, eval)("API='https://stub.test/v1'; KEY='k'; PERMS=['*']; CUR='shop';"); });
  await pp.evaluate(() => (0, eval)('renderShopAdmin()'));
  await pp.waitForTimeout(700);

  const seen = await pp.evaluate(() => {
    const main = document.getElementById('main');
    const tableRows = main.querySelectorAll('.tbl-wrap table tbody tr');
    /* The shop table is the first .tbl-wrap; the helps card carries its own. */
    const wraps = [...main.querySelectorAll('.tbl-wrap')];
    const count = (w) => w ? [...w.querySelectorAll('tbody tr')].filter((r) => !r.querySelector('.empty')).length : 0;
    return {
      text: main.innerText,
      wraps: wraps.length,
      shopRows: count(wraps[wraps.length - 1]),
      helpRows: count(wraps[0]),
      hasOffButton: /برداشتن از فروشگاه/.test(main.innerHTML),
      helpsCardText: (wraps[0] ? wraps[0].innerText : ''),
      offButtons: (main.innerHTML.match(/shopLifelineOff\(/g) || []).length
    };
  });
  /* The four helps used to be invisible here. Now they are on the page, named,
     priced, and each with the switch that removes them. */
  ok('the helps are on the shop page at all', seen.helpRows === 4, JSON.stringify({ wraps: seen.wraps, helpRows: seen.helpRows }));
  ok('the shop items are still listed', seen.shopRows === 9, String(seen.shopRows));
  ok('every help can be taken off the shelf', seen.offButtons === 4, String(seen.offButtons));
  ok('and the page says the two add up', /\+ این ۴ کمک|این ۴ کمک/.test(seen.text) || /۴ کمک/.test(seen.text), (seen.text.match(/.{0,30}۴ کمک.{0,20}/) || [''])[0]);
  ok('each help is named where it can be found', /۵۰:۵۰/.test(seen.text) && /وقت اضافه/.test(seen.text));
  /* A help the operator has already taken off the shelf is not counted — and
     is offered back, so it can be found again. */
  ok('a help that is not for sale is not counted', !/رد کردن سؤال/.test(seen.helpsCardText), seen.helpsCardText.slice(0, 120).replace(/\n/g, ' '));
  ok('but it is offered back under «خارج از فروشگاه»', /خارج از فروشگاه/.test(seen.text) && /رد کردن سؤال/.test(seen.text), (seen.text.match(/خارج از فروشگاه.{0,40}/) || [''])[0]);

  /* Removing one really writes sellable:false and really removes the card. */
  await pp.evaluate(() => { window.confirm = () => true; });
  await pp.evaluate(() => (0, eval)("shopLifelineOff('p5050')"));
  await pp.waitForTimeout(900);
  const saved = savedRows || [];
  const p5050 = saved.find((r) => r.key === 'p5050') || {};
  ok('taking one off turns its selling off', p5050.sellable === false, JSON.stringify(p5050));
  ok('and leaves the help itself switched on', p5050.enabled === true, String(p5050.enabled));
  ok('and the others are untouched', saved.filter((r) => r.sellable).length === 3, String(saved.filter((r) => r.sellable).length));
  /* And a help can be put back on the shelf from the same place. */
  await pp.evaluate(() => (0, eval)("shopLifelineOn('pskip')"));
  await pp.waitForTimeout(900);
  const back = (savedRows || []).find((r) => r.key === 'pskip') || {};
  ok('and one can be put back on it', back.sellable === true, JSON.stringify(back));
  ok('no panel script errors', perrs.length === 0, perrs.join(' | '));
  await ctx.close();

  const panel = fs.readFileSync(path.join(ROOT, 'pzadmin.html'), 'utf8');

  /* The game prepends exactly what the panel promises: enabled + sellable +
     priced. If those three ever disagree, the counts disagree again. */
  const client = fs.readFileSync(path.join(ROOT, 'prizze-v643.html'), 'utf8');
  const filter = (client.match(/pzLL\.catalog\|\|\[\]\)\.filter\(d=>([^)]*)\)/) || [])[1] || '';
  ok('the game shelves the same three conditions', /d\.enabled/.test(filter) && /d\.sellable/.test(filter) && /d\.price>0/.test(filter), filter);
  const panelFilter = (panel.match(/\(ll\.rows\|\|\[\]\)\.filter\(r=>([^;]*?)\);/) || [])[1] || '';
  ok('and the panel counts by the same three', /r\.enabled/.test(panelFilter) && /r\.sellable/.test(panelFilter) && /r\.price\)>0/.test(panelFilter), panelFilter);
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
