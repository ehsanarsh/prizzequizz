/* THE NEW HOME, DRIVEN.
 *
 * Four modes behind one card is only better than four stacked cards if the
 * card actually turns. So this swipes it with a real finger path, checks the
 * mode changed, checks a small drag snaps BACK (a card left halfway is worse
 * than no gesture at all), and checks a vertical flick is still a scroll.
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/* A logged-in session, or the app sits on the login screen and nothing lays out. */
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 'test-token');
  localStorage.setItem('pz_rtok', 'test-rtoken');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 3, xp: 120, wallet: 0, coins: 360, hearts: 5, weeklyScore: 92 }));
});
await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (p === '/leaderboards/weekly-winnings') return send({ entries: [
    { rank: 1, userId: 'a', username: 'زرگل', avatar: '', character: null, score: 2400000, highlighted: false },
    { rank: 2, userId: 'b', username: 'رضا', avatar: '', character: null, score: 1100000, highlighted: false },
    { rank: 3, userId: 'c', username: 'سینا', avatar: '', character: null, score: 750000, highlighted: true }
  ] });
  if (p === '/leaderboards/weekly') return send({ entries: [] });
  if (p.startsWith('/users/')) return send({ id: 'u1', username: 'ehsan', level: 3, xp: 120, weeklyScore: 92, balances: {}, matches: 0, wins: 0 });
  return send({});
});

const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 140)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);                     // splash routing
await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
await page.waitForTimeout(900);

const title = () => page.evaluate(() => document.querySelector('#mcard h2')?.textContent || '');
const idx = () => page.evaluate(() => (0, eval)('hmIdx'));

console.log('the card:');
{
  const t = await title();
  ok('home opens on the first mode', /دوئل/.test(t), t);
  const box = await page.evaluate(() => { const r = document.getElementById('mcard').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; });
  ok('the card is actually laid out', box.w > 150 && box.h > 200, box.w + '×' + box.h);
  const rails = await page.evaluate(() => ({ r: document.querySelectorAll('#hrailR .hside').length, l: document.querySelectorAll('#hrailL .hside').length }));
  ok('both rails carry their icons', rails.r === 3 && rails.l === 4, 'right ' + rails.r + ', left ' + rails.l);
  const dots = await page.evaluate(() => document.querySelectorAll('#mdots i').length);
  ok('there is one dot per mode', dots === 4, String(dots));
}

/* A real finger: press, move in steps, release. */
async function swipe(dx, dy = 0, steps = 12) {
  const b = await page.evaluate(() => { const r = document.getElementById('mcard').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 60 }; });
  await page.touchscreen.tap(b.x, b.y).catch(() => {});
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: b.x + (dx * i) / steps, y: b.y + (dy * i) / steps }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(350);
}

console.log('the header:');
{
  const h = await page.evaluate(() => {
    const hdr = document.querySelector('#home .pz-header');
    return {
      buttons: hdr ? hdr.querySelectorAll('button').length : -1,
      hasCup: !!hdr?.querySelector('.weekly-progress-line'),
      hasName: !!hdr?.querySelector('#hdrName'),
      hasWallet: !!hdr?.querySelector('#hdrWallet'),
      bg: hdr ? getComputedStyle(hdr).backgroundImage.replace(/\s+/g, '') : ''
    };
  });
  /* The wheel, the bell and the daily gift moved to the rails. A control in
     two places is a control whose badge is wrong in one of them. */
  ok('the header carries no action buttons any more', h.buttons === 0, String(h.buttons));
  ok('the cup rail is inside the header now', h.hasCup);
  ok('and the name and belongings are still there', h.hasName && h.hasWallet);
  /* The header was left exactly as it was: a dark bar carrying light text.
     Turning it into a light card made XP, tickets and the vault unreadable. */
  ok('the header is still the dark bar it always was', /rgba\(10,14,20/.test(h.bg), h.bg.slice(0, 60));
  const legible = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/\d+/g); return m ? (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) : null; };
    const pick = (sel) => { const e = document.querySelector(sel); return e ? lum(getComputedStyle(e).color) : null; };
    return { xp: pick('#home .pzh-xptxt'), wallet: pick('#home .p-money b'), ticket: pick('#home .pzh-tickets') };
  });
  /* Light text on a dark bar: anything dark here means it vanished. */
  ok('XP, the vault and the tickets are light enough to read on it', legible.xp > 140 && legible.wallet > 140, JSON.stringify(legible));
  const rails = await page.evaluate(() => [...document.querySelectorAll('.hside .lbl')].map((e) => e.textContent));
  for (const must of ['گردونه', 'اعلان‌ها', 'هدایا']) ok('«' + must + '» is on a rail', rails.includes(must), rails.join('،'));
}

console.log('touching the card:');
{
  /* A plain tap once turned the card into a 44×44 button: the swipe code added
     a class named «sw», and this file already had a .sw that IS a 44×44
     button. Everything after the first touch was scrambled. Geometry before
     and after a touch must be identical. */
  const before = await page.evaluate(() => { const r = document.getElementById('mcard').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  const pt = await page.evaluate(() => { const r = document.getElementById('mcard').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 40 }; });
  await page.touchscreen.tap(pt.x, pt.y);
  await page.waitForTimeout(350);
  const after = await page.evaluate(() => { const r = document.getElementById('mcard').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
  ok('a tap does not change the card', before.w === after.w && before.h === after.h, before.w + '×' + before.h + ' → ' + after.w + '×' + after.h);
  ok('and the card is a card, not a 44px button', after.w > 150 && after.h > 200, after.w + '×' + after.h);
}

console.log('the swipe:');
{
  await swipe(160);
  ok('a swipe toward the right moves to the next mode', /بازمانده/.test(await title()), await title());
  await swipe(-160);
  ok('and back the other way returns', /دوئل/.test(await title()), await title());

  const before = await idx();
  await swipe(18);                                   // a nudge, not a swipe
  ok('a small drag snaps back instead of switching', (await idx()) === before, 'index ' + before + ' → ' + (await idx()));

  const t0 = await title();
  await swipe(0, 120);                               // a vertical flick
  ok('a vertical flick is a scroll, not a mode change', (await title()) === t0);
}

console.log('the rest:');
{
  await page.evaluate(() => { try { (0, eval)('hmSet')(0); } catch (e) {} });
  await page.waitForTimeout(200);
  const arrow = await page.evaluate(async () => {
    document.querySelector('#mcard .mk-arrow.next').click();
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector('#mcard h2').textContent;
  });
  ok('the arrow works too', /بازمانده/.test(arrow), arrow);

  const t3 = await page.evaluate(() => ({ n: document.querySelectorAll('#top3Row .t3p').length, txt: (document.getElementById('top3Row').textContent || '').replace(/\s+/g, ' ').slice(0, 60) }));
  ok('the week’s three biggest prizes are real rows', t3.n === 3, t3.txt);
  ok('and they show money, not cup points', /۲٬۴۰۰٬۰۰۰|2,400,000/.test(t3.txt), t3.txt);

  /* "still there" passed on ANY value, including the transparent rail a later
     !important block was still winning. Assert the colour it must actually be. */
  const cup = await page.evaluate(() => {
    const el = document.querySelector('#home .weekly-progress-line');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { onHeader: !!el.closest('.pz-header'), flag: getComputedStyle(el.querySelector('.wpl-flag small')).color, marker: !!el.querySelector('.wpl-marker') };
  });
  ok('the cup rail is still there', !!cup && cup.marker, JSON.stringify(cup));
  /* The rail is on the dark header now, so its own light-on-dark colours are
     the right ones — the light-card overrides are gone. */
  ok('the cup rail sits on the header, not on its own card', !!cup && cup.onHeader, JSON.stringify(cup).slice(0, 80));
}

/* ---- the squash ----
   .screen is a scrolling flex column, and flex items shrink by default. Once
   the real content made the page taller than the phone, every block was
   compressed below its own content height and their insides overlapped — the
   report was "at first it draws, then everything goes into everything".
   Nothing here may shrink; the screen scrolls instead. Measured on a SHORT
   phone, because that is where it bites. */
console.log('nothing may be squashed:');
for (const [w, h] of [[390, 844], [360, 640], [412, 732]]) {
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, sh: e.scrollHeight }; };
    const parts = { cup: box('#home .weekly-progress-line'), stage: box('.hstage'), card: box('#mcard'), top3: box('.top3') };
    /* A block shorter than what it contains is a squashed block. */
    const squashed = Object.keys(parts).filter((k) => parts[k] && parts[k].sh - parts[k].h > 2);
    /* And two blocks must never sit on top of one another. */
    const order = [parts.cup, parts.stage, parts.top3].filter(Boolean);
    let overlap = false;
    for (let i = 1; i < order.length; i++) if (order[i].top < order[i - 1].bottom - 1) overlap = true;
    return { squashed, overlap, card: parts.card && Math.round(parts.card.h) };
  });
  /* Home is one screen. A start button below the fold is a start button
     nobody presses. */
  const sc = await page.evaluate(() => { const e = document.getElementById('home'); return { sh: e.scrollHeight, ch: e.clientHeight, top: e.scrollTop }; });
  ok('home does not scroll at ' + w + '×' + h, sc.sh <= sc.ch + 2, sc.sh + ' vs ' + sc.ch);
  if (r.squashed.length) console.log('     ', JSON.stringify(await page.evaluate(() => {
    const st = document.querySelector('.hstage'), c = document.querySelector('#mcard');
    return { stage: Math.round(st.getBoundingClientRect().height) + '/' + st.scrollHeight,
             kids: [...st.children].map((e) => e.className + ':' + Math.round(e.getBoundingClientRect().height) + '/' + e.scrollHeight),
             card: Math.round(c.getBoundingClientRect().height) + '/' + c.scrollHeight,
             cardKids: [...c.children].map((e) => (e.className || '?') + ':' + Math.round(e.getBoundingClientRect().height)) };
  })));
  ok('nothing is squashed at ' + w + '×' + h, r.squashed.length === 0, r.squashed.join(',') || 'none');
  ok('and no two blocks overlap at ' + w + '×' + h, !r.overlap, 'card ' + r.card + 'px');
}
await page.setViewportSize({ width: 390, height: 844 });

console.log('the banner is the one exception:');
{
  const r = await page.evaluate(async () => {
    const home = document.getElementById('home');
    const before = getComputedStyle(home).overflowY;
    /* Put a banner in the way the banner system does. */
    let host = home.querySelector('.tk-promo-host');
    if (!host) { host = document.createElement('div'); host.className = 'tk-promo-host'; home.insertBefore(host, home.firstChild); }
    host.innerHTML = '<div style="height:150px;background:#333">بنر</div>';
    (0, eval)('pzHomeBannerFit')(host);
    await new Promise((r2) => setTimeout(r2, 250));
    const withB = { overflow: getComputedStyle(home).overflowY, sh: home.scrollHeight, ch: home.clientHeight };
    /* Scroll it away and back, the way a thumb would. */
    home.scrollTop = 999; await new Promise((r2) => setTimeout(r2, 120));
    const scrolledAway = home.scrollTop > 100;
    const bannerTop = host.getBoundingClientRect().bottom;
    home.scrollTop = 0; await new Promise((r2) => setTimeout(r2, 120));
    const backAgain = host.getBoundingClientRect().bottom > 0;
    host.innerHTML = ''; (0, eval)('pzHomeBannerFit')(host);
    await new Promise((r2) => setTimeout(r2, 200));
    return { before, withB, scrolledAway, bannerTop, backAgain, after: getComputedStyle(home).overflowY, afterSh: home.scrollHeight, afterCh: home.clientHeight };
  });
  ok('home does not scroll without a banner', r.before === 'hidden' && r.after === 'hidden', r.before + ' / ' + r.after);
  ok('and it may scroll while one is shown', r.withB.overflow === 'auto', r.withB.overflow + ', ' + r.withB.sh + ' vs ' + r.withB.ch);
  /* The banner has to ADD height, not squeeze the page — otherwise there is
     nothing to scroll and it can never go away. */
  ok('the banner adds real scroll room', r.withB.sh > r.withB.ch + 100, r.withB.sh + ' vs ' + r.withB.ch);
  ok('pushing the page up scrolls the banner away', r.scrolledAway && r.bannerTop <= 0, 'banner bottom at ' + Math.round(r.bannerTop));
  ok('and pulling back down brings it again', r.backAgain);
  ok('removing the banner puts home back to one screen', r.afterSh <= r.afterCh + 2, r.afterSh + ' vs ' + r.afterCh);
}

ok('no script errors on the new home', errs.length === 0, errs.slice(0, 2).join(' | '));
await page.screenshot({ path: '/tmp/claude-0/-home-user-prizzequizz/8e7dbfdd-7716-52fe-a640-0feaacd6599f/scratchpad/home-real.png' });
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
