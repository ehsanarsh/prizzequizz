/* ONE WORD FOR ONE NUMBER.
 *
 * «در دوستان جلو بعضی‌هاشون می‌نویسه لول ۴ سطح ۴ — باید یکی‌شو بنویسه، فقط سطح ۴.»
 *
 * Two faults sitting on top of each other. The friend card carried a second
 * badge meant for the LEAGUE, but the friends query sends no cup, so it was
 * filled with the level a second time under a different word — the same fact,
 * printed twice, disagreeing about what to call itself. And the app at large
 * used «لول» and «سطح» interchangeably in a dozen places, which is what made
 * the doubling read as a bug rather than as a repetition.
 *
 * So this holds the whole surface to one word, not just the one card: whatever
 * screen is rendered, a level is called «سطح» and is printed once.
 *
 * Run: node src/tests/browser-levelword.mjs */
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
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 7, xp: 900, wallet: 0, coins: 500, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) }));
const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/* Exactly the shape the server sends for a friend: a level, and no cup — which
   is why the league slot had nothing to put in it. */
const painted = await page.evaluate(() => {
  const sf = { id: 'f1', username: 'sara', displayName: 'سارا', level: 4, avatar: '', character: null,
               online: true, lastSeenAt: null, unread: 0, lastMessage: '' };
  const mapped = (0, eval)('mapFriend')(sf);
  (0, eval)('FRIENDS_DATA').length = 0;
  (0, eval)('FRIENDS_DATA').push(mapped);
  const host = document.createElement('div');
  document.body.appendChild(host);
  (0, eval)('renderFriendsList')(host, '');
  const card = host.querySelector('.friend-card');
  const txt = (card ? card.textContent : '').replace(/\s+/g, ' ');
  return {
    txt,
    badges: card ? [...card.querySelectorAll('.mini-badge')].map((b) => b.textContent.trim()) : [],
    mappedKeys: Object.keys(mapped)
  };
});

console.log('a friend card:');
ok('the level is printed', /۴/.test(painted.txt), painted.txt);
ok('and it is called «سطح»', /سطح ۴/.test(painted.txt), painted.txt);
ok('never «لول»', !/لول/.test(painted.txt), painted.txt);
/* The heart of the report: the SAME number twice, under two names. */
ok('the number appears once, not twice',
  (painted.txt.match(/۴/g) || []).length === 1, painted.txt);
/* The presence chip is a different fact and belongs there; what must not be
   doubled is the LEVEL. */
ok('one badge carries the level, not two',
  painted.badges.filter((b) => /سطح|لول/.test(b)).length === 1, painted.badges.join(' | '));
/* And the empty slot is gone rather than left behind holding a copy. */
ok('the unwired league field is not carried around any more',
  !painted.mappedKeys.includes('league'), painted.mappedKeys.join(','));

/* ── THE PROFILE'S OWN LEVEL CELL ──────────────────────────────────────── */
/* Same fault, one screen over: the cell's value said the level and its caption
   said the word again. Repeating the WORD is the bug whether or not the word
   changes, so this reads the rendered cell rather than scanning for «لول». */
const cell = await page.evaluate(() => {
  try { showScreen('profile'); } catch (e) {}
  (0, eval)('paintProfileStats')();
  const grid = document.getElementById('profStatGrid');
  const cells = grid ? [...grid.querySelectorAll('.stat')] : [];
  const lvl = cells.find((c) => /سطح/.test(c.textContent || ''));
  if (!lvl) return { found: false };
  return { found: true,
           value: (lvl.querySelector('b') || {}).textContent || '',
           caption: (lvl.querySelector('span') || {}).textContent || '' };
});

console.log('the profile’s level cell:');
ok('the cell is there', cell.found === true);
ok('the value names the level', /سطح ?[۰-۹]+/.test(cell.value), cell.value);
ok('and the caption does not say it a second time', !/سطح/.test(cell.caption), cell.caption);
ok('the caption carries the league instead, which is a different fact',
  (cell.caption || '').trim().length > 0 && !/^\s*·/.test(cell.caption || ''), cell.caption);

/* ── THE WHOLE SURFACE, not only that one card ─────────────────────────── */
/* Rendering every screen and reading the DOM is the honest check, but many of
   these need a live server. The label is a literal in the source, so the source
   is where the answer is — and a scan there covers screens a test would never
   reach. Quiz text is excluded: «سلول» is a cell, not a level. */
const src = fs.readFileSync(path.join(ROOT, 'prizze-v643.html'), 'utf8');
/* Block comments are stripped WHOLE — the notes in this file quote the report
   verbatim («لول من ۱۵ هست»), and a line-by-line filter only catches the line a
   comment opens on, not the ones inside it. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
const stray = code.split('\n')
  .map((l, i) => ({ i, l }))
  .filter(({ l }) => /لول/.test(l) && !/سلول/.test(l));

console.log('and every other screen:');
ok('no screen still says «لول»', stray.length === 0,
  stray.slice(0, 3).map(({ l }) => l.trim().slice(0, 60)).join(' ⏎ ') || 'none');
ok('«سطح» is the word that is actually used', /سطح /.test(src));

console.log(`\n[levelword] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
