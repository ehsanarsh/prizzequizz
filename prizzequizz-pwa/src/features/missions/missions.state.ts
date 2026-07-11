import { store } from '../../core/stateStore';
import { eventBus } from '../../core/eventBus';

export interface Mission {
  id: string;
  title: string;
  progress: number;
  goal: number;
  rewardCoins: number;
  claimed: boolean;
}

const KEY = 'prizzequizz-missions-v1';

let missions: Mission[] = load() ?? [
  { id: 'correct3', title: '۳ پاسخ درست بده', progress: 2, goal: 3, rewardCoins: 100, claimed: false },
  { id: 'duel1', title: 'یک دوئل بازی کن', progress: 0, goal: 1, rewardCoins: 150, claimed: false },
  { id: 'visitWallet', title: 'کیف پول را بررسی کن', progress: 0, goal: 1, rewardCoins: 50, claimed: false }
];

export function getMissions(): Mission[] {
  return missions;
}

export function claimMission(id: string): boolean {
  const mission = missions.find((item) => item.id === id);
  if (!mission || mission.claimed || mission.progress < mission.goal) return false;
  mission.claimed = true;
  save();
  store.set((draft) => { draft.economy.coins += mission.rewardCoins; });
  eventBus.emit('COINS_GAINED', { amount: mission.rewardCoins });
  return true;
}

export function progressMission(id: string, amount = 1): void {
  const mission = missions.find((item) => item.id === id);
  if (!mission || mission.claimed) return;
  mission.progress = Math.min(mission.goal, mission.progress + amount);
  save();
}

function load(): Mission[] | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(missions)); } catch {}
}
