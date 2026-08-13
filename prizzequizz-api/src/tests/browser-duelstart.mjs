/* FINDING AN OPPONENT MUST NOT COST A TICKET BY ITSELF.
 *
 * The report: an opponent is found, the player is thrown back home, no match is
 * played, and the entry ticket is gone. The client used to call
 * POST /matches/:id/start the instant a match id arrived — which is what
 * really spends the ticket server-side — and only THEN check whether the
 * opponent had actually joined. When they had not, it went home saying
 * «ورودی برگشت داده شد» with nothing given back.
 *
 * So these checks are about ORDER: what is called, and when.
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
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 500, hearts: 5, wallet: 0 }));
});

/* The server side of the rule: /start is what spends the ticket, and a cancel
   only refunds while the match has NOT started. */
let tickets = 3, started = false;
const calls = [];
await ctx.route('**/v1/**', (route) => {
  const u = new URL(route.request().url()); const p = u.pathname.replace(/^.*\/v1/, '');
  calls.push(route.request().method() + ' ' + p);
  const send = (d, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
  const snap = { matchId: 'm1', modeId: 'duel', phase: started ? 'question' : 'lobby', round: 0, players: [
    { userId: 'me', username: 'ehsan', avatar: '' }, { userId: 'p2', username: 'zahra', avatar: '' }] };

  if (p === '/matchmaking/enqueue') { tickets -= 1; return send({ ok: true, data: { id: 'tk1', status: 'matched', matchId: 'm1' } }); }
  if (/^\/matchmaking\/[^/]+\/cancel$/.test(p)) {
    if (started) return send({ ok: false, error: { code: 'MATCH_ALREADY_STARTED', message: 'مسابقه شروع شده', status: 409 } }, 409);
    tickets += 1;                                    // voided before start → refunded
    return send({ ok: true, data: { status: 'cancelled', cancelled: true } });
  }
  if (/^\/matches\/m1\/start$/.test(p)) { started = true; return send({ ok: true, data: snap }); }
  if (/^\/matches\/m1$/.test(p)) return send({ ok: true, data: snap });
  if (/^\/matches\/m1\/question/.test(p)) {
    const rd = Number(u.searchParams.get('round') || 0);
    return send({ ok: true, data: { id: 'q' + rd, text: 'سوال ' + rd, options: ['الف','ب','ج','د'], correctIndex: rd % 4, category: 'عمومی', difficulty: 'easy' } });
  }
  if (p === '/users/me') return send({ ok: true, data: { id: 'me', username: 'ehsan', coins: 500, hearts: 5, wallet: 0 } });
  return send({ ok: true, data: {} });
});

const errs = [];
const page = await ctx.newPage();
page.on('pageerror', (e) => errs.push(String(e.message || e)));
await page.goto('http://127.0.0.1:' + PORT + '/');
await page.waitForTimeout(5200);

async function stub(present) {
  await page.evaluate((pres) => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; curStake=12500; duelTicket='green';");
    (0, eval)("_pzEntryTicket='green'; _pzEntryPlan='premium'; _pzEntryRefunded=false; _mmt='tk1'; _mmCancelled=false;");
    (0, eval)("pzRt.active=false; pzRt.matchId=null;");
    (0, eval)("pzWsConnect=function(){}; pzConnStart=function(){}; pzWsJoin=function(){}; pzHeartbeat=function(){};");
    (0, eval)("pzWaitOpponentPresent=function(){ return Promise.resolve(" + (pres ? 'true' : 'false') + "); }");
    (0, eval)("showScreen('matchmaking')");
  }, present);
}

console.log('the opponent never joins:');
{
  /* Two in hand and one HELD by the enqueue that produced this match — the
     state the player is really in when _pzMatchFound runs. */
  tickets = 2; started = false; calls.length = 0;
  await stub(false);
  await page.evaluate(() => (0, eval)("_pzMatchFound('m1')"));
  await page.waitForTimeout(1400);

  ok('the match was never started', !calls.some((c) => /POST \/matches\/m1\/start/.test(c)), calls.join(' | '));
  ok('so the entry could still be voided', calls.some((c) => /POST \/matchmaking\/.*\/cancel/.test(c)), calls.join(' | '));
  ok('and the ticket really came back', tickets === 3, String(tickets));
  const t = await page.evaluate(() => document.getElementById('pzToast')?.textContent || '');
  ok('the player is told the ticket came back', /بلیط برگشت/.test(t), t);
  await page.waitForTimeout(900);
  const scr = await page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
  ok('and is sent home', scr === 'home', scr);
}

console.log('the opponent is there:');
{
  tickets = 2; started = false; calls.length = 0;
  await stub(true);
  await page.evaluate(() => (0, eval)("_pzMatchFound('m1')"));
  await page.waitForTimeout(1600);

  ok('the match is read before it is started', calls.indexOf('GET /matches/m1') < calls.indexOf('POST /matches/m1/start'), calls.join(' | '));
  ok('the match IS started', calls.some((c) => c === 'POST /matches/m1/start'), calls.join(' | '));
  ok('nothing is cancelled', !calls.some((c) => /cancel/.test(c)), calls.join(' | '));
  ok('the ticket stays spent — a match was played for it', tickets === 2, String(tickets));
  await page.waitForTimeout(2200);
  const scr = await page.evaluate(() => (document.querySelector('.screen.active') || {}).id);
  ok('and the duel opens', scr === 'duel' || scr === 'duel-vs', scr);
}

console.log('the questions still arrive:');
{
  const q = await page.evaluate(() => Array.isArray(window._pzQs) ? window._pzQs.length : -1);
  ok('the synced set was fetched even though start came later', q >= 5, String(q));
}

console.log('the server refuses to void — the opponent’s client got there first:');
{
  /* The one case where the ticket is genuinely gone: the match had already
     been started by the other side, so there is nothing to give back. The
     player must not be told otherwise — that is how a real complaint («گفت
     برگشت داده شد ولی نداد») is produced. */
  tickets = 2; started = true; calls.length = 0;
  await stub(false);
  await page.evaluate(() => (0, eval)("_pzMatchFound('m1')"));
  await page.waitForTimeout(1400);

  ok('it still asks the server to void', calls.some((c) => /cancel/.test(c)), calls.filter((c) => /cancel|start/.test(c)).join(' | '));
  ok('the ticket is not conjured back', tickets === 2, String(tickets));
  const t = await page.evaluate(() => document.getElementById('pzToast')?.textContent || '');
  ok('and the player is NOT told it came back', !/برگشت/.test(t), t);
  ok('but is still told what happened', /حریف/.test(t), t);
  await page.waitForTimeout(900);
}

console.log('the search is cancellable after an instant pairing:');
{
  /* The immediate-match branch used to return before recording the queue
     ticket, so there was no id to address a refund to. */
  tickets = 3; started = false; calls.length = 0;
  await page.evaluate(() => {
    (0, eval)("_mmt=null; _mmCancelled=false;");
    (0, eval)("pzRt.active=false; pzRt.matchId=null;");
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; duelTicket='green';");
    (0, eval)("showScreen('matchmaking')");
    (0, eval)("_pzMatchFound=function(){ window.__found=1; }");
  });
  await page.evaluate(() => (0, eval)("startMatchmaking()"));
  await page.waitForTimeout(900);
  const mmt = await page.evaluate(() => (0, eval)('_mmt'));
  ok('the queue ticket is recorded', !!mmt, String(mmt));
}

ok('no script errors through any of it', errs.length === 0, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
