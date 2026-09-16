/* ONE PAYMENT SHEET, EVERY DOOR ON IT.
 *
 * «مودال پرداخت باید یکی باشه. وقتی می‌زنی روی دکمهٔ خرید، روش‌های پرداخت بیاد:
 *  صندوق جایزه با نمایش موجودی صندوق — در صورت کم بودن موجودی از قیمت فاکتور،
 *  عدد موجودی قرمز، در غیر این صورت سبز — آنی. کارت به کارت، درگاه امن بلوپال،
 *  ۵ دقیقه. درگاه شاپرک (بزودی)، آنی. تتر (بزودی)، بعد از تأیید شبکه. و با یه
 *  دکمهٔ پرداخت با رنگ سبز. یکی رو کاربر انتخاب می‌کنه و پرداخت می‌کنه.»
 *
 * There used to be two sheets: one to choose a door, and a second to confirm
 * the door — which said nothing the first had not. What is checked here is that
 * there is ONE, that every door is on it, and above all that what the green
 * button SENDS is the door that is lit. A sheet whose selection does not reach
 * the server is a sheet that lies.
 *
 * Run: node src/tests/browser-paysheet.mjs */
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

const PRICE = 125000;
const GATEWAY_URL = 'https://blupal.net/pay/9001';
const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A primed session, with the quote saying what this run is about. */
async function open(o = {}) {
  const vault = o.vault ?? 900000;
  const gatewayOn = o.gatewayOn !== false;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await ctx.addInitScript(() => {
    localStorage.setItem('pz_tok', 't'); localStorage.setItem('pz_rtok', 'r');
    localStorage.setItem('pz_usr', JSON.stringify({ id: 'u1', username: 'ehsan', displayName: 'احسان', level: 5, xp: 900, wallet: 0, coins: 100, hearts: 4 }));
    for (const k of ['leaderboard', 'missions', 'shop', 'wheel']) localStorage.setItem('pq_tut_' + k, '1');
    try { sessionStorage.setItem('pz_push_asked_visit', '1'); } catch (e) {}
  });
  const paid = [];
  const quoted = [];
  await ctx.route('**/v1/**', (route) => {
    const u = route.request().url();
    let body = { ok: true, data: {} };
    if (u.includes('/orders/quote')) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      const code = String(b.discountCode || '').trim().toUpperCase();
      quoted.push(code);
      /* The server's own shape: it prices the code and hands back BOTH figures.
         The sheet never works a price out for itself. */
      const off = code === 'EID20' ? Math.floor(PRICE * 0.2) : 0;
      const bad = code && !off ? 'این کد معتبر نیست.' : '';
      const due = PRICE - off;
      body = { ok: true, data: { amount: due, listPrice: PRICE, discount: off,
        discountCode: off ? 'Eid20' : '', discountError: bad, currency: 'cash', label: 'بلیط سبز',
        vaultBalance: vault, canPayFromVault: vault >= due, canPayByGateway: gatewayOn } };
    } else if (u.includes('/orders/pay')) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      paid.push(b);
      body = b.method === 'vault'
        ? { ok: true, data: { method: 'vault', granted: [{ value: 1, label: 'بلیط سبز' }] } }
        : { ok: true, data: { method: 'gateway', intentId: 'int-1', amount: PRICE, status: 'pending', paymentUrl: GATEWAY_URL } };
    } else if (u.includes('/payments/gateway')) {
      body = { ok: true, data: { cardToCard: true, mode: 'live', live: true, logo: LOGO, label: 'پرداخت امن با بلو پال' } };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const wentTo = [];
  await ctx.route('https://blupal.net/**', (route) => { wentTo.push(route.request().url()); route.fulfill({ status: 200, contentType: 'text/html', body: '<html>blupal</html>' }); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error: ' + String(e).slice(0, 140)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5400);
  return { ctx, page, paid, quoted, wentTo };
}

const buy = async (page) => {
  await page.evaluate(() => { window.__bought = (0, eval)('pzBuyOrder')({ kind: 'ticket', tier: 'green', qty: 1 }, 'بلیط سبز'); });
  await page.waitForTimeout(700);
};
/** Every method row, as a person reading the sheet would see it. */
const rows = (page) => page.evaluate(() => [...document.querySelectorAll('#pmList .pm')].map((el) => {
  const note = el.querySelector('.pm-note');
  const cs = note ? getComputedStyle(note) : null;
  return {
    text: el.innerText.replace(/\s+/g, ' ').trim(),
    on: el.classList.contains('on'),
    off: el.classList.contains('off'),
    soon: !!el.querySelector('.pm-soon'),
    when: (el.querySelector('.pm-when') || {}).textContent || '',
    noteColor: cs ? cs.color : '',
    clickable: !!el.getAttribute('onclick'),
    cursor: getComputedStyle(el).cursor
  };
}));
const pick = async (page, needle) => {
  await page.evaluate((n) => {
    const el = [...document.querySelectorAll('#pmList .pm')].find((x) => x.innerText.includes(n));
    if (el) el.click();
  }, needle);
  await page.waitForTimeout(250);
};
const payNow = async (page) => {
  await page.evaluate(() => { const b = document.getElementById('aaaPrimary'); if (b) b.click(); });
  await page.waitForTimeout(900);
};

/* ── 1. ONE SHEET, AND EVERYTHING ON IT ─────────────────────────────────── */
console.log('the payment sheet:');
{
  const { ctx, page } = await open();
  await buy(page);

  const sheets = await page.evaluate(() => document.querySelectorAll('#aaaModal.show, .modal-bg').length);
  ok('buying opens one sheet, not two', sheets === 1, String(sheets));

  const r = await rows(page);
  ok('all four ways to pay are on it', r.length === 4, r.length + ' rows');
  const names = r.map((x) => x.text);
  ok('صندوق جایزه is one of them', /صندوق جایزه/.test(names[0]), names[0]);
  ok('and بلو پال, said as card-to-card', /بلو پال/.test(names[1]) && /کارت به کارت/.test(names[1]), names[1]);
  ok('and شاپرک', /شاپرک/.test(names[2]), names[2]);
  ok('and تتر', /تتر/.test(names[3]), names[3]);

  ok('the price is on the sheet, big and on its own', await page.evaluate(() => {
    const el = document.querySelector('#aaaModal .aaa-amount b');
    return !!el && /۱۲۵٬۰۰۰/.test(el.textContent) && parseFloat(getComputedStyle(el).fontSize) >= 20;
  }));

  /* «آنی» / «حدود ۵ دقیقه» / «بعد از تأیید شبکه» — how long each door takes is
     the thing that decides between them once the price is known. */
  ok('the صندوق says it is instant', /آنی/.test(r[0].when), r[0].when);
  ok('card-to-card says how long it really takes', /۵ دقیقه/.test(r[1].when), r[1].when);
  ok('شاپرک says instant too', /آنی/.test(r[2].when), r[2].when);
  ok('and تتر says it waits for the network', /شبکه/.test(r[3].when), r[3].when);

  await ctx.close();
}

/* ── 2. THE BALANCE, IN THE COLOUR OF ITS OWN ANSWER ────────────────────── */
{
  const { ctx, page } = await open({ vault: 900000 });   /* more than the 125,000 bill */
  await buy(page);
  const r = await rows(page);
  ok('a صندوق that can cover the bill shows its balance in green',
     /۹۰۰٬۰۰۰/.test(r[0].text) && /92, 255, 168|rgb\(92/.test(r[0].noteColor), r[0].noteColor + ' — ' + r[0].text.slice(0, 34));
  ok('and it is the row the sheet opens on', r[0].on && !r[0].off, JSON.stringify({ on: r[0].on, off: r[0].off }));
  await ctx.close();
}
{
  const { ctx, page } = await open({ vault: 40000 });    /* short of the bill */
  await buy(page);
  const r = await rows(page);
  ok('a صندوق that cannot shows the SAME number in red',
     /۴۰٬۰۰۰/.test(r[0].text) && /255, 143, 130|rgb\(255/.test(r[0].noteColor), r[0].noteColor + ' — ' + r[0].text.slice(0, 40));
  ok('and says why, rather than just refusing', /کافی نیست/.test(r[0].text), r[0].text.slice(0, 40));
  ok('it cannot be chosen', r[0].off && !r[0].clickable, JSON.stringify({ off: r[0].off, click: r[0].clickable }));
  ok('so the sheet opens on the door that IS open', r[1].on, JSON.stringify(r.map((x) => x.on)));
  await ctx.close();
}

/* ── 3. THE DOORS THAT ARE NOT OPEN YET ─────────────────────────────────── */
{
  const { ctx, page } = await open();
  await buy(page);
  const r = await rows(page);
  ok('شاپرک says «بزودی»', r[2].soon && /بزودی/.test(r[2].text), r[2].text);
  ok('تتر says «بزودی» too', r[3].soon && /بزودی/.test(r[3].text), r[3].text);
  ok('neither is pressable, because there is nothing behind them',
     !r[2].clickable && !r[3].clickable && r[2].cursor !== 'pointer' && r[3].cursor !== 'pointer',
     r[2].cursor + '/' + r[3].cursor);
  ok('and they look shut, not merely unlit', r[2].off && r[3].off);

  /* Tapping one must change nothing — not the selection, not the button. */
  await pick(page, 'شاپرک');
  const after = await rows(page);
  ok('tapping «بزودی» does not move the selection',
     after[2].on === false && after.filter((x) => x.on).length === 1 && after[0].on,
     JSON.stringify(after.map((x) => x.on)));
  await ctx.close();
}

/* ── 4. ONE GREEN BUTTON ────────────────────────────────────────────────── */
{
  const { ctx, page } = await open();
  await buy(page);
  const btn = await page.evaluate(() => {
    const p = document.getElementById('aaaPrimary'), sec = document.getElementById('aaaSecondary');
    const row = document.getElementById('aaaActions');
    return { text: p.textContent.trim(), bg: getComputedStyle(p).backgroundImage,
             w: Math.round(p.getBoundingClientRect().width), row: Math.round(row.getBoundingClientRect().width),
             secShown: sec.offsetParent !== null, disabled: p.disabled,
             x: document.getElementById('aaaClose').offsetParent !== null };
  });
  ok('there is one button and it says «پرداخت»', /پرداخت/.test(btn.text), btn.text);
  ok('it is green', /63, 208, 122|rgb\(63/.test(btn.bg), btn.bg.slice(0, 44));
  ok('it takes the whole row', btn.w >= btn.row - 2, btn.w + ' of ' + btn.row);
  ok('«بعداً» is not beside it', !btn.secShown);
  ok('and the ✕ is still the way out', btn.x);
  ok('with a door lit, the button is live', !btn.disabled);
  await ctx.close();
}

/* ── 5. WHAT THE BUTTON ACTUALLY SENDS ──────────────────────────────────── */
{
  const { ctx, page, paid } = await open();          /* صندوق can cover it */
  await buy(page);
  await payNow(page);
  ok('pressing پرداخت on the صندوق pays from the صندوق',
     paid.length === 1 && paid[0].method === 'vault', JSON.stringify(paid));
  await ctx.close();
}
{
  const { ctx, page, paid, wentTo } = await open();
  await buy(page);
  await pick(page, 'بلو پال');
  const sel = await rows(page);
  ok('choosing the gateway lights the gateway', sel[1].on && !sel[0].on, JSON.stringify(sel.map((x) => x.on)));
  await payNow(page);
  ok('and پرداخت then pays by the gateway',
     paid.length === 1 && paid[0].method === 'gateway', JSON.stringify(paid));
  /* The whole point of merging the two sheets: no second card in between. */
  ok('the player goes straight there — there is no second sheet',
     wentTo.some((u) => u.startsWith('https://blupal.net/')) || page.url().startsWith('https://blupal.net/'),
     wentTo[0] || page.url());
  await ctx.close();
}

/* ── 6. WHEN NO DOOR IS OPEN ────────────────────────────────────────────── */
{
  const { ctx, page, paid } = await open({ vault: 40000, gatewayOn: false });
  await buy(page);
  const st = await page.evaluate(() => {
    const p = document.getElementById('aaaPrimary');
    const rows = [...document.querySelectorAll('#pmList .pm')];
    const gw = rows.find((el) => /بلو پال/.test(el.innerText));
    return { disabled: p.disabled,
             gateway: gw ? gw.innerText.replace(/\s+/g, ' ').trim() : '(no gateway row)',
             text: (document.getElementById('aaaModal') || {}).innerText || '' };
  });
  /* Read off the GATEWAY'S OWN ROW, not the whole sheet: «هیچ روش پرداختی در
     دسترس نیست» is on the sheet too, and matching that instead made this pass
     however the row itself read. */
  ok('a gateway switched off says so on its own row', /در دسترس نیست/.test(st.gateway), st.gateway.slice(0, 80));
  ok('and the sheet says plainly that there is no way to pay',
     /هیچ روش پرداختی/.test(st.text), st.text.replace(/\s+/g, ' ').slice(0, 70));
  ok('nothing is lit, so the button cannot be pressed', st.disabled, String(st.disabled));
  await payNow(page);
  ok('and pressing it anyway buys nothing', paid.length === 0, JSON.stringify(paid));
  /* The disabled button is the first guard. This is the second one, reached on
     purpose: if anything ever re-enables that button — a stale render, a
     future edit — pressing it must still not buy something nobody chose. */
  await page.evaluate(() => { const b = document.getElementById('aaaPrimary'); b.disabled = false; b.click(); });
  await page.waitForTimeout(700);
  ok('and it still buys nothing even with the button forced live', paid.length === 0, JSON.stringify(paid));
  await ctx.close();
}

/* ── 7. THE DISCOUNT CODE ───────────────────────────────────────────────── */
/*
 * «و کد تخفیف هم باید باشه.»
 *
 * The rule the sheet must never break: it does not work out a price. It sends
 * the code and shows what comes back. So what is checked is what it SENDS and
 * what it then DISPLAYS — never that it computed 20% correctly, because it must
 * not be computing anything.
 */
console.log('the discount code:');
{
  const { ctx, page, paid, quoted } = await open();
  await buy(page);
  ok('there is somewhere to type a code', await page.evaluate(() => !!document.getElementById('pmCode')));

  const type = async (code) => {
    await page.evaluate((c) => { document.getElementById('pmCode').value = c; }, code);
    await page.evaluate(() => document.getElementById('pmCodeBtn').click());
    await page.waitForTimeout(600);
  };
  const shown = () => page.evaluate(() => {
    const p = document.getElementById('pmPrice');
    return { text: p ? p.innerText.replace(/\s+/g, ' ').trim() : '',
             was: !!document.querySelector('#pmPrice .pm-was'),
             err: (document.getElementById('pmCodeErr') || {}).textContent || '' };
  });

  await type('eid20');
  ok('applying a code asks the SERVER what it is worth',
     quoted.includes('EID20'), JSON.stringify(quoted));
  const s1 = await shown();
  ok('the new price is shown', /۱۰۰٬۰۰۰/.test(s1.text), s1.text);
  ok('and the old one beside it, struck through — otherwise there is nothing to see',
     s1.was && /۱۲۵٬۰۰۰/.test(s1.text), s1.text);
  ok('with what was saved said in words', /۲۵٬۰۰۰ تومان تخفیف/.test(s1.text), s1.text);
  ok('and no error while it is working', !s1.err, s1.err);

  /* The صندوق row has to re-read the NEW price — a balance that could not cover
     the full amount may well cover what is left. */
  const row = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#pmList .pm')][0];
    return { text: el.innerText.replace(/\s+/g, ' ').trim(), on: el.classList.contains('on') };
  });
  ok('the doors are re-read against the discounted price', row.on, row.text.slice(0, 40));

  await payNow(page);
  ok('and paying sends the code, so the server prices it again',
     paid.length === 1 && String(paid[0].discountCode).toUpperCase() === 'EID20', JSON.stringify(paid));
  await ctx.close();
}
{
  const { ctx, page, quoted } = await open();
  await buy(page);
  await page.evaluate(() => { document.getElementById('pmCode').value = 'nope'; });
  await page.evaluate(() => document.getElementById('pmCodeBtn').click());
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({
    err: (document.getElementById('pmCodeErr') || {}).textContent || '',
    text: (document.getElementById('pmPrice') || {}).innerText || '',
    was: !!document.querySelector('#pmPrice .pm-was')
  }));
  ok('a code that is not real says so', /معتبر/.test(s.err), s.err);
  ok('and the price does not move', !s.was && /۱۲۵٬۰۰۰/.test(s.text), s.text.replace(/\s+/g, ' '));
  await ctx.close();
}
{
  /* A code applied by mistake has to be removable, or the player closes the
     sheet and starts again — which is where purchases get abandoned. */
  const { ctx, page, quoted } = await open();
  await buy(page);
  await page.evaluate(() => { document.getElementById('pmCode').value = 'eid20'; });
  await page.evaluate(() => document.getElementById('pmCodeBtn').click());
  await page.waitForTimeout(600);
  const label = await page.evaluate(() => document.getElementById('pmCodeBtn').textContent.trim());
  ok('once applied, the button offers to take it off', /برداشتن/.test(label), label);
  await page.evaluate(() => document.getElementById('pmCodeBtn').click());
  await page.waitForTimeout(600);
  const s = await page.evaluate(() => ({
    text: (document.getElementById('pmPrice') || {}).innerText || '',
    was: !!document.querySelector('#pmPrice .pm-was')
  }));
  ok('and taking it off puts the price back', !s.was && /۱۲۵٬۰۰۰/.test(s.text), s.text.replace(/\s+/g, ' '));
  ok('by asking the server for a price with no code', quoted[quoted.length - 1] === '', JSON.stringify(quoted));
  await ctx.close();
}

/* ── 8. BACKING OUT ─────────────────────────────────────────────────────── */
{
  const { ctx, page, paid } = await open();
  await buy(page);
  await page.evaluate(() => document.getElementById('aaaClose').click());
  await page.waitForTimeout(400);
  ok('the ✕ closes the sheet', await page.evaluate(() => {
    const m = document.getElementById('aaaModal');
    return !m || !m.classList.contains('show');
  }));
  ok('and nothing was bought', paid.length === 0, JSON.stringify(paid));
  ok('and no half-finished payment is left behind',
     await page.evaluate(() => localStorage.getItem('pz_pay_pending')) === null);
  await ctx.close();
}

await browser.close(); server.close();
console.log(`[paysheet] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
