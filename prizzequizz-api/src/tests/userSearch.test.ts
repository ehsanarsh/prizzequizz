/* FINDING A PLAYER.
 *
 * «در قسمت سرچ کاربران و هر جایی که میخوای کاربر رو سرچ کنی باید بتونیم با
 *  شماره موبایل هم سرچ کنیم.»
 *
 * Two things were wrong, and the second one is why the first was never
 * noticed. `searchAdminUsers` asked the repository for `list(limit)` — the
 * most recently UPDATED accounts — and filtered those in memory. So the panel
 * searched the last couple of hundred people to have played, which is close to
 * the opposite of who a support case is about: the account being asked after
 * has usually been quiet for a while. Typing a real phone number and being
 * told «کاربری نیست» is what that looks like from a desk.
 *
 * And a phone number is never typed the way it is stored. The same line is
 * 09121234567, 9121234567, +989121234567, or ۰۹۱۲۱۲۳۴۵۶۷ from a Persian
 * keyboard — which are not even the same characters.
 *
 * Run: npx tsx src/tests/userSearch.test.ts
 */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { searchAdminUsers } from '../services/adminUserService.js';
import { phoneKey, toLatinDigits, looksLikePhone } from '../utils/phone.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

async function makeUser(name: string, phone: string): Promise<string> {
  const userId = id();
  const username = RUN + '_' + name;
  await repositories.users.save({
    id: userId, phone, username, displayName: username, plan: 'free', level: 1, xp: 0,
    weeklyScore: 0, wallet: 0, coins: 0, hearts: 5, tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  return userId;
}

/* RUN ON WHICHEVER DRIVER IS CONFIGURED.
   The memory driver lists users in insertion order, so the bug this file is
   really about — «list() gives the most recently ACTIVE accounts, and the
   person you are looking for is the opposite of that» — cannot even be
   reproduced there. It is a Postgres ordering. So the same assertions run
   against both, and the numbers below never assume a fresh database: every
   account made here carries a prefix unique to this run and the results are
   read through it. */
const RUN = 'ts' + Date.now().toString(36);
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) process.env.REPOSITORY_DRIVER = 'memory';
  console.log('driver: ' + (process.env.DATABASE_URL ? 'postgres' : 'memory'));

  console.log('reading a phone number the way a person types it:');
  await check('Persian digits are digits', () => {
    assert.equal(toLatinDigits('۰۹۱۲۱۲۳۴۵۶۷'), '09121234567');
    assert.equal(toLatinDigits('٠٩١٢'), '0912');
    assert.equal(toLatinDigits('mixed ۱۲۳ abc'), 'mixed 123 abc');
  });
  await check('every spelling of one line reduces to the same key', () => {
    const want = '9121234567';
    for (const written of ['09121234567', '9121234567', '+989121234567', '0098 912 123 4567',
                           '۰۹۱۲۱۲۳۴۵۶۷', '0912-123-4567', '(0912) 1234567']) {
      assert.equal(phoneKey(written), want, written);
    }
  });
  await check('and a name is not mistaken for a number', () => {
    assert.equal(looksLikePhone('sara'), false);
    assert.equal(looksLikePhone('0912'), true);
    /* Two digits would match half the accounts — that is noise, not a search. */
    assert.equal(looksLikePhone('91'), false);
  });

  console.log('\nsearching for somebody:');
  /* Numbers unique to this run, so a real database's own data cannot collide. */
  const tail = String(Date.now()).slice(-7);
  const PH_SARA = '0912' + tail;
  /* A different tail, or «the last seven digits» would match them both and the
     test would be asserting nothing. */
  const PH_REZA = '0935' + String(Number(tail) ^ 8675309).padStart(7, '0').slice(-7);
  const sara = await makeUser('sara_92', PH_SARA);
  const reza = await makeUser('reza', PH_REZA);

  /* Only this run's accounts — the database may hold anybody else's. */
  const mine = (rows: Array<{ id: string; username: string }>) =>
    rows.filter((r) => String(r.username || '').startsWith(RUN)).map((r) => r.id);

  await check('by username', async () => {
    assert.deepEqual(mine(await searchAdminUsers(RUN + '_sara', 200)), [sara]);
  });
  await check('by phone, written the way it is stored', async () => {
    assert.deepEqual(mine(await searchAdminUsers(PH_SARA, 200)), [sara]);
  });
  await check('by phone without the leading zero', async () => {
    assert.deepEqual(mine(await searchAdminUsers(PH_SARA.slice(1), 200)), [sara]);
  });
  await check('by phone with the country code', async () => {
    assert.deepEqual(mine(await searchAdminUsers('+98' + PH_SARA.slice(1), 200)), [sara]);
  });
  await check('by phone typed in Persian digits', async () => {
    const fa = PH_SARA.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);
    assert.deepEqual(mine(await searchAdminUsers(fa, 200)), [sara]);
  });
  await check('by part of a phone number', async () => {
    assert.deepEqual(mine(await searchAdminUsers(PH_REZA.slice(-7), 200)), [reza]);
  });
  await check('and somebody who is not there is not there', async () => {
    assert.deepEqual(mine(await searchAdminUsers('09999999999', 200)), []);
  });

  /* THE ONE THAT MADE THE OTHERS UNREACHABLE. */
  console.log('\nsomebody who has not played for a long time:');
  await check('is still found, however many people played since', async () => {
    /* The account is created first, then two hundred others are touched after
       it — so it is nowhere near the top of «most recently updated». */
    const phQuiet = '0919' + tail;
    const quiet = await makeUser('ghadimi', phQuiet);
    /* Phone is UNIQUE in the real schema, so the filler numbers have to be
       unique to this run as well as to each other. */
    for (let i = 0; i < 220; i++) await makeUser('later_' + i, '09' + String(Date.now()).slice(-6) + String(100 + i).slice(-3));
    assert.deepEqual(mine(await searchAdminUsers(RUN + '_ghadimi', 200)), [quiet], 'the old account cannot be found by name');
    assert.deepEqual(mine(await searchAdminUsers(phQuiet, 200)), [quiet], 'nor by phone');
  });

  await check('an empty search still lists people', async () => {
    const rows = await searchAdminUsers('', 10);
    assert.ok(rows.length > 0 && rows.length <= 10, String(rows.length));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}
main();
