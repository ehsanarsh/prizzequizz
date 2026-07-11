import { showBottomSheet, hideBottomSheet } from '../../components/bottomSheet';
import { store } from '../../core/stateStore';
import { eventBus } from '../../core/eventBus';

const prizes = [
  { icon: '🪙', label: '100 سکه', type: 'coins', amount: 100 },
  { icon: '❤️', label: '1 قلب', type: 'hearts', amount: 1 },
  { icon: 'XP', label: '150 XP', type: 'xp', amount: 150 },
  { icon: '🎫', label: 'بلیت', type: 'ticket', amount: 1 },
  { icon: '🪙', label: '250 سکه', type: 'coins', amount: 250 },
  { icon: '⏱️', label: 'بوستر زمان', type: 'item', amount: 1 },
  { icon: '✂️', label: 'حذف گزینه', type: 'item', amount: 1 },
  { icon: '🎁', label: 'جعبه', type: 'coins', amount: 400 }
] as const;

let spinning = false;
let rotation = 0;

export function openLuckyWheel(): void {
  showBottomSheet(`
    <div class="wheel-sheet">
      <h2>گردونه شانس روزانه</h2>
      <p>یک جایزه سبک و سریع بگیر.</p>
      <div class="wheel" id="luckyWheel">${prizes.map((p, i) => `<span style="--a:${i * 45 + 22.5}deg"><b>${p.icon}</b><small>${p.label}</small></span>`).join('')}</div>
      <button class="primary" id="spinWheelButton">بچرخون</button>
    </div>
  `);

  document.getElementById('spinWheelButton')?.addEventListener('click', spinWheel);
}

function spinWheel(): void {
  if (spinning) return;
  spinning = true;
  const wheel = document.getElementById('luckyWheel') as HTMLElement | null;
  const button = document.getElementById('spinWheelButton') as HTMLButtonElement | null;
  const index = Math.floor(Math.random() * prizes.length);
  const prize = prizes[index];
  rotation += 360 * 6 + (360 - index * 45 - 22.5);
  if (button) button.disabled = true;
  if (wheel) wheel.style.transform = `rotate(${rotation}deg)`;

  window.setTimeout(() => {
    settlePrize(prize);
    spinning = false;
    hideBottomSheet();
  }, 4200);
}

function settlePrize(prize: typeof prizes[number]): void {
  store.set((draft) => {
    if (prize.type === 'coins') draft.economy.coins += prize.amount;
    if (prize.type === 'hearts') draft.economy.hearts += prize.amount;
    if (prize.type === 'xp') draft.user.xp += prize.amount;
    if (prize.type === 'ticket') draft.economy.tickets.bronze += prize.amount;
  });
  eventBus.emit('REWARD_GRANTED', prize);
  if (prize.type === 'coins') eventBus.emit('COINS_GAINED', { amount: prize.amount });
  if (prize.type === 'xp') eventBus.emit('XP_GAINED', { amount: prize.amount });
}
