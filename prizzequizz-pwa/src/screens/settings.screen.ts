import type { AppState } from '../types/app';
import type { NotificationPreferencesDto } from '../api/contracts';
import { bottomNav, topbar } from '../components/layout';
import { emptyState, errorState, skeletonList } from '../components/statusViews';
import { getNotificationPreferences, getNotifications, isPushEnabled, notificationPermission } from '../features/notifications/notification.state';

const prefLabels: Array<[keyof Pick<NotificationPreferencesDto, 'matchUpdates' | 'leaderboardUpdates' | 'walletUpdates' | 'promos'>, string, string]> = [
  ['matchUpdates', 'نتیجه مسابقه', 'پایان دوئل، برد، باخت و وضعیت بازی'],
  ['leaderboardUpdates', 'رتبه‌بندی', 'تغییرات مهم در رنکینگ و لیگ هفتگی'],
  ['walletUpdates', 'کیف پول', 'شارژ، برداشت، جایزه و تراکنش مهم'],
  ['promos', 'پیشنهادها', 'کمپین‌ها، جایزه‌های مناسبتی و پیشنهادهای تبلیغاتی']
];

export function renderSettings(state: AppState): string {
  const loading = state.ui.loading['notifications.hydrate'];
  const error = state.ui.errors['notifications.hydrate'];
  const prefs = getNotificationPreferences();
  const permission = notificationPermission();
  return `<section class="screen settings pad">
    ${topbar('تنظیمات', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="list-card notification-hero"><b>🔔 اعلان‌ها</b><p>اعلان‌های مهم بازی، کیف پول و رتبه‌بندی را مدیریت کن.</p><div class="notification-status"><span>مرورگر: ${permissionLabel(permission)}</span><span>${isPushEnabled() ? 'Push فعال' : 'Push غیرفعال'}</span></div><button class="primary" data-action="enable-push">فعال‌سازی Push</button></div>
    ${loading && !prefs ? skeletonList(4) : error && !prefs ? errorState(error, 'retry-notifications') : prefs ? renderPreferences(prefs) : emptyState('🔕','تنظیمی نیست','بعد از اتصال API تنظیمات اعلان‌ها نمایش داده می‌شود.')}
    <div class="list-card"><b>پیام‌های اخیر</b><button class="ghost" data-action="notifications-read-all">خواندن همه</button></div>
    <div class="notifications-list">${renderNotifications()}</div>
    ${bottomNav()}
  </section>`;
}

function renderPreferences(prefs: NotificationPreferencesDto): string {
  return `<div class="settings-list">${prefLabels.map(([key, title, desc]) => `<div class="pref-row"><div><b>${title}</b><small>${desc}</small></div><button class="${prefs[key] ? 'primary' : 'ghost'}" data-pref-key="${key}" data-pref-value="${!prefs[key]}">${prefs[key] ? 'فعال' : 'خاموش'}</button></div>`).join('')}</div>`;
}

function renderNotifications(): string {
  const rows = getNotifications();
  if (!rows.length) return emptyState('📭', 'پیامی نیست', 'اعلان‌های داخل برنامه اینجا نمایش داده می‌شوند.');
  return rows.map((n) => `<div class="notification-row ${n.readAt ? 'read' : ''}"><span>${icon(n.type)}</span><div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body)}</p><small>${new Date(n.createdAt).toLocaleString('fa-IR')}</small></div>${n.readAt ? '<em>خوانده شده</em>' : `<button class="ghost" data-notification-read="${n.id}">خواندم</button>`}</div>`).join('');
}

function permissionLabel(permission: NotificationPermission | 'unsupported'): string {
  if (permission === 'granted') return 'مجاز';
  if (permission === 'denied') return 'مسدود';
  if (permission === 'unsupported') return 'پشتیبانی نمی‌شود';
  return 'در انتظار اجازه';
}

function icon(type: string): string {
  if (type === 'match_update') return '⚔️';
  if (type === 'leaderboard_update') return '🏆';
  if (type === 'wallet_update') return '💰';
  if (type === 'promo') return '🎁';
  return '🔔';
}

function escapeHtml(value: string): string { return value.replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!)); }
