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
      shine: { name: cs.animationName, dur: cs.animationDuration, size: cs.backgroundSize.split(',')[0].trim() },
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
ok('and the light is a band wider than the card, so it can travel across it',
   parseFloat(cards[0].shine.size) >= 200, cards[0].shine.size);
ok('it pauses between passes rather than strobing', parseFloat(cards[0].shine.dur) >= 3, cards[0].shine.dur);

/* Asked of the ANIMATION rather than of the computed style: Chromium does not
   report a running transform off a pseudo-element reliably, and a test that
   fights the browser over how to observe something ends up asserting the
   observation instead of the behaviour. */
const moved = await page.evaluate(async () => {
  const el = document.querySelector('#shopContent .item.has-color');
  const anim = document.getAnimations().find((a) => a.effect && a.effect.target === el && !a.effect.pseudoElement);
  if (!anim) return { found: false };
  const raw = anim.effect.getKeyframes();
  const props = [...new Set(raw.flatMap((f) => Object.keys(f)))]
    .filter((k) => k !== 'offset' && k !== 'computedOffset' && k !== 'easing' && k !== 'composite');
  /* Chromium expands the shorthand: the keyframes carry backgroundPositionX. */
  const positions = raw.map((f) => String(f.backgroundPositionX || f.backgroundPosition || ''));
  const t0 = anim.currentTime;
  await new Promise((r) => setTimeout(r, 400));
  return { found: true, props, positions, advanced: anim.currentTime !== t0, playing: anim.playState };
});
ok('the light is a real running animation', moved.found && moved.playing === 'running', JSON.stringify(moved).slice(0, 70));
ok('the clock is actually advancing', moved.advanced, String(moved.advanced));
ok('it crosses the card from one end to the other',
   moved.found && /(^|[^0-9])0%/.test(moved.positions.join(' ')) && /100%/.test(moved.positions.join(' ')),
   (moved.positions || []).join(' | ').slice(0, 70));

/* ── THE FIX ITSELF: A COLOURED CARD IS A GREY CARD WITH DIFFERENT PAINT ──
 * «اولش که رنگش خاکستری بود باگ نداشت و کارت‌ها موقع تاچ دراز نمی‌شدن، ولی وقتی
 *  رنگش رو عوض کردم همون باگ روی همون کارت اومد.»
 *
 * That sentence is the whole diagnosis: whatever stretches the card is
 * something the COLOUR adds. It used to add three structural things — an
 * absolutely-positioned pseudo-element, the `overflow:hidden` that clipped it,
 * and a z-index rule on every child. A background cannot move or resize
 * anything, so the light lives in one now and the three are gone.
 *
 * This is checked as a DIFFERENCE against the plain card beside it rather than
 * as a list of properties, because the list is the part that grows: the next
 * thing somebody adds to `.has-color` is caught here without anybody
 * remembering to add a line. */
const sameShape = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#shopContent .item')];
  const plain = cards.find((e) => !e.classList.contains('has-color'));
  const lit = cards.find((e) => e.classList.contains('has-color'));
  if (!plain || !lit) return null;
  /* Every property that can affect where something is drawn or how big it is.
     Paint-only properties (background, border-color, box-shadow, color) are
     deliberately NOT here — those are the ones a colour is allowed to change. */
  /* Longhands, not shorthands: computed style resolves `overflowX`/`overflowY`
     reliably where `overflow` can come back empty, and an empty string on both
     sides is a difference that compares equal — a check that silently stops
     checking. Same reason `borderTopWidth` rather than `border`. */
  const LAYOUT = ['overflowX', 'overflowY', 'position', 'display', 'contain', 'isolation', 'transform',
                  'paddingTop', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'borderTopLeftRadius',
                  'boxSizing', 'minWidth', 'minHeight', 'width', 'height', 'marginTop', 'marginLeft',
                  'willChange', 'clipPath', 'filter', 'perspective', 'zIndex', 'float'];
  /* And prove the probe can see a difference at all, so it cannot pass by
     comparing two empty strings for ever. */
  if (getComputedStyle(plain).overflowX === undefined) return null;
  const diff = [];
  const cp = getComputedStyle(plain), cl = getComputedStyle(lit);
  for (const k of LAYOUT) if (cp[k] !== cl[k]) diff.push(k + ': ' + cp[k] + ' → ' + cl[k]);
  const pseudo = (el) => getComputedStyle(el, '::before').content;
  return {
    diff,
    plainPseudo: pseudo(plain), litPseudo: pseudo(lit),
    childZ: [...lit.children].map((c) => getComputedStyle(c).zIndex + '/' + getComputedStyle(c).position).join(' '),
    plainChildZ: [...plain.children].map((c) => getComputedStyle(c).zIndex + '/' + getComputedStyle(c).position).join(' ')
  };
});
ok('a coloured card has the same box as a plain one in every way that can move it',
   sameShape && sameShape.diff.length === 0, sameShape ? sameShape.diff.join(' | ') || 'identical' : 'no pair to compare');
ok('it grows no pseudo-element the plain card does not have',
   sameShape && sameShape.litPseudo === sameShape.plainPseudo,
   sameShape ? sameShape.plainPseudo + ' vs ' + sameShape.litPseudo : '—');
ok('and its children are stacked exactly like the plain card’s',
   sameShape && sameShape.childZ === sameShape.plainChildZ,
   sameShape ? sameShape.childZ : '—');

/* And the light really is painted — the point of all this is not to remove it. */
const lightMoves = await page.evaluate(async () => {
  const el = document.querySelector('#shopContent .item.shine-on');
  const anim = document.getAnimations().find((a) => a.effect && a.effect.target === el && !a.effect.pseudoElement);
  if (!anim) return null;
  const t = anim.effect.getComputedTiming();
  const dur = Number(t.duration) || 0;
  /* PAST THE DELAY. Each card starts its sweep at its own moment so a shelf of
     them does not flash in unison — and sampling from zero measures that wait,
     not the sweep. The first attempt at this test read «the light never moves»
     for exactly that reason, which is a test failing at arithmetic rather than
     a product failing at anything. */
  const d = Number(t.delay) || 0;
  anim.pause();
  const at = (ms) => { anim.currentTime = d + ms; return getComputedStyle(el).backgroundPosition.split(',')[0].trim(); };
  const start = at(0), mid = at(dur * 0.12), rest = at(dur * 0.6);
  anim.play();
  return { start, mid, rest, delay: d, size: getComputedStyle(el).backgroundSize.split(',')[0].trim() };
});
ok('the band is somewhere else in the middle of the sweep than at the start',
   lightMoves && lightMoves.start !== lightMoves.mid,
   lightMoves ? lightMoves.start + ' → ' + lightMoves.mid : '—');
ok('and it has come to rest by the time the pause begins',
   lightMoves && lightMoves.mid !== lightMoves.rest,
   lightMoves ? lightMoves.mid + ' → ' + lightMoves.rest : '—');
ok('and it moves by repainting, never by laying the card out again',
   moved.found && !(moved.props || []).some((p) => /^(left|right|top|bottom|width|height|margin|transform)/.test(p)),
   (moved.props || []).join(',') || '—');

/* ── ONE LONG NAME MUST NOT STRETCH THE SHELF ────────────────────────────
   «کارت دراز می‌شه.» An unbreakable run of characters — a latin product name, a
   pasted url, a Persian phrase joined with ZWNJ — has no wrap opportunity, so
   it either runs out of the side of its card or pushes the card taller; one
   item measured 245px beside a 201px twin, and grid stretch drags the whole row
   up to match. Every card on the shelf is the same height whatever an operator
   types into the panel, and the grid never grows wider than the screen. */
const shapes = await page.evaluate(() => {
  const S = (0, eval)('SHOP');
  S.util = [
    { id: 'x1', i: '🎫', n: 'قلب', d: 'یک جان', p: 1, cur: 'coins', key: 'heart', val: 1 },
    { id: 'x2', i: '🎁', n: 'SUPER-MEGA-ULTRA-TICKET-PACK-2026-EDITION', d: 'x', p: 2, cur: 'coins', key: 'heart', val: 1 },
    { id: 'x3', i: '📦', n: 'بستهٔ‌ویژهٔ‌بلیط‌های‌طلایی‌مسابقات‌بزرگ‌پاییزه', d: 'توضیح', p: 3, cur: 'coins', key: 'heart', val: 1, color: '#1155ff' },
    { id: 'x4', i: '💎', n: 'بلیط', d: 'https://example.com/very/long/path/that/never/breaks/anywhere', p: 4, cur: 'coins', key: 'heart', val: 1 }
  ];
  (0, eval)('renderShop')('util');
  const cards = [...document.querySelectorAll('#shopContent .item')].map((e) => {
    const r = e.getBoundingClientRect();
    return { n: (e.querySelector('b') || {}).textContent.slice(0, 12), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const grid = document.querySelector('#shopContent .shop-grid');
  return { cards, gridW: Math.round(grid.getBoundingClientRect().width), gridScroll: grid.scrollWidth,
           bodyScroll: document.body.scrollWidth, view: window.innerWidth };
});
/* The NAME BOX, not just the card. `align-items:stretch` already levels the
   cards within one row, so equal card heights alone would pass even if a short
   name reserved less room than a long one — the difference would simply move
   into the row below. The box that holds the name is where the reservation
   either exists or does not. */
const nameBoxes = await page.evaluate(() =>
  [...new Set([...document.querySelectorAll('#shopContent .item b')]
    .map((b) => Math.round(b.getBoundingClientRect().height)))]);
ok('a one-word name reserves the same room as a two-line one',
   nameBoxes.length === 1, nameBoxes.join(' / ') + 'px');
const heights = [...new Set(shapes.cards.map((c) => c.h))];
ok('every card on the shelf is the same height, whatever its name',
   heights.length === 1, shapes.cards.map((c) => c.n + ':' + c.h).join(' | '));
ok('and the same width', [...new Set(shapes.cards.map((c) => c.w))].length === 1,
   shapes.cards.map((c) => c.w).join(' '));
ok('a name with nowhere to wrap does not push the grid sideways',
   shapes.gridScroll <= shapes.gridW + 1 && shapes.bodyScroll <= shapes.view,
   'grid ' + shapes.gridScroll + '/' + shapes.gridW + ', page ' + shapes.bodyScroll + '/' + shapes.view);

/* Put the shelf back the way the checks below expect to find it. */
await page.evaluate((items) => {
  (0, eval)('SHOP').util = items.map((it) => ({ id: it.id, i: it.icon, n: it.name, d: it.description, p: it.price,
    key: it.effectKey, val: it.effectValue, cur: it.currency, badge: it.badge, img: it.image || '', color: it.color || '',
    shine: it.shine, rewards: it.rewards }));
  (0, eval)('renderShop')('util');
}, ITEMS);
await page.waitForTimeout(300);

/* ── AND NOTHING ANIMATES UNDER A TRANSFORM ──────────────────────────────
   Sizing the band to the card was not enough — the user pressed a card and it
   stretched again. Two things transform it: `:active` puts a transform on the
   card itself, and opening a sheet puts `filter:blur(7px)` AND
   `transform:scale(.985)` on the whole viewport behind it, both transitioned.
   A layer that is animating underneath that has to be folded into the blur
   while it moves, and it is folded in at the wrong size — the band smears and
   the shelf looks broken. Nobody can see a shine through a blur at 48%
   brightness, so it simply stops. */
ok('the shine claims no layer of its own at all',
   'auto' === await page.evaluate(() =>
     getComputedStyle(document.querySelector('#shopContent .item.shine-on')).willChange),
   await page.evaluate(() => getComputedStyle(document.querySelector('#shopContent .item.shine-on')).willChange));

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
    const cs = getComputedStyle(el);
    return { pressed: el.matches(':active'), anim: cs.animationName, op: cs.opacity };
  });
  await page.mouse.up();
  await page.waitForTimeout(300);
  return v;
})();
ok('the card really is in its pressed state for this check', held.pressed, String(held.pressed));
ok('and the light stops while a finger is on it', held.anim === 'none', held.anim);
ok('and the card is still fully itself while pressed', held.op === '1', held.op);

/* The sheet is open over the shelf, and the shelf behind it is blurred. */
await page.evaluate(() => (0, eval)('showAaaModal')({ title: 'آزمایش', primaryText: 'باشه' }));
await page.waitForTimeout(400);
const behind = await page.evaluate(() => {
  const el = document.querySelector('#shopContent .item.shine-on');
  const cs = getComputedStyle(el);
  const vp = document.querySelector('.phone.modal-open .viewport');
  return { anim: cs.animationName, op: cs.opacity,
           blurred: !!vp && /blur/.test(getComputedStyle(vp).filter),
           scaled: !!vp && getComputedStyle(vp).transform !== 'none' };
});
ok('the shelf behind a sheet really is blurred and scaled', behind.blurred && behind.scaled,
   JSON.stringify(behind));
ok('and the shine stops there too', behind.anim === 'none', behind.anim);
ok('and nothing is repainting behind a blur nobody can see through', behind.op === '1', behind.op);
await page.evaluate(() => (0, eval)('closeAaaModal')(false));
await page.waitForTimeout(400);
const after = await page.evaluate(() =>
  getComputedStyle(document.querySelector('#shopContent .item.shine-on')).animationName);
ok('once the sheet is closed it shines again', after === 'scShine', after);

/* ── ONE CARD SHINY, THE NEXT ONE PLAIN ──────────────────────────────────── */
const perCard = await page.evaluate(() => {
  const out = {};
  for (const el of document.querySelectorAll('#shopContent .item')) {
    const n = (el.querySelector('b') || {}).textContent || '';
    out[n] = { coloured: el.classList.contains('has-color'), shining: el.classList.contains('shine-on'),
               anim: getComputedStyle(el).animationName };
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

/* ── THE TRIP FROM THE SERVER, WHICH IS THE ONLY ONE THAT COUNTS ─────────
   Everything above sets SHOP by hand, so it proves the CARD reads `shine` —
   not that the answer from the server ever carries it. It did not: the line in
   pzLoadShop that turns the server's items into shelf items listed every other
   field and not this one, so every card shone whatever the operator chose. The
   same line, and the same omission, that once lost `color`. */
{
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx2.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'e', displayName: 'ا', level: 5, xp: 9, wallet: 0, coins: 9999, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  /* Two ticket cards: one told to shine, one told not to. The catalogue is
     deliberately SLOW, because the bug being checked below only exists in the
     gap between opening the shop and the answer arriving. */
  const SERVED = [
    { id: 's1', category: 'tickets', icon: '🎫', name: 'بلیط براق', description: 'با درخشش', price: 1000, currency: 'cash', effectKey: 'ticket-green', effectValue: 1, color: '#1155ff', shine: true, rewards: [{ key: 'ticket-green', value: 1, label: 'بلیط سبز' }] },
    { id: 's2', category: 'tickets', icon: '🎟️', name: 'بلیط مات', description: 'بدون درخشش', price: 2000, currency: 'cash', effectKey: 'ticket-green', effectValue: 1, color: '#1155ff', shine: false, rewards: [{ key: 'ticket-green', value: 1, label: 'بلیط سبز' }] }
  ];
  await ctx2.route('**/v1/**', (route) => {
    const url = route.request().url();
    let body = { ok: true, data: {} };
    let wait = 30;
    if (url.includes('/shop/items')) {
      const cats = {}; for (const i of SERVED) (cats[i.category] ??= []).push(i);
      body = { ok: true, data: { items: SERVED, categories: cats } };
      wait = 500;                      // a real phone on a bad connection
    }
    setTimeout(() => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }), wait);
  });
  const p2 = await ctx2.newPage();
  await p2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(5400);

  /* THE FLASH. «اول یه لحظه یه صفحه میاد که آیتم قلب داره، بعد می‌ره رو بلیط
     مسابقات.» renderShop('util') ran at PAGE LOAD, painted the helps shelf into
     #shopContent and left it there, so opening the shop showed helps until the
     catalogue answered. Sampled while the answer is still in flight — which is
     the only window in which it was ever visible. */
  /* BEFORE THE SHOP IS EVER OPENED. renderShop('util') ran at page load: it
     painted the helps into the shared #shopContent and — the part that did the
     damage — set _shopCurTab to 'util' on the way past. Nothing at startup has
     any business choosing which shelf the player will land on. */
  const atLoad = await p2.evaluate(() => ({
    tab: (0, eval)('_shopCurTab'),
    painted: (document.getElementById('shopContent').innerText || '').trim().slice(0, 40)
  }));
  ok('nothing has chosen a shelf before the shop is opened', atLoad.tab === 'tickets', atLoad.tab);
  ok('and nothing has been painted into it either', atLoad.painted === '', atLoad.painted || '(empty)');

  await p2.evaluate(() => (0, eval)('go')('shop'));
  await p2.waitForTimeout(180);
  const early = await p2.evaluate(() => {
    const c = document.getElementById('shopContent');
    return { names: [...c.querySelectorAll('.item b')].map((b) => b.textContent).join(' | '),
             text: (c.innerText || '').slice(0, 60), tab: (0, eval)('_shopCurTab') };
  });
  ok('the shop opens on the tickets shelf', early.tab === 'tickets', early.tab);
  ok('and no other shelf is shown first, not even for a moment',
     !/جان اضافی|حذف دو گزینه|وقت اضافه/.test(early.names + ' ' + early.text),
     early.names || early.text.replace(/\n/g, ' '));
  ok('what it shows while waiting is that it is waiting',
     /در حال گرفتن|بلیط/.test(early.text), early.text.replace(/\n/g, ' ').slice(0, 44));
  /* Checked HERE, in the gap, not after the catalogue lands. The load-time
     renderShop('util') set _shopCurTab to 'util' as a side effect, and the tab
     bar is built from it when the FIRST fetch answers — at page load, long
     before the shop is opened. By the time the second fetch rebuilds the bar
     the evidence is gone, so the only window in which the bar and the shelf
     disagree is this one. */
  const earlyBar = await p2.evaluate(() => {
    const on = document.querySelector('#shopTabs .tab.active');
    return { active: on ? on.textContent.trim() : '(none)', count: document.querySelectorAll('#shopTabs .tab.active').length };
  });
  ok('the highlighted tab agrees with the shelf from the first moment',
     earlyBar.count === 1 && /بلیط/.test(earlyBar.active), earlyBar.active + ' ×' + earlyBar.count);

  await p2.waitForTimeout(900);
  const served = await p2.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#shopContent .item')) {
      out.push({ name: (el.querySelector('b') || {}).textContent || '',
                 coloured: el.classList.contains('has-color'),
                 shining: el.classList.contains('shine-on') });
    }
    return { cards: out, raw: ((0, eval)('SHOP').tickets || []).map((i) => i.shine) };
  });
  ok('the catalogue arrives and the tickets are drawn', served.cards.length === 2,
     served.cards.map((c) => c.name).join(' | '));
  ok('the server’s answer carries the shine flag into the shelf',
     JSON.stringify(served.raw) === '[true,false]', JSON.stringify(served.raw));
  ok('the card told to shine does', (served.cards[0] || {}).shining === true, JSON.stringify(served.cards[0]));
  ok('and the one told not to does NOT — the whole point of the setting',
     (served.cards[1] || {}).shining === false, JSON.stringify(served.cards[1]));
  ok('both kept their colour either way',
     served.cards.every((c) => c.coloured), JSON.stringify(served.cards));

  /* AND THE TAB BAR AGREES WITH THE SHELF.
     The load-time renderShop('util') did not only paint the wrong shelf — it
     set _shopCurTab to 'util' as a side effect, and the tab bar is rebuilt from
     that when the catalogue lands. So the tickets could be on show with
     «آیتم‌های کاربردی» lit up above them: the highlighted tab and the shelf
     underneath it disagreeing is how a player learns not to trust either. */
  const bar = await p2.evaluate(() => {
    const on = document.querySelector('#shopTabs .tab.active');
    return { active: on ? on.textContent.trim() : '(none)',
             count: document.querySelectorAll('#shopTabs .tab.active').length };
  });
  ok('exactly one tab is highlighted', bar.count === 1, String(bar.count));
  ok('and it is the one whose shelf is actually on show', /بلیط/.test(bar.active), bar.active);
  await ctx2.close();
}

await browser.close(); server.close();
console.log(`[browser-shopcolor] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
