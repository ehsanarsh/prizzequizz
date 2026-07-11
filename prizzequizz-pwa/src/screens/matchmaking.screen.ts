import type { AppState } from '../types/app';
import { topbar } from '../components/layout';

export function renderMatchmaking(state: AppState): string {
  const free = state.user.plan === 'free';
  const mm = state.match.matchmaking;
  const quality = mm?.quality ? qualityLabel(mm.quality) : 'در حال جستجو';
  const wait = mm?.waitMs ? `${Math.round(mm.waitMs / 1000).toLocaleString('fa-IR')}ث` : '۰ث';
  return `<section class="screen matchmaking pad">
    ${topbar('جستجوی حریف', '<button class="iconbtn" data-go="home">→</button>')}
    <div class="matchmaking-body">
      <div class="match-chip">${free ? 'تمرینی · قلب و سکه' : 'جایزه واقعی · کیف پول'}</div>
      <div class="radar-pro" aria-label="opponent search radar">
        <div class="radar-sweep"></div>
        <div class="radar-grid"></div>
        <div class="radar-ring r1"></div>
        <div class="radar-ring r2"></div>
        <div class="radar-ring r3"></div>
        <div class="radar-orbit o1"><i></i></div>
        <div class="radar-orbit o2"><i></i></div>
        <div class="radar-center">🦁</div>
      </div>
      <div class="search-status">
        <b>${mm?.status === 'matched' ? 'حریف پیدا شد ✅' : 'در حال اسکن بازیکن‌های هم‌سطح'}<span class="dots"><i></i><i></i><i></i></span></b>
        <span>${mm?.opponentIsBot ? 'برای کاهش انتظار، حریف تمرینی هوشمند آماده شد.' : 'اتصال پایدار، سطح مهارت و سرعت پاسخ بررسی می‌شود.'}</span>
      </div>
      <div class="search-kpis">
        <div><b>${wait}</b><span>زمان انتظار</span></div>
        <div><b>${quality}</b><span>کیفیت تطبیق</span></div>
      </div>
    </div>
    <button class="ghost" data-go="home">لغو جستجو</button>
  </section>`;
}

function qualityLabel(q: string): string {
  if (q === 'excellent') return 'عالی';
  if (q === 'good') return 'خوب';
  if (q === 'wide') return 'گسترده';
  if (q === 'bot') return 'بات';
  return '—';
}
