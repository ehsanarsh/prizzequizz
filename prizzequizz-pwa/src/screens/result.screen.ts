import type { AppState } from '../types/app';
import { topbar } from '../components/layout';

export function renderResult(state: AppState): string {
  const d = state.match.duel;
  const won = d.myScore >= d.opponentScore;
  const free = state.user.plan === 'free';
  const coins = won ? d.stage * 45 + 80 : 0;
  return `<section class="screen result pad">
    ${topbar('نتیجه مسابقه', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="result-panel premium-result">
      <div class="duel-summary">
        <div><div class="avatar">🦁</div><b>تو</b><em>${toFa(d.myScore)}</em></div>
        <strong>${won ? 'پیروزی' : 'پایان دوئل'}<span>${toFa(d.myScore)} - ${toFa(d.opponentScore)}</span><small>تو - حریف</small></strong>
        <div><div class="avatar" data-action="opponent-profile">${d.opponent.avatar}</div><b>${d.opponent.name}</b><em>${toFa(d.opponentScore)}</em></div>
      </div>
      <div class="result-kpis">
        <div><b>${toFa(d.myScore)}</b><span>درست</span></div>
        <div><b>${toFa(d.myResults.filter((x) => x === 'no').length)}</b><span>اشتباه</span></div>
        <div><b>${toFa(d.stage * 80)}</b><span>XP</span></div>
      </div>
      <div class="reward-strip">${free ? `+${toFa(coins)} 🪙` : 'جایزه نقدی'}</div>
      <div class="social-actions"><button data-action="friend-request">➕ دوستی</button><button data-action="opponent-profile">👤 پروفایل</button><button>🚩 گزارش</button><button>🚫 بلاک</button></div>
      <div class="result-actions"><button class="primary" data-go="home">${free ? 'دریافت سکه و خروج' : 'برداشت و خروج'}</button><button class="ghost" data-action="rematch">ادامه بازی</button></div>
    </div>
  </section>`;
}

function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
