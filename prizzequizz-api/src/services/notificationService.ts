import webPush from 'web-push';
import { effectivePushConfig } from './pushConfigService.js';
import { repositories } from '../repositories/index.js';
import type { NotificationPreferences, NotificationRecord, NotificationType, PushSubscriptionRecord } from '../types/domain.js';
import { typeAllowed } from './notificationPolicyService.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceLabel?: string;
}

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  push?: boolean;
}

export interface NotificationDiagnostics {
  provider: 'log' | 'webpush';
  vapidConfigured: boolean;
  /** 'env' = set on the container, 'db' = set in the admin panel, 'none' = unset. */
  source: 'env' | 'db' | 'none';
  subscriptions: number;
  queued: number;
  sent: number;
  failed: number;
  unread: number;
}

interface PushProvider {
  readonly name: 'log' | 'webpush';
  send(subscription: PushSubscriptionRecord, payload: Record<string, unknown>): Promise<void>;
}

class LogPushProvider implements PushProvider {
  readonly name = 'log' as const;
  async send(subscription: PushSubscriptionRecord, payload: Record<string, unknown>): Promise<void> {
    logger.info('push_notification_logged', { userId: subscription.userId, endpointHash: hashEndpoint(subscription.endpoint), title: payload.title });
  }
}

class WebPushProvider implements PushProvider {
  readonly name = 'webpush' as const;
  /* Keys are passed per call rather than through webPush.setVapidDetails().
   * That setter is process-global: with keys now editable at runtime, a save
   * would have raced with an in-flight campaign and signed some of it with the
   * old pair. */
  constructor(private readonly vapid: { subject: string; publicKey: string; privateKey: string }) {}

  async send(subscription: PushSubscriptionRecord, payload: Record<string, unknown>): Promise<void> {
    await webPush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      { vapidDetails: this.vapid }
    );
  }
}

export class NotificationService {
  /* No provider means "decide per send from the current configuration" — keys
   * can be changed in the panel and take effect without a restart. Tests and
   * callers that want a fixed provider still pass one in. */
  constructor(private readonly provider?: PushProvider) {}

  private async sender(): Promise<PushProvider> {
    if (this.provider) return this.provider;
    const cfg = await effectivePushConfig();
    if (!cfg.configured) return new LogPushProvider();
    return new WebPushProvider({ subject: cfg.subject, publicKey: cfg.publicKey, privateKey: cfg.privateKey });
  }

  async subscribe(userId: string, input: PushSubscriptionInput, userAgent?: string): Promise<PushSubscriptionRecord> {
    if (!input.endpoint || !input.keys?.p256dh || !input.keys?.auth) throw new Error('INVALID_PUSH_SUBSCRIPTION');
    const now = new Date().toISOString();
    const record: PushSubscriptionRecord = {
      id: id(),
      userId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      deviceLabel: input.deviceLabel,
      userAgent,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now
    };
    /* The browser re-registers its push subscription on every launch, and this
     * used to greet each one with «اعلان‌ها فعال شد» — so the inbox collected
     * a fresh copy every single time the game was opened. The storage layer
     * upserts on the endpoint, so a re-registration is not a new device and
     * has nothing to announce.
     *
     * Only a genuinely unknown endpoint is worth a word, and it is said once. */
    const known = await repositories.notifications.listSubscriptions(userId).catch(() => []);
    const isNewDevice = !known.some((s) => s.endpoint === input.endpoint && !s.revokedAt);
    await repositories.notifications.saveSubscription(record);
    if (isNewDevice) {
      await this.create({ userId, type: 'system', title: 'اعلان‌ها فعال شد', body: 'از این به بعد پیام‌های مهم PrizzeQuizz را دریافت می‌کنی.', push: false });
    }
    return record;
  }

  async revoke(subscriptionId: string, userId: string): Promise<boolean> {
    return repositories.notifications.revokeSubscription(subscriptionId, userId);
  }

  async preferences(userId: string): Promise<NotificationPreferences> {
    const existing = await repositories.notifications.getPreferences(userId);
    if (existing) return existing;
    const defaults = defaultPreferences(userId);
    await repositories.notifications.savePreferences(defaults);
    return defaults;
  }

  async updatePreferences(userId: string, patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
    const current = await this.preferences(userId);
    const next: NotificationPreferences = {
      ...current,
      matchUpdates: patch.matchUpdates ?? current.matchUpdates,
      leaderboardUpdates: patch.leaderboardUpdates ?? current.leaderboardUpdates,
      walletUpdates: patch.walletUpdates ?? current.walletUpdates,
      promos: patch.promos ?? current.promos,
      quietHoursStart: typeof patch.quietHoursStart === 'string' ? patch.quietHoursStart : current.quietHoursStart,
      quietHoursEnd: typeof patch.quietHoursEnd === 'string' ? patch.quietHoursEnd : current.quietHoursEnd,
      updatedAt: new Date().toISOString()
    };
    await repositories.notifications.savePreferences(next);
    return next;
  }

  async list(userId: string, limit = 50): Promise<NotificationRecord[]> {
    return repositories.notifications.listNotifications(userId, Math.min(100, Math.max(1, limit)));
  }

  async markRead(notificationId: string, userId: string): Promise<boolean> {
    return repositories.notifications.markRead(notificationId, userId);
  }

  async markAllRead(userId: string): Promise<number> {
    return repositories.notifications.markAllRead(userId);
  }

  async create(input: NotificationInput): Promise<NotificationRecord> {
    /* The operator's game-wide switch. A type turned off is not written to
     * anybody's inbox and not pushed — gating only the push would leave the
     * bell filling up exactly as before, which is the whole complaint. */
    const allowed = await typeAllowed(input.type).catch(() => true);
    const notification: NotificationRecord = {
      id: id(),
      userId: input.userId,
      type: input.type,
      title: input.title.slice(0, 160),
      body: input.body.slice(0, 800),
      data: input.data ?? {},
      channel: input.push ? 'push' : 'in_app',
      status: 'queued',
      createdAt: new Date().toISOString()
    };
    if (!allowed) {
      /* Returned, not thrown: every caller treats a notification as a
         side-effect and none of them should fail because the operator muted a
         category. It simply never existed. */
      return { ...notification, status: 'failed' };
    }
    await repositories.notifications.saveNotification(notification);
    if (input.push !== false) await this.dispatch(notification);
    return notification;
  }

  /* One recipient must never take the campaign down with it. This loop used to
   * let any failure escape — a stale id, a row the database rejected — so a
   * single bad entry aborted the send and the panel showed the raw database
   * error instead of delivering to the thousands of people who were fine.
   * A failure is now counted and reported, and the rest still go out. */
  async broadcast(input: { userIds: string[]; type: NotificationType; title: string; body: string; data?: Record<string, unknown>; push?: boolean }): Promise<{ created: number; sent: number; skipped: number; failed: number; errors: string[] }> {
    let created = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const userId of input.userIds) {
      try {
        const allowed = await this.allowedByPreference(userId, input.type);
        if (!allowed) { skipped += 1; continue; }
        const notification = await this.create({ userId, type: input.type, title: input.title, body: input.body, data: input.data, push: input.push });
        created += 1;
        if (notification.status === 'sent') sent += 1;
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : 'unknown';
        if (errors.length < 5) errors.push(msg);
        logger.warn('notification_recipient_failed', { userId, message: msg });
      }
    }
    if (failed) logger.error('notification_broadcast_partial', { failed, created, total: input.userIds.length });
    return { created, sent, skipped, failed, errors };
  }

  async diagnostics(): Promise<NotificationDiagnostics> {
    const users = await repositories.users.list(1000);
    let subscriptions = 0;
    let queued = 0;
    let sent = 0;
    let failed = 0;
    let unread = 0;
    for (const user of users) {
      subscriptions += (await repositories.notifications.listSubscriptions(user.id)).length;
      const rows = await repositories.notifications.listNotifications(user.id, 1000);
      queued += rows.filter((n) => n.status === 'queued').length;
      sent += rows.filter((n) => n.status === 'sent').length;
      failed += rows.filter((n) => n.status === 'failed').length;
      unread += rows.filter((n) => !n.readAt).length;
    }
    const cfg = await effectivePushConfig();
    return {
      provider: this.provider ? this.provider.name : (cfg.configured ? 'webpush' : 'log'),
      vapidConfigured: this.provider ? true : cfg.configured,
      /* Where the keys came from, so the panel can tell "set in the panel" from
       * "set in the container" — they are fixed in very different places. */
      source: cfg.source,
      subscriptions, queued, sent, failed, unread
    };
  }

  private async dispatch(notification: NotificationRecord): Promise<void> {
    if (!(await this.allowedByPreference(notification.userId, notification.type))) {
      notification.status = 'queued';
      await repositories.notifications.saveNotification(notification);
      return;
    }
    const subscriptions = await repositories.notifications.listSubscriptions(notification.userId);
    if (!subscriptions.length) {
      notification.status = 'queued';
      await repositories.notifications.saveNotification(notification);
      return;
    }
    const payload = {
      id: notification.id, type: notification.type, title: notification.title, body: notification.body,
      data: notification.data, url: notification.data.url ?? '/',
      /* Passed through so a campaign's picture reaches the tray as well as the
       * in-app inbox. The worker falls back to the app icon. */
      image: typeof notification.data.image === 'string' ? notification.data.image : undefined
    };
    /* Each device on its own. Promise.all marked the whole notification failed
     * when ANY device rejected it — so one stale phone made a message that
     * three other devices received look undelivered. And an endpoint the push
     * service has retired (404/410) stayed on the account forever, failing every
     * time; those are dropped here so they stop poisoning later sends. */
    const sender = await this.sender();
    let ok = 0, gone = 0;
    const errors: string[] = [];
    for (const sub of subscriptions) {
      try { await sender.send(sub, payload); ok++; }
      catch (error) {
        const status = Number((error as any)?.statusCode ?? 0);
        const msg = error instanceof Error ? error.message : 'push failed';
        if (status === 404 || status === 410) {
          gone++;
          try { await repositories.notifications.revokeSubscription(sub.id, sub.userId); } catch { /* best effort */ }
        } else if (errors.length < 3) errors.push(msg);
      }
    }
    if (ok > 0) {
      notification.status = 'sent';
      notification.sentAt = new Date().toISOString();
    } else if (subscriptions.length === gone) {
      // Every device this account had is retired; it stays in the inbox.
      notification.status = 'queued';
    } else {
      notification.status = 'failed';
      notification.error = errors[0] ?? 'push failed';
      logger.warn('push_notification_failed', { notificationId: notification.id, userId: notification.userId, message: notification.error });
    }
    if (gone) logger.info('push_subscriptions_pruned', { userId: notification.userId, gone });
    await repositories.notifications.saveNotification(notification);
  }

  private async allowedByPreference(userId: string, type: NotificationType): Promise<boolean> {
    const prefs = await this.preferences(userId);
    if (inQuietHours(prefs)) return false;
    if (type === 'match_update') return prefs.matchUpdates;
    if (type === 'leaderboard_update') return prefs.leaderboardUpdates;
    if (type === 'wallet_update') return prefs.walletUpdates;
    if (type === 'promo') return prefs.promos;
    return true;
  }
}

function defaultPreferences(userId: string): NotificationPreferences {
  return { userId, matchUpdates: true, leaderboardUpdates: true, walletUpdates: true, promos: false, updatedAt: new Date().toISOString() };
}

function inQuietHours(prefs: NotificationPreferences): boolean {
  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = parseTime(prefs.quietHoursStart);
  const end = parseTime(prefs.quietHoursEnd);
  if (start === null || end === null || start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function parseTime(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function hashEndpoint(endpoint: string): string {
  let hash = 0;
  for (const ch of endpoint) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(16);
}

/* No fixed provider: the effective one is resolved per send, so keys set in the
 * admin panel work immediately and no restart is involved. */
export const notifications = new NotificationService();
