import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { notifications } from '../../services/notificationService.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

export function registerNotificationRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/notifications`, async (ctx) => {
    json(ctx.res, 200, await notifications.list(ctx.userId ?? 'u1', Number(ctx.query.get('limit') ?? 50)));
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

  router.add('POST', `${base}/notifications/read-all`, async (ctx) => {
    json(ctx.res, 200, { updated: await notifications.markAllRead(ctx.userId ?? 'u1') });
  });
}
