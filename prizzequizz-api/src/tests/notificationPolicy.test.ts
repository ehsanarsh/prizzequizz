/* WHAT THE GAME IS ALLOWED TO SEND.
 *
 * "the inbox keeps filling up" is not answered by asking every player to go
 * and switch things off one at a time. This is the operator's game-wide
 * control, and the important part is WHERE it applies: a muted category is
 * never created at all. Gating only the push would leave the bell filling up
 * exactly as before.
 *
 * Run: npx tsx src/tests/notificationPolicy.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { notifications } from '../services/notificationService.js';
import { getPolicy, setPolicy, typeAllowed, _resetPolicy, NOTIFICATION_TYPES, NOTIFICATION_TYPE_LABELS } from '../services/notificationPolicyService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'np' + uid.slice(0, 8), displayName: 'np',
    phone: '09' + String(800000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return uid;
}
const inbox = (uid: string) => notifications.list(uid, 200);

async function run(): Promise<void> {
  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const admin = { 'x-admin-key': 'dev-admin', 'content-type': 'application/json' };

  try {
    await check('everything is allowed by default', async () => {
      _resetPolicy();
      const p = await getPolicy();
      for (const t of NOTIFICATION_TYPES) assert.equal(p.types[t], true, t + ' should start on');
    });

    await check('a muted category is never written to the inbox', async () => {
      /* Not "created and hidden" — never created. This is the whole point. */
      _resetPolicy();
      await setPolicy({ types: { match_update: false } });
      const uid = await player();
      await notifications.create({ userId: uid, type: 'match_update', title: 'نتیجهٔ دوئل', body: 'x', push: false });
      assert.equal((await inbox(uid)).length, 0, 'nothing landed');
    });

    await check('and the categories still on are unaffected', async () => {
      const uid = await player();
      await notifications.create({ userId: uid, type: 'wallet_update', title: 'کیف پول', body: 'x', push: false });
      const rows = await inbox(uid);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.type, 'wallet_update');
    });

    await check('muting one does not mute the rest', async () => {
      _resetPolicy();
      await setPolicy({ types: { promo: false } });
      const uid = await player();
      for (const t of NOTIFICATION_TYPES) {
        await notifications.create({ userId: uid, type: t, title: t, body: 'x', push: false });
      }
      const rows = await inbox(uid);
      assert.equal(rows.length, NOTIFICATION_TYPES.length - 1, JSON.stringify(rows.map((r) => r.type)));
      assert.ok(!rows.some((r) => r.type === 'promo'), 'promo is the one missing');
    });

    await check('turning it back on starts delivery again', async () => {
      await setPolicy({ types: { promo: true } });
      const uid = await player();
      await notifications.create({ userId: uid, type: 'promo', title: 'تخفیف', body: 'x', push: false });
      assert.equal((await inbox(uid)).length, 1);
    });

    await check('a muted category does not make the caller fail', async () => {
      /* Every caller treats a notification as a side-effect; a match must not
         fail to finish because the operator muted its announcement. */
      _resetPolicy();
      await setPolicy({ types: { system: false } });
      const uid = await player();
      const n = await notifications.create({ userId: uid, type: 'system', title: 'x', body: 'y', push: false });
      assert.ok(n && n.id, 'it still returns a record rather than throwing');
      assert.equal((await inbox(uid)).length, 0);
    });

    await check('an unknown key in the stored data cannot silence anything', async () => {
      /* Losing a notification is worse than sending one; anything the row does
         not mention stays on. */
      _resetPolicy();
      await setPolicy({ types: { nonsense: false } as any });
      for (const t of NOTIFICATION_TYPES) assert.equal(await typeAllowed(t), true, t);
    });

    await check('the panel can read it, with a Persian name for each switch', async () => {
      const res = await fetch(base + '/admin/notification-policy', { headers: admin });
      const body = (await res.json()).data;
      assert.equal(res.status, 200);
      assert.deepEqual(body.types, NOTIFICATION_TYPES);
      for (const t of NOTIFICATION_TYPES) assert.ok(body.labels[t] && body.labels[t] !== t, t + ' has no label');
      assert.equal(body.labels.wallet_update, NOTIFICATION_TYPE_LABELS.wallet_update);
    });

    await check('and write it', async () => {
      _resetPolicy();
      const res = await fetch(base + '/admin/notification-policy', {
        method: 'PUT', headers: admin, body: JSON.stringify({ types: { leaderboard_update: false } })
      });
      assert.equal(res.status, 200);
      assert.equal((await getPolicy()).types.leaderboard_update, false);
      const uid = await player();
      await notifications.create({ userId: uid, type: 'leaderboard_update', title: 'رتبه', body: 'x', push: false });
      assert.equal((await inbox(uid)).length, 0, 'the switch really took effect');
    });

    await check('it is not open without the admin key', async () => {
      const r1 = await fetch(base + '/admin/notification-policy');
      const r2 = await fetch(base + '/admin/notification-policy', { method: 'PUT', body: '{}' });
      assert.equal(r1.status, 403);
      assert.equal(r2.status, 403);
    });
  } finally {
    _resetPolicy();
    await setPolicy({ types: NOTIFICATION_TYPES.reduce((a, t) => { a[t] = true; return a; }, {} as Record<string, boolean>) });
    server.close();
  }

  console.log(`[notificationPolicy] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
