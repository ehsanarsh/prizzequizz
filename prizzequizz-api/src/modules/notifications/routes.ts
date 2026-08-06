import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { notifications } from '../../services/notificationService.js';
import { effectivePushConfig } from '../../services/pushConfigService.js';
import { repositories } from '../../repositories/index.js';
import { bumpCampaignClick } from '../../services/notificationCampaignService.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

export function registerNotificationRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/notifications`, async (ctx) => {
    json(ctx.res, 200, await notifications.list(ctx.userId ?? 'u1', Number(ctx.query.get('limit') ?? 50)));
  });

  // Public VAPID key the client needs to subscribe to web-push. Null when push
  // isn't configured on the server (client then falls back to in-app only).
  // Read through the config service so a key set in the admin panel works
  // without a restart, not only one baked into the container's environment.
  router.add('GET', `${base}/notifications/vapid-public-key`, async (ctx) => {
    const cfg = await effectivePushConfig();
    json(ctx.res, 200, { publicKey: cfg.configured ? cfg.publicKey : null });
  });

  // Count of unread notifications (for the header bell badge).
  router.add('GET', `${base}/notifications/unread-count`, async (ctx) => {
    const rows = await notifications.list(ctx.userId ?? 'u1', 100);
    json(ctx.res, 200, { count: rows.filter((n) => !n.readAt).length });
  });

  // Send a REAL test notification to the current user (appears in their list +
  // push), so the settings screen's "test" button is not a fake toast.
  router.add('POST', `${base}/notifications/test`, async (ctx) => {
    const n = await notifications.create({ userId: ctx.userId ?? 'u1', type: 'system', title: 'اعلان آزمایشی 🔔', body: 'اگر این پیام را می‌بینی، اعلان‌های تو درست کار می‌کند.', data: { url: '/notifications', test: true }, push: true });
    json(ctx.res, 201, n);
  });

  router.add('GET', `${base}/notifications/preferences`, async (ctx) => {
    json(ctx.res, 200, await notifications.preferences(ctx.userId ?? 'u1'));
  });

  router.add('PUT', `${base}/notifications/preferences`, async (ctx) => {
    const body = bodyObject(ctx.body);
    json(ctx.res, 200, await notifications.updatePreferences(ctx.userId ?? 'u1', {
      matchUpdates: typeof body.matchUpdates === 'boolean' ? body.matchUpdates : undefined,
      leaderboardUpdates: typeof body.leaderboardUpdates === 'boolean' ? body.leaderboardUpdates : undefined,
      walletUpdates: typeof body.walletUpdates === 'boolean' ? body.walletUpdates : undefined,
      promos: typeof body.promos === 'boolean' ? body.promos : undefined,
      quietHoursStart: optionalString(body, 'quietHoursStart'),
      quietHoursEnd: optionalString(body, 'quietHoursEnd')
    }));
  });

  router.add('POST', `${base}/notifications/push-subscriptions`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const keys = typeof body.keys === 'object' && body.keys ? body.keys as Record<string, unknown> : {};
    const subscription = await notifications.subscribe(ctx.userId ?? 'u1', {
      endpoint: requiredString(body, 'endpoint'),
      keys: { p256dh: requiredString(keys, 'p256dh'), auth: requiredString(keys, 'auth') },
      deviceLabel: optionalString(body, 'deviceLabel')
    }, String(ctx.req.headers['user-agent'] ?? 'unknown'));
    json(ctx.res, 201, subscription);
  });

  /* Everything the phone needs to explain itself. "The bell shows it but
   * nothing appears on my screen" has four different causes — no keys on the
   * server, this handset never registered, the account muted that kind of
   * message, or quiet hours — and they are indistinguishable from the game
   * screen without this. The endpoints are the caller's own, so returning them
   * leaks nothing they did not send us. */
  router.add('GET', `${base}/notifications/push-status`, async (ctx) => {
    const userId = ctx.userId ?? 'u1';
    const cfg = await effectivePushConfig();
    const subs = await repositories.notifications.listSubscriptions(userId);
    const prefs = await notifications.preferences(userId);
    json(ctx.res, 200, {
      serverConfigured: cfg.configured,
      devices: subs.length,
      endpoints: subs.map((s) => s.endpoint),
      preferences: {
        matchUpdates: prefs.matchUpdates, leaderboardUpdates: prefs.leaderboardUpdates,
        walletUpdates: prefs.walletUpdates, promos: prefs.promos,
        quietHoursStart: prefs.quietHoursStart ?? '', quietHoursEnd: prefs.quietHoursEnd ?? ''
      }
    });
  });

  router.add('DELETE', `${base}/notifications/push-subscriptions/:id`, async (ctx) => {
    const revoked = await notifications.revoke(ctx.params.id!, ctx.userId ?? 'u1');
    if (!revoked) return error(ctx.res, 404, 'SUBSCRIPTION_NOT_FOUND', 'Push subscription not found.');
    json(ctx.res, 200, { revoked });
  });

  router.add('POST', `${base}/notifications/:id/read`, async (ctx) => {
    const updated = await notifications.markRead(ctx.params.id!, ctx.userId ?? 'u1');
    if (!updated) return error(ctx.res, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
    json(ctx.res, 200, { updated });
  });

  // Click / action-tap tracking: marks the notification read (=opened) and, if it
  // belongs to an admin campaign, bumps that campaign's click counter for CTR.
  router.add('POST', `${base}/notifications/:id/click`, async (ctx) => {
    const uid = ctx.userId ?? 'u1';
    const list = await notifications.list(uid, 100);
    const n = list.find((x) => x.id === ctx.params.id);
    await notifications.markRead(ctx.params.id!, uid);
    const campaignId = n && n.data && (n.data as any).campaignId;
    if (campaignId) { try { await bumpCampaignClick(String(campaignId)); } catch { /* analytics optional */ } }
    json(ctx.res, 200, { tracked: true, url: (n && n.data && (n.data as any).url) || '/' });
  });

  router.add('POST', `${base}/notifications/read-all`, async (ctx) => {
    json(ctx.res, 200, { updated: await notifications.markAllRead(ctx.userId ?? 'u1') });
  });
}
