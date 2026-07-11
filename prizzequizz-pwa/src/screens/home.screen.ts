import type { AppState } from '../types/app';
import { bottomNav, topbar } from '../components/layout';
import { gameConfig, weeklyLeagueTargets } from '../config/game.config';
import { levelProgress, nextHeartLabel } from '../features/practice/practiceEconomy';
import { getDailyState, getTodayReward } from '../features/daily/dailyRewards';

export function renderHome(state: AppState): string {
  const free = state.user.plan === 'free';
  const score = state.user.weeklyScore;
  const pct = Math.min(100, Math.round((score / weeklyLeagueTargets.gold) * 100));
  const lvl = levelProgress(state.user.xp);
  const daily = getDailyState();
  const todayReward = getTodayReward();
  return `<section class="screen home">
    ${topbar('PrizzeQuizz', '<button class="iconbtn" data-action="menu">☰</button>', '<button class="iconbtn has-dot" data-action="spin">🎡</button>')}
    <div class="header-pills">
      ${free ? `<span>❤️ ${toFa(state.economy.hearts)} <small>${nextHeartLabel()}</small></span><span data-coins>🪙 ${toFa(state.economy.coins)}</span>` : `<span>💰 ${toFa(state.economy.wallet)}</span>`}
      <span data-xp>Lv ${toFa(lvl.level)} · XP ${toFa(state.user.xp)}</span>
      <span>🎫 ${toFa(state.economy.tickets.bronze)}</span>
    </div>
    <div class="xp-mini"><i style="width:${lvl.pct}%"></i></div>
    <div class="weekly-line">
      <div class="line"><i style="width:${pct}%"></i><b style="left:${pct}%">● ${toFa(score)}</b></div>
      <div class="flags"><span>🏁 Bronze<br>۵۰۰</span><span>🏁 Silver<br>۱۵۰۰</span><span>🏁 Gold<br>۳۰۰۰</span></div>
    </div>
    <main class="pad">
      <div class="hero-card">
        <b>${state.user.username}</b>
        <p>${free ? 'حالت تمرینی فعال است: قلب + سکه' : 'حالت جایزه فعال است: کیف پول + جایزه واقعی'}</p>
        <div class="daily-widget ${daily.claimedToday ? '' : 'ready'}" data-action="daily">
          <span>${todayReward.icon}</span>
          <b>${daily.claimedToday ? 'جایزه امروز دریافت شد' : 'جایزه روزانه آماده است'}</b>
          <small>روز ${toFa(daily.day)} · ${todayReward.label}</small>
          <em>${daily.claimedToday ? 'فردا' : 'دریافت'}</em>
        </div>
      </div>
      <div class="mode-list">
        ${Object.values(gameConfig).filter((m) => m.id !== 'practice').map((mode) => `<button class="mode-card" data-mode="${mode.id}"><span>${mode.icon}</span><b>${mode.title}</b><small>${free ? 'ورودی تمرینی' : 'ورودی پولی'}</small></button>`).join('')}
      </div>
    </main>
    ${bottomNav()}
  </section>`;
}

function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
