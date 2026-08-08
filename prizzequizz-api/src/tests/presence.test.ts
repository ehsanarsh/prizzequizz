/* IS ANYBODY THERE?
 *
 * The dashboard's «آنلاین (۵ دقیقه)» and DAU read a table nothing ever wrote
 * to, so both were always zero — not "nobody is playing" but "nobody can ever be
 * counted". These cover the write that was missing and the reads that depend
 * on it.
 *
 * Run: npx tsx src/tests/presence.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { touchPresence, onlineCount, activeTodayCount, _resetPresence } from '../services/presenceService.js';
import { dashboardMetrics } from '../services/adminOpsService.js';
import { repositories } from '../repositories/index.js';
import { signAccessToken } from '../services/tokenService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(): Promise<{ id: string; token: string }> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'pr' + uid.slice(0, 8), displayName: 'pr',
    phone: '09' + String(500000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return { id: uid, token: signAccessToken(uid) };
}

async function run(): Promise<void> {
  _resetPresence();

  await check('nobody has been seen yet, so the count is a real zero', async () => {
    assert.equal(await onlineCount(5), 0);
  });

  await check('a user who is seen is counted', async () => {
    _resetPresence();
    const a = await player();
    await touchPresence(a.id);
    assert.equal(await onlineCount(5), 1);
  });

  await check('two different users count as two, the same user twice as one', async () => {
    _resetPresence();
    const a = await player(), b = await player();
    await touchPresence(a.id);
    await touchPresence(b.id);
    await touchPresence(a.id);
    assert.equal(await onlineCount(5), 2, 'distinct users, not requests');
  });

  await check('an authenticated request records presence by itself', async () => {
    /* This is the half that was missing: the write has to happen on the normal
       request path, not only when something remembers to call it. */
    _resetPresence();
    const server = createApiServer();
    server.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    try {
      const p = await player();
      assert.equal(await onlineCount(5), 0, 'not seen before the request');
      await fetch(base + '/wallet', { headers: { authorization: 'Bearer ' + p.token } });
      await new Promise((r) => setTimeout(r, 120));   // the touch is fire-and-forget
      assert.equal(await onlineCount(5), 1, 'seen after it');
    } finally { server.close(); }
  });

  await check('an anonymous request records nobody', async () => {
    _resetPresence();
    const server = createApiServer();
    server.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    try {
      await fetch(base + '/config/public');
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(await onlineCount(5), 0);
    } finally { server.close(); }
  });

  await check('the dashboard reports the same figure, not a hardcoded zero', async () => {
    _resetPresence();
    const a = await player(), b = await player();
    await touchPresence(a.id);
    await touchPresence(b.id);
    const d: any = await dashboardMetrics();
    assert.equal(d.onlineUsers, 2, 'online');
    assert.equal(d.dau, 2, 'and today’s active players');
  });

  await check('today’s count includes someone seen earlier today', async () => {
    _resetPresence();
    const a = await player();
    await touchPresence(a.id);
    assert.equal(await activeTodayCount(), 1);
  });

  await check('presence never throws, whatever it is handed', async () => {
    await touchPresence('');
    await touchPresence('no-such-user-at-all');
    assert.ok(true, 'no exception escaped');
  });

  console.log(`[presence] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
