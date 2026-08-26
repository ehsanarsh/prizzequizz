/* THE QUESTION MAKER, THE RULES, THE CREDIT LINE, AND THE WAY OUT.
 *
 *   • «تولید سوال باید بازطراحی بشه — برای هر گزینه یک کادر مجزا، موضوعات با
 *     موضوعات سرور یکی باشه، سختی آسان/متوسط/سخت/خیلی سخت»
 *   • «در موقع پخش سوال ریز زیر سوال بنویسه طراحی‌شده توسط اسم کاربر»
 *   • «باتم‌شیت‌ها راه خروجی ندارن — دکمهٔ ضربدر قرمز باشه»
 *   • «موقع ثبت‌نام باید مستقیم بره به انتخاب کاراکتر»
 *   • «قوانین و مقررات رو کامل بنویس»
 *   • «دور همهٔ کارت‌ها زرد، همهٔ دکمه‌های بک زرد»
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

/* THE MAKER'S OWN TOPIC LIST, which the server now serves separately.
   «باید همه موضوعات فعال بازی باشه… به غیر از تصادفی و انتخاب موضوع» — so the
   filtering happens on the server, and what arrives here is already the answer.
   «سینما» has no questions yet and is still offered: a topic with an empty bank
   is exactly where a new question is worth the most. */
const MAKER_TOPICS = [
  { name: 'ورزشی', icon: '⚽', image: '', questionCount: 40 },
  { name: 'تاریخ', icon: '🏛️', image: '', questionCount: 25 },
  { name: 'سینما', icon: '🎬', image: '', questionCount: 0 }
];
/* Last Survivor's list, which the maker must NOT be reading any more. */
const TOPICS = [
  { name: 'تصادفی', random: true, playable: true, questionCount: 90, icon: '🎲' },
  { name: 'ورزشی', random: false, playable: true, questionCount: 40, icon: '⚽' }
];
let lsTopicsAsked = 0;
const posted = [];

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (route.request().method() === 'POST' || route.request().method() === 'PATCH') {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      posted.push({ path: p, body });
      if (p === '/questions/submit') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { questionId: 'q9' } }) });
      if (p === '/users/me') return send({ id: 'me', username: body.username, displayName: body.displayName, level: 1, coins: 0, hearts: 5 });
      return send({});
    }
    if (p === '/last-survivor/topics') { lsTopicsAsked++; return send({ topics: TOPICS, tickets: {} }); }
    if (p === '/questions/maker-topics') return send({ topics: MAKER_TOPICS });
    if (p === '/questions/mine') return send({ rows: [] });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true;"));
  return { ctx, page, errs };
}

/* ── THE QUESTION MAKER ──────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('writing a question:');
  await page.evaluate(async () => { (0, eval)('hmQuizMaker')(); await new Promise((r) => setTimeout(r, 800)); });

  /* «کاربر قبل از ورود به صفحه کوییز ساز موضوع رو از لیست انتخاب کنه بعد وارد
     همون صفحه بشه» — the maker is one screen further in than it was. */
  ok('the maker opens on the topic list, not the form',
    await page.evaluate(() => (document.querySelector('.screen.active') || {}).id) === 'qstopics',
    await page.evaluate(() => (document.querySelector('.screen.active') || {}).id));
  const cats = await page.evaluate(() => [...document.querySelectorAll('#qsTopicList .qs-topic')].map((b) => b.getAttribute('data-c')));
  ok('every topic the maker is open for is on it', cats.join(',') === 'ورزشی,تاریخ,سینما', cats.join(' / '));
  /* THE BUG: it used to read Last Survivor's list, which hides everything not
     running a room, so most of the game could not be written about. */
  ok('and Last Survivor\'s list is not what it reads', lsTopicsAsked === 0, String(lsTopicsAsked));
  ok('a topic with no questions yet is still offered', cats.indexOf('سینما') >= 0, cats.join(' / '));
  /* Named rather than positional: the card lays the name and the count in a
     wrapper now, and «the last span» quietly became the wrapper — which still
     contains the count, so a loose selector would have gone on passing while
     testing something else. */
  ok('each one says how many questions it has',
    await page.evaluate(() => (document.querySelector('#qsTopicList .qs-topic .tmeta > span') || {}).textContent || '') === '۴۰ سؤال',
    await page.evaluate(() => (document.querySelector('#qsTopicList .qs-topic .tmeta > span') || {}).textContent || ''));
  /* Nothing is chosen for them: the form is not open yet. */
  ok('no topic is assumed before one is picked', await page.evaluate(() => (0, eval)('QS_CAT')) === '', await page.evaluate(() => (0, eval)('QS_CAT')));

  /* Tapping a topic IS the way in. */
  await page.evaluate(() => document.querySelector('#qsTopicList .qs-topic[data-c="تاریخ"]').click());
  await page.waitForTimeout(500);
  ok('picking one opens the maker', await page.evaluate(() => (document.querySelector('.screen.active') || {}).id) === 'qsubmit');
  ok('for that topic', await page.evaluate(() => (0, eval)('QS_CAT')) === 'تاریخ', await page.evaluate(() => (0, eval)('QS_CAT')));
  const chosen = await page.evaluate(() => (document.getElementById('qsChosen') || {}).textContent || '');
  ok('and the maker says which topic it is writing for', /تاریخ/.test(chosen), chosen.trim());
  ok('with a way back to the list', await page.evaluate(() => !!document.querySelector('#qsChosen button[onclick*="qstopics"]')));
  /* The chips are gone: the topic is not chosen twice. */
  ok('the old chip row is gone', await page.evaluate(() => !document.getElementById('qsCats')));

  /* A RELOAD, A DEEP LINK, A BACK BUTTON — anything that lands on the form with
     no topic behind it. The form cannot be submitted without one, so the player
     is put back on the list rather than left filling in a page that will refuse
     them at the end. */
  await page.evaluate(() => { (0, eval)("QS_CAT='';"); (0, eval)('go')('qsubmit'); });
  await page.waitForTimeout(400);
  ok('the form is not shown without a topic',
    await page.evaluate(() => (document.querySelector('.screen.active') || {}).id) === 'qstopics',
    await page.evaluate(() => (document.querySelector('.screen.active') || {}).id));
  await page.evaluate(() => document.querySelector('#qsTopicList .qs-topic[data-c="تاریخ"]').click());
  await page.waitForTimeout(400);

  const diffs = await page.evaluate(() => [...document.querySelectorAll('#qsDiffs .qs-chip')].map((b) => ({ d: b.getAttribute('data-d'), t: b.textContent.trim() })));
  /* «سطح سختی باید آسان متوسط سخت و خیلی سخت باشه» */
  ok('there are four levels of difficulty', diffs.length === 4, diffs.map((x) => x.d).join(','));
  ok('including خیلی سخت, which was missing', diffs.some((x) => x.d === 'veryhard' && /خیلی سخت/.test(x.t)), JSON.stringify(diffs.map((x) => x.t)));

  /* «برای هر گزینه یک کادر مجزا» */
  const boxes = await page.evaluate(() => document.querySelectorAll('#qsOpts .qs-opt .input').length);
  ok('each option has a box of its own', boxes === 4, String(boxes));
  const oldFields = await page.evaluate(() => [!!document.getElementById('qsCorrect'), !!document.getElementById('qsWrong')]);
  ok('and the slash-separated field is gone', oldFields[0] === false && oldFields[1] === false, JSON.stringify(oldFields));

  posted.length = 0;
  const sent = await page.evaluate(async () => {
    (0, eval)('qsPickDiff')('veryhard');
    document.getElementById('qsText').value = 'کدام سردار در نبرد گاگامل شکست خورد؟';
    ['اسکندر', 'داریوش سوم', 'کوروش', 'خشایارشا'].forEach((t, i) => { document.getElementById('qsO' + i).value = t; });
    (0, eval)('qsPickCorrect')(1);
    await (0, eval)('submitQuestion')();
    await new Promise((r) => setTimeout(r, 500));
    return null;
  });
  const body = (posted.find((x) => x.path === '/questions/submit') || {}).body;
  ok('the question is sent to the server', !!body, JSON.stringify(posted.map((p) => p.path)));
  ok('with all four options in order', !!body && body.options.length === 4 && body.options[1] === 'داریوش سوم', JSON.stringify(body && body.options));
  /* THE POINT of tapping rather than typing into a «correct» field: the right
     answer can be any of the four, so the bank does not always hold it first. */
  ok('and the right answer wherever it was put', !!body && body.correctIndex === 1, String(body && body.correctIndex));
  ok('carrying the topic that was chosen', !!body && body.category === 'تاریخ', String(body && body.category));
  ok('and the difficulty, in the words the server uses', !!body && body.difficulty === 'veryhard', String(body && body.difficulty));

  /* It must refuse to send half a question rather than let one through. */
  posted.length = 0;
  const refused = await page.evaluate(async () => {
    (0, eval)("closeAaaModal(false);");
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('qsText').value = 'یک سوال ناقص';
    ['الف', 'الف', '', ''].forEach((t, i) => { document.getElementById('qsO' + i).value = t; });
    await (0, eval)('submitQuestion')();
    await new Promise((r) => setTimeout(r, 300));
    return (document.getElementById('aaaSub') || {}).textContent || '';
  });
  ok('an unfinished question is not sent', posted.length === 0, JSON.stringify(posted));
  ok('and it says what is missing', /گزینه/.test(refused), refused.trim());

  /* Four boxes all filled, two of them the same — a question with two right
     answers, or two wrong ones the player cannot tell apart. */
  posted.length = 0;
  const dup = await page.evaluate(async () => {
    (0, eval)("closeAaaModal(false);");
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('qsText').value = 'کدام‌یک پایتخت فرانسه است؟';
    ['پاریس', 'رم', 'رم', 'لندن'].forEach((t, i) => { document.getElementById('qsO' + i).value = t; });
    await (0, eval)('submitQuestion')();
    await new Promise((r) => setTimeout(r, 300));
    return (document.getElementById('aaaSub') || {}).textContent || '';
  });
  ok('two identical options are refused', posted.length === 0, JSON.stringify(posted));
  ok('and said so plainly', /مثل هم/.test(dup), dup.trim());
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE CREDIT UNDER THE QUESTION ───────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('a question somebody wrote, while it is being asked:');
  const snap = (author) => {
    const now = Date.now();
    return { room: { id: 'R9', topic: 'ورزشی', status: 'running', phase: 'question', round: 3, totalRounds: 12,
             capacity: 20, startsAt: now - 60000, phaseEndsAt: now + 20000, serverNow: now, grossPool: 250000, chatEnabled: true, forfeited: 0 },
      players: [{ userId: 'me', username: 'احسان', avatar: '', character: null, color: 'green', status: 'alive', shields: 0, units: 1 }],
      me: { userId: 'me', username: 'احسان', status: 'alive', shields: 0, units: 1, currentShare: 0, lifelinesUsed: [] },
      stats: { alive: 1, eliminated: 0, cashedOut: 0, totalPlayers: 1, grossPot: 250000, remainingPot: 250000, paidOut: 0 },
      question: { id: 'q1', text: 'پایتخت فرانسه؟', options: ['پاریس', 'رم', 'مادرید', 'لندن'], difficulty: 'easy', authorName: author },
      votes: 0 };
  };
  await page.evaluate((sn) => {
    (0, eval)("lsRoomId='R9'; lsMyId='me'; lsSnap=null; lsLastKey=''; lsWatching=false; go('lsGame');");
    (0, eval)('lsRender')(sn);
  }, snap('سارا'));
  await page.waitForTimeout(500);
  const line = await page.evaluate(() => {
    const el = document.querySelector('#lsGame .pz-byline');
    if (!el) return null;
    const q = document.querySelector('#lsGame .ls-qtext');
    return { text: el.textContent.trim(),
             px: Math.round(parseFloat(getComputedStyle(el).fontSize)),
             qpx: Math.round(parseFloat(getComputedStyle(q).fontSize)),
             below: el.getBoundingClientRect().top >= q.getBoundingClientRect().bottom - 1 };
  });
  ok('the author is credited under the question', !!line && /سارا/.test(line.text), JSON.stringify(line));
  ok('in the words asked for', !!line && /طراحی‌شده توسط/.test(line.text), line && line.text);
  /* «ریز» — small. Bigger than the question would be absurd. */
  ok('and small, under the question itself', line.px < line.qpx && line.below, line.px + 'px vs ' + line.qpx + 'px');

  const none = await page.evaluate(async (sn) => {
    (0, eval)("lsSnap=null; lsLastKey='';");
    (0, eval)('lsRender')(sn);
    await new Promise((r) => setTimeout(r, 400));
    return document.querySelectorAll('#lsGame .pz-byline').length;
  }, snap(''));
  /* A question the operator wrote has nobody to credit — and a line reading
     «طراحی‌شده توسط» with nothing after it is worse than no line. */
  ok('a question with no author gets no line at all', none === 0, String(none));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── A WAY OUT OF EVERY BOTTOM SHEET ─────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the bottom sheets:');
  const sheets = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.sheet').forEach((s) => {
      const x = s.querySelector('.sheet-x') || s.querySelector('.ib-close');
      out.push({ id: s.id, hasX: !!x });
    });
    return out;
  });
  ok('every sheet has a close button', sheets.every((s) => s.hasX), JSON.stringify(sheets));

  const red = await page.evaluate(() => {
    (0, eval)('openKyc')();
    const b = document.querySelector('#kycSheet .sheet-x');
    if (!b) return null;
    const bg = getComputedStyle(b).backgroundImage + getComputedStyle(b).backgroundColor;
    const r = b.getBoundingClientRect();
    return { red: /255,\s*122,\s*107|#FF7A6B/i.test(bg), w: Math.round(r.width), onScreen: r.width > 20 && r.top >= 0 };
  });
  ok('the prize sheet’s way out is red', !!red && red.red, JSON.stringify(red));
  ok('and big enough to hit', red.onScreen, JSON.stringify(red));

  const closed = await page.evaluate(async () => {
    document.querySelector('#kycSheet .sheet-x').click();
    await new Promise((r) => setTimeout(r, 500));
    return document.getElementById('kycSheet').classList.contains('show');
  });
  ok('and pressing it actually closes the sheet', closed === false, String(closed));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── REGISTRATION GOES STRAIGHT ON ───────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('finishing registration:');
  /* The REAL submit, filled in and pressed — driving the navigation by hand
     here would only be testing the harness. */
  const landed = await page.evaluate(async () => {
    (0, eval)("go('register')");
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('regFullName').value = 'احسان رضایی';
    document.getElementById('regUsername').value = 'ehsan_1364';
    const g = document.getElementById('regGender'); if (g) g.value = 'male';
    await (0, eval)('submitRegister')();
    await new Promise((r) => setTimeout(r, 900));
    return { screen: [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id,
             back: (0, eval)('charBack'),
             note: !!document.getElementById('regSavedNote') };
  });
  ok('the details really were saved', landed.note, JSON.stringify(landed));
  /* «الان وقتی ثبت رو میزنی اسم دکمه به انتخاب کاراکتر تغییر پیدا میکنه و باید
     دوباره همونو بزنی» — one press, not two. */
  ok('the character picker opens by itself', landed.screen === 'character', JSON.stringify(landed));
  ok('and finishing it lands on home, not the profile', landed.back === 'home', String(landed.back));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE RULES ───────────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the rules page:');
  await page.evaluate(async () => { (0, eval)("go('rules')"); await new Promise((r) => setTimeout(r, 500)); });
  const rules = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#rulesBody .rule-card')];
    return { cards: cards.length,
             lines: document.querySelectorAll('#rulesBody .rule-list li').length,
             heads: cards.map((c) => c.querySelector('.rule-h').textContent.replace(/\s+/g, ' ').trim()),
             text: document.getElementById('rulesBody').textContent };
  });
  ok('it is a real set of rules, not three sentences', rules.cards >= 8, String(rules.cards));
  ok('with a numbered line for each rule', rules.lines >= 25, String(rules.lines));
  /* The subjects a player actually needs the rules for. */
  for (const [what, re] of [['tickets', /بلیط/], ['Last Survivor', /آخرین بازمانده/], ['the ladder', /نردبان/],
                            ['invites', /دعوت/], ['the quiz maker', /کوییزساز/], ['withdrawals', /برداشت/],
                            ['fair play', /جوانمردانه|تقلب/], ['support', /پشتیبانی/]]) {
    ok('covers ' + what, re.test(rules.text), '');
  }
  /* The server sends take-home figures and the operator can change the rest, so
     a percentage written here would be the one official-looking number in the
     app that could be wrong. */
  ok('and quotes no fee percentage it cannot keep true', !/٪|درصد|%/.test(rules.text), (rules.text.match(/.{0,20}(٪|درصد|%).{0,20}/) || [''])[0]);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── YELLOW EDGES, YELLOW BACK BUTTONS ───────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the colours:');
  const paint = await page.evaluate(async () => {
    const seen = [];
    for (const id of ['rules', 'qsubmit', 'support', 'friends', 'wallet', 'settings']) {
      (0, eval)("go('" + id + "')");
      await new Promise((r) => setTimeout(r, 320));
      /* The BACK arrow, found by what it is rather than by where it sits: the
         friends screen's first icon button is «＋», which must stay as it was. */
      const btns = [...document.querySelectorAll('#' + id + ' .topbar .iconbtn')];
      const back = btns.find((b) => /→|‹/.test(b.textContent));
      const other = btns.find((b) => !/→|‹/.test(b.textContent));
      const card = document.querySelector('#' + id + ' .card, #' + id + ' .qsubmit-card, #' + id + ' .sup-card, #' + id + ' .friend-card');
      seen.push({
        id,
        back: back ? back.classList.contains('ib-back') : null,
        backBg: back ? getComputedStyle(back).backgroundImage : '',
        otherBg: other ? getComputedStyle(other).backgroundImage : null,
        cardBorder: card ? getComputedStyle(card).borderTopColor : null
      });
    }
    return seen;
  });
  const yellow = (s) => /255,\s*210,\s*31|255,\s*226,\s*74|240,\s*164,\s*0/.test(s);
  ok('every screen checked was actually reached', paint.length === 6, JSON.stringify(paint.map((s) => s.id)));
  const withBack = paint.filter((s) => s.back !== null);
  ok('and most of them have a back arrow to colour', withBack.length >= 5, String(withBack.length));
  for (const s of withBack) {
    ok('the back button on ' + s.id + ' is yellow', s.back && yellow(s.backBg), s.backBg.slice(0, 60));
  }
  for (const s of paint) {
    if (s.cardBorder !== null) ok('the cards on ' + s.id + ' have a yellow edge', yellow(s.cardBorder), s.cardBorder);
  }
  /* Yellow means «back». A different button in the same bar must not borrow it,
     or the colour stops telling the player anything. */
  const others = paint.filter((s) => s.otherBg);
  ok('and a button that is not «back» does not take the colour', others.length > 0 && others.every((s) => !yellow(s.otherBg)),
     JSON.stringify(others.map((s) => s.id + ':' + s.otherBg.slice(0, 24))));
  /* «این زردها در قسمت دوستانه باید آبی باشه» */
  const free = await page.evaluate(async () => {
    document.querySelector('.phone').classList.add('theme-free');
    (0, eval)("go('rules')");
    await new Promise((r) => setTimeout(r, 400));
    const back = document.querySelector('#rules .topbar .iconbtn');
    const card = document.querySelector('#rules .card');
    return { back: getComputedStyle(back).backgroundImage, card: getComputedStyle(card).borderTopColor };
  });
  const blue = (s) => /115,\s*217,\s*255|185,\s*240,\s*255|21,\s*151,\s*210/.test(s);
  ok('on the friendly side the back button is blue', blue(free.back), free.back.slice(0, 60));
  ok('and so is the edge of the cards', blue(free.card), free.card);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── THE TOPIC CARDS, AND THE BUTTON THAT CHANGES THE TOPIC ──────────────── */
/* «کارت‌های موضوعات دو ستون بشه و اندازه‌اش کوچک بشه، ارتفاع هر کدوم نصفِ این
 * باشه، و هر کارت یه رنگ به‌خصوص داشته باشه.»
 * «دکمهٔ تغییر موضوع سایزش اصلا با صفحه همخوانی نداره، رنگشم سبز بشه یا آبی.»
 *
 * Measured on the narrowest phone the game supports as well as the common one:
 * the old layout dropped to a SINGLE column under 370px, which put the tallest
 * possible cards on the screen with the least room for them. */
for (const width of [390, 360]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    /* Ten topics — as many as the palette has colours, so a scheme that
       collides has nowhere left to hide. */
    if (p === '/questions/maker-topics') return send({ topics:
      ['ورزشی', 'تاریخ', 'علمی', 'سینما و سریال', 'جغرافیا', 'موسیقی', 'ادبیات فارسی', 'فناوری', 'عمومی', 'آشپزی']
        .map((n, i) => ({ name: n, icon: '📚', image: '', questionCount: 10 + i })) });
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  console.log('\nthe topic cards at ' + width + 'px:');

  const shown = await page.evaluate(async () => {
    (0, eval)("go('qstopics')");
    await (0, eval)('qsLoadTopics')(true);
    await new Promise((r) => setTimeout(r, 500));
    const cards = [...document.querySelectorAll('.qs-topic')].filter((c) => c.getBoundingClientRect().height > 0);
    const box = (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left) }; };
    return {
      n: cards.length,
      columns: new Set(cards.map((c) => box(c).l)).size,
      heights: [...new Set(cards.map((c) => box(c).h))],
      colours: cards.map((c) => getComputedStyle(c).getPropertyValue('--tc').trim()),
      /* The count has to survive on the card, not be squeezed off it. */
      countsShown: cards.every((c) => /سؤال/.test(c.textContent || '')),
      namesShown: cards.every((c) => (c.querySelector('b') || {}).textContent),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  });
  ok('all ten topics are drawn', shown.n === 10, String(shown.n));
  ok('in two columns', shown.columns === 2, String(shown.columns) + ' column(s)');
  /* «ارتفاع هر کدوم به نصف این باشه» — the old card ran about 130px. */
  ok('and each card is about half the height it was', shown.heights.every((h) => h > 0 && h <= 70), JSON.stringify(shown.heights));
  ok('every card the same height as its neighbours', shown.heights.length === 1, JSON.stringify(shown.heights));
  ok('the name is still on the card', shown.namesShown === true);
  ok('and so is how many questions it has', shown.countsShown === true);
  /* «هر کارت یه رنگ به‌خصوص داشته باشه» — a repeat on screen reads as a bug,
     not a scheme. Ten topics, ten colours, no two alike. */
  ok('each card has a colour of its own', new Set(shown.colours).size === shown.colours.length,
     new Set(shown.colours).size + ' distinct of ' + shown.colours.length);
  ok('and they are real colours, not blank', shown.colours.every((c) => /^#[0-9a-fA-F]{6}$/.test(c)), JSON.stringify(shown.colours.slice(0, 3)));
  ok('nothing hangs off the side of the screen', shown.overflowX === false, String(shown.overflowX));

  /* The colour must be the same on the next visit and on another phone — a
     colour drawn at random would repaint the whole screen every time. */
  const again = await page.evaluate(async () => {
    await (0, eval)('qsLoadTopics')(true);
    await new Promise((r) => setTimeout(r, 400));
    return [...document.querySelectorAll('.qs-topic')].filter((c) => c.getBoundingClientRect().height > 0)
      .map((c) => getComputedStyle(c).getPropertyValue('--tc').trim());
  });
  ok('and it is the same colour when the list is drawn again', JSON.stringify(again) === JSON.stringify(shown.colours),
     JSON.stringify(again.slice(0, 3)) + ' vs ' + JSON.stringify(shown.colours.slice(0, 3)));

  console.log('\nthe «تغییر موضوع» button at ' + width + 'px:');
  const swap = await page.evaluate(async () => {
    (0, eval)('qsPickCat')('ورزشی');
    await new Promise((r) => setTimeout(r, 500));
    const b = document.querySelector('.qs-swap'), row = document.getElementById('qsChosen');
    if (!b || !row) return null;
    const bb = b.getBoundingClientRect(), rb = row.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { w: Math.round(bb.width), h: Math.round(bb.height), rowH: Math.round(rb.height),
             rowW: Math.round(rb.width), bg: cs.backgroundImage, text: (b.textContent || '').trim(),
             insideTheRow: bb.top >= rb.top - 2 && bb.bottom <= rb.bottom + 2 };
  });
  ok('the button is there', !!swap, JSON.stringify(swap));
  ok('it says what it does', swap.text === 'تغییر موضوع', swap.text);
  /* «سایزش اصلا با صفحه همخوانی نداره» — it has to belong to the row it sits
     in, not tower over it, and not run the width of the screen. */
  ok('it fits inside its own row', swap.insideTheRow === true, JSON.stringify(swap));
  ok('no taller than the row', swap.h <= swap.rowH, swap.h + ' vs row ' + swap.rowH);
  ok('and no wider than half the row', swap.w <= swap.rowW / 2, swap.w + ' vs row ' + swap.rowW);
  ok('but still big enough to hit', swap.h >= 30 && swap.w >= 60, swap.w + '×' + swap.h);
  /* «رنگشم سبز بشه یا آبی» — green. */
  const rgb = (swap.bg.match(/\d+/g) || []).map(Number);
  ok('and it is green, not grey', rgb.length >= 3 && rgb[1] > rgb[0] + 40 && rgb[1] > rgb[2] + 40, swap.bg.slice(0, 60));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
