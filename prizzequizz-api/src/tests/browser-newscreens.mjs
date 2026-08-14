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
let friendReq = null;
let firstFaces = '';
let doorsOpen = false;
let recordCalls = 0;
let cutlineCalls = 0;
let joined = 0; const answered = []; const picked = [];
let roomPhase = 'turn', roomMine = true;
function wtaSnap(phase, mine) {
  return {
    id: 'lr1', phase, turnUserId: mine ? 'me' : 'p2', endsAt: Date.now() + 15000, serverNow: Date.now(),
    aliveCount: 4, winnerUserId: phase === 'finished' ? 'me' : null,
    players: [
      { userId: 'me', username: 'ehsan', lives: 3, out: false, absent: false },
      { userId: 'p2', username: 'زهرا', lives: 2, out: false, absent: false },
      { userId: 'p3', username: 'رضا', lives: 3, out: false, absent: false },
      { userId: 'p4', username: 'سینا', lives: 1, out: false, absent: false }
    ],
    question: phase === 'turn' ? { id: 'q1', text: 'پایتخت ژاپن؟', options: ['توکیو', 'اوساکا', 'کیوتو', 'ناگویا'], category: 'جغرافیا', difficulty: 'easy' } : undefined,
    me: { userId: 'me', lives: 3, out: false, absent: false, myTurn: mine }
  };
}
await ctx.route('**/v1/**', (route) => {
  const u = new URL(route.request().url());
  const p = u.pathname.replace(/^.*\/v1/, '') + (u.search || '');
  seen.push(route.request().method() + ' ' + p);
  const send = (d, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(d) });

  if (p.startsWith('/users/online')) {
    const refresh = /refresh=1/.test(p);
    onlineCall++;
    if (refresh && onlineCall > 2) return send({ ok: false, error: { code: 'INSUFFICIENT_COINS', message: 'برای رفرش ۵ سکه لازم است.', status: 402 } }, 402);
    return send({ ok: true, data: {
      players: Array.from({ length: refresh ? 3 : 2 }, (_, i) => ({
        userId: 'p' + onlineCall + i, username: 'p' + onlineCall + i, displayName: 'بازیکن ' + (refresh ? 'ب' : 'الف') + i,
        gender: i % 2 ? 'female' : 'male', level: 5, avatar: null, lastSeen: new Date().toISOString()
      })),
      charged: refresh ? 5 : 0, coins: refresh ? 355 : 360,
      nextCost: refresh ? 5 : 0, freeLeft: refresh ? 0 : 1, onlineTotal: 47
    } });
  }
  if (p === '/leagues/me') {
    return send({ ok: true, data: {
      enabled: true, seasonId: '2026-W07', rank: 4, cup: 980,
      tier: { key: 'gold', label: 'لیگ طلایی', emoji: '🥇' },
      qualifiedTier: 'gold', tickets: { gold: 1 },
      cutLines: [
        { key: 'gold', label: 'لیگ طلایی', emoji: '🥇', rank: 15, cup: 1240, exact: true },
        { key: 'silver', label: 'لیگ نقره‌ای', emoji: '🥈', rank: 30, cup: 860, exact: true },
        { key: 'bronze', label: 'لیگ برنزی', emoji: '🥉', rank: 45, cup: 410, exact: false }
      ],
      kickoffAt: Date.now() + 3600_000,
      doorsOpenAt: doorsOpen ? Date.now() - 60_000 : Date.now() + 3000_000,
      roomSize: 15,
      tiers: [
        { key: 'gold', label: 'لیگ طلایی', emoji: '🥇', fromRank: 1, toRank: 15, participationPrize: 50000, winnerPrize: 500000, prizeType: 'cash' },
        { key: 'silver', label: 'لیگ نقره‌ای', emoji: '🥈', fromRank: 16, toRank: 30, participationPrize: 25000, winnerPrize: 250000, prizeType: 'cash' },
        { key: 'bronze', label: 'لیگ برنزی', emoji: '🥉', fromRank: 31, toRank: 45, participationPrize: 10000, winnerPrize: 100000, prizeType: 'cash' }
      ],
      room: { id: 'lr1', tier: 'gold', round: 1, roomNo: 1, startsAt: Date.now() + 3600_000, seats: 4 }
    } });
  }
  if (/^\/leagues\/rooms\/[^/]+\/join$/.test(p)) { joined++; return send({ ok: true, data: wtaSnap('turn', true) }); }
  if (/^\/leagues\/rooms\/[^/]+\/answer$/.test(p)) {
    answered.push(route.request().postDataJSON());
    /* The server's state really does move to «picking» after a right answer,
       so the fake one must too — otherwise the poll a second later drags the
       screen back and the test passes or fails for the wrong reason. */
    roomPhase = 'picking'; roomMine = true;
    return send({ ok: true, data: { correct: true, correctIndex: 0, picking: true, eliminated: false, livesLeft: 3, room: wtaSnap('picking', true) } });
  }
  if (/^\/leagues\/rooms\/[^/]+\/pick$/.test(p)) {
    picked.push(route.request().postDataJSON());
    roomPhase = 'turn'; roomMine = false;
    return send({ ok: true, data: wtaSnap('turn', false) });
  }
  if (/^\/leagues\/rooms\/[^/]+$/.test(p)) return send({ ok: true, data: wtaSnap(roomPhase, roomMine) });
  if (p.startsWith('/leagues/cutlines')) {
    cutlineCalls++;
    return send({ ok: true, data: { season: '2026-W07', lines: [
      { key: 'gold',   label: 'لیگ طلایی',  emoji: '🥇', rank: 15, cup: 1240, exact: true },
      { key: 'silver', label: 'لیگ نقره‌ای', emoji: '🥈', rank: 30, cup: 860,  exact: true },
      { key: 'bronze', label: 'لیگ برنزی',  emoji: '🥉', rank: 45, cup: 410,  exact: false }
    ] } });
  }
  if (p.startsWith('/record/overview')) {
    recordCalls++;
    return send({ ok: true, data: { enabled: true, friendlyOnly: true, hearts: 3, questionSeconds: 33,
      global: { best: 12, worldBest: 40 },
      categories: [{ name: 'فوتبال', best: 7, worldBest: 21 }, { name: 'تاریخ', best: 3, worldBest: 15 }] } });
  }
  if (p.startsWith('/record/leaderboard')) {
    return send({ ok: true, data: { rows: [
      { userId: 'me', username: 'ehsan', score: 12, rank: 1 },
      { userId: 'z', username: 'زهرا', score: 9, rank: 2 }
    ] } });
  }
  if (p === '/friends/requests') { friendReq = route.request().postDataJSON(); return send({ ok: true, data: { status: 'pending' } }, 201); }
  /* The signed-in player. Without this the catch-all answers with {} and the
     client ends up with a user that has no id — which quietly breaks anything
     that compares "is this me". */
  if (p === '/users/me' && route.request().method() === 'GET') {
    return send({ ok: true, data: { id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, xp: 120, weeklyScore: 980, balances: { wallet: 0, coins: 360, hearts: 5, tickets: {} } } });
  }
  if (/^\/users\/[^/]+\/profile/.test(p)) {
    /* Answer about the player who was actually asked for — a fixed name here
       would make a mismatched profile look correct. */
    const who = p.split('/')[2];
    return send({ ok: true, data: { id: who, username: who, level: 5, matches: 12, wins: 7, balances: {} } });
  }
  if (p === '/questions/submit') { submitted = route.request().postDataJSON(); return send({ ok: true, data: { questionId: 'q-new', status: 'pending' } }, 201); }
  if (p.startsWith('/questions/mine')) return send({ ok: true, data: { rows: [
    { questionId: 'q1', text: 'پایتخت فرانسه کدام است؟', status: 'approved', reward: { type: 'coins', amount: 120, label: 'سکه', icon: '🪙' } },
    { questionId: 'q2', text: 'بلندترین کوه ایران؟', status: 'pending', reward: null }
  ] } });
  if (route.request().method() === 'PATCH' && p === '/users/me') {
    patched = route.request().postDataJSON();
    return send({ ok: true, data: { id: 'me', username: 'ehsan', displayName: 'احسان', gender: patched.gender ?? null, level: 3, xp: 120 } });
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
  ok('with the names the server gave, not placeholders', /^p\d+,p\d+$/.test(names), names);
  firstFaces = names;
}

console.log('the paid refresh:');
{
  seen.length = 0;
  await page.evaluate(() => (0, eval)('onlineRefresh()'));
  await page.waitForTimeout(500);
  ok('pressing refresh asks for a refresh', seen.some((s) => /users\/online\?refresh=1/.test(s)), seen.join(' | '));
  const names = await page.evaluate(() => [...document.querySelectorAll('#onList .nm')].map((e) => e.textContent).join(','));
  ok('and the faces actually change', names.split(',').length === 3 && names !== firstFaces, names + ' (was ' + firstFaces + ')');
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
  const el = await page.evaluate(() => {
    const e = document.getElementById('regGender');
    return e ? { tag: e.tagName, opts: [...e.options].map((o) => o.value + ':' + o.textContent) } : null;
  });
  ok('sign-up asks with a dropdown, not a row of buttons', el && el.tag === 'SELECT', JSON.stringify(el));
  ok('and offers exactly آقا and خانم', el && el.opts.length === 3 && /male:آقا/.test(el.opts[1]) && /female:خانم/.test(el.opts[2]), JSON.stringify(el?.opts));
  ok('with nothing preselected — a default would record a guess', await page.evaluate(() => document.getElementById('regGender').value) === '');

  /* Sign-up must not go through without it. */
  patched = null;
  await page.evaluate(() => {
    document.getElementById('regFullName').value = 'احسان تست';
    document.getElementById('regUsername').value = 'ehsantest';
    document.getElementById('regGender').value = '';
    (0, eval)('submitRegister()');
  });
  await page.waitForTimeout(400);
  ok('registering without answering is refused', patched === null, JSON.stringify(patched));
  const errShown = await page.evaluate(() => document.getElementById('errGender')?.classList.contains('show'));
  ok('and it says which field is missing', !!errShown);

  patched = null;
  await page.evaluate(() => {
    document.getElementById('regGender').value = 'female';
    (0, eval)('submitRegister()');
  });
  await page.waitForTimeout(500);
  ok('answering it lets sign-up through, with the answer attached', patched && patched.gender === 'female', JSON.stringify(patched));

  /* Once answered, the profile SHOWS it — it does not offer the question again. */
  await page.evaluate(() => { (0, eval)('_usr').gender = 'female'; (0, eval)("go('profileEdit')"); (0, eval)('renderProfileGender()'); });
  await page.waitForTimeout(250);
  const slot = await page.evaluate(() => ({
    text: document.getElementById('profGenderSlot')?.textContent || '',
    picker: !!document.getElementById('profGender')
  }));
  ok('the profile states the chosen gender', /خانم/.test(slot.text), slot.text);
  ok('and does not ask again', slot.picker === false);

  /* An older account that never answered still gets the chance to. */
  await page.evaluate(() => { (0, eval)('_usr').gender = null; (0, eval)('renderProfileGender()'); });
  await page.waitForTimeout(200);
  const old = await page.evaluate(() => {
    const e = document.getElementById('profGender');
    return e ? e.tagName : 'missing';
  });
  ok('an account from before the question can still answer it', old === 'SELECT', old);

  patched = null;
  await page.evaluate(() => {
    document.getElementById('profGender').value = 'male';
    (0, eval)('submitProfileEdit()');
  });
  await page.waitForTimeout(400);
  ok('and that answer reaches the server', patched && patched.gender === 'male', JSON.stringify(patched));
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


/* ── the friendly plan ─────────────────────────────────────────────── */
async function setPlan(plan) {
  await page.evaluate((pl) => {
    (0, eval)('userPlan = ' + JSON.stringify(pl));
    (0, eval)('planExplicitlyChosen = true');
    (0, eval)('applyPlanTheme()');
    (0, eval)("go('home')");
  }, plan);
  await page.waitForTimeout(500);
}
const deck = () => page.evaluate(() => (0, eval)('hmModes()').map((m) => m.key));

/* What the eye actually gets off the mode carousel: the frame colour of the
   card you are on, the shadow behind it, and the halo pseudo-element. Read as
   computed values so a class name alone can never make these pass. */
const rgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
const cardSkin = () =>
  page.evaluate(() => {
    const el = document.querySelector('#mtrack .mcard.cur');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      border: cs.borderTopColor,
      shadow: cs.boxShadow,
      halo: getComputedStyle(el, '::after').boxShadow,
      plain: getComputedStyle(document.querySelector('.card')).borderTopColor,
    };
  });
let freeSkin = null;

console.log('the friendly plan:');
{
  await setPlan('free');
  const d = await deck();
  ok('carries only the friendly duel and record mode', JSON.stringify(d) === '["duel","record"]', JSON.stringify(d));
  const dots = await page.evaluate(() => document.querySelectorAll('#mdots i').length);
  ok('and the carousel really shows two, not four', dots === 2, String(dots));
  const cards = await page.evaluate(() => [...document.querySelectorAll('#mtrack .mcard h2')].map((e) => e.textContent));
  ok('no prize ladder is on screen to be refused later', !cards.some((c) => /بازمانده|همه یا هیچ|لیگ/.test(c)), JSON.stringify(cards));

  const chip = await page.evaluate(() => {
    const e = document.getElementById('hdrPlan');
    return e ? { shown: getComputedStyle(e).display !== 'none', text: e.textContent } : null;
  });
  ok('the header says plainly that this is the free plan', chip && chip.shown && /رایگان/.test(chip.text), JSON.stringify(chip));

  const blue = await page.evaluate(() => document.querySelector('.phone')?.classList.contains('theme-free'));
  ok('and the theme is the blue one', !!blue);
  const bolt = await page.evaluate(() => getComputedStyle(document.querySelector('.phone')).getPropertyValue('--bolt').trim());
  ok('the accent colour really changed, not just a class', /73D9FF/i.test(bolt), bolt);

  freeSkin = await cardSkin();
  const [r, g, b] = rgb(freeSkin.border);
  ok('the friendly deck keeps its blue frame', b > r && b > g, freeSkin.border);
  ok('and no gold halo is bolted onto it', !/255,\s*210/.test(freeSkin.halo || 'none'), String(freeSkin.halo).slice(0, 60));
}

console.log('«افراد آنلاین» in the friendly plan:');
{
  await page.evaluate(() => { try { (0, eval)('closeAaaModal(false)'); } catch (e) {} });
  seen.length = 0;
  await page.evaluate(() => (0, eval)('hmOnline()'));
  await page.waitForTimeout(400);
  const txt = await page.evaluate(() => document.getElementById('aaaSub')?.textContent || '');
  ok('says it belongs to the main competition', /رقابت اصلی/.test(txt), txt.slice(0, 80));
  const opened = await page.evaluate(() => document.getElementById('online')?.classList.contains('active'));
  ok('and does not open the screen anyway', !opened);
  ok('nor ask the server for a list it will not show', !seen.some((x) => /users\/online/.test(x)), seen.join(' | '));
}

console.log('back in the main plan:');
{
  await page.evaluate(() => { try { (0, eval)('closeAaaModal(false)'); } catch (e) {} });
  await setPlan('premium');
  const d = await deck();
  ok('all four modes are back', d.length >= 4 && d.includes('ls') && d.includes('league'), JSON.stringify(d));
  const chip = await page.evaluate(() => getComputedStyle(document.getElementById('hdrPlan')).display);
  ok('and the free-plan chip is gone', chip === 'none', chip);

  const skin = await cardSkin();
  const [r, g, b] = rgb(skin.border);
  ok('the prize deck is framed in yellow', r > 200 && g > 150 && b < 100, skin.border);
  ok('which is not the frame the friendly deck wears', skin.border !== freeSkin.border, skin.border + ' vs ' + freeSkin.border);
  ok('the drop shadow is gold too, not the flat black one', /255,\s*210/.test(skin.shadow), skin.shadow.slice(0, 90));
  ok('and the card you are on carries a halo', /255,\s*210/.test(skin.halo || ''), String(skin.halo).slice(0, 70));
  const [pr, pg, pb] = rgb(skin.plain);
  ok('while an ordinary card is left alone, so the deck stands apart', !(pr > 200 && pg > 150 && pb < 100), skin.plain);

  seen.length = 0;
  await page.evaluate(() => (0, eval)('hmOnline()'));
  await page.waitForTimeout(500);
  ok('the online list opens normally here', await page.evaluate(() => document.getElementById('online')?.classList.contains('active')));
  ok('and asks the server', seen.some((x) => /users\/online/.test(x)), seen.join(' | '));
}

console.log('a face on the online list:');
{
  const cards = await page.evaluate(() => document.querySelectorAll('#onList .online-card').length);
  ok('the list is drawn', cards > 0, String(cards));

  await page.evaluate(() => document.querySelector('#onList .online-card').click());
  await page.waitForTimeout(400);
  const modal = await page.evaluate(() => document.getElementById('aaaModal')?.textContent || '');
  const shownName = await page.evaluate(() => document.getElementById('aaaTitle')?.textContent || '');
  const listName = await page.evaluate(() => document.querySelector('#onList .nm')?.textContent || '');
  ok('tapping one opens THAT player’s profile', shownName && shownName === listName, shownName + ' vs ' + listName);
  ok('with a way to send a friend request', /درخواست دوستی/.test(modal), modal.slice(0, 200));

  await page.evaluate(() => { try { (0, eval)('closeAaaModal(false)'); } catch (e) {} });
  await page.waitForTimeout(200);
  friendReq = null;
  await page.evaluate(() => document.querySelector('#onList .online-add').click());
  await page.waitForTimeout(500);
  ok('and the card itself can send one', friendReq && !!friendReq.userId, JSON.stringify(friendReq));
  const t = await page.evaluate(() => document.getElementById('pzToast')?.textContent || '');
  ok('with the player told it went', /دوست/.test(t), t);
}


/* ── ثبت رکورد ─────────────────────────────────────────────────────── */
console.log('record mode:');
{
  /* The screen used to be opened by a tile the home rebuild deleted, and that
     tile was the only thing that ever loaded it. Every other way in is a bare
     go('record'), so the screen sat on «در حال بارگذاری…» with no topics and
     no records — which is exactly what was reported. */
  await setPlan('free');
  recordCalls = 0;
  await page.evaluate(() => (0, eval)("go('record')"));
  await page.waitForTimeout(600);
  ok('opening it asks the server for the overview', recordCalls >= 1, String(recordCalls));

  const cats = await page.evaluate(() => [...document.querySelectorAll('#rmCats .rm-c-txt b')].map((e) => e.textContent));
  ok('the topics are on screen, not a skeleton', cats.length === 2 && /فوتبال/.test(cats.join(',')), JSON.stringify(cats));
  const stillLoading = await page.evaluate(() => /در حال بارگذاری/.test(document.getElementById('rmCats')?.textContent || ''));
  ok('and «در حال بارگذاری» is gone', !stillLoading);

  const best = await page.evaluate(() => document.getElementById('rmGlobalBest')?.textContent || '');
  ok('the player’s own record is shown', /۱۲/.test(best), best);
  const mineInCat = await page.evaluate(() => document.querySelector('#rmCats .rm-c-best b')?.textContent || '');
  ok('and their record in each topic', /۷/.test(mineInCat), mineInCat);

  /* Reaching it from the friendly carousel, the way a player actually would. */
  await setPlan('free');
  recordCalls = 0;
  await page.evaluate(() => {
    const i = (0, eval)('hmModes()').findIndex((m) => m.key === 'record');
    (0, eval)('hmSet')(i, 1);
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => (0, eval)('hmStart()'));
  await page.waitForTimeout(700);
  ok('the card on the home carousel opens a LOADED screen', recordCalls >= 1, String(recordCalls));
  const onScreen = await page.evaluate(() => document.getElementById('record')?.classList.contains('active'));
  ok('and it really is the record screen', !!onScreen);

  /* The board of previous records. */
  await page.evaluate(() => (0, eval)("rmOpenBoard('global','')"));
  await page.waitForTimeout(600);
  const rows = await page.evaluate(() => document.querySelectorAll('#rmBoardRows .rm-skel').length === 0
    ? document.getElementById('rmBoardRows').children.length : 0);
  ok('the previous records are listed', rows >= 2, String(rows));
}


console.log('the record card and the end-of-run modal:');
{
  /* The list was a wall of near-black blocks. Contrast is the point, so the
     check is on the rendered colours, not on whether a class is present. */
  const look = await page.evaluate(() => {
    const c = document.querySelector('#rmCats .rm-card');
    if (!c) return null;
    const cs = getComputedStyle(c);
    const lum = (rgb) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
      if (!m) return null;
      return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
    };
    const best = c.querySelector('.rm-c-best b');
    return { bg: cs.backgroundImage, text: lum(cs.color), bestText: best ? lum(getComputedStyle(best).color) : null };
  });
  ok('a topic card is drawn', !!look);
  const bgLight = /hsl\(|rgb\(/.test(look.bg) && !/#1B1630/i.test(look.bg);
  ok('its background is a light tint, not a near-black shade', bgLight, look.bg.slice(0, 90));
  ok('and the writing on it is dark, so it can be read', look.text !== null && look.text < 0.4, String(look.text));
  ok('including the record number, which used to be the yellow accent', look.bestText !== null && look.bestText < 0.4, String(look.bestText));

  /* The end-of-run card had «دوباره» and «جدول رکورد» and no way out. */
  await page.evaluate(() => {
    (0, eval)('rmFinish')({ score: 14, correct: 14, wrong: 3, durationMs: 95000, isPersonalBest: true,
                            mode: 'category', category: 'فوتبال', previousBest: 9, rank: 2, totalPlayers: 40 });
  });
  await page.waitForTimeout(1800);
  const exit = await page.evaluate(() => {
    const e = document.getElementById('aaaTertiary');
    return e ? { shown: getComputedStyle(e).display !== 'none', text: e.textContent } : null;
  });
  ok('the result card offers a way out', exit && exit.shown && /خروج/.test(exit.text), JSON.stringify(exit));
  await page.evaluate(() => document.getElementById('aaaTertiary').click());
  await page.waitForTimeout(500);
  ok('and pressing it leaves the mode', await page.evaluate(() => document.getElementById('home')?.classList.contains('active')));
  const open = await page.evaluate(() => {
    const m = document.getElementById('aaaModal');
    return !!m && getComputedStyle(m).display !== 'none' && m.classList.contains('show');
  });
  ok('with the card closed behind it', !open);
}


console.log('the league cut lines on the cup rail:');
{
  /* The badges used to be fixed thresholds, which told a player nothing about
     whether they would actually get in. They are ranks now, so the number has
     to come from the server and change with the board. */
  await setPlan('premium');
  cutlineCalls = 0;
  await page.evaluate(() => (0, eval)("go('home')"));
  await page.waitForTimeout(700);
  ok('home asks the server where the cut lines are', cutlineCalls >= 1, String(cutlineCalls));

  /* The badges stand ON the bar now, so their old two-line captions are gone
     and the cut line travels with the sentence written inside the tube — for
     the line actually being chased, which is the only one a player can act on.
     What must NOT be lost is that the number is a rank read off the live board,
     not a fixed threshold. */
  const say = (score) => page.evaluate((v) => {
    (0, eval)('weeklyScore=' + v); (0, eval)('renderWeeklyProgress()');
    return document.getElementById('wpInside').textContent;
  }, score);

  const toSilver = await say(600);        // past bronze, chasing silver (rank 30 @ 860)
  ok('the sentence quotes the cup of the rank being chased, not a fixed number',
    /۲۶۰/.test(toSilver) && !/۹۴۰/.test(toSilver), toSilver);
  ok('and says which rank that is', /۳۰/.test(toSilver), toSilver);

  const toGold = await say(900);          // past silver, chasing gold (rank 15 @ 1,240)
  ok('the next line up is rank 15’s', /۳۴۰/.test(toGold) && !/۱۶۸۰/.test(toGold), toGold);
  ok('named as such', /۱۵/.test(toGold), toGold);

  const toBronze = await say(0);
  ok('a cut line the board has not reached is marked as approximate', /~/.test(toBronze), toBronze);

  /* The badge lights when the player is past the line — using the REAL line. */
  const lit = await page.evaluate(() => {
    (0, eval)('weeklyScore = 900');
    (0, eval)('renderWeeklyProgress()');
    return {
      bronze: document.getElementById('wpBronze')?.classList.contains('done'),
      silver: document.getElementById('wpSilver')?.classList.contains('done'),
      gold: document.getElementById('wpGold')?.classList.contains('done')
    };
  });
  ok('900 cup is past bronze and silver but not gold', lit.bronze && lit.silver && !lit.gold, JSON.stringify(lit));
}


console.log('the league card on the home carousel:');
{
  /* Two separate switches said «بزودی»: the card's own flag and a gate at the
     bottom of the file that replaced openLeagues entirely. Removing one left
     the other, and the one the player actually sees is the card. */
  await setPlan('premium');
  await page.evaluate(() => {
    const M = (0, eval)('hmModes)'.slice(0, -1) + '()');
    const i = M.findIndex((m) => m.key === 'league');
    (0, eval)('hmSet')(i, 1);
  });
  await page.waitForTimeout(800);
  const card = await page.evaluate(() => ({
    title: document.querySelector('#mcard h2')?.textContent || '',
    btn: document.querySelector('#mcard .mk-start')?.textContent || '',
    soon: !!document.querySelector('#mcard .mk-start.soon')
  }));
  ok('the league card is the one on screen', /لیگ/.test(card.title), card.title);
  ok('its button no longer says «بزودی»', !card.soon && !/بزودی/.test(card.btn), JSON.stringify(card));

  await page.evaluate(() => (0, eval)('hmStart()'));
  await page.waitForTimeout(800);
  ok('and pressing it actually opens the league hub',
    await page.evaluate(() => document.getElementById('leagues')?.classList.contains('active')));
}

console.log('the league hub and the studio:');
{
  doorsOpen = true;
  await setPlan('premium');
  await page.evaluate(() => { try { (0, eval)('closeAaaModal(false)'); } catch (e) {} });
  await page.evaluate(() => (0, eval)("openLeagues()"));
  await page.waitForTimeout(900);
  ok('the hub is not still parked behind a «بزودی» modal',
    await page.evaluate(() => document.getElementById('leagues')?.classList.contains('active')));
  const live = await page.evaluate(() => document.getElementById('lgBody')?.textContent || '');
  ok('the hub says where the player actually stands', /رتبهٔ تو این هفته/.test(live) && /۴/.test(live), live.slice(0, 90));
  ok('and which league they are in', /لیگ طلایی/.test(live), live.slice(0, 140));
  ok('with a way into their room once the doors are open',
    await page.evaluate(() => !!document.querySelector('#lgBody button')));

  joined = 0;
  await page.evaluate(() => document.querySelector('#lgBody button').click());
  await page.waitForTimeout(700);
  ok('entering the studio takes the seat on the server', joined === 1, String(joined));
  ok('and the studio is on screen', await page.evaluate(() => document.getElementById('wta')?.classList.contains('active')));

  const seats = await page.evaluate(() => document.querySelectorAll('#wtaStage .wta-seat').length);
  ok('the other players are seated from the server list', seats === 3, String(seats));
  const qtext = await page.evaluate(() => document.getElementById('wtaText')?.textContent || '');
  ok('the question is the server’s', /ژاپن/.test(qtext), qtext);
  const enabled = await page.evaluate(() => [...document.querySelectorAll('#wtaAnswers .ans')].filter((b) => !b.disabled).length);
  ok('and it is answerable because it is my turn', enabled === 4, String(enabled));
}

console.log('answering and choosing who is next:');
{
  answered.length = 0; picked.length = 0;
  /* The options are shuffled per player now, so «the first button» is not
     «option 0». Tap the one whose TEXT is the first option the server sent and
     the server must receive index 0 — that is the whole translation, checked
     end to end rather than by trusting the map. */
  const tapped = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#wtaAnswers .ans')].find((x) => /توکیو/.test(x.textContent));
    const shownAt = Number(b.dataset.i);
    b.click();
    return shownAt;
  });
  await page.waitForTimeout(1400);
  ok('the answer goes to the server in the server’s own option order',
    answered.length === 1 && answered[0].selectedIndex === 0,
    'tapped display slot ' + tapped + ' → sent ' + JSON.stringify(answered));

  const picking = await page.evaluate(() => document.getElementById('wtaPickArea')?.style.display !== 'none');
  ok('a right answer opens the choice of who answers next', picking);

  await page.evaluate(() => {
    const seat = [...document.querySelectorAll('#wtaStage .wta-seat')].find((e) => e.dataset.uid && e.dataset.uid !== 'me');
    seat.click();
  });
  await page.waitForTimeout(600);
  ok('and naming somebody sends THEIR id', picked.length === 1 && !!picked[0].userId && picked[0].userId !== 'me', JSON.stringify(picked));
}

console.log('when it is somebody else’s turn:');
{
  roomPhase = 'turn'; roomMine = false;
  for (let i = 0; i < 3; i++) { await page.evaluate(() => (0, eval)('wtaLeagueTick()')); await page.waitForTimeout(250); }
  await page.waitForTimeout(400);
  const locked = await page.evaluate(() => [...document.querySelectorAll('#wtaAnswers .ans')].every((b) => b.disabled));
  ok('the answers are locked — you cannot answer for another player', locked);
  const clock = await page.evaluate(() => document.getElementById('wtaNum')?.textContent || '');
  ok('and the timer shows you are watching', /👀/.test(clock), clock);
}

console.log('the end of the match:');
{
  answered.length = 0;
  await page.evaluate(() => {
    const s = (0, eval)('wtaLeague').snap;
    (0, eval)('wtaLeagueApply')(Object.assign({}, s, { phase: 'finished', winnerUserId: 'me' }));
  });
  await page.waitForTimeout(600);
  const txt = await page.evaluate(() => document.getElementById('aaaModal')?.textContent || '');
  const who = await page.evaluate(() => (0, eval)('_usr') && (0, eval)('_usr').id);
  ok('a winner is told they won', /قهرمان شدی/.test(txt), txt.slice(0, 60) + ' [_usr.id=' + who + ']');
  const polling = await page.evaluate(() => !!((0, eval)('wtaLeague') && (0, eval)('wtaLeague').poll));
  ok('and the room stops polling once it is over', !polling);
}


/* ── one answer layout everywhere ──────────────────────────────────── */
console.log('the option order:');
{
  /* The bank stores most questions with the answer first, so a mode that draws
     `options` as they arrive makes «الف» the answer nearly every time. */
  const spread = await page.evaluate(() => {
    const seen = {};
    for (let i = 0; i < 200; i++) {
      const v = (0, eval)('pzShuffleView')(['A', 'B', 'C', 'D'], 0, null);
      seen[v.correct] = (seen[v.correct] || 0) + 1;
    }
    return seen;
  });
  const slots = Object.keys(spread).length;
  ok('the correct answer lands in every slot, not always the first', slots === 4, JSON.stringify(spread));
  ok('and no slot takes more than half of them', Math.max(...Object.values(spread)) < 100, JSON.stringify(spread));

  const stable = await page.evaluate(() => {
    const a = (0, eval)('pzShuffleView')(['A', 'B', 'C', 'D'], 0, 'k1');
    const b = (0, eval)('pzShuffleView')(['A', 'B', 'C', 'D'], 0, 'k1');
    return { a: a.options.join(''), b: b.options.join('') };
  });
  ok('a card redrawn keeps the order it already had', stable.a === stable.b, JSON.stringify(stable));

  const roundTrip = await page.evaluate(() => {
    (0, eval)('pzForgetView')('k2');
    const v = (0, eval)('pzShuffleView')(['A', 'B', 'C', 'D'], 2, 'k2');
    const out = [];
    for (let d = 0; d < 4; d++) {
      const orig = (0, eval)('pzToOriginal')('k2', d);
      out.push({ shown: v.options[d], orig, back: (0, eval)('pzToDisplay')('k2', orig) === d });
    }
    return { out, correctShown: v.options[v.correct] };
  });
  ok('the option tapped maps back to the one the server stores',
    roundTrip.out.every((r, d) => r.back && r.shown === ['A', 'B', 'C', 'D'][r.orig]), JSON.stringify(roundTrip.out));
  ok('and the correct answer still points at the right text', roundTrip.correctShown === 'C', roundTrip.correctShown);
}

console.log('the timer, in every mode:');
{
  /* The duel's: a circle between two bars that close inward, sitting between
     the question and the options. */
  const shape = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="tprobe">' + (0, eval)('pzTimerHTML')('tp') + '</div>');
    (0, eval)('pzTimerSet')('tp', 5, 20);
    const L = document.getElementById('tpL'), R = document.getElementById('tpR'), N = document.getElementById('tpN');
    const out = { l: L.style.transform, r: R.style.transform, n: N.textContent,
                  danger: document.getElementById('tp').classList.contains('danger') };
    (0, eval)('pzTimerSet')('tp', 18, 20);
    out.wide = document.getElementById('tpL').style.transform;
    out.calm = !document.getElementById('tp').classList.contains('danger');
    document.getElementById('tprobe').remove();
    return out;
  });
  ok('both bars close in as the time goes', /scaleX\(0.25\)/.test(shape.l) && /scaleX\(0.25\)/.test(shape.r), JSON.stringify(shape));
  ok('the circle counts the seconds', /۵/.test(shape.n), shape.n);
  ok('the last five seconds turn red', shape.danger === true && shape.calm === true, JSON.stringify(shape));

  /* And it is between the question and the options in each mode's markup. */
  const between = await page.evaluate(() => {
    const check = (card, q, t, o) => {
      const C = document.querySelector(card); if (!C) return 'no card';
      const Q = C.querySelector(q), T = C.querySelector(t), O = C.querySelector(o);
      if (!Q || !T || !O) return 'missing ' + (!Q ? 'question' : !T ? 'timer' : 'options');
      const pos = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
      return (pos(Q, T) && pos(T, O)) ? 'between' : 'out of order';
    };
    return {
      record: check('#recordPlay .rmp-card', '#rmQ', '#rmTimer', '#rmOpts'),
      studio: check('#wta .wta-qpanel', '#wtaText', '#wtaTimer', '#wtaAnswers')
    };
  });
  ok('record mode puts it between the question and the options', between.record === 'between', between.record);
  ok('and so does the league studio', between.studio === 'between', between.studio);

  const old = await page.evaluate(() => ({
    recordRing: !!document.getElementById('rmTimerArc'),
    lsRing: /timer-ring[^>]*id="lsRing"/.test(document.documentElement.innerHTML)
  }));
  ok('the old corner rings are gone', !old.recordRing, JSON.stringify(old));
}


console.log('the league hub explains itself:');
{
  doorsOpen = false;
  await setPlan('premium');
  await page.evaluate(() => (0, eval)("openLeagues()"));
  await page.waitForTimeout(800);
  const t = await page.evaluate(() => document.getElementById('lgBody')?.textContent || '');

  ok('it says when the match starts', /زمان مسابقه/.test(t) && /تا شروع/.test(t), t.slice(0, 60));
  ok('and what turning up is worth', /جایزهٔ حضور/.test(t) && /۵۰٬۰۰۰/.test(t), /جایزهٔ حضور/.test(t) + '/' + /۵۰٬۰۰۰/.test(t));
  ok('it warns that being absent costs the prize', /حذف است/.test(t));
  ok('the rank bands are the server’s, not typed in', /رتبهٔ ۱ تا ۱۵/.test(t) && /رتبهٔ ۳۱ تا ۴۵/.test(t));
  ok('every tier shows both prizes', /قهرمان: ۵۰۰٬۰۰۰ تومان/.test(t), t.slice(t.indexOf('لیگ‌ها'), t.indexOf('لیگ‌ها') + 200));
  ok('the rules of «از کی بپرسم» are spelled out', /۳ جان/.test(t) && /سؤال بعدی از چه کسی/.test(t));
  ok('and it says the ticket is not for sale', /فروخته نمی‌شود/.test(t));

  const counting = await page.evaluate(() => document.getElementById('lgCount')?.textContent || '');
  ok('the countdown is a real time, not a placeholder', /ساعت|دقیقه|روز/.test(counting), counting);

  ok('the door is shut until ten minutes before', !/ورود به استودیو/.test(t), 'entry offered too early');
}

console.log('nothing in the league plays against bots any more:');
{
  const gone = await page.evaluate(() => ({
    goLive: typeof window.goLeagueLive,
    start: typeof window.startLeagueMatch,
    claim: typeof window.claimLeagueTicketReward,
    screen: !!document.getElementById('league-live')
  }));
  ok('the bot-league entry points are gone', gone.goLive === 'undefined' && gone.start === 'undefined', JSON.stringify(gone));
  ok('so is the fake ticket giveaway', gone.claim === 'undefined', JSON.stringify(gone));
  ok('and the invented league table screen', gone.screen === false, JSON.stringify(gone));
}

console.log('the studio before kickoff:');
{
  /* Entering early used to show the question card with nothing in it. */
  roomPhase = 'lobby'; roomMine = false;
  await page.evaluate(() => {
    (0, eval)('wtaLeague = {roomId:"lr1",snap:null,poll:null,lastKey:"",ended:false}');
    (0, eval)("go('wta')");
    const s = {
      id: 'lr1', phase: 'lobby', turnUserId: null, endsAt: Date.now() + 300000, serverNow: Date.now(),
      aliveCount: 4, winnerUserId: null,
      players: [
        { userId: 'me', username: 'ehsan', lives: 3, out: false, absent: false },
        { userId: 'p2', username: 'زهرا', lives: 3, out: false, absent: false },
        { userId: 'p3', username: 'رضا', lives: 3, out: false, absent: true },
        { userId: 'p4', username: 'سینا', lives: 3, out: false, absent: true }
      ],
      me: { userId: 'me', lives: 3, out: false, absent: false, myTurn: false }
    };
    (0, eval)('wtaLeagueApply')(s);
  });
  await page.waitForTimeout(300);
  const lobby = await page.evaluate(() => document.getElementById('wtaQArea')?.textContent || '');
  ok('the studio says what it is waiting for', /استودیو هنوز باز نشده/.test(lobby), lobby.slice(0, 60));
  ok('with a countdown', /دقیقه|ساعت/.test(lobby), lobby.slice(0, 90));
  ok('and who has arrived so far', /۲ از ۴/.test(lobby), lobby.slice(0, 140));
  const blank = await page.evaluate(() => document.querySelectorAll('#wtaAnswers .ans').length);
  ok('and no empty question card behind it', blank === 0, String(blank));

  /* When the first question lands, the card has to come back. */
  await page.evaluate(() => {
    const s = Object.assign({}, (0, eval)('wtaLeague').snap, {
      phase: 'turn', turnUserId: 'me', endsAt: Date.now() + 15000,
      question: { id: 'q9', text: 'پایتخت ژاپن؟', options: ['توکیو', 'اوساکا', 'کیوتو', 'ناگویا'], category: 'جغرافیا' },
      me: { userId: 'me', lives: 3, out: false, absent: false, myTurn: true }
    });
    (0, eval)('wtaLeagueApply')(s);
  });
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    opts: document.querySelectorAll('#wtaAnswers .ans').length,
    text: document.getElementById('wtaText')?.textContent || ''
  }));
  ok('the question card comes back when play starts', back.opts === 4 && /ژاپن/.test(back.text), JSON.stringify(back));
}

console.log('record mode:');
{
  await page.evaluate(() => (0, eval)("go('record')"));
  await page.waitForTimeout(700);
  const secs = await page.evaluate(() => (0, eval)('rmQuestionSeconds()'));
  ok('the question clock is the operator’s, not a constant in the file', secs === 33, String(secs));

  const praise = await page.evaluate(() => {
    const i = (0, eval)('rmAnswer').toString();
    return /showAnswerCelebration/.test(i);
  });
  ok('an answer throws the duel’s words out of the option', praise);

  const stable = await page.evaluate(() => {
    (0, eval)('pzRM').questionSeconds = 33;
    (0, eval)('rmTimerStart')(6);          // a shortened second-chance clock
    return (0, eval)('rmQuestionSeconds()');
  });
  ok('and a shortened round does not rewrite the setting', stable === 33, String(stable));
}

ok('no script errors on the new screens', errs.length === 0, errs.join(' | '));








console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
