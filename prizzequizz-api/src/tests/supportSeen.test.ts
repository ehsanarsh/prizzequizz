/* «پشتیبان پیامت را خواند» — و فقط همین جهت.
 *
 * «برای پشتیبانی مهم نیست کاربر سین کرده یا نه؛ برای کاربر مهمه که پشتیبان سین
 *  کرده یا نه.»
 *
 * So the whole feature is one-way on purpose, and the half that must NOT exist
 * is as much a part of it as the half that must: a player opening their own
 * ticket marks nothing, because nobody is waiting to hear that they did.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/supportSeen.test.ts
 */
import assert from 'node:assert/strict';
import { markSupportRead, supportReadAt, _resetSupportSeen } from '../services/supportSeenService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  const T = 'tk-seen-' + Date.now();

  await check('a ticket nobody has opened has not been read', async () => {
    assert.equal(await supportReadAt('tk-never-' + Date.now()), null);
  });

  await check('support opening it is what marks it read', async () => {
    const when = Date.now();
    await markSupportRead(T, when);
    const at = await supportReadAt(T);
    assert.ok(at, 'it was opened and still reads as unread');
    assert.equal(new Date(at!).getTime(), when);
  });

  await check('the mark only ever moves FORWARD', async () => {
    /* An admin opening an old ticket after a newer one must not pull the mark
       back and un-read messages the player was already told were read. */
    const later = Date.now() + 60_000;
    await markSupportRead(T, later);
    await markSupportRead(T, Date.now() - 60_000);      /* an older open */
    assert.equal(new Date((await supportReadAt(T))!).getTime(), later,
      'an older reading moved the mark backwards');
  });

  await check('it survives a restart', async () => {
    if (!process.env.DATABASE_URL) return;             /* nothing to survive into */
    const when = Date.now() + 120_000;
    await markSupportRead(T, when);
    _resetSupportSeen();                                /* the process forgets */
    assert.equal(new Date((await supportReadAt(T))!).getTime(), when,
      'the mark lived only in this process');
  });

  await check('and a ticket with no id asks nothing of anybody', async () => {
    await markSupportRead('');
    assert.equal(await supportReadAt(''), null);
  });

  /* ── THE FALLBACK, ACTUALLY RUN ───────────────────────────────────────── */
  /* Without a database the marks live in memory, and that is the whole store —
     for tests, for the memory driver, and for a server whose database is not
     reachable. Every check above ran with Postgres present, which meant the
     database quietly answered for the memory path and the memory path was never
     executed at all. So it is run here, on purpose, with the database taken
     away. */

  await check('with no database at all, the mark still works', async () => {
    const before = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      _resetSupportSeen();
      const M = 'tk-mem-' + Date.now();
      assert.equal(await supportReadAt(M), null, 'unread before anybody opened it');
      const when = Date.now();
      await markSupportRead(M, when);
      const at = await supportReadAt(M);
      assert.ok(at, 'nothing was recorded');
      assert.equal(new Date(at!).getTime(), when);
      /* And forward-only holds here too. */
      await markSupportRead(M, when - 5000);
      assert.equal(new Date((await supportReadAt(M))!).getTime(), when, 'the mark went backwards');
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before;
      _resetSupportSeen();
    }
  });

  /* ── THE ONE-WAY RULE, THROUGH THE ROUTES ─────────────────────────────── */
  /* The half that must NOT exist is as much the feature as the half that must.
     Checked where it is decided — in the handlers — because that is the only
     place the difference between the two GETs lives. */

  await check('SUPPORT opening a ticket is what marks it; the PLAYER opening it is not', async () => {
    const src = await import('node:fs').then((fs) => fs.promises.readFile('src/modules/support/routes.ts', 'utf8'));
    const userGet = src.slice(src.indexOf("`${base}/support/tickets/:id`"), src.indexOf("`${base}/support/tickets/:id/reply`"));
    const adminGet = src.slice(src.indexOf("`${base}/admin/support/tickets/:id`"), src.indexOf("`${base}/admin/support/tickets/:id/reply`"));
    assert.ok(/markSupportRead\(/.test(adminGet), 'support opening a ticket does not mark it read');
    assert.ok(!/markSupportRead\(/.test(userGet),
      'the player opening their OWN ticket marks it read — nobody is waiting to hear that');
    assert.ok(/supportReadAt\(/.test(userGet), 'the player is never told whether it was read');
    assert.ok(!/supportReadAt\(/.test(adminGet), 'the desk is being told something it did not ask for');
  });

  if (process.env.DATABASE_URL) {
    const { getPgPool } = await import('../database/postgres.js');
    await getPgPool().query(`DELETE FROM support_seen WHERE ticket_id LIKE 'tk-%'`).catch(() => {});
  }
  console.log(`[supportSeen] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
