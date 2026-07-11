import type { AppState } from '../types/app';
import type { CharacterItemDto, CharacterSlot } from '../api/contracts';
import { bottomNav, topbar } from '../components/layout';
import { emptyState, errorState, skeletonList } from '../components/statusViews';
import { getActiveCharacterSlot, getCharacterCatalog, getCharacterInventory } from '../features/characters/character.state';

const slotLabels: Record<CharacterSlot, string> = { head: 'سر', body: 'لباس', shoes: 'کفش' };
const rarityLabels: Record<string, string> = { common: 'معمولی', rare: 'کمیاب', epic: 'حماسی', legendary: 'افسانه‌ای' };

export function renderCharacter(state: AppState): string {
  const loading = state.ui.loading['character.hydrate'];
  const error = state.ui.errors['character.hydrate'];
  const catalog = getCharacterCatalog();
  const inventory = getCharacterInventory();
  return `<section class="screen character pad">
    ${topbar('کاراکتر من', '<button class="iconbtn" data-go="home">→</button>', '<button class="iconbtn" data-action="character-random">🎲</button>')}
    ${loading && (!catalog || !inventory) ? skeletonList(4) : error && (!catalog || !inventory) ? errorState(error, 'retry-character') : catalog && inventory ? renderCharacterContent(catalog, inventory, state) : emptyState('🧬','کاراکتری نیست','کاتالوگ کاراکتر بعد از اتصال API نمایش داده می‌شود.')}
    ${bottomNav()}
  </section>`;
}

function renderCharacterContent(catalog: NonNullable<ReturnType<typeof getCharacterCatalog>>, inventory: NonNullable<ReturnType<typeof getCharacterInventory>>, state: AppState): string {
  const activeSlot = getActiveCharacterSlot();
  const base = catalog.states.find((item) => item.id === inventory.loadout.state) ?? catalog.states[0]!;
  const layer = (slot: CharacterSlot) => catalog.items.find((item) => item.id === inventory.loadout.outfit[slot]);
  const equippedTitle = Object.entries(inventory.loadout.outfit).map(([slot, itemId]) => `${slotLabels[slot as CharacterSlot]}: ${catalog.items.find((i) => i.id === itemId)?.title ?? '-'}`).join(' · ');
  const slotItems = catalog.items.filter((item) => item.slot === activeSlot);
  return `<div class="character-hero">
      <div class="character-stage" data-mood="${inventory.loadout.state}">
        <img class="character-layer base" src="${base.src}" alt="${escapeHtml(base.title)}"/>
        ${(['body','shoes','head'] as CharacterSlot[]).map((slot) => { const item = layer(slot); return item ? `<img class="character-layer ${slot}" src="${item.src}" alt="${escapeHtml(item.title)}"/>` : ''; }).join('')}
      </div>
      <div class="character-meta"><b>${escapeHtml(state.user.displayName || state.user.username)}</b><p>${equippedTitle}</p><small>Lv ${fa(state.user.level)} · 🪙 ${fa(state.economy.coins)}</small></div>
    </div>
    <div class="list-card"><b>حالت کاراکتر</b><div class="character-state-grid">${catalog.states.map((mood) => `<button class="${mood.id === inventory.loadout.state ? 'active' : ''}" data-character-state="${mood.id}">${moodIcon(mood.id)}<span>${mood.title}</span></button>`).join('')}</div></div>
    <div class="tabs small-tabs character-tabs">${catalog.slots.map((slot) => `<button class="${slot === activeSlot ? 'active' : ''}" data-character-slot="${slot}">${slotLabels[slot]}</button>`).join('')}</div>
    <div class="character-shop">${slotItems.map((item) => renderItem(item, inventory.unlockedItemIds.includes(item.id), inventory.loadout.outfit[item.slot] === item.id, state.user.level)).join('')}</div>`;
}

function renderItem(item: CharacterItemDto, unlocked: boolean, equipped: boolean, level: number): string {
  const levelLocked = level < (item.unlockLevel ?? 1);
  const action = equipped ? 'نصب شده' : unlocked ? 'Equip' : levelLocked ? `Lv ${fa(item.unlockLevel ?? 1)}` : `خرید ${fa(item.priceCoins)}`;
  const attr = equipped ? '' : unlocked ? `data-character-equip="${item.id}" data-character-slot-equip="${item.slot}"` : levelLocked ? '' : `data-character-buy="${item.id}"`;
  return `<div class="character-item ${item.rarity} ${equipped ? 'equipped' : ''}"><div class="item-preview"><img src="${item.src}" alt="${escapeHtml(item.title)}"/></div><div><b>${escapeHtml(item.title)}</b><small>${rarityLabels[item.rarity]} · ${item.tags.join('، ')}</small></div><button class="${equipped ? 'ghost' : unlocked ? 'primary' : 'ghost'}" ${attr} ${levelLocked || equipped ? 'disabled' : ''}>${action}</button></div>`;
}

function moodIcon(id: string): string { return ({ idle:'🙂', happy:'😄', sad:'😔', win:'🏆', lose:'💥' } as Record<string,string>)[id] ?? '✨'; }
function fa(n: number): string { return Number(n).toLocaleString('fa-IR'); }
function escapeHtml(value: string): string { return value.replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]!)); }
