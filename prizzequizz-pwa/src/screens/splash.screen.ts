import type { AppState } from '../types/app';

export function renderSplash(_state: AppState): string {
  return `<section class="screen center splash">
    <div class="brand-logo">Prize<span>Quiz</span></div>
    <p>در حال آماده‌سازی مسابقه...</p>
  </section>`;
}
