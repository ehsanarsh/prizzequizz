/* NAZARAT VA PISHNAHADAT — «کامل بشه و به پشتیبانی متصل بشه».
 *
 * It was a page that pushed onto an array and answered «بازخوردت برای تیم
 * محصول ارسال شد». Nothing left the phone, nobody read one, and there was no
 * way to answer. The list even opened with two invented entries attributed to
 * a player who had never written anything.
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

const posted = [];
let tickets = [];

async function makePage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (route.request().method() === 'POST') {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      posted.push({ path: p, body });
      if (p === '/support/tickets') {
        const t = { id: 'tk' + (tickets.length + 1), title: body.title, category: body.category, body: body.body,
                    status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastMessage: body.body };
        tickets = [t].concat(tickets);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, data: t }) });
      }
      return send({});
    }
    if (p === '/support/tickets') return send({ rows: tickets });
    if (/^\/support\/tickets\/[^/]+$/.test(p)) {
      const t = tickets.find((x) => x.id === p.split('/').pop());
      return send({ ticket: t || null, messages: [] });
    }
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true;"));
  return { ctx, page, errs };
}

{
  const { ctx, page, errs } = await makePage();
  console.log('the feedback screen:');
  tickets = []; posted.length = 0;
  await page.evaluate(async () => { (0, eval)("go('feedback')"); await new Promise((r) => setTimeout(r, 700)); });

  /* «موارد ثبت‌شده اخیر» used to open with two entries the player never wrote. */
  const first = await page.evaluate(() => ({
    items: document.querySelectorAll('#feedbackList .feedback-list-item').length,
    text: (document.getElementById('feedbackList') || {}).textContent || ''
  }));
  ok('it does not open with feedback nobody sent', first.items === 0, JSON.stringify(first.items));
  ok('and says so plainly', /هنوز نظری نفرستاده/.test(first.text), first.text.replace(/\s+/g, ' ').trim().slice(0, 60));

  await page.evaluate(async () => {
    document.getElementById('feedbackSubject').value = 'گردونه جذاب‌تر شود';
    document.getElementById('feedbackBody').value = 'جایزه‌ها کمی بیشتر شود.';
    await (0, eval)('submitFeedback')();
    await new Promise((r) => setTimeout(r, 700));
  });
  const sent = posted.find((x) => x.path === '/support/tickets');
  /* THE POINT: it leaves the phone. */
  ok('sending it really posts a support ticket', !!sent, JSON.stringify(posted.map((p) => p.path)));
  ok('with the title and the text', !!sent && sent.body.title === 'گردونه جذاب‌تر شود' && /بیشتر شود/.test(sent.body.body), JSON.stringify(sent && sent.body));
  ok('filed under the kind of feedback it is', !!sent && sent.body.category === 'پیشنهاد', String(sent && sent.body.category));

  const after = await page.evaluate(() => ({
    items: document.querySelectorAll('#feedbackList .feedback-list-item').length,
    subject: document.getElementById('feedbackSubject').value,
    body: document.getElementById('feedbackBody').value,
    modal: (document.getElementById('aaaSub') || {}).textContent || ''
  }));
  ok('the list then shows it, from the server', after.items === 1, String(after.items));
  ok('the form is cleared', !after.subject && !after.body, JSON.stringify(after));
  ok('and the player is told where it went', /پشتیبانی/.test(after.modal), after.modal.trim());

  /* «به پشتیبانی متصل بشه» — tapping one continues the conversation there. */
  const opened = await page.evaluate(async () => {
    (0, eval)('closeAaaModal')(false);
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#feedbackList .feedback-list-item').click();
    await new Promise((r) => setTimeout(r, 700));
    return { screen: [...document.querySelectorAll('.screen')].find((s) => s.classList.contains('active')).id,
             open: (0, eval)('_supOpenId') };
  });
  ok('tapping it opens the conversation in support', opened.screen === 'support', JSON.stringify(opened));
  ok('on that very ticket', opened.open === 'tk1', String(opened.open));

  /* A bug report and a rating are the same road, filed differently. */
  posted.length = 0;
  const kinds = await page.evaluate(async () => {
    (0, eval)("go('feedback')");
    await new Promise((r) => setTimeout(r, 400));
    (0, eval)('feedbackType')('bug');
    document.getElementById('feedbackSubject').value = 'دکمه کار نمی‌کند';
    document.getElementById('feedbackBody').value = 'در صفحهٔ کیف پول.';
    await (0, eval)('submitFeedback')();
    await new Promise((r) => setTimeout(r, 500));
    (0, eval)('closeAaaModal')(false);
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)('feedbackType')('rate');
    (0, eval)('currentRating=4');
    document.getElementById('feedbackSubject').value = '';
    document.getElementById('feedbackBody').value = 'سریع و روان.';
    await (0, eval)('submitFeedback')();
    await new Promise((r) => setTimeout(r, 500));
    return null;
  });
  const cats = posted.filter((x) => x.path === '/support/tickets').map((x) => x.body.category);
  ok('a bug report is filed as one', cats.indexOf('گزارش مشکل') >= 0, cats.join(','));
  ok('and a rating as one', cats.indexOf('امتیازدهی') >= 0, cats.join(','));
  const rate = posted.filter((x) => x.path === '/support/tickets').pop();
  /* A score with no words beside it is not something an operator can act on,
     so the number goes in the body where it will be read. */
  ok('the rating carries the score in the text', !!rate && /۴ از ۵/.test(rate.body.body), JSON.stringify(rate && rate.body));
  ok('and gets a title even when none was typed', !!rate && !!String(rate.body.title || '').trim(), String(rate && rate.body.title));

  /* Nothing is sent for an empty form. */
  posted.length = 0;
  const empty = await page.evaluate(async () => {
    (0, eval)('closeAaaModal')(false);
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)('feedbackType')('idea');
    document.getElementById('feedbackSubject').value = '';
    document.getElementById('feedbackBody').value = '   ';
    await (0, eval)('submitFeedback')();
    await new Promise((r) => setTimeout(r, 400));
    return (document.getElementById('aaaTitle') || {}).textContent || '';
  });
  ok('an empty note is not sent', posted.length === 0, JSON.stringify(posted));
  ok('and the player is told why', /خالی/.test(empty), empty.trim());

  /* A title with nothing under it is the same problem wearing a hat: there is
     no note to read, and the earlier check would pass on the missing title
     alone rather than on the missing text. */
  posted.length = 0;
  const titleOnly = await page.evaluate(async () => {
    (0, eval)('closeAaaModal')(false);
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('feedbackSubject').value = 'یک عنوان دارم';
    document.getElementById('feedbackBody').value = '';
    await (0, eval)('submitFeedback')();
    await new Promise((r) => setTimeout(r, 400));
    return (document.getElementById('aaaTitle') || {}).textContent || '';
  });
  ok('a title with no note behind it is not sent either', posted.length === 0, JSON.stringify(posted));
  ok('and says the text is what is missing', /متن نظر خالیه/.test(titleOnly), titleOnly.trim());

  /* The hand-off into support is a one-time request. Left set, the NEXT visit
     from the menu would reopen a conversation the player did not ask for. */
  const menuVisit = await page.evaluate(async () => {
    (0, eval)('closeAaaModal')(false);
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)("go('feedback')");
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#feedbackList .feedback-list-item').click();   // sets the hand-off
    await new Promise((r) => setTimeout(r, 600));
    const first = (0, eval)('_supOpenId');
    (0, eval)("go('home')");
    await new Promise((r) => setTimeout(r, 300));
    (0, eval)("go('support')");                                            // the ordinary way in
    await new Promise((r) => setTimeout(r, 600));
    return { first, second: (0, eval)('_supOpenId'), tab: (0, eval)('supportActiveTab') };
  });
  ok('the hand-off opens the conversation once', !!menuVisit.first, JSON.stringify(menuVisit));
  ok('and support opens at the top the next time', menuVisit.second === null && menuVisit.tab === 'home', JSON.stringify(menuVisit));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
