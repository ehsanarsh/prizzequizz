/* JUDGING A GENERATED QUESTION, NOT JUST ITS FIRST LINE.
 *
 * «بعد تولید من باید بتونم چهارگزینه رو ببینم و بتونم سطح سوال رو تغییر بدم و
 *  مدیریت کنم.»
 *
 * The run report was a list of question TEXTS with an approve button beside
 * each — and a question cannot be judged from its text. «پایتخت استرالیا
 * کجاست؟» is a fine question with four wrong answers underneath it, and this
 * game pays real money on the answer. The options were written to the bank and
 * simply never sent back to the screen.
 *
 * Everything here goes through the RENDERED CARD and real clicks: a test that
 * called aiSetDiff() directly would prove the function works and say nothing
 * about whether an operator can reach it.
 *
 * Run: node src/tests/browser-aireview.mjs */
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
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

const RUN = {
  configured: true, requested: 2, generated: 2, added: 1, pending: 1, skipped: [],
  questions: [
    { id: 'q1', text: 'پایتخت استرالیا کجاست؟', category: 'جغرافیا', difficulty: 'medium',
      stage: 'approved', quality: 88, approved: true,
      options: ['سیدنی', 'کانبرا', 'ملبورن', 'پرت'], correctIndex: 1,
      explanation: 'کانبرا از ۱۹۱۳ پایتخت است؛ سیدنی بزرگ‌ترین شهر است، نه پایتخت.' },
    { id: 'q2', text: 'بلندترین قلهٔ ایران کدام است؟', category: 'جغرافیا', difficulty: 'easy',
      stage: 'held', quality: 61, approved: false, reason: 'امتیاز کیفیت ۶۱ کمتر از حد ۷۰ است',
      options: ['دماوند', 'علم‌کوه', 'سبلان', 'زردکوه'], correctIndex: 0 },
    /* A MODEL WRITES SENTENCES, NOT WORDS. Every option above is one or two
       words, and a row only has to hold a word to look fine however it is laid
       out — which is why two mutations of the layout survived this file until
       this question was added. */
    { id: 'q3', text: 'کدام گزینه دربارهٔ سازوکار تقسیم جایزه در حالت «آخرین بازمانده» درست است؟',
      category: 'عمومی', difficulty: 'hard', stage: 'held', quality: 71, approved: false, reason: 'نگه داشته شد',
      options: [
        'جایزه پس از حذف هر بازیکن میان بازماندگان تقسیم می‌شود و هر کس بخواهد می‌تواند سهمش را برداشت کند',
        'تمام جایزه فقط به آخرین نفری می‌رسد که تا پایان دوازده سؤال در بازی مانده باشد',
        'جایزه در ابتدای مسابقه میان همهٔ شرکت‌کنندگان به‌صورت مساوی تقسیم می‌شود',
        'هیچ جایزه‌ای تقسیم نمی‌شود مگر آنکه همهٔ بازیکنان تا سؤال آخر ادامه دهند'
      ], correctIndex: 0 }
  ]
};

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const patched = [];
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let body = { ok: true, data: {} };
    /* Enough of the AI studio's own calls that renderAiStudio() will draw. */
    if (u.includes('/admin/questions/ai/status')) body = { ok: true, data: { configured: true, provider: 'anthropic', models: [], qualityMin: 80, duplicateThreshold: 90 } };
    else if (u.includes('/admin/questions/ai/models')) body = { ok: true, data: { models: [] } };
    else if (u.includes('/admin/categories')) body = { ok: true, data: { categories: [{ name: 'فرهنگ و هنر', icon: '🎭' }] } };
    else if (route.request().method() === 'PATCH' && /\/admin\/questions\/[^/]+$/.test(u)) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      patched.push({ id: u.split('/').pop(), body: b });
      /* Refused for q2 on purpose in one case below — see the rollback test. */
      if (patched[patched.length - 1].id === 'qBAD') {
        return route.fulfill({ status: 422, contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: { code: 'NOPE', message: 'ذخیره نشد' } }) });
      }
      body = { ok: true, data: { id: patched[patched.length - 1].id, ...b } };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  /* THE PANEL BOOTS ON ITS LOGIN SCREEN. Without revealing the shell the markup
     reads fine and nothing is clickable — the layout has zero height. */
  await page.evaluate(() => {
    document.getElementById('login').classList.add('hidden');
    document.getElementById('shell').classList.remove('hidden');
  });
  /* THE REAL SCREEN, NOT A DIV OF OUR OWN.
     This used to build its own `#ai_out` inside `#main` — and that is exactly
     how it missed the thing it existed to check. In the real studio the option
     rows came out with a ZERO-WIDTH text column: every Persian letter on its
     own line, each option a 153px vertical ribbon of characters. The markup was
     correct in isolation and wrong where it lives. */
  await page.evaluate(async () => { (0, eval)("CUR='aistudio'"); await (0, eval)('renderAiStudio')(); });
  await page.waitForTimeout(600);
  await page.evaluate((run) => {
    (0, eval)('aiSaveRun')(run, true);
    document.getElementById('ai_out').innerHTML = (0, eval)('aiRunHtml')(run, false);
  }, RUN);
  await page.waitForTimeout(350);
  return { ctx, page, patched, errs };
}

const cards = (page) => page.evaluate(() => [...document.querySelectorAll('.ai-qcard')].map((c) => ({
  id: c.id,
  text: (c.querySelector('.ai-qtext') || {}).textContent || '',
  opts: [...c.querySelectorAll('.ai-opt')].map((o) => ({
    label: (o.querySelector('span') || {}).textContent || '',
    on: o.classList.contains('on'),
    checked: !!(o.querySelector('input') || {}).checked,
    visible: o.getBoundingClientRect().height > 0
  })),
  diff: (c.querySelector('.ai-diff') || {}).value || '',
  diffVisible: !!c.querySelector('.ai-diff') && c.querySelector('.ai-diff').getBoundingClientRect().height > 0,
  why: (c.querySelector('.note') || {}).textContent || ''
})));

/* ── 1. WHAT IS ON THE CARD ─────────────────────────────────────────────── */
console.log('a generated question:');
{
  const { ctx, page, errs } = await open();
  const c = await cards(page);
  ok('every generated question gets a card', c.length === 3, c.length + ' cards');
  ok('the question itself is on it', /پایتخت استرالیا/.test(c[0].text), c[0].text);

  /* THE WHOLE POINT. */
  ok('all four options are drawn', c[0].opts.length === 4, c[0].opts.length + ' options');
  ok('and every one of them is actually visible', c[0].opts.every((o) => o.visible));
  ok('with their real text', c[0].opts.map((o) => o.label).join('|') === 'سیدنی|کانبرا|ملبورن|پرت',
    c[0].opts.map((o) => o.label).join('|'));

  /* Which one is right has to be readable at a glance, not only as a radio dot. */
  const marked = c[0].opts.map((o, i) => (o.on ? i : -1)).filter((i) => i >= 0);
  ok('exactly one option is marked as the right answer', marked.length === 1, JSON.stringify(marked));
  ok('and it is the right one', marked[0] === 1, 'index ' + marked[0]);
  ok('the radio agrees with the highlight', c[0].opts[1].checked);

  ok('the explanation is shown when there is one', /کانبرا از ۱۹۱۳/.test(c[0].why), c[0].why.slice(0, 40));

  /* ── AND IT IS READABLE, WHICH IS NOT THE SAME AS PRESENT ──────────────
     «نحوهٔ نمایش گزینه‌ها خیلی بزرگه و حروف زیر هم نوشته میشه و اصلا خوانا
      نیست.» Every assertion above passed while each option was a 153px column
     of single letters, because «the text is in the DOM» and «the text can be
     read» are different questions. These ask the second one. */
  const geoOf = (id) => page.evaluate((qid) => [...document.querySelectorAll('#aiq_' + qid + ' .ai-opt')].map((el) => {
    const span = el.querySelector('span');
    const r = el.getBoundingClientRect(), s = span.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(span).lineHeight) || 1;
    return { rowH: Math.round(r.height), textW: Math.round(s.width), lines: Math.round(s.height / lh),
             /* Text wider than the box it sits in is text running off the card. */
             spill: Math.round(span.scrollWidth - span.clientWidth) };
  }), id);

  const geo = await geoOf('q1');
  ok('the answer text has room to be text', geo.every((g) => g.textW > 80), JSON.stringify(geo.map((g) => g.textW)));
  ok('a short answer stays on one line', geo.every((g) => g.lines <= 1), JSON.stringify(geo.map((g) => g.lines)));
  ok('and a row is a row, not a column of letters', geo.every((g) => g.rowH <= 56), JSON.stringify(geo.map((g) => g.rowH)));

  /* A SENTENCE-LENGTH ANSWER, which is what a model actually writes. */
  const long = await geoOf('q3');
  ok('a long answer still gets a wide column', long.every((g) => g.textW > 300), JSON.stringify(long.map((g) => g.textW)));
  ok('it wraps into a few lines, not into a ribbon', long.every((g) => g.lines >= 1 && g.lines <= 4), JSON.stringify(long.map((g) => g.lines)));
  ok('and nothing spills out of its box', long.every((g) => g.spill <= 1), JSON.stringify(long.map((g) => g.spill)));
  ok('the row grows with the text, but only so far', long.every((g) => g.rowH <= 110), JSON.stringify(long.map((g) => g.rowH)));
  ok('the difficulty is a control, not a label', c[0].diffVisible && c[0].diff === 'medium', c[0].diff);
  ok('and it starts on what the model chose', c[1].diff === 'easy', c[1].diff);
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. CHANGING THE LEVEL ──────────────────────────────────────────────── */
console.log('\nchanging the level:');
{
  const { ctx, page, patched, errs } = await open();
  await page.selectOption('#aiq_q2 .ai-diff', 'hard');
  await page.waitForTimeout(500);

  ok('a level change reaches the server', patched.length === 1, JSON.stringify(patched));
  ok('as the question it was changed on', patched[0] && patched[0].id === 'q2', patched[0] && patched[0].id);
  ok('carrying only the level', patched[0] && JSON.stringify(patched[0].body) === '{"difficulty":"hard"}',
    JSON.stringify(patched[0] && patched[0].body));
  /* Status is a separate decision and must not ride along with an edit. */
  ok('and never the status', patched[0] && !('status' in patched[0].body));
  ok('the remembered run is updated too', await page.evaluate(() =>
    ((0, eval)('aiLastRun')().r.questions.find((q) => q.id === 'q2') || {}).difficulty) === 'hard');
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. CHANGING THE RIGHT ANSWER ───────────────────────────────────────── */
console.log('\nchanging the right answer:');
{
  const { ctx, page, patched, errs } = await open();
  /* A real click on the option, the way an operator fixes a wrong key. */
  await page.click('#aiq_q1 .ai-opt:nth-child(3)');
  await page.waitForTimeout(600);

  ok('the new answer reaches the server', patched.length === 1 && patched[0].body.correctIndex === 2,
    JSON.stringify(patched));
  const c = await cards(page);
  const marked = c[0].opts.map((o, i) => (o.on ? i : -1)).filter((i) => i >= 0);
  /* The highlight has to FOLLOW: moving the radio dot and leaving the green row
     where it was is how an operator thinks they fixed it and did not. */
  ok('and the highlight moves with it', marked.length === 1 && marked[0] === 2, JSON.stringify(marked));
  ok('the remembered run is updated too', await page.evaluate(() =>
    ((0, eval)('aiLastRun')().r.questions.find((q) => q.id === 'q1') || {}).correctIndex) === 2);
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. WHEN THE SAVE IS REFUSED ────────────────────────────────────────── */
console.log('\nwhen the server says no:');
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.route('**/v1/**', (route) => route.fulfill({ status: 422, contentType: 'application/json',
    body: JSON.stringify({ ok: false, error: { code: 'NOPE', message: 'ذخیره نشد' } }) }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.getElementById('login').classList.add('hidden');
    document.getElementById('shell').classList.remove('hidden');
  });
  await page.evaluate((run) => {
    document.getElementById('main').innerHTML = '<div id="ai_out"></div>';
    document.getElementById('ai_out').innerHTML = (0, eval)('aiRunHtml')(run, false);
    (0, eval)('aiSaveRun')(run, true);
  }, RUN);
  await page.waitForTimeout(250);

  await page.selectOption('#aiq_q2 .ai-diff', 'hard');
  await page.waitForTimeout(600);
  /* A DROPDOWN THAT MOVED ON SCREEN AND NOT IN THE BANK IS THE WORST OF BOTH:
     the operator believes the level changed and the game disagrees. */
  const back = await page.evaluate(() => document.querySelector('#aiq_q2 .ai-diff').value);
  ok('a refused level change is put back on screen', back === 'easy', back);
  ok('and the remembered run is not moved either', await page.evaluate(() =>
    ((0, eval)('aiLastRun')().r.questions.find((q) => q.id === 'q2') || {}).difficulty) === 'easy');

  await page.click('#aiq_q1 .ai-opt:nth-child(3)');
  await page.waitForTimeout(600);
  const c = await cards(page);
  const marked = c[0].opts.map((o, i) => (o.on ? i : -1)).filter((i) => i >= 0);
  ok('a refused answer change is put back too', marked.length === 1 && marked[0] === 1, JSON.stringify(marked));
  /* THE RADIO, NOT ONLY THE HIGHLIGHT.
     Clicking an option moves the RADIO by itself — the browser does that — and
     the green highlight is a class the card only gets on a redraw. So on a
     refused save the highlight is still on the old answer whether the rollback
     ran or not, and checking it proves nothing: this assertion passed with the
     rollback deleted. What the rollback is actually for is the dot, which the
     click has already moved to the answer the server refused. */
  const dots = c[0].opts.map((o, i) => (o.checked ? i : -1)).filter((i) => i >= 0);
  ok('and the radio itself goes back to the saved answer', dots.length === 1 && dots[0] === 1, JSON.stringify(dots));
  ok('the remembered run is untouched as well', await page.evaluate(() =>
    ((0, eval)('aiLastRun')().r.questions.find((q) => q.id === 'q1') || {}).correctIndex) === 1);
  ok('nothing threw', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. A QUESTION THAT CAME BACK BROKEN ────────────────────────────────── */
console.log('\na question with no options:');
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.route('**/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"data":{}}' }));
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.getElementById('login').classList.add('hidden');
    document.getElementById('shell').classList.remove('hidden');
  });
  await page.evaluate(() => {
    const run = { configured: true, requested: 1, generated: 1, added: 0, pending: 1, skipped: [],
      questions: [{ id: 'q9', text: 'یک سؤال ناقص', difficulty: 'medium', stage: 'held',
        quality: 40, approved: false, options: ['فقط یکی'], correctIndex: 0 }] };
    document.getElementById('main').innerHTML = '<div id="ai_out"></div>';
    document.getElementById('ai_out').innerHTML = (0, eval)('aiRunHtml')(run, false);
  });
  await page.waitForTimeout(200);
  /* Said plainly rather than drawn as an empty box that reads like the model's
     fault — and still deletable, which is the only sensible thing to do with it. */
  const t = await page.evaluate(() => (document.querySelector('#aiq_q9') || {}).innerText || '');
  ok('it says the question is broken', /چهار گزینه ندارد/.test(t), t.replace(/\s+/g, ' ').slice(0, 60));
  ok('and there is still a way to delete it', await page.evaluate(() =>
    !!document.querySelector('#aiq_q9 .danger')));
  await ctx.close();
}

await browser.close(); server.close();
console.log(`\n[aireview] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
