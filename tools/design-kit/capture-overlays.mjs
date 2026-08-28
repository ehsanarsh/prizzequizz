/* THE MODALS, SHEETS AND OVERLAYS — the other half of the interface.
 *
 * «فقط صفحات رو نمیخوام؛ مودال‌ها و باتم‌شیت‌ها و همه پنجره‌ها یکدست باشه.»
 *
 * These are where a game's design usually falls apart: each one was added on
 * the day it was needed, so they end up with four different corner radii, three
 * ways of closing and two ideas about where the buttons go. They cannot be made
 * consistent by someone who has never seen them side by side.
 *
 * Each is opened by calling the game's OWN function wherever there is one, so
 * what is captured is the real thing with real content. Where a component is
 * only ever shown by a class toggle deep inside a match, the class is toggled
 * the same way the game toggles it, and the handoff says so.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
const OUT = process.argv[2];
fs.mkdirSync(path.join(OUT, 'overlays'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'shots-overlays'), { recursive: true });

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 'test-token'); localStorage.setItem('pz_rtok', 'test-rtoken');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان رستمی',
    level: 7, xp: 4200, wallet: 250000, coins: 1360, hearts: 4, weeklyScore: 640 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, data: {} }) }));

const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);
await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
await page.waitForTimeout(700);

/* name, the code that opens it, and the element to save. `call` runs in the
 * page; every one of these is the game's own function or the game's own class. */
const CASES = [
  ['modal-confirm', `showAaaModal({icon:'⚠️',title:'از بازی خارج می‌شوی؟',sub:'اگر الان بیرون بروی ورودی‌ات برنمی‌گردد و حریفت برنده می‌شود.',primaryText:'بله، خارج شو',secondaryText:'ادامه می‌دهم'})`, '#aaaModal'],
  ['modal-reward',  `showAaaModal({icon:'🎁',title:'۳ بلیط سبز گرفتی',sub:'دوستت با کد معرف تو وارد بازی شد و اولین مسابقه‌اش را داد.',primaryText:'عالی'})`, '#aaaModal'],
  ['modal-hint',    `showAaaModal({icon:'🏆',title:'راهنمای سریع لیگ هفتگی',sub:'با بلیت وارد لیگ می‌شوی. حذف نشوی به فینال می‌رسی و فینال به دوئل تبدیل می‌شود.',checkboxText:'دیگر این پیام را نمایش نده',primaryText:'متوجه شدم'})`, '#aaaModal'],
  ['sheet-menu',    `openMenu()`, '#menuSheet'],
  ['sheet-wheel',   `openSpin()`, '#spinSheet'],
  ['overlay-levelup', `showLevelUp(8)`, '#lvlOverlay'],
  ['overlay-chest',   `showChest(120000, function(){})`, '#chestOverlay'],
  ['overlay-promotion', `showPromotion()`, '#promoOverlay'],
  ['overlay-elimination', `showElimination(3, 45000, function(){})`, '#elimOverlay'],
  ['toast',         `toast('امتیاز ثبت شد ✅', 8000)`, '.pz-toast, .toast'],
  /* Shown by the game only in the middle of a live match, with the same class
   * the game adds. Content is whatever the last render left in them. */
  ['overlay-turn',    `document.getElementById('turnOverlay').classList.add('show')`, '#turnOverlay'],
  ['overlay-ready',   `document.getElementById('readyOverlay').classList.add('show')`, '#readyOverlay'],
  ['modal-rematch',   `document.getElementById('rematchModal').classList.add('show')`, '#rematchModal'],
  ['sheet-checkpoint',`document.querySelector('.qcp-sheet').classList.add('show')`, '.qcp-sheet']
];

const index = [];
for (const [name, call, sel] of CASES) {
  try {
    await page.evaluate((c) => { try { (0, eval)(c); } catch (e) { /* reported below */ } }, call);
    await page.waitForTimeout(700);
    const info = await page.evaluate((s2) => {
      const el = document.querySelector(s2);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { html: el.outerHTML, visible: cs.display !== 'none' && r.width > 4 && r.height > 4 };
    }, sel);
    if (!info || !info.visible) { console.log('  skip', name, '(did not open)'); continue; }
    const clean = info.html.replace(/data:([a-z/+.-]+);base64,[A-Za-z0-9+/=]+/g,
      (m, mime) => `../assets/inline-${mime.replace(/[^a-z0-9]/gi, '-')}-${m.length}.bin`);
    fs.writeFileSync(path.join(OUT, 'overlays', name + '.html'), clean);
    await page.screenshot({ path: path.join(OUT, 'shots-overlays', name + '.jpg'), type: 'jpeg', quality: 84 });
    index.push({ name, selector: sel, bytes: Buffer.byteLength(clean) });
    console.log('  ok  ', name.padEnd(22), (Buffer.byteLength(clean) / 1024).toFixed(1) + ' KB');
    // put it away again so the next one is not captured on top of it
    await page.evaluate((s2) => {
      try { (0, eval)('closeAaaModal(false)'); } catch (e) {}
      const el = document.querySelector(s2); if (el) el.classList.remove('show');
      try { (0, eval)('closeMenu()'); } catch (e) {}
      try { (0, eval)('forceCloseSpin()'); } catch (e) {}
      try { (0, eval)('hideLevelUp()'); } catch (e) {}
    }, sel);
    await page.waitForTimeout(400);
  } catch (e) { console.log('  ERR ', name, String(e).slice(0, 90)); }
}
fs.writeFileSync(path.join(OUT, 'overlays', '_index.json'), JSON.stringify(index, null, 1));
await browser.close(); server.close();
console.log('captured', index.length, 'of', CASES.length, 'overlays');
