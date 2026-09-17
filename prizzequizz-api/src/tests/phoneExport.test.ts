/* THE NUMBERS, TO BE SENT FROM SOMEWHERE ELSE.
 *
 * «یه چیزی هم اضافه کن که من بتونم شماره همه کاربرام رو دانلود کنم و همون رو تو
 *  پنل نیازپرداز بزنم و از اونجا بفرستم.»
 *
 * This file exists to be pasted into a sender, so what it contains IS what gets
 * texted. Two things follow from that and they are most of what is checked:
 * somebody on the blacklist must not be in it — they asked the game not to
 * text them, not the panel it is sent from — and the same person must not be in
 * it twice, because that is the same person billed twice.
 *
 * Run: DATABASE_URL=… npx tsx src/tests/phoneExport.test.ts
 */
import assert from 'node:assert/strict';
import { exportUserPhones, phonesAsText, phonesAsCsv, localPhone, phoneDigits } from '../services/phoneExportService.js';
import { addBlacklist, removeBlacklist } from '../services/smsService.js';
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  const pool = getPgPool();
  await pool.query(`DELETE FROM users WHERE username LIKE 'pex\\_%'`);
  const made: string[] = [];
  const mk = async (phone: string, username: string, display: string) => {
    const uid = id(); made.push(uid);
    await pool.query(
      `INSERT INTO users(id, phone, username, display_name, wallet_balance, coins, tickets)
       VALUES ($1,$2,$3,$4,0,0,'{}'::jsonb)`, [uid, phone, username, display]);
    return uid;
  };

  await check('a number is read whatever spelling it was stored in', () => {
    /* Nothing normalises a phone on the way IN, so the column really holds all
       of these — and they are one line. */
    assert.equal(localPhone('09121234567'), '09121234567');
    assert.equal(localPhone('+98 912 123 4567'), '09121234567');
    assert.equal(localPhone('۰۹۱۲۱۲۳۴۵۶۷'), '09121234567');
    assert.equal(localPhone('0912-123-4567'), '09121234567');
    assert.equal(phoneDigits('+989121234567'), '9121234567');
  });

  await mk('09121000001', 'pex_a', 'الف');
  await mk('+98 912 100 0002', 'pex_b', 'ب');
  await mk('۰۹۱۲۱۰۰۰۰۰۳', 'pex_c', 'ج');

  await check('every player is in the file, however their number was typed', async () => {
    const x = await exportUserPhones('all');
    for (const want of ['09121000001', '09121000002', '09121000003']) {
      assert.ok(x.phones.includes(want), want + ' is missing from ' + JSON.stringify(x.phones.slice(0, 8)));
    }
  });

  await check('THE SAME PERSON IS NOT IN IT TWICE', async () => {
    /* Two rows, one line — «+98912…» and «0912…» are the same phone, and a
       duplicate in a file that exists to be pasted into a sender is the same
       person billed twice. */
    await mk('+989121000001', 'pex_dup', 'تکراری');
    const x = await exportUserPhones('all');
    const mine = x.phones.filter((p) => p === '09121000001');
    assert.equal(mine.length, 1, 'the same number came out ' + mine.length + ' times');
    assert.ok(x.skippedDuplicate >= 1, 'and it was not reported as skipped');
  });

  await check('SOMEBODY ON THE BLACKLIST IS NOT IN IT', async () => {
    /* They asked the GAME not to text them. Handing their number over in a file
       whose purpose is to be pasted into a sender is texting them, one step
       removed. */
    await addBlacklist('09121000002');
    try {
      const x = await exportUserPhones('all');
      assert.ok(!x.phones.includes('09121000002'), 'a blacklisted number was exported');
      assert.equal(x.skippedBlacklisted, 1, JSON.stringify(x));
    } finally { await removeBlacklist('09121000002'); }
  });

  await check('and the blacklist is matched on digits, not on spelling', async () => {
    /* Blacklisted as «+98…», stored as «0912…» — one person either way. */
    await addBlacklist('+98 912 100 0003');
    try {
      const x = await exportUserPhones('all');
      assert.ok(!x.phones.includes('09121000003'), 'a blacklisted number escaped through its spelling');
    } finally { await removeBlacklist('+98 912 100 0003'); }
  });

  await check('a number that is not a mobile line is left out and counted', async () => {
    /* Pasting one into a sender is a request that will be refused, and refused
       requests are what got this server's IP blocked in the first place. */
    await mk('021 8899 7766', 'pex_land', 'ثابت');
    const x = await exportUserPhones('all');
    assert.ok(!x.phones.some((p) => p.includes('88997766')), 'a landline went into the file');
    assert.ok(x.skippedMalformed >= 1, JSON.stringify(x));
  });

  await check('unfinished sign-ups can be included or left out', async () => {
    await mk('09121000009', 'user_' + Date.now() + '99', 'بازیکن جدید');
    const all = await exportUserPhones('all');
    const done = await exportUserPhones('registered');
    const ghosts = await exportUserPhones('unfinished');
    assert.ok(all.phones.includes('09121000009'), 'missing from «همه»');
    assert.ok(!done.phones.includes('09121000009'), 'an unfinished sign-up got into «ثبت‌نام کامل»');
    assert.ok(ghosts.phones.includes('09121000009'), 'missing from «ثبت‌نام ناتمام»');
    assert.ok(!ghosts.phones.includes('09121000001'), 'a real player got into «ثبت‌نام ناتمام»');
  });

  await check('the text file is numbers and nothing else', async () => {
    /* It is pasted into a box that expects one number per line; a header or a
       name in it is a line the sender will reject. */
    const x = await exportUserPhones('all');
    const txt = phonesAsText(x);
    const lines = txt.split('\n').filter(Boolean);
    assert.equal(lines.length, x.phones.length);
    assert.ok(lines.every((l) => /^09\d{9}$/.test(l)), 'not every line is a bare number: ' + lines.slice(0, 3).join('|'));
  });

  await check('and the csv keeps who each number belongs to', async () => {
    const x = await exportUserPhones('all');
    const csv = phonesAsCsv(x);
    assert.ok(csv.startsWith('﻿'), 'without a BOM every Persian name opens as mojibake in Excel');
    assert.match(csv, /phone,username,name/);
    assert.match(csv, /"09121000001"/);
  });

  await check('a name with a comma or a quote in it does not break the csv', async () => {
    await mk('09121000010', 'pex_odd', 'علی, "کاپیتان"');
    const csv = phonesAsCsv(await exportUserPhones('all'));
    const row = csv.split('\n').find((l) => l.includes('09121000010')) ?? '';
    /* Three fields, whatever is inside them. */
    assert.equal((row.match(/","/g) || []).length, 2, 'the row split into the wrong number of columns: ' + row);
    assert.ok(row.includes('""کاپیتان""'), 'the quotes were not escaped: ' + row);
  });

  await pool.query(`DELETE FROM users WHERE username LIKE 'pex\\_%' OR phone IN ('09121000009','+989121000001','021 8899 7766')`);
  console.log(`[phoneExport] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
