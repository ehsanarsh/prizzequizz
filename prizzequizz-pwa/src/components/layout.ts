import type { AppState } from '../types/app';

export function shell(content: string, state: AppState): string {
  const theme = state.user.plan === 'free' ? 'free' : 'paid';
  return `<div class="phone" data-theme="${theme}">
    <div class="viewport">${content}</div>
  </div>`;
}

export function topbar(title: string, left = '', right = ''): string {
  return `<div class="topbar">${left}<h1>${title}</h1>${right}</div>`;
}

export function bottomNav(): string {
  return `<nav class="bottomnav">
    <button data-go="home">خانه</button>
    <button data-go="wallet">کیف پول</button>
    <button data-go="missions">ماموریت</button>
    <button data-go="friends">دوستان</button>
    <button data-go="character">کاراکتر</button>
  </nav>`;
}
