/* A CRASH NOBODY HEARD.
 *
 * The server has had `error_reports` all along — status, severity, source,
 * stack, «who resolved it», three endpoints, a migration. Nothing wrote to it
 * and nothing read it. Every crash on every player's phone happened in silence,
 * and the only way one was ever learned about was a player taking the trouble
 * to open a ticket and describe it in their own words.
 *
 * Two things have to hold for the pipe to be worth opening at all:
 *
 *   1. NOTHING PRIVATE TRAVELS WITH IT. A message and a URL carry whatever was
 *      in scope — the player's number, the SMS code, the session token. This is
 *      a real-money game and the screen these land on is opened by employees.
 *      Data stored once is stored for good.
 *   2. ONE CRASH IS ONE JOB. A bug inside a render loop writes thousands of
 *      rows. A flat list shows that bug and nothing else, and the rare crash —
 *      the one that loses a payment — is on page forty.
 *
 * Run: npx tsx src/tests/errorReports.test.ts
 *      DATABASE_URL=… npx tsx src/tests/errorReports.test.ts   (+ the table)
 */
import assert from 'node:assert/strict';
import { scrubText, scrubRoute, scrubMeta, fingerprint, latinDigits } from '../services/errorScrub.js';
import { createErrorReport, errorGroups, updateErrorGroupStatus } from '../services/errorReportService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* The messages this file writes, and nothing else. */
const OWN = ['%boom at line%', 'RangeError: once', 'login failed for%'];
async function clearOwnRows(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const { getPgPool } = await import('../database/postgres.js');
  const pool = getPgPool();
  for (const like of OWN) await pool.query(`DELETE FROM error_reports WHERE message LIKE $1`, [like]);
}

(async () => {
  /* ── WHAT MUST NEVER REACH THE TABLE ──────────────────────────────────── */

  await check('a phone number does not travel with the crash', () => {
    assert.ok(!scrubText('failed for 09121234567').includes('09121234567'));
    assert.ok(!scrubText('user +989121234567 wallet').includes('9121234567'));
    assert.ok(!scrubText('to 989121234567').includes('9121234567'));
    /* The Persian spelling is what a Persian keyboard actually produces, and it
       is handed to the API unchanged — a rule that only knows Latin digits
       would let every one of those straight through. */
    assert.ok(!latinDigits('۰۹۱۲۱۲۳۴۵۶۷').includes('۹'));
    assert.ok(!scrubText('شماره ۰۹۱۲۱۲۳۴۵۶۷ نشد').includes('9121234567'));
  });

  await check('nor a card number, whatever way it was spaced', () => {
    for (const c of ['6274129005473742', '6274 1290 0547 3742', '6274-1290-0547-3742']) {
      const out = scrubText('card ' + c);
      assert.ok(out.includes('[کارت]'), c + ' survived: ' + out);
      assert.ok(!/\d{6}/.test(out), c + ' left digits behind: ' + out);
    }
  });

  await check('nor a token, labelled or bare', () => {
    assert.ok(!scrubText('token=at_' + 'a1b2c3d4'.repeat(6)).includes('at_a1b2'));
    assert.ok(!scrubText('at_' + 'f0'.repeat(20) + ' expired').includes('f0f0f0'));
    assert.ok(!scrubText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef').includes('eyJhbGci'));
    assert.ok(!scrubText('{"password":"hunter2","x":1}').includes('hunter2'));
  });

  await check('nor the SMS code, which is the whole account', () => {
    assert.ok(!scrubText('otp=4209 wrong').includes('4209'));
    assert.ok(!scrubText('verification_code: 819233').includes('819233'));
  });

  await check('but the crash is still recognisable afterwards', () => {
    /* A scrub that eats the message leaves a queue of identical blanks, which
       is the same as having no queue. */
    const out = scrubText("TypeError: cannot read 'balance' of undefined at pzWallet (index.html:4120)");
    assert.ok(out.includes('TypeError'), out);
    assert.ok(out.includes('pzWallet'), out);
    assert.ok(out.includes('balance'), out);
  });

  await check('a URL keeps WHICH SCREEN and loses what was on it', () => {
    /* The path is the single most useful field on the record. The query string
       is where the app puts the things it was asked not to keep. */
    const r = scrubRoute('/game?phone=09121234567&code=4209&ref=abc');
    assert.ok(r.startsWith('/game'), r);
    assert.ok(!r.includes('09121234567') && !r.includes('4209') && !r.includes('abc'), r);
    assert.ok(r.includes('phone') && r.includes('code'), 'the NAMES are useful and are kept: ' + r);
    assert.equal(scrubRoute('/shop'), '/shop');
  });

  await check('metadata is judged by its key as well as its value', () => {
    const m = scrubMeta({ screen: 'home', token: 1, phone: 'x', w: 390, note: 'call 09121234567' });
    assert.equal(m.screen, 'home');
    assert.equal(m.w, 390);
    /* «token: 1» is not safer than «token: "at_…"» — it is only shorter, and
       the key is the part that says what the value is for. */
    assert.ok(String(m.token).includes('توکن'), JSON.stringify(m));
    assert.ok(String(m.phone).includes('توکن'), JSON.stringify(m));
    assert.ok(!String(m.note).includes('09121234567'), JSON.stringify(m));
  });

  await check('and metadata cannot be used to fill the table', () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) big['k' + i] = 'x'.repeat(5000);
    const m = scrubMeta(big);
    assert.ok(Object.keys(m).length <= 20, Object.keys(m).length + ' keys got through');
    for (const v of Object.values(m)) assert.ok(String(v).length <= 300);
  });

  /* ── ONE CRASH, NOT FOUR THOUSAND OCCURRENCES ─────────────────────────── */

  await check('two occurrences of one bug are one bug', () => {
    const a = fingerprint("TypeError: x of undefined at fit (index.html:4120:17)");
    const b = fingerprint("TypeError: x of undefined at fit (index.html:4188:3)");
    assert.equal(a, b, 'a different line number made it a different bug');
  });

  await check('and two different bugs stay two', () => {
    assert.notEqual(fingerprint('TypeError: x of undefined'), fingerprint('RangeError: too big'));
  });

  await check('a report is stored scrubbed, not scrubbed on the way out', () => {
    /* The difference matters: scrubbing at read time means the raw value is in
       the table, in the backups, and in every dump anybody ever took. */
    return createErrorReport({ message: 'login failed for 09121234567', route: '/otp?code=4209', source: 'frontend', metadata: { phone: '09121234567' } })
      .then((r) => {
        assert.ok(!r.message.includes('09121234567'), r.message);
        assert.ok(!String(r.route).includes('4209'), String(r.route));
        assert.ok(!JSON.stringify(r.metadata).includes('09121234567'), JSON.stringify(r.metadata));
      });
  });

  /* THIS FILE OWNS ITS OWN ROWS. Counting is the whole point of grouping, and
     a table still holding the previous run's five «boom»s makes the next run
     count ten — a failure that says nothing about the code. */
  await clearOwnRows();

  await check('the queue is grouped, and the noisiest is first', async () => {
    for (let i = 0; i < 5; i++) await createErrorReport({ message: `TypeError: boom at line ${i}`, source: 'frontend' });
    await createErrorReport({ message: 'RangeError: once', source: 'frontend' });
    const groups = await errorGroups({ status: 'open', limit: 50 });
    assert.ok(groups.length >= 2, 'nothing was grouped at all');
    const boom = groups.find((g) => g.message.includes('TypeError'))!;
    const once = groups.find((g) => g.message.includes('RangeError'))!;
    assert.ok(boom, 'the repeated crash is missing');
    assert.equal(boom.count, 5, 'five occurrences did not add up to one group of five');
    assert.equal(once.count, 1);
    assert.ok(groups.indexOf(boom) < groups.indexOf(once), 'the one-off was listed above the crash hitting five times');
  });

  await check('and triage works on the group, because nobody marks five thousand rows', async () => {
    const before = await errorGroups({ status: 'open', limit: 50 });
    const boom = before.find((g) => g.message.includes('TypeError'))!;
    const n = await updateErrorGroupStatus(boom.fingerprint, 'resolved', 'system');
    assert.equal(n, 5, 'only ' + n + ' of the five rows were marked');
    const after = await errorGroups({ status: 'open', limit: 50 });
    assert.ok(!after.some((g) => g.fingerprint === boom.fingerprint), 'the group is still in the open queue');
    const done = await errorGroups({ status: 'resolved', limit: 50 });
    assert.ok(done.some((g) => g.fingerprint === boom.fingerprint), 'and it is not in the resolved one either');
  });

  await clearOwnRows();
  console.log(`[errorReports] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
