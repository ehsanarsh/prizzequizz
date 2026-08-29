/* THE ADVERT PLAYS THROUGH, WHATEVER THE PLAYER IS TAPPING.
 *
 * «در صفحهٔ انتخاب بلیط، هم در دوئل و هم در آخرین بازمانده، وقتی بلیط رو انتخاب
 *  می‌کنی اون بنر تبلیغات دوباره از اول پخش می‌شه … باید بدون دخالت هیچ چیزی
 *  پخش بشه و تموم شه و دوباره پخش بشه.»
 *
 * Choosing a ticket rebuilds the card, and the banner was rebuilt with it —
 * the same markup written back, which is still a NEW <video> element starting
 * at zero. Nothing about that is visible in the markup: the proof is that the
 * element survives, and that its playhead keeps moving across a re-render.
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 500000, coins: 100, hearts: 4, plan: 'premium' }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/* A banner in both ticket slots, as an operator would have set one. */
await page.evaluate(() => {
  const b = (slot) => ({ slot, title: 'جایزهٔ بزرگ', text: 'همین هفته', kind: 'image',
    media: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' });
  (0, eval)('PZ_BANNERS=window.__B'); // set below
});
await page.evaluate(() => {
  window.__B = { duel: [{ slot: 'duel', title: 'جایزهٔ بزرگ', text: 'همین هفته', kind: 'image',
    media: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }],
    lastSurvivor: [{ slot: 'lastSurvivor', title: 'آخرین بازمانده', text: 'بمان تا آخر', kind: 'image',
      media: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }] };
  (0, eval)('PZ_BANNERS=window.__B');
});

for (const [label, hostId, slot] of [['duel', 'promoDuel', 'duel'], ['last survivor', 'promoLs', 'lastSurvivor']]) {
  console.log('the ' + label + ' ticket screen:');
  const first = await page.evaluate((x) => {
    const host = document.getElementById(x.hostId);
    host.innerHTML = '';
    (0, eval)('pzPromoRender')(x.slot, x.hostId);
    const el = host.querySelector('.tk-promo');
    if (el) el.dataset.pzStamp = 'first';       // survives only if the node does
    return { painted: !!el, txt: (host.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) };
  }, { hostId, slot });
  ok('the banner is painted', first.painted, first.txt);

  /* Re-render it the way choosing a ticket does — several times over. */
  const again = await page.evaluate((x) => {
    for (let i = 0; i < 4; i++) (0, eval)('pzPromoRender')(x.slot, x.hostId);
    const host = document.getElementById(x.hostId);
    const el = host.querySelector('.tk-promo');
    return { same: !!(el && el.dataset.pzStamp === 'first'), count: host.querySelectorAll('.tk-promo').length };
  }, { hostId, slot });
  ok('choosing a ticket does not replace it', again.same, again.same ? 'same element' : 'a new element was built');
  ok('and does not stack a second one', again.count === 1, String(again.count));

  /* And when the operator DOES change the banner, the screen follows. */
  const changed = await page.evaluate((x) => {
    window.__B[x.slot] = [{ slot: x.slot, title: 'بنر تازه', text: 'عوض شد', kind: 'image', media: '' }];
    (0, eval)('PZ_BANNERS=window.__B');
    (0, eval)('pzPromoRender')(x.slot, x.hostId);
    const host = document.getElementById(x.hostId);
    return { txt: (host.textContent || '').replace(/\s+/g, ' ').trim(),
             fresh: !host.querySelector('[data-pz-stamp="first"]') };
  }, { hostId, slot });
  ok('but a banner that really changed is repainted', /بنر تازه/.test(changed.txt), changed.txt.slice(0, 30));
}

console.log('but a host that was wiped is repainted:');
/* The memo says «already painted»; the DOM says otherwise, because the screen
   around it was rebuilt from scratch. Believing the memo would leave a blank
   space where the advert should be — and nothing would ever bring it back. */
const wiped = await page.evaluate(() => {
  const host = document.getElementById('promoDuel');
  window.__B.duel = [{ slot: 'duel', title: 'بنر برگشتنی', kind: 'image',
    media: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }];
  (0, eval)('PZ_BANNERS=window.__B');
  (0, eval)('pzPromoRender')('duel', 'promoDuel');
  const before = host.querySelectorAll('.tk-promo').length;
  host.innerHTML = '';                       // the card around it was rebuilt
  (0, eval)('pzPromoRender')('duel', 'promoDuel');
  return { before, after: host.querySelectorAll('.tk-promo').length,
           txt: (host.textContent || '').trim().slice(0, 20) };
});
ok('it was there to begin with', wiped.before === 1, String(wiped.before));
ok('and it comes back after the host is emptied', wiped.after === 1, wiped.txt || 'nothing came back');

/* Same for a host that is REMOVED and rebuilt, which is what a screen rebuild
   does to the banner pzBannerMount creates on demand. */
const remade = await page.evaluate(() => {
  window.__B.home = [{ slot: 'home', title: 'خانهٔ برگشتنی', kind: 'image',
    media: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }];
  (0, eval)('PZ_BANNERS=window.__B');
  (0, eval)('pzBannerMount')('home', 'home');
  const host = document.querySelector('#home .tk-promo-host[data-slot="home"]');
  const before = host.querySelectorAll('.tk-promo').length;
  host.remove();                             // the screen was rebuilt underneath
  (0, eval)('pzBannerMount')('home', 'home');
  const again = document.querySelector('#home .tk-promo-host[data-slot="home"]');
  return { before, after: again ? again.querySelectorAll('.tk-promo').length : 0 };
});
ok('a removed home host is rebuilt with its banner in it', remade.before === 1 && remade.after === 1,
  remade.before + ' → ' + remade.after);

console.log('a video banner keeps playing across a re-render:');
const vid = await page.evaluate(async () => {
  /* A tiny real video so the element is a genuine <video>, not a stand-in. */
  window.__B.duel = [{ slot: 'duel', title: 'تبلیغ', kind: 'video', loop: true, autoplay: true,
    media: '/prizzequizz-api/src/tests/fixtures/none.mp4' }];
  (0, eval)('PZ_BANNERS=window.__B');
  const host = document.getElementById('promoDuel');
  host.innerHTML = ''; (0, eval)('_pzPromoShown')['promoDuel'] = null;
  (0, eval)('pzPromoRender')('duel', 'promoDuel');
  const v = host.querySelector('video');
  if (!v) return { none: true };
  v.dataset.pzStamp = 'first';
  /* currentTime is the playhead. Setting it stands in for "it has been playing
     for a while" without waiting on a real decode in a headless browser. */
  v.currentTime = 7.5;
  for (let i = 0; i < 4; i++) (0, eval)('pzPromoRender')('duel', 'promoDuel');
  const after = host.querySelector('video');
  return { none: false, same: !!(after && after.dataset.pzStamp === 'first'),
           at: after ? after.currentTime : -1 };
});
ok('the video element is the one that was already playing', vid.none === false && vid.same, vid.none ? 'no video' : '');
ok('and its playhead did not go back to the start', vid.at > 0, 'currentTime=' + vid.at);

console.log('and the home banner is not restarted by every screen change:');
const home = await page.evaluate(() => {
  window.__B.home = [{ slot: 'home', title: 'خانه', text: 'یک بنر', kind: 'image',
    media: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }];
  (0, eval)('PZ_BANNERS=window.__B');
  (0, eval)('pzBannerMount')('home', 'home');
  const host = document.querySelector('#home .tk-promo-host[data-slot="home"]');
  const el = host && host.querySelector('.tk-promo');
  if (el) el.dataset.pzStamp = 'first';
  for (let i = 0; i < 3; i++) (0, eval)('pzBannerMount')('home', 'home');
  const after = host && host.querySelector('.tk-promo');
  return { had: !!el, same: !!(after && after.dataset.pzStamp === 'first'),
           count: host ? host.querySelectorAll('.tk-promo').length : 0 };
});
ok('the home banner is painted', home.had);
ok('and survives being mounted again', home.same);
ok('without stacking copies', home.count === 1, String(home.count));

console.log(`\n[banner] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
