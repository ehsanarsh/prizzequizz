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
  (0, eval)('CFG = { categories: [{ name: "اطلاعات عمومی", icon: "🧠", enabled: true, order: 1 }, { name: "تاریخ", icon: "🏛️", enabled: true, order: 2 }, { name: "کهنه", icon: "📦", enabled: false, order: 9 }], questionPipeline: { aiEnabled: true, minQuality: 70, generatorModel: "t-claude-sonnet-5" } }');
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
  /* Read through the helper, not off the <select>: the control is a picker with
     a «دستی…» escape, and an id the catalogue does not know lives in the text
     box beside it. The raw select value would be the sentinel. */
  const read = (st) => (0, eval)('aiModelValue')(st);
  return { gen: read('generator'), rev: read('reviewer'), fact: read('factChecker'),
           rawGen: v('ai_m_generator'), isPicker: !!document.querySelector('#ai_m_generator option') };
});
console.log('the model each stage uses:');
ok2('has a field of its own', models.gen !== null && models.rev !== null && models.fact !== null, JSON.stringify(models));
ok2('filled from the server', models.gen === 'claude-sonnet-5' && models.fact === 'claude-opus-5', JSON.stringify(models));
/* «عین همون منو کرکره‌ای باشه تا بتونم راحت انتخاب کنم، نه اینکه اسم مدل رو
   بنویسم» — a typed id is a missing «t-» prefix waiting to happen. */
ok2('and it is a menu, not a box to spell an id into', models.isPicker, String(models.isPicker));
ok2('an id the catalogue does not know still survives', models.rawGen === '__other__' && models.gen === 'claude-sonnet-5',
    models.rawGen + ' → ' + models.gen);

const picker = await page.evaluate(() => {
  const sel = document.getElementById('ai_m_generator');
  const ids = [...sel.querySelectorAll('option')].map((o) => o.value);
  const groups = [...sel.querySelectorAll('optgroup')].map((g) => g.label);
  /* Pick a real one, as the operator would. */
  sel.value = 't-claude-sonnet-5';
  sel.dispatchEvent(new Event('change'));
  return { ids, groups, chosen: (0, eval)('aiModelValue')('generator'),
           otherHidden: document.getElementById('ai_mo_generator').style.display === 'none' };
});
ok2('the provider’s models are all in it', picker.ids.includes('t-claude-opus-5') && picker.ids.includes('t-gpt-5.5') && picker.ids.includes('t-deepseek-v4-pro'),
    picker.ids.length + ' options');
ok2('grouped by who makes them', picker.groups.includes('Anthropic') && picker.groups.includes('OpenAI'), picker.groups.join(', ').slice(0, 60));
ok2('the ones a token key cannot use are kept apart, not hidden',
    picker.groups.some((g) => /t-/.test(g)) && picker.ids.includes('gpt-6-astra'),
    picker.groups.find((g) => /t-/.test(g)) || '(none)');
ok2('choosing one takes effect', picker.chosen === 't-claude-sonnet-5', picker.chosen);
ok2('and the hand-typed box gets out of the way', picker.otherHidden, String(picker.otherHidden));

console.log('saving:');
const saved = await page.evaluate(async () => {
  document.getElementById('ai_p_generator').value = '  سؤال فقط دربارهٔ تاریخ ایران  ';
  document.getElementById('ai_p_reviewer').value = 'سخت بگیر';
  /* The «t-» prefix a token-based key needs — CHOSEN here, not typed into raw
     JSON and not spelled by hand. A <select> only holds one of its own option
     values, so there is no whitespace left to trim on this path; the typed one
     is checked separately below, where whitespace is still possible. */
  document.getElementById('ai_m_generator').value = 't-claude-sonnet-5';
  await (0, eval)('aiSavePrompts')();
  return window.__saved[0] || null;
});
ok2('it sends the prompts under questionPipeline', !!(saved && saved.questionPipeline && saved.questionPipeline.prompts),
  saved ? Object.keys(saved).join(',') : 'nothing sent');
ok2('trimmed', saved.questionPipeline.prompts.generator === 'سؤال فقط دربارهٔ تاریخ ایران',
  JSON.stringify(saved.questionPipeline.prompts.generator));
ok2('all three stages travel together', Object.keys(saved.questionPipeline.prompts).sort().join(',') === 'factChecker,generator,reviewer');
/* And the escape hatch still trims: a model id pasted by hand arrives with the
   spaces the paste brought, and a trailing space is a 404 from the provider. */
const typed = await page.evaluate(async () => {
  const sel = document.getElementById('ai_m_generator');
  sel.value = '__other__'; sel.dispatchEvent(new Event('change'));
  document.getElementById('ai_mo_generator').value = '  t-claude-opus-5  ';
  const before = window.__saved.length;
  await (0, eval)('aiSavePrompts')();
  return window.__saved.slice(before)[0] || null;
});
ok2('a hand-typed id is trimmed before it is sent',
    !!(typed && typed.questionPipeline && typed.questionPipeline.generatorModel === 't-claude-opus-5'),
    JSON.stringify(typed && typed.questionPipeline ? typed.questionPipeline.generatorModel : null));
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

/* ── A RUN THAT KEEPS GOING WHEN YOU LOOK AWAY ──────────────────────────
   «چون زمان‌بر هست، وقتی می‌ری به تب دیگه‌ای اون صفحه کار خودشو بکنه و وقتی
    تموم شد بج بیاد که تموم شد. الان وقتی می‌ره تب دیگه تولید سوال متوقف می‌شه.»
   The request never stopped; leaving the screen threw away the element the
   answer was going to be written into, so it landed in a detached node and the
   operator came back to the PREVIOUS run labelled «اجرای قبلی» — which looks
   exactly like a cancelled one, except the questions really were in the bank
   and nobody was told. */
await page.evaluate(() => {
  /* The «config never loaded» case above deliberately leaves CFG null. Put the
     world back before driving the run, or the topic picker has nothing in it. */
  (0, eval)('CFG = { categories: [{ name: "اطلاعات عمومی", icon: "🧠", enabled: true, order: 1 }, { name: "تاریخ", icon: "🏛️", enabled: true, order: 2 }, { name: "کهنه", icon: "📦", enabled: false, order: 9 }], questionPipeline: { aiEnabled: true } }');
  /* A run that takes its time, and whose answer can be released on demand. */
  window.__release = null;
  const realApi = (0, eval)('api');
  (0, eval)('api = ' + (function (m, p, body) {
    const s = String(p);
    if (m === 'POST' && s.indexOf('/admin/questions/ai/run') >= 0) {
      return new Promise((res) => { window.__release = () => res({ configured: true, requested: 3, generated: 3, added: 2, pending: 1, skipped: [], questions: [{ id: 'q1', text: 'یک', difficulty: 'medium', stage: 'approved', quality: 91, approved: true }] }); });
    }
    if (m === 'PATCH' && s.indexOf('/admin/config') >= 0) { window.__saved.push(body); return Promise.resolve({ ok: true }); }
    return Promise.resolve({});
  }).toString());
  (0, eval)('buildNav = () => {}');
  (0, eval)('paintGroupBar = () => {}');
});
await page.evaluate(async () => { await (0, eval)('renderAiStudio')(); });
await page.waitForTimeout(200);
await page.evaluate(() => {
  /* Chosen from the list, the way an operator now must. */
  const t = document.getElementById('ai_topic');
  t.value = [...t.options].map((o) => o.value).find((v) => /تاریخ/.test(v)) || t.options[1].value;
  document.getElementById('ai_count').value = '3';
});
await page.evaluate(() => { (0, eval)('aiRun')(); });
await page.waitForTimeout(300);

const during = await page.evaluate(() => ({
  running: !!(0, eval)('AI_RUNNING'),
  text: (document.getElementById('ai_out') || {}).innerText || '',
}));
ok2('while it runs, the screen says so', during.running && /در حال ساختن/.test(during.text),
    during.text.replace(/\n/g, ' ').slice(0, 50));
ok2('and names what it is working on', /تاریخ/.test(during.text), during.text.replace(/\n/g, ' ').slice(0, 60));
ok2('and says you may leave', /تب دیگری|تب دیگه/.test(during.text), during.text.replace(/\n/g, ' ').slice(0, 90));

/* Now walk away, exactly as the operator did. */
await page.evaluate(() => { (0, eval)('CUR = "questions"'); document.getElementById('main').innerHTML = '<div>بانک سوالات</div>'; });
await page.waitForTimeout(150);
const awayBefore = await page.evaluate(() => ({ running: !!(0, eval)('AI_RUNNING'), done: (0, eval)('AI_DONE') }));
ok2('leaving the screen does not stop the run', awayBefore.running === true, String(awayBefore.running));
ok2('and nothing is announced before it finishes', awayBefore.done === 0, String(awayBefore.done));

/* It lands while the operator is somewhere else entirely. */
await page.evaluate(() => window.__release());
await page.waitForTimeout(300);
const landed = await page.evaluate(() => ({
  running: !!(0, eval)('AI_RUNNING'),
  done: (0, eval)('AI_DONE'),
  saved: JSON.parse(sessionStorage.getItem('pz_ai_last_run') || 'null')
}));
ok2('the answer is kept even though its screen was gone', !!(landed.saved && landed.saved.r && landed.saved.r.added === 2),
    JSON.stringify(landed.saved && landed.saved.r ? { added: landed.saved.r.added, pending: landed.saved.r.pending } : null));
ok2('the run is marked finished', landed.running === false, String(landed.running));
ok2('and a badge is raised, because the operator is not looking', landed.done === 1, String(landed.done));
ok2('the kept run is marked fresh, not «اجرای قبلی»', landed.saved && landed.saved.fresh === true,
    String(landed.saved && landed.saved.fresh));

/* Coming back: the finished result, and the badge cleared. */
await page.evaluate(async () => { (0, eval)('CUR = "aistudio"'); await (0, eval)('renderAiStudio')(); });
await page.waitForTimeout(300);
const back = await page.evaluate(() => ({
  done: (0, eval)('AI_DONE'),
  text: (document.getElementById('ai_out') || {}).innerText || ''
}));
ok2('coming back shows the finished run', /نتیجهٔ اجرا/.test(back.text), back.text.replace(/\n/g, ' ').slice(0, 40));
ok2('and not as somebody else’s old run', !/اجرای قبلی/.test(back.text), back.text.replace(/\n/g, ' ').slice(0, 60));
ok2('the badge is cleared once it has been seen', back.done === 0, String(back.done));

/* And two runs at once are refused rather than raced. */
await page.evaluate(() => { (0, eval)('AI_RUNNING = { topic: "x", n: 1, at: Date.now() }'); });
const second = await page.evaluate(async () => {
  document.getElementById('ai_topic').value = document.getElementById('ai_topic').options[1].value;
  const before = window.__saved.length;
  await (0, eval)('aiRun')();
  return { still: (0, eval)('AI_RUNNING').topic, saves: window.__saved.length - before };
});
ok2('a second run is refused while one is in flight', second.still === 'x', second.still);
await page.evaluate(() => { (0, eval)('AI_RUNNING = null'); });

/* ── THE GATE, WHERE THE OPERATOR CAN SEE IT ──────────────────────────── */
await page.evaluate(async () => {
  (0, eval)('CFG = { questionPipeline: { aiEnabled: true, minQualityScore: 80, duplicateThreshold: 90 } }');
  await (0, eval)('renderAiStudio')();
});
await page.waitForTimeout(250);
const gate = await page.evaluate(() => {
  const q = document.getElementById('ai_minq'), d = document.getElementById('ai_dupth');
  return { q: q ? q.value : null, d: d ? d.value : null,
           text: (document.getElementById('main') || {}).innerText || '' };
});
ok2('the auto-approve bar is on the screen that uses it', gate.q === '80', String(gate.q));
ok2('and the duplicate threshold beside it', gate.d === '90', String(gate.d));
ok2('the number is a number the browser accepts', /^[0-9]+$/.test(String(gate.q)), String(gate.q));
ok2('and it says what the score is made of', /دقت|اصالت/.test(gate.text), 'rubric shown');
const savedGate = await page.evaluate(async () => {
  document.getElementById('ai_minq').value = '75';
  const before = window.__saved.length;
  await (0, eval)('aiSaveGates')();
  return window.__saved.slice(before)[0] || null;
});
ok2('changing it reaches the server', savedGate && savedGate.questionPipeline && savedGate.questionPipeline.minQualityScore === 75,
    JSON.stringify(savedGate && savedGate.questionPipeline ? savedGate.questionPipeline.minQualityScore : null));

console.log(`\n[aistudio] ${p2} passed, ${f2} failed`);
await browser.close(); server.close();
process.exit(f2 ? 1 : 0);
