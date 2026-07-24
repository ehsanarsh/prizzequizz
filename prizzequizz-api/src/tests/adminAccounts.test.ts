import { ensureOwnerSeed, login, createAccount, listAccounts, updateAccount, deleteAccount, changeOwnPassword, refreshTokenCache, resolveTokenSync, tabForPath, hasTab } from '../services/adminAccountService.js';

(async () => {
  let pass = 0, fail = 0; const ok = (n: boolean, m: string) => { n ? pass++ : (fail++, console.log('  x', m)); };
  process.env.ADMIN_KEY = 'test-master-key';

  // 1) owner seeded from master key; login with it
  await ensureOwnerSeed();
  const owner = await login('owner', 'test-master-key');
  ok(!!owner && owner.isOwner && owner.perms.includes('*'), 'owner seeded + logs in with master key, has all perms');

  // 2) create a restricted operator (only shop + questions)
  const op = await createAccount({ username: 'operator1', password: 'pass1234', perms: ['shop', 'questions'] });
  ok(op.username === 'operator1' && op.token.startsWith('at_'), 'operator created with a token');

  // 3) operator logs in
  const li = await login('operator1', 'pass1234');
  ok(!!li && li.token === op.token, 'operator login returns its token');
  ok(!(await login('operator1', 'wrong')), 'wrong password rejected');

  // 4) token cache resolves the operator + perms
  await refreshTokenCache();
  const cached = resolveTokenSync(op.token);
  ok(!!cached && cached.perms.join(',') === 'shop,questions', 'token cache resolves operator perms');

  // 5) per-tab enforcement helper
  ok(tabForPath('/v1/admin/shop/items') === 'shop', 'path maps to shop tab');
  ok(tabForPath('/v1/admin/wallet/withdrawals') === 'withdrawals', 'withdrawals path maps correctly');
  ok(hasTab(cached!.perms, 'shop') === true, 'operator allowed on shop');
  ok(hasTab(cached!.perms, 'withdrawals') === false, 'operator denied on withdrawals');
  ok(hasTab(['*'], 'anything') === true, 'wildcard perms allow all');
  ok(hasTab(cached!.perms, null) === true, 'unmapped path allowed for any admin');

  // 6) update perms → cache reflects it
  ok(await updateAccount(op.id, { perms: ['shop', 'users', 'withdrawals'] }), 'update perms');
  ok(hasTab(resolveTokenSync(op.token)!.perms, 'withdrawals'), 'new perm active after update');

  // 7) can't downgrade/delete the owner
  const list = await listAccounts();
  const ownerRow = list.find((a) => a.isOwner)!;
  ok(!(await updateAccount(ownerRow.id, { perms: [] })), 'owner cannot be modified via updateAccount');
  ok(!(await deleteAccount(ownerRow.id)), 'owner cannot be deleted');

  // 8) change operator password (rotates token) — old token stops working
  const oldToken = op.token;
  const cp = await changeOwnPassword(op.id, 'pass1234', 'newpass99');
  ok(cp.ok && cp.token !== oldToken, 'password change rotates token');
  await refreshTokenCache();
  ok(!resolveTokenSync(oldToken), 'old token no longer resolves');
  ok(!!(await login('operator1', 'newpass99')), 'login with new password works');

  // 9) duplicate username rejected
  let threw = false; try { await createAccount({ username: 'operator1', password: 'xxxx', perms: [] }); } catch { threw = true; }
  ok(threw, 'duplicate username rejected');

  // 10) delete operator
  ok(await deleteAccount(op.id), 'operator deleted');

  console.log(`\nadminAccounts: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
