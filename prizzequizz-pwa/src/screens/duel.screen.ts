import type { AppState } from '../types/app';
import { topbar } from '../components/layout';
import { timerRing } from '../components/timerRing';
import { answerGrid } from '../components/answerGrid';

export function setDuelQuestion(_question?: AppState['match']['duel']['currentQuestion']): void {
  // Kept for compatibility with the event wiring. The question now lives in AppState.
}

export function renderDuel(state: AppState): string {
  const d = state.match.duel;
  const q = d.currentQuestion ?? null;
  const revealing = state.match.phase === 'revealing';
  return `<section class="screen duel">
    ${topbar('دوئل', '<button class="iconbtn" data-go="home">✕</button>', timerRing('duelTimer', d.timerLeft))}
    ${realtimeStrip(state)}
    ${reconnectOverlay(state)}
    <div class="duel-top">
      <div class="player me"><div class="avatar">🦁</div><b>تو</b><em>${toFa(d.myScore)}</em><div class="slots">${slots(d.myResults)}</div></div>
      <div class="score"><span class="opp">${toFa(d.opponentScore)}</span><i>-</i><span class="me">${toFa(d.myScore)}</span></div>
      <div class="player opp"><div class="avatar" data-action="opponent-profile">${d.opponent.avatar}</div><b>${d.opponent.name}</b><em>${toFa(d.opponentScore)}</em><div class="slots">${slots(d.opponentResults)}</div></div>
    </div>
    <main class="pad">
      <div class="question-card ${revealing ? 'revealing' : ''}"><small>${q?.category ?? 'موضوع'}</small><h2>${q?.text ?? 'در حال دریافت سؤال...'}</h2></div>
      ${powerups(d.powerups)}
      ${renderAnswersWithState(state)}
      ${d.statsVisible ? statsPanel(q?.correctIndex ?? 0) : ''}
      ${duelLiveChat(state)}
    </main>
  </section>`;
}

function realtimeStrip(state: AppState): string {
  const rt = state.ui.realtime;
  const onlineOpponent = rt.presence.some((p) => p.userId !== state.user.id);
  const status = rt.connected ? (onlineOpponent ? 'حریف آنلاین' : 'اتصال زنده') : rt.reconnecting ? 'اتصال مجدد...' : 'آفلاین';
  return `<div class="duel-live-strip ${rt.connected ? 'on' : 'off'}"><span></span><b>${status}</b>${rt.lastRecoveredAt ? '<small>بازیابی شد</small>' : ''}</div>`;
}

function reconnectOverlay(state: AppState): string {
  const rt = state.ui.realtime;
  if (rt.connected && !rt.reconnecting) return '';
  const title = rt.reconnecting ? 'در حال اتصال مجدد...' : 'اتصال زنده قطع است';
  const text = rt.reconnecting ? 'در حال بازیابی وضعیت دوئل هستیم. لطفاً چند لحظه صبر کن.' : 'تا برقراری اتصال، ارسال پاسخ و چت غیرفعال است.';
  return `<div class="duel-reconnect-overlay"><b>${title}</b><span>${text}</span></div>`;
}

function duelLiveChat(state: AppState): string {
  const messages = state.ui.realtime.duelChat.slice(-4);
  return `<div class="duel-live-chat">
    <div class="live-chat-list">${messages.length ? messages.map((m) => `<div class="live-msg ${m.from} ${m.pending ? 'pending' : ''}">${m.text}${m.pending ? '<small>ارسال...</small>' : ''}</div>`).join('') : '<div class="live-msg system">پیام‌های زنده دوئل اینجا نمایش داده می‌شود.</div>'}</div>
    <div class="live-chat-send"><input id="duelLiveChatInput" class="input" placeholder="پیام کوتاه..." ${state.ui.realtime.connected && !state.ui.realtime.reconnecting ? '' : 'disabled'} /><button class="primary" data-action="duel-live-chat" ${state.ui.realtime.connected && !state.ui.realtime.reconnecting ? '' : 'disabled'}>ارسال</button></div>
  </div>`;
}

function renderAnswersWithState(state: AppState): string {
  const d = state.match.duel;
  const q = d.currentQuestion;
  if (!q) return answerGrid(null);
  const revealing = state.match.phase === 'revealing';
  const liveBlocked = !state.ui.realtime.connected || state.ui.realtime.reconnecting;
  return `<div class="answers">${q.options.map((option, index) => {
    const hidden = d.hiddenOptions.includes(index);
    const correct = revealing && index === d.correctIndex;
    const wrong = revealing && index === d.selectedIndex && index !== d.correctIndex;
    const selected = index === d.selectedIndex;
    return `<button data-answer="${index}" ${hidden || revealing || liveBlocked ? 'disabled' : ''} class="${hidden ? 'dim' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''} ${selected ? 'selected' : ''}">${option}</button>`;
  }).join('')}</div>`;
}

function powerups(p: AppState['match']['duel']['powerups']): string {
  return `<div class="powerups-row">
    <button data-power="fifty">✂️ حذف دو گزینه <b>${toFa(p.fifty)}</b></button>
    <button data-power="time">⏱️ زمان اضافه <b>${toFa(p.time)}</b></button>
    <button data-power="stats">📈 آمار کل <b>${toFa(p.stats)}</b></button>
  </div>`;
}

function statsPanel(correctIndex: number): string {
  const values = [18, 24, 31, 27];
  values[correctIndex] += 18;
  const sum = values.reduce((a, b) => a + b, 0);
  return `<div class="stats-panel"><b>آمار انتخاب بازیکنان</b>${values.map((v, i) => `<div><span>${['الف', 'ب', 'ج', 'د'][i]}</span><i style="width:${Math.round((v / sum) * 100)}%"></i><em>${toFa(Math.round((v / sum) * 100))}٪</em></div>`).join('')}</div>`;
}

function slots(values: Array<'ok' | 'no'>): string { return Array.from({ length: 5 }).map((_, i) => `<i class="${values[i] ?? ''}"></i>`).join(''); }
function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
