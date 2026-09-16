/* A CHAT THAT KEEPS UP, AND SAYS WHEN IT WAS READ.
 *
 * «باید سریع باشه پیاما، عین تلگرام و واتساپ. و در چت — چه با کاربر دیگه و چه
 *  با پشتیبانی — وقتی سین می‌کنه معلوم بشه و علامت چشم بیاد بغل پیام.»
 *
 * The screen used to ask for the ENTIRE conversation every three seconds. On a
 * long chat that is two hundred messages down the wire to learn that nothing
 * happened, and it is why the chat felt slow. What is checked here is that a
 * poll now carries only what has arrived since — and, just as important, that
 * asking that way does not make the last message arrive twice.
 *
 * Run: node src/tests/browser-chatseen.mjs */
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

/* The server's side of the conversation, as a real one behaves: microsecond
   timestamps, and `after` meaning strictly after. */
const FRIEND = 'ffffffff-0000-4000-8000-00000000000f';
let seq = 0;
const stamp = () => { seq++; return '2026-09-16T10:' + String(10 + Math.floor(seq / 60)).padStart(2, '0') + ':' + String(seq % 60).padStart(2, '0') + '.123456Z'; };
const store = [];
const say = (mine, body, replyTo) => { store.push({ id: 'm' + store.length, mine, body, at: stamp(), readAt: null, replyTo: replyTo || null }); };
for (let i = 0; i < 6; i++) say(i % 2 === 0, 'پیام ' + i);
let readThrough = null;
const asked = [];
const sent = [];

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 0, hearts: 4 }));
  for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
  try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
});
await ctx.route('**/v1/**', (route) => {
  const u = new URL(route.request().url());
  const p = u.pathname.replace(/^.*\/v1/, '');
  /* pzApi hands back the whole envelope, so the stub has to speak it. */
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (/\/friends\/[^/]+\/messages$/.test(p) && route.request().method() === 'GET') {
    const after = u.searchParams.get('after');
    asked.push(after || '(all)');
    const rows = after ? store.filter((m) => m.at > after) : store.slice(-200);
    return send({ messages: rows, readThrough });
  }
  if (/\/friends\/[^/]+\/messages$/.test(p)) {
    let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    sent.push(b);
    /* The server answers with the quote attached, resolved from the id. */
    const q = b.replyTo ? store.find((m) => m.id === b.replyTo) : null;
    say(true, String(b.body || ''), q ? { id: q.id, mine: q.mine, body: q.body } : null);
    return send({ id: store[store.length - 1].id, mine: true, body: b.body, at: store[store.length - 1].at });
  }
  if (p === '/friends') {
    return send({ friends: [{ id: FRIEND, username: 'sara', displayName: 'سارا', online: true, unread: 0 }] });
  }
  return send({});
});
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5400);

/* Put a friend on the screen and open the chat with them. */
await page.evaluate((fid) => {
  (0, eval)('FRIENDS_DATA').length = 0;
  (0, eval)('FRIENDS_DATA').push({ id: fid, n: 'سارا', u: 'sara', a: null, ch: null, on: true, s: 'آنلاین', m: [], unread: 0 });
}, FRIEND);
await page.evaluate((fid) => (0, eval)('openFriendChat')(fid), FRIEND);
await page.waitForTimeout(900);

const bubbles = () => page.evaluate(() => [...document.querySelectorAll('#chatBody .msg')].map((el) => ({
  mine: el.classList.contains('me'),
  text: el.innerText.replace(/\s+/g, ' ').trim(),
  seen: !!el.querySelector('.msg-seen')
})));

console.log('the chat:');
{
  const b = await bubbles();
  ok('the conversation is on screen', b.length === 6, b.length + ' bubbles');
  ok('and the first fetch asked for all of it', asked[0] === '(all)', JSON.stringify(asked.slice(0, 2)));
}

/* ── THE POLL CARRIES ONLY WHAT IS NEW ──────────────────────────────────── */
{
  const before = asked.length;
  await page.waitForTimeout(2600);
  const polls = asked.slice(before);
  ok('it keeps asking while the chat is open', polls.length >= 2, polls.length + ' polls in 2.6s');
  ok('and every poll asks only for what came after the last message',
     polls.every((a) => a !== '(all)'), JSON.stringify(polls.slice(0, 3)));

  /* THE TRAP: a cursor that is a hair EARLIER than the message it came from
     makes every poll return that message again, and the chat fills with copies
     of whatever was said last. */
  const b = await bubbles();
  ok('and the last message does not arrive again and again', b.length === 6,
     b.length + ' bubbles: ' + b.slice(-3).map((x) => x.text).join(' | '));
}

/* ── A MESSAGE THAT ARRIVES WHILE WE WATCH ──────────────────────────────── */
{
  say(false, 'سلام تازه');
  await page.waitForTimeout(1600);
  const b = await bubbles();
  ok('a message sent by the other side shows up on its own', b.length === 7 && /سلام تازه/.test(b[6].text),
     b.length + ' — ' + b[6].text);
  ok('and it is drawn as theirs, not mine', b[6].mine === false);
}

/* ── «سین شد» ───────────────────────────────────────────────────────────── */
{
  const b0 = await bubbles();
  ok('nothing is marked seen before they have read it', b0.every((x) => !x.seen),
     JSON.stringify(b0.map((x) => x.seen)));

  /* They open the chat: the server now reports how far they have read. */
  readThrough = store.filter((m) => m.mine).slice(-1)[0].at;
  await page.waitForTimeout(1600);
  const b1 = await bubbles();
  const mine = b1.filter((x) => x.mine);
  ok('once they read it, an eye appears on MY messages', mine.length > 0 && mine.every((x) => x.seen),
     JSON.stringify(b1.map((x) => (x.mine ? (x.seen ? 'me✔' : 'me✗') : 'them'))));
  ok('and never on theirs — they know they read their own',
     b1.filter((x) => !x.mine).every((x) => !x.seen),
     JSON.stringify(b1.filter((x) => !x.mine).map((x) => x.seen)));
  ok('the mark is the eye that was asked for',
     await page.evaluate(() => {
       const el = document.querySelector('#chatBody .msg.me .msg-seen');
       return !!el && /👁/.test(el.textContent);
     }));
}

/* ── THE BOUNDARY: SEEN UP TO HERE, AND NOT PAST IT ─────────────────────── */
/*
 * The rule is «mine, and sent no later than the point they have read to». The
 * half that is easy to get wrong is the second one — a rule that says «mine»
 * and stops there puts an eye on a message they cannot possibly have seen. So
 * two more of mine arrive from the SERVER (with real timestamps) after the mark
 * was set, and they must stay unmarked while the older ones keep their eye.
 */
{
  const markedAt = readThrough;
  say(true, 'بعد از سین ۱');
  say(true, 'بعد از سین ۲');
  await page.waitForTimeout(1600);
  const b = await bubbles();
  const mine = b.filter((x) => x.mine);
  const after = mine.slice(-2);
  const before = mine.slice(0, -2);
  ok('messages sent after they stopped reading have no eye',
     after.every((x) => !x.seen), JSON.stringify(after.map((x) => x.text + '=' + x.seen)));
  ok('and the ones they did read keep theirs',
     before.length > 0 && before.every((x) => x.seen), JSON.stringify(before.map((x) => x.seen)));

  /* And when they come back and read those too, the eyes follow. */
  readThrough = store.filter((m) => m.mine).slice(-1)[0].at;
  await page.waitForTimeout(1600);
  const b2 = await bubbles();
  ok('and when they read on, the newer ones get their eye too',
     b2.filter((x) => x.mine).every((x) => x.seen),
     JSON.stringify(b2.filter((x) => x.mine).map((x) => x.seen)));
  ok('the mark really did move', String(markedAt) !== String(readThrough));
}

/* ── A MESSAGE SENT NOW IS NOT SEEN YET ─────────────────────────────────── */
{
  await page.evaluate(() => {
    const i = document.getElementById('chatInput');
    i.value = 'این تازه است';
    (0, eval)('sendChatMsg')();
  });
  await page.waitForTimeout(1400);
  const b = await bubbles();
  const last = b[b.length - 1];
  ok('a message just sent is on screen', /این تازه است/.test(last.text), last.text);
  ok('and is NOT marked seen, because it has not been', last.seen === false, String(last.seen));
  ok('while the older ones keep their eye',
     b.filter((x) => x.mine).slice(0, -1).every((x) => x.seen),
     JSON.stringify(b.filter((x) => x.mine).map((x) => x.seen)));
}

/* ── LEAVING STOPS THE TICKING ──────────────────────────────────────────── */
{
  await page.evaluate(() => { (0, eval)('frActiveChat = null'); });
  await page.waitForTimeout(400);
  const before = asked.length;
  await page.waitForTimeout(2200);
  ok('closing the chat stops the polling', asked.length === before, before + ' → ' + asked.length);
}

/* ── REPLYING ───────────────────────────────────────────────────────────── */
/*
 * «ریپلای هم بذار برای پیام‌ها.»
 *
 * A tap on a bubble answers it. What is checked is that the reply names the
 * message it answers when it is SENT, and that the quote it comes back with is
 * drawn inside the reply — a reply whose quote has to be looked up when it is
 * drawn goes blank the moment the original scrolls off the page.
 */
console.log('replying:');
{
  await page.evaluate((fid) => (0, eval)('openFriendChat')(fid), FRIEND);
  await page.waitForTimeout(1200);

  /* Answer the other person's first message. */
  const target = store.find((m) => !m.mine);
  await page.evaluate((id) => (0, eval)('frReplyTo')(id), target.id);
  await page.waitForTimeout(250);

  const bar = await page.evaluate(() => {
    const el = document.querySelector('.chat-view .chat-reply');
    return el ? { text: el.innerText.replace(/\s+/g, ' ').trim(), x: !!el.querySelector('.x') } : null;
  });
  ok('tapping a message shows what is being answered', !!bar && /پاسخ به/.test(bar.text), bar ? bar.text : '(no bar)');
  ok('with its words in the bar', !!bar && bar.text.includes(target.body), bar ? bar.text : '—');
  ok('and a way out of it', !!bar && bar.x);

  const before = sent.length;
  await page.evaluate(() => {
    document.getElementById('chatInput').value = 'جواب من';
    (0, eval)('sendChatMsg')();
  });
  await page.waitForTimeout(1400);
  const msg = sent[before];
  ok('sending names the message it answers', msg && msg.replyTo === target.id, JSON.stringify(msg));
  ok('and the bar clears once it is gone',
     await page.evaluate(() => !document.querySelector('.chat-view .chat-reply')));

  const quoted = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#chatBody .msg')];
    const last = els[els.length - 1];
    const q = last.querySelector('.msg-q');
    return { text: last.innerText.replace(/\s+/g, ' ').trim(), quote: q ? q.textContent.trim() : '' };
  });
  ok('and the reply is drawn WITH the quote on it', quoted.quote === target.body, quoted.quote || '(no quote)');
  ok('above the answer itself', /جواب من/.test(quoted.text), quoted.text.slice(0, 50));
}
{
  /* Changing your mind must leave an ordinary message, not a reply to whatever
     was last tapped. */
  const target = store.find((m) => !m.mine);
  await page.evaluate((id) => (0, eval)('frReplyTo')(id), target.id);
  await page.waitForTimeout(200);
  await page.evaluate(() => (0, eval)('frReplyCancel')());
  await page.waitForTimeout(200);
  ok('cancelling takes the bar away',
     await page.evaluate(() => !document.querySelector('.chat-view .chat-reply')));
  const before = sent.length;
  await page.evaluate(() => {
    document.getElementById('chatInput').value = 'بدون ریپلای';
    (0, eval)('sendChatMsg')();
  });
  await page.waitForTimeout(1400);
  ok('and the next message answers nothing', sent[before] && !sent[before].replyTo, JSON.stringify(sent[before]));
  const plain = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#chatBody .msg')];
    return !els[els.length - 1].querySelector('.msg-q');
  });
  ok('so it is drawn without a quote', plain);
}

ok('the page threw nothing', errs.length === 0, errs.join(' | ').slice(0, 160));

await browser.close(); server.close();
console.log(`[chatseen] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
