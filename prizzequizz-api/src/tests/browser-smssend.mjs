/* TEXTING PLAYERS FROM THE PANEL, WHERE EVERY BUTTON PRESS IS A BILL.
 *
 * «از پنل ادمین باید بتونم به تمامی و یا بعضی از کاربران پیامک بدم.»
 *
 * The screen owes three things a push screen does not, because this one spends
 * money: it must PRICE the run before sending, it must refuse to send a run
 * nobody has priced, and pressing send twice must not bill twice.
 *
 * Run: node src/tests/browser-smssend.mjs */
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 120)));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const PLAN = { audience: 120, reachable: 112, noPhone: 6, blacklisted: 2, parts: 2, messages: 224, overCap: false, description: 'همهٔ کاربران', smsEnabled: true, live: true, max: 2000 };

await page.evaluate((plan) => {
  window.__calls = [];
  window.__plan = plan;
  window.api = async (m, p, body) => {
    const s = String(p);
    window.__calls.push({ m, p: s, body });
    if (s.indexOf('/sms/broadcast/preview') >= 0) return window.__plan;
    if (s.indexOf('/sms/broadcast') >= 0) return { sent: 112, failed: 0, blocked: 2, noPhone: 6, audience: 120, messages: 224, duplicate: false };
    if (s.indexOf('/sms/log') >= 0) return { rows: [] };
    return {};
  };
  (0, eval)('CUR = "sms"');
  (0, eval)('SMS_SUB = "send"');
  try { (0, eval)('confirm = () => true'); } catch (e) {}
}, PLAN);

await page.evaluate(() => (0, eval)('renderSms')());
await page.waitForTimeout(400);

ok('the SMS panel has a screen for texting players', await page.evaluate(() => !!document.getElementById('sb_text')));
ok('and it uses the SAME audience picker as the notification centre',
   await page.evaluate(() => !!document.getElementById('seg_base') && !!document.getElementById('seg_minlvl')));

/* ── nothing may be sent unpriced ───────────────────────────────────────── */
ok('the send button starts disabled, before anything is priced',
   await page.evaluate(() => document.getElementById('sb_go').disabled));

await page.evaluate(() => { document.getElementById('sb_text').value = 'ا'.repeat(80); (0, eval)('smsCountChars')(); });
await page.waitForTimeout(150);
const chars = await page.evaluate(() => document.getElementById('sb_chars').innerText);
ok('a long Persian text is shown as more than one message while typing',
   /۲/.test(chars) && /پیامک/.test(chars), chars);

/* ── pricing ────────────────────────────────────────────────────────────── */
await page.evaluate(() => (0, eval)('smsPreviewSend')());
await page.waitForTimeout(300);
const planText = await page.evaluate(() => document.getElementById('sb_plan').innerText);
ok('the price is given in MESSAGES, not people', /۲۲۴/.test(planText), planText.replace(/\n/g, ' | ').slice(0, 90));
ok('and people who cannot be reached are named', /بدون شماره/.test(planText) && /لیست سیاه/.test(planText));
ok('only now is sending allowed', !(await page.evaluate(() => document.getElementById('sb_go').disabled)));

const previewCall = await page.evaluate(() => window.__calls.filter((c) => c.p.indexOf('/preview') >= 0).length);
ok('pricing it sent nothing', await page.evaluate(() => window.__calls.every((c) => c.p.indexOf('/sms/broadcast') < 0 || c.p.indexOf('/preview') >= 0)), previewCall + ' preview call(s)');

/* ── the sandbox must never read as the real thing ──────────────────────── */
await page.evaluate(() => { window.__plan = { ...window.__plan, live: false }; (0, eval)('smsPreviewSend')(); });
await page.waitForTimeout(300);
ok('a sandbox run says so plainly', /تست/.test(await page.evaluate(() => document.getElementById('sb_plan').innerText)));

await page.evaluate(() => { window.__plan = { ...window.__plan, live: true, smsEnabled: false }; (0, eval)('smsPreviewSend')(); });
await page.waitForTimeout(300);
ok('and a switched-off service says that too', /خاموش/.test(await page.evaluate(() => document.getElementById('sb_plan').innerText)));

/* ── over the cap ───────────────────────────────────────────────────────── */
await page.evaluate(() => { window.__plan = { ...window.__plan, smsEnabled: true, overCap: true }; (0, eval)('smsPreviewSend')(); });
await page.waitForTimeout(300);
ok('a group over the cap cannot be sent at all',
   await page.evaluate(() => document.getElementById('sb_go').disabled));

/* ── sending, once ──────────────────────────────────────────────────────── */
await page.evaluate(() => { window.__plan = { ...window.__plan, overCap: false }; (0, eval)('smsPreviewSend')(); });
await page.waitForTimeout(300);
await page.evaluate(() => (0, eval)('smsDoSend')());
await page.waitForTimeout(400);
const sends = await page.evaluate(() => window.__calls.filter((c) => c.m === 'POST' && c.p.endsWith('/admin/sms/broadcast')));
ok('the send carries an idempotency key', sends.length === 1 && !!sends[0].body.idempotencyKey, JSON.stringify(sends[0]?.body?.idempotencyKey || null));
ok('and the text and audience it was priced with', sends[0]?.body?.text?.length === 80 && !!sends[0]?.body?.segment);

await browser.close(); server.close();
console.log(`[browser-smssend] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
