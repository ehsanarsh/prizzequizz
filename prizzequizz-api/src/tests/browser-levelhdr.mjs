/* THE LEVEL THE PLAYER READS.
 *
 * «در فروشگاه… می‌گه این کاراکتر در لول ۵ آزاد می‌شود، با اینکه لول من ۱۵ هست.»
 *
 * There were THREE answers to «what level am I». The stored column, the
 * server's curve over XP, and — the one actually printed in the header — this
 * file's own copy of that curve with the base baked in as 100. The panel can
 * re-tune «پایهٔ XP هر لول» and «نوع منحنی»; the first two move with it and the
 * third cannot, because it never hears about it. That is a header saying ۱۵
 * beside a shelf that has good reason to say ۴.
 *
 * The server now sends the level it gates on, and the bounds of that level
 * under the live curve. This holds the browser to using them.
 *
 * Run: node src/tests/browser-levelhdr.mjs */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };
const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

/* 900 XP. Under the built-in curve (base 100, sqrt) that is level 4 — which is
   exactly the arithmetic that produced the complaint. The server, on a panel
   tuned differently, says 15. */
const XP = 900, SERVER_LEVEL = 15, FLOOR = 800, NEXT = 1000;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const open = async (usr) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript((u) => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify(u));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  }, usr);
  /* `_usr` is REPLACED by whatever /users/me answers, so a blanket empty stub
     would delete the very fields under test — and would also be a lie about
     what the API does. This one answers that endpoint with the real DTO. */
  await ctx.route('**/v1/**', (r) => {
    const body = /\/users\/me/.test(r.request().url())
      ? { ok: true, data: usr }
      : { ok: true, data: {} };
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  return { ctx, page };
};

const base = { id: 'u1', username: 'ehsan', displayName: 'احسان', wallet: 0, coins: 0, hearts: 4 };

/* ── The server has spoken ──────────────────────────────────────────────── */
{
  const { ctx, page } = await open({ ...base, level: SERVER_LEVEL, xp: XP, xpFloor: FLOOR, xpNext: NEXT });
  const hdr = await page.evaluate((xp) => {
    (0, eval)('pzUpdateXpBar')(xp);
    const w = (document.getElementById('hdrXp') || {}).style;
    return { lvl: (document.getElementById('hdrLvl') || {}).textContent || '',
             tail: (document.getElementById('hdrXpN') || {}).textContent || '',
             width: w ? w.width : '',
             ownCurve: (0, eval)('pzLevelForXp')(xp) };
  }, XP);
  console.log('when the account carries the server’s level:');
  ok('the fixture is the reported mismatch', hdr.ownCurve !== SERVER_LEVEL,
    'built-in curve says ' + hdr.ownCurve + ', server says ' + SERVER_LEVEL);
  ok('the header prints the server’s level', hdr.lvl === fa(SERVER_LEVEL), hdr.lvl);
  ok('and not the one this file worked out for itself', hdr.lvl !== fa(hdr.ownCurve), hdr.lvl);
  /* The bar is drawn between the server's bounds, so it cannot show a player
     four fifths of the way through a level the server thinks they just began. */
  ok('the bar fills between the server’s bounds',
    hdr.width === Math.max(3, Math.min(100, ((XP - FLOOR) / (NEXT - FLOOR)) * 100)) + '%', hdr.width);
  ok('and the tail counts to the server’s next level', hdr.tail.indexOf(fa(NEXT - XP)) >= 0, hdr.tail);
  await ctx.close();
}

/* ── The server has not (an old build, or the first paint before login) ──── */
{
  const { ctx, page } = await open({ ...base, xp: XP });
  const hdr = await page.evaluate((xp) => {
    (0, eval)('pzUpdateXpBar')(xp);
    return { lvl: (document.getElementById('hdrLvl') || {}).textContent || '',
             tail: (document.getElementById('hdrXpN') || {}).textContent || '',
             ownCurve: (0, eval)('pzLevelForXp')(xp) };
  }, XP);

  console.log('when it has not:');
  ok('the header still shows something sensible', hdr.lvl === fa(hdr.ownCurve), hdr.lvl);
  ok('and the bar still has a tail', hdr.tail.indexOf('XP') >= 0, hdr.tail);
  await ctx.close();
}

/* ── A nonsense figure must not blank the header ─────────────────────────── */
{
  const { ctx, page } = await open({ ...base, level: 0, xp: XP, xpFloor: 5000, xpNext: 10 });
  const hdr = await page.evaluate((xp) => {
    (0, eval)('pzUpdateXpBar')(xp);
    return { lvl: (document.getElementById('hdrLvl') || {}).textContent || '',
             width: ((document.getElementById('hdrXp') || {}).style || {}).width || '' };
  }, XP);
  console.log('when the server sends something impossible:');
  /* level 0 and a floor above the ceiling: every server figure is rejected and
     the built-in curve answers, which for 900 XP is 4. A header that prints
     «۰», or nothing, is worse than one that is merely out of date. */
  ok('the header falls back rather than printing zero', hdr.lvl === fa(4), hdr.lvl);
  ok('and the bar stays on the page', /%$/.test(hdr.width), hdr.width);
  await ctx.close();
}

console.log(`\n[levelhdr] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
