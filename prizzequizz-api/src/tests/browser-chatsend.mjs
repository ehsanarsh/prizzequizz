/* ONE TAP TO SEND.
 *
 * «باید دوبار تاچ کنی: تاچ اول کیبورد رو پایین می‌بره، تاچ دوم ارسال می‌کنه.»
 *
 * A headless browser has no on-screen keyboard, so the visible half of that bug
 * cannot be reproduced here. What CAN be checked is its cause: whether the tap
 * takes the focus off the input. If focus survives, the keyboard never closes,
 * the layout never jumps, and the button stays under the finger — which is the
 * whole of the fix.
 *
 * So the test taps the send button exactly once and asserts two things: the
 * message went, and the caret is still in the box.
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
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 3, xp: 120, coins: 300, hearts: 5 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
const sent = [];
await ctx.route('**/v1/**', (route) => {
  const u = new URL(route.request().url());
  if (/\/messages$/.test(u.pathname) && route.request().method() === 'POST') {
    try { sent.push(JSON.parse(route.request().postData() || '{}')); } catch { sent.push({}); }
  }
  const p = u.pathname.replace(/^.*\/v1/, '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (p.startsWith('/friends')) return send({ friends: [{ id: 'f1', userId: 'f1', username: 'sara', displayName: 'سارا', online: true }], requests: [], suggestions: [] });
  return send({});
});

const page = await ctx.newPage();
page.on('pageerror', () => {});
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/* Open a friend chat — the composer with the send button the report is about. */
await page.evaluate(() => { try { (0, eval)("go('friends')"); } catch (e) {} });
await page.waitForTimeout(400);
await page.evaluate(() => {
  try {
    (0, eval)('FRIENDS_DATA').length = 0;
    (0, eval)('FRIENDS_DATA').push({ id: 'f1', n: 'سارا', u: 'sara', m: [], last: '', on: true });
    (0, eval)('frActiveChat') ; (0, eval)('frActiveChat="f1"');
    (0, eval)('renderFriendsHub()');
  } catch (e) {}
});
await page.waitForTimeout(500);

const hasBox = await page.evaluate(() => !!document.getElementById('chatInput'));
ok('the chat composer is on screen', hasBox);

if (hasBox) {
  await page.focus('#chatInput');
  await page.fill('#chatInput', 'سلام');
  const focusedBefore = await page.evaluate(() => document.activeElement && document.activeElement.id);
  ok('the caret starts in the box', focusedBefore === 'chatInput', focusedBefore || 'none');

  /* ONE tap. A real finger: down, then up. */
  const btn = await page.$('.chat-send .btn');
  ok('the send button is there', !!btn);
  if (btn) {
    const box = await btn.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const focusedDuring = await page.evaluate(() => document.activeElement && document.activeElement.id);
    /* THE BUG, EXACTLY: if the press blurs the input, the phone closes the
       keyboard, the page reflows and the button walks out from under the tap. */
    ok('pressing the button does not take the keyboard away', focusedDuring === 'chatInput', focusedDuring || 'none');
    await page.mouse.up();
    await page.waitForTimeout(700);

    ok('one tap sent the message', sent.length === 1, sent.length + ' request(s)');
    ok('and it sent what was typed', sent[0] && sent[0].body === 'سلام', JSON.stringify(sent[0] || {}));
    const cleared = await page.evaluate(() => document.getElementById('chatInput').value);
    ok('the box was emptied for the next line', cleared === '', JSON.stringify(cleared));
    const focusedAfter = await page.evaluate(() => document.activeElement && document.activeElement.id);
    ok('and the caret is still in it', focusedAfter === 'chatInput', focusedAfter || 'none');
  }
}

/* The guard must not steal focus from ordinary buttons elsewhere. */
const stolen = await page.evaluate(() => {
  const b = document.createElement('button');
  b.textContent = 'x'; document.body.appendChild(b);
  b.focus();
  const before = document.activeElement === b;
  b.remove();
  return before;
});
ok('a plain button outside a composer still focuses normally', stolen);

console.log(`\n[chatsend] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
