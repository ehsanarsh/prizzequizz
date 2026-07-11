import type { AppState, ScreenId } from '../types/app';
import { bottomNav, topbar } from '../components/layout';

const titles: Record<string, string> = {
  wallet: 'کیف پول', missions: 'ماموریت‌ها', friends: 'دوستان', support: 'پشتیبانی', rankings: 'رنکینگ', settings: 'تنظیمات'
};

export function renderPlaceholder(id: ScreenId) {
  return (_state: AppState) => `<section class="screen pad placeholder">
    ${topbar(titles[id] ?? id, '<button class="iconbtn" data-go="home">→</button>')}
    <div class="empty-state"><b>${titles[id] ?? id}</b><p>این صفحه در فاز بعدی از Prototype کامل منتقل می‌شود.</p></div>
    ${bottomNav()}
  </section>`;
}
