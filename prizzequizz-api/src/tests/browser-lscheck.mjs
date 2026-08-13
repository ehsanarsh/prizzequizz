/* THE QUESTION THAT NEVER ARRIVED, DRIVEN IN A BROWSER.
 *
 * Reported: in Last Survivor, question 1 shows for everybody, question 2 goes
 * missing for a few people, question 3 is fine again — and whoever missed one
 * is graded as having not answered, loses a shield or their place.
 *
 * The server side of that was a rate limiter that counted a whole room as one
 * caller (see rateLimitPerCaller.test.ts). This is the client half: what the
 * screen does when a round opens and the question is NOT in the payload. It
 * used to draw an empty card and never redraw it, because the render key was
 * status|phase|round and none of those change when the question turns up.
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
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 'test-token');
  localStorage.setItem('pz_rtok', 'test-rtoken');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, xp: 10, coins: 50, hearts: 5, weeklyScore: 0 }));
});

/* The snapshot endpoint is the thing that fails in the real bug, so the test
   controls it: `snapshotMode` decides what the next GET returns. */
let snapshotMode = 'full';
const polls = [];
const answersSent = [];
await ctx.route('**/v1/**', (route) => {
  const u = new URL(route.request().url());
  const p = u.pathname.replace(/^.*\/v1/, '');
  const send = (d, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });
  if (/^\/last-survivor\/rooms\/[^/]+\/answer$/.test(p)) {
    let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    answersSent.push(b);
    return send({ ok: true, data: { recorded: true } });
  }
  if (/^\/last-survivor\/rooms\/[^/]+$/.test(p)) {
    polls.push(snapshotMode);
    if (snapshotMode === 'fail') return send({ ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }, 429);
    return send({ ok: true, data: snap(snapshotMode !== 'noquestion') });
  }
  return send({ ok: true, data: {} });
});

function snapJson(withQuestion) {
  const s = {
    room: { id: 'r1', topic: 'عمومی', status: 'running', phase: 'question', round: 2, totalRounds: 10,
            capacity: 10, minUsers: 3, grossPool: 100000, netPool: 95000,
            phaseEndsAt: Date.now() + 12000, startsAt: Date.now(), serverNow: Date.now(), chatEnabled: false },
    stats: { alive: 5, eliminated: 1, cashedOut: 0, paidOut: 0, remainingPot: 95000, total: 6 },
    players: [{ userId: 'me', username: 'احسان', avatar: null, color: 'green', status: 'alive', shields: 0, payoutCash: 0 }],
    votes: 0,
    me: { userId: 'me', status: 'alive', color: 'green', units: 1, payoutCash: 0,
          answeredThisRound: false, decisionThisRound: null, currentShare: 0,
          shields: 0, shieldBroke: false, lifelinesUsed: [] }
  };
  if (withQuestion) s.question = { id: 'q2', round: 2, difficulty: 'medium', text: 'پایتخت ژاپن کدام است؟', options: ['توکیو', 'اوساکا', 'کیوتو', 'ناگویا'] };
  return s;
}
/* Injected into the page as a plain object. */
function snap(withQuestion) { return snapJson(withQuestion); }

const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.expose_binding === undefined ? null : null;
await page.evaluate((s) => { window.__snapFull = s; }, snapJson(true));
await page.evaluate((s) => { window.__snapNoQ = s; }, snapJson(false));

/* Put the app on the Last Survivor screen with a live round open. */
async function openRound(withQuestion) {
  await page.evaluate((withQ) => {
    (0, eval)("lsRoomId='r1'; lsLastKey=''; lsSnap=null; lsMyId='me'; lsAnswered=false; lsPuUsed={};");
    (0, eval)("showScreen('lsGame')");
    const s = JSON.parse(JSON.stringify(withQ ? window.__snapFull : window.__snapNoQ));
    s.room.phaseEndsAt = Date.now() + 12000; s.room.serverNow = Date.now();
    (0, eval)('lsRender')(s);
  }, withQuestion);
  await page.waitForTimeout(150);
}
const optionCount = () => page.evaluate(() => document.querySelectorAll('#lsBody #lsOpts .ans').length);
const questionText = () => page.evaluate(() => document.querySelector('#lsBody .ls-qtext')?.textContent || '');

console.log('a round that arrives complete:');
{
  snapshotMode = 'full';
  await openRound(true);
  ok('the question is on screen', /ژاپن/.test(await questionText()), await questionText());
  ok('with its four options', await optionCount() === 4, String(await optionCount()));
}

console.log('a round whose question did not make it:');
{
  snapshotMode = 'noquestion';
  await openRound(false);
  const before = await optionCount();
  ok('the card starts empty — nothing to answer', before === 0, String(before));

  /* Now the question turns up. status|phase|round have NOT changed. */
  snapshotMode = 'full';
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify(window.__snapFull));
    s.room.phaseEndsAt = Date.now() + 12000; s.room.serverNow = Date.now();
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(150);
  ok('the card is redrawn the moment the question arrives', await optionCount() === 4, String(await optionCount()));
  ok('and the text is really there', /ژاپن/.test(await questionText()), await questionText());
}

console.log('the client chases a question it does not have:');
{
  snapshotMode = 'noquestion';
  await openRound(false);
  polls.length = 0;
  snapshotMode = 'full';
  await page.evaluate(() => (0, eval)('lsTick()'));
  await page.waitForTimeout(400);
  ok('a missing question triggers a fetch without waiting for the slow tick', polls.length >= 1, JSON.stringify(polls));
  ok('and the question ends up on screen', await optionCount() === 4, String(await optionCount()));

  /* And it does not chase forever when there is genuinely nothing to fetch. */
  snapshotMode = 'noquestion';
  await openRound(false);
  polls.length = 0;
  for (let i = 0; i < 40; i++) await page.evaluate(() => (0, eval)('lsTick()'));
  await page.waitForTimeout(300);
  /* 40 ticks = 10 ordinary refreshes on the 4-second beat, plus at most the
     per-round chase budget. What must NOT happen is a fetch every single tick
     for a room that has no question to give. */
  ok('the chase is capped so a question-less room is not hammered', polls.length <= 20 && polls.length < 40, String(polls.length));
}

console.log('the round announcement carries the question itself:');
{
  snapshotMode = 'noquestion';          // the snapshot is useless on purpose
  await openRound(false);
  await page.evaluate(() => {
    (0, eval)('lsOnWs')('ls:question', {
      round: 3, questionId: 'q3', text: 'بلندترین کوه ایران؟',
      options: ['دماوند', 'سبلان', 'زردکوه', 'تفتان'],
      endsAt: Date.now() + 12000, serverNow: Date.now()
    });
  });
  await page.waitForTimeout(200);
  ok('the push alone puts a full question on screen', await optionCount() === 4, String(await optionCount()));
  ok('with the right text', /دماوند/.test(await page.evaluate(() => document.getElementById('lsOpts')?.textContent || '')));
  const round = await page.evaluate(() => (0, eval)('lsSnap.room.round'));
  ok('and the round moved on', round === 3, String(round));
}

console.log('a new round does not inherit the last one’s answer:');
{
  /* If answeredThisRound carried over, the new question would be replaced by
     «پاسخ شما ثبت شد» — the same blank screen by another road. */
  snapshotMode = 'noquestion';
  await openRound(false);
  await page.evaluate(() => { (0, eval)('lsSnap').me.answeredThisRound = true; });
  await page.evaluate(() => {
    (0, eval)('lsOnWs')('ls:ready', {
      round: 4, questionId: 'q4', text: 'سؤال چهارم؟', options: ['۱', '۲', '۳', '۴'],
      difficulty: 'hard', endsAt: Date.now() + 6000, serverNow: Date.now()
    });
  });
  await page.waitForTimeout(200);
  const answered = await page.evaluate(() => (0, eval)('lsSnap.me.answeredThisRound'));
  ok('the previous round’s answer flag is cleared', answered === false, String(answered));
  ok('and the new question is drawn, not the "answer recorded" note', await optionCount() === 4, String(await optionCount()));
}

console.log('a stale push cannot drag the match backwards:');
{
  const roundBefore = await page.evaluate(() => (0, eval)('lsSnap.room.round'));
  await page.evaluate(() => {
    (0, eval)('lsOnWs')('ls:question', { round: 1, questionId: 'q1', text: 'قدیمی', options: ['a', 'b', 'c', 'd'], endsAt: Date.now() + 9000 });
  });
  await page.waitForTimeout(150);
  const roundAfter = await page.evaluate(() => (0, eval)('lsSnap.room.round'));
  ok('an old round is ignored', roundAfter === roundBefore, roundBefore + ' → ' + roundAfter);
}

console.log('lifelines:');
{
  snapshotMode = 'full';
  await openRound(true);
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify(window.__snapFull));
    s.room.phaseEndsAt = Date.now() + 12000; s.room.serverNow = Date.now();
    s.me.lifelinesUsed = ['p5050'];
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(150);
  const used = await page.evaluate(() => (0, eval)('JSON.stringify(lsPuUsed)'));
  ok('a help spent earlier in the match is remembered', /"5050":true/.test(used), used);
  const dead = await page.evaluate(() => {
    const el = document.querySelector('#lsBody [data-ls-pu="5050"]');
    return el ? el.className : 'missing';
  });
  ok('and its button is greyed out', /used/.test(dead), dead);
  const live = await page.evaluate(() => {
    const el = document.querySelector('#lsBody [data-ls-pu="stats"]');
    return el ? el.className + ' | ' + el.textContent : 'missing';
  });
  ok('an untouched help is never labelled «استفاده شد»', !/\bused\b/.test(live) && !/استفاده شد/.test(live), live);

  /* The round rolls over — the buttons must NOT come back. */
  await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify(window.__snapFull));
    s.room.round = 5; s.room.phase = 'ready';
    s.room.phaseEndsAt = Date.now() + 6000; s.room.serverNow = Date.now();
    s.question.round = 5; s.me.lifelinesUsed = ['p5050'];
    (0, eval)('lsRender')(s);
  });
  await page.waitForTimeout(150);
  const stillUsed = await page.evaluate(() => (0, eval)('JSON.stringify(lsPuUsed)'));
  ok('a new round does not hand the help back', /"5050":true/.test(stillUsed), stillUsed);
}

/* ── tapping an option must light up THAT option ──────────────────────
   The card is shuffled per player, so every option carries two indexes: where
   it sits on this screen, and what the server calls it. Tapping «الف» used to
   highlight whichever option the server happened to call 0 — the answer sent
   was right, the one that lit up was not. */
console.log('tapping an option:');
{
  snapshotMode = 'full';
  for (const tapAt of [0, 1, 2, 3]) {
    await openRound(true);
    answersSent.length = 0;
    const r = await page.evaluate(async (idx) => {
      const btns = [...document.querySelectorAll('#lsBody #lsOpts .ans')];
      const tapped = btns[idx];
      const label = tapped.querySelector('.atxt').textContent;
      await (0, eval)('lsAnswer')(idx);
      const lit = [...document.querySelectorAll('#lsBody #lsOpts .ans.selected')];
      return {
        label,
        litCount: lit.length,
        litLabel: lit[0] ? lit[0].querySelector('.atxt').textContent : null,
        litIndex: lit[0] ? Number(lit[0].dataset.i) : -1
      };
    }, tapAt);
    ok('option ' + tapAt + ' lights up exactly one option', r.litCount === 1, String(r.litCount));
    ok('and it is the one that was tapped', r.litLabel === r.label && r.litIndex === tapAt, r.label + ' vs ' + r.litLabel);

    /* And the answer that went to the server is still the right one — the fix
       must not have swapped the bug from the screen to the wire. */
    await page.waitForTimeout(150);
    const sentIdx = answersSent.length ? answersSent[answersSent.length - 1].selectedIndex : null;
    const serverLabel = await page.evaluate((i) => (0, eval)('lsSnap').question.options[i], sentIdx);
    ok('and the option sent to the server is that same option', serverLabel === r.label, serverLabel + ' vs ' + r.label);
  }
}

console.log('a shield breaking:');
{
  await openRound(true);
  const v = await page.evaluate(() => {
    const s = JSON.parse(JSON.stringify(window.__snapFull));
    s.room.phase = 'elimination';
    s.me.shieldBroke = true; s.me.shields = 1;      // had a red shield, one left
    s.me.reveal = { options: ['توکیو', 'اوساکا', 'کیوتو', 'ناگویا'], correctIndex: 0, yourIndex: 2 };
    (0, eval)('lsRender')(s);
    const card = document.querySelector('.ls-verdict');
    const cs = getComputedStyle(card);
    return {
      cls: card.className,
      color: cs.color,
      fontSize: parseFloat(getComputedStyle(card.querySelector('.lsv-head')).fontSize),
      halves: document.querySelectorAll('.lsb-half').length,
      broken: (document.querySelector('.lsb-half') || {}).className || '',
      fresh: (document.querySelector('.lsb-new') || {}).className || '',
      anim: getComputedStyle(document.querySelector('.lsb-half')).animationName
    };
  });
  const rgb = (v.color.match(/\d+/g) || []).map(Number);
  ok('the card is red — the answer was wrong', rgb[0] > 150 && rgb[1] < 130 && rgb[2] < 130, v.color);
  ok('not the old calm blue', !/shield/.test(v.cls.replace('ls-shield-break', '')), v.cls);
  ok('the headline is big enough to read at a glance', v.fontSize >= 18, String(v.fontSize));
  ok('the shield is drawn in two halves', v.halves === 2, String(v.halves));
  ok('the broken one is the shield that was held — red', /red/.test(v.broken), v.broken);
  ok('and the one left is blue', /blue/.test(v.fresh), v.fresh);
  ok('the halves really animate apart', /lsbFly|lsbShake/.test(v.anim), v.anim);
}

console.log('the last shield breaking:');
{
  const v = await page.evaluate(() => {
    /* The client skips a redraw when nothing about the round changed, and the
       previous case left it on the same round+phase — so the guard is cleared
       here. In a real match a player only breaks one shield per round. */
    (0, eval)("lsLastKey=''");
    const s = JSON.parse(JSON.stringify(window.__snapFull));
    s.room.phase = 'elimination';
    s.me.shieldBroke = true; s.me.shields = 0;      // had a blue shield, none left
    s.me.reveal = { options: ['توکیو', 'اوساکا', 'کیوتو', 'ناگویا'], correctIndex: 0, yourIndex: 2 };
    (0, eval)('lsRender')(s);
    return {
      broken: (document.querySelector('.lsb-half') || {}).className || '',
      fresh: (document.querySelector('.lsb-new') || {}).className || '',
      freshShape: (document.querySelector('.lsb-new svg') || {}).innerHTML || '',
      text: document.querySelector('.ls-verdict').innerText
    };
  });
  ok('a blue shield breaks', /blue/.test(v.broken), v.broken);
  ok('and green is what is left', /green/.test(v.fresh), v.fresh);
  ok('drawn as the circle, not a shield', /circle/.test(v.freshShape), v.freshShape.slice(0, 40));
  ok('and the player is told the next mistake ends it', /اشتباه بعدی/.test(v.text), v.text.replace(/\n/g, ' ').slice(0, 90));
}

ok('no script errors through all of it', errs.length === 0, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
