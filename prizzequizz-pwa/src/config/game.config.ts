import type { GameModeId } from '../types/app';

export const gameConfig: Record<GameModeId, any> = {
  duel: {
    id: 'duel',
    title: 'دوئل ۱به‌۱',
    icon: '⚡',
    questionCount: 5,
    timerSeconds: 10,
    entry: { free: { hearts: 1, coins: 25 }, paid: { cash: 30000 } },
    reward: { free: { type: 'coins', base: 80, perStage: 45 }, paid: { type: 'cash', multiplier: 2 } }
  },
  lastSurvivor: {
    id: 'lastSurvivor',
    title: 'آخرین بازمانده',
    icon: '🏆',
    questionCount: 12,
    timerSeconds: 15,
    entry: { free: { hearts: 1, coins: 30 }, paid: { cash: 60000 } },
    reward: { free: { type: 'coins', base: 50, perQuestion: 30 }, paid: { type: 'cash', pool: true } }
  },
  allOrNothing: {
    id: 'allOrNothing',
    title: 'همه یا هیچ',
    icon: '🤝',
    timerSeconds: 15,
    chatSeconds: 60,
    entry: { free: { hearts: 1, coins: 30 }, paid: { cash: 60000 } },
    reward: { free: { type: 'coins', base: 50, perQuestion: 30 }, paid: { type: 'cash', pool: true } }
  },
  weeklyLeague: {
    id: 'weeklyLeague',
    title: 'لیگ هفتگی',
    icon: '🎯',
    entry: { ticket: 1 },
    reward: { free: { type: 'league' }, paid: { type: 'league' } }
  }
};

export const economyConfig = {
  heartRechargeMinutes: 60,
  maxFreeHearts: 5,
  defaultCoins: 350
};

export const weeklyLeagueTargets = {
  bronze: 500,
  silver: 1500,
  gold: 3000
};
