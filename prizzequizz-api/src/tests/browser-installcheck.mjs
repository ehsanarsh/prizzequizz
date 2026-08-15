/* GETTING THE GAME ONTO THE PHONE, AND GETTING PERMISSION TO REACH IT.
 *
 *   • «در اولین ورود باید هم در اون بالا install بیاد که روش بزنه و add to
 *     home screen بشه» — the browser offers the install prompt exactly ONCE,
 *     through an event, and nothing in the game was catching it. The offer was
 *     thrown away every single time, so the strip that spends it never existed
 *     and almost nobody installed the game. On iPhone that is not cosmetic:
 *     Safari has no push at all until the game is installed.
 *   • «تا زمانی که کاربر دسترسی نداده در هر ورودش ازش بخواییم» — permission was
 *     asked at most twice per lifetime. A player who dismissed it twice could
 *     never be sent anything again, and nothing would ever bring it up.
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

/* `ios` fakes an iPhone: no beforeinstallprompt exists there at all, which is
   the case the strip has to handle by teaching instead of prompting. */
async function makePage({ ios = false, permission = 'default', standalone = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(({ ios, permission, standalone }) => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5 }));
    if (ios) Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
    /* The permission state the browser would report, and the modal's answer. */
    try {
      window.__perm = permission;
      window.__requested = 0;
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: Object.assign(function () {}, {
          get permission() { return window.__perm; },
          requestPermission: () => { window.__requested++; return Promise.resolve(window.__perm); }
        })
      });
    } catch (e) {}
    if (standalone) {
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q) => (/standalone/.test(q) ? { matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q));
    }
  }, { ios, permission, standalone });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

/* The browser's offer, as it really arrives: an event the page must catch and
   keep, with a userChoice the page reads after prompting. */
const fireInstallOffer = (page) => page.evaluate(() => {
  const e = new Event('beforeinstallprompt');
  e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; };
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(e);
});

/* ── 1. THE STRIP ───────────────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('the install strip on a phone that can install:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => !!document.getElementById('pzInstallBar'));
  ok('nothing is shown before the browser offers it', before === false, String(before));

  await fireInstallOffer(page);
  await page.waitForTimeout(300);
  const bar = await page.evaluate(() => {
    const b = document.getElementById('pzInstallBar');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const scr = document.querySelector('.screen.active');
    return { text: (b.querySelector('.pzib-txt') || {}).textContent || '',
             btn: (b.querySelector('.pzib-btn') || {}).textContent || '',
             top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width),
             /* Flush with the top of the app itself — the phone frame can sit a
                few pixels down inside a desktop window, so 0 is the wrong thing
                to compare against. */
             vpTop: Math.round((document.getElementById('vp') || document.body).getBoundingClientRect().top),
             screenTop: scr ? Math.round(scr.getBoundingClientRect().top) : -1 };
  });
  ok('the offer puts a strip on the screen', !!bar, JSON.stringify(bar));
  ok('at the very top of the app', bar.top === bar.vpTop, bar.top + 'px vs app top ' + bar.vpTop + 'px');
  ok('across the whole width', bar.w >= 380, bar.w + 'px');
  ok('with a button that says «نصب»', /نصب/.test(bar.btn), bar.btn);
  ok('and says what it is for', /نصب|خبر/.test(bar.text), bar.text);
  /* A strip that covers the header is a strip that gets tapped by accident. */
  ok('and the screen moves down instead of hiding under it', bar.screenTop >= bar.h - 2, 'screen at ' + bar.screenTop + ', bar ' + bar.h);

  const tapped = await page.evaluate(async () => {
    document.querySelector('#pzInstallBar .pzib-btn').click();
    await new Promise((r) => setTimeout(r, 500));
    return { prompted: window.__prompted || 0, bar: !!document.getElementById('pzInstallBar') };
  });
  ok('tapping it spends the browser’s offer', tapped.prompted === 1, JSON.stringify(tapped));
  ok('and an accepted install takes the strip away', tapped.bar === false, String(tapped.bar));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. THE IPHONE, WHERE THERE IS NO PROMPT TO SPEND ───────────────────── */
{
  const { ctx, page, errs } = await makePage({ ios: true });
  console.log('the same strip on an iPhone:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(3400);              // the on-load check puts it up

  const shown = await page.evaluate(() => !!document.getElementById('pzInstallBar'));
  ok('it is shown even with no install event', shown === true, String(shown));

  const taught = await page.evaluate(async () => {
    document.querySelector('#pzInstallBar .pzib-btn').click();
    await new Promise((r) => setTimeout(r, 500));
    /* The MODAL's own text, not document.body — the whole app is one inline
       <script> inside <body>, so body.textContent contains the source of the
       game and would match almost any string asked of it. */
    const ov = document.getElementById('aaaModal');
    const shown = !!(ov && (ov.classList.contains('show') || getComputedStyle(ov).display !== 'none'));
    const txt = ((document.getElementById('aaaTitle') || {}).textContent || '') + ' ' +
                ((document.getElementById('aaaSub') || {}).textContent || '');
    return { modal: shown, txt: txt.replace(/\s+/g, ' ').trim().slice(0, 90),
             addToHome: /Add to Home Screen/.test(txt), share: /اشتراک/.test(txt), why: /اعلان/.test(txt) };
  });
  ok('a modal actually opens', taught.modal, JSON.stringify(taught));
  ok('tapping teaches the two taps instead of pretending', taught.addToHome, taught.txt);
  ok('naming the share button they have to find', taught.share, taught.txt);
  ok('and saying why it matters on iPhone', taught.why, taught.txt);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. ALREADY INSTALLED ───────────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage({ ios: true, standalone: true });
  console.log('a player who already installed it:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(3400);
  const bar = await page.evaluate(() => ({ bar: !!document.getElementById('pzInstallBar'), cls: document.body.className }));
  ok('is not asked to install it again', bar.bar === false, JSON.stringify(bar));

  /* Chrome can still fire the offer at a window that is already standalone.
     Taking it at face value would put an install strip on top of an installed
     game, which is the one player who can never need it. */
  await fireInstallOffer(page);
  await page.waitForTimeout(300);
  const afterOffer = await page.evaluate(() => !!document.getElementById('pzInstallBar'));
  ok('and a stray install offer does not conjure one', afterOffer === false, String(afterOffer));
  ok('and their screen is not pushed down for nothing', !/pz-has-install/.test(bar.cls), bar.cls);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 4. PERMISSION, EVERY VISIT UNTIL ANSWERED ──────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('asking for notification permission:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(400);

  /* Two visits' worth of asks already spent — the old rule stopped here for
     ever, which is the bug: a player who dismissed it twice was unreachable. */
  const asks = await page.evaluate(async () => {
    localStorage.setItem('pz_push_asked', '9');
    sessionStorage.removeItem('pz_push_asked_visit');
    return (0, eval)('pzShouldAskPush')();
  });
  ok('a player who dismissed it before is still asked', asks === true, String(asks));

  const first = await page.evaluate(async () => {
    (0, eval)('pzAskPushOnInstall')();
    await new Promise((r) => setTimeout(r, 400));
    return { body: (document.body.textContent || '').indexOf('روی گوشی') >= 0,
             again: (0, eval)('pzShouldAskPush')() };
  });
  ok('and asked once, with a reason', first.body, String(first.body));
  ok('but not a second time in the same visit', first.again === false, String(first.again));

  /* A new visit is a new session — the same tab reloaded, sessionStorage gone. */
  const nextVisit = await page.evaluate(() => {
    sessionStorage.removeItem('pz_push_asked_visit');
    return (0, eval)('pzShouldAskPush')();
  });
  ok('the next visit asks again', nextVisit === true, String(nextVisit));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 5. AN ANSWER IS AN ANSWER ──────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage({ permission: 'granted' });
  console.log('once the player has answered:');
  await page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await page.waitForTimeout(400);
  const granted = await page.evaluate(() => { sessionStorage.removeItem('pz_push_asked_visit'); return (0, eval)('pzShouldAskPush')(); });
  ok('a player who said yes is never asked again', granted === false, String(granted));
  await ctx.close();

  const denied = await makePage({ permission: 'denied' });
  await denied.page.evaluate(() => (0, eval)("userPlan='premium'; planExplicitlyChosen=true; go('home');"));
  await denied.page.waitForTimeout(400);
  const d = await denied.page.evaluate(() => { sessionStorage.removeItem('pz_push_asked_visit'); return (0, eval)('pzShouldAskPush')(); });
  ok('and one who said no is not nagged either', d === false, String(d));
  ok('no script errors', errs.length === 0 && denied.errs.length === 0, errs.concat(denied.errs).join(' | '));
  await denied.ctx.close();
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
