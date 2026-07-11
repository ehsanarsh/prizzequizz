import { store } from '../../core/stateStore';
import { economyConfig } from '../../config/game.config';
import { eventBus } from '../../core/eventBus';

const HOUR = 60 * 60 * 1000;

export function syncHeartRecharge(): void {
  const state = store.get();
  const last = state.economy.heartLastAt ?? Date.now();
  const max = economyConfig.maxFreeHearts;
  if (state.economy.hearts >= max) {
    store.set((draft) => { draft.economy.heartLastAt = Date.now(); });
    return;
  }
  const earned = Math.floor((Date.now() - last) / HOUR);
  if (earned <= 0) return;
  store.set((draft) => {
    draft.economy.hearts = Math.min(max, draft.economy.hearts + earned);
    draft.economy.heartLastAt = draft.economy.hearts >= max ? Date.now() : last + earned * HOUR;
  });
}

export function nextHeartLabel(): string {
  syncHeartRecharge();
  const state = store.get();
  if (state.economy.hearts >= economyConfig.maxFreeHearts) return 'کامل';
  const last = state.economy.heartLastAt ?? Date.now();
  const left = Math.max(0, HOUR - (Date.now() - last));
  const minutes = Math.ceil(left / 60000);
  return minutes >= 60 ? '۱س' : `${toFa(minutes)}د`;
}

export function setPracticeCoinStake(coins: number): void {
  store.set((draft) => {
    draft.economy.coinStake = coins;
  });
}

export function spendPracticeEntry(coins?: number): boolean {
  syncHeartRecharge();
  const state = store.get();
  const cost = coins ?? state.economy.coinStake ?? 25;
  if (state.economy.hearts <= 0) {
    eventBus.emit('RESOURCE_MISSING', { type: 'hearts', message: 'قلب کافی نداری' });
    return false;
  }
  if (state.economy.coins < cost) {
    eventBus.emit('RESOURCE_MISSING', { type: 'coins', message: 'سکه کافی نیست' });
    return false;
  }
  store.set((draft) => {
    draft.economy.hearts -= 1;
    draft.economy.coins -= cost;
    if (draft.economy.hearts < economyConfig.maxFreeHearts) draft.economy.heartLastAt = Date.now();
  });
  eventBus.emit('HEART_SPENT', { amount: 1 });
  return true;
}

export function spendPaidEntry(cash: number): boolean {
  const state = store.get();
  if (state.economy.wallet < cash) {
    eventBus.emit('RESOURCE_MISSING', { type: 'cash', message: 'موجودی کافی نیست' });
    return false;
  }
  store.set((draft) => {
    draft.economy.wallet -= cash;
  });
  return true;
}

export function addPracticeCoins(amount: number): void {
  store.set((draft) => {
    draft.economy.coins += amount;
  });
  eventBus.emit('COINS_GAINED', { amount });
}

export function addXP(amount: number): void {
  store.set((draft) => {
    draft.user.xp += amount;
    draft.user.weeklyScore += Math.round(amount * 0.8);
    draft.user.level = calculateLevel(draft.user.xp);
  });
  eventBus.emit('XP_GAINED', { amount });
}

export function addHearts(amount: number): void {
  store.set((draft) => {
    draft.economy.hearts += amount;
  });
  eventBus.emit('HEART_GAINED', { amount });
}

export function calculateLevel(xp: number): number {
  const levels = [0, 100, 250, 450, 700, 1050, 1500, 2100, 2800, 3700, 4800, 6200, 7900, 9800, 12200, 15000, 18500, 22500, 27000, 33000];
  let level = 1;
  levels.forEach((required, index) => {
    if (xp >= required) level = index + 1;
  });
  return level;
}

export function levelProgress(xp: number): { level: number; pct: number; next: number } {
  const levels = [0, 100, 250, 450, 700, 1050, 1500, 2100, 2800, 3700, 4800, 6200, 7900, 9800, 12200, 15000, 18500, 22500, 27000, 33000];
  const level = calculateLevel(xp);
  const current = levels[level - 1] ?? 0;
  const next = levels[level] ?? levels[levels.length - 1];
  const pct = next === current ? 100 : Math.min(100, Math.round(((xp - current) / (next - current)) * 100));
  return { level, pct, next };
}

function toFa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
