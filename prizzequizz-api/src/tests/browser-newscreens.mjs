/* THE THREE NEW PLAYER-FACING PIECES, DRIVEN IN A REAL BROWSER.
 *
 *   افراد آنلاین — the list, and the refresh that costs coins.
 *   جنسیت        — asked at sign-up, editable in the profile.
 *   کوییزساز     — the question must LEAVE the phone.
 *
 * Every one of these was, until now, either absent or a message with nothing
 * behind it. So the checks are about the request actually happening: the network
 * calls are recorded and asserted on, not just the pixels.
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
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', gender: 'male', level: 3, xp: 120, wallet: 0, coins: 360, hearts: 5, weeklyScore: 92 }));
});

/* The fake server. It records what it was asked for — that is the point. */
const seen = [];
let onlineCall = 0;
let submitted = null;
let patched = null;
await ctx.route('**/v1/**', (route) => {
  const u = new URL(route.request().url());
  const p = u.pathname.replace(/^.*\/v1/, '') + (u.search || '');
  seen.push(route.request().method() + ' ' + p);
  const send = (d, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });

  if (p.startsWith('/users/online')) {
    const refresh = /refresh=1/.test(p);
    onlineCall++;
    if (refresh && onlineCall > 2) return send({ ok: false, error: { code: 'INSUFFICIENT_COINS', message: 'برای رفرش ۵ سکه لازم است.', status: 402 } }, 402);
    return send({
      players: Array.from({ length: refresh ? 3 : 2 }, (_, i) => ({
        userId: 'p' + onlineCall + i, username: 'p' + i, displayName: 'بازیکن ' + (refresh ? 'ب' : 'الف') + i,
        gender: i % 2 ? 'female' : 'male', level: 5, avatar: null, lastSeen: new Date().toISOString()
      })),
      charged: refresh ? 5 : 0, coins: refresh ? 355 : 360,
      nextCost: refresh ? 5 : 0, freeLeft: refresh ? 0 : 1, onlineTotal: 47
    });
  }
  if (p === '/questions/submit') { submitted = route.request().postDataJSON(); return send({ questionId: 'q-new', status: 'pending' }, 201); }
  if (p.startsWith('/questions/mine')) return send({ rows: [
    { questionId: 'q1', text: 'پایتخت فرانسه کدام است؟', status: 'approved', reward: { type: 'coins', amount: 120, label: 'سکه', icon: '🪙' } },
    { questionId: 'q2', text: 'بلندترین کوه ایران؟', status: 'pending', reward: null }
  ] });
  if (route.request().method() === 'PATCH' && p === '/users/me') {
    patched = route.request().postDataJSON();
    return send({ ok: true, data: { id: 'u1', username: 'ehsan', displayName: 'احسان', gender: patched.gender ?? null, level: 3, xp: 120 } });
  }
  if (p === '/leaderboards/weekly-winnings' || p === '/leaderboards/weekly') return send({ ok: true, data: { entries: [] } });
  return send({ ok: true, data: {} });
});

const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.evaluate(() => { try { (0, eval)("go('home')"); } catch (e) {} });
await page.waitForTimeout(600);

/* ── افراد آنلاین ──────────────────────────────────────────────────── */
console.log('online players:');
{
  seen.length = 0;
  await page.evaluate(() => (0, eval)('hmOnline()'));
  await page.waitForTimeout(500);
  const shown = await page.evaluate(() => document.getElementById('online')?.classList.contains('active'));
  ok('the rail icon opens a real screen, not a toast', !!shown);
  ok('and it asks the server who is here', seen.some((s) => s.startsWith('GET /users/online')), seen.join(' | '));
  ok('the first look does NOT ask for a paid refresh', !seen.some((s) => /refresh=1/.test(s)), seen.join(' | '));

  const cards = await page.evaluate(() => document.querySelectorAll('#onList .online-card').length);
  ok('the people the server sent are on screen', cards === 2, String(cards));
  const total = await page.evaluate(() => document.getElementById('onCount')?.textContent || '');
  ok('the real online total is shown', /۴۷/.test(total), total);
  const names = await page.evaluate(() => [...document.querySelectorAll('#onList .nm')].map((e) => e.textContent).join(','));
  ok('with the names the server gave, not placeholders', /بازیکن الف0/.test(names), names);
}

console.log('the paid refresh:');
{
  seen.length = 0;
  await page.evaluate(() => (0, eval)('onlineRefresh()'));
  await page.waitForTimeout(500);
  ok('pressing refresh asks for a refresh', seen.some((s) => /users\/online\?refresh=1/.test(s)), seen.join(' | '));
  const names = await page.evaluate(() => [...document.querySelectorAll('#onList .nm')].map((e) => e.textContent).join(','));
  ok('and the faces actually change', /بازیکن ب0/.test(names), names);
  const btn = await page.evaluate(() => document.getElementById('onRefresh')?.textContent || '');
  ok('the button then states the price before it is pressed', /۵/.test(btn) && /سکه/.test(btn), btn);
}

console.log('when the coins run out:');
{
  seen.length = 0;
  await page.evaluate(() => (0, eval)('onlineRefresh()'));   // 402 from the fake server
  await page.waitForTimeout(500);
  const cards = await page.evaluate(() => document.querySelectorAll('#onList .online-card').length);
  ok('the list already on screen is not wiped out', cards === 3, String(cards));
  const t = await page.evaluate(() => document.getElementById('pzToast')?.textContent || '');
  ok('and the player is told why', /سکه/.test(t), t);
  const disabled = await page.evaluate(() => !!document.getElementById('onRefresh')?.disabled);
  ok('the button is usable again afterwards', !disabled);
}

/* ── جنسیت ─────────────────────────────────────────────────────────── */
console.log('gender:');
{
  ok('sign-up asks the question', await page.evaluate(() => !!document.getElementById('regGender')));
  ok('and so does the profile', await page.evaluate(() => !!document.getElementById('profGender')));
  const preset = await page.evaluate(() => document.querySelectorAll('#regGender .gender-opt.on').length);
  ok('nothing is preselected — a default would record a guess', preset === 0, String(preset));

  await page.evaluate(() => (0, eval)("pickGender('regGender','female')"));
  const onNow = await page.evaluate(() => [...document.querySelectorAll('#regGender .gender-opt.on')].map((e) => e.dataset.g).join(','));
  ok('choosing one marks exactly that one', onNow === 'female', onNow);

  patched = null;
  await page.evaluate(() => {
    document.getElementById('regFullName').value = 'احسان تست';
    document.getElementById('regUsername').value = 'ehsantest';
    (0, eval)('submitRegister()');
  });
  await page.waitForTimeout(500);
  ok('and it is sent with the rest of the sign-up', patched && patched.gender === 'female', JSON.stringify(patched));

  /* Editing the profile sends the change too. */
  await page.evaluate(() => { (0, eval)("go('profileEdit')"); });
  await page.waitForTimeout(200);
  patched = null;
  await page.evaluate(() => {
    (0, eval)("showGender('profGender','')");
    (0, eval)("pickGender('profGender','male')");
    (0, eval)('submitProfileEdit()');
  });
  await page.waitForTimeout(400);
  ok('a change in the profile reaches the server', patched && patched.gender === 'male', JSON.stringify(patched));
}

/* ── کوییزساز ──────────────────────────────────────────────────────── */
console.log('quiz maker:');
{
  submitted = null;
  await page.evaluate(() => (0, eval)('hmQuizMaker()'));
  await page.waitForTimeout(400);
  const mine = await page.evaluate(() => document.querySelectorAll('#qsMine .qs-mine-row').length);
  ok('opening it shows the questions already written', mine === 2, String(mine));
  const prize = await page.evaluate(() => document.querySelector('#qsMine .qs-prize')?.textContent || '');
  ok('with what the approved one actually paid', /۱۲۰/.test(prize), prize);

  await page.evaluate(() => {
    document.getElementById('qsText').value = 'پایتخت ژاپن کدام است؟';
    document.getElementById('qsCorrect').value = 'توکیو';
    document.getElementById('qsWrong').value = 'اوساکا / کیوتو / ناگویا';
    (0, eval)('submitQuestion()');
  });
  await page.waitForTimeout(600);
  ok('the question leaves the phone', !!submitted, JSON.stringify(submitted));
  ok('with four options', submitted && submitted.options?.length === 4, JSON.stringify(submitted?.options));
  ok('and the right one marked correct',
    submitted && submitted.options[submitted.correctIndex] === 'توکیو', String(submitted?.correctIndex));
  ok('the difficulty is sent in the form the server stores',
    submitted && ['easy', 'medium', 'hard'].includes(submitted.difficulty), String(submitted?.difficulty));
}

console.log('an incomplete question:');
{
  submitted = null;
  await page.evaluate(() => {
    (0, eval)('closeAaaModal(false)');
    document.getElementById('qsText').value = 'فقط متن';
    document.getElementById('qsCorrect').value = '';
    document.getElementById('qsWrong').value = '';
    (0, eval)('submitQuestion()');
  });
  await page.waitForTimeout(400);
  ok('is not sent at all', submitted === null);
}

ok('no script errors on the new screens', errs.length === 0, errs.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
