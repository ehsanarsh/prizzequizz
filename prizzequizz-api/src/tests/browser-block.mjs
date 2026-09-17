/* BLOCKING SOMEBODY, FROM THE PLAYER'S SIDE.
 *
 * «یه بلاک هم بزاریم تا کاربرا بتونن بلاک کنن تا بلاک‌شده نتونه بهشون پیام و
 *  دعوت به بازی بفرسته.»
 *
 * The refusing itself is the server's job and is held by blockUser.test.ts.
 * What is held here is that a person can actually DO it and undo it: the
 * button exists where they are, the list is findable again, and a chat with a
 * blocked person stops pretending it can send.
 *
 * Everything goes through real clicks. A test that called pzDoBlock() would
 * prove the function works and say nothing about whether anybody can reach it.
 *
 * Run: node src/tests/browser-block.mjs */
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

const FRIEND = { id: 'f-1', username: 'sara_k', displayName: 'سارا کریمی' };

async function open(o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5, balances: { wallet: 0, coins: 0, hearts: 5 } }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  /* The server's own state, so blocking really changes what comes back. */
  const blocked = new Map(o.blocked ? [[FRIEND.id, { ...FRIEND, createdAt: '' }]] : []);
  const calls = [];
  await ctx.route('**/v1/**', (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname.replace(/^.*\/v1/, '');
    const m = req.method();
    calls.push(m + ' ' + p);
    const send = (d, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(d) });

    if (p === '/blocks' && m === 'GET') return send({ ok: true, data: { rows: [...blocked.values()] } });
    const bm = /^\/blocks\/(.+)$/.exec(p);
    if (bm && m === 'POST') { blocked.set(bm[1], { ...FRIEND, createdAt: '' }); return send({ ok: true, data: { blocked: true } }); }
    if (bm && m === 'DELETE') { blocked.delete(bm[1]); return send({ ok: true, data: { blocked: false } }); }

    /* A BARE ARRAY — friendsLoad checks `Array.isArray(fr.data)`, so a
       `{friends:[…]}` wrapper is silently ignored and the list stays empty. */
    if (p === '/friends' && m === 'GET') {
      return send({ ok: true, data: [{ id: FRIEND.id, username: FRIEND.username, displayName: FRIEND.displayName, level: 3, online: false, unread: 0 }] });
    }
    if (p === '/friends/requests' && m === 'GET') return send({ ok: true, data: { incoming: [], outgoing: [] } });
    if (/^\/friends\/[^/]+\/messages$/.test(p) && m === 'GET') return send({ ok: true, data: { rows: [], readThrough: null } });
    if (/^\/friends\/[^/]+\/messages$/.test(p) && m === 'POST') {
      /* The server refuses it, exactly as the real one does. */
      const other = p.split('/')[2];
      if (blocked.has(other)) return send({ ok: false, error: { code: 'BLOCKED', message: 'ارتباط با این بازیکن ممکن نیست.' } }, 403);
      return send({ ok: true, data: { id: 'm1', mine: true, body: 'x', at: new Date().toISOString() } }, 201);
    }
    send({ ok: true, data: {} });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5600);
  return { ctx, page, blocked, calls, errs };
}

const screen = (page) => page.evaluate(() => ((document.querySelector('.screen.active') || {}).id) || '(none)');
const modalText = (page) => page.evaluate(() => {
  const m = document.getElementById('aaaModal');
  return m && m.classList.contains('show') ? (m.innerText || '').replace(/\s+/g, ' ').trim() : '';
});
const btnLabels = (page) => page.evaluate(() => ['aaaPrimary', 'aaaSecondary', 'aaaTertiary']
  .map((i) => { const b = document.getElementById(i); return b && b.style.display !== 'none' ? b.textContent.trim() : ''; }));
/* openFriendChat, not renderChatView. The second only DRAWS — it does not set
   `frActiveChat`, and every action in the chat reads that. Opening the wrong
   way made the composer look present and do nothing when pressed, and the test
   reported it as «the message was not queued» rather than «nothing was sent». */
const openChat = async (page) => {
  await page.evaluate(() => { (0, eval)("go('friends')"); });
  await page.waitForTimeout(900);
  await page.evaluate(async (fid) => { await (0, eval)('openFriendChat')(fid); }, FRIEND.id);
  await page.waitForTimeout(700);
};

/* ── 1. THE BUTTON IS WHERE THE PERSON IS ───────────────────────────────── */
console.log('blocking from a chat:');
{
  const { ctx, page, blocked, errs } = await open();
  await openChat(page);
  ok('the chat has a composer to begin with', await page.evaluate(() => !!document.getElementById('chatInput')));

  /* The ⋯ menu in the chat head, tapped. */
  await page.click('.chat-head .iconbtn:last-of-type');
  await page.waitForTimeout(400);
  const labels = await btnLabels(page);
  ok('the menu offers blocking', labels.some((l) => /بلاک/.test(l)), JSON.stringify(labels));
  /* And it is NOT hidden behind «حذف دوست» — removing a friend and blocking
     them are different decisions. */
  ok('as its own choice, beside removing the friend', labels.some((l) => /حذف دوست/.test(l)) && labels.some((l) => /بلاک/.test(l)), JSON.stringify(labels));

  await page.click('#aaaTertiary');
  await page.waitForTimeout(400);
  /* ASKED FIRST — it cannot be undone by the person on the other end. */
  const ask = await modalText(page);
  ok('it asks before doing it', /بلاک کردن/.test(ask), ask.slice(0, 50));
  ok('and says what it actually does', /پیام/.test(ask) && /دعوت/.test(ask), ask.slice(0, 120));
  ok('and where to undo it', /تنظیمات/.test(ask), ask.slice(0, 160));
  ok('nothing is blocked while it is only asking', blocked.size === 0, String(blocked.size));

  await page.click('#aaaPrimary');
  await page.waitForTimeout(900);
  ok('confirming really blocks them, on the server', blocked.has(FRIEND.id), [...blocked.keys()].join(','));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. A CHAT WITH A BLOCKED PERSON STOPS PRETENDING ───────────────────── */
console.log('\nthe chat afterwards:');
{
  const { ctx, page, calls, errs } = await open({ blocked: true });
  await openChat(page);
  ok('there is no composer any more', await page.evaluate(() => !document.getElementById('chatInput')));
  /* Leaving the box there means typing a message, pressing send, and being
     refused — every time. */
  const bar = await page.evaluate(() => (document.querySelector('.chat-blocked') || {}).innerText || '');
  ok('it says why', /بلاک/.test(bar), bar.replace(/\s+/g, ' ').slice(0, 60));
  ok('and offers the way out', /برداشتن/.test(bar), bar.replace(/\s+/g, ' ').slice(0, 80));

  await page.click('.chat-blocked .btn');
  await page.waitForTimeout(900);
  ok('unblocking reaches the server', calls.some((c) => c.startsWith('DELETE /blocks/')), calls.filter((c) => c.includes('/blocks')).join(' | '));
  ok('and the composer comes back', await page.evaluate(() => !!document.getElementById('chatInput')));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. A REFUSED MESSAGE IS NOT A FAILED ONE ───────────────────────────── */
console.log('\nwhen the server refuses a message:');
{
  /* Blocked on the server but not yet known to this tab — which is what
     happens when the OTHER person did the blocking. */
  const { ctx, page, calls, errs } = await open({ blocked: true });
  await openChat(page);
  /* Forget the block locally, then redraw: this tab does not know yet, which is
     exactly the state when the OTHER person did the blocking. */
  await page.evaluate((fid) => { (0, eval)('PZ_BLOCKED=[]'); (0, eval)('renderChatView')(fid); }, FRIEND.id);
  await page.waitForTimeout(400);

  await page.fill('#chatInput', 'سلام');
  await page.click('.chat-send .btn-primary');
  await page.waitForTimeout(1200);

  const toast = await page.evaluate(() => (document.getElementById('pzToast') || {}).textContent || '');
  ok('the player is told', /ارتباط/.test(toast), toast);
  /* NOT queued for retry: the button would be there for ever and would never
     once work. */
  const failed = await page.evaluate((fid) => {
    const f = (0, eval)('FRIENDS_DATA').find((x) => x.id === fid);
    return (f && f.failed ? f.failed.length : 0);
  }, FRIEND.id);
  ok('and it is not left in the retry queue', failed === 0, String(failed));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE LIST IS FINDABLE AGAIN ──────────────────────────────────────── */
console.log('\nfinding it again in settings:');
{
  const { ctx, page, blocked, errs } = await open({ blocked: true });
  await page.evaluate(() => { (0, eval)("go('settings')"); });
  await page.waitForTimeout(500);
  /* A block nobody can find again is a block nobody can undo. */
  const row = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#settings .row')].find((x) => /بلاک/.test(x.innerText));
    return r ? { text: r.innerText.replace(/\s+/g, ' ').trim(), h: Math.round(r.getBoundingClientRect().height) } : null;
  });
  ok('there is a row for it in تنظیمات', !!row && row.h > 10, JSON.stringify(row));

  await page.evaluate(() => {
    const r = [...document.querySelectorAll('#settings .row')].find((x) => /بلاک/.test(x.innerText));
    if (r) r.click();
  });
  await page.waitForTimeout(900);
  const list = await modalText(page);
  ok('it lists who is blocked, by name', /سارا کریمی/.test(list), list.slice(0, 80));

  await page.click('#pzBlockedList .btn');
  await page.waitForTimeout(900);
  ok('unblocking from the list works', !blocked.has(FRIEND.id), [...blocked.keys()].join(','));
  ok('and the list says so straight away', /بلاک نکرده‌ای/.test(await modalText(page)), (await modalText(page)).slice(0, 60));
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. NOT ON YOUR OWN PROFILE ─────────────────────────────────────────── */
console.log('\nyour own profile:');
{
  const { ctx, page } = await open();
  await page.evaluate(() => { (0, eval)('showPlayerProfile')('me', { n: 'احسان' }); });
  await page.waitForTimeout(500);
  const labels = await btnLabels(page);
  ok('offers no way to block yourself', !labels.some((l) => /بلاک/.test(l)), JSON.stringify(labels));
  await ctx.close();
}
{
  const { ctx, page } = await open();
  await page.evaluate(() => { (0, eval)('showPlayerProfile')('someone-else', { n: 'رقیب' }); });
  await page.waitForTimeout(500);
  const labels = await btnLabels(page);
  /* Somebody met in a match is exactly who an unwanted invitation comes from,
     and they are not in the friends list. */
  ok('but does offer it for anybody else', labels.some((l) => /بلاک/.test(l)), JSON.stringify(labels));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n[block] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
