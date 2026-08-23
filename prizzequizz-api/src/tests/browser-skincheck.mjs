/* THE BADGES THAT NEVER APPEARED, AND THE COLOURS THAT SAID NOTHING.
 *
 *   • «badge چرخونه و هدایا و ماموریت‌ها کار نمیکنه» — all three were painted
 *     onto header buttons that stopped existing when home was rebuilt.
 *   • «برای اعلان هم رنگش زرده و معلوم نیست» — a yellow pill on a yellow rail.
 *   • «افراد آنلاین بیاد به ستون سمت راست، کارتش زرد با نوشتهٔ مشکی، آیکون
 *     متمایز با موشن زنده بودن.»
 *   • «دکمه ضربدر خروج قرمز، دکمه بک زرد.»
 *   • «در تمام کارت‌ها دور کارت‌ها زرد باشه» — «و این زردها در قسمت دوستانه
 *     باید آبی باشه.»
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

/* What the server says is waiting for this player. */
let wheelReady = true, dailyClaimed = false, unread = 3;
let missions = {
  daily: [
    { id: 'm1', title: 'یک', progress: 3, target: 3, completed: true, claimed: false, rewards: [{ type: 'coins', amount: 10 }] },
    { id: 'm2', title: 'دو', progress: 1, target: 3, completed: false, claimed: false, rewards: [{ type: 'coins', amount: 10 }] },
    { id: 'm3', title: 'سه', progress: 3, target: 3, completed: true, claimed: true, rewards: [{ type: 'coins', amount: 10 }] }
  ],
  weekly: [], achievements: [], chain: null, resetsAt: {},
  box: { total: 3, done: 2, ready: false, opened: false, rewards: [] }, dailyRotates: false, nextSetAt: 0
};

async function makePage(plan = 'premium') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/rewards/status') return send({
      wheel: { ready: wheelReady, segments: [{ label: 'س', color: '#f00' }, { label: 'ب', color: '#0f0' }], title: 'گردونه', nextSpinAt: null },
      daily: { claimedToday: dailyClaimed, enabled: true, day: 2, streakDays: 2,
               days: [{ day: 1, icon: '🎁', label: 'یک' }, { day: 2, icon: '🎁', label: 'دو' }] }
    });
    if (p === '/missions') return send(missions);
    if (/^\/notifications/.test(p)) return send(Array.from({ length: unread }, (_, i) => ({ id: 'n' + i, type: 'system', title: 'x', body: 'y', readAt: null })));
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  await page.evaluate((pl) => (0, eval)("userPlan='" + pl + "'; planExplicitlyChosen=true; go('home');"), plan);
  await page.waitForTimeout(1400);
  return { ctx, page, errs };
}

const railTags = (page) => page.evaluate(() => {
  const out = {};
  document.querySelectorAll('#home .hside').forEach((el) => {
    out[el.querySelector('.lbl').textContent.trim()] = (el.querySelector('.tag') || {}).textContent || '';
  });
  return out;
});

/* ── 1. THE BADGES ──────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('what is waiting for the player:');
  const t = await railTags(page);
  ok('the wheel says it is ready to spin', t['گردونه'] === '!', JSON.stringify(t));
  ok('the gift says it has not been taken', t['هدایا'] === '!', JSON.stringify(t));
  /* One finished-and-unclaimed daily. The one still in progress does not
     count, and neither does the one already collected. */
  ok('the missions count what can be COLLECTED, not what is left to do', t['مأموریت‌ها'] === '۱', JSON.stringify(t));

  /* The prize box counts too, once it is ready. */
  missions = JSON.parse(JSON.stringify(missions));
  missions.box.ready = true; missions.box.done = 3;
  const withBox = await page.evaluate(async () => {
    await (0, eval)('pzMissionsLoad')(true);
    (0, eval)('hmRails')();
    await new Promise((r) => setTimeout(r, 200));
    return (document.querySelector('#home .hside:nth-child(2) .tag') || {}).textContent || '';
  });
  ok('a ready prize box is one more thing to collect', withBox === '۲', withBox);

  /* Nothing waiting means no mark at all — a badge that is always there says
     nothing. */
  wheelReady = false; dailyClaimed = true;
  missions.daily = missions.daily.map((m) => ({ ...m, claimed: true }));
  missions.box.ready = false; missions.box.opened = true;
  const none = await page.evaluate(async () => {
    await (0, eval)('pzRewardsLoad')(true);
    await (0, eval)('pzMissionsLoad')(true);
    (0, eval)('hmRails')();
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelectorAll('#home .hside .tag').length;
  });
  ok('and nothing waiting means no badges at all', none === 0, String(none));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE BELL ────────────────────────────────────────────────────────── */
{
  wheelReady = true; dailyClaimed = false; unread = 3;
  const { ctx, page, errs } = await makePage();
  console.log('the bell on the header:');
  const bell = await page.evaluate(() => {
    const b = document.getElementById('pzHdrBell'), t = document.getElementById('pzHdrBellTag');
    const r = b.getBoundingClientRect(), hdr = document.querySelector('#home .pz-header').getBoundingClientRect();
    const rgb = (c) => (c.match(/\d+/g) || []).map(Number);
    return { inHeader: r.top >= hdr.top - 1 && r.bottom <= hdr.bottom + 1,
             count: t.textContent, shown: t.classList.contains('on'),
             tagBg: rgb(getComputedStyle(t).backgroundColor),
             onRail: [...document.querySelectorAll('#home .hside .lbl')].some((e) => /اعلان/.test(e.textContent)) };
  });
  ok('it is on the header', bell.inHeader, JSON.stringify(bell.inHeader));
  ok('and not on a rail as well', bell.onRail === false, String(bell.onRail));
  ok('carrying the real unread count', bell.count === '۳' && bell.shown, JSON.stringify(bell));
  /* «رنگش زرده و معلوم نیست» */
  ok('the count is red, not yellow', bell.tagBg[0] > 180 && bell.tagBg[1] < 140 && bell.tagBg[2] < 140, bell.tagBg.join(','));
  /* And the same for the counts on the rails, which had the same problem: a
     yellow pill among yellow icons. */
  const railTag = await page.evaluate(() => {
    const t = document.querySelector('#home .hside .tag');
    if (!t) return null;
    return { bg: (getComputedStyle(t).backgroundColor.match(/\d+/g) || []).map(Number),
             fg: (getComputedStyle(t).color.match(/\d+/g) || []).map(Number) };
  });
  ok('the rail counts are red too', !!railTag && railTag.bg[0] > 180 && railTag.bg[1] < 140 && railTag.bg[2] < 140, JSON.stringify(railTag));
  ok('written in white so it can be read', railTag.fg.every((v) => v > 200), railTag.fg.join(','));

  const cleared = await page.evaluate(async () => {
    (0, eval)('PZ_UNREAD=0'); (0, eval)('pzPaintBellTag')();
    await new Promise((r) => setTimeout(r, 150));
    const t = document.getElementById('pzHdrBellTag');
    return { on: t.classList.contains('on'), vis: getComputedStyle(t).display };
  });
  ok('and it goes away when there is nothing unread', cleared.on === false && cleared.vis === 'none', JSON.stringify(cleared));

  const tap = await page.evaluate(async () => {
    document.getElementById('pzHdrBell').click();
    await new Promise((r) => setTimeout(r, 600));
    const ov = document.getElementById('pzInboxOverlay');
    return !!ov && ov.classList.contains('show');
  });
  ok('and tapping it opens the notifications', tap, String(tap));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE ONLINE CARD ─────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('«افراد آنلاین» on the right-hand rail:');
  const on = await page.evaluate(() => {
    const right = [...document.querySelectorAll('#hrailR .hside')];
    const left = [...document.querySelectorAll('#hrailL .hside')];
    const label = (e) => e.querySelector('.lbl').textContent.trim();
    const el = right.find((e) => label(e) === 'افراد آنلاین');
    if (!el) return { onRight: false, right: right.map(label), left: left.map(label) };
    const art = el.querySelector('.art'), lbl = el.querySelector('.lbl');
    const rgb = (c) => (c.match(/\d+/g) || []).map(Number);
    const waves = el.querySelector('.waves');
    const anim = waves ? getComputedStyle(waves, '::before').animationName : '';
    return { onRight: true, right: right.map(label), left: left.map(label),
             artBg: getComputedStyle(art).backgroundImage,
             lblBg: getComputedStyle(lbl).backgroundImage,
             lblColour: rgb(getComputedStyle(lbl).color),
             live: !!el.querySelector('.live'), waves: !!waves, anim };
  });
  ok('it is on the right column', on.onRight, JSON.stringify(on.right) + ' / ' + JSON.stringify(on.left));
  ok('and named in full', on.right.indexOf('افراد آنلاین') >= 0, on.right.join('،'));
  ok('the card is yellow', /255,\s*226,\s*74/.test(on.artBg), on.artBg.slice(0, 60));
  ok('the label too', /255,\s*226,\s*74/.test(on.lblBg), on.lblBg.slice(0, 60));
  /* «با نوشته مشکی» */
  ok('with black writing on it', on.lblColour.every((v) => v < 60), on.lblColour.join(','));
  /* «با موشن زنده بودن، مثلا از پشتش امواج گرد بزنه بیرون» */
  ok('and rings rippling out from behind it', on.waves && on.anim === 'hsWave', on.anim);
  ok('the live dot is still there', on.live, String(on.live));

  const tapped = await page.evaluate(async () => {
    [...document.querySelectorAll('#hrailR .hside')]
      .find((e) => e.querySelector('.lbl').textContent.trim() === 'افراد آنلاین').click();
    await new Promise((r) => setTimeout(r, 700));
    return [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id;
  });
  ok('and it still opens the online list', tapped === 'online', tapped);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE TWO BUTTONS ON THE MENU ─────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the «بیشتر» menu head:');
  const btns = await page.evaluate(async () => {
    (0, eval)('openMenu')();
    await new Promise((r) => setTimeout(r, 500));
    const head = document.querySelector('.menu-sheet-head');
    const back = head.querySelector('.ib-back'), close = head.querySelector('.ib-close');
    const rgb = (e) => (getComputedStyle(e).backgroundImage.match(/\d+/g) || []).map(Number);
    return { back: back ? rgb(back) : null, close: close ? rgb(close) : null,
             backTxt: back ? back.textContent.trim() : '', closeTxt: close ? close.textContent.trim() : '' };
  });
  ok('the back button is the one with the arrow', btns.backTxt === '→', btns.backTxt);
  ok('and it is yellow', btns.back && btns.back[0] > 200 && btns.back[1] > 170 && btns.back[2] < 120, String(btns.back));
  ok('the close button is the cross', btns.closeTxt === '✕', btns.closeTxt);
  ok('and it is red', btns.close && btns.close[0] > 180 && btns.close[1] < 140 && btns.close[2] < 130, String(btns.close));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. THE CARD BORDERS, IN BOTH HALVES OF THE GAME ────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the borders round the cards:');
  const paid = await page.evaluate(() => {
    const c = document.createElement('div'); c.className = 'card';
    document.querySelector('.phone').appendChild(c);
    const col = (getComputedStyle(c).borderTopColor.match(/\d+/g) || []).map(Number);
    const w = getComputedStyle(c).borderTopWidth;
    c.remove(); return { col, w };
  });
  /* «در تمام کارت‌ها دور کارت‌ها زرد رنگ باشه» */
  ok('a card is edged in yellow', paid.col[0] > 200 && paid.col[1] > 170 && paid.col[2] < 120, paid.col.join(','));
  /* The 2.5px keyline is reported as a whole number of device pixels, so the
     figure to hold onto is that it did not get thinner. */
  ok('and the edge is as thick as it always was', parseFloat(paid.w) >= 2, paid.w);

  /* «این زردها در قسمت دوستانه باید آبی باشه» */
  const free = await page.evaluate(async () => {
    (0, eval)("userPlan='free'; planExplicitlyChosen=true;");
    try { (0, eval)('applyPlanTheme')(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 400));
    const c = document.createElement('div'); c.className = 'card';
    document.querySelector('.phone').appendChild(c);
    const col = (getComputedStyle(c).borderTopColor.match(/\d+/g) || []).map(Number);
    c.remove();
    const rgb = (s, prop) => { const e = document.querySelector(s); return e ? (getComputedStyle(e)[prop].match(/\d+/g) || []).map(Number) : null; };
    return { card: col, themed: document.querySelector('.phone').classList.contains('theme-free'),
             bell: rgb('#pzHdrBell', 'backgroundImage'),
             online: rgb('#hrailR .hs-online .art', 'backgroundImage'),
             back: rgb('.menu-sheet-head .ib-back', 'backgroundImage') };
  });
  ok('the friendly side is themed at all', free.themed, String(free.themed));
  const blue = (c) => !!c && c[2] > c[0] && c[2] > 150;
  ok('there the card edge is blue instead', blue(free.card), String(free.card));
  ok('so is the bell', blue(free.bell), String(free.bell));
  ok('so is the online card', blue(free.online), String(free.online));
  ok('and so is the back button', blue(free.back), String(free.back));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── EVERY WAY OUT IS RED, EVERY WAY BACK IS YELLOW ─────────────────────── */
/* «هر دکمه ضربدر برای خروج هست باید قرمز بشه و هر دکمه بک زرد بشه.»
 *
 * `ib-close` and `ib-back` already said this, and the two buttons above prove
 * it. What was missing is every OTHER way out — the sheets, the quick-chat
 * panel, the photo viewer, the wheel, the quit button on the game screen —
 * none of which ever carried those classes. Checked as a rule rather than as
 * a tour of fifteen screens, so the next sheet that gets a ✕ is red without
 * anybody remembering to ask for it. */
{
  const { ctx, page, errs } = await makePage();
  console.log('every ✕ and every ↩ in the game:');
  const col = await page.evaluate(() => {
    const probe = (cls, tag = 'button') => {
      const e = document.createElement(tag);
      cls.split(' ').forEach((c) => e.classList.add(c));
      e.textContent = '✕';
      document.querySelector('.phone').appendChild(e);
      const bg = getComputedStyle(e).backgroundImage;
      const fg = getComputedStyle(e).color;
      e.remove();
      return { bg: (bg.match(/\d+/g) || []).map(Number), fg: (fg.match(/\d+/g) || []).map(Number) };
    };
    return {
      sheet: probe('sheet-x'), qcp: probe('qcp-x'), lb: probe('pz-lb-x'), quit: probe('pzm-quit'),
      close: probe('iconbtn ib-close'), back: probe('iconbtn ib-back'), pzback: probe('pz-back')
    };
  });
  const red = (c) => !!c && c.bg.length >= 3 && c.bg[0] > 170 && c.bg[1] < 150 && c.bg[2] < 140;
  const yellow = (c) => !!c && c.bg.length >= 3 && c.bg[0] > 200 && c.bg[1] > 160 && c.bg[2] < 130;
  ok('a sheet’s ✕ is red', red(col.sheet), JSON.stringify(col.sheet.bg));
  ok('the quick-chat ✕ is red', red(col.qcp), JSON.stringify(col.qcp.bg));
  /* This one was YELLOW — the same colour as every back button in the game,
     on a button that closes a full-screen photo. */
  ok('the photo viewer’s ✕ is red', red(col.lb), JSON.stringify(col.lb.bg));
  ok('the quit button on the game screen is red', red(col.quit), JSON.stringify(col.quit.bg));
  ok('and so is any ib-close', red(col.close), JSON.stringify(col.close.bg));
  ok('a back arrow is yellow', yellow(col.back), JSON.stringify(col.back.bg));
  ok('and so is a pz-back', yellow(col.pzback), JSON.stringify(col.pzback.bg));
  /* Red on red is unreadable; the mark on the button has to be legible. */
  const light = (c) => c.fg.length >= 3 && c.fg[0] + c.fg[1] + c.fg[2] > 600;
  ok('the crosses are drawn in white', ['sheet', 'qcp', 'lb', 'quit', 'close'].every((k) => light(col[k])),
     JSON.stringify(['sheet', 'qcp', 'lb', 'quit', 'close'].map((k) => col[k].fg)));

  /* THE RULE IS ABOUT BUTTONS. A ✕ that is not pressable is a mark, not an
     exit — the big cross the elimination animation stamps across the screen is
     drawn where the animation wants it, and painting it as a button would be
     reading the rule backwards. */
  const decorative = await page.evaluate(() => {
    const e = document.querySelector('.lsmo-x');
    return e ? { tag: e.tagName, pressable: typeof e.onclick === 'function' } : null;
  });
  ok('a decorative cross is not a button at all', !decorative || (decorative.tag !== 'BUTTON' && !decorative.pressable), JSON.stringify(decorative));

  /* AND EVERY ✕ BUTTON IN THE MARKUP REALLY CARRIES ONE OF THESE CLASSES. A
     button that closes something and was never given the class is the fault
     this is about, and no colour check can see one that does not exist. */
  const stray = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll('button')) {
      if (b.textContent.trim() !== '✕') continue;
      const c = b.className || '';
      if (/ib-close|sheet-x|qcp-x|pz-lb-x|pzm-quit/.test(c)) continue;
      out.push(c || '(no class)');
    }
    return out;
  });
  ok('no ✕ button anywhere is left uncoloured', stray.length === 0, JSON.stringify(stray).slice(0, 200));
  /* And the check can actually see them: an empty page would pass the line
     above too. */
  const crosses = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '✕').length);
  ok('and there really are crosses to check', crosses >= 8, String(crosses));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
