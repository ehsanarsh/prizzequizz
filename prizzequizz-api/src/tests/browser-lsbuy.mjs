/* BUYING A HELP WITHOUT LEAVING THE MATCH — AND A HELP THAT ACTUALLY WORKS.
 *
 * «در قسمت داشبورد مسابقه در آخرین بازمانده گزینهٔ خرید آیتم کمکی بذار، ولی فقط
 *  از طریق موجودی صندوق جایزه قابل خرید باشه… ولی قانون همونه: یک بار استفاده
 *  از هرکدام در هر بازی. و اینکه انتخاب دوم کار نمی‌کنه.»
 *
 * Two things, and the second is the one that costs a player money: «حق دو
 * انتخاب» was a wrapper around `answerDuel`, which is one of the ways a
 * question is answered. On the arena and on همه‌یاهیچ the help was SPENT, the
 * player was told it was armed, and then the first wrong answer locked them out
 * anyway. That is not «a feature that does nothing» — it is taking something
 * that was paid for.
 *
 * Run: node src/tests/browser-lsbuy.mjs */
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

const CATALOG = [
  { key: 'p5050',  label: '۵۰:۵۰',       price: 5000,  enabled: true, sellable: true, seconds: 0 },
  { key: 'psecond', label: 'حق دو انتخاب', price: 8000,  enabled: true, sellable: true, seconds: 0 },
  { key: 'pstats',  label: 'درصد بقیه',   price: 3000,  enabled: true, sellable: true, seconds: 0 },
  /* A help that adds seconds cannot work on a room-wide clock; it must not be
     offered inside a Last Survivor match however sellable it is elsewhere. */
  { key: 'ptime',   label: 'زمان بیشتر',  price: 2000,  enabled: true, sellable: true, seconds: 10 }
];

async function open(o = {}) {
  const inv = o.inv || {};
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, xp: 10, coins: 50, hearts: 5 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  const bought = [];
  let balance = o.wallet ?? 900000;
  await ctx.route('**/v1/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.pathname.replace(/^.*\/v1/, '');
    const send = (d, st = 200) => route.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(d) });
    if (/^\/lifelines\/[^/]+\/buy$/.test(p)) {
      const key = p.split('/')[2];
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      const price = (CATALOG.find((c) => c.key === key) || {}).price || 0;
      bought.push({ key, body: b });
      balance -= price;
      const next = { ...inv, [key]: (inv[key] || 0) + 1 };
      Object.assign(inv, next);
      return send({ ok: true, data: { key, qty: 1, price, inventory: next, balance, duplicate: false } });
    }
    if (p === '/lifelines') return send({ ok: true, data: { catalog: CATALOG, inventory: inv, used: o.used || [] } });
    if (p === '/wallet') return send({ ok: true, data: { available: balance, locked: 0, tickets: {} } });
    return send({ ok: true, data: {} });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  await page.evaluate((c) => { (0, eval)('pzLL').catalog = c; }, CATALOG);
  await page.evaluate((i) => { (0, eval)('pzLL').inv = i; (0, eval)('powerups = pzLL.inv'); }, inv);
  await page.evaluate((w) => { (0, eval)('wallet = ' + Number(w)); }, o.wallet ?? 900000);
  return { ctx, page, bought, errs, get balance() { return balance; } };
}

const SNAP = (alive = true) => ({
  room: { id: 'r1', topic: 'عمومی', status: 'running', phase: 'dashboard', round: 2, totalRounds: 10,
          capacity: 10, minUsers: 3, grossPool: 100000, netPool: 95000,
          phaseEndsAt: Date.now() + 12000, startsAt: Date.now(), serverNow: Date.now(), chatEnabled: false },
  stats: { alive: 5, eliminated: 1, cashedOut: 0, paidOut: 0, remainingPot: 95000, grossPot: 100000, totalPlayers: 6, total: 6 },
  players: [{ userId: 'me', username: 'احسان', avatar: null, color: 'green', status: 'alive', shields: 0, payoutCash: 0 }],
  votes: 0,
  me: { userId: 'me', status: alive ? 'alive' : 'out', color: 'green', units: 1, payoutCash: 0,
        answeredThisRound: false, decisionThisRound: null, currentShare: 0, shields: 0, shieldBroke: false, lifelinesUsed: [] }
});

async function dash(page, o = {}) {
  await page.evaluate(([s, used]) => {
    (0, eval)("lsRoomId='r1'; lsLastKey=''; lsSnap=null; lsMyId='me'; lsAnswered=false;");
    (0, eval)('lsPuUsed')[''] = undefined;
    Object.keys((0, eval)('lsPuUsed')).forEach((k) => delete (0, eval)('lsPuUsed')[k]);
    (used || []).forEach((t) => { (0, eval)('lsPuUsed')[t] = true; });
    (0, eval)("showScreen('lsGame')");
    const body = document.getElementById('lsBody');
    (0, eval)('lsSnap = ' + JSON.stringify(s));
    body.innerHTML = (0, eval)('lsDashHtml')(JSON.parse(JSON.stringify(s)));
  }, [o.snap || SNAP(), o.used || []]);
  await page.waitForTimeout(200);
}
const cells = (page) => page.evaluate(() => [...document.querySelectorAll('#lsBuy .ls-buy-c')].map((el) => ({
  text: el.innerText.replace(/\s+/g, ' ').trim(),
  off: el.classList.contains('off'),
  clickable: !!el.getAttribute('onclick'),
  cursor: getComputedStyle(el).cursor
})));

/* ── 1. THE SHOP IS THERE, AND SELLS WHAT THIS MODE CAN HONOUR ──────────── */
console.log('the in-match help shop:');
{
  const { ctx, page, errs } = await open();
  await dash(page);
  const c = await cells(page);
  ok('the dashboard carries a help shop', c.length > 0, c.length + ' cells');
  ok('with the three helps this mode can honour', c.length === 3, JSON.stringify(c.map((x) => x.text)));
  ok('and NOT the one that adds seconds to a room-wide clock',
     !c.some((x) => /زمان/.test(x.text)), JSON.stringify(c.map((x) => x.text)));
  /* A help the admin adds tomorrow has to appear. It used to need its key in a
     hand-written map of three icons, so anything new was silently unsellable
     here with nothing on screen to explain why. */
  await page.evaluate(() => {
    (0, eval)('pzLL').catalog = (0, eval)('pzLL').catalog.concat([
      { key: 'pskip', label: 'رد کردن سؤال', price: 4000, enabled: true, sellable: true, seconds: 0 }]);
  });
  await page.evaluate(() => (0, eval)('lsRepaintBuy')());
  await page.waitForTimeout(200);
  const c2 = await cells(page);
  const fresh = c2.find((x) => /رد کردن سؤال/.test(x.text));
  ok('a help the admin adds later is sold here too', !!fresh, JSON.stringify(c2.map((x) => x.text)));
  /* And it is sold looking like a thing to buy. Without a fallback mark the
     cell renders the word «undefined» where its picture belongs — a help that
     is on sale and looks broken is barely better than one that is missing. */
  ok('and it gets a mark of its own rather than the word «undefined»',
     !!fresh && !/undefined/.test(fresh.text) && /\S/.test(fresh.text), fresh ? fresh.text : '—');

  const head = await page.evaluate(() => (document.querySelector('#lsBuy .ls-buy-h') || {}).innerText || '');
  ok('it names the صندوق as where the money comes from', /صندوق جایزه/.test(head), head.replace(/\s+/g, ' '));
  ok('and shows what is in it', /۹۰۰٬۰۰۰/.test(head), head.replace(/\s+/g, ' '));
  ok('each cell carries its price', c.every((x) => /ت$/.test(x.text)), JSON.stringify(c.map((x) => x.text)));
  ok('the page threw nothing', errs.length === 0, errs.join(' | ').slice(0, 140));
  await ctx.close();
}

/* ── 2. IT BUYS, AND ONLY FROM THE صندوق ────────────────────────────────── */
{
  const { ctx, page, bought } = await open();
  await dash(page);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#lsBuy .ls-buy-c')].find((x) => /۵۰:۵۰/.test(x.innerText));
    if (el) el.click();
  });
  await page.waitForTimeout(700);
  ok('tapping a cell buys exactly that help', bought.length === 1 && bought[0].key === 'p5050', JSON.stringify(bought));
  ok('one at a time, with a stamp so a double tap cannot buy twice',
     bought[0].body.qty === 1 && typeof bought[0].body.idempotencyKey === 'string' && bought[0].body.idempotencyKey.length > 8,
     JSON.stringify(bought[0].body));
  /* The صندوق is not a choice offered here — it is the only door that settles
     inside a round, so there must be no gateway anywhere on this path. */
  const anyGateway = await page.evaluate(() => (document.getElementById('lsBuy') || {}).innerHTML || '');
  ok('no gateway is offered inside a running match',
     !/بلو پال|شاپرک|تتر|درگاه/.test(anyGateway), anyGateway.slice(0, 60));

  const after = await page.evaluate(() => (document.querySelector('#lsBuy .ls-buy-h') || {}).innerText || '');
  ok('and the balance shown is the one the SERVER reported after the debit',
     /۸۹۵٬۰۰۰/.test(after), after.replace(/\s+/g, ' '));
  await ctx.close();
}

/* ── 3. ONE PER MATCH MEANS ONE IS ENOUGH ───────────────────────────────── */
{
  const { ctx, page, bought } = await open({ inv: { p5050: 1 } });
  await dash(page);
  const c = await cells(page);
  const fifty = c.find((x) => /۵۰:۵۰/.test(x.text));
  ok('a help already in your hands is not sold again', fifty.off && !fifty.clickable, JSON.stringify(fifty));
  ok('and it says why, rather than just refusing', /داری/.test(fifty.text), fifty.text);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#lsBuy .ls-buy-c')].find((x) => /۵۰:۵۰/.test(x.innerText));
    if (el) el.click();
  });
  await page.waitForTimeout(500);
  ok('tapping it anyway spends nothing', bought.length === 0, JSON.stringify(bought));
  await ctx.close();
}
{
  const { ctx, page, bought } = await open();
  await dash(page, { used: ['second'] });
  const c = await cells(page);
  const sec = c.find((x) => /انتخاب دوم/.test(x.text));
  ok('a help already spent THIS match is not sold again', sec.off && !sec.clickable, JSON.stringify(sec));
  ok('and says so in those words', /در این مسابقه/.test(sec.text), sec.text);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('#lsBuy .ls-buy-c')].find((x) => /انتخاب دوم/.test(x.innerText));
    if (el) el.click();
  });
  await page.waitForTimeout(500);
  ok('and buying it is not possible either', bought.length === 0, JSON.stringify(bought));
  await ctx.close();
}

/* ── 4. NOT ENOUGH IN THE صندوق ─────────────────────────────────────────── */
{
  const { ctx, page, bought } = await open({ wallet: 1000 });
  await dash(page);
  const c = await cells(page);
  ok('nothing is offered that the صندوق cannot cover', c.every((x) => x.off && !x.clickable), JSON.stringify(c.map((x) => x.off)));
  const head = await page.evaluate(() => {
    const el = document.querySelector('#lsBuy .ls-buy-h span:last-child');
    return { text: el.innerText, color: getComputedStyle(el).color };
  });
  ok('and the balance says so in red', /255, 143, 130|rgb\(255/.test(head.color), head.color + ' — ' + head.text);
  await page.evaluate(() => { const el = document.querySelector('#lsBuy .ls-buy-c'); if (el) el.click(); });
  await page.waitForTimeout(400);
  ok('a cell that cannot be afforded buys nothing', bought.length === 0, JSON.stringify(bought));
  await ctx.close();
}

/* ── 5. NOT WHILE YOU ARE OUT ───────────────────────────────────────────── */
{
  const { ctx, page } = await open();
  await dash(page, { snap: SNAP(false) });
  const c = await cells(page);
  ok('a player who is out of the match is not sold a help', c.length === 0, c.length + ' cells');
  await ctx.close();
}

/* ── 6. «حق دو انتخاب», ON EVERY SCREEN THAT HAS IT ─────────────────────── */
/*
 * The help is armed by setting `pzSecondArmed`, exactly as usePower() does once
 * the server has agreed to spend it. What is checked is the FIRST WRONG PICK:
 * the board must stay open and the wrong option must be struck out. Before this
 * fix that happened on the duel and nowhere else.
 */
console.log('حق دو انتخاب:');
{
  const { ctx, page } = await open();
  const tryBox = async (boxId, correct, pick) => page.evaluate(([b, c, p]) => {
    const host = document.getElementById(b) || (() => {
      const d = document.createElement('div'); d.id = b; document.body.appendChild(d); return d;
    })();
    host.innerHTML = '';
    (0, eval)('pzSecondArmed = true; pzSecondUsedRound = false;');
    let picked = null;
    window.__lastPick = null;
    (0, eval)('buildAnswers')(b, { a: ['الف', 'ب', 'ج', 'د'], c }, (i) => { picked = i; window.__lastPick = i; });
    const btns = [...host.querySelectorAll('.ans')];
    btns[p].click();
    return {
      locked: (0, eval)('qLocked'),
      struck: btns[p].classList.contains('pz-removed') && btns[p].disabled,
      openLeft: btns.filter((x) => !x.disabled).length,
      submitted: picked
    };
  }, [boxId, correct, pick]);

  for (const box of ['answers', 'dAnswers', 'wtaAnswers']) {
    const r = await tryBox(box, 0, 2);            /* 0 is right, 2 is wrong */
    ok('on #' + box + ' a wrong first pick does not lock the board', !r.locked, JSON.stringify(r));
    ok('on #' + box + ' the wrong option is struck out', r.struck, JSON.stringify(r));
    ok('on #' + box + ' the other options are still open', r.openLeft >= 2, String(r.openLeft));
    ok('on #' + box + ' nothing was submitted yet', r.submitted === null, String(r.submitted));
  }

  /* The other half: it must not fire when the first pick is RIGHT, and it must
     not fire twice in one round. */
  const right = await tryBox('dAnswers', 1, 1);
  ok('a correct first pick locks the board like any other', right.locked && !right.struck, JSON.stringify(right));
  /* buildAnswers submits after a pause so the player can see what they chose;
     the point is that it DOES submit, rather than being swallowed by a help
     that should not have fired. */
  await page.waitForTimeout(1200);
  ok('and it really is submitted, not swallowed by the help',
     await page.evaluate(() => window.__lastPick), String(await page.evaluate(() => window.__lastPick)));
  ok('and the help is still armed for the next wrong answer',
     await page.evaluate(() => (0, eval)('pzSecondArmed')) === true);

  /* ONCE PER ROUND, THROUGH THE CODE THAT DECIDES IT.
     Setting `pzSecondUsedRound` by hand and then checking it is checking the
     test's own assignment. Here the FIRST wrong pick is what must set it, and
     the round is then asked two questions: does a second wrong pick lock, and
     can the player arm the help all over again without the round ending. The
     second one is the expensive half — arming again spends another help. */
  const round = await page.evaluate(() => {
    const host = document.getElementById('dAnswers'); host.innerHTML = '';
    (0, eval)('pzSecondArmed = true; pzSecondUsedRound = false;');
    (0, eval)('buildAnswers')('dAnswers', { a: ['الف', 'ب', 'ج', 'د'], c: 0 }, () => {});
    const btns = [...host.querySelectorAll('.ans')];
    btns[2].click();                                   /* wrong — the help fires */
    const afterFirst = { locked: (0, eval)('qLocked'), used: (0, eval)('pzSecondUsedRound') };
    btns[3].click();                                   /* wrong again */
    return { afterFirst, locked: (0, eval)('qLocked'), used: (0, eval)('pzSecondUsedRound') };
  });
  ok('the first wrong pick is what marks the round as having used it',
     round.afterFirst.used === true && round.afterFirst.locked === false, JSON.stringify(round.afterFirst));
  ok('a second wrong answer in the same round does lock', round.locked, JSON.stringify(round));
  /* And the mark has to survive, because it is what stops the help being armed
     a second time in the same round — which would spend another one. */
  ok('and the round stays marked, so it cannot be armed again', round.used === true, String(round.used));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`[lsbuy] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
