/* A JOB, NOT FIFTY TICKS.
 *
 * Access to the panel is per-screen, and there are more than fifty screens.
 * Handing somebody a job meant fifty decisions taken once, by whoever created
 * the account — and, worse, a screen added afterwards reached NOBODY, because
 * every account carried the tab list that existed on the day it was saved.
 *
 * A role fixes that only if it is STORED and resolved per request. If it is
 * copied into the account's ticks at save time it is a shortcut for typing,
 * not a rule — and the new-screen problem comes straight back. That property is
 * what most of this file is about.
 *
 * Run: npx tsx src/tests/adminRoles.test.ts        (the rules)
 *      DATABASE_URL=… npx tsx src/tests/adminRoles.test.ts   (+ real accounts)
 */
import assert from 'node:assert/strict';
import { ADMIN_ROLES, roleTabs, effectivePerms, extraTabsFor, isRoleKey } from '../services/adminRoleService.js';
import { ADMIN_TABS } from '../services/adminTabs.js';
import { hasTab } from '../services/adminAccountService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  const TABS = new Set<string>(ADMIN_TABS as readonly string[]);

  await check('every tab a role grants is a tab that exists', () => {
    /* THE TYPO THAT GRANTS NOTHING. `hasTab` compares strings, so 'withdrawls'
       in a role is not an error anywhere — it is simply a screen the finance
       person cannot open, with no message and nothing in a log. */
    for (const r of ADMIN_ROLES) {
      for (const t of r.tabs) {
        if (t === '*') continue;
        assert.ok(TABS.has(t), `role «${r.key}» grants «${t}», which is not a panel screen`);
      }
    }
  });

  await check('only the owner gets everything', () => {
    for (const r of ADMIN_ROLES) {
      if (r.key === 'owner') assert.deepEqual(r.tabs, ['*']);
      else assert.ok(!r.tabs.includes('*'), `role «${r.key}» quietly grants everything`);
    }
  });

  await check('and the two screens that can destroy the game belong to nobody else', () => {
    /* «ابزار ریست» wipes records and «ویرایش خام Config» can rewrite the
       economy in one paste. Being technical is not the same as being allowed to
       do either, and neither is being trusted — these are kept to one account
       so that an accident has one possible author. */
    for (const r of ADMIN_ROLES) {
      if (r.key === 'owner') continue;
      for (const dangerous of ['reset', 'rawcfg', 'accounts']) {
        assert.ok(!r.tabs.includes(dangerous), `role «${r.key}» can open «${dangerous}»`);
      }
    }
  });

  await check('the programmers get the screen their whole role is for', () => {
    assert.ok(TABS.has('errors'), 'the errors screen is not a grantable tab at all');
    assert.ok(roleTabs('dev').includes('errors'), 'the dev role does not include the error queue');
  });

  await check('a job is the role plus that one person’s extras', () => {
    const p = effectivePerms('growth', ['users']);
    assert.ok(p.includes('leaderboard'), 'the role’s own tabs were lost');
    assert.ok(p.includes('users'), 'the extra tab was lost');
    assert.ok(hasTab(p, 'users') && hasTab(p, 'sms'));
    assert.ok(!hasTab(p, 'withdrawals'), 'growth reached the money screens');
  });

  await check('and the growth role does not carry the phone list on its own', () => {
    /* Every player's phone number lives behind `users`, and so does every
       player's balance. Somebody who needs the export gets it as one visible
       decision about one account, not as a property of the job. */
    assert.ok(!roleTabs('growth').includes('users'));
    assert.ok(!hasTab(effectivePerms('growth', []), 'users'));
  });

  await check('a role this build does not know grants nothing, never everything', () => {
    /* An account saved by a later version, or a role renamed. Failing open here
       would hand a stranger the whole panel; failing closed shows them too
       little, and somebody says so within the hour. */
    assert.deepEqual(effectivePerms('regional-manager', []), []);
    assert.deepEqual(effectivePerms('regional-manager', ['support']), ['support']);
    assert.equal(isRoleKey('regional-manager'), false);
    assert.equal(hasTab(effectivePerms(null, []), 'users'), false);
  });

  await check('an explicit star still means everything', () => {
    assert.deepEqual(effectivePerms('support', ['*']), ['*']);
    assert.deepEqual(effectivePerms('owner', []), ['*']);
  });

  await check('the extras offered are exactly the tabs the role does not cover', () => {
    const extras = extraTabsFor('support');
    const own = new Set(roleTabs('support'));
    for (const t of extras) assert.ok(!own.has(t), `«${t}» is offered as an extra and the role already has it`);
    assert.equal(extras.length + own.size, TABS.size, 'the two lists together are not the whole panel');
    assert.deepEqual(extraTabsFor('owner'), [], 'the owner was offered extras on top of everything');
  });

  /* ── AGAINST REAL ACCOUNTS ────────────────────────────────────────────── */
  if (!process.env.DATABASE_URL) {
    console.log('  — skipped: the rest needs Postgres, where the accounts live');
    console.log(`[adminRoles] ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  const { createAccount, updateAccount, deleteAccount, listAccounts, refreshTokenCache, resolveTokenSync } =
    await import('../services/adminAccountService.js');
  const listAccountsFirst = async (): Promise<void> => { await listAccounts(); };
  const { getPgPool } = await import('../database/postgres.js');
  const pool = getPgPool();
  const uname = 'roletest' + Date.now();
  /* listAccounts() first: it is what creates the table on a database that has
     never run the panel, and deleting from a table that does not exist yet is
     an error about the test, not about roles. */
  await listAccountsFirst();
  await pool.query(`DELETE FROM admin_accounts WHERE username LIKE 'roletest%'`);

  const acc = await createAccount({ username: uname, password: 'pw1234', perms: [], role: 'support' });

  await check('an account made with a role can open that role’s screens', async () => {
    await refreshTokenCache();
    const c = resolveTokenSync(acc.token);
    assert.ok(c, 'the new account cannot be resolved from its token');
    assert.ok(hasTab(c!.perms, 'support'), 'the support role could not open support');
    assert.ok(hasTab(c!.perms, 'qreports'));
    assert.ok(!hasTab(c!.perms, 'withdrawals'), 'support reached the money screens');
  });

  await check('the role is STORED, not copied into its ticks', async () => {
    /* The whole point. If saving had expanded the role into `perms`, this row
       would come back with a dozen tabs and no role — and a screen added to the
       role next month would never reach this account. */
    const row = (await listAccounts()).find((a) => a.username === uname)!;
    assert.equal(row.role, 'support', 'the role was not kept');
    assert.deepEqual(row.perms, [], 'the role was expanded into the account’s own ticks');
    assert.ok(row.effective.includes('support'), 'the panel would show this account as having no access');
  });

  await check('changing the job changes what opens, without touching a tick', async () => {
    await updateAccount(acc.id, { role: 'finance' });
    await refreshTokenCache();
    const c = resolveTokenSync(acc.token)!;
    assert.ok(hasTab(c.perms, 'withdrawals'), 'the finance role cannot open withdrawals');
    assert.ok(!hasTab(c.perms, 'support'), 'the old role’s screens stayed behind');
  });

  await check('an extra tab is added on top and survives a role change', async () => {
    await updateAccount(acc.id, { perms: ['errors'] });
    await refreshTokenCache();
    let c = resolveTokenSync(acc.token)!;
    assert.ok(hasTab(c.perms, 'errors') && hasTab(c.perms, 'withdrawals'));
    await updateAccount(acc.id, { role: 'content' });
    await refreshTokenCache();
    c = resolveTokenSync(acc.token)!;
    assert.ok(hasTab(c.perms, 'errors'), 'the extra was lost when the job changed');
    assert.ok(hasTab(c.perms, 'questions'));
    assert.ok(!hasTab(c.perms, 'withdrawals'));
  });

  await check('a job title nobody recognises is not stored as a job title', async () => {
    /* Otherwise the panel prints «regional-manager» next to the account while
       `effectivePerms` grants nothing from it — and the complaint that follows
       is «I have a role and I can't open anything», which is a much harder
       thing to work out than «بدون نقش». What is shown and what is enforced
       have to be the same fact. */
    await updateAccount(acc.id, { role: 'regional-manager' });
    const row = (await listAccounts()).find((a) => a.username === uname)!;
    assert.equal(row.role, null, 'a role the build does not know was stored as if it were one');
  });

  await check('and the job can be taken away, leaving only the extras', async () => {
    /* `if (patch.role)` would make this impossible — an empty role would read
       as «not provided» and the old job would stay for ever. */
    await updateAccount(acc.id, { role: '' });
    await refreshTokenCache();
    const c = resolveTokenSync(acc.token)!;
    assert.deepEqual(c.perms, ['errors'], 'clearing the role did not clear the role');
    assert.equal(hasTab(c.perms, 'questions'), false);
  });

  await deleteAccount(acc.id);
  await pool.query(`DELETE FROM admin_accounts WHERE username LIKE 'roletest%'`);
  console.log(`[adminRoles] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
