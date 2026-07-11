import type { AppState } from '../types/app';

export function renderLogin(state: AppState): string {
  const loading = state.ui.loading['auth.login'];
  const error = state.ui.errors['auth.login'];
  return `<section class="screen login pad center">
    <div class="login-card">
      <div class="login-logo">Prize<span>Quiz</span></div>
      <p>ورود سریع با شماره موبایل. در حالت Mock کد به صورت خودکار پذیرفته می‌شود.</p>
      <input class="input" id="loginPhone" inputmode="tel" dir="ltr" placeholder="09xxxxxxxxx" value="09120000000" />
      ${error ? `<div class="inline-error">${error}</div>` : ''}
      <button class="primary" data-action="login" ${loading ? 'disabled' : ''}>${loading ? 'در حال ورود...' : 'ورود / دریافت کد'}</button>
      <button class="ghost" data-go="home">مشاهده نسخه Mock</button>
    </div>
  </section>`;
}
