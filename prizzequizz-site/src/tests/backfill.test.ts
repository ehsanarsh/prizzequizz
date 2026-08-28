/* A NEW DESIGN REACHING A SITE THAT IS ALREADY LIVE.
 *
 * The seeder only writes into an empty store, which is correct — a deploy must
 * never overwrite the words an operator wrote. The cost of that is that new
 * design SLOTS reach nobody who already installed the site: the character
 * artwork was added to every shipped page and, on the live server, not one page
 * had a character, because those rows were written before the field existed.
 *
 * The backfill fills the empty slots. The dangerous half of it is everything it
 * must NOT do, and that is most of what is checked here: a character somebody
 * chose, a card somebody renamed, a page somebody rewrote, a slot somebody
 * deliberately cleared — all of them have to survive a deploy untouched.
 */
import assert from 'node:assert/strict';
import {
  listPages, savePage, getPage, getSettings, saveSettings,
  backfillShippedDesign, _resetSiteMemory, _seedPages
} from '../content.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** A store that looks like an OLD install: the shipped pages, with every design
 *  slot the new version added stripped back out of them. */
async function oldInstall(mutate: (p: any) => void = () => undefined): Promise<void> {
  _resetSiteMemory();
  for (const p of _seedPages()) {
    const old: any = structuredClone(p);
    delete old.heroCharacter; delete old.kicker; delete old.intro; delete old.heroButtons;
    for (const b of old.blocks ?? []) {
      delete b.character;
      for (const i of b.items ?? []) delete i.character;
    }
    mutate(old);
    await savePage(old);
  }
}

async function run(): Promise<void> {
  /* The first half deliberately runs on the MEMORY repository, so it has to be
   * told not to reach for Postgres — otherwise `_resetSiteMemory` clears a
   * store nothing is reading and every case silently tests the database with
   * none of the database section's setup. The URL is put back below. */
  const url = process.env.PGTEST_URL || process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  await check('an old install gets the artwork the design shipped with', async () => {
    await oldInstall();
    const pages = await listPages(true);            // listPages runs the backfill
    const withChar = pages.filter((p) => p.heroCharacter);
    assert.ok(withChar.length >= 8, `only ${withChar.length} pages got a character`);
    const home = pages.find((p) => p.slug === 'home')!;
    assert.equal(home.heroCharacter, 'char-hero.png');
  });

  await check('and the characters inside the cards, matched by their title', async () => {
    await oldInstall();
    await listPages(true);
    const home = (await getPage('home', true))!;
    const modes = home.blocks.find((b) => b.kind === 'cards' && /حالت/.test(b.title ?? ''))!;
    const duel = modes.items!.find((i) => i.title === 'دوئل')!;
    assert.equal(duel.character, 'char-cyclops.png');
  });

  /* ── EVERYTHING IT MUST NOT TOUCH ─────────────────────────────────── */

  await check('a character the operator chose is never replaced', async () => {
    await oldInstall((p) => { if (p.slug === 'home') p.heroCharacter = 'char-king.png'; });
    await listPages(true);
    const home = (await getPage('home', true))!;
    assert.equal(home.heroCharacter, 'char-king.png', 'the operator’s choice was overwritten');
  });

  await check('words the operator rewrote survive the deploy', async () => {
    await oldInstall((p) => {
      if (p.slug === 'home') {
        p.title = 'عنوان خودم';
        p.seoDescription = 'توضیح خودم';
        p.blocks[0].title = 'تیتر خودم';
      }
    });
    await listPages(true);
    const home = (await getPage('home', true))!;
    assert.equal(home.title, 'عنوان خودم');
    assert.equal(home.seoDescription, 'توضیح خودم');
    assert.equal(home.blocks[0]!.title, 'تیتر خودم');
  });

  await check('a card the operator renamed is not assumed to be the shipped one', async () => {
    await oldInstall((p) => {
      if (p.slug === 'home') {
        const modes = p.blocks.find((b: any) => b.kind === 'cards' && /حالت/.test(b.title ?? ''));
        modes.items[0].title = 'یک اسم دیگر';
      }
    });
    await listPages(true);
    const home = (await getPage('home', true))!;
    const modes = home.blocks.find((b) => b.kind === 'cards' && /حالت/.test(b.title ?? ''))!;
    const renamed = modes.items!.find((i) => i.title === 'یک اسم دیگر')!;
    assert.ok(!renamed.character, 'a renamed card was given a character by guesswork');
  });

  await check('a page the operator deleted is not brought back', async () => {
    await oldInstall();
    const { deletePage } = await import('../content.js');
    await deletePage('faq');
    await listPages(true);
    assert.equal(await getPage('faq', true), null, 'a deleted page reappeared');
  });

  await check('a page that is not one this project ships is left completely alone', async () => {
    await oldInstall();
    await savePage({ slug: 'my-own-page', title: 'صفحهٔ خودم', navOrder: 40, blocks: [] } as any);
    await listPages(true);
    const mine = (await getPage('my-own-page', true))!;
    assert.ok(!mine.heroCharacter, 'a page the design never shipped was decorated');
    assert.equal(mine.title, 'صفحهٔ خودم');
  });

  await check('a character the operator put on a CARD is never replaced', async () => {
    await oldInstall((p) => {
      if (p.slug === 'home') {
        const modes = p.blocks.find((b: any) => b.kind === 'cards' && /حالت/.test(b.title));
        modes.items[0].character = 'char-dark.png';
      }
    });
    await listPages(true);
    const home = (await getPage('home', true))!;
    const modes = home.blocks.find((b) => b.kind === 'cards' && /حالت/.test(b.title ?? ''))!;
    assert.equal(modes.items![0]!.character, 'char-dark.png', 'a card’s own character was overwritten');
  });

  await check('a character the operator put on a CALLOUT is never replaced', async () => {
    await oldInstall((p) => {
      if (p.slug === 'home') {
        const c = p.blocks.find((b: any) => b.kind === 'callout');
        if (c) c.character = 'char-winged.png';
      }
    });
    await listPages(true);
    const home = (await getPage('home', true))!;
    const c = home.blocks.find((b) => b.kind === 'callout')!;
    assert.equal(c.character, 'char-winged.png');
  });

  /* THE ONE THAT KEEPS THIS FROM BECOMING A NUISANCE.
   *
   * Once it has run, an operator owns every slot. Clearing a character has to
   * stick — and it cannot stick if a migration re-runs and «helpfully» fills
   * the empty slot back in on the next deploy. So the pass is stamped and never
   * runs a second time. */
  await check('it runs exactly once, and a second run writes nothing', async () => {
    await oldInstall();
    await listPages(true);
    const before = (await getPage('home', true))!;
    assert.ok(before.heroCharacter, 'the first run did nothing');
    assert.equal((await getSettings()).designBackfilled, true, 'the run was not stamped');

    await backfillShippedDesign();               // a second boot
    const after = (await getPage('home', true))!;
    assert.equal(after.updatedAt, before.updatedAt, 'the page was rewritten on the second run');
  });

  await check('a slot the operator cleared stays cleared across deploys', async () => {
    await oldInstall();
    await listPages(true);                       // design arrives, and is stamped
    const home = (await getPage('home', true))!;
    await savePage({ ...home, heroCharacter: '' });
    await backfillShippedDesign();               // the next deploy
    const again = (await getPage('home', true))!;
    assert.ok(!again.heroCharacter, 'a deliberately cleared character was put back');
  });

  await check('an install that has already been stamped is not touched at all', async () => {
    await oldInstall();
    await saveSettings({ designBackfilled: true });
    await backfillShippedDesign();
    const home = (await getPage('home', true))!;
    assert.ok(!home.heroCharacter, 'a stamped install was backfilled anyway');
  });

  await check('a fresh install still gets the full seed, characters included', async () => {
    _resetSiteMemory();
    const pages = await listPages(true);
    assert.ok(pages.length >= 9, 'the seed did not run');
    assert.equal(pages.find((p) => p.slug === 'home')!.heroCharacter, 'char-hero.png');
  });

  /* ── THE PATH THE LIVE SERVER ACTUALLY TAKES ───────────────────────────
   *
   * Everything above runs on the memory repository, and the memory repository
   * has its own branch in the seeder. The bug this whole file exists for lived
   * in the OTHER branch: on a server with Postgres, an existing store made the
   * seeder return before the design ever reached it. A suite that only ever
   * exercised memory would have passed the entire time the live site was
   * missing every character. */
  if (!url) {
    console.log('  … the Postgres half needs PGTEST_URL/DATABASE_URL; skipped.');
  } else {
    const { Pool } = (await import('pg')).default;
    const p2 = new Pool({ connectionString: url });
    const db = await p2.connect();
    const schema = 'bf_' + Math.random().toString(36).slice(2, 8);
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      /* TWO connections have to agree on the schema and they are set up
         differently: ALTER ROLE only takes effect for sessions opened AFTER it,
         which covers the site's pool but NOT this already-open one. Without the
         SET as well, the test reads `public` while the code under test writes
         the throwaway schema, and every assertion below is measuring a
         different database from the one it just changed. */
      await db.query(`ALTER ROLE CURRENT_USER SET search_path TO ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      process.env.DATABASE_URL = url;
      const { closePgPool, _resetSiteMemory: reset } = await import('../content.js')
        .then(async (m) => ({ ...m, closePgPool: (await import('../db.js')).closePgPool }));
      await closePgPool().catch(() => undefined);
      reset();

      /* An install written by the PREVIOUS version: the shipped pages, with
         every slot this version added stripped out, and no stamp. */
      await listPages(true);                                  // create schema + seed
      await db.query(`UPDATE site_pages SET design = '{}'::jsonb`);
      await db.query(`UPDATE site_pages SET blocks = replace(blocks::text,'"character"','"_gone"')::jsonb`);
      /* NOT swallowed: if this does not remove the stamp, the backfill returns
         immediately and both cases below fail for a reason that has nothing to
         do with the code under test. */
      const un = await db.query(`UPDATE site_settings SET data = data - 'designBackfilled' WHERE id='default'`);
      assert.equal(un.rowCount, 1, 'the settings row was not found — the fixture is wrong, not the code');
      await closePgPool().catch(() => undefined);
      reset();

      await check('on Postgres, an existing install gets the design', async () => {
        await listPages(true);
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM site_pages WHERE design->>'heroCharacter' <> ''`);
        assert.ok(Number(rows[0].n) >= 8, `only ${rows[0].n} pages got a character`);
      });

      await check('on Postgres, it stamps itself and does not run again', async () => {
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM site_pages WHERE blocks::text LIKE '%"character"%'`);
        assert.ok(Number(rows[0].n) >= 1, 'block characters did not arrive');
        assert.equal((await getSettings()).designBackfilled, true, 'no stamp was written');
      });
    } finally {
      delete process.env.DATABASE_URL;
      await db.query(`ALTER ROLE CURRENT_USER RESET search_path`).catch(() => undefined);
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      db.release();
      await p2.end();
      const { closePgPool } = await import('../db.js');
      await closePgPool().catch(() => undefined);
    }
  }

  console.log(`[backfill] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
