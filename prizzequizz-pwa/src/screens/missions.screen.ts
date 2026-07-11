import type { AppState } from '../types/app';
import { bottomNav, topbar } from '../components/layout';
import { getMissions } from '../features/missions/missions.state';

export function renderMissions(_state: AppState): string {
  return `<section class="screen missions pad">
    ${topbar('ماموریت‌ها', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="mission-list">
      ${getMissions().map((m) => `<div class="mission-card">
        <b>${m.title}</b>
        <div class="mission-track"><i style="width:${Math.round((m.progress / m.goal) * 100)}%"></i></div>
        <small>${toFa(m.progress)} از ${toFa(m.goal)} · جایزه ${toFa(m.rewardCoins)} سکه</small>
        <button class="${m.progress >= m.goal && !m.claimed ? 'primary' : 'ghost'}" data-claim="${m.id}" ${m.progress < m.goal || m.claimed ? 'disabled' : ''}>${m.claimed ? 'دریافت شد' : 'دریافت جایزه'}</button>
      </div>`).join('')}
    </div>
    ${bottomNav()}
  </section>`;
}

function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
