import webPush from 'web-push';
import { repositories } from '../repositories/index.js';
import type { NotificationPreferences, NotificationRecord, NotificationType, PushSubscriptionRecord } from '../types/domain.js';
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
  constructor() {
    webPush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@prizzequizz.local',
      process.env.VAPID_PUBLIC_KEY || '',
      process.env.VAPID_PRIVATE_KEY || ''
    );
  }

  async send(subscription: PushSubscriptionRecord, payload: Record<string, unknown>): Promise<void> {
    await webPush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload));
  }
}

export class NotificationService {
  constructor(private readonly provider: PushProvider) {}

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
    await repositories.notifications.saveSubscription(record);
    await this.create({ userId, type: 'system', title: 'اعلان‌ها فعال شد', body: 'از این به بعد پیام‌های مهم PrizzeQuizz را دریافت می‌کنی.', push: false });
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
    await repositories.notifications.saveNotification(notification);
    if (input.push !== false) await this.dispatch(notification);
    return notification;
  }

  async broadcast(input: { userIds: string[]; type: NotificationType; title: string; body: string; data?: Record<string, unknown>; push?: boolean }): Promise<{ created: number; sent: number; skipped: number }> {
    let created = 0;
    let sent = 0;
    let skipped = 0;
    for (const userId of input.userIds) {
      const allowed = await this.allowedByPreference(userId, input.type);
      if (!allowed) { skipped += 1; continue; }
      const notification = await this.create({ userId, type: input.type, title: input.title, body: input.body, data: input.data, push: input.push });
      created += 1;
      if (notification.status === 'sent') sent += 1;
    }
    return { created, sent, skipped };
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
    return { provider: this.provider.name, vapidConfigured: vapidConfigured(), subscriptions, queued, sent, failed, unread };
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
    const payload = { id: notification.id, type: notification.type, title: notification.title, body: notification.body, data: notification.data, url: notification.data.url ?? '/' };
    try {
      await Promise.all(subscriptions.map((sub) => this.provider.send(sub, payload)));
      notification.status = 'sent';
      notification.sentAt = new Date().toISOString();
    } catch (error) {
      notification.status = 'failed';
      notification.error = error instanceof Error ? error.message : 'push failed';
      logger.warn('push_notification_failed', { notificationId: notification.id, userId: notification.userId, message: notification.error });
    }
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

function vapidConfigured(): boolean {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function hashEndpoint(endpoint: string): string {
  let hash = 0;
  for (const ch of endpoint) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(16);
}

const provider: PushProvider = process.env.PUSH_PROVIDER === 'webpush' && vapidConfigured()
  ? new WebPushProvider()
  : new LogPushProvider();

export const notifications = new NotificationService(provider);
