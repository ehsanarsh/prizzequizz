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
/* A real 2×2 PNG. A truncated one would fire the `onerror` fallback and the
   sheet would show the emoji — which is the correct behaviour, and would make
   a test for «the artwork is shown» quietly assert the opposite. */
const ART = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8DwnwEJMCFzBjMHAFqJAxAlfgi3AAAAAElFTkSuQmCC';
const ITEMS = [
  { id: 'i1', category: 'util', icon: '🎫', name: 'کارت آبی', description: 'با رنگ', price: 1000, currency: 'coins', effectKey: 'heart', effectValue: 1, color: BLUE, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] },
  { id: 'i2', category: 'util', icon: '🎁', name: 'کارت دومی', description: 'هم رنگ', price: 2000, currency: 'coins', effectKey: 'heart', effectValue: 1, color: BLUE, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] },
  { id: 'i3', category: 'util', icon: '📦', name: 'کارت بی‌رنگ', description: 'بدون رنگ', price: 3000, currency: 'coins', effectKey: 'heart', effectValue: 1, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] },
  /* «هر کدوم نخواستم ساده بمونه» — coloured, and told not to shine. */
  { id: 'i4', category: 'util', icon: '🔇', name: 'کارت مات', description: 'رنگی ولی ساده', price: 4000, currency: 'coins', effectKey: 'heart', effectValue: 1, color: BLUE, shine: false, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] },
  /* Has artwork of its own, and is priced in cash so the purchase sheet opens. */
  { id: 'i5', category: 'util', icon: '🧸', name: 'کارت عکس‌دار', description: 'با عکس', price: 5000, currency: 'cash', effectKey: 'heart', effectValue: 1, color: BLUE, image: ART, rewards: [{ key: 'heart', value: 1, label: 'قلب' }] }
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
    key: it.effectKey, val: it.effectValue, cur: it.currency, badge: it.badge, img: it.image || '', color: it.color || '',
    shine: it.shine, rewards: it.rewards }));
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
ok('and every card kept its own place on the shelf', cards.length === ITEMS.length, String(cards.length));

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
  const raw = anim.effect.getKeyframes();
  const frames = raw.map((f) => String(f.transform || ''));
  /* Every property the animation touches, not only the transform: a sweep that
     moved by `left` would still pass a transform-only check by having none. */
  const props = [...new Set(raw.flatMap((f) => Object.keys(f)))]
    .filter((k) => k !== 'offset' && k !== 'computedOffset' && k !== 'easing' && k !== 'composite');
  const t0 = anim.currentTime;
  await new Promise((r) => setTimeout(r, 400));
  return { found: true, frames, props, advanced: anim.currentTime !== t0, playing: anim.playState };
});
ok('the light is a real running animation', moved.found && moved.playing === 'running', JSON.stringify(moved).slice(0, 70));
ok('it crosses the card from one side to the other',
   moved.found && /-1[0-9]{2}%/.test(moved.frames.join(' ')) && /[23][0-9]{2}%/.test(moved.frames.join(' ')),
   (moved.frames || []).join(' | ').slice(0, 80));
/* Frames that only fade carry no transform at all, so «every frame» is the
   wrong question — «does it ever move the card by a layout property» is the
   one that matters, and it is the stronger check of the two. */
ok('and it moves by transform, not by relaying the card out',
   moved.found
   && moved.frames.filter(Boolean).every((f) => /translateX/.test(f))
   && moved.frames.some(Boolean)
   && !(moved.props || []).some((p) => /^(left|right|top|bottom|width|height|margin)/.test(p)),
   (moved.props || []).join(',') || '—');
ok('the clock is actually advancing', moved.advanced, String(moved.advanced));

ok('two cards do not flash in unison', cards[0].delay !== cards[1].delay,
   cards[0].delay + ' vs ' + cards[1].delay);

/* ── and the card is still readable ─────────────────────────────────────── */
ok('the lettering is chosen for the card it sits on', /rgb/.test(cards[0].colour), cards[0].colour);
ok('an uncoloured card is left exactly as it was',
   !/radial-gradient/.test(cards[2].bg) && cards[2].sc === '', cards[2].bg.slice(0, 40) || '(none)');

/* ── THE CARD THAT STRETCHED ─────────────────────────────────────────────
   «وقتی روی کارت‌های رنگ‌شده تاچ می‌کنی کارت دراز می‌شه و صفحه قاطی می‌شه.»
   The band was 433px tall on a 201px card and only a rounded overflow clip on
   a `:active`-transformed element kept the other 232px off the screen — the
   one arrangement mobile Chrome drops the clip on. Nothing here needs to
   reproduce that compositor bug: what is asserted is that there is no longer
   anything outside the card TO escape. The old CSS fails this on the numbers
   alone. */
const band = await page.evaluate(() => {
  const el = document.querySelector('#shopContent .item.shine-on');
  const r = el.getBoundingClientRect();
  const b = getComputedStyle(el, '::before');
  return { card: +r.height.toFixed(1), h: parseFloat(b.height), w: parseFloat(b.width), cardW: +r.width.toFixed(1),
           top: b.top, bottom: b.bottom, radius: b.borderTopLeftRadius, clip: getComputedStyle(el).overflow };
});
ok('the shine is no taller than the card it lives on', band.h <= band.card,
   band.h + 'px band on a ' + band.card + 'px card');
ok('and it still covers the card top to bottom', band.h >= band.card - 8, band.h + ' vs ' + band.card);
ok('it hangs off neither the top nor the bottom', band.top === '0px' && band.bottom === '0px',
   band.top + ' / ' + band.bottom);
ok('it is rounded like the card, so a dropped clip shows nothing', parseFloat(band.radius) > 0, band.radius);
ok('the card still clips its own contents', band.clip === 'hidden', band.clip);
ok('and the band is narrower than the card', band.w < band.cardW, band.w + ' of ' + band.cardW);

/* ── AND NOTHING ANIMATES UNDER A TRANSFORM ──────────────────────────────
   Sizing the band to the card was not enough — the user pressed a card and it
   stretched again. Two things transform it: `:active` puts a transform on the
   card itself, and opening a sheet puts `filter:blur(7px)` AND
   `transform:scale(.985)` on the whole viewport behind it, both transitioned.
   A layer that is animating underneath that has to be folded into the blur
   while it moves, and it is folded in at the wrong size — the band smears and
   the shelf looks broken. Nobody can see a shine through a blur at 48%
   brightness, so it simply stops. */
ok('the shine claims no permanent layer of its own',
   !/transform|opacity/.test(await page.evaluate(() =>
     getComputedStyle(document.querySelector('#shopContent .item.shine-on'), '::before').willChange)),
   await page.evaluate(() => getComputedStyle(document.querySelector('#shopContent .item.shine-on'), '::before').willChange));

const held = await (async () => {
  const box = await page.evaluate(() => {
    const e = document.querySelector('#shopContent .item.shine-on');
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  const v = await page.evaluate(() => {
    const el = document.querySelector('#shopContent .item.shine-on');
    const b = getComputedStyle(el, '::before');
    return { pressed: el.matches(':active'), anim: b.animationName, op: b.opacity };
  });
  await page.mouse.up();
  await page.waitForTimeout(300);
  return v;
})();
ok('the card really is in its pressed state for this check', held.pressed, String(held.pressed));
ok('and the light stops while a finger is on it', held.anim === 'none', held.anim);
ok('with nothing left painted to smear', held.op === '0', held.op);

/* The sheet is open over the shelf, and the shelf behind it is blurred. */
await page.evaluate(() => (0, eval)('showAaaModal')({ title: 'آزمایش', primaryText: 'باشه' }));
await page.waitForTimeout(400);
const behind = await page.evaluate(() => {
  const el = document.querySelector('#shopContent .item.shine-on');
  const b = getComputedStyle(el, '::before');
  const vp = document.querySelector('.phone.modal-open .viewport');
  return { anim: b.animationName, op: b.opacity,
           blurred: !!vp && /blur/.test(getComputedStyle(vp).filter),
           scaled: !!vp && getComputedStyle(vp).transform !== 'none' };
});
ok('the shelf behind a sheet really is blurred and scaled', behind.blurred && behind.scaled,
   JSON.stringify(behind));
ok('and the shine stops there too', behind.anim === 'none', behind.anim);
ok('again with nothing painted under the blur', behind.op === '0', behind.op);
await page.evaluate(() => (0, eval)('closeAaaModal')(false));
await page.waitForTimeout(400);
const after = await page.evaluate(() =>
  getComputedStyle(document.querySelector('#shopContent .item.shine-on'), '::before').animationName);
ok('once the sheet is closed it shines again', after === 'scShine', after);

/* ── ONE CARD SHINY, THE NEXT ONE PLAIN ──────────────────────────────────── */
const perCard = await page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('#shopContent .item')) {
    const n = (el.querySelector('b') || {}).textContent || '';
    out[n] = { coloured: el.classList.contains('has-color'), shining: el.classList.contains('shine-on'),
               anim: getComputedStyle(el, '::before').animationName };
  }
  return out;
});
ok('a card told not to shine keeps its colour', perCard['کارت مات'] && perCard['کارت مات'].coloured,
   JSON.stringify(perCard['کارت مات']));
ok('and has no light crossing it at all',
   perCard['کارت مات'] && !perCard['کارت مات'].shining && perCard['کارت مات'].anim === 'none',
   (perCard['کارت مات'] || {}).anim);
ok('while the card beside it still shines',
   perCard['کارت آبی'] && perCard['کارت آبی'].shining && perCard['کارت آبی'].anim === 'scShine',
   (perCard['کارت آبی'] || {}).anim);
ok('a card that says nothing about it shines, as it always did',
   cards[0].coloured && perCard['کارت دومی'].shining, String(perCard['کارت دومی'].shining));

/* ── THE PURCHASE SHEET SHOWS THE THING BEING BOUGHT ─────────────────────── */
/* «عکس همون آیتم باید بزرگ بالای مودال باشه به جای عکس کارتی که ما گذاشتیم.» */
await page.route('**/v1/orders/quote', (route) => route.fulfill({ status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, data: { order: {}, amount: 5000, currency: 'cash', label: 'کارت عکس‌دار',
    vaultBalance: 90000, canPayFromVault: true, canPayByGateway: true } }) }));
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#shopContent .item')].find((e) => /عکس‌دار/.test(e.textContent));
  el.click();
});
await page.waitForTimeout(900);
const sheet = await page.evaluate(() => {
  const ic = document.getElementById('aaaIcon');
  const img = ic ? ic.querySelector('img') : null;
  const r = ic ? ic.getBoundingClientRect() : { width: 0 };
  return { art: ic ? ic.classList.contains('has-art') : false, src: img ? img.getAttribute('src') : '',
           w: Math.round(r.width), text: (document.getElementById('aaaModal') || {}).innerText || '',
           accent: ic ? getComputedStyle(ic).getPropertyValue('--aaa-accent').trim() : '' };
});
ok('the sheet shows the item’s own picture', sheet.art && sheet.src.startsWith('data:image/png'),
   sheet.src.slice(0, 30));
ok('and shows it big, not as a small tile', sheet.w >= 130, sheet.w + 'px');
ok('it is no longer the same credit card for everything', !/💳/.test(sheet.text),
   sheet.text.replace(/\n/g, ' | ').slice(0, 50));
ok('the halo behind it is lit with the item’s own colour', /17, ?85, ?255/.test(sheet.accent), sheet.accent || '—');
ok('and it is still the purchase sheet', /کارت عکس‌دار/.test(sheet.text),
   sheet.text.replace(/\n/g, ' | ').slice(0, 46));

/* An item with no artwork falls back to ITS OWN emoji, not to the card. */
await page.evaluate(() => { const x = document.getElementById('aaaClose'); if (x) x.click(); });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const s = (0, eval)('SHOP');
  s.util = s.util.map((i) => (i.id === 'i5' ? { ...i, img: '' } : i));
  (0, eval)('renderShop')('util');
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  const el = [...document.querySelectorAll('#shopContent .item')].find((e) => /عکس‌دار/.test(e.textContent));
  el.click();
});
await page.waitForTimeout(900);
const noArt = await page.evaluate(() => {
  const ic = document.getElementById('aaaIcon');
  return { art: ic.classList.contains('has-art'), text: ic.innerText || '' };
});
ok('an item without artwork shows its own emoji instead', !noArt.art && /🧸/.test(noArt.text),
   JSON.stringify(noArt).slice(0, 60));

await browser.close(); server.close();
console.log(`[browser-shopcolor] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
