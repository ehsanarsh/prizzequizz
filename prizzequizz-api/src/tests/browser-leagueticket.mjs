/* THE LEAGUE TICKET, IN THE HEADER, BIGGER THAN THE REST.
 *
 * «باید هر کسی که بلیط ورود به یکی از لیگ‌ها رو گرفت اون بلیط در هدر به صورت
 *  بزرگ‌تر از بلیط‌های معمولی دیده بشه … نه فونتاش تو هم بره نه بزرگ بشه … و
 *  اگه روش تاچ کنه توضیحات کامل و زمان مسابقه براش توضیح داده بشه.»
 *
 * Three requirements pulling against each other: make it stand out, do not let
 * the header swell, and do not shrink or collide any text. So this measures all
 * three against a real header in a real mobile browser.
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
/* A Friday-night kickoff the modal can print, and the tiers it names. */
const KICK = Date.now() + 6 * 3600_000;
/* The artwork lives in the media library, which this little file server does
 * not have. Without a stub the image 404s, pzArtNext falls back to the emoji,
 * and the test would be checking the fallback while believing it checked the
 * picture. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42mP8z8BQz0AEYBxVSF+F' +
  'jIyMDIwMDAxDQyEDAwMDAJ0kBPmR9tOEAAAAAElFTkSuQmCC', 'base64');
await ctx.route('**/media/**', (route) =>
  route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (p.startsWith('/leagues/me')) return send({
    enabled: true, seasonId: '2026-W34', roomSize: 10, rank: 4, cup: 640,
    tiers: [{ key: 'gold', label: 'طلایی', emoji: '🥇', participationPrize: 50000, winnerPrize: 900000, fromRank: 1, toRank: 10 }],
    tier: null, qualifiedTier: 'gold', tickets: { gold: 1 }, cutLines: [],
    kickoffAt: KICK, doorsOpenAt: KICK - 600_000, room: null,
    canEnter: false, enterBlockedReason: 'هنوز زمان ورود نرسیده است.'
  });
  return send({});
});

const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);
await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
await page.waitForTimeout(800);

const before = await page.evaluate(() => Math.round(document.querySelector('.pz-header').getBoundingClientRect().height));

/* Win a gold ticket. */
const set = await page.evaluate(() => {
  try { (0, eval)('mTickets').gold = 1; (0, eval)('renderHeaderTickets()'); return 'ok'; }
  catch (e) { return String(e).slice(0, 90); }
});
ok('the ticket can be given to the player', set === 'ok', set);
await page.waitForTimeout(600);

const m = await page.evaluate(() => {
  const hd = document.querySelector('.pz-header');
  const lg = document.querySelector('.pzh-pill.p-league');
  const normal = document.querySelector('.pzh-pill:not(.p-league)');
  const num = lg && lg.querySelector('b');
  const img = lg && lg.querySelector('img.pz-lgtk');
  const nb = normal && normal.querySelector('b');
  return {
    header: Math.round(hd.getBoundingClientRect().height),
    league: lg ? Math.round(lg.getBoundingClientRect().height) : 0,
    leagueW: lg ? Math.round(lg.getBoundingClientRect().width) : 0,
    normal: normal ? Math.round(normal.getBoundingClientRect().height) : 0,
    normalW: normal ? Math.round(normal.getBoundingClientRect().width) : 0,
    imgSrc: img ? img.getAttribute('src') : '',
    numFs: num ? getComputedStyle(num).fontSize : '',
    normalNumFs: nb ? getComputedStyle(nb).fontSize : '',
    /* Anything overlapping its neighbour would be «فونتاش تو هم رفته». */
    overlap: (() => {
      const pills = [...document.querySelectorAll('.pzh-wallets > *')];
      for (let i = 1; i < pills.length; i++) {
        const a = pills[i - 1].getBoundingClientRect(), b = pills[i].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1) return true;
      }
      return false;
    })()
  };
});

console.log('the chip:');
ok('a league ticket appears in the header', m.league > 0, m.league + 'px');
ok('and it is bigger than an ordinary ticket', m.league > m.normal, m.league + 'px vs ' + m.normal + 'px');
ok('noticeably bigger, not by a pixel', m.league >= m.normal + 6, '+' + (m.league - m.normal) + 'px');
ok('it carries the ticket artwork, not an emoji', /\/media\//.test(m.imgSrc), m.imgSrc || 'no image (fell back to the emoji)');

console.log('nothing else moved:');
ok('the number in it is the same size as every other number', m.numFs === m.normalNumFs, m.numFs + ' vs ' + m.normalNumFs);
ok('no pill overlaps its neighbour', !m.overlap);
/* It has to cost something — a bigger chip needs a taller row. The budget is
   what was freed by slimming the header, not the player's screen. */
ok('the header grows by a little, not a lot', m.header - before <= 12, '+' + (m.header - before) + 'px');
ok('and stays well under the 210px it used to be', m.header <= 195, m.header + 'px');

/* ONLY THE TIERS ACTUALLY HELD. A permanent «۰» beside the others would be an
   advert for a shelf that is empty for most players most of the week, and the
   header would carry the extra height all the time instead of only when there
   is something to show. */
const counts = await page.evaluate(() => {
  const n = () => document.querySelectorAll('.pzh-pill.p-league').length;
  const h = () => Math.round(document.querySelector('.pz-header').getBoundingClientRect().height);
  const t = (0, eval)('mTickets'), draw = (0, eval)('renderHeaderTickets');
  const out = {};
  t.gold = 1; t.silver = 0; t.bronze = 0; draw(); out.one = n();
  t.silver = 2; draw(); out.two = n();
  t.gold = 0; t.silver = 0; t.bronze = 0; draw(); out.none = n(); out.noneH = h();
  t.gold = 1; draw(); out.back = n();          // put the gold ticket back for the tap below
  return out;
});
ok('only the tiers actually held are drawn', counts.one === 1, counts.one + ' chips for one ticket');
ok('a second ticket of another tier adds a second chip', counts.two === 2, counts.two + ' chips');
ok('a player holding none gets no chip at all', counts.none === 0, counts.none + ' chips');
ok('and their header is the height it was before any of this', counts.noneH === before, counts.noneH + 'px vs ' + before + 'px');
ok('winning one again brings it back', counts.back === 1, counts.back + ' chips');

console.log('tapping it:');
/* The ordinary tickets are explained by the SAME handler, and this is the only
   place that proves the tap still reaches it — a change to the big chip must
   not quietly cost the small ones their explanation. */
await page.click('.pzh-pill.p-tk', { force: true });
await page.waitForTimeout(700);
const plain = await page.evaluate(() => {
  const el = document.getElementById('aaaModal');
  const shown = el && getComputedStyle(el).display !== 'none';
  return { shown, text: shown ? (el.textContent || '').replace(/\s+/g, ' ').slice(0, 40) : '' };
});
ok('an ordinary ticket still explains itself when tapped', plain.shown, plain.text);
await page.evaluate(() => { try { (0, eval)('closeAaaModal()'); } catch (e) {} });
await page.waitForTimeout(500);

/* `force` because the chip breathes: a 1.5px float that never settles, which
   is deliberate — it is how a player notices something arrived — and which
   Playwright would otherwise wait for forever. */
await page.click('.pzh-pill.p-league', { force: true });
await page.waitForTimeout(900);
const modal = await page.evaluate(() => {
  const el = document.getElementById('aaaModal');
  const shown = el && getComputedStyle(el).display !== 'none';
  return { shown, text: shown ? (el.textContent || '').replace(/\s+/g, ' ') : '', art: !!el.querySelector('img.pz-lgtk-big') };
});
ok('the explanation opens', modal.shown);
ok('it says when the match is', /شروع مسابقه/.test(modal.text), modal.text.slice(0, 60));
ok('it says the ticket cannot be bought', /خریدنی نیست/.test(modal.text));
ok('it warns the ticket is lost if the hour is missed', /باطل می‌شود/.test(modal.text));
ok('it names the prize for turning up', /جایزهٔ حضور/.test(modal.text));
ok('and the same artwork is on the card', modal.art);

await page.screenshot({ path: '/tmp/lgticket.jpg', type: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: 390, height: 300 } });
console.log(`\n[leagueticket] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
