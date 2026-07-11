import type { AppState } from '../types/app';
import { eventBus } from './eventBus';

const STORAGE_KEY = 'prizzequizz-pwa-state-v1';

const initialState: AppState = {
  user: { id: 'u1', username: 'Shahab_9865', displayName: 'شهاب', level: 3, xp: 3400, weeklyScore: 820, plan: 'paid' },
  economy: { wallet: 900000, coins: 350, hearts: 3, heartLastAt: Date.now(), coinStake: 25, tickets: { bronze: 1, silver: 0, gold: 0 } },
  match: {
    phase: 'idle',
    matchmaking: {},
    duel: { stage: 1, round: 0, myScore: 0, opponentScore: 0, myResults: [], opponentResults: [], opponent: { id: 'op1', name: 'رضا', avatar: '🦊' }, hiddenOptions: [], statsVisible: false, timerLeft: 10, powerups: { fifty: 2, time: 1, stats: 3 } }
  },
  ui: { currentScreen: 'splash', theme: 'paid', loading: {}, errors: {}, realtime: { connected: false, reconnecting: false, presence: [], duelChat: [] } }
};

export class StateStore {
  private state: AppState;
  private listeners = new Set<(state: AppState) => void>();

  constructor() {
    this.state = this.load() ?? initialState;
    this.state.economy.heartLastAt ??= Date.now();
    this.state.economy.coinStake ??= 25;
    this.state.ui.loading ??= {};
    this.state.ui.errors ??= {};
    this.state.ui.realtime ??= { connected: false, reconnecting: false, presence: [], duelChat: [] };
  }

  get(): AppState {
    return this.state;
  }

  set(mutator: (state: AppState) => AppState | void): void {
    const next = structuredClone(this.state);
    const returned = mutator(next);
    this.state = returned ?? next;
    this.save();
    this.listeners.forEach((listener) => listener(this.state));
    eventBus.emit('STATE_CHANGED', this.state);
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private load(): AppState | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {}
  }
}

export const store = new StateStore();
