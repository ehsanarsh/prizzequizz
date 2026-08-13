/* THE CHAT WORK, DRIVEN IN A REAL BROWSER.
 *
 *   1. A profile photo must appear as a PICTURE, never as its web address —
 *      in the friend chat window, in the duel header, in the seat ring and in
 *      any modal that was handed an avatar where an emoji was expected.
 *   2. The duel's quick chat: a named yellow button under your own face, a
 *      sheet of packs behind it, the free pack usable, the paid ones locked
 *      with their sentences withheld, and a purchase that unlocks them.
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

const AV = 'https://cdn.example.com/avatars/zahra.jpg';
const FREE = ['سلام! 👋', 'بازی خوبی باشه 🤝', 'موفق باشی!'];
const PAID = ['😂😂😂', 'مغزم سوخت 🤯'];

const seen = [];
let owned = false;               // does the player own the paid pack yet?
let purchases = 0;
const purchaseKeys = [];
let coins = 5000;

function packs() {
  return [
    { key: 'friendly', name: 'دوستانه', emoji: '🤝', free: true, price: 0, currency: 'coins', owned: true, locked: false, phraseCount: FREE.length, phrases: FREE },
    { key: 'fun', name: 'فان', emoji: '😂', free: false, price: 1500, currency: 'coins', owned, locked: !owned, phraseCount: PAID.length, phrases: owned ? PAID : [] },
    { key: 'trash', name: 'کل‌کل', emoji: '😤', free: false, price: 20000, currency: 'cash', owned: false, locked: true, phraseCount: 20, phrases: [] }
  ];
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 5000, hearts: 5, wallet: 0 }));
});

await ctx.route('**/v1/**', (route) => {
  const u = new URL(route.request().url());
  const p = u.pathname.replace(/^.*\/v1/, '');
  seen.push(route.request().method() + ' ' + p);
  const send = (d, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
  let body = {};
  try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}

  if (p === '/chat-packs') return send({ ok: true, data: { packs: packs() } });
  if (/^\/chat-packs\/[^/]+\/purchase$/.test(p)) {
    const key = p.split('/')[2];
    purchaseKeys.push(String(body.idempotencyKey || ''));
    if (key === 'trash') return send({ ok: false, error: { code: 'INSUFFICIENT_FUNDS', message: 'موجودی کیف پولت کافی نیست.', status: 409 } }, 409);
    purchases++; owned = true; coins -= 1500;
    return send({ ok: true, data: { key, name: 'فان', price: 1500, currency: 'coins', duplicate: false, balances: { coins, wallet: 0 }, phrases: PAID } });
  }
  if (p === '/friends') return send({ ok: true, data: [{ id: 'f1', username: 'zahra', displayName: 'زهرا', avatar: AV, level: 7, online: true, unread: 0, lastMessage: 'سلام' }] });
  if (p === '/friends/requests') return send({ ok: true, data: { incoming: [], outgoing: [] } });
  if (/\/friends\/f1\/messages/.test(p)) return send({ ok: true, data: { messages: [{ mine: false, body: 'سلام خوبی؟', at: new Date().toISOString() }] } });
  if (p === '/users/me') return send({ ok: true, data: { id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins, hearts: 5, wallet: 0 } });
  if (/\/users\/.*\/profile/.test(p)) return send({ ok: true, data: { username: 'zahra', avatar: AV, level: 7, xp: 100 } });
  return send({ ok: true, data: {} });
});

const errs = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errs.push(String(e.message || e)));
await page.goto('http://127.0.0.1:' + PORT + '/');
await page.waitForTimeout(5200);

/* ── 1. a photo is a photo, everywhere it can be shown ───────────────── */
console.log('the chat window with an opponent who has a photo:');
{
  await page.evaluate(() => (0, eval)("go('friends')"));
  await page.waitForTimeout(700);
  await page.evaluate(() => (0, eval)("openFriendChat('f1')"));
  await page.waitForTimeout(700);

  const v = await page.evaluate((av) => {
    const view = document.querySelector('.chat-view');
    return {
      imgs: [...document.querySelectorAll('.chat-head img')].map((i) => i.getAttribute('src')),
      text: view ? view.innerText : '',
      typing: !!document.getElementById('chatInput')
    };
  }, AV);
  ok('the picture is drawn as an image', v.imgs.includes(AV), JSON.stringify(v.imgs));
  ok('and its address is nowhere in the text', !v.text.includes('http'), v.text.replace(/\n/g, ' ').slice(0, 90));
  ok('and there is still somewhere to type', v.typing);
}

console.log('a modal handed an avatar where an emoji was expected:');
{
  /* This is the shape of the bug wherever it happens: `icon` has always meant
     an emoji, and a caller that passes a photo used to print the address. */
  const t = await page.evaluate((av) => {
    (0, eval)("showAaaModal({icon:" + JSON.stringify(av) + ",title:'نوبت زهرا',sub:'…',primaryText:'باشه'})");
    const ic = document.getElementById('aaaIcon');
    return { text: ic.innerText, img: ic.querySelector('img') ? ic.querySelector('img').getAttribute('src') : null };
  }, AV);
  ok('draws the picture', t.img === AV, String(t.img));
  ok('instead of printing the address', !/http/.test(t.text), t.text.slice(0, 70));

  const emoji = await page.evaluate(() => {
    (0, eval)("closeAaaModal(false)");
    (0, eval)("showAaaModal({icon:'🎯',title:'x',sub:'y',primaryText:'باشه'})");
    return document.getElementById('aaaIcon').innerHTML;
  });
  ok('and a real emoji icon still works as before', emoji.includes('🎯'), emoji.slice(0, 40));
  await page.evaluate(() => (0, eval)("closeAaaModal(false)"));
}

console.log('the duel header and the seat ring:');
{
  const head = await page.evaluate((av) => {
    (0, eval)('oppAv = ' + JSON.stringify(av));
    (0, eval)("['duelOppAv','duelOppAv2'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML=pzAvCell(oppAv,null);})");
    const el = document.getElementById('duelOppAv2');
    return { img: el.querySelector('img') ? el.querySelector('img').getAttribute('src') : null, text: el.innerText };
  }, AV);
  ok('the opponent’s photo is an image in the duel header', head.img === AV, String(head.img));
  ok('not a line of text', !/http/.test(head.text), head.text.slice(0, 60));

  const cell = await page.evaluate(() => ({
    emoji: (0, eval)("pzAvCell('🦊',null)"),
    url: (0, eval)("pzAvCell('https://x.test/a.png',null)"),
    empty: (0, eval)("pzAvCell('',null)")
  }));
  ok('an emoji avatar is still just the emoji', cell.emoji === '🦊', cell.emoji);
  ok('a url avatar becomes an <img>', /<img/.test(cell.url), cell.url.slice(0, 60));
  ok('and nothing at all does not print "undefined"', !/undefined/.test(cell.empty), cell.empty.slice(0, 40));
}

/* ── 2. the quick-chat packs ─────────────────────────────────────────── */
console.log('the duel’s chat button:');
{
  const b = await page.evaluate(() => {
    const el = document.getElementById('duelChatBtn');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const av = document.querySelector('#duel .pzm-av-me');
    return {
      text: el.textContent.trim(),
      bg: cs.backgroundImage,
      belowAvatar: av ? el.compareDocumentPosition(av) === Node.DOCUMENT_POSITION_PRECEDING : null,
      sameStack: !!el.closest('.pzm-avstack') && !!av.closest('.pzm-avstack'),
      fabs: document.querySelectorAll('.qc-fab').length
    };
  });
  ok('there is a button and it says چت', b && /چت/.test(b.text), b && b.text);
  ok('it is yellow', b && /255,\s*226,\s*74|255,\s*210/.test(b.bg), b && b.bg.slice(0, 80));
  ok('it sits under the player’s own photo', b && b.sameStack && b.belowAvatar, JSON.stringify(b && { s: b.sameStack, p: b.belowAvatar }));
  ok('and the old floating circle is gone', b && b.fabs === 0, String(b && b.fabs));
}

console.log('opening it:');
{
  seen.length = 0;
  await page.evaluate(() => (0, eval)('qcOpen()'));
  await page.waitForTimeout(600);
  ok('the packs are fetched from the server', seen.some((x) => x === 'GET /chat-packs'), seen.join(' | '));

  const s = await page.evaluate(() => ({
    open: document.getElementById('qcpSheet').classList.contains('show'),
    tabs: [...document.querySelectorAll('.qcp-tab')].map((t) => t.textContent.trim()),
    phrases: [...document.querySelectorAll('.qcp-grid button')].map((b) => b.textContent)
  }));
  ok('the sheet is open', s.open);
  ok('every pack has a tab', s.tabs.length === 3, JSON.stringify(s.tabs));
  ok('the locked ones are marked with a lock', s.tabs.filter((t) => /🔒/.test(t)).length === 2, JSON.stringify(s.tabs));
  ok('the free pack’s sentences are on screen', s.phrases.length === FREE.length && s.phrases[0] === FREE[0], JSON.stringify(s.phrases));
}

console.log('a locked pack:');
{
  await page.evaluate(() => (0, eval)("qcTab('fun')"));
  await page.waitForTimeout(200);
  const s = await page.evaluate(() => ({
    body: document.getElementById('qcpBody').innerText,
    phrases: document.querySelectorAll('.qcp-grid button').length,
    buy: !!document.getElementById('qcpBuyBtn')
  }));
  ok('shows the lock, not the sentences', s.phrases === 0, String(s.phrases));
  ok('says how many sentences are in it', /۲/.test(s.body), s.body.replace(/\n/g, ' ').slice(0, 90));
  ok('shows the price in coins', /سکه/.test(s.body), s.body.replace(/\n/g, ' ').slice(0, 90));
  ok('and offers to buy it', s.buy);

  /* The whole point of withholding them server-side: they are not in the page
     at all, so there is nothing to read out of the DOM. */
  const leaked = await page.evaluate((p) => document.documentElement.innerHTML.includes(p), PAID[0]);
  ok('a locked pack’s sentences are not hidden in the page — they are absent', !leaked);
}

console.log('a pack priced in cash:');
{
  await page.evaluate(() => (0, eval)("qcTab('trash')"));
  await page.waitForTimeout(200);
  const t = await page.evaluate(() => document.getElementById('qcpBody').innerText);
  ok('is priced in تومان, not coins', /تومان/.test(t) && !/سکه/.test(t), t.replace(/\n/g, ' ').slice(0, 90));
}

console.log('buying:');
{
  purchaseKeys.length = 0;
  await page.evaluate(() => (0, eval)("qcTab('fun')"));
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('qcpBuyBtn').click());
  await page.waitForTimeout(800);

  ok('the purchase carries an idempotency key', purchaseKeys.length === 1 && purchaseKeys[0].length > 4, JSON.stringify(purchaseKeys));
  const s = await page.evaluate(() => ({
    phrases: [...document.querySelectorAll('.qcp-grid button')].map((b) => b.textContent),
    tabs: [...document.querySelectorAll('.qcp-tab')].map((t) => t.textContent.trim())
  }));
  ok('the sentences appear straight away', s.phrases.length === PAID.length && s.phrases[0] === PAID[0], JSON.stringify(s.phrases));
  ok('and the tab loses its lock', !/🔒/.test(s.tabs.find((t) => /فان/.test(t)) || ''), JSON.stringify(s.tabs));
}

console.log('a purchase the server refuses:');
{
  purchaseKeys.length = 0;
  await page.evaluate(() => (0, eval)("qcTab('trash')"));
  await page.waitForTimeout(150);
  await page.evaluate(() => document.getElementById('qcpBuyBtn').click());
  await page.waitForTimeout(700);
  const s = await page.evaluate(() => ({
    toast: document.getElementById('pzToast') ? document.getElementById('pzToast').textContent : '',
    btn: document.getElementById('qcpBuyBtn') ? document.getElementById('qcpBuyBtn').disabled : null,
    phrases: document.querySelectorAll('.qcp-grid button').length
  }));
  ok('the player is told why', /موجودی/.test(s.toast), s.toast);
  ok('the pack stays locked', s.phrases === 0, String(s.phrases));
  ok('and the button is usable again', s.btn === false, String(s.btn));
}

console.log('sending one:');
{
  await page.evaluate(() => (0, eval)("qcTab('friendly')"));
  await page.waitForTimeout(150);
  const sent = await page.evaluate(() => {
    /* sendTaunt is script-scope, so the spy has to hang off window — a closure
       declared here is invisible to the code the page actually runs. */
    window.__said = [];
    (0, eval)('sendTaunt = function(t){ window.__said.push(t); }');
    document.querySelectorAll('.qcp-grid button')[1].click();
    return { said: window.__said.slice(), open: document.getElementById('qcpSheet').classList.contains('show') };
  });
  ok('the sentence goes out', sent.said.length === 1 && sent.said[0] === FREE[1], JSON.stringify(sent.said));
  ok('and the sheet closes behind it', !sent.open);

  /* Index, not innerText: the text on the button is the player's to edit. */
  const bySource = await page.evaluate(() => (0, eval)('qcSay').toString());
  ok('what is sent is read from the pack, not from the button', /phrases\[i\]/.test(bySource) && !/textContent/.test(bySource));
}

console.log('a locked pack cannot be spoken from even if the sheet is fooled:');
{
  /* The server withholds a locked pack's sentences, so asking qcSay for one
     while the data is honest proves nothing — there is nothing there to send.
     The sentences are put back by hand first, so the client-side refusal is
     actually the thing under test. */
  const blocked = await page.evaluate(() => {
    window.__said = [];
    const p = (0, eval)('QC_PACKS').find((x) => x.key === 'trash');
    p.phrases = ['یک جملهٔ قفل‌شده'];
    (0, eval)("qcSay('trash',0)");
    const n = window.__said.length;
    p.phrases = [];
    return n;
  });
  ok('nothing is sent even when the sentence is right there', blocked === 0, String(blocked));
}

console.log('the setting still governs the button:');
{
  const off = await page.evaluate(() => {
    (0, eval)("appSettings.quickChat=false"); (0, eval)('applySettings()');
    return { d: getComputedStyle(document.getElementById('duelChatBtn')).display, sheet: document.getElementById('qcpSheet').classList.contains('show') };
  });
  ok('turning «چت سریع» off hides it', off.d === 'none', off.d);
  ok('and closes the sheet', !off.sheet);
  const on = await page.evaluate(() => {
    (0, eval)("appSettings.quickChat=true"); (0, eval)('applySettings()');
    return getComputedStyle(document.getElementById('duelChatBtn')).display;
  });
  ok('turning it back on shows it', on !== 'none', on);
}

console.log('the shop shelf:');
{
  await page.evaluate(() => { (0, eval)("go('shop')"); });
  await page.waitForTimeout(400);
  await page.evaluate(() => (0, eval)("renderShop('chat')"));
  await page.waitForTimeout(700);
  const s = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('#shopContent .item')].map((c) => c.innerText.replace(/\n/g, ' ')),
    tab: [...document.querySelectorAll('#shopTabs .tab')].some((t) => /پک‌های چت/.test(t.textContent))
  }));
  ok('there is a چت tab in the shop', s.tab);
  ok('every pack is on the shelf', s.cards.length === 3, String(s.cards.length));
  ok('the owned ones say so instead of showing a price', s.cards.filter((c) => /فعال/.test(c)).length === 2, JSON.stringify(s.cards));
  ok('and the cash one is priced in تومان', s.cards.some((c) => /تومان/.test(c)), JSON.stringify(s.cards));
}

ok('no script errors through any of it', errs.length === 0, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
