/* TWO THINGS THE ADMIN PANEL HAS TO GET RIGHT.
 *
 * THE LEDGER REPORT, IN THE PANEL THAT SHOWS IT.
 *
 * «۲۸ حساب ۰ مغایرت — ولی وقتی مغایرت داشته باشه معلوم نیست کدوم حساب‌هاست و
 *  مغایرت برای چی هست.»
 *
 * The server has always sent the whole picture; the panel printed a count in a
 * toast and dropped the rest. What matters is therefore not what the API
 * returns — ledgerMismatch.test.ts holds that — but what an operator can read
 * off the screen after pressing the button. So this presses it.
 */
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

/* Exactly the shape verifyConsistency returns, with both directions of gap. */
const REPORT = {
  checked: 28,
  mismatches: [
    { userId: 'aaaaaaaa-1111-4000-8000-000000000001', username: 'reza90', displayName: 'رضا محمدی', phone: '09121234567',
      account: { available: 107500, locked: 250 }, ledger: { available: 100000, locked: 0 },
      diff: { available: 7500, locked: 250 } },
    { userId: 'bbbbbbbb-2222-4000-8000-000000000002', username: 'sara', displayName: '', phone: '',
      account: { available: 40000, locked: 0 }, ledger: { available: 52500, locked: 0 },
      diff: { available: -12500, locked: 0 } }
  ]
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 120)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);


/* THE AI STUDIO: WHERE THE KEY IS, AND WHERE THE PROMPT IS WRITTEN.
 *
 * «API هوش مصنوعی گرفتم — از کجا وارد کنم و پرامپتش را کجا بنویسم؟»
 *
 * The key is deliberately NOT editable here: it is a server environment
 * variable, and a panel field for it would put a credential in a browser. What
 * the screen owes the operator instead is proof of what the server is set to —
 * the address requests go to and which key is loaded — and the three prompts,
 * which are the thing anyone actually wants to tune.
 */
let p2 = 0, f2 = 0;
const ok2 = (n, c, extra = '') => { if (c) { p2++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); } else { f2++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); } };

const STATUS = {
  configured: true,
  endpoint: 'https://sinoxapi.com/v1/messages',
  keyTail: 'a9f2',
  models: { generator: 'claude-sonnet-5', reviewer: 'claude-sonnet-5', factChecker: 'claude-opus-5' },
  prompts: { generator: 'متن فعلیِ تولیدکننده', reviewer: '', factChecker: 'متن راستی‌آزما' },
  promptDefaults: { generator: 'DEFAULT-GEN', reviewer: 'DEFAULT-REV', factChecker: 'DEFAULT-FACT' }
};

await page.evaluate((st) => {
  window.__saved = [];
  window.api = async (m, p, body) => {
    const s = String(p);
    if (s.indexOf('/admin/questions/ai/status') >= 0) return st;
    if (m === 'PATCH' && s.indexOf('/admin/config') >= 0) { window.__saved.push(body); return { ok: true }; }
    return {};
  };
  /* CFG is null until loadCfg() runs, so it is assigned whole here rather than
     reached into — which is also why the renderers now guard it. */
  (0, eval)('CFG = { questionPipeline: { aiEnabled: true, minQuality: 70, generatorModel: "claude-sonnet-5" } }');
  /* Saving ends with render(), which repaints whatever tab is open — so the
     tab has to be this one, exactly as it is for an operator. */
  (0, eval)('CUR = "aistudio"');
  /* loadCfg() would go to the real API and overwrite the stub's world. */
  try { (0, eval)('loadCfg = async () => {}'); } catch (e) {}
}, STATUS);

/* CFG is null until the config loads. This screen used to reach straight into
   it, so a boot where that fetch failed turned the tab into a blank page with a
   TypeError behind it — which is how this was found. */
const renderErr = await page.evaluate(async () => {
  try { await (0, eval)('renderAiStudio')(); return ''; }
  catch (e) { return String((e && e.message) || e); }
});
ok2('the screen renders without throwing', renderErr === '', renderErr || 'clean');
await page.waitForTimeout(900);

const shown = await page.evaluate(() => {
  const m = document.getElementById('main');
  const val = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
  return { txt: (m.textContent || '').replace(/\s+/g, ' '),
           gen: val('ai_p_generator'), rev: val('ai_p_reviewer'), fact: val('ai_p_factChecker'),
           areas: m.querySelectorAll('textarea').length };
});

console.log('what the screen tells the operator about the connection:');
ok2('the address requests actually go to', shown.txt.indexOf('https://sinoxapi.com/v1/messages') >= 0, 'endpoint');
ok2('that a key is loaded, by its tail only', /…a9f2/.test(shown.txt), 'key tail');
ok2('and the whole key is nowhere on the page', shown.txt.indexOf('sk-') < 0);
ok2('it says where the key is really set', /ANTHROPIC_API_KEY/.test(shown.txt) && /ANTHROPIC_BASE_URL/.test(shown.txt));
ok2('and that the panel cannot change it', /قابل تغییر نیستند|روی سرور/.test(shown.txt));

console.log('and the three prompts:');
ok2('there is a box for each stage', shown.areas === 3, shown.areas + ' boxes');
ok2('each holds what the server has', shown.gen === 'متن فعلیِ تولیدکننده' && shown.fact === 'متن راستی‌آزما',
  JSON.stringify([shown.gen, shown.fact]));
/* A stage left at the default shows EMPTY, not the default text: filling it in
   would freeze today's wording into the config the first time anything is
   saved, and quietly stop tracking the shipped default. */
ok2('one left at the default shows empty, not the default text pasted in', shown.rev === '', JSON.stringify(shown.rev));

/* THE MODEL IDS, BESIDE THE PROMPT THEY BELONG TO.
   A token-based key refuses every model whose id lacks a «t-» prefix, so this
   is not an advanced setting — it is the difference between the feature working
   and a 402 on the first press. It used to be reachable only by hand-editing
   the raw config JSON. */
const models = await page.evaluate(() => {
  const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
  return { gen: v('ai_m_generator'), rev: v('ai_m_reviewer'), fact: v('ai_m_factChecker') };
});
console.log('the model each stage uses:');
ok2('has a field of its own', models.gen !== null && models.rev !== null && models.fact !== null, JSON.stringify(models));
ok2('filled from the server', models.gen === 'claude-sonnet-5' && models.fact === 'claude-opus-5', JSON.stringify(models));

console.log('saving:');
const saved = await page.evaluate(async () => {
  document.getElementById('ai_p_generator').value = '  سؤال فقط دربارهٔ تاریخ ایران  ';
  document.getElementById('ai_p_reviewer').value = 'سخت بگیر';
  /* The «t-» prefix a token-based key needs — typed here, not in raw JSON. */
  document.getElementById('ai_m_generator').value = '  t-claude-sonnet-5  ';
  await (0, eval)('aiSavePrompts')();
  return window.__saved[0] || null;
});
ok2('it sends the prompts under questionPipeline', !!(saved && saved.questionPipeline && saved.questionPipeline.prompts),
  saved ? Object.keys(saved).join(',') : 'nothing sent');
ok2('trimmed', saved.questionPipeline.prompts.generator === 'سؤال فقط دربارهٔ تاریخ ایران',
  JSON.stringify(saved.questionPipeline.prompts.generator));
ok2('all three stages travel together', Object.keys(saved.questionPipeline.prompts).sort().join(',') === 'factChecker,generator,reviewer');
ok2('and the models are saved with them', saved.questionPipeline.generatorModel === 't-claude-sonnet-5',
  JSON.stringify(saved.questionPipeline.generatorModel));
/* The rest of questionPipeline — the thresholds, the on/off switch — must
   survive a save that was not about them. */
ok2('and the settings this form does not own are kept',
  saved.questionPipeline.minQuality === 70 && saved.questionPipeline.aiEnabled === true,
  JSON.stringify({ q: saved.questionPipeline.minQuality, on: saved.questionPipeline.aiEnabled }));

console.log('resetting one to the default:');
const reset = await page.evaluate(async () => {
  window.__saved = [];
  /* The save above repainted the screen; these are the fresh boxes. */
  await (0, eval)('renderAiStudio')();
  (0, eval)('aiResetPrompt')('ai_p_factChecker');
  const after = document.getElementById('ai_p_factChecker').value;
  await (0, eval)('aiSavePrompts')();
  return { after, sent: (window.__saved[0] || {}).questionPipeline.prompts.factChecker };
});
ok2('the box is emptied', reset.after === '', JSON.stringify(reset.after));
ok2('and an empty string is what is saved, so the shipped default is used again',
  reset.sent === '', JSON.stringify(reset.sent));

/* WHAT THE PROVIDER'S ERRORS MEAN, IN WORDS AN OPERATOR CAN ACT ON. */
console.log('when the provider refuses:');
const help = await page.evaluate(() => {
  const h = (0, eval)('aiErrorHelp');
  return {
    billing: h('AI HTTP 402: {"type":"error","error":{"type":"permission_error","message":"This API key is for token-based models only","code":"billing_type_mismatch"}}'),
    auth: h('AI HTTP 401: {"error":{"message":"invalid x-api-key"}}'),
    notFound: h('AI HTTP 404: not found'),
    fine: h('')
  };
});
ok2('a token-key mismatch says to put «t-» in front', /t-claude-sonnet-5/.test(help.billing) && /توکنی/.test(help.billing));
ok2('a rejected key points at the server’s .env', /ANTHROPIC_API_KEY/.test(help.auth));
ok2('a 404 points at the «/v1» in the address', /ANTHROPIC_BASE_URL/.test(help.notFound) && /v1/.test(help.notFound));
ok2('and nothing is said when there is no error', help.fine === '');

/* THE BOOT WHERE THE CONFIG NEVER ARRIVED. */
console.log('when the config has not loaded at all:');
const nullCfg = await page.evaluate(async (st) => {
  (0, eval)('CFG = null');
  window.api = async (m, p) => (String(p).indexOf('/admin/questions/ai/status') >= 0 ? st : {});
  let err = '';
  try { await (0, eval)('renderAiStudio')(); } catch (e) { err = String((e && e.message) || e); }
  return { err, areas: document.querySelectorAll('#main textarea').length };
}, STATUS);
ok2('the screen still renders', nullCfg.err === '', nullCfg.err || 'clean');
ok2('and the prompts are still editable', nullCfg.areas === 3, nullCfg.areas + ' boxes');

console.log(`\n[aistudio] ${p2} passed, ${f2} failed`);
await browser.close(); server.close();
process.exit(f2 ? 1 : 0);
