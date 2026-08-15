/* THE NOTIFICATION SWITCHES, AND WHAT THEY ACTUALLY SEND.
 *
 *   «وقتی تیک رو می‌زنی که در اعلان چه چیزی برود انگار کار نمی‌کنه بعضی‌هاشون»
 *
 * A switch that flips on screen and sends nothing looks identical to one that
 * works, which is why this drives the real settings screen and reads the
 * request body the game puts on the wire.
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

let prefs = { userId: 'me', matchUpdates: true, leaderboardUpdates: true, walletUpdates: true, promos: false, friendMessages: true };
const puts = [];

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.addInitScript(() => {
  localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
  localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
});
await ctx.route('**/v1/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
  const m = route.request().method();
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (p === '/notifications/preferences') {
    if (m === 'PUT' || m === 'PATCH') {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      puts.push(b); prefs = { ...prefs, ...b };
      return send(prefs);
    }
    return send(prefs);
  }
  return send({});
});
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
await page.goto('http://127.0.0.1:' + PORT + '/');
await page.waitForTimeout(5200);

const openNotifSettings = async () => {
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; openSettingDetail('notifications');"));
  await page.waitForTimeout(600);
};
await openNotifSettings();

const rows = await page.evaluate(() => [...document.querySelectorAll('#settingDetailContent .set-row')].map((r) => ({
  title: (r.querySelector('b') || {}).textContent || '',
  on: !!r.querySelector('.switch.on'),
  key: ((r.querySelector('.switch') || {}).getAttribute('onclick') || '').replace(/.*'([^']+)'.*/, '$1')
})));
console.log('the switches on the notifications screen:');
ok('the screen has its switches', rows.length >= 4, JSON.stringify(rows.map((r) => r.title)));

/* Each one, on its own: flip it off and read what the game sent. */
const field = { notifMatch: 'matchUpdates', notifLeague: 'leaderboardUpdates', notifRewards: 'walletUpdates', notifFriends: 'friendMessages' };
for (const [key, f] of Object.entries(field)) {
  puts.length = 0;
  const before = await page.evaluate((k) => (0, eval)('appSettings')[k] !== false, key);
  await page.evaluate((k) => (0, eval)("toggleSetting('" + k + "')"), key);
  await page.waitForTimeout(700);
  const sent = puts[puts.length - 1] || null;
  ok('«' + (rows.find((r) => r.key === key) || {}).title + '» reaches the server', !!sent, JSON.stringify(sent));
  ok('  and carries ' + f + ' = ' + String(!before), sent && sent[f] === !before, sent ? String(sent[f]) : '—');
  /* Put it back so the next one is measured from the same start. */
  await page.evaluate((k) => (0, eval)("toggleSetting('" + k + "')"), key);
  await page.waitForTimeout(700);
}

/* The master switch has to mute everything, not just look muted. */
{
  puts.length = 0;
  await page.evaluate(() => (0, eval)("toggleSetting('notifications')"));
  await page.waitForTimeout(700);
  const sent = puts[puts.length - 1] || {};
  ok('the master switch mutes every type at once',
     sent.matchUpdates === false && sent.leaderboardUpdates === false && sent.walletUpdates === false && sent.friendMessages === false && sent.promos === false,
     JSON.stringify(sent));
  await page.evaluate(() => (0, eval)("toggleSetting('notifications')"));
  await page.waitForTimeout(700);
}

/* And what the server says must be what the screen shows on the way back in. */
{
  prefs = { userId: 'me', matchUpdates: false, leaderboardUpdates: true, walletUpdates: false, promos: false, friendMessages: false };
  await page.evaluate(async () => { await (0, eval)('pzLoadNotifPrefs()'); });
  await page.waitForTimeout(400);
  await openNotifSettings();
  const back = await page.evaluate(() => [...document.querySelectorAll('#settingDetailContent .set-row')].map((r) => ({
    key: ((r.querySelector('.switch') || {}).getAttribute('onclick') || '').replace(/.*'([^']+)'.*/, '$1'),
    on: !!r.querySelector('.switch.on')
  })));
  const byKey = (k) => (back.find((b) => b.key === k) || {}).on;
  ok('a type the server has off comes back off', byKey('notifMatch') === false && byKey('notifRewards') === false && byKey('notifFriends') === false, JSON.stringify(back));
  ok('and one it has on comes back on', byKey('notifLeague') === true, JSON.stringify(back));
}
ok('no script errors', errs.length === 0, errs.join(' | '));

/* ── WHO GETS ASKED FOR PERMISSION AT ALL ───────────────────────────────── */
console.log('being asked to turn phone notifications on:');
{
  /* The gate used to be «only when installed as an app», so a player in an
     ordinary browser was never asked, never subscribed, and could not receive
     a push at all — which is exactly «badge yes, phone no». */
  const canAsk = await page.evaluate(() => {
    (0, eval)("try{localStorage.removeItem('pz_push_asked');}catch(e){}");
    return {
      installed: (0, eval)('pzIsInstalled()'),
      supported: 'PushManager' in window,
      should: (0, eval)('pzShouldAskPush()')
    };
  });
  ok('this browser is not an installed app', canAsk.installed === false, String(canAsk.installed));
  ok('but it does support push', canAsk.supported === true, String(canAsk.supported));
  ok('so the game is willing to ask', canAsk.should === true, JSON.stringify(canAsk));

  /* And it does ask, from the chat — the one place the answer matters most. */
  const asked = await page.evaluate(async () => {
    (0, eval)("try{localStorage.removeItem('pz_push_asked');}catch(e){} try{closeAaaModal(true);}catch(e){}");
    (0, eval)('pzAskPushForChat()');
    await new Promise((r) => setTimeout(r, 1400));
    const m = document.getElementById('aaaModal');
    return { open: !!m && m.classList.contains('show'), text: (m ? m.innerText : '').replace(/\s+/g, ' ') };
  });
  ok('opening a chat asks for it', asked.open, asked.text.slice(0, 60));
  ok('in words about the chat', /پیام دوستت/.test(asked.text), asked.text.slice(0, 90));

  /* ONCE A VISIT, AND NOT AGAIN INSIDE IT. The rule used to be «twice, ever»,
     which meant a player who waved it away in their first week could never be
     sent anything for the life of the account — no match starting, no message
     from a friend — and nothing in the game would ever raise it again. Now the
     ask comes back on the next visit and stops the moment they actually answer
     (granted or denied), which is the browser's own gate. */
  const nag = await page.evaluate(async () => {
    (0, eval)("try{closeAaaModal(true);}catch(e){}");
    (0, eval)('pzAskPushForChat()'); await new Promise((r) => setTimeout(r, 1200));
    (0, eval)("try{closeAaaModal(true);}catch(e){}");
    (0, eval)('pzAskPushForChat()'); await new Promise((r) => setTimeout(r, 1200));
    const m = document.getElementById('aaaModal');
    return { open: !!m && m.classList.contains('show'), should: (0, eval)('pzShouldAskPush')() };
  });
  ok('and does not ask twice in one visit', nag.open === false && nag.should === false, JSON.stringify(nag));

  const backTomorrow = await page.evaluate(() => {
    try { sessionStorage.removeItem('pz_push_asked_visit'); } catch (e) {}
    return (0, eval)('pzShouldAskPush')();
  });
  ok('but the next visit asks again, because it still matters', backTomorrow === true, String(backTomorrow));
}

console.log(`\n${pass} passed, ${fail} failed`);
await ctx.close(); await browser.close(); server.close();
process.exit(fail ? 1 : 0);
