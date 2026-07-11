import { store } from '../../core/stateStore';
import { eventBus } from '../../core/eventBus';
import { addHearts, addPracticeCoins, addXP } from '../practice/practiceEconomy';

export type DailyRewardType = 'coins' | 'xp' | 'hearts' | 'ticket' | 'spin' | 'item';

export interface DailyReward {
  day: number;
  icon: string;
  label: string;
  type: DailyRewardType;
  amount: number;
}

export const dailyRewards: DailyReward[] = [
  { day: 1, icon: '🪙', label: '۱۰۰ سکه', type: 'coins', amount: 100 },
  { day: 2, icon: 'XP', label: '۱۵۰ XP', type: 'xp', amount: 150 },
  { day: 3, icon: '❤️', label: '۱ قلب', type: 'hearts', amount: 1 },
  { day: 4, icon: '🎫', label: '۱ بلیت', type: 'ticket', amount: 1 },
  { day: 5, icon: '🪙', label: '۲۵۰ سکه', type: 'coins', amount: 250 },
  { day: 6, icon: '⏱️', label: 'بوستر زمان', type: 'item', amount: 1 },
  { day: 7, icon: '🎡', label: 'چرخش اضافه', type: 'spin', amount: 1 },
  { day: 8, icon: '❤️', label: '۲ قلب', type: 'hearts', amount: 2 },
  { day: 9, icon: '🪙', label: '۴۰۰ سکه', type: 'coins', amount: 400 },
  { day: 10, icon: '🎫', label: '۲ بلیت', type: 'ticket', amount: 2 },
  { day: 11, icon: 'XP', label: '۴۰۰ XP', type: 'xp', amount: 400 },
  { day: 12, icon: '🎁', label: 'جعبه سورپرایز', type: 'item', amount: 1 },
  { day: 13, icon: '🏆', label: 'قاب ویژه', type: 'item', amount: 1 },
  { day: 14, icon: '🪙', label: '۷۰۰ سکه', type: 'coins', amount: 700 },
  { day: 15, icon: '👑', label: 'آواتار ویژه', type: 'item', amount: 1 }
];

const KEY = 'prizzequizz-daily-v1';

export interface DailyState {
  day: number;
  claimedToday: boolean;
  lastClaimAt?: number;
}

let dailyState: DailyState = load() ?? { day: 1, claimedToday: false };

export function getDailyState(): DailyState {
  resetIfNewDay();
  return dailyState;
}

export function getTodayReward(): DailyReward {
  return dailyRewards[Math.min(dailyState.day, 15) - 1];
}

export function claimDailyReward(): DailyReward | null {
  resetIfNewDay();
  if (dailyState.claimedToday) return null;
  const reward = getTodayReward();
  if (reward.type === 'coins') addPracticeCoins(reward.amount);
  if (reward.type === 'xp') addXP(reward.amount);
  if (reward.type === 'hearts') addHearts(reward.amount);
  if (reward.type === 'ticket') {
    store.set((draft) => {
      draft.economy.tickets.bronze += reward.amount;
    });
  }
  dailyState.claimedToday = true;
  dailyState.lastClaimAt = Date.now();
  save();
  eventBus.emit('DAILY_REWARD_CLAIMED', reward);
  return reward;
}

function resetIfNewDay(): void {
  if (!dailyState.lastClaimAt) return;
  const last = new Date(dailyState.lastClaimAt).toDateString();
  const now = new Date().toDateString();
  if (last !== now) {
    dailyState.claimedToday = false;
    dailyState.day = Math.min(15, dailyState.day + 1);
    save();
  }
}

function load(): DailyState | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(dailyState)); } catch {}
}
