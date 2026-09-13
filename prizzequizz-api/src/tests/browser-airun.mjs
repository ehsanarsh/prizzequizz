/* THE AI STUDIO, AFTER IT WAS MADE TO FINISH THE JOB.
 *
 * «وقتی سوال ساخته میشه وقتی تب رو عوض میکنه همه سوالات ساخته شده پاک میشه…
 *  باید همه کار رو انجام بده، فقط بعد از اتمام بگه n تعداد سوال طراحی شد و این
 *  سوالات به دیتابیس اضافه شد — ولی واقعا کار کنه.»
 *
 * The old screen asked the model and held the answers in a JavaScript variable
 * for the operator to save one at a time; changing tab threw them away. So what
 * is checked here is not «did a card render» — it is that the screen makes the
 * claim the operator is being given: these are IN the bank, and the report can
 * be left and come back to.
 *
 * Run: node src/tests/browser-airun.mjs */
import pw from '/tmp/node_modules/playwright-core/index.js';
const { chromium } = pw;
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const ROOT = '/home/user/prizzequizz';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const server = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url === '/' ? 'pzadmin.html' : decodeURIComponent(q.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('no'); }
  r.writeHead(200); fs.createReadStream(f).pipe(r);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const STATUS = {
  configured: true, endpoint: 'https://x/v1/messages', keyTail: 'a9f2',
  models: { generator: 'claude-sonnet-5', reviewer: 'claude-sonnet-5', factChecker: 'claude-opus-5' },
  prompts: { generator: '', reviewer: '', factChecker: '' },
  promptDefaults: { generator: 'D1', reviewer: 'D2', factChecker: 'D3' }
};
const MODELS = { ok: true, models: ['claude-opus-5', 'claude-sonnet-5', 't-claude-sonnet-5'] };
const RUN = {
  configured: true, requested: 4, generated: 5, added: 2, pending: 1, max: 25,
  questions: [
    { id: 'q1', text: 'پرسش یکم دربارهٔ جغرافیا', difficulty: 'medium', stage: 'approved', quality: 97, approved: true },
    { id: 'q2', text: 'پرسش دوم دربارهٔ تاریخ', difficulty: 'easy', stage: 'approved', quality: 96, approved: true },
    { id: 'q3', text: 'پرسش سوم که مشکوک است', difficulty: 'hard', stage: 'scored', quality: 61, approved: false, reason: 'صحت پاسخ تأیید نشد' }
  ],
  skipped: [
    { question: 'پرسشی که از قبل داریم', reason: 'duplicate', detail: 'شباهت ۹۴٪ به سؤال موجود' },
    { question: 'پرسش ناقص', reason: 'malformed' }
  ]
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 120)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

await page.evaluate(({ st, md, run }) => {
  window.__calls = [];
  window.api = async (m, p, body) => {
    const s = String(p);
    window.__calls.push(m + ' ' + s + (body ? ' ' + JSON.stringify(body) : ''));
    if (s.indexOf('/ai/status') >= 0) return st;
    if (s.indexOf('/ai/models') >= 0) return md;
    if (s.indexOf('/ai/run') >= 0) return run;
    if (s.indexOf('/bulk/approve') >= 0) return { done: (body.ids || []).length, failed: [] };
    if (m === 'POST' && /\/approve$/.test(s)) return { approved: true };
    if (m === 'DELETE') return { deleted: true };
    return {};
  };
  /* The topic is chosen from the game's own categories now, so the picker needs
     a game to choose from. */
  (0, eval)('CFG = { categories: [{ name: "جغرافیا", icon: "🌍", enabled: true, order: 1 }, { name: "تاریخ", icon: "🏛️", enabled: true, order: 2 }], questionPipeline: { aiEnabled: true } }');
  (0, eval)('CUR = "aistudio"');
  try { (0, eval)('loadCfg = async () => {}'); } catch (e) {}
  try { (0, eval)('confirm = () => true'); } catch (e) {}
}, { st: STATUS, md: MODELS, run: RUN });

await page.evaluate(() => (0, eval)('renderAiStudio')());
await page.waitForTimeout(400);

/* ── the old losing path is gone ────────────────────────────────────────── */
ok('the ask-only path no longer exists at all',
   await page.evaluate(() => typeof (0, eval)('typeof aiGen') === 'string' && (0, eval)('typeof aiGen') === 'undefined'),
   await page.evaluate(() => (0, eval)('typeof aiGen')));
ok('and the button runs the whole job instead',
   await page.evaluate(() => !!document.querySelector('button[onclick*="aiRun()"]')));
ok('there is no «تولید با AI» button left to press by mistake',
   await page.evaluate(() => ![...document.querySelectorAll('button')].some((b) => /^🤖 تولید با AI$/.test(b.textContent.trim()))));

/* ── the model list comes from the provider ─────────────────────────────── */
ok('the models the key can use are offered as a list',
   await page.evaluate(() => document.querySelectorAll('#ai_models option').length) === 3);
/* It is a menu now — «عین همون منو کرکره‌ای باشه تا بتونم راحت انتخاب کنم، نه
   اینکه اسم مدل رو بنویسم» — but the reason the box existed has not gone away:
   some proxies need a prefix nobody's list knows. So the escape stays, one
   option down, rather than the whole control being a place to make typos in. */
ok('the model is chosen from a menu, not spelled',
   await page.evaluate(() => { const el = document.getElementById('ai_m_generator'); return !!el && el.tagName === 'SELECT'; }),
   await page.evaluate(() => (document.getElementById('ai_m_generator') || {}).tagName || 'missing'));
ok('and a proxy that needs its own prefix can still be typed in',
   await page.evaluate(() => {
     const sel = document.getElementById('ai_m_generator');
     sel.value = '__other__'; sel.dispatchEvent(new Event('change'));
     const box = document.getElementById('ai_mo_generator');
     box.value = 'x-custom-model';
     return box.style.display !== 'none' && (0, eval)('aiModelValue')('generator') === 'x-custom-model';
   }));
ok('the topic is chosen from the game’s own list',
   await page.evaluate(() => {
     const t = document.getElementById('ai_topic');
     return !!t && t.tagName === 'SELECT' && [...t.options].some((o) => o.value === 'جغرافیا');
   }),
   await page.evaluate(() => (document.getElementById('ai_topic') || {}).tagName || 'missing'));

/* ── the run, and what it reports ───────────────────────────────────────── */
await page.evaluate(() => { document.getElementById('ai_topic').value = 'جغرافیا'; document.getElementById('ai_count').value = '4'; });
ok('and the topic reaches the run as the game spells it',
   await page.evaluate(() => (0, eval)('aiTopicValue')()) === 'جغرافیا');
await page.evaluate(() => (0, eval)('aiRun')());
await page.waitForTimeout(500);

const body = await page.evaluate(() => document.getElementById('ai_out').innerText);
ok('it says how many actually went into the bank', /تأیید شد و وارد بازی شد/.test(body) && /۲/.test(body), body.slice(0, 80).replace(/\n/g, ' | '));
ok('and how many were kept back', /ذخیره شد ولی تأیید نشد/.test(body));
ok('naming why each one was held', /صحت پاسخ تأیید نشد/.test(body));
ok('and what was refused before being written', /تکراری/.test(body) && /ناقص/.test(body));
ok('a duplicate says what it collided with', /شباهت ۹۴٪/.test(body));

const called = await page.evaluate(() => window.__calls.filter((c) => c.indexOf('/ai/run') >= 0)[0] || '');
ok('the count asked for is the one on screen', /"count":4/.test(called), called.slice(0, 90));
ok('and auto-approve is sent as the operator set it', /"autoApprove":true/.test(called));

/* ── THE COMPLAINT ITSELF: changing tab must not lose it ────────────────── */
await page.evaluate(() => (0, eval)('CUR = "questions"'));
await page.evaluate(() => (0, eval)('renderAiStudio')());
await page.waitForTimeout(400);
const afterTab = await page.evaluate(() => document.getElementById('ai_out').innerText);
ok('leaving the screen and coming back still shows the run',
   /تأیید شد و وارد بازی شد/.test(afterTab), afterTab.slice(0, 70).replace(/\n/g, ' | '));
/* DELIBERATELY THE OTHER WAY ROUND NOW. This used to demand the «اجرای قبلی»
   label here, because the only way back to a result was to find it lying in
   sessionStorage and there was no telling whether it was yours. A finished run
   is announced now — a badge on the sidebar, and the result kept as it lands —
   so calling it «the previous run» in the same breath contradicts the badge.
   The label belongs to a run restored after a RELOAD, which is the case below. */
ok('coming back shows it as the run you just did, not as somebody’s leftovers',
   !/اجرای قبلی/.test(afterTab), afterTab.slice(0, 60).replace(/\n/g, ' | '));
const reloaded = await page.evaluate(async () => {
  /* What a fresh page load sees: the same record, no longer fresh. */
  const v = JSON.parse(sessionStorage.getItem('pz_ai_last_run'));
  v.fresh = false; sessionStorage.setItem('pz_ai_last_run', JSON.stringify(v));
  await (0, eval)('renderAiStudio')();
  return document.getElementById('ai_out').innerText;
});
ok('and after a reload it IS marked as the previous run', /اجرای قبلی/.test(reloaded),
   reloaded.slice(0, 60).replace(/\n/g, ' | '));

/* ── acting on what came back ───────────────────────────────────────────── */
ok('a held question can be approved from here', await page.evaluate(() => !!document.querySelector('button[onclick*="aiOneApprove"]')));
ok('and every question can be deleted', await page.evaluate(() => document.querySelectorAll('button[onclick*="aiOneDelete"]').length) === 3);

await page.evaluate(() => (0, eval)('aiApproveHeld')());
await page.waitForTimeout(400);
const bulk = await page.evaluate(() => window.__calls.filter((c) => c.indexOf('/bulk/approve') >= 0)[0] || '');
ok('approving the held ones goes in ONE request', /"ids":\["q3"\]/.test(bulk), bulk.slice(0, 80));

const after = await page.evaluate(() => document.getElementById('ai_out').innerText);
ok('and the report updates instead of going stale', !/صحت پاسخ تأیید نشد/.test(after));

/* ── clearing it ────────────────────────────────────────────────────────── */
await page.evaluate(() => (0, eval)('aiClearRun')());
await page.waitForTimeout(200);
ok('the report can be dismissed', await page.evaluate(() => document.getElementById('ai_out').innerText.trim() === ''));

await browser.close(); server.close();
console.log(`[browser-airun] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
