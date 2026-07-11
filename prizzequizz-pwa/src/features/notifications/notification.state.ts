import { api } from '../../api';
import type { NotificationDto, NotificationPreferencesDto } from '../../api/contracts';
import { eventBus } from '../../core/eventBus';
import { runTask } from '../../core/asyncTask';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

let preferences: NotificationPreferencesDto | null = null;
let items: NotificationDto[] = [];
let pushEnabled = false;

export function getNotificationPreferences(): NotificationPreferencesDto | null { return preferences; }
export function getNotifications(): NotificationDto[] { return items; }
export function isPushEnabled(): boolean { return pushEnabled; }
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function hydrateNotifications(): Promise<void> {
  await runTask('notifications.hydrate', async () => {
    const [prefs, list] = await Promise.all([api.notifications.preferences(), api.notifications.list(30)]);
    preferences = prefs;
    items = list;
    pushEnabled = await hasBrowserSubscription();
  });
}

export async function updateNotificationPreference(key: keyof Pick<NotificationPreferencesDto, 'matchUpdates' | 'leaderboardUpdates' | 'walletUpdates' | 'promos'>, value: boolean): Promise<boolean> {
  const result = await runTask('notifications.preference', async () => api.notifications.updatePreferences({ [key]: value }));
  if (result) preferences = result;
  return !!result;
}

export async function enablePushNotifications(): Promise<'enabled' | 'denied' | 'unsupported' | 'missing-vapid' | 'failed'> {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  if (!VAPID_PUBLIC_KEY) {
    eventBus.emit('API_ERROR', { message: 'کلید VAPID برای Push هنوز تنظیم نشده است.', key: 'notifications.push' });
    return 'missing-vapid';
  }
  const result = await runTask('notifications.push', async () => {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY).buffer as ArrayBuffer });
    const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error('اشتراک Push معتبر نیست.');
    return api.notifications.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, deviceLabel: navigator.platform || 'PWA' });
  });
  pushEnabled = !!result;
  if (result) await hydrateNotifications();
  return result ? 'enabled' : 'failed';
}

export async function markNotificationRead(id: string): Promise<void> {
  const result = await runTask('notifications.read', async () => api.notifications.markRead(id));
  if (result?.updated) items = items.map((item) => item.id === id ? { ...item, status: 'read', readAt: new Date().toISOString() } : item);
}

export async function markAllNotificationsRead(): Promise<void> {
  const result = await runTask('notifications.readAll', async () => api.notifications.markAllRead());
  if (result) items = items.map((item) => ({ ...item, status: 'read', readAt: item.readAt ?? new Date().toISOString() }));
}

async function hasBrowserSubscription(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const registration = await navigator.serviceWorker.ready;
    return Boolean(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}
