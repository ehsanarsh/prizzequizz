import type { AppState } from '../types/app';
import { gameConfig } from '../config/game.config';
import { topbar } from '../components/layout';

export function renderModeEntry(state: AppState): string {
  const mode = state.match.mode ?? 'duel';
  const config = gameConfig[mode];
  const free = state.user.plan === 'free';
  const stake = state.economy.coinStake ?? config.entry?.free?.coins ?? 25;
  const coinOptions = [10, 25, 50];
  return `<section class="screen pad mode-entry">
    ${topbar(config.title, '<button class="iconbtn" data-go="home">→</button>')}
    <div class="mode-hero"><span>${config.icon}</span><h2>${config.title}</h2></div>
    <div class="entry-card">
      ${free ? `<b>ورودی تمرینی</b><p>۱ قلب + ${toFa(stake)} سکه</p><div class="stake-grid">${coinOptions.map((c) => `<button class="${c === stake ? 'active' : ''}" data-coin-stake="${c}">${toFa(c)} 🪙</button>`).join('')}</div>` : `<b>ورودی پولی</b><p>${toFa(config.entry?.paid?.cash ?? 0)} تومان</p>`}
    </div>
    <button class="primary" data-action="start-mode">شروع بازی</button>
  </section>`;
}

function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
