/* SENDING A NOTIFICATION FROM THE PANEL.
 *
 * The reported failure: "invalid input syntax for type uuid" and nothing sent.
 * A hand-typed recipient went straight through to an insert against a UUID
 * column, and one bad row aborted the whole loop — so a campaign to thousands
 * died on one typo. */
import assert from 'node:assert/strict';
import { resolveSegment, resolveRecipients } from '../services/notificationSegmentService.js';
import { notifications } from '../services/notificationService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function makeUser(username: string, phone: string): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone, username, displayName: username, plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}

async function run() {
  const uid = await makeUser('taghi_' + Date.now().toString(36), '0912' + Math.floor(Math.random() * 1e7));
  const user = (await repositories.users.findById(uid))!;

  await check('a username typed in the box resolves to that user', async () => {
    const r = await resolveRecipients([user.username]);
    assert.deepEqual(r.ids, [uid]);
    assert.equal(r.unknown.length, 0);
  });

  await check('a phone number resolves too', async () => {
    const r = await resolveRecipients([user.phone]);
    assert.deepEqual(r.ids, [uid]);
  });

  await check('the id itself still works', async () => {
    const r = await resolveRecipients([uid]);
    assert.deepEqual(r.ids, [uid]);
  });

  await check('a name that does not exist is reported, not passed on', async () => {
    const r = await resolveRecipients(['کاربر-ناموجود', 'not-a-uuid-at-all']);
    assert.equal(r.ids.length, 0);
    assert.equal(r.unknown.length, 2, 'the operator gets told what did not match');
  });

  await check('a manual segment only ever yields real user ids', async () => {
    const seg = await resolveSegment({ userIds: [user.username, 'ghost-user'] } as any);
    assert.deepEqual(seg.userIds, [uid], 'the ghost must not reach the database');
    assert.deepEqual(seg.unknown, ['ghost-user']);
  });

  await check('one impossible recipient does not stop the rest', async () => {
    /* Exactly the production shape: a good id next to something the database
       will refuse. Before the fix this threw and nothing at all was sent. */
    const res = await notifications.broadcast({
      userIds: [uid, 'definitely-not-a-uuid'],
      type: 'system', title: 'تست', body: 'پیام آزمایشی', push: false
    });
    assert.ok(res.created >= 1, 'the real user must still receive it');
    assert.equal(typeof res.failed, 'number');
  });

  await check('the good recipient really has the message', async () => {
    const rows = await repositories.notifications.listNotifications(uid, 20);
    assert.ok(rows.some((n) => n.title === 'تست'), 'it must be in their inbox');
  });

  await check('a broadcast to nobody reports zero rather than throwing', async () => {
    const res = await notifications.broadcast({ userIds: [], type: 'system', title: 'x', body: 'y', push: false });
    assert.equal(res.created, 0);
    assert.equal(res.failed, 0);
  });

  await check('every failure is counted', async () => {
    const res = await notifications.broadcast({
      userIds: ['bad-1', 'bad-2', 'bad-3'], type: 'system', title: 'x', body: 'y', push: false
    });
    assert.equal(res.created + res.failed + res.skipped, 3, 'nothing may go unaccounted for');
  });

  console.log(`[notifySend] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
