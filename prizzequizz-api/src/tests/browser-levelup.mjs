/* «بعد هر بازی موشن level up میاد — باید هر موقع لول آپ شدی بیاد.»
 *
 * It fired on the first, third, fifth… win of a session — `winsThisSession % 2`
 * — which is a demo trigger that had nothing to do with the player's level. It
 * even printed a number it had made up: `curLvl + 1`, counting from a hardcoded
 * 3. So it appeared after games where nothing had happened, and showed a level
 * the player did not have.
 *
 * A level-up is a fact about XP. The one place that knows it is pzUpdateXpBar,
 * which compares the level the server reports against the one before.
 *
 * The rest of this file is about the motion itself — «مسخره و مصنوعی». The
 * checks that matter are not «is there an animation» but the three things that
 * separate made from generated: it has to LEAVE rather than vanish, it has to
 * replay on the second one, and the number has to be shown CHANGING, because
 * that is the only information the overlay exists to deliver.
 *
 * Run: node src/tests/browser-levelup.mjs */
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

async function open({ calm = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    reducedMotion: calm ? 'reduce' : 'no-preference'
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 3, xp: 100 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    const d = u.includes('/auth/refresh') ? { accessToken: 't2', refreshToken: 'r2' } : {};
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5600);
  return { ctx, page, errs };
}
const shown = (page) => page.evaluate(() => {
  const o = document.getElementById('lvlOverlay');
  return !!o && o.classList.contains('show');
});
/* The level shown on the badge, as digits a person would read. */
const num = (page) => page.evaluate(() => (document.getElementById('lvlNum') || {}).textContent || '');

/* ── 1. THE BUG ─────────────────────────────────────────────────────────── */
console.log('after an ordinary win:');
{
  const { ctx, page, errs } = await open();
  /* Spying rather than watching the overlay: `endGame` is a long function with
     chests and timers in it, and what is being pinned is that nothing in the
     win path ASKS for a level-up — not that the overlay happened to be slow. */
  await page.evaluate(() => {
    window.__lvl = [];
    (0, eval)('showLevelUp = function(a,b){ window.__lvl.push([a,b]); }');
  });
  /* BOTH WAYS A WIN CAN END. A free player's win pays practice coins; a paying
     one opens the chest — two separate branches, and the false trigger was in
     BOTH of them. Testing one would have left the other firing. */
  for (const plan of ['free', 'premium', 'free', 'premium']) {
    await page.evaluate((p) => {
      try { (0, eval)('userPlan=' + JSON.stringify(p)); (0, eval)('endGame(true, 50000, false)'); }
      catch (e) { window.__endErr = String(e).slice(0, 80); }
    }, plan);
    /* A paying win opens the chest, and the branch that used to fire the false
       level-up is inside the chest's CALLBACK — which does not run until the
       chest animation finishes. Skipping it is how that branch is reached at
       all; waiting a few hundred milliseconds silently tests nothing. */
    await page.waitForTimeout(250);
    await page.evaluate(() => { try { (0, eval)('skipChest()'); } catch (e) {} });
    await page.waitForTimeout(400);
  }
  const calls = await page.evaluate(() => window.__lvl.length);
  ok('four wins, both kinds, ask for no level-up at all', calls === 0, String(calls));
  ok('and the win path itself ran', !(await page.evaluate(() => window.__endErr)), String(await page.evaluate(() => window.__endErr || '')));
  await ctx.close();
}

/* ── 2. WHEN THE LEVEL REALLY GOES UP ───────────────────────────────────── */
console.log('when the level really goes up:');
{
  const { ctx, page, errs } = await open();
  /* The first paint must not celebrate: opening the app is not a level-up. */
  await page.evaluate(() => { (0, eval)('_pzLastLevel=null'); (0, eval)('_usr.level=3'); (0, eval)('pzUpdateXpBar(400)'); });
  await page.waitForTimeout(700);
  ok('opening the app is not a level-up', !(await shown(page)));

  await page.evaluate(() => { (0, eval)('_usr.level=4'); (0, eval)('pzUpdateXpBar(900)'); });
  await page.waitForTimeout(700);
  ok('but earning one is', await shown(page));

  /* THE NUMBER IS THE WHOLE POINT. It used to appear already reading the new
     level, so «this is higher than before» was never actually shown. */
  ok('and the badge starts on the level that is being left', /۳/.test(await num(page)), await num(page));
  await page.waitForTimeout(700);
  ok('then becomes the new one', /۴/.test(await num(page)), await num(page));
  ok('which is the level the server said, not a guess',
     (await page.evaluate(() => (document.getElementById('lvlSub') || {}).textContent || '')).includes('۴'),
     await page.evaluate(() => (document.getElementById('lvlSub') || {}).textContent || ''));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. IT LEAVES ───────────────────────────────────────────────────────── */
console.log('and then it goes away:');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => { (0, eval)('_pzLastLevel=3'); (0, eval)('_usr.level=4'); (0, eval)('pzUpdateXpBar(900)'); });
  await page.waitForTimeout(700);
  ok('it is up', await shown(page));
  /* Half of «مصنوعی» was this: display:none, one frame, gone. Things leave. */
  await page.evaluate(() => (0, eval)('hideLevelUp()'));
  await page.waitForTimeout(80);
  const leaving = await page.evaluate(() => {
    const o = document.getElementById('lvlOverlay');
    return { out: o.classList.contains('out'), still: o.classList.contains('show') };
  });
  ok('it plays an exit rather than vanishing', leaving.out && leaving.still, JSON.stringify(leaving));
  await page.waitForTimeout(600);
  ok('and is gone once the exit has played', !(await shown(page)));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. THE SECOND ONE ──────────────────────────────────────────────────── */
console.log('levelling up twice in one session:');
{
  /* CSS animations do not replay for a class that is already on the element.
     Without re-arming, the second level-up of a session is a static picture —
     and the second one is the one that matters, because by then the player
     knows what it is supposed to look like. */
  const { ctx, page, errs } = await open();
  await page.evaluate(() => { (0, eval)('_pzLastLevel=3'); (0, eval)('_usr.level=4'); (0, eval)('pzUpdateXpBar(900)'); });
  await page.waitForTimeout(700);
  await page.evaluate(() => (0, eval)('hideLevelUp()'));
  await page.waitForTimeout(600);

  await page.evaluate(() => { (0, eval)('_usr.level=5'); (0, eval)('pzUpdateXpBar(1700)'); });
  await page.waitForTimeout(700);
  ok('the second one shows too', await shown(page));

  const live = await page.evaluate(() => {
    const r = document.querySelector('#lvlOverlay .lvx-ring');
    /* A running animation has a non-zero currentTime; a replayed one restarts
       near zero. Either way this is only true if it is actually playing. */
    const a = r ? r.getAnimations().filter((x) => x.playState === 'running') : [];
    return { count: a.length, sparks: document.querySelectorAll('.lvx-spark').length };
  });
  ok('and it really plays, rather than sitting there', live.count > 0, JSON.stringify(live));
  ok('with the impact thrown again', live.sparks > 0, JSON.stringify(live));
  /* The count-up runs over the first half-second, so this waits for it rather
     than reading the number mid-flight — and asserts it for real. */
  await page.waitForTimeout(700);
  ok('and the badge reads the newest level', /۵/.test(await num(page)), await num(page));
  /* AND ONE THAT ARRIVES ON TOP OF ANOTHER. Two levels in quick succession is
     the case the class is never taken off in — so the second would be a still
     picture of the first. This is what the explicit re-arm is for; without it
     everything above still passes, because hiding in between does the same job
     by accident. */
  await page.evaluate(() => { (0, eval)('_usr.level=6'); (0, eval)('pzUpdateXpBar(2600)'); });
  await page.waitForTimeout(600);
  const stacked = await page.evaluate(() => {
    const r = document.querySelector('#lvlOverlay .lvx-ring');
    const a = r ? r.getAnimations() : [];
    const intro = a.find((x) => x.animationName === 'lvxRing');
    /* Freshly re-armed means the entrance is playing again from near its start,
       not sitting finished from the level-up before it. */
    return { playing: !!intro && intro.playState === 'running', t: intro ? Math.round(Number(intro.currentTime) || 0) : -1 };
  });
  ok('a level-up landing on one already showing plays again', stacked.playing && stacked.t < 700, JSON.stringify(stacked));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. SOMEBODY WHO ASKED FOR LESS MOVEMENT ────────────────────────────── */
console.log('for a phone set to reduce motion:');
{
  const { ctx, page, errs } = await open({ calm: true });
  await page.evaluate(() => { (0, eval)('_pzLastLevel=3'); (0, eval)('_usr.level=4'); (0, eval)('pzUpdateXpBar(900)'); });
  await page.waitForTimeout(700);
  ok('the news still arrives', await shown(page));
  const sparks = await page.evaluate(() => document.querySelectorAll('.lvx-spark').length);
  /* Not created at all, rather than created and hidden — eighteen elements
     nobody will see is work done for no one. */
  ok('but nothing is thrown at them', sparks === 0, String(sparks));
  ok('and the number is simply correct, without counting', /۴/.test(await num(page)), await num(page));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 6. THE WIN ITSELF ──────────────────────────────────────────────────── */
console.log('the victory screen:');
{
  const { ctx, page, errs } = await open();
  await page.evaluate(() => { try { (0, eval)('endGame(true, 50000, false)'); } catch (e) {} });
  /* The result screen has to be ON SCREEN for any of this to mean anything: a
     `display:none` section runs no animations at all, so checking one while the
     player is still looking at another screen proves nothing either way. */
  await page.evaluate(() => (0, eval)("go('result')"));
  await page.waitForTimeout(120);
  const first = await page.evaluate(() => {
    const t = document.getElementById('resultTitle');
    return {
      win: t.classList.contains('win'),
      armed: document.getElementById('result').classList.contains('win-in'),
      running: t.getAnimations().filter((a) => a.playState === 'running').length,
      char: (document.querySelector('.res-char') || { getAnimations: () => [] }).getAnimations().length
    };
  });
  ok('the headline is dressed as a win', first.win, JSON.stringify(first));
  ok('and it lands rather than simply appearing', first.running > 0, JSON.stringify(first));
  ok('with the character landing beside it', first.char > 0, JSON.stringify(first));

  /* THE SECOND WIN IS THE ONE THAT CATCHES THIS. The `win` class never comes
     off between results, and a CSS animation on a class that does not change
     plays once per page load — so without re-arming, every win after the first
     would be a headline that is simply there. */
  await page.waitForTimeout(900);
  await page.evaluate(() => { try { (0, eval)('endGame(true, 50000, false)'); } catch (e) {} });
  await page.waitForTimeout(120);
  const again = await page.evaluate(() => {
    const t = document.getElementById('resultTitle');
    return t.getAnimations().filter((a) => a.playState === 'running').length;
  });
  ok('and a second win lands again rather than sitting still', again > 0, String(again));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n[levelup] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
