import type { AppState } from '../types/app';
import { bottomNav, topbar } from '../components/layout';
import { emptyState, errorState, skeletonList } from '../components/statusViews';
import { getCards, getTransactions, getWalletTab } from '../features/wallet/wallet.state';

export function renderWallet(state: AppState): string {
  const tab = getWalletTab();
  const loading = state.ui.loading['wallet.hydrate'];
  const error = state.ui.errors['wallet.hydrate'];

  return `<section class="screen wallet pad">
    ${topbar('کیف پول', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="wallet-hero">
      <small>موجودی قابل استفاده</small>
      <b>${toFa(state.economy.wallet)} <em>تومان</em></b>
      <span>🛡️ امن</span>
    </div>
    <div class="wallet-grid">
      <button class="primary" data-action="wallet-topup">شارژ ۱۰۰٬۰۰۰</button>
      <button class="ghost" data-action="wallet-withdraw">برداشت ۵۰٬۰۰۰</button>
    </div>
    <div class="tabs small-tabs">
      ${tabButton('overview', 'خلاصه', tab)}${tabButton('transactions', 'تراکنش‌ها', tab)}${tabButton('cards', 'کارت‌ها', tab)}${tabButton('security', 'امنیت', tab)}
    </div>
    <div class="wallet-content">${loading ? skeletonList(3) : error ? errorState(error, 'retry-wallet') : renderTab(tab)}</div>
    ${bottomNav()}
  </section>`;
}

function renderTab(tab: string): string {
  if (tab === 'transactions') {
    const txns = getTransactions();
    return txns.length
      ? txns.map((t) => `<div class="txn-row"><span>${t.icon}</span><b>${t.title}</b><small>${t.time} · ${statusText(t.status)}</small><strong class="${t.positive ? 'pos' : 'neg'}">${t.positive ? '+' : '−'}${toFa(t.amount)}</strong></div>`).join('')
      : emptyState('📭', 'تراکنشی نیست', 'فعلاً تراکنشی برای نمایش وجود ندارد.');
  }
  if (tab === 'cards') {
    const cards = getCards();
    return cards.length
      ? cards.map((card) => `<div class="list-card"><b>${card.bank}</b><p>${card.masked}</p><small>${card.iban}</small>${card.isDefault ? '<p>کارت پیش‌فرض</p>' : ''}</div>`).join('')
      : emptyState('💳', 'کارتی ثبت نشده', 'برای برداشت جایزه، کارت بانکی اضافه کن.');
  }
  if (tab === 'security') {
    return `<div class="list-card"><b>سطح احراز</b><p>تأیید اولیه فعال است.</p></div><div class="list-card"><b>محدودیت‌ها</b><p>حداقل برداشت ۵۰٬۰۰۰ تومان</p></div>`;
  }
  return `<div class="list-card"><b>گزارش سریع</b><p>کیف پول آماده اتصال به API واقعی است. داده‌ها از لایه قرارداد API خوانده می‌شوند.</p></div>`;
}

function statusText(status: string): string {
  return status === 'pending' ? 'در انتظار' : status === 'paid' ? 'واریز شد' : 'موفق';
}

function tabButton(id: string, label: string, active: string): string { return `<button class="${id === active ? 'active' : ''}" data-wallet-tab="${id}">${label}</button>`; }
function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
