import type { AppState } from '../types/app';
import type { LeaderboardEntryDto, LeaderboardKind } from '../api/contracts';
import { bottomNav, topbar } from '../components/layout';
import { emptyState, errorState, skeletonList } from '../components/statusViews';
import { getLeaderboard, getLeaderboardKind } from '../features/leaderboards/leaderboard.state';

const labels: Record<LeaderboardKind, { title: string; desc: string; unit: string; icon: string }> = {
  weekly: { title: 'هفتگی', desc: 'معیار: امتیاز هفتگی و XP هفته', unit: 'امتیاز', icon: '🏆' },
  overall: { title: 'کلی', desc: 'معیار: XP کل بازیکن', unit: 'XP', icon: '⭐' },
  winnings: { title: 'بردها', desc: 'معیار: مجموع بردهای نقدی/سکه‌ای', unit: 'برد', icon: '💰' }
};

export function renderRankings(state: AppState): string {
  const kind = getLeaderboardKind();
  const board = getLeaderboard(kind);
  const loading = state.ui.loading[`leaderboard.${kind}`];
  const err = state.ui.errors[`leaderboard.${kind}`];
  const meta = labels[kind];
  return `<section class="screen rankings pad">
    ${topbar('رنکینگ', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="tabs small-tabs leaderboard-tabs">
      ${tab('weekly', 'هفتگی', kind)}${tab('overall', 'کلی XP', kind)}${tab('winnings', 'بردها', kind)}
    </div>
    <div class="list-card leaderboard-head"><b>${meta.icon} ${meta.title}</b><p>${meta.desc}</p><small>${board ? `به‌روزرسانی: ${new Date(board.generatedAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}` : 'در حال دریافت داده زنده...'}</small></div>
    <div class="rank-list">${loading && !board ? skeletonList(5) : err && !board ? errorState(err, 'retry-leaderboard') : renderRows(board?.entries ?? [], meta.unit)}</div>
    ${bottomNav()}
  </section>`;
}

function renderRows(entries: LeaderboardEntryDto[], unit: string): string {
  if (!entries.length) return emptyState('🏁', 'رتبه‌ای ثبت نشده', 'بعد از اولین مسابقه، رتبه‌بندی اینجا نمایش داده می‌شود.');
  return entries.map((entry) => `<div class="rank-row leaderboard-row ${entry.highlighted ? 'me' : ''}"><span>${medal(entry.rank)}</span><em>${entry.avatar}</em><b>${escapeHtml(entry.username)}<small>Lv ${toFa(entry.level)} · #${toFa(entry.rank)}</small></b><strong>${toFa(entry.score)}<small>${unit}</small></strong></div>`).join('');
}

function tab(id: LeaderboardKind, label: string, active: LeaderboardKind): string {
  return `<button class="${id === active ? 'active' : ''}" data-leaderboard-kind="${id}">${label}</button>`;
}

function medal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return toFa(rank);
}

function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
function escapeHtml(value: string): string { return value.replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!)); }
