/* REAL SCREENS, CAPTURED FROM A RUNNING GAME.
 *
 * A designer redesigning from a description redesigns the description. So the
 * game is booted in a real mobile browser, every screen is opened, and what is
 * saved is what the browser actually painted: the DOM after the JavaScript has
 * filled it, and a screenshot of it.
 *
 * The API is stubbed rather than live — a handoff must be reproducible and must
 * not depend on who happens to be playing tonight — but the SHAPES are the real
 * ones the client asks for, so lists have rows and cards have numbers.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
const OUT = process.argv[2];
fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'prizze-v643.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 'test-token');
  localStorage.setItem('pz_rtok', 'test-rtoken');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان رستمی',
    level: 7, xp: 4200, wallet: 250000, coins: 1360, hearts: 4, weeklyScore: 640 }));
  /* THE ONE-TIME HINTS, ALREADY SEEN.
   *
   * The first capture came back with a tutorial card covering nearly every
   * screen — which is exactly what a new player sees, and exactly not what a
   * designer needs to redesign the screen underneath. These are the game's own
   * «do not show again» flags, set the way the game sets them. */
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});

const P = (n) => ({ id: 'u' + n, userId: 'u' + n, username: ['زرگل','رضا','سینا','مینا','کاوه','رها','نیما','سارا'][n % 8],
  displayName: ['زرگل','رضا','سینا','مینا','کاوه','رها','نیما','سارا'][n % 8], avatar: '', character: null,
  level: 3 + n, score: 2400 - n * 190, cup: 900 - n * 70, online: n % 2 === 0 });

await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ rank: i + 1, ...P(i), highlighted: i === 2 }));
  if (p.startsWith('/leaderboards')) return send({ entries: rows(8) });
  if (p.startsWith('/friends'))      return send({ friends: rows(6), requests: rows(2), suggestions: rows(4) });
  if (p.startsWith('/missions'))     return send({ missions: [
    { id: 'm1', title: 'یک مسابقه ببر', icon: '🏆', progress: 1, target: 1, claimed: false, completedAt: 1, rewards: [{ type: 'coins', amount: 150 }] },
    { id: 'm2', title: 'به ۲۰ سؤال جواب بده', icon: '❓', progress: 12, target: 20, claimed: false, rewards: [{ type: 'coins', amount: 150 }, { type: 'xp', amount: 100 }] },
    { id: 'm3', title: 'گردونه را بچرخان', icon: '🎡', progress: 0, target: 1, claimed: false, rewards: [{ type: 'coins', amount: 75 }] }] });
  if (p.startsWith('/shop'))         return send({ items: [
    { id: 's1', kind: 'ticket', title: 'بلیط سبز', price: 20000, icon: '🎫', tier: 'green' },
    { id: 's2', kind: 'coins', title: '۱۰۰۰ سکه', price: 15000, icon: '🪙' },
    { id: 's3', kind: 'heart', title: '۵ قلب', price: 12000, icon: '❤️' }], packs: [], characters: [] });
  if (p.startsWith('/leagues'))      return send({ tiers: [
    { id: 'bronze', name: 'برنز', min: 0, icon: '🥉' }, { id: 'silver', name: 'نقره', min: 300, icon: '🥈' },
    { id: 'gold', name: 'طلا', min: 800, icon: '🥇' }], current: 'silver', entries: rows(6) });
  if (p.startsWith('/wallet') || p.startsWith('/economy')) return send({ balance: 250000, coins: 1360, entries: [
    { id: 'e1', kind: 'credit', amount: 120000, description: 'جایزهٔ مسابقه', createdAt: new Date().toISOString() },
    { id: 'e2', kind: 'debit', amount: 20000, description: 'ورودی دوئل', createdAt: new Date().toISOString() }],
    wallet: {}, free: {}, categories: [], modes: {} });
  if (p.startsWith('/record'))       return send({ topics: [{ name: 'ورزش', icon: '⚽', best: 24 }, { name: 'تاریخ', icon: '🏛️', best: 18 }], entries: rows(6) });
  if (p.startsWith('/support'))      return send({ threads: [], macros: [], tickets: [] });
  if (p.startsWith('/notifications'))return send({ items: [], unread: 0 });
  if (p.startsWith('/users/'))       return send({ id: 'u1', username: 'ehsan', displayName: 'احسان رستمی', level: 7, xp: 4200,
    weeklyScore: 640, balances: { wallet: 250000, coins: 1360 }, matches: 42, wins: 25, tickets: { green: 3, blue: 1, red: 0 } });
  if (p.startsWith('/questions'))    return send({ questions: [{ id: 'q1', text: 'پایتخت ژاپن کدام است؟',
    options: ['توکیو', 'اوساکا', 'کیوتو', 'ناگویا'], correctIndex: 0, category: 'جغرافیا', difficulty: 'easy' }] });
  return send({});
});

const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);                       // splash routing

const names = await page.evaluate(() => [...document.querySelectorAll('.screen')].map((e) => e.id).filter(Boolean));
console.log('screens found:', names.length);

/* SOME SCREENS ARE EMPTY UNTIL SOMETHING FILLS THEM.
 *
 * `go()` only shows the shell; the lists and cards are written by a loader that
 * the button which normally opens the screen calls afterwards. Capturing
 * without them would hand the designer an empty div and a screenshot of a
 * blank page — the exact opposite of the point. Each of these is the function
 * the game itself calls, named, so nothing here invents markup. */
const FILL = {
  missions: ['pzMissionsLoad', 'renderMissions'],
  friends: ['friendsLoad', 'renderFriendsHub', 'renderFriendsList'],
  shop: ['pzLoadShop', 'renderShop'],
  support: ['renderSupport'],
  leagues: ['openLeagues'],
  wallet: ['renderWallet', 'renderWalletOverview'],
  settings: ['loadSettings', 'renderSettingsSummary'],
  stats: ['renderStats', 'renderStatsHeader'],
  online: ['onlineLoad'],
  feedback: ['loadFeedback', 'renderFeedbackList'],
  'setting-detail': ['renderSettingDetail'],
  'topic-pick': ['openTopicPick'],
  record: ['rmOpen']
};

const index = [];
for (const name of names) {
  try {
    await page.evaluate((n) => { try { (0, eval)(`go('${n}')`); } catch (e) {} }, name);
    await page.waitForTimeout(350);
    for (const fn of (FILL[name] || [])) {
      await page.evaluate((f) => { try { (0, eval)(`${f}()`); } catch (e) {} }, fn);
      await page.waitForTimeout(250);
    }
    /* Belt and braces: the league guide is gated on a setting rather than a
     * flag, and a modal that opened before the flags were read is still up.
     * closeAaaModal is the game's own dismiss. */
    await page.evaluate(() => {
      try { (0, eval)('appSettings').leagueGuide = false; } catch (e) {}
      for (let i = 0; i < 3; i++) { try { (0, eval)('closeAaaModal(false)'); } catch (e) {} }
    });
    await page.waitForTimeout(500);
    const info = await page.evaluate(() => {
      const el = document.querySelector('.screen.active');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { id: el.id, html: el.outerHTML, h: Math.round(el.scrollHeight), visible: r.width > 0 };
    });
    if (!info || info.id !== name) { console.log('  skip', name, '(did not open)'); continue; }
    /* Base64 pictures are replaced by a reference to the file they were
     * extracted to. A designer opening a 300KB line of base64 learns nothing,
     * and the picture is in assets/ where it can actually be looked at. */
    const clean = info.html.replace(/data:([a-z/+.-]+);base64,[A-Za-z0-9+/=]+/g,
      (m, mime) => `../assets/inline-${mime.replace(/[^a-z0-9]/gi, '-')}-${m.length}.bin`);
    fs.writeFileSync(path.join(OUT, 'screens', name + '.html'), clean);
    await page.screenshot({ path: path.join(OUT, 'shots', name + '.jpg'), type: 'jpeg', quality: 84, fullPage: false });
    index.push({ name, bytes: Buffer.byteLength(clean), height: info.h });
    console.log('  ok  ', name.padEnd(16), (Buffer.byteLength(clean) / 1024).toFixed(1) + ' KB');
  } catch (e) { console.log('  ERR ', name, String(e).slice(0, 80)); }
}
fs.writeFileSync(path.join(OUT, 'screens', '_index.json'), JSON.stringify(index, null, 1));
await browser.close(); server.close();
console.log('captured', index.length, 'of', names.length);
