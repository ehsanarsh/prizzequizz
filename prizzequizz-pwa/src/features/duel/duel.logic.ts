import { api } from '../../api';
import { createIdempotencyKey } from '../../utils/idempotency';
import { runTask } from '../../core/asyncTask';
import { store } from '../../core/stateStore';
import { go } from '../../core/router';
import { eventBus } from '../../core/eventBus';
import { addPracticeCoins, addXP } from '../practice/practiceEconomy';

let timerId = 0;
let matchId: string | null = null;

const opponents = [
  { id: 'op1', name: 'رضا', avatar: '🦊' },
  { id: 'op2', name: 'نگار', avatar: '🐼' },
  { id: 'op3', name: 'امیر', avatar: '🐯' },
  { id: 'op4', name: 'سارا', avatar: '🐰' }
];

export async function startDuelSearch(): Promise<void> {
  window.clearTimeout(timerId);
  store.set((draft) => {
    draft.match.mode = 'duel';
    draft.match.phase = 'matchmaking';
  });
  go('matchmaking');
  eventBus.emit('MATCHMAKING_STARTED');

  const ticket = await runTask('duel.matchmaking', async () => {
    const state = store.get();
    return api.matchmaking.enqueue({
      modeId: 'duel',
      economyType: state.user.plan,
      entry: { coinStake: state.economy.coinStake },
      skill: state.user.weeklyScore || state.user.xp || 1000
    });
  });

  if (!ticket) return;
  store.set((draft)=>{draft.match.matchmaking={ticketId:ticket.id,status:ticket.status,quality:ticket.matchQuality,opponentIsBot:ticket.opponentIsBot,waitMs:ticket.waitMs};});

  async function resolveTicket(nextTicketId: string, elapsed = 0): Promise<void> {
    const latest = await api.matchmaking.get(nextTicketId);
    store.set((draft)=>{draft.match.matchmaking={ticketId:latest.id,status:latest.status,quality:latest.matchQuality,opponentIsBot:latest.opponentIsBot,waitMs:latest.waitMs};});
    if (latest.status === 'matched' && latest.matchId) {
      matchId = latest.matchId;
      eventBus.emit('DUEL_MATCH_CREATED', { matchId });
      eventBus.emit('OPPONENT_FOUND', latest);
      await api.matches.start(matchId);
      await startDuel();
      return;
    }
    if (elapsed >= 2200) {
      const bot = await api.matchmaking.bot(nextTicketId);
      store.set((draft)=>{draft.match.matchmaking={ticketId:bot.id,status:bot.status,quality:bot.matchQuality,opponentIsBot:bot.opponentIsBot,waitMs:bot.waitMs};});
      if (bot.status === 'matched' && bot.matchId) {
        matchId = bot.matchId;
        eventBus.emit('DUEL_MATCH_CREATED', { matchId });
        eventBus.emit('OPPONENT_FOUND', bot);
        await api.matches.start(matchId);
        await startDuel();
      }
      return;
    }
    timerId = window.setTimeout(() => void resolveTicket(nextTicketId, elapsed + 700), 700);
  }

  await resolveTicket(ticket.id);
}

export async function startDuel(): Promise<void> {
  clearDuelTimer();
  store.set((draft) => {
    draft.match.mode = 'duel';
    draft.match.phase = 'question';
    draft.match.duel.stage = 1;
    draft.match.duel.round = 0;
    draft.match.duel.myScore = 0;
    draft.match.duel.opponentScore = 0;
    draft.match.duel.myResults = [];
    draft.match.duel.opponentResults = [];
    draft.match.duel.hiddenOptions = [];
    draft.match.duel.statsVisible = false;
    draft.match.duel.timerLeft = 10;
    draft.match.duel.powerups = { fifty: 2, time: 1, stats: 3 };
  });
  go('duel');
  await loadQuestion();
}

export async function loadQuestion(): Promise<void> {
  clearDuelTimer();
  const q = await runTask('duel.loadQuestion', async () => api.questions.next(matchId ?? undefined));
  if (!q) return;
  store.set((draft) => {
    draft.match.phase = 'question';
    draft.match.duel.currentQuestion = q;
    draft.match.duel.selectedIndex = undefined;
    draft.match.duel.correctIndex = undefined;
    draft.match.duel.hiddenOptions = [];
    draft.match.duel.statsVisible = false;
    draft.match.duel.timerLeft = 10;
  });
  eventBus.emit('QUESTION_LOADED', q);
  startDuelTimer();
}

function startDuelTimer(): void {
  clearDuelTimer();
  timerId = window.setInterval(() => {
    const state = store.get();
    if (state.ui.currentScreen !== 'duel' || state.match.phase !== 'question') {
      clearDuelTimer();
      return;
    }
    const left = state.match.duel.timerLeft - 1;
    store.set((draft) => {
      draft.match.duel.timerLeft = Math.max(0, left);
    });
    if (left <= 0) {
      clearDuelTimer();
      void answerDuel(-1);
    }
  }, 1000);
}

function clearDuelTimer(): void {
  window.clearInterval(timerId);
}

export async function answerDuel(selectedIndex: number): Promise<void> {
  const state = store.get();
  const question = state.match.duel.currentQuestion;
  if (!question || state.match.phase !== 'question') return;
  clearDuelTimer();

  const res = selectedIndex >= 0
    ? await runTask('duel.submitAnswer', async () => api.questions.submitAnswer({
        matchId: matchId ?? 'local_match',
        questionId: question.id,
        selectedIndex,
        answerTimeMs: Math.max(0, (10 - state.match.duel.timerLeft) * 1000),
        idempotencyKey: createIdempotencyKey('answer', [matchId, question.id, selectedIndex])
      }))
    : { correct: false, correctIndex: question.correctIndex, selectedIndex, score: 0, phase: 'revealing' as const, events: [] };

  if (!res) {
    startDuelTimer();
    return;
  }

  const opponentCorrect = Math.random() < 0.58;

  store.set((draft) => {
    draft.match.phase = 'revealing';
    draft.match.duel.selectedIndex = selectedIndex;
    draft.match.duel.correctIndex = res.correctIndex;
    if (res.correct) draft.match.duel.myScore += 1;
    if (opponentCorrect) draft.match.duel.opponentScore += 1;
    draft.match.duel.myResults.push(res.correct ? 'ok' : 'no');
    draft.match.duel.opponentResults.push(opponentCorrect ? 'ok' : 'no');
  });

  if (res.correct) addXP(10);
  eventBus.emit('ANSWER_RESOLVED', { selectedIndex, correctIndex: res.correctIndex, correct: res.correct });

  window.setTimeout(() => {
    const d = store.get().match.duel;
    if (d.myResults.length >= 5) finishDuel();
    else void loadQuestion();
  }, 950);
}

export function useDuelPowerup(type: 'fifty' | 'time' | 'stats'): void {
  const state = store.get();
  const q = state.match.duel.currentQuestion;
  if (!q || state.match.phase !== 'question') return;

  store.set((draft) => {
    const duel = draft.match.duel;
    if (type === 'fifty' && duel.powerups.fifty > 0) {
      const wrong = q.options.map((_, i) => i).filter((i) => i !== q.correctIndex).slice(0, 2);
      duel.hiddenOptions = wrong;
      duel.powerups.fifty -= 1;
      eventBus.emit('POWERUP_USED', { type });
    }
    if (type === 'time' && duel.powerups.time > 0) {
      duel.timerLeft += 5;
      duel.powerups.time -= 1;
      eventBus.emit('POWERUP_USED', { type });
    }
    if (type === 'stats' && duel.powerups.stats > 0) {
      duel.statsVisible = true;
      duel.powerups.stats -= 1;
      eventBus.emit('POWERUP_USED', { type });
    }
  });
}

export function finishDuel(): void {
  clearDuelTimer();
  const d = store.get().match.duel;
  const won = d.myScore >= d.opponentScore;
  const coins = won ? d.stage * 45 + 80 : 0;
  if (coins) addPracticeCoins(coins);
  if (won) addXP(50);
  store.set((draft) => {
    draft.match.phase = 'result';
  });
  eventBus.emit('DUEL_FINISHED', { won, coins });
  go('result');
}
