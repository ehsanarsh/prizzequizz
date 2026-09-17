/* THE PAYMENT SHEET ON A PHONE, NOT ON A LAPTOP.
 *
 * «چرا گزینه‌های مودال پرداخت رو پهن‌تر کردی؟ چرا متن‌ها رو زیر هم می‌نویسی که
 *  کارت‌ها پهن بشه و اسکرول بشه؟ بهت گفتم نمی‌خوام اسکرول بشه. اگه دیدی متن خیلی
 *  کوچیک می‌شه حداقل‌ترین اسکرول رو باید داشته باشه، و همهٔ متن‌های گزینه‌ها هم
 *  خونده بشن.»
 *
 * Three demands that pull against each other, and two earlier answers got it
 * wrong in opposite directions:
 *
 *   1. The timing badge («آنی» / «۲ دقیقه» / «تأیید شبکه») was hidden below
 *      360px. It was therefore readable on a laptop and GONE on the thing
 *      people actually pay with — and it is the only thing that distinguishes
 *      one door from another once the price is known.
 *   2. Then it was dropped onto its own line. Every row went from 59px to
 *      119px, the four doors no longer fit, and the sheet grew the scrollbar
 *      that had been complained about in the first place.
 *
 * So what is pinned here is all three at once, at the widths of real phones:
 * every word present, every row ONE line of name and ONE of note, and the
 * sheet fitting without a scroll wherever it possibly can. A test that checked
 * only "the badge is in the DOM" would have passed for both wrong answers.
 *
 * Run: node src/tests/browser-paynarrow.mjs */
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

const PRICE = 125000;
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** The sheet, open, at one phone size. `vault` decides whether the صندوق row
 *  carries the short «موجودی: …» note or the longer «موجودی کافی نیست — …» one,
 *  which is the widest note the sheet ever draws. */
async function open(width, height, vault = 900000) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let body = { ok: true, data: {} };
    if (u.includes('/orders/quote')) {
      body = { ok: true, data: { amount: PRICE, listPrice: PRICE, discount: 0, discountCode: '', discountError: '',
        currency: 'cash', label: 'بلیط سبز', vaultBalance: vault, canPayFromVault: vault >= PRICE, canPayByGateway: true } };
    } else if (u.includes('/payments/gateway')) {
      body = { ok: true, data: { cardToCard: true, mode: 'live', live: true, logo: LOGO, label: 'پرداخت امن با بلو پال' } };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 140)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  await page.evaluate(() => { (0, eval)('pzBuyOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'بلیط سبز'); });
  await page.waitForTimeout(800);
  return { ctx, page };
}

/** What a person looking at the sheet would be able to say about it. */
const look = (page) => page.evaluate(() => {
  /* How many lines a box actually renders, not how many it was given room for. */
  const linesOf = (el) => {
    if (!el) return 0;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    if (!lh) return 0;
    return Math.round(el.getBoundingClientRect().height / lh);
  };
  const rows = [...document.querySelectorAll('#pmList .pm')].map((el) => {
    const badge = el.querySelector('.pm-when');
    const bRect = badge ? badge.getBoundingClientRect() : null;
    const name = el.querySelector('.pm-name');
    const note = el.querySelector('.pm-note');
    return {
      h: Math.round(el.getBoundingClientRect().height),
      nameLines: linesOf(name),
      noteLines: linesOf(note),
      /* PAINTED, not merely present: a badge that is display:none, zero-width
         or empty is a badge nobody can read. */
      badge: badge && bRect.width > 0 && bRect.height > 0 && getComputedStyle(badge).display !== 'none'
        ? badge.textContent.trim() : '',
      /* Sitting beside the body on the same line, not pushed under it. */
      badgeBesideBody: (() => {
        const b = el.querySelector('.pm-body');
        if (!b || !bRect) return false;
        const br = b.getBoundingClientRect();
        return bRect.top < br.bottom - 2 && br.top < bRect.bottom - 2;
      })(),
      /* Nothing cut off in either direction. */
      nameClipped: name ? name.scrollWidth > name.clientWidth + 1 : false,
      noteClipped: note ? note.scrollHeight > note.clientHeight + 1 : false
    };
  });
  const sc = document.querySelector('#aaaModal .aaa-card > .aaa-sub');
  const card = document.querySelector('#aaaModal .aaa-card');
  const de = document.documentElement;
  return {
    rows,
    /* .aaa-sub is the element that actually scrolls. The card's own
       scrollHeight is meaningless here — .aaa-card::before is inset:-34%. */
    vOverflow: sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : -1,
    /* SIDEWAYS OVERFLOW HIDES FROM THE DOCUMENT.
       The first version of this test asked documentElement whether the page
       scrolled sideways, and the answer was always no — `.phone` clips it. So a
       `width:100%` button inside the discount row could push 31px past the edge
       of the sheet and every assertion still passed. What actually has to be
       asked is the sheet's own scroller, and the card's own edge. */
    hOverflow: sc ? Math.max(0, sc.scrollWidth - sc.clientWidth) : -1,
    pastCardEdge: (() => {
      if (!card || !sc) return -1;
      const cr = card.getBoundingClientRect();
      let worst = 0;
      for (const el of sc.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        worst = Math.max(worst, cr.left - r.left, r.right - cr.right);
      }
      return Math.round(worst);
    })(),
    cardOverflowsViewport: (() => {
      if (!card) return true;
      const r = card.getBoundingClientRect();
      return r.width > de.clientWidth + 1 || r.height > de.clientHeight + 1;
    })()
  };
});

/* ── EVERY PHONE WIDTH THE SHEET HAS TO SURVIVE ─────────────────────────── */
/* `maxRow` is the budget for one row. A wrapped row is ~119px; a two-line note
   is ~76px. The budget sits between them on purpose: it must fail the wrap and
   allow a long note its second line. */
const SIZES = [
  { w: 390, h: 844, label: 'a normal phone', maxRow: 80, maxScroll: 0 },
  { w: 360, h: 740, label: 'the common Android', maxRow: 80, maxScroll: 8 },
  { w: 330, h: 700, label: 'a narrow phone', maxRow: 80, maxScroll: 8 },
  /* The smallest screen anyone still pays on. Here a little scroll is the
     honest answer — «حداقل‌ترین اسکرول رو باید داشته باشه» — but it has to stay
     little, and it must not come from rows that doubled in height.
     64 is four pixels above what the sheet actually measures. A looser budget
     is not a safer one: at 90 this line passed with the short-screen trim
     deleted, which is 85px of scroll — «حداقل» stops meaning anything if the
     number is allowed to drift up to it. */
  { w: 320, h: 640, label: 'the smallest phone', maxRow: 80, maxScroll: 64 }
];

for (const s of SIZES) {
  for (const vault of [900000, 20000]) {
    const tag = `${s.w}×${s.h}` + (vault < PRICE ? ' short vault' : '');
    console.log(`\n${s.label} — ${tag}:`);
    const { ctx, page } = await open(s.w, s.h, vault);
    const r = await look(page);

    ok('four doors are drawn', r.rows.length === 4, r.rows.length + ' rows');

    /* 1. EVERY WORD IS THERE. */
    const badges = r.rows.map((x) => x.badge);
    ok('every row still says how long it takes', badges.every((b) => b.length > 0), badges.join(' | '));
    ok('and those are the real words', /آنی/.test(badges[0]) && /دقیقه/.test(badges[1]) && /شبکه/.test(badges[3]), badges.join(' | '));
    ok('no name is cut off', r.rows.every((x) => !x.nameClipped));
    ok('no note is cut off', r.rows.every((x) => !x.noteClipped));

    /* 2. THE ROW KEEPS ITS SHAPE — name and badge on one line. */
    ok('the badge sits beside the body, not under it', r.rows.every((x) => x.badgeBesideBody),
      r.rows.map((x) => (x.badgeBesideBody ? '·' : 'UNDER')).join(''));
    ok('every name is one line', r.rows.every((x) => x.nameLines === 1), r.rows.map((x) => x.nameLines).join(','));
    /* Today's wording never reaches a third line on its own — this is held by
       the CONTENT, and `-webkit-line-clamp:2` is what keeps it true if a note
       is ever made longer. Deleting the clamp does not fail this line now; it
       would fail `no row is taller than …` the moment a note outgrew it. */
    ok('no note runs past two lines', r.rows.every((x) => x.noteLines <= 2), r.rows.map((x) => x.noteLines).join(','));
    const tallest = Math.max(...r.rows.map((x) => x.h));
    ok(`no row is taller than ${s.maxRow}px`, tallest <= s.maxRow, 'tallest ' + tallest + 'px');

    /* 3. AND IT FITS. */
    ok('the sheet does not scroll sideways', r.hOverflow === 0, r.hOverflow + 'px');
    ok('nothing sticks out past the card edge', r.pastCardEdge === 0, r.pastCardEdge + 'px');
    ok('the card fits inside the screen', !r.cardOverflowsViewport);
    ok(s.maxScroll === 0 ? 'the sheet needs no vertical scroll' : `vertical scroll stays under ${s.maxScroll}px`,
      r.vOverflow <= s.maxScroll, r.vOverflow + 'px');

    await ctx.close();
  }
}

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
