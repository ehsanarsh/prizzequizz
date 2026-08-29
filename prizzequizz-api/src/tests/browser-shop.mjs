/* THE SHOP OPENS ON THE SHOP, NOT ON LAST VERSION'S SHOP.
 *
 * «الان وقتی فروشگاه رو باز می‌کنی اول طرح قدیمی فروشگاه میاد، کارت‌های بزرگ
 *  بلیط، بعد از چند ثانیه طرح جدید و فعلی میاد … نمی‌خوام کدهای قدیمی و
 *  صفحاتی که برای ورژن قدیمی بود بمونن و باعث باگ بشن.»
 *
 * The ticket shelf had a fallback: if the catalogue was not loaded, draw the
 * three big config-driven cards the previous version used. The catalogue is
 * NEVER loaded on the first open — the request is still in flight — so the
 * fallback ran every single time and the old design was the first thing anyone
 * saw. This drives the real open, with the catalogue answering slowly, and
 * asks what is on the screen at each moment.
 */
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

const TICKETS = [
  { id: 's1', category: 'tickets', icon: '🎫', name: 'بلیط سبز', description: 'ورودی مسابقه', price: 12500, effectKey: 'ticket', currency: 'cash' },
  { id: 's2', category: 'tickets', icon: '🎟️', name: 'بستهٔ سه‌تایی', description: 'سه بلیط', price: 33000, effectKey: 'ticket', currency: 'cash' }
];

async function open(catalogue, delayMs) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 500000, coins: 100, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  await ctx.route('**/v1/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (/\/shop\/items/.test(p)) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { items: catalogue } }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  return { browser, page };
}

/* THE OLD SHELF, described exactly as it was: three cards, each a coloured
   block with the tier's own name and «تعداد تو». */
const OLD_MARKERS = ['ورودی مسابقه\nجایزهٔ برد', 'تعداد تو'];

console.log('opening the shop while the catalogue is still in flight:');
{
  /* Slower than the splash on purpose. pzLoadShop also runs at boot, so a delay
     shorter than the ~5.4s start-up means the catalogue has already answered by
     the time the shop is opened — and the one moment this test exists for never
     happens. */
  const { browser, page } = await open(TICKETS, 9000);
  await page.evaluate(() => { try { go('shop'); } catch (e) {} });
  await page.waitForTimeout(300);
  await page.evaluate(() => { try { (0, eval)('renderShop')('tickets'); } catch (e) {} });
  await page.waitForTimeout(200);

  const early = await page.evaluate((markers) => {
    const c = document.getElementById('shopContent');
    const txt = (c.textContent || '').replace(/\s+/g, ' ');
    return { txt, cards: c.querySelectorAll('.shop-grid > .item').length,
             note: !!c.querySelector('.shop-note'),
             dots: c.querySelectorAll('.shop-note-dots i').length,
             oldish: markers.some((m) => txt.includes(m.replace('\n', ' '))) };
  }, OLD_MARKERS);
  ok('nothing from the old shelf is drawn', early.oldish === false, early.txt.slice(0, 60));
  ok('no product cards are invented before the catalogue answers', early.cards === 0, String(early.cards));
  ok('it says it is still fetching them', early.note && /در حال گرفتن/.test(early.txt), early.txt.slice(0, 40));
  ok('and it looks like waiting, not like a broken shelf', early.dots === 3);

  /* And when the catalogue lands, the real cards — with no second design in
     between. */
  await page.waitForFunction(() => (0, eval)('shopWaiting')() === false, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const late = await page.evaluate(() => {
    const c = document.getElementById('shopContent');
    return { txt: (c.textContent || '').replace(/\s+/g, ' '),
             cards: c.querySelectorAll('.shop-grid > .item').length,
             note: !!c.querySelector('.shop-note') };
  });
  ok('the real shelf arrives', late.cards === 2, late.cards + ' cards');
  ok('with the operator’s own items on it', /بستهٔ سه‌تایی/.test(late.txt), late.txt.slice(0, 50));
  ok('and the waiting line is gone', late.note === false);
  await browser.close();
}

console.log('when the operator has put no tickets up:');
{
  const { browser, page } = await open([], 300);
  await page.evaluate(() => { try { go('shop'); } catch (e) {} });
  await page.waitForTimeout(1600);
  await page.evaluate(() => { try { (0, eval)('renderShop')('tickets'); } catch (e) {} });
  await page.waitForTimeout(300);
  const empty = await page.evaluate(() => {
    const c = document.getElementById('shopContent');
    return { txt: (c.textContent || '').replace(/\s+/g, ' '),
             cards: c.querySelectorAll('.shop-grid > .item').length,
             loaded: (0, eval)('shopWaiting')() === false };
  });
  ok('the catalogue is known to have answered', empty.loaded === true);
  ok('it says the shelf is empty, rather than inventing one', /هنوز بلیطی/.test(empty.txt), empty.txt.slice(0, 50));
  ok('and still no cards', empty.cards === 0, String(empty.cards));
  await browser.close();
}

console.log('and when the request fails outright:');
{
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'e', displayName: 'a', level: 1, xp: 0, wallet: 0, coins: 0, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (/\/shop\/items/.test(p)) return route.abort();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  await page.evaluate(() => { try { go('shop'); } catch (e) {} });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { try { (0, eval)('renderShop')('tickets'); } catch (e) {} });
  await page.waitForTimeout(300);
  const failed = await page.evaluate(() => ({
    loaded: (0, eval)('shopWaiting')() === false,
    txt: (document.getElementById('shopContent').textContent || '').replace(/\s+/g, ' ')
  }));
  /* A FAILED request is not «the shelf is empty». Opening the shop fires another
     fetch, so the honest thing to say is still «loading» — telling a player the
     operator has listed nothing, because their phone was briefly offline, is a
     lie they would act on. */
  ok('a failure does not become «nothing for sale»', /در حال گرفتن/.test(failed.txt), failed.txt.slice(0, 50));
  ok('and the shelf is still described as waiting', failed.loaded === false);
  await browser.close();
}

console.log(`\n[shop] ${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
