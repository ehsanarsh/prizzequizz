/* PUSH DELIVERY — what actually reaches the phone.
 *
 * The report: "اعلان ارسال میشه ولی مثل پیامک تو گوشی صدا نمیده" — the panel
 * said sent, the inbox had the message, and the handset showed nothing. Two
 * separate things had to be true for that: the server has to address every one
 * of a user's devices individually, and the payload it hands the service worker
 * has to carry enough for the tray to draw a real notification.
 *
 * These tests stand in for the push service with a fake provider, so the whole
 * chain up to the network hop is exercised: who gets addressed, what they get,
 * what happens when a phone has been wiped, and what the panel is told. */
import assert from 'node:assert/strict';
import { NotificationService } from '../services/notificationService.js';
import type { PushSubscriptionRecord } from '../types/domain.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** A push service we can make behave badly on purpose. */
class FakeProvider {
  readonly name = 'webpush' as const;
  sent: { endpoint: string; payload: any }[] = [];
  /** endpoint → HTTP status to reject with. */
  fail = new Map<string, number>();
  async send(sub: PushSubscriptionRecord, payload: Record<string, unknown>): Promise<void> {
    const status = this.fail.get(sub.endpoint);
    if (status) {
      const err: any = new Error('push rejected: ' + status);
      err.statusCode = status;
      throw err;
    }
    this.sent.push({ endpoint: sub.endpoint, payload });
  }
}

async function makeUser(): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'push_' + userId.slice(0, 8),
    displayName: 'تستی', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}

/** Register a device the way the game does when the player allows notifications. */
async function addDevice(svc: NotificationService, userId: string, endpoint: string): Promise<void> {
  await svc.subscribe(userId, { endpoint, keys: { p256dh: 'p-' + endpoint, auth: 'a-' + endpoint } });
}

/* dispatch() settles the record in place, so what create() hands back is the
   final state — reading the inbox back would mean guessing at its ordering. */

async function run() {
  await check('a message goes to every device the player registered', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/phone');
    await addDevice(svc, uid, 'https://fcm/tablet');
    p.sent = [];

    await svc.create({ userId: uid, type: 'system', title: 'سلام', body: 'متن' });
    assert.deepEqual(p.sent.map((s) => s.endpoint).sort(), ['https://fcm/phone', 'https://fcm/tablet']);
  });

  await check('the payload carries what the tray needs to draw a real notification', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/a');
    p.sent = [];

    await svc.create({ userId: uid, type: 'system', title: 'جایزهٔ روزانه', body: 'گردونه‌ات آمادهٔ چرخیدن است.', data: { url: '/wheel' } });
    const payload = p.sent[0]!.payload;
    assert.equal(payload.title, 'جایزهٔ روزانه', 'without a title the phone shows the site name only');
    assert.equal(payload.body, 'گردونه‌ات آمادهٔ چرخیدن است.');
    assert.equal(payload.url, '/wheel', 'tapping it must land on the right screen');
    assert.ok(payload.id, 'the worker tags the notification with this so a second one does not replace the first');
  });

  await check('a campaign picture is passed through to the tray', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/b');
    await svc.updatePreferences(uid, { promos: true });
    p.sent = [];

    await svc.create({ userId: uid, type: 'promo', title: 'کمپین', body: 'متن', data: { image: 'https://cdn/x.png' } });
    assert.equal(p.sent[0]!.payload.image, 'https://cdn/x.png');
  });

  await check('one dead phone does not make a delivered message look failed', async () => {
    /* The old code used Promise.all: any single rejection marked the whole
       notification failed, even though the other handsets had it. */
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/good');
    await addDevice(svc, uid, 'https://fcm/broken');
    p.fail.set('https://fcm/broken', 500);

    const n = await svc.create({ userId: uid, type: 'system', title: 'تحویل', body: 'متن' });
    assert.equal(n.status, 'sent');
  });

  await check('an endpoint the push service retired is dropped instead of failing forever', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/stale');
    await addDevice(svc, uid, 'https://fcm/live');
    p.fail.set('https://fcm/stale', 410);

    await svc.create({ userId: uid, type: 'system', title: 'هرس', body: 'متن' });
    const left = await repositories.notifications.listSubscriptions(uid);
    assert.deepEqual(left.map((s) => s.endpoint), ['https://fcm/live'], 'the retired one must not be tried again');
  });

  await check('a phone that merely errored is kept — it may come back', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/flaky');
    p.fail.set('https://fcm/flaky', 500);

    const n = await svc.create({ userId: uid, type: 'system', title: 'خطای موقت', body: 'متن' });
    assert.equal((await repositories.notifications.listSubscriptions(uid)).length, 1);
    assert.equal(n.status, 'failed');
    assert.ok(n.error, 'the panel needs a reason to show');
  });

  await check('when every device is gone the message waits in the inbox rather than reading as failed', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/x1');
    p.fail.set('https://fcm/x1', 404);

    const n = await svc.create({ userId: uid, type: 'system', title: 'بی‌دستگاه', body: 'متن' });
    assert.equal(n.status, 'queued');
  });

  await check('a player who never allowed notifications still gets the in-app message', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();

    const n = await svc.create({ userId: uid, type: 'system', title: 'بدون اجازه', body: 'متن' });
    assert.equal(p.sent.length, 0, 'there is nothing to send to');
    assert.equal(n.status, 'queued', 'and it is not an error');
    const inbox = await repositories.notifications.listNotifications(uid, 20);
    assert.ok(inbox.some((r) => r.title === 'بدون اجازه'), 'but it is in their inbox');
  });

  await check('a promo is withheld from someone who turned promos off', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/optout');
    p.sent = [];
    await svc.updatePreferences(uid, { promos: false });

    const res = await svc.broadcast({ userIds: [uid], type: 'promo', title: 'تخفیف', body: 'متن' });
    assert.equal(res.skipped, 1);
    assert.equal(p.sent.length, 0, 'the whole point of the switch');
  });

  await check('the same person is reported as sent when a device really took it', async () => {
    const p = new FakeProvider();
    const svc = new NotificationService(p);
    const uid = await makeUser();
    await addDevice(svc, uid, 'https://fcm/counts');

    const res = await svc.broadcast({ userIds: [uid], type: 'system', title: 'شمارش', body: 'متن' });
    assert.equal(res.created, 1);
    assert.equal(res.sent, 1, 'the panel must distinguish "delivered" from "written to the inbox"');
    assert.equal(res.failed, 0);
  });

  await check('diagnostics tell the panel whether push is configured at all', async () => {
    const d = await new NotificationService(new FakeProvider()).diagnostics();
    assert.equal(d.provider, 'webpush');
    assert.equal(typeof d.vapidConfigured, 'boolean');
    assert.ok(d.subscriptions >= 1, 'the devices registered above must be counted');
  });

  console.log(`[pushDispatch] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
