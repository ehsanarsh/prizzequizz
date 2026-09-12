/* WHY CHROME WAS SLOW AND FIREFOX WAS NOT.
 *
 * «اعلان‌ها در مرورگر کروم دیر می‌رسه ولی مرورگرهای دیگه زود می‌ره.»
 *
 * Same server, same code, same message — so the difference could not be in
 * what was sent, only in what was NOT sent. Two headers were missing entirely:
 * Urgency and TTL. The Web Push default for Urgency is `normal`, and Chrome's
 * push service is allowed to sit on a normal-urgency message until the handset
 * wakes up for something else; Firefox's delivers it immediately. One default,
 * two behaviours, and it reads as «Chrome is broken».
 *
 * These hold the two rules that are easy to get wrong in opposite directions:
 * marking everything urgent (which is how people end up switching notifications
 * off) and letting everything live forever (which delivers news about a match
 * that finished an hour ago).
 *
 * Run: npx tsx src/tests/pushUrgency.test.ts */
import assert from 'node:assert/strict';
import { pushUrgency, pushTtlSeconds, NotificationService } from '../services/notificationService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import webPush from 'web-push';

/* Real VAPID keys are needed for the service to pick the web-push provider at
   all; these are a throwaway pair generated for the test and sign nothing that
   leaves the process. */
const VAPID = webPush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = VAPID.publicKey;
process.env.VAPID_PRIVATE_KEY = VAPID.privateKey;
process.env.VAPID_SUBJECT = 'mailto:test@example.com';

async function subscriber(): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'p' + uid.slice(0, 6), displayName: 'p',
    phone: '09' + String(300000000 + Math.floor(Math.random() * 9999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0, tickets: {}
  } as any);
  await repositories.notifications.saveSubscription({
    id: id(), userId: uid, endpoint: 'https://fcm.googleapis.com/fcm/send/' + uid,
    keys: { p256dh: VAPID.publicKey, auth: 'YWJjZGVmZ2hpamtsbW5vcA' }, createdAt: new Date().toISOString()
  } as any);
  return uid;
}

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  await check('the things a player is waiting on are sent urgently', () => {
    assert.equal(pushUrgency('match_update'), 'high', 'a match starting is the whole reason for a push');
    assert.equal(pushUrgency('friend_message'), 'high');
  });

  await check('and an advert is not', () => {
    /* Waking somebody\'s phone for a shop promo is how a player ends up turning
       notifications off altogether — and then never hears about a match. */
    assert.equal(pushUrgency('promo'), 'low');
  });

  await check('nothing is left on the default that caused this', () => {
    /* The bug was the ABSENCE of the header, so «normal» chosen on purpose is
       fine and «normal» by accident is not. Every type has to be a decision. */
    for (const t of ['match_update', 'friend_message', 'wallet_update', 'system', 'promo', 'leaderboard_update'] as const) {
      assert.ok(['very-low', 'low', 'normal', 'high'].includes(pushUrgency(t)), t + ' has no urgency');
    }
  });

  await check('news that goes stale is allowed to expire', () => {
    assert.ok(pushTtlSeconds('match_update') <= 900,
      'a push about a match must not be handed over after the match is done');
  });

  await check('while a message worth reading tomorrow survives the night', () => {
    assert.ok(pushTtlSeconds('friend_message') >= 3600 * 12);
    assert.ok(pushTtlSeconds('promo') >= 3600 * 24);
  });

  await check('and a match expires far sooner than an advert', () => {
    assert.ok(pushTtlSeconds('match_update') < pushTtlSeconds('promo'),
      'the urgent one is the one that must NOT linger — these are different questions');
  });

  /* ── and the sender actually puts them on the wire ─────────────────── */

  await check('every push really carries both headers onto the wire', async () => {
    /* The rules above are worth nothing if the send drops them, which is
       precisely what used to happen — so the actual library call is caught and
       its options read, rather than something nearby being checked instead. */
    const calls: any[] = [];
    const real = (webPush as any).sendNotification;
    (webPush as any).sendNotification = async (_sub: any, _payload: any, opts: any) => { calls.push(opts); };
    try {
      const svc = new NotificationService();
      const uid = await subscriber();
      await svc.create({ userId: uid, type: 'match_update', title: 'م', body: 'ب', push: true });
      assert.equal(calls.length, 1, 'nothing reached the push library');
      assert.equal(calls[0].urgency, 'high', 'the header that fixes Chrome was not sent');
      assert.equal(calls[0].TTL, 600, 'no expiry, so stale news can still be delivered');
    } finally { (webPush as any).sendNotification = real; }
  });

  await check('and a promo goes out quietly, not urgently', async () => {
    const calls: any[] = [];
    const real = (webPush as any).sendNotification;
    (webPush as any).sendNotification = async (_s: any, _p: any, o: any) => { calls.push(o); };
    try {
      const svc = new NotificationService();
      const uid = await subscriber();
      await repositories.notifications.savePreferences({
        userId: uid, matchUpdates: true, leaderboardUpdates: true, walletUpdates: true,
        promos: true, friendMessages: true, updatedAt: new Date().toISOString()
      } as any);
      await svc.create({ userId: uid, type: 'promo', title: 'ت', body: 'ب', push: true });
      assert.equal(calls[0].urgency, 'low', 'an advert must not wake a handset');
    } finally { (webPush as any).sendNotification = real; }
  });

  console.log(`[pushUrgency] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
