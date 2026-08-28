/* THE SITE PANEL'S IMAGE HANDLING, IN A REAL BROWSER.
 *
 * «به جای لیست کاراکترها … بتونم از فایل‌هایی که رو سرور آپلود کردم استفاده کنم
 *  … و اینکه در تب تصویرها دکمهٔ خروج یا بک وجود نداره، وقتی می‌ری توش نمی‌تونی
 *  بیای بیرون.»
 *
 * Two faults, both only visible once the panel is actually running:
 *
 *   1. the media tab drew itself into #app, which is the whole shell — header,
 *      tab bar and all — so opening «تصویرها» deleted the tabs and there was no
 *      way back short of reloading the page. Worse, `tab()` then threw on a
 *      missing button, so even a click that survived did nothing.
 *   2. a character could only ever be one of the files the design ships. A
 *      picture uploaded from that same panel was not in the dropdown and there
 *      was nowhere to type its address, so it could not be used at all.
 *
 * Neither can be caught by asserting on a string of HTML: the first is about
 * what is left on the page after a click, and the second about what a click
 * puts into the form and what the form then sends. So this drives the panel.
 */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http';
import { adminHtml } from '../adminUi.js';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const HTML = adminHtml();
const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(HTML); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const MEDIA = [
  { id: 'm1', url: '/media/abc-123', filename: 'ghahreman.webp', size: 40000, alt: '' },
  { id: 'm2', url: '/media/def-456', filename: 'jayeze.webp', size: 51000, alt: '' }
];
const PAGES = [{
  slug: 'home', title: 'خانه', navLabel: 'خانه', navOrder: 1, showInNav: true, published: true,
  noindex: false, heroCharacter: 'char-thinking.png',
  blocks: [{ kind: 'callout', title: 'یک نکته', body: 'متن', character: '' }]
}];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });

/** Everything the panel PUTs back, so we can see what a pick really saved. */
const saved = [];
await ctx.route('**/site-api/**', (route) => {
  const req = route.request();
  const p = new URL(req.url()).pathname.replace('/site-api/', '');
  const send = (d) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: d }) });
  if (req.method() === 'PUT') { saved.push({ path: p, body: JSON.parse(req.postData() || '{}') }); return send({}); }
  if (p === 'all') return send({ pages: PAGES, posts: [], settings: { homePath: '/home', baseUrl: 'https://x.ir' } });
  if (p === 'media') return send({ media: MEDIA });
  return send({});
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.fill('#key', 'k');
await page.click('#gate .btn.pri');
await page.waitForTimeout(600);
ok('the panel opens', await page.isVisible('#app'));

console.log('getting out of the images tab:');
await page.click('#t-media');
await page.waitForTimeout(400);
ok('the images tab really opened', (await page.textContent('#body')).includes('کتابخانه'));
ok('the tab bar is still on the page', await page.isVisible('#t-pages'), 'this is the way out');
ok('so is the header', await page.isVisible('#viewSite'));
await page.click('#t-pages');
await page.waitForTimeout(400);
ok('and clicking another tab leaves', (await page.textContent('#body')).includes('صفحهٔ جدید'));
ok('nothing threw on the way', errors.length === 0, errors.join(' | '));

console.log('choosing a character:');
await page.click('#body .card .btn:has-text("ویرایش")');
await page.waitForTimeout(400);
const hasField = await page.isVisible('.charBtn[data-for="pg_heroCharacter_0"]');
ok('the character field is there', hasField);
/* What the page already had must still be shown, not silently dropped. */
ok('and it still holds what was saved before',
  (await page.inputValue('#pg_heroCharacter_0')) === 'char-thinking.png',
  await page.inputValue('#pg_heroCharacter_0'));

await page.click('.charBtn[data-for="pg_heroCharacter_0"]');
await page.waitForTimeout(400);
const inPicker = await page.evaluate(() => {
  const box = [...document.querySelectorAll('div')].find((d) => d.style.position === 'fixed' && d.style.zIndex === '50');
  if (!box) return null;
  return {
    urls: [...box.querySelectorAll('[data-u]')].map((e) => e.getAttribute('data-u')),
    text: (box.textContent || '').replace(/\s+/g, ' ')
  };
});
ok('the picker opens', !!inPicker);
ok('it offers the design’s own characters', (inPicker?.urls || []).some((u) => /^char-/.test(u)),
  (inPicker?.urls || []).filter((u) => /^char-/.test(u)).length + ' characters');
ok('AND the pictures uploaded from this same panel', (inPicker?.urls || []).includes('/media/abc-123'),
  (inPicker?.urls || []).filter((u) => u.startsWith('/media/')).join(' '));
ok('each upload is named so it can be told apart', /ghahreman\.webp/.test(inPicker?.text || ''));

await page.click('[data-u="/media/abc-123"]');
await page.waitForTimeout(400);
ok('picking an upload puts it in the field',
  (await page.inputValue('#pg_heroCharacter_0')) === '/media/abc-123',
  await page.inputValue('#pg_heroCharacter_0'));
const shown = await page.getAttribute('[data-prev="pg_heroCharacter_0"] img', 'src');
ok('and shows it, so it is obvious what will appear', shown === '/media/abc-123', String(shown));

/* A bare design filename must still resolve to where the site serves it — the
   same rule assetUrl() uses, or the preview and the page disagree. */
await page.click('.charBtn[data-for="pg_heroCharacter_0"]');
await page.waitForTimeout(300);
await page.click('[data-u^="char-"]');
await page.waitForTimeout(300);
const charSrc = await page.getAttribute('[data-prev="pg_heroCharacter_0"] img', 'src');
ok('a design character previews from /site-assets/', /^\/site-assets\/char-/.test(String(charSrc)), String(charSrc));

/* Put the upload back, and prove it survives the save. */
await page.click('.charBtn[data-for="pg_heroCharacter_0"]');
await page.waitForTimeout(300);
await page.click('[data-u="/media/def-456"]');
await page.waitForTimeout(300);

console.log('and it sits in its place:');
await page.click('#body .btn.pri:has-text("ذخیرهٔ صفحه")');
await page.waitForTimeout(600);
const put = saved.find((s) => s.path === 'pages');
ok('the page is saved', !!put, saved.map((s) => s.path).join(','));
ok('with the uploaded picture as its character', put?.body?.heroCharacter === '/media/def-456', String(put?.body?.heroCharacter));

/* The block-level character field is the same control and must behave the same. */
await page.waitForTimeout(300);
await page.click('#body .card .btn:has-text("ویرایش")');
await page.waitForTimeout(400);
const blockBtn = await page.isVisible('.charBtn[data-for="bk_0_0_character"]');
ok('a block’s character field is the same picker', blockBtn);
if (blockBtn) {
  await page.click('.charBtn[data-for="bk_0_0_character"]');
  await page.waitForTimeout(300);
  await page.click('[data-u="/media/abc-123"]');
  await page.waitForTimeout(300);
  ok('and an upload lands in it too',
    (await page.inputValue('#bk_0_0_character')) === '/media/abc-123',
    await page.inputValue('#bk_0_0_character'));
  await page.click('.charClr[data-for="bk_0_0_character"]');
  await page.waitForTimeout(300);
  ok('«برداشتن» empties it again', (await page.inputValue('#bk_0_0_character')) === '');
}

ok('no script error in the whole run', errors.length === 0, errors.join(' | '));
await page.screenshot({ path: '/tmp/adminpicker.jpg', type: 'jpeg', quality: 84, fullPage: false });
console.log(`\n[adminpicker] ${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
