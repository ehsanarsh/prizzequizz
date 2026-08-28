/* A SLIMMER HEADER THAT IS STILL READABLE.
 *
 * «هدر بازی یکم باریک‌تر بشه ولی همه چیزش خوانا باشه» — two requirements, and
 * the second is the one a height change quietly breaks. Shrinking a header is
 * trivial if you are allowed to shrink the words; the whole difficulty is doing
 * it without.
 *
 * So this measures a real header in a real mobile browser and asserts both
 * halves:
 *   • it is meaningfully shorter than the 210px it used to be, and
 *   • not one piece of text is smaller than it was, and
 *   • nothing is clipped that was not already clipped before.
 *
 * The font sizes below are the ones the header shipped with. They are written
 * out rather than compared to «whatever it is now», because the point is that
 * they never move.
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
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان',
    level: 7, xp: 4200, wallet: 250000, coins: 1360, hearts: 4, weeklyScore: 640 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);
await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
await page.waitForTimeout(900);

const m = await page.evaluate(() => {
  const hd = document.querySelector('.pz-header');
  const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : 0; };
  const fs2 = (s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).fontSize : ''; };
  const clipped = [...hd.querySelectorAll('*')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height >= 6 && !el.children.length && (el.textContent || '').trim()
      && el.scrollHeight > Math.ceil(r.height) + 1;
  }).length;
  const hb = hd.getBoundingClientRect();
  const outside = [...hd.querySelectorAll('*')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height >= 6 && (r.bottom > hb.bottom + 2 || r.top < hb.top - 2);
  }).length;
  return {
    header: Math.round(hb.height),
    fonts: { name: fs2('#hdrName'), xp: fs2('.pzh-xptxt'), pill: fs2('.pzh-pill'), say: fs2('.wpl-say'), lvl: fs2('.pzh-lvl') },
    rail: h('.weekly-progress-line'), track: h('.wpl-track'), clipped, outside,
    bar: h('.pzh-xpbar'), pill: h('.pzh-pill'), av: h('.pzh-av')
  };
});

console.log('the height:');
/* 210 is what it measured before this change; 190 leaves room for a font the
   phone renders a shade taller without turning this into a flapping test. */
ok('the header is slimmer than it was', m.header <= 190, m.header + 'px, was 210');
ok('and not slimmer by so much that something was removed', m.header >= 150, m.header + 'px');

console.log('the words:');
ok('the player name is the same size', m.fonts.name === '12.5px', m.fonts.name);
ok('the XP line is the same size', m.fonts.xp === '10.5px', m.fonts.xp);
ok('the wallet pills are the same size', m.fonts.pill === '11.5px', m.fonts.pill);
ok('the league sentence is the same size', m.fonts.say === '10.5px', m.fonts.say);
ok('the level badge is the same size', m.fonts.lvl === '11.5px', m.fonts.lvl);

console.log('nothing broken:');
/* 8 was the count BEFORE the header was touched — a two-pixel line-box
   overhang on the XP text and the pill numbers, which does not cut a glyph.
   The requirement is not to fix them here; it is not to add to them. */
ok('no more text is clipped than already was', m.clipped <= 8, m.clipped + ' clipped');
ok('nothing pokes out of the header', m.outside === 0, m.outside + ' outside');
ok('the XP bar still has room for its text', m.bar >= 19, m.bar + 'px');
ok('the wallet pills are still a comfortable size', m.pill >= 22, m.pill + 'px');
ok('the avatar is still recognisable', m.av >= 32, m.av + 'px');

console.log(`\n[headerslim] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
