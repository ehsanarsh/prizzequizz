import type { AppState } from '../types/app';
import { topbar } from '../components/layout';
import { emptyState, errorState, skeletonList } from '../components/statusViews';
import { getSupportMessages, getSupportTab, getSupportTickets } from '../features/support/support.state';

export function renderSupport(state: AppState): string {
  const tab = getSupportTab();
  const loading = state.ui.loading['support.hydrate'];
  const error = state.ui.errors['support.hydrate'];
  return `<section class="screen support pad">
    ${topbar('پشتیبانی', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="support-hero"><b>مرکز پشتیبانی</b><p>چت زنده، تیکت، سوالات پرتکرار و وضعیت سرویس‌ها.</p></div>
    <div class="tabs small-tabs">
      ${tabButton('home', 'خانه', tab)}${tabButton('chat', 'چت', tab)}${tabButton('tickets', 'تیکت', tab)}${tabButton('faq', 'FAQ', tab)}${tabButton('status', 'وضعیت', tab)}
    </div>
    <div class="support-content">${loading ? skeletonList(3) : error ? errorState(error, 'retry-support') : renderTab(tab)}</div>
  </section>`;
}

function renderTab(tab: string): string {
  if (tab === 'chat') {
    const messages = getSupportMessages();
    return `<div class="chat-view support-chat"><div class="chat-body">${messages.map((m) => `<div class="msg ${m.from === 'me' ? 'me' : 'them'}">${m.text}</div>`).join('')}</div><div class="chat-send"><input id="supportMessageInput" class="input" placeholder="پیامت رو بنویس..."/><button class="primary" data-action="send-support-message">➤</button></div></div>`;
  }
  if (tab === 'tickets') {
    const tickets = getSupportTickets();
    return `<div class="list-card"><b>تیکت جدید</b><input id="ticketTitle" class="input" placeholder="عنوان"/><textarea id="ticketBody" class="input" placeholder="توضیحات"></textarea><button class="primary" data-action="create-ticket">ارسال تیکت</button></div>${tickets.length ? tickets.map((t) => `<div class="list-card"><b>#${t.id} ${t.title}</b><p>${t.reply}</p><small>${t.status}</small></div>`).join('') : emptyState('🎫', 'تیکتی نداری', 'برای پیگیری جدی، تیکت بساز.')}`;
  }
  if (tab === 'faq') return `<div class="list-card"><b>چطور جایزه برداشت کنم؟</b><p>از کیف پول درخواست برداشت ثبت کن.</p></div><div class="list-card"><b>اگر بازی را ترک کنم؟</b><p>در بازی جایزه‌دار از همان راند حذف می‌شوی.</p></div>`;
  if (tab === 'status') return `<div class="list-card"><b>سرور مسابقات</b><p>فعال و پایدار ✅</p></div><div class="list-card"><b>پرداخت</b><p>فعال ✅</p></div>`;
  return `<div class="list-card"><b>چه کمکی لازم داری؟</b><p>برای پاسخ سریع از چت استفاده کن یا تیکت ثبت کن.</p><button class="primary" data-support-tab="chat">شروع چت</button></div>`;
}

function tabButton(id: string, label: string, active: string): string { return `<button class="${id === active ? 'active' : ''}" data-support-tab="${id}">${label}</button>`; }
