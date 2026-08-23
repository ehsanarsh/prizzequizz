/* BRINGING SOMEBODY NEW IN — the door, the code, the link, and who gets paid.
 *
 *   «آیکون دعوت در صفحهٔ اصلی اسمش به دعوت دوستان عوض بشه و وقتی می‌زنی باید
 *    به صفحهٔ کد معرف من بره — الان می‌ره به صفحهٔ دوستان.»
 *   «در صفحهٔ دوستان هم در قسمت افزودن، لینک دعوت و کپی لینک دعوت هم باید همان
 *    کد معرف باشه.»
 *   «اون کد همیشه برای یک کاربر باشه، کاربر دیگه‌ای نباید کد مشترک داشته باشن.»
 *   «هر کس با کد من بره به من بلیط می‌ده، نه به تازه‌وارد — نوشتی یه بلیط
 *    مهمون تو، باید عوض بشه.»
 *   «یه عکس هم با نام logo آپلود کردم، باید در سکو زیر نفر اول باشه.»
 *
 * The thread running through all of it: the referral CODE is the only thing a
 * new player can redeem. The home tile went to the wrong screen, the invite
 * link carried a username the referral system has never heard of, and the
 * screen told the newcomer the prize was theirs. Each one of those makes the
 * feature look present and do nothing.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

/* WHAT THE SITE-ADMIN PANEL HANDS BACK.
   Not a folder and not a filename: every upload gets an address of its own,
   a code with no name in it and no extension. Nothing about a picture can be
   worked out from what it is called, which is the whole reason the game has to
   look names up rather than guess at them. */
const MEDIA_URL = { logo: '/media/msi929ll-52a9mhwm',
  'medal-gold': '/media/mt69rmlc-jwpizbiq',
  'medal-silver': '/media/mt69rmwy-r9kfd8cc',
  'medal-bronze': '/media/mt69rloa-nb98jwyc' };
const ONE_PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4f0n+PwAHtALwCdbNDwAAAABJRU5ErkJggg==', 'base64');
/* '' = nothing uploaded · 'media' = uploaded through the panel, so only the
   panel's own addresses answer · 'root' = sitting beside index.html instead. */
let artUploaded = '';
let artAsked = [];
const MEDIA_OWNER = Object.fromEntries(Object.entries(MEDIA_URL).map(([k, v]) => [v, k]));

const server = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]);
  /* An uploaded picture, asked for by the address the panel gave it. */
  if (MEDIA_OWNER[rel]) {
    artAsked.push(rel);
    if (artUploaded !== 'media') { r.writeHead(404); return r.end('no'); }
    r.writeHead(200, { 'content-type': 'image/png' }); return r.end(ONE_PIXEL);
  }
  const art = /^\.?\/([a-z0-9-]+)\.(webp|png|jpg)$/.exec(rel);
  if (art && /^(medal-[a-z]+|logo|cup-crown|mode-[a-z]+|wheel[a-z]+|winchar|losechar)$/.test(art[1])) {
    artAsked.push(rel);
    if (artUploaded !== 'root') { r.writeHead(404); return r.end('no'); }
    r.writeHead(200, { 'content-type': 'image/png' }); return r.end(ONE_PIXEL);
  }
  /* Compare the PATH, not the raw url — `/?ref=…` is still the index, and
     joining it verbatim lands on the directory and 404s the whole page. */
  const f = path.join(ROOT, rel === '/' ? 'prizze-v643.html' : rel);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const MY_CODE = 'K7XQ2MW';
let refCalls = 0;
let board = [
  { userId: 'a', username: 'محمدرضا حسین‌زاده', score: 1840, avatar: '', character: null },
  { userId: 'b', username: 'Ali_TheDestroyer_99', score: 1520, avatar: '', character: null },
  { userId: 'c', username: 'نگار', score: 990, avatar: '', character: null }
];

async function makePage(query = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5 }));
    localStorage.setItem('pq_user_plan', 'premium');
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/users/me/referral') { refCalls++; return send({ code: MY_CODE, invites: 4, rewardTier: 'green', rewardCount: 1 }); }
    if (p === '/friends') return send([]);
    if (p === '/friends/requests') return send({ incoming: [], outgoing: [] });
    if (p.startsWith('/leaderboards/')) return send({ entries: board });
    if (p === '/users/me') return send({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5, balances: { wallet: 0 } });
    if (p === '/wallet') return send({ available: 0, locked: 0, tickets: { green: 3, blue: 2, red: 2 } });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  /* The clipboard is not available to a headless page, so what was copied is
     recorded instead — the point is WHAT gets copied, not that Chrome can. */
  await page.addInitScript(() => {
    window.__copied = [];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get: () => ({ writeText: (t) => { window.__copied.push(String(t)); return Promise.resolve(); } })
      });
    } catch (e) {}
  });
  await page.goto('http://127.0.0.1:' + PORT + '/' + query);
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

/* ── 1. THE DOOR ON THE HOME SCREEN ─────────────────────────────────────── */
{
  refCalls = 0;
  const { ctx, page, errs } = await makePage();
  console.log('the invite tile on home:');

  const rail = await page.evaluate(() => [...document.querySelectorAll('.hside')].map((t) => ({
    lbl: (t.querySelector('.lbl') || {}).textContent || '',
    ico: (t.querySelector('.art') || {}).textContent || ''
  })));
  const tile = rail.find((t) => /دعوت/.test(t.lbl));
  ok('the tile is there', !!tile, JSON.stringify(rail.map((t) => t.lbl)));
  ok('and it is called «دعوت دوستان»', tile && tile.lbl.trim() === 'دعوت دوستان', tile ? tile.lbl : '—');

  /* «وقتی می‌زنی باید به صفحهٔ کد معرف من بره» — the friends list is where you
     manage people you already know, not where you bring new ones in. */
  const landed = await page.evaluate(async () => {
    const tiles = [...document.querySelectorAll('.hside')];
    const t = tiles.find((x) => /دعوت/.test((x.querySelector('.lbl') || {}).textContent || ''));
    t.click();
    await new Promise((r) => setTimeout(r, 900));
    const on = [...document.querySelectorAll('.screen')].filter((s) => s.classList.contains('active')).map((s) => s.id);
    return { on, code: (document.getElementById('refCode') || {}).textContent || '' };
  });
  ok('tapping it opens the referral screen', landed.on.includes('referral'), JSON.stringify(landed.on));
  ok('and not the friends list', !landed.on.includes('friends'), JSON.stringify(landed.on));
  ok('the code is already being fetched when it opens', refCalls >= 1, String(refCalls));
  ok('and it is on the screen', landed.code.trim() === MY_CODE, landed.code);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. WHO THE PRIZE IS FOR ────────────────────────────────────────────── */
/* «هر کس با کد من بره به من بلیط می‌ده، نه به تازه‌وارد.» Both screens used to
   read the other way round: «مهمان تو می‌شود» on one, «جایزه بگیر» on the
   other — addressed to the person entering the code. */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nwho the ticket goes to:');
  const words = await page.evaluate(() => ({
    hero: (document.querySelector('#referral .ref-hero') || {}).textContent || '',
    ph: (document.getElementById('regReferral') || {}).placeholder || ''
  }));
  ok('the referral screen says the ticket comes to you', /به تو می‌رسد/.test(words.hero), words.hero.slice(0, 80));
  ok('and no longer that it is the newcomer’s', !/مهمان تو می‌شود/.test(words.hero), words.hero.slice(0, 80));
  ok('it says so outright', /جایزه برای توست/.test(words.hero), words.hero.slice(0, 140));
  /* The box the NEWCOMER types into must not promise them a prize. */
  ok('and the sign-up box does not promise the newcomer one', !/جایزه بگیر/.test(words.ph), words.ph);
  ok('it says whose prize it is', /به او برسد/.test(words.ph), words.ph);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE INVITE LINK IS THE CODE ─────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe invite link:');
  const link = await page.evaluate(() => (0, eval)('pzInviteLink')('K7XQ2MW'));
  ok('the link carries a ref', /[?&]ref=/.test(link), link);
  ok('and the ref is the code', /[?&]ref=K7XQ2MW(&|$)/.test(link), link);
  ok('an empty code gets no ref at all', !/ref=/.test(await page.evaluate(() => (0, eval)('pzInviteLink')(''))), 'empty');

  /* What actually lands on the clipboard, from the friends screen, without the
     referral screen ever having been opened. */
  const copied = await page.evaluate(async () => {
    window.__copied = [];
    await (0, eval)('copyInviteLink')();
    await new Promise((r) => setTimeout(r, 600));
    return window.__copied.slice();
  });
  ok('copying puts one link on the clipboard', copied.length === 1, JSON.stringify(copied));
  ok('and it is the code, not the username', /ref=K7XQ2MW/.test(copied[0] || ''), String(copied[0]));
  ok('the username is nowhere in it', !/ehsan/.test(copied[0] || ''), String(copied[0]));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3b. THE MESSAGE THAT GOES WITH IT ──────────────────────────────────── */
/* «نوشته بیا پرایز کوییز بازی کنیم ولی لینک سایت و بازی رو اصلا نذاشته.» It
   asked someone to come and play and gave them no way of getting there. */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe message sent with the code:');
  const t = await page.evaluate(async () => {
    await (0, eval)('pzRefCode')();
    return (0, eval)('refText')();
  });
  ok('it still asks them to come and play', /بیا پرایز کوییز بازی کنیم/.test(t), t);
  ok('it carries a link', /https?:\/\/[^\s]+/.test(t), t);
  ok('and the link is the way into the game', /[?&]ref=K7XQ2MW/.test(t), t);
  /* The code is inside the URL as well, so «does the text contain it» cannot
     tell the two apart — it has to be there as a line a person can READ, for
     whoever opens the message on one phone and signs up on another. */
  ok('the code is written out too, not only buried in the link',
     new RegExp('کد معرف من: ' + MY_CODE).test(t), t);
  ok('and on a line of its own', t.split('\n').some((l) => l.trim() === 'کد معرف من: ' + MY_CODE), JSON.stringify(t.split('\n')));
  ok('and it says when to use it', /موقع ثبت‌نام/.test(t), t);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE CARD IN THE FRIENDS SCREEN ──────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('\nthe «افزودن» card in the friends screen:');
  const card = await page.evaluate(async () => {
    (0, eval)("go('friends')");
    await new Promise((r) => setTimeout(r, 500));
    (0, eval)("frActiveTab='add'; renderFriendsHub();");
    await new Promise((r) => setTimeout(r, 900));
    const box = document.querySelector('#friendsContent .qr-card');
    return { text: box ? box.textContent : '', code: (document.getElementById('frRefCode') || {}).textContent || '' };
  });
  ok('the card names the referral code', /کد معرف تو/.test(card.text), card.text.slice(0, 80));
  ok('and shows the code itself', card.code.trim() === MY_CODE, card.code);
  ok('not the username', !/ehsan/.test(card.text), card.text.slice(0, 80));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. A LINK THAT CARRIES A CODE HANDS IT OVER ────────────────────────── */
/* `?ref=` was written into every invite link and read by nobody. */
{
  const { ctx, page, errs } = await makePage('?ref=ABCD123');
  console.log('\narriving on an invite link:');
  /* Through the door, not by calling the filler by hand: every route into
     registration has to do this, not just the one that used to. */
  const got = await page.evaluate(async () => {
    const before = (document.getElementById('regReferral') || {}).value;
    (0, eval)("go('register')");
    await new Promise((r) => setTimeout(r, 400));
    return { kept: (() => { try { return sessionStorage.getItem('pz_ref'); } catch (e) { return null; } })(),
             before, after: (document.getElementById('regReferral') || {}).value };
  });
  ok('the code in the link is remembered', got.kept === 'ABCD123', String(got.kept));
  ok('and fills the sign-up box', got.after === 'ABCD123', String(got.after));

  /* It must never overwrite a code the player typed themselves. */
  const typed = await page.evaluate(async () => {
    const el = document.getElementById('regReferral');
    el.value = 'MINE99';
    (0, eval)("go('home')"); (0, eval)("go('register')");
    await new Promise((r) => setTimeout(r, 400));
    return el.value;
  });
  ok('but never overwrites one already typed', typed === 'MINE99', typed);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. THE LOGO ON THE WINNER'S PLINTH ─────────────────────────────────── */
{
  artUploaded = 'media'; artAsked = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe logo on the podium, uploaded through the panel:');
  const pod = await page.evaluate(async () => {
    (0, eval)("go('rankings')");
    await new Promise((r) => setTimeout(r, 400));
    (0, eval)('rankTab')(null, 'cup');
    await new Promise((r) => setTimeout(r, 1200));
    const pods = [...document.querySelectorAll('.podium .pod')];
    const read = (p) => {
      const img = p.querySelector('.base .pod-logo');
      if (!img) return null;
      const b = img.getBoundingClientRect(), base = p.querySelector('.base').getBoundingClientRect();
      return { src: img.getAttribute('src'), loaded: img.naturalWidth > 0,
               w: Math.round(b.width),
               insideThePlinth: b.top >= base.top - 1 && b.bottom <= base.bottom + 1 };
    };
    return { first: read(pods[1]), second: read(pods[0]), third: read(pods[2]) };
  });
  ok('the logo is on the podium', !!pod.first, JSON.stringify(pod));
  ok('and it came from the media folder', /^\/media\//.test((pod.first || {}).src || ''), String((pod.first || {}).src));
  ok('it actually loaded', (pod.first || {}).loaded === true, JSON.stringify(pod.first));
  ok('it sits on the plinth, not off it', (pod.first || {}).insideThePlinth === true, JSON.stringify(pod.first));
  ok('it is big enough to be seen', ((pod.first || {}).w || 0) >= 40, String((pod.first || {}).w));
  /* «روی سکوی یک بچسبه» — first place only. */
  ok('second place has none', pod.second === null, JSON.stringify(pod.second));
  ok('and neither has third', pod.third === null, JSON.stringify(pod.third));
  ok('and by the address the panel gave it, not by its name',
     ((pod.first || {}).src || '') === MEDIA_URL.logo, String((pod.first || {}).src));
  ok('nothing tried to guess a filename for it',
     !artAsked.some((a) => /logo\.(webp|png|jpg)$/.test(a)), JSON.stringify(artAsked.filter((a) => /logo/.test(a))));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  artUploaded = '';
}

/* ── 7. AND WITH NO LOGO UPLOADED, NO TRACE OF ONE ──────────────────────── */
{
  artUploaded = ''; artAsked = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nand with no logo uploaded at all:');
  const pod = await page.evaluate(async () => {
    (0, eval)("go('rankings')");
    await new Promise((r) => setTimeout(r, 400));
    (0, eval)('rankTab')(null, 'cup');
    await new Promise((r) => setTimeout(r, 2000));
    const p1 = [...document.querySelectorAll('.podium .pod')][1];
    const base = p1.querySelector('.base');
    return { logo: !!p1.querySelector('.pod-logo'), imgs: base.querySelectorAll('img').length,
             rank: (base.querySelector('.rk') || {}).textContent || '' };
  });
  /* A picture that was never uploaded must leave nothing behind — not a
     broken-image icon, and not a gap where the rank digit used to be. */
  ok('nothing is left on the plinth', pod.logo === false && pod.imgs === 0, JSON.stringify(pod));
  ok('and the rank is exactly where it was', pod.rank.trim() === '۱', pod.rank);
  /* `artAsked` is what the SERVER was asked for — the browser has already
     resolved './logo.webp' against the page, so it arrives as '/logo.webp'. */
  ok('its uploaded address was tried first',
     artAsked.indexOf(MEDIA_URL.logo) >= 0 && artAsked.indexOf(MEDIA_URL.logo) < artAsked.indexOf('/logo.webp'),
     JSON.stringify(artAsked.filter((a) => /logo/.test(a))));
  ok('and the game’s own folder only after that', artAsked.includes('/logo.webp'),
     JSON.stringify(artAsked.filter((a) => /logo/.test(a))));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 8. AND IT IS EVERY PICTURE, NOT JUST THE MEDALS ────────────────────── */
/* «هر عکسی» — every picture. The game already had its own loader for the
   `data-pzsrc` artwork (the mode cards, the cup, the wheel characters), and
   fixing only the podium would have left every one of those asking for a
   filename the panel never kept. Both loaders read the same lookup, and this
   is the half that is not the podium — driven directly, because no home-screen
   picture has been uploaded yet and inventing an address for one here would be
   putting made-up production data in a test. */
{
  artUploaded = 'media'; artAsked = [];
  const { ctx, page, errs } = await makePage();
  console.log('\nthe game’s own image loader:');

  const mapped = await page.evaluate(async () => {
    const im = document.createElement('img');
    document.body.appendChild(im);
    await new Promise((done) => { (0, eval)('pzTryArt')(im, 'logo', () => done()); setTimeout(done, 2500); });
    const out = { src: im.getAttribute('src'), art: im.getAttribute('data-pzart'), loaded: im.naturalWidth > 0 };
    im.remove();
    return out;
  });
  ok('a name in the table is fetched by its uploaded address', mapped.src === MEDIA_URL.logo, String(mapped.src));
  ok('and it loads', mapped.loaded === true, JSON.stringify(mapped));
  ok('it is still tracked under its name', mapped.art === 'logo', String(mapped.art));
  ok('no filename was ever guessed for it', !artAsked.some((a) => /logo\.(webp|png|jpg)$/.test(a)),
     JSON.stringify(artAsked.filter((a) => /logo/.test(a))));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  artUploaded = '';
}

/* ── 9. A NAME NOBODY HAS UPLOADED STILL WORKS THE OLD WAY ──────────────── */
/* The table is filled in one line at a time, so most names are not in it yet.
   Those have to keep behaving exactly as they did before any of this. */
{
  artUploaded = 'root'; artAsked = [];
  const { ctx, page, errs } = await makePage();
  console.log('\na name that is not in the table:');

  const home = await page.evaluate(async () => {
    (0, eval)("go('home')");
    await new Promise((r) => setTimeout(r, 1500));
    return [...document.querySelectorAll('img[data-pzsrc]')].map((im) => ({
      name: im.getAttribute('data-pzsrc'), loaded: im.naturalWidth > 0,
      hidden: getComputedStyle(im).display === 'none'
    })).filter((x) => x.name);
  });
  ok('the home screen names pictures of its own', home.length >= 1, JSON.stringify(home.map((x) => x.name)));
  ok('and they still load from the game’s own folder', home.some((x) => x.loaded && !x.hidden),
     JSON.stringify(home));
  ok('asked for by name, as they always were', artAsked.some((a) => /^\/mode-[a-z]+\.webp$/.test(a)),
     JSON.stringify(artAsked.slice(0, 6)));

  /* The lookup itself, for the rules that have no picture to look at. */
  const lists = await page.evaluate(() => ({
    mapped: (0, eval)('pzImgCandidates')('logo'),
    plain: (0, eval)('pzImgCandidates')('mode-duel'),
    path: (0, eval)('pzImgCandidates')('/some/where/thing'),
    url: (0, eval)('pzImgCandidates')('https://cdn.example.com/thing'),
    empty: (0, eval)('pzImgCandidates')('')
  }));
  ok('a name in the table starts at its uploaded address', lists.mapped[0] === MEDIA_URL.logo, JSON.stringify(lists.mapped));
  /* The panel's address IS the file — bolting .webp onto the end of it asks
     for something that does not exist. */
  ok('and that address is used whole, with nothing added', !/\.(webp|png|jpg)$/.test(lists.mapped[0]), lists.mapped[0]);
  ok('with the game’s own folder still behind it', lists.mapped.includes('./logo.webp'), JSON.stringify(lists.mapped));
  ok('a name not in the table goes straight to that folder', lists.plain[0] === './mode-duel.webp', JSON.stringify(lists.plain));
  ok('WebP before the rest', lists.plain.indexOf('./mode-duel.webp') < lists.plain.indexOf('./mode-duel.png'), JSON.stringify(lists.plain));
  ok('a path is left exactly as it is', lists.path.length === 3 && lists.path.every((u) => u.startsWith('/some/where/thing.')), JSON.stringify(lists.path));
  ok('and so is a full URL', lists.url.length === 3 && lists.url.every((u) => u.startsWith('https://cdn.example.com/thing.')), JSON.stringify(lists.url));
  ok('no name at all asks for nothing', lists.empty.length === 0, JSON.stringify(lists.empty));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
  artUploaded = '';
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
