/* THE NAME THAT WENT BACK TO «بازیکن جدید».
 *
 * Several players signed up, typed their own name and username, and then
 * appeared in the admin panel as «بازیکن جدید» with a username of
 * `user_1783807103051` — the placeholder the account is created with. Not all
 * players. Some.
 *
 * The cause is that `users.save` writes the WHOLE row and about thirty services
 * read a user, change one balance, and save it back. Any of them holding a copy
 * fetched before the player finished signing up puts that copy's name back on
 * save. Which accounts it hits is decided by who happened to have a request in
 * flight — hence «some».
 *
 * This is a Postgres test on purpose. The guard is in the upsert's ON CONFLICT
 * clause; the memory driver never runs it, so a memory test would pass while
 * production kept losing names.
 *
 * Run: PGTEST_URL=postgres://... npx tsx src/tests/profileClobber.test.ts
 */
import assert from 'node:assert/strict';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function run(): Promise<void> {
  const url = process.env.PGTEST_URL || process.env.DATABASE_URL;
  if (!url) {
    console.log('[profileClobber] SKIPPED — no PGTEST_URL/DATABASE_URL. The guard lives in SQL;');
    console.log('                 the memory driver never executes it.');
    return;
  }
  process.env.DATABASE_URL = url;
  const { Pool } = (await import('pg')).default;
  const p = new Pool({ connectionString: url });
  const db = await p.connect();
  const schema = 'clob_' + Math.random().toString(36).slice(2, 8);

  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`ALTER ROLE CURRENT_USER SET search_path TO ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await db.query(`CREATE TABLE users (
      id uuid PRIMARY KEY, phone varchar(32) UNIQUE, username varchar(64) UNIQUE,
      display_name varchar(120), plan varchar(16) DEFAULT 'free',
      coins bigint DEFAULT 0, hearts int DEFAULT 5, wallet_balance bigint DEFAULT 0,
      xp bigint DEFAULT 0, level int DEFAULT 1, weekly_score bigint DEFAULT 0,
      role varchar(16) DEFAULT 'user', status varchar(16) DEFAULT 'active',
      ban_reason text, banned_at timestamptz, gender varchar(10),
      updated_at timestamptz DEFAULT now())`);

    const { repositories } = await import('../repositories/index.js');
    const users = repositories.users;
    const ID = '33333333-3333-3333-3333-333333333333';

    /** The account exactly as auth/routes creates it, then named by the player. */
    async function signUpAndName(): Promise<any> {
      await db.query(`TRUNCATE users`);
      const fresh: any = { id: ID, phone: '09120000000', username: 'user_1783807103051',
        displayName: 'بازیکن جدید', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
        wallet: 0, coins: 350, hearts: 5, tickets: {} };
      await users.save(fresh);
      const named = { ...fresh, username: 'ehsan_r', displayName: 'احسان رستمی' };
      await users.save(named);
      return fresh;                       // the STALE copy, still holding the placeholder
    }

    await check('the player’s own name is stored in the first place', async () => {
      await signUpAndName();
      const u = await users.findById(ID);
      assert.equal(u!.username, 'ehsan_r');
      assert.equal(u!.displayName, 'احسان رستمی');
    });

    /* THE BUG, EXACTLY: a service that read the user before sign-up finished,
       added some coins, and saved. */
    await check('a stale copy adding coins cannot put the placeholder back', async () => {
      const stale = await signUpAndName();
      stale.coins = 500;
      await users.save(stale);
      const u = await users.findById(ID);
      assert.equal(u!.username, 'ehsan_r', 'the username reverted to the placeholder');
      assert.equal(u!.displayName, 'احسان رستمی', 'the name reverted to «بازیکن جدید»');
      assert.equal(Number(u!.coins), 500, 'and the coins it actually meant to write must still land');
    });

    await check('the same is true for every other balance a service might write', async () => {
      const stale = await signUpAndName();
      Object.assign(stale, { xp: 900, level: 4, hearts: 2, wallet: 120000, weeklyScore: 33 });
      await users.save(stale);
      const u = await users.findById(ID) as any;
      assert.equal(u.username, 'ehsan_r');
      assert.equal(Number(u.xp), 900);
      assert.equal(Number(u.wallet), 120000);
    });

    /* The guard must not become a wall: renaming has to keep working. */
    await check('a player renaming themselves still works', async () => {
      await signUpAndName();
      const u: any = await users.findById(ID);
      u.displayName = 'احسان ر'; u.username = 'ehsan2';
      await users.save(u);
      const after = await users.findById(ID);
      assert.equal(after!.username, 'ehsan2');
      assert.equal(after!.displayName, 'احسان ر');
    });

    await check('an account that never registered keeps its placeholder', async () => {
      await db.query(`TRUNCATE users`);
      const fresh: any = { id: ID, phone: '09120000000', username: 'user_1783807103051',
        displayName: 'بازیکن جدید', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
        wallet: 0, coins: 350, hearts: 5, tickets: {} };
      await users.save(fresh);
      fresh.coins = 400;
      await users.save(fresh);
      const u = await users.findById(ID);
      assert.equal(u!.username, 'user_1783807103051', 'an unregistered account lost its own id');
      assert.equal(u!.displayName, 'بازیکن جدید');
    });

    /* `user_12` is a name a person could plausibly type; the placeholder is a
       millisecond timestamp. The guard must only catch the machine one. */
    await check('a real username that merely looks similar is not treated as a placeholder', async () => {
      await signUpAndName();
      const u: any = await users.findById(ID);
      u.username = 'user_12';
      await users.save(u);
      assert.equal((await users.findById(ID))!.username, 'user_12');
      const stale2: any = { ...u, username: 'user_12', displayName: 'احسان رستمی', coins: 700 };
      await users.save(stale2);
      assert.equal((await users.findById(ID))!.username, 'user_12', 'a chosen name was blocked');
    });
  } finally {
    await db.query(`ALTER ROLE CURRENT_USER RESET search_path`).catch(() => undefined);
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    db.release(); await p.end();
  }

  console.log(`[profileClobber] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
