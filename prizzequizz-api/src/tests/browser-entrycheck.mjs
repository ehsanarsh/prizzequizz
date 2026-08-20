/* THREE SCREENS THAT WERE ASKED FOR BY NAME.
 *
 *   1. The two ticket screens — Last Survivor's and the duel's — carried a
 *      banner at a fixed 172px with air around every label. The banner is the
 *      only thing on either screen anyone looks AT; everything else is a label.
 *      So the gaps close and the banner takes what is left.
 *   2. A ticket in the header jumped to the shop when tapped, which answers a
 *      question nobody asked. A player looking at a ticket they already hold
 *      wants to know what it is FOR.
 *   3. Registration marked the character step DONE without ever showing it, so
 *      a new player arrived with a default face and had to go and find the
 *      picker themselves.
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
const IMG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#2b6cb0"/></svg>').toString('base64');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

const patches = [];
async function makePage(w = 390, h = 844) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'me', username: 'ehsan', displayName: 'احسان', level: 3, coins: 50, hearts: 5, wallet: 900000 }));
  });
  await ctx.route('**/v1/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^.*\/v1/, '');
    const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
    if (p === '/users/me' && route.request().method() === 'PATCH') {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      patches.push(b);
      return send({ id: 'me', username: b.username || 'ehsan', displayName: b.displayName || 'احسان', level: 3, coins: 50, hearts: 5 });
    }
    return send({});
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 160)));
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.waitForTimeout(5200);
  return { ctx, page, errs };
}

const seedBanner = (page) => page.evaluate((img) => {
  (0, eval)("PZ_BANNERS={lastSurvivor:[{slot:'lastSurvivor',title:'جایزهٔ بزرگ',text:'با بلیط طلایی وارد شو',media:'" + img + "',kind:'image'}]," +
            "duel:[{slot:'duel',title:'دوئل ویژه',text:'حریفت منتظره',media:'" + img + "',kind:'image'}]}");
}, IMG);

/* ── 1. THE TWO TICKET SCREENS ──────────────────────────────────────────── */
for (const [w, h] of [[390, 844], [360, 640]]) {
  const { ctx, page, errs } = await makePage(w, h);
  console.log(`the ticket screens at ${w}×${h}:`);
  await seedBanner(page);

  const measure = (id) => page.evaluate((sid) => {
    const sec = document.getElementById(sid);
    const box = (sel) => { const e = sec.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) }; };
    /* Every visible block, so the gaps BETWEEN them can be measured — the ask
       was «متن‌ها و کارت‌ها و دکمه‌ها رو به هم نزدیک کن». */
    const kids = [...sec.children].filter((e) => e.offsetParent && e.getBoundingClientRect().height > 1)
      .map((e) => ({ n: (e.className || e.id || '').toString().slice(0, 24), t: Math.round(e.getBoundingClientRect().top), b: Math.round(e.getBoundingClientRect().bottom) }));
    const gaps = kids.slice(1).map((k, i) => k.t - kids[i].b);
    return { promo: box('.tk-promo'), sec: { h: Math.round(sec.getBoundingClientRect().height) }, kids, gaps,
             scrolls: sec.scrollHeight > sec.clientHeight + 1 };
  }, id);

  await page.evaluate(() => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; lsEntryTopic='ورزشی'; lsEntryColor='green'; mTickets={green:2,blue:1,red:0};");
    (0, eval)("go('lsEntry'); try{ lsRenderEntry(); }catch(e){}");
  });
  await page.waitForTimeout(900);
  const ls = await measure('lsEntry');
  ok('the Last Survivor banner is there', !!ls.promo, JSON.stringify(ls.promo));
  /* «اندازه تصویر بنر رو به حداکثرترین حالت ممکن برسون» — it must be much more
     than the 172px it used to be fixed at, and a real share of the screen.
     A short phone has less to give, so it is judged on the share it hands over
     rather than on an absolute height a 640px screen cannot reach. */
  /* THE NUMBERS BELOW MOVED WHEN THE FONT DID, and it is worth saying why so
     nobody reads it as the banner shrinking. This page used to fetch Vazirmatn
     from a font server; in this harness that request fails, so every earlier
     measurement here was taken against a SYSTEM fallback face. The font now
     travels inside the page, so the screen is finally measured in the letters
     a player actually sees — slightly taller ones, which take a few pixels out
     of what is left for the picture. Nothing about the layout changed. */
  ok('and much bigger than the old fixed 172px', ls.promo.h > 172 + 30, ls.promo.h + 'px');
  ok('taking a real share of the screen', ls.promo.h / ls.sec.h >= 0.32, (ls.promo.h / ls.sec.h).toFixed(2));
  ok('while the screen still does not scroll', !ls.scrolls, String(ls.scrolls));
  /* Nothing else is allowed to hold air. */
  ok('and nothing is left floating apart from its neighbour', ls.gaps.every((g) => g <= 10), JSON.stringify(ls.gaps));

  await page.evaluate(() => {
    (0, eval)("curMode='survivor'; go('mode-entry'); try{ updateModeEntryPlan(); }catch(e){} try{ renderTicketSelect(); }catch(e){}");
  });
  await page.waitForTimeout(900);
  const duel = await measure('mode-entry');
  ok('the duel banner is there too', !!duel.promo, JSON.stringify(duel.promo));
  ok('and just as big', duel.promo.h > 172 + 40, duel.promo.h + 'px');
  ok('the duel screen does not scroll either', !duel.scrolls, String(duel.scrolls));
  ok('and its blocks sit together', duel.gaps.every((g) => g <= 10), JSON.stringify(duel.gaps));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 2. A TICKET EXPLAINS ITSELF ────────────────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('tapping a ticket in the header:');
  await page.evaluate(() => {
    (0, eval)("userPlan='premium'; planExplicitlyChosen=true; mTickets={green:2,blue:0,red:1};");
    (0, eval)("PZ_PRIZES={green:{value:12500,prize:22500},blue:{value:25000,prize:45000},red:{value:50000,prize:90000}};");
    (0, eval)("lsTickets={red:{units:4,shields:2},green:{units:1,shields:0}};");
    (0, eval)("go('home'); renderHeaderTickets();");
  });
  await page.waitForTimeout(500);

  const pills = await page.evaluate(() => [...document.querySelectorAll('#hdrTickets .p-tk')].map((el) => ({
    border: getComputedStyle(el).borderTopColor,
    num: (el.querySelector('b') || {}).textContent,
    numColour: getComputedStyle(el.querySelector('b')).color,
    goesToShop: /goShopTickets/.test(el.getAttribute('onclick') || '')
  })));
  ok('every ticket has its own colour', pills.length === 3 && new Set(pills.map((p) => p.border)).size === 3,
     JSON.stringify(pills.map((p) => p.border)));
  ok('and its count is written in that colour', new Set(pills.map((p) => p.numColour)).size === 3, JSON.stringify(pills.map((p) => p.numColour)));
  ok('tapping one no longer just jumps to the shop', pills.every((p) => !p.goesToShop), JSON.stringify(pills.map((p) => p.goesToShop)));

  /* THE EXPLANATION: what it is, where it is used, when, and what it pays. */
  const info = await page.evaluate(async () => {
    (0, eval)("pzTicketInfo('red')");
    await new Promise((r) => setTimeout(r, 350));
    const m = document.getElementById('aaaModal');
    return { open: !!m && m.classList.contains('show'), text: (m ? m.innerText : '').replace(/\s+/g, ' ') };
  });
  ok('it opens an explanation instead', info.open, String(info.open));
  ok('naming the ticket', /بلیط قرمز/.test(info.text), info.text.slice(0, 40));
  ok('saying how many you hold', /تعداد تو/.test(info.text) && /۱/.test(info.text), (info.text.match(/تعداد تو.{0,14}/) || [''])[0]);
  ok('what it costs to enter', /۵۰٬۰۰۰/.test(info.text), (info.text.match(/ارزش ورودی.{0,16}/) || [''])[0]);
  /* The prize is the SERVER's after-commission figure, never worked out here. */
  ok('and what winning with it pays — the net figure', /۹۰٬۰۰۰/.test(info.text) && !/۱۰۰٬۰۰۰/.test(info.text), (info.text.match(/جایزهٔ برد.{0,20}/) || [''])[0]);
  ok('where it is used — both games by name', /دوئل/.test(info.text) && /آخرین بازمانده/.test(info.text));
  /* Both halves: the question the player is asking, and the answer. Checking
     only the answer let a mutation delete the heading and still pass. */
  ok('and when — asked and answered', /چه زمانی/.test(info.text) && /تاریخ انقضا ندارد|هر وقت خواستی/.test(info.text),
     (info.text.match(/چه زمانی.{0,40}/) || [''])[0]);
  /* A red ticket carries shields and a bigger share; those are part of what it
     is for, and they come from the room config rather than being invented. */
  ok('and what the tier itself grants', /سپر داخل بازی/.test(info.text) && /×۴/.test(info.text), (info.text.match(/سپر.{0,30}/) || [''])[0]);
  /* The shop is still one button away. */
  const shop = await page.evaluate(async () => {
    const b = document.getElementById('aaaPrimary');
    const label = b ? b.textContent : '';
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 400));
    return { label, screen: (document.querySelector('.screen.active') || {}).id };
  });
  ok('with buying it one button away', /خرید/.test(shop.label) && shop.screen === 'shop', JSON.stringify(shop));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ── 3. CHOOSING A CHARACTER AT REGISTRATION ────────────────────────────── */
{
  const { ctx, page, errs } = await makePage();
  console.log('finishing registration:');
  await page.evaluate(() => {
    (0, eval)("go('register')");
    document.getElementById('regFullName').value = 'احسان رضایی';
    document.getElementById('regUsername').value = 'ehsan_r';
    document.getElementById('regGender').value = 'male';
  });
  const before = await page.evaluate(() => (document.querySelector('#register .btn-primary,#register .btn-yellow') || {}).textContent);
  ok('the button saves the details', /ثبت اطلاعات/.test(before || ''), before);

  await page.evaluate(() => (0, eval)('submitRegister()'));
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => {
    const b = document.querySelector('#register .btn-primary,#register .btn-yellow');
    return {
      screen: (document.querySelector('.screen.active') || {}).id,
      label: b ? b.textContent : '',
      note: (document.getElementById('regSavedNote') || {}).innerText || '',
      charDone: localStorage.getItem('pz_charDone')
    };
  });
  ok('the details were sent', patches.length === 1 && patches[0].username === 'ehsan_r', JSON.stringify(patches[0] || {}));
  /* «باید مستقیم بره به انتخاب کاراکتر — الان اسم دکمه عوض میشه و باید دوباره
     همونو بزنی.» Saving and opening the picker were two presses of one button,
     which reads as the first press having done nothing. One press now. */
  ok('the picker opens straight away', after.screen === 'character', after.screen);
  ok('the button behind it is «انتخاب کاراکتر»', /انتخاب کاراکتر/.test(after.label), after.label);
  ok('with a line saying the details were saved', /ذخیره شد/.test(after.note), after.note.replace(/\n/g, ' '));
  /* And the step is NOT quietly marked done, which is what used to skip it. */
  ok('and the character step is not pre-marked as done', after.charDone !== '1', String(after.charDone));

  /* Coming back out of the picker ends registration at home, not at the
     profile screen the picker returns to when opened from anywhere else. */
  const dest = await page.evaluate(() => (0, eval)('charBack'));
  ok('and finishing it lands in the game', dest === 'home', String(dest));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
