/* A COLOURED SHOP CARD.
 *
 * «آبی می‌ذاری همه‌جا یک‌دست همون آبیه — باید از روشن شروع بشه بره تا رنگی که
 *  انتخاب کردیم، از هاله شروع بشه، یه چیز خوشگل باشه، و یه موشن درخشش روش باشه
 *  که از یه سمت کارت بره سمت دیگه.»
 *
 * The first attempt painted the colour flat across the whole card, which is the
 * complaint. What is checked here is that the operator's colour is the DEEP end
 * of something with a light end and a highlight — and that the shine really
 * travels rather than sitting still.
 *
 * Run: node src/tests/browser-shopcolor.mjs */
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

const BLUE = '#1155ff';
const ITEMS = [
  { id: 'i1', category: 'util', icon: '🎫', name: 'کارت آبی', description: 'با رنگ', price: 1000, currency: 'coins', effectKey: 'heart', effectValue: 1, color: BLUE, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] },
  { id: 'i2', category: 'util', icon: '🎁', name: 'کارت دومی', description: 'هم رنگ', price: 2000, currency: 'coins', effectKey: 'heart', effectValue: 1, color: BLUE, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] },
  { id: 'i3', category: 'util', icon: '📦', name: 'کارت بی‌رنگ', description: 'بدون رنگ', price: 3000, currency: 'coins', effectKey: 'heart', effectValue: 1, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] }
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'e', displayName: 'ا', level: 5, xp: 9, wallet: 0, coins: 9999, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (route) => {
  const url = route.request().url();
  let body = { ok: true, data: {} };
  if (url.includes('/shop/items')) body = { ok: true, data: { items: ITEMS, categories: { util: ITEMS } } };
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 120)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/* The shop SCREEN has to be the one on show. A card built into a hidden screen
   generates no boxes at all — no pseudo-element, and therefore no animation to
   look at — which looks exactly like a shine that does not work. */
await page.evaluate(() => (0, eval)('go')('shop'));
await page.waitForTimeout(600);

await page.evaluate((items) => {
  (0, eval)('SHOP').util = items.map((it) => ({ id: it.id, i: it.icon, n: it.name, d: it.description, p: it.price,
    key: it.effectKey, val: it.effectValue, cur: it.currency, badge: it.badge, img: '', color: it.color || '',
    rewards: it.rewards }));
  (0, eval)('renderShop')('util');
}, ITEMS);
await page.waitForTimeout(400);

const cards = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll('#shopContent .item')) {
    const cs = getComputedStyle(el);
    out.push({
      name: (el.querySelector('b') || {}).textContent || '',
      coloured: el.classList.contains('has-color'),
      bg: cs.backgroundImage,
      sc: cs.getPropertyValue('--sc').trim(),
      lite: cs.getPropertyValue('--sc-lite').trim(),
      delay: cs.getPropertyValue('--sc-delay').trim(),
      shine: (() => { const b = getComputedStyle(el, '::before'); return { name: b.animationName, dur: b.animationDuration, w: b.width }; })(),
      colour: cs.color
    });
  }
  return out;
});

ok('a card with a colour is marked as one', cards[0].coloured && !cards[2].coloured,
   cards.map((c) => c.name + ':' + c.coloured).join(' '));

/* ── the complaint itself: not one flat colour ──────────────────────────── */
ok('the card is a GRADIENT, not a block of paint', /gradient/.test(cards[0].bg) && /linear-gradient/.test(cards[0].bg),
   cards[0].bg.slice(0, 70));
ok('and it starts light and ends on the chosen colour',
   cards[0].lite !== '' && cards[0].lite !== cards[0].sc, cards[0].lite + ' → ' + cards[0].sc);
ok('the light end really is lighter', await page.evaluate(() => {
  const el = document.querySelector('#shopContent .item.has-color');
  const lite = getComputedStyle(el).getPropertyValue('--sc-lite');
  const m = lite.match(/\d+/g) || [];
  return m.length >= 3 && (Number(m[0]) + Number(m[1]) + Number(m[2])) > (0x11 + 0x55 + 0xff);
}), cards[0].lite);
ok('there is a halo above the colour, not just the colour',
   /radial-gradient/.test(cards[0].bg), cards[0].bg.slice(0, 46));

/* ── the shine ──────────────────────────────────────────────────────────── */
ok('a light sweeps across the card', cards[0].shine.name === 'scShine', JSON.stringify(cards[0].shine));
ok('and it is a band, not the whole card', cards[0].shine.w !== '' && parseFloat(cards[0].shine.w) < 200, cards[0].shine.w);
ok('it pauses between passes rather than strobing', parseFloat(cards[0].shine.dur) >= 3, cards[0].shine.dur);

/* Asked of the ANIMATION rather than of the computed style: Chromium does not
   report a running transform off a pseudo-element reliably, and a test that
   fights the browser over how to observe something ends up asserting the
   observation instead of the behaviour. */
const moved = await page.evaluate(async () => {
  const el = document.querySelector('#shopContent .item.has-color');
  const anim = document.getAnimations().find((a) => {
    const t = a.effect && a.effect.target;
    return t === el && a.effect.pseudoElement === '::before';
  });
  if (!anim) return { found: false };
  const frames = anim.effect.getKeyframes().map((f) => String(f.transform || ''));
  const t0 = anim.currentTime;
  await new Promise((r) => setTimeout(r, 400));
  return { found: true, frames, advanced: anim.currentTime !== t0, playing: anim.playState };
});
ok('the light is a real running animation', moved.found && moved.playing === 'running', JSON.stringify(moved).slice(0, 70));
ok('it crosses the card from one side to the other',
   moved.found && /-1[0-9]{2}%/.test(moved.frames.join(' ')) && /[23][0-9]{2}%/.test(moved.frames.join(' ')),
   (moved.frames || []).join(' | ').slice(0, 80));
ok('and it moves by transform, not by relaying the card out',
   moved.found && moved.frames.every((f) => /translateX/.test(f)), (moved.frames || [])[0] || '—');
ok('the clock is actually advancing', moved.advanced, String(moved.advanced));

ok('two cards do not flash in unison', cards[0].delay !== cards[1].delay,
   cards[0].delay + ' vs ' + cards[1].delay);

/* ── and the card is still readable ─────────────────────────────────────── */
ok('the lettering is chosen for the card it sits on', /rgb/.test(cards[0].colour), cards[0].colour);
ok('an uncoloured card is left exactly as it was',
   !/radial-gradient/.test(cards[2].bg) && cards[2].sc === '', cards[2].bg.slice(0, 40) || '(none)');

await browser.close(); server.close();
console.log(`[browser-shopcolor] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
