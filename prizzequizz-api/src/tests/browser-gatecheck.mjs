/* NOBODY READS THE QUESTION BEFORE THE ROUND OPENS.
 *
 *   • «سوال اول برای بعضی کاربران بدون مودال آماده‌ای میاد، یعنی زودتر و یهویی»
 *     The card is built during the ready phase on purpose — that is what stops
 *     it being torn down and rebuilt when the round opens — and the «آماده‌ای؟»
 *     modal is what covers it meanwhile. Whenever that modal failed to appear,
 *     the question was simply sitting there in the open, early.
 *   • «در موقع تماشا مودال تایمر نمیاد و تماشاگر زودتر از بقیه سوال را می‌بیند»
 *     The gate returned immediately for a watcher, so a second device open on
 *     the same room read the question before the people answering it.
 *
 * Both are the same hole seen from two sides, so both are tested the same way:
 * during the ready phase the words must not be readable, by anyone.
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const SECRET = 'پایتخت ایران کجاست؟';
const Q = { id: 'q1', text: SECRET, options: ['تهران', 'شیراز', 'اصفهان', 'تبریز'], difficulty: 'easy' };

const player = (i, over = {}) => Object.assign({
  userId: 'u' + i, username: 'p' + i, displayName: 'بازیکن ' + i, avatar: '', color: 'green',
  status: 'alive', shields: 0, units: 1, answeredThisRound: false
}, over);

function snap(over = {}) {
  const now = Date.now();
  const base = {
    room: { id: 'R1', topic: 'ورزشی', status: 'running', phase: 'ready', round: 1, totalRounds: 12,
            capacity: 20, startsAt: now, phaseEndsAt: now + 5000, serverNow: now, grossPool: 250_000,
            manualStartEnabled: false, chatEnabled: false, forfeited: 0 },
    players: Array.from({ length: 6 }, (_, i) => player(i)),
    me: player(0, { currentShare: 0, lifelinesUsed: [] }),
    stats: { alive: 6, eliminated: 0, cashedOut: 0, totalPlayers: 6, grossPot: 250_000, remainingPot: 200_000, paidOut: 0 },
    question: Q, votes: 0
  };
  const out = JSON.parse(JSON.stringify(base));
  for (const k of Object.keys(over)) out[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]))
    ? Object.assign(out[k] || {}, over[k]) : over[k];
  return out;
}

async function makePage({ watching = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u0', username: 'p0', displayName: 'بازیکن ۰', level: 3, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} })
  }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  await page.evaluate((w) => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsRoomId='R1'; lsSnap=null; lsLastKey=''; lsReadyShownRound=''; lsWatching=" + (w ? 'true' : 'false') + "; go('lsGame');"), watching);
  return { ctx, page, errs };
}
const feed = (page, s) => page.evaluate((x) => (0, eval)('lsRender')(x), s);

/* What a pair of eyes can actually READ off the screen — not what is in the
   DOM, which is a different question and a different fix. An element hidden by
   visibility, or covered by the modal, is not readable. */
const readable = (page, needle) => page.evaluate((txt) => {
  const seen = (el) => {
    if (!el) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
      n = n.parentElement;
    }
    return true;
  };
  const q = document.querySelector('#lsBody .ls-qtext');
  const opts = [...document.querySelectorAll('#lsBody #lsOpts .atxt')];
  return {
    question: !!q && seen(q) && (q.textContent || '').indexOf(txt) >= 0,
    options: opts.filter((o) => seen(o) && (o.textContent || '').trim()).length,
    gate: (document.querySelector('#lsBody .ls-qwrap') || { dataset: {} }).dataset.gate,
    /* showCountdownModal is showAaaModal with a timer — same overlay. */
    modal: (() => { const m = document.getElementById('aaaModal');
                    return !!(m && m.classList.contains('show')); })(),
    modalText: ((document.getElementById('aaaTitle') || {}).textContent || '') + ' ' +
               ((document.getElementById('aaaSub') || {}).textContent || '')
  };
}, needle);

/* ── 1. A PLAYER, THE ORDINARY WAY ──────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a player waiting for the round to open:');
  await feed(page, snap());
  await page.waitForTimeout(500);
  const gated = await readable(page, SECRET);
  ok('the question is not readable during the countdown', gated.question === false, JSON.stringify(gated));
  ok('and neither are the options', gated.options === 0, String(gated.options));
  ok('the card is marked as gated', gated.gate === '1', String(gated.gate));

  await feed(page, snap({ room: { phase: 'question', phaseEndsAt: Date.now() + 15000 } }));
  await page.waitForTimeout(500);
  const open = await readable(page, SECRET);
  ok('and it is readable the moment the round opens', open.question === true, JSON.stringify(open));
  ok('with every option', open.options === 4, String(open.options));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE WATCHER — THE CHEAT ─────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage({ watching: true });
  console.log('a second device watching the same room:');
  await feed(page, snap({ me: { status: 'eliminated', eliminatedRound: 1 } }));
  await page.waitForTimeout(500);
  const peek = await readable(page, SECRET);
  ok('the watcher cannot read it early either', peek.question === false, JSON.stringify(peek));
  ok('nor its options', peek.options === 0, String(peek.options));
  ok('they get a countdown of their own', peek.modal === true, JSON.stringify(peek.modal));
  /* Not «آماده‌ای؟» — they are not about to answer anything, and being asked
     that while knocked out was its own complaint. */
  ok('worded for someone who is watching, not answering', /سوال بعدی/.test(peek.modalText) && !/آماده‌ای/.test(peek.modalText), peek.modalText.trim());

  await feed(page, snap({ room: { phase: 'question', phaseEndsAt: Date.now() + 15000 }, me: { status: 'eliminated', eliminatedRound: 1 } }));
  await page.waitForTimeout(500);
  const withEveryone = await readable(page, SECRET);
  ok('and sees it when everyone else does', withEveryone.question === true, JSON.stringify(withEveryone));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. THE QUESTION THAT ARRIVES AFTER THE GATE ────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a ready phase that starts before the question lands:');
  /* The real sequence behind «بعضی کاربران»: the ready snapshot arrives with no
     question yet, so the card is empty and the gate goes up. Then the question
     lands and the card is rebuilt — and the gate, remembered by round alone,
     refused to come back for it. */
  await feed(page, snap({ question: null }));
  await page.waitForTimeout(400);
  const firstGate = await readable(page, SECRET);
  ok('the empty card still gets a gate', firstGate.modal === true, String(firstGate.modal));

  /* Shut it, so what is measured next is a gate that came back for the
     question — not the one that was already on screen for the empty card. */
  await page.evaluate(() => { try { (0, eval)('closeAaaModal')(true); } catch (e) {} });
  await page.waitForTimeout(250);
  const between = await readable(page, SECRET);
  ok('and closing it leaves nothing on screen', between.modal === false, String(between.modal));

  await feed(page, snap());
  await page.waitForTimeout(500);
  const late = await readable(page, SECRET);
  ok('the late question is still not readable', late.question === false, JSON.stringify(late));
  ok('the gate came back for it', late.modal === true, String(late.modal));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. EVERY ROUND, NOT JUST THE FIRST ─────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the rounds after the first:');
  await feed(page, snap());
  await page.waitForTimeout(300);
  await feed(page, snap({ room: { phase: 'question', phaseEndsAt: Date.now() + 15000 } }));
  await page.waitForTimeout(300);

  const Q2 = { id: 'q2', text: 'بلندترین کوه ایران؟', options: ['دماوند', 'سبلان', 'زردکوه', 'الوند'], difficulty: 'medium' };
  await feed(page, snap({ room: { phase: 'ready', round: 2, phaseEndsAt: Date.now() + 5000 }, question: Q2 }));
  await page.waitForTimeout(500);
  const r2 = await readable(page, 'بلندترین کوه');
  ok('round two is gated too', r2.question === false, JSON.stringify(r2));
  ok('with its own countdown', r2.modal === true, String(r2.modal));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
