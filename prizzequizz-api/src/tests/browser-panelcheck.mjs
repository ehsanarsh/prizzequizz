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
const saved = { box: null, character: null, config: null, music: null, musicUpload: null };
/* Two tracks the operator has already uploaded, and the settings the Last
   Survivor screen is built from. */
const MUSIC = [
  { id: 'm1', title: 'بی‌کلام ۱', mime: 'audio/mpeg', bytes: 2_300_000, enabled: true, sortOrder: 0, createdAt: '' },
  { id: 'm2', title: 'بی‌کلام ۲', mime: 'audio/mpeg', bytes: 3_100_000, enabled: true, sortOrder: 1, createdAt: '' }
];
const LS_CFG = {
  room: { capacity: 20, minUsers: 3, waitSeconds: 60, manualStartEnabled: true, startPct: 70 },
  timings: { readySeconds: 5, questionSeconds: 15, eliminationSeconds: 5, dashboardSeconds: 5, cashoutSeconds: 10 },
  match: { totalRounds: 12, minSurvivors: 1 },
  features: { animations: true, chat: true },
  economy: { rakePercent: 10, tickets: { green: { value: 12500, units: 1 }, blue: { value: 25000, units: 2 }, red: { value: 50000, units: 4 } } }
};
/* The topics tab reads the game config and writes it back — including the
   internal toss bank, which must survive a save it was not part of. */
const CFG = { version: '1.2.3', categories: [
  { name: 'فوتبال', icon: '⚽', enabled: true, order: 1 },
  { name: 'سینما و سریال', icon: '🎬', enabled: true, order: 2 },
  { name: 'انتخاب موضوع', icon: '⚡', enabled: false, order: 99, role: 'toss', note: 'بانک جدا' }
] };
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
  if (p === '/admin/waiting-music/raw') {
    /* The file goes as itself now: the body IS the bytes, and the name rides
       in the query string. */
    saved.musicUpload = {
      title: u.searchParams.get('title') || '',
      type: route.request().headers()['content-type'] || '',
      bytes: (route.request().postDataBuffer() || Buffer.alloc(0)).length,
      key: route.request().headers()['x-admin-key'] || ''
    };
    return send({ id: 'm3', bytes: saved.musicUpload.bytes });
  }
  if (p === '/admin/waiting-music') {
    if (m === 'POST') { try { saved.musicUpload = JSON.parse(route.request().postData() || '{}'); } catch (e) {} return send({ id: 'm3' }); }
    return send({ rows: MUSIC, maxBytes: 15 * 1024 * 1024 });
  }
  if (/^\/admin\/waiting-music\//.test(p)) {
    if (m === 'PATCH') { try { saved.music = JSON.parse(route.request().postData() || '{}'); } catch (e) {} return send({ id: 'm1', enabled: false }); }
    return send({ removed: true });
  }
  if (p === '/admin/last-survivor/config') return send(LS_CFG);
  if (p === '/admin/last-survivor/rooms') return send({ rows: [] });
  if (p === '/admin/last-survivor/topics') return send({ topics: [], categories: [], randomCategories: [] });
  if (p === '/admin/config') {
    if (m === 'PATCH') { try { saved.config = JSON.parse(route.request().postData() || '{}'); } catch (e) {} return send({ ok: true }); }
    return send(CFG);
  }
  if (p === '/admin/questions') return send([{ id: 'q1', category: 'فوتبال', status: 'approved' }]);
  if (p === '/admin/categories/images') return send({ images: {}, maxBytes: 200000 });
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

/* ── 4. THE TOPICS TAB, AND THE QUIZ-MAKER SWITCH ──────────────────────── */
{
  console.log('\nthe topics tab:');
  await page.evaluate(() => { (0, eval)('CFG=null; CUR="categories";'); });
  await page.evaluate(() => (0, eval)('renderCategories()'));
  await page.waitForTimeout(900);

  const head = await page.evaluate(() => (document.querySelector('#main .card .cfg-row') || {}).innerText || '');
  ok('the topic rows have a quiz-maker column', /کوییزساز/.test(head), head.replace(/\s+/g, ' '));
  const boxes = await page.evaluate(() => [...document.querySelectorAll('[id^=cat_mk_]')].map((b) => ({ id: b.id, on: b.checked, off: b.disabled })));
  ok('one tick per topic', boxes.length === 3, JSON.stringify(boxes));
  ok('and every topic starts open to the maker', boxes.slice(0, 2).every((b) => b.on === true), JSON.stringify(boxes));
  /* «انتخاب موضوع» is the internal toss bank — not a subject anybody writes
     about, so its tick is shown but cannot be given. */
  ok('the toss bank cannot be ticked', boxes[2].off === true, JSON.stringify(boxes[2]));

  saved.config = null;
  await page.evaluate(async () => {
    document.getElementById('cat_mk_1').checked = false;      // سینما و سریال
    await (0, eval)('catSave')();
  });
  await page.waitForTimeout(700);
  const sent = saved.config && saved.config.categories;
  ok('saving sends the topics to the server', !!sent, JSON.stringify(saved.config));
  ok('with the topic that was switched off marked so',
     !!sent && sent.find((c) => c.name === 'سینما و سریال').maker === false,
     JSON.stringify(sent && sent.find((c) => c.name === 'سینما و سریال')));
  ok('and the others left open', !!sent && sent.find((c) => c.name === 'فوتبال').maker === true,
     JSON.stringify(sent && sent.find((c) => c.name === 'فوتبال')));
  /* THE OLD SAVE REBUILT EACH ROW FROM FOUR KEYS, so `role` — the thing that
     marks the toss bank — was dropped on every save the panel made. */
  ok('the toss bank keeps what makes it the toss bank',
     !!sent && sent.find((c) => c.name === 'انتخاب موضوع').role === 'toss',
     JSON.stringify(sent && sent.find((c) => c.name === 'انتخاب موضوع')));
}

/* ── 5. THE WAITING-ROOM MUSIC, FROM THE OPERATOR'S SIDE ────────────────── */
{
  console.log('\nthe waiting-room music card:');
  await page.evaluate(() => { (0, eval)('CUR="lastsurvivor";'); });
  await page.evaluate(() => (0, eval)('renderLastSurvivor()'));
  await page.waitForTimeout(900);

  const card = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#main .card')];
    const c = cards.find((x) => /موزیک/.test(x.innerText));
    if (!c) return null;
    return {
      text: c.innerText.replace(/\s+/g, ' ').slice(0, 500),
      file: !!c.querySelector('#lsm_file'),
      accept: (c.querySelector('#lsm_file') || {}).accept || '',
      title: !!c.querySelector('#lsm_title'),
      rows: c.querySelectorAll('tbody tr').length,
      players: !!c.querySelector('audio')
    };
  });
  ok('the Last Survivor screen has a music card', !!card, JSON.stringify(card));
  ok('with a file picker for audio', card.file && /audio/.test(card.accept), card.accept);
  ok('and a name field that is only for the operator', card.title && /فقط در همین پنل|فقط برای خودت/.test(card.text), card.text.slice(0, 120));
  ok('the uploaded tracks are listed', card.rows === 2, String(card.rows));
  ok('each with a way to hear it before players do', card.players === true, String(card.players));

  /* A FILE TOO BIG IS REFUSED BEFORE THE WAIT, not after it. Uploading six
     megabytes and being told no at the end of it is the operator's time spent
     for nothing. */
  saved.musicUpload = null;
  await page.setInputFiles('#lsm_file', { name: 'big.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(16 * 1024 * 1024) });
  await page.evaluate(() => document.getElementById('lsm_add').click());
  await page.waitForTimeout(900);
  ok('a file over the limit is not uploaded at all', saved.musicUpload === null, JSON.stringify(saved.musicUpload && Object.keys(saved.musicUpload)));
  ok('and the operator is told why', await page.evaluate(() => {
    const t = document.querySelector('.toast, #toast');
    return /حجم/.test((t && t.textContent) || '');
  }));

  /* One inside the limit really is sent — and sent as the FILE, not as a
     base64 string wrapped in JSON. That wrapping is what killed a ten-megabyte
     upload in the browser before it ever left. */
  saved.musicUpload = null;
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200000)]);
  await page.setInputFiles('#lsm_file', { name: 'ok.mp3', mimeType: 'audio/mpeg', buffer: audio });
  await page.evaluate(() => { document.getElementById('lsm_title').value = 'تست'; document.getElementById('lsm_add').click(); });
  await page.waitForTimeout(1500);
  ok('a file inside the limit is uploaded', !!saved.musicUpload, JSON.stringify(saved.musicUpload));
  ok('as the file itself, byte for byte, with no base64 in front of it',
     !!saved.musicUpload && saved.musicUpload.bytes === audio.length,
     JSON.stringify(saved.musicUpload && { sent: saved.musicUpload.bytes, file: audio.length }));
  ok('with the operator’s own name and the file’s own type',
     !!saved.musicUpload && saved.musicUpload.title === 'تست' && /^audio\//.test(saved.musicUpload.type),
     JSON.stringify(saved.musicUpload && { t: saved.musicUpload.title, ty: saved.musicUpload.type }));
  ok('and the admin key on it', !!saved.musicUpload && saved.musicUpload.key === 'k', String(saved.musicUpload && saved.musicUpload.key));

  saved.music = null;
  await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => /خاموش کن/.test(b.textContent));
    btn.click();
  });
  await page.waitForTimeout(600);
  ok('switching one off tells the server', !!saved.music && saved.music.enabled === false, JSON.stringify(saved.music));
}

ok('no panel script errors', errs.length === 0, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close(); await browser.close(); server.close();
process.exit(fail ? 1 : 0);
