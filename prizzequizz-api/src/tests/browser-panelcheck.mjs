/* THE PANEL'S HALF OF THE TWO NEW THINGS.
 *
 *   «داخل این جعبه جوایزی که در پنل تعیین شده به کاربر برسه»
 *   «در فروشگاه یه قسمت کاراکتر باشه با گروه‌بندی در پنل»
 *
 * Both are operator screens, so the test drives the real panel in a browser
 * and reads what it actually SENDS — a field that renders but never reaches the
 * server is the failure worth catching here.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'pzadmin.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

let box = { enabled: true, title: 'جعبهٔ جایزهٔ روزانه', rewards: [{ type: 'coins', amount: 300 }, { type: 'cup', amount: 15 }] };
const characters = [
  { id: 'ch-a', name: 'پهلوان', description: '', image: '', kind: 'normal', enabled: true, unlockLevel: 12, viaLevel: false, viaReward: false, viaPurchase: true, viaEvent: false, viaRandom: false, price: 700, group: 'قهرمانان', sortOrder: 0, newUntil: '', createdAt: '' },
  { id: 'ch-b', name: 'روباه', description: '', image: '', kind: 'normal', enabled: true, unlockLevel: 0, viaLevel: false, viaReward: false, viaPurchase: true, viaEvent: false, viaRandom: false, price: 300, group: 'حیوانات', sortOrder: 1, newUntil: '', createdAt: '' }
];
const saved = { box: null, character: null };
const broadcasts = [];

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.route('**/*', (route) => {
  const u = new URL(route.request().url());
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(d) });
  if (u.hostname === '127.0.0.1' && u.port === String(PORT)) return route.continue();
  const p = u.pathname.replace(/^.*\/v1/, '');
  const m = route.request().method();
  if (p === '/admin/missions') return send({ rows: [], metrics: ['matchesPlayed', 'matchesWon', 'questionsAnswered'] });
  if (p === '/admin/missions/box') {
    if (m === 'PUT') { try { saved.box = JSON.parse(route.request().postData() || '{}'); } catch (e) {} box = saved.box; return send(box); }
    return send(box);
  }
  if (p === '/admin/notifications/broadcast') {
    let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    broadcasts.push(b);
    return send({ audienceCount: 42, created: 42, sent: 40 });
  }
  if (p === '/admin/notifications/campaigns' || /^\/admin\/notifications/.test(p)) return send({ rows: [], types: [], policy: { types: {} }, labels: {} });
  if (p === '/admin/users' || /^\/admin\/users/.test(p)) return send({ rows: [], total: 0 });
  if (p === '/admin/characters') {
    if (m === 'POST') { try { saved.character = JSON.parse(route.request().postData() || '{}'); } catch (e) {} return send({ id: 'ch-a' }); }
    return send({ characters, hasDatabase: true, stats: [] });
  }
  return send({});
});
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
await page.goto('http://127.0.0.1:' + PORT + '/pzadmin.html');
await page.waitForTimeout(900);
await page.evaluate(() => { (0, eval)("API='https://stub.test/v1'; KEY='k'; PERMS=['*']; CUR='missions';"); });

/* ── 1. THE BOX EDITOR ──────────────────────────────────────────────────── */
console.log('the missions page:');
await page.evaluate(() => (0, eval)('renderMissions2()'));
await page.waitForTimeout(800);

const seen = await page.evaluate(() => {
  const card = document.querySelector('#msBody .card');
  return {
    there: !!card && /جعبه/.test(card.innerText),
    text: card ? card.innerText.replace(/\s+/g, ' ') : '',
    types: [...(document.getElementById('msb_t_0') || { options: [] }).options].map((o) => o.value),
    title: (document.getElementById('msb_title') || {}).value,
    firstAmount: (document.getElementById('msb_a_0') || {}).value,
    rows: ['msb_a_0', 'msb_a_1', 'msb_a_2', 'msb_a_3'].filter((i) => document.getElementById(i)).length
  };
});
ok('the box has an editor of its own', seen.there, seen.text.slice(0, 70));
ok('with the server’s current contents in it', seen.title === 'جعبهٔ جایزهٔ روزانه' && seen.firstAmount === '300',
   seen.title + ' / ' + seen.firstAmount);
ok('four reward rows to fill', seen.rows === 4, String(seen.rows));
/* Cup and character are the two new prize kinds the rework needs. */
ok('cup can be a prize', seen.types.includes('cup'), JSON.stringify(seen.types));
ok('and so can a character', seen.types.includes('character'), JSON.stringify(seen.types));
ok('and it explains the rule the box belongs to',
   /هر سه مأموریت/.test(seen.text) && /عوض نمی‌شوند/.test(seen.text), seen.text.slice(0, 140));

/* What it SENDS is the test — a field that renders and never leaves is worse
   than one that is missing, because the panel then lies about being saved. */
const sent = await page.evaluate(async () => {
  document.getElementById('msb_title').value = 'جعبهٔ ویژه';
  document.getElementById('msb_t_0').value = 'character';
  document.getElementById('msb_a_0').value = '1';
  document.getElementById('msb_g_0').value = 'ch-b';
  document.getElementById('msb_t_1').value = 'cup';
  document.getElementById('msb_a_1').value = '25';
  document.getElementById('msb_a_2').value = '0';
  document.getElementById('msb_a_3').value = '0';
  (0, eval)('msBoxSave()');
  await new Promise((r) => setTimeout(r, 600));
  return true;
});
ok('saving really sends it', !!saved.box, JSON.stringify(saved.box));
ok('with the title', saved.box && saved.box.title === 'جعبهٔ ویژه', saved.box && saved.box.title);
ok('the character prize, carrying which character', saved.box && saved.box.rewards[0].type === 'character' && saved.box.rewards[0].target === 'ch-b',
   JSON.stringify(saved.box && saved.box.rewards[0]));
ok('the cup prize', saved.box && saved.box.rewards[1].type === 'cup' && saved.box.rewards[1].amount === 25,
   JSON.stringify(saved.box && saved.box.rewards[1]));
ok('and the empty rows left out', saved.box && saved.box.rewards.length === 2, String(saved.box && saved.box.rewards.length));
void sent;

/* ── 2. THE CHARACTER'S SHOP GROUP ──────────────────────────────────────── */
console.log('the characters page:');
await page.evaluate(() => { (0, eval)("CUR='g_chars';"); });
await page.evaluate(() => (0, eval)('renderCharacters()'));
await page.waitForTimeout(800);

const list = await page.evaluate(() => (document.getElementById('main') || {}).innerText || '');
/* A level on a paid character is a gate on the purchase, so the row has to say
   it — otherwise the operator cannot see why nobody is buying it. */
ok('the list says a paid character also needs a level', /از لول ۱۲/.test(list), (list.match(/.{0,24}لول ۱۲.{0,10}/) || [''])[0]);

const form = await page.evaluate(async () => {
  (0, eval)("chEdit('ch-a')");
  await new Promise((r) => setTimeout(r, 500));
  const g = document.getElementById('ch_group');
  const dl = document.getElementById('ch_groups');
  return {
    has: !!g, value: g ? g.value : '',
    suggestions: dl ? [...dl.options].map((o) => o.value) : []
  };
});
ok('a character has a group field', form.has, '');
ok('showing the group it is already in', form.value === 'قهرمانان', form.value);
/* The groups already in use are offered, so the second «قهرمانان» is the same
   shelf and not a new one with a stray space in it. */
ok('and the groups already in use are offered', form.suggestions.includes('قهرمانان') && form.suggestions.includes('حیوانات'),
   JSON.stringify(form.suggestions));

/* «کاراکترها را فقط با سکه می‌توانم به فروش بگذارم نه تومان» — so the price
   has a unit beside it, and the unit has to travel with the save. */
const cur = await page.evaluate(() => {
  const sel = document.getElementById('ch_cur');
  return { has: !!sel, options: sel ? [...sel.options].map((o) => o.value) : [], value: sel ? sel.value : '' };
});
ok('a character price has a unit', cur.has, JSON.stringify(cur));
ok('and it can be coins or toman', cur.options.includes('coins') && cur.options.includes('cash'), JSON.stringify(cur.options));
ok('defaulting to coins for one already priced in coins', cur.value === 'coins', cur.value);

const savedChar = await page.evaluate(async () => {
  document.getElementById('ch_group').value = 'حیوانات';
  document.getElementById('ch_cur').value = 'cash';
  (0, eval)("chSave('ch-a')");
  await new Promise((r) => setTimeout(r, 600));
  return true;
});
ok('and saving sends the group with it', saved.character && saved.character.group === 'حیوانات', JSON.stringify(saved.character && saved.character.group));
ok('and the price unit too', saved.character && saved.character.currency === 'cash', JSON.stringify(saved.character && saved.character.currency));
void savedChar;
/* ── 3. SENDING TO A GROUP ──────────────────────────────────────────────── */
console.log('the notifications page:');
await page.evaluate(() => { (0, eval)("CUR='notifications'; NT_TAB='compose';"); });
await page.evaluate(() => (0, eval)('renderNotifications()'));
await page.waitForTimeout(900);

{
  const filled = await page.evaluate(async () => {
    document.getElementById('nt_title').value = 'سلام';
    document.getElementById('nt_body').value = 'متن پیام';
    const st = document.getElementById('seg_status'); if (st) st.value = '';
    (0, eval)('ntSubmit(false)');
    await new Promise((r) => setTimeout(r, 800));
    const t = document.querySelector('.toast, #toast');
    return { toast: t ? t.textContent : '', err: window.__lastErr || '' };
  });
  /* «اعلان‌ها گروهی نمی‌ره، ارور seg is not defined می‌ده» — the audience was
     read but never built. A broadcast that reaches the server at all is the
     whole assertion here; who is in the segment is the server's business. */
  ok('a group send reaches the server', broadcasts.length === 1, JSON.stringify(broadcasts[0] || null));
  ok('carrying the message', broadcasts[0] && broadcasts[0].title === 'سلام' && broadcasts[0].body === 'متن پیام',
     JSON.stringify(broadcasts[0] && { t: broadcasts[0].title, b: broadcasts[0].body }));
  ok('and an audience, not «undefined»', broadcasts[0] && broadcasts[0].segment && typeof broadcasts[0].segment === 'object',
     JSON.stringify(broadcasts[0] && broadcasts[0].segment));
  ok('with no «seg is not defined» thrown', !errs.some((e) => /seg is not defined/.test(e)), errs.join(' | '));
  void filled;
}

ok('no panel script errors', errs.length === 0, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close(); await browser.close(); server.close();
process.exit(fail ? 1 : 0);
