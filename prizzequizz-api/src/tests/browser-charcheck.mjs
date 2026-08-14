/* THE CHARACTER SCREENS.
 *
 *   «صفحه انتخاب کاراکتر باید چیدمان کاراکترها به صورت دایره‌ای و ۳ بعدی باشه
 *    نه به شکل وی و به امتداد بالا — باید به عمق بره نه بالا»
 *   «در قسمت انتخاب کاراکتر فقط کاراکترهای فعال نمایش داده بشه»
 *   «در فروشگاه یه قسمت کاراکتر باشه با گروه‌بندی... و وقتی فعال کردی نشون بده
 *    که این کاراکتر برای شما فعال است»
 *
 * The ring is geometry, so it is measured rather than eyeballed: a circle
 * seen in perspective has a signature — the outer characters are SMALLER and
 * only a little higher, and the ones behind are drawn behind. A V has the
 * opposite signature, so these numbers can tell them apart.
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
const ART = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#7a4"/></svg>').toString('base64');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const ch = (o) => Object.assign({
  id: 'c' + Math.random().toString(36).slice(2, 8), name: 'کاراکتر', description: 'توضیح',
  image: ART, kind: 'normal', enabled: true, unlockLevel: 0, viaLevel: false, viaReward: false,
  viaPurchase: true, viaEvent: false, viaRandom: false, price: 500, group: '', sortOrder: 0,
  newUntil: '', createdAt: '', unlocked: false, equipped: false, isNew: false, lockReason: '', source: ''
}, o);

let roster = { characters: [], equippedId: '', level: 3, xp: 0, hasDatabase: false };
const purchases = [];

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 5000, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/characters') return send(roster);
    if (/^\/characters\/.+\/purchase$/.test(p)) { purchases.push(p); return send({ charged: 500, coins: 4500, roster }); }
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

const openPicker = async (page) => {
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('character'); csLoad&&csLoad();"));
  await page.waitForTimeout(1400);
};

/* Every slot the ring is currently drawing, with the numbers that tell a circle
   from a V: half-width from centre, the top of the box, and the scale. */
const readRing = (page) => page.evaluate(() => {
  const ring = document.getElementById('csRing'); if (!ring) return null;
  const st = document.getElementById('csStage').getBoundingClientRect();
  return [...ring.children].map((el, i) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return null;
    const m = new DOMMatrixReadOnly(cs.transform);
    const r = el.getBoundingClientRect();
    return {
      i, x: Math.round(m.m41), y: Math.round(m.m42), scale: +m.a.toFixed(3),
      z: Number(cs.zIndex) || 0, opacity: +cs.opacity, blur: cs.filter,
      cx: Math.round(r.left + r.width / 2 - st.left - st.width / 2),
      top: Math.round(r.top - st.top), h: Math.round(r.height)
    };
  }).filter(Boolean);
});

/* ── 1. THE RING IS A RING ──────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the picker with nine characters:');
  roster = {
    characters: Array.from({ length: 9 }, (_, i) => ch({ id: 'r' + i, name: 'کاراکتر ' + (i + 1), unlocked: true, equipped: i === 0 })),
    equippedId: 'r0', level: 3, xp: 0, hasDatabase: false
  };
  await openPicker(page);
  const slots = await readRing(page);
  ok('every owned character is on the ring', !!slots && slots.length >= 5, String(slots && slots.length));

  const front = slots.reduce((a, b) => (Math.abs(a.cx) < Math.abs(b.cx) ? a : b));
  const outer = slots.filter((s) => s !== front).sort((a, b) => Math.abs(b.cx) - Math.abs(a.cx))[0];
  const near = slots.filter((s) => s !== front).sort((a, b) => Math.abs(a.cx) - Math.abs(b.cx))[0];

  /* DEPTH, not height. A circle turning away makes the far characters SMALLER;
     the V made them merely higher and kept a big vertical climb. */
  ok('the character at the front is the biggest', slots.every((s) => s.scale <= front.scale + 0.001),
     'front ' + front.scale + ' vs max ' + Math.max(...slots.map((s) => s.scale)));
  ok('and the ones further round are smaller', outer.scale < front.scale * 0.8,
     'front ' + front.scale + ' → outer ' + outer.scale);
  ok('shrinking step by step, not in one jump', near.scale < front.scale && outer.scale < near.scale,
     [front.scale, near.scale, outer.scale].join(' → '));

  /* «به عمق بره نه بالا» — the vertical travel is the podium ellipse, tens of
     pixels, not the 320px arm of the old U. */
  const rise = Math.max(...slots.map((s) => front.top - s.top));
  ok('nobody climbs up the screen', rise < 90, rise + 'px of rise');
  ok('while the ring is wide enough to read as a circle',
     Math.abs(outer.cx) > 60, Math.abs(outer.cx) + 'px out');

  /* A circle has a back: the ones behind are drawn behind, dimmer and softer. */
  ok('the far ones are layered behind the near ones', outer.z < front.z, outer.z + ' < ' + front.z);
  ok('and are dimmer', outer.opacity < front.opacity - 0.05, outer.opacity + ' vs ' + front.opacity);
  ok('and softer', /blur/.test(outer.blur) && !/blur/.test(front.blur), outer.blur + ' | ' + front.blur);

  /* THE SIGNATURE OF A CIRCLE: x is a sine of the angle, so the horizontal gap
     between neighbours SHRINKS towards the edges. A V spaces them evenly. */
  const bySide = slots.slice().sort((a, b) => a.cx - b.cx).map((s) => s.cx);
  const gaps = bySide.slice(1).map((v, i) => v - bySide[i]);
  const mid = gaps[Math.floor(gaps.length / 2)];
  const edge = Math.min(gaps[0], gaps[gaps.length - 1]);
  ok('the spacing closes up towards the edges, as a circle does', edge < mid * 0.92,
     'edge ' + edge + ' vs middle ' + mid);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THREE CHARACTERS STILL CURVE ────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the picker with only three:');
  roster = { characters: Array.from({ length: 3 }, (_, i) => ch({ id: 't' + i, unlocked: true, equipped: i === 0 })), equippedId: 't0', level: 3, xp: 0, hasDatabase: false };
  await openPicker(page);
  const slots = await readRing(page);
  ok('all three are there', slots.length === 3, String(slots.length));
  const front = slots.reduce((a, b) => (Math.abs(a.cx) < Math.abs(b.cx) ? a : b));
  ok('and the two beside it are already turning away', slots.every((s) => s === front || s.scale < front.scale),
     slots.map((s) => s.scale).join(','));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. ONLY WHAT THE PLAYER OWNS ───────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a wardrobe with three owned and five locked:');
  roster = {
    characters: [
      ...Array.from({ length: 3 }, (_, i) => ch({ id: 'own' + i, name: 'مال من ' + i, unlocked: true, equipped: i === 0 })),
      ...Array.from({ length: 5 }, (_, i) => ch({ id: 'lock' + i, name: 'قفلی ' + i, unlocked: false, lockReason: 'خرید (۵۰۰ سکه)' }))
    ], equippedId: 'own0', level: 3, xp: 0, hasDatabase: false
  };
  await openPicker(page);
  const shown = await page.evaluate(() => (0, eval)('csView.map(c=>c.id)'));
  ok('the ring holds only the owned ones', shown.length === 3 && shown.every((i) => /^own/.test(i)), JSON.stringify(shown));
  const locked = await page.evaluate(() => {
    const el = document.getElementById('csRing');
    return [...el.querySelectorAll('.cs-slot.locked')].length;
  });
  ok('with no locked slot on the ring at all', locked === 0, String(locked));

  const chip = await page.evaluate(() => {
    const b = document.getElementById('csShopChip');
    return { shown: !!b && getComputedStyle(b).display !== 'none', text: b ? b.textContent : '' };
  });
  ok('but the five to be had are counted', chip.shown && /۵/.test(chip.text), chip.text);
  const went = await page.evaluate(async () => {
    document.getElementById('csShopChip').click();
    await new Promise((r) => setTimeout(r, 500));
    return { screen: (document.querySelector('.screen.active') || {}).id,
             tab: (document.querySelector('#shopTabs .tab.active') || {}).textContent };
  });
  ok('and the chip goes to the shop’s character shelf', went.screen === 'shop' && /کاراکتر/.test(went.tab || ''), JSON.stringify(went));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE SHELF ───────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the shop’s character shelf:');
  purchases.length = 0;
  roster = {
    characters: [
      ch({ id: 's1', name: 'پهلوان', group: 'قهرمانان', price: 500, unlocked: false }),
      ch({ id: 's2', name: 'شمشیرزن', group: 'قهرمانان', price: 800, unlocked: true }),
      ch({ id: 's3', name: 'روباه', group: 'حیوانات', price: 300, unlocked: false }),
      ch({ id: 's4', name: 'استاد', group: 'حیوانات', price: 900, unlocked: false, unlockLevel: 40, lockReason: 'از لول ۴۰ — سپس خرید (۹۰۰ سکه)' }),
      ch({ id: 's5', name: 'جایزه‌ای', group: '', price: 0, viaPurchase: false, viaRandom: true, unlocked: false, lockReason: 'آزادسازی با: قرعه‌کشی' })
    ], equippedId: '', level: 3, xp: 0, hasDatabase: false
  };
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('shop'); _shopCurTab='characters'; renderCharacterShop();"));
  await page.waitForTimeout(900);

  const shelf = await page.evaluate(() => {
    const c = document.getElementById('shopContent');
    const heads = [...c.querySelectorAll('.section-title')].map((e) => e.textContent.trim());
    const cards = [...c.querySelectorAll('.item')].map((e) => ({
      name: (e.querySelector('b') || {}).textContent || '',
      note: (e.querySelector('p') || {}).textContent || '',
      price: (e.querySelector('.price') || {}).textContent || '',
      clickable: !!e.onclick
    }));
    return { heads, cards };
  });
  ok('the shelves are the panel’s groups', shelf.heads.includes('قهرمانان') && shelf.heads.includes('حیوانات'), JSON.stringify(shelf.heads));
  ok('every character is listed, not only the ones with a price',
     shelf.cards.length === 5, String(shelf.cards.length));

  const byName = (n) => shelf.cards.find((c) => c.name === n);
  /* «وقتی فعال کردی در قسمت فروشگاه نشون بده که این کاراکتر برای شما فعال است» */
  ok('one already owned says so in those words', /برای شما فعال است/.test(byName('شمشیرزن').price), byName('شمشیرزن').price);
  ok('one for sale shows its coin price', /۵۰۰/.test(byName('پهلوان').price), byName('پهلوان').price);
  /* «من پول داشته باشم سکه داشته باشم ولی لول نداشته باشم نتونم خرید کنم» */
  ok('one gated by level says the level instead of the price', /لول ۴۰/.test(byName('استاد').price), byName('استاد').price);
  ok('and cannot be bought by tapping it', await page.evaluate(async () => {
    const card = [...document.querySelectorAll('#shopContent .item')].find((e) => /استاد/.test(e.textContent));
    card.click(); await new Promise((r) => setTimeout(r, 400));
    return true;
  }) && purchases.length === 0, JSON.stringify(purchases));
  /* One that is not for sale at all is still on the shelf, as a goal. */
  ok('a wheel-only character is listed with how it is come by',
     /قرعه‌کشی/.test(byName('جایزه‌ای').note) && !/🪙/.test(byName('جایزه‌ای').price),
     byName('جایزه‌ای').note + ' / ' + byName('جایزه‌ای').price);

  await page.evaluate(async () => {
    const card = [...document.querySelectorAll('#shopContent .item')].find((e) => /پهلوان/.test(e.textContent));
    card.click(); await new Promise((r) => setTimeout(r, 700));
  });
  ok('a buyable one really goes to the server', purchases.length === 1, JSON.stringify(purchases));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
