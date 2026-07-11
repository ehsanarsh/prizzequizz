import { eventBus } from '../core/eventBus';
import { store } from '../core/stateStore';

let installed = false;

export function installRewardAnimations(root: HTMLElement): void {
  if (installed) return;
  installed = true;

  eventBus.on<{ amount: number }>('COINS_GAINED', ({ amount }) => {
    const target = root.querySelector('[data-coins]') as HTMLElement | null;
    if (!target) return;
    const bubble = document.createElement('div');
    bubble.className = 'float-reward coin-reward';
    bubble.textContent = `+${toFa(amount)} 🪙`;
    root.appendChild(bubble);
    window.setTimeout(() => bubble.remove(), 900);
    target.classList.add('pulse');
    window.setTimeout(() => target.classList.remove('pulse'), 500);
  });

  eventBus.on<{ amount: number }>('XP_GAINED', ({ amount }) => {
    const xp = root.querySelector('[data-xp]') as HTMLElement | null;
    if (!xp) return;
    const bubble = document.createElement('div');
    bubble.className = 'float-reward xp-reward';
    bubble.textContent = `+${toFa(amount)} XP`;
    root.appendChild(bubble);
    window.setTimeout(() => bubble.remove(), 800);
    xp.classList.add('pulse');
    window.setTimeout(() => xp.classList.remove('pulse'), 500);
  });

  store.subscribe((state) => {
    const coins = root.querySelector('[data-coins]');
    if (coins) coins.textContent = `🪙 ${toFa(state.economy.coins)}`;
    const xp = root.querySelector('[data-xp]');
    if (xp) xp.textContent = `Lv ${toFa(state.user.level)} · XP ${toFa(state.user.xp)}`;
  });
}

function toFa(n: number): string {
  return Number(n).toLocaleString('fa-IR');
}
