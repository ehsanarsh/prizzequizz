import { repositories } from '../repositories/index.js';
import type { CharacterInventory, CharacterItem, CharacterItemStatus, CharacterLoadout, CharacterSlot, CharacterStateKey, CharacterRarity } from '../types/domain.js';
import { id } from '../utils/id.js';

export interface CharacterStateConfig { id: CharacterStateKey; title: string; src: string }

const states: CharacterStateConfig[] = [
  { id: 'idle', title: 'آماده', src: '/character-assets/states/idle.png' },
  { id: 'happy', title: 'خوشحال', src: '/character-assets/states/happy.png' },
  { id: 'sad', title: 'ناراحت', src: '/character-assets/states/sad.png' },
  { id: 'win', title: 'برنده', src: '/character-assets/states/win.png' },
  { id: 'lose', title: 'بازنده', src: '/character-assets/states/lose.png' }
];

const defaultItems: CharacterItem[] = [
  item('none_head', 'head', 'بدون آیتم', '/character-assets/outfits/head/none.png', 'common', 0, 1, ['default']),
  item('cap_blue', 'head', 'کلاه آبی', '/character-assets/outfits/head/cap_blue.png', 'common', 120, 1, ['casual']),
  item('crown_gold', 'head', 'تاج طلایی', '/character-assets/outfits/head/crown_gold.png', 'legendary', 900, 5, ['winner', 'premium']),
  item('halo', 'head', 'هاله نور', '/character-assets/outfits/head/halo.png', 'epic', 650, 4, ['glow']),
  item('none_body', 'body', 'لباس اصلی', '/character-assets/outfits/body/none.png', 'common', 0, 1, ['default']),
  item('hoodie_sky', 'body', 'هودی آسمانی', '/character-assets/outfits/body/hoodie_sky.png', 'common', 180, 1, ['casual']),
  item('jacket_purple', 'body', 'ژاکت بنفش', '/character-assets/outfits/body/jacket_purple.png', 'rare', 350, 2, ['style']),
  item('badge_star', 'body', 'نشان ستاره', '/character-assets/outfits/body/badge_star.png', 'epic', 500, 3, ['achievement']),
  item('none_shoes', 'shoes', 'کفش اصلی', '/character-assets/outfits/shoes/none.png', 'common', 0, 1, ['default']),
  item('sneakers_blue', 'shoes', 'اسنیکر آبی', '/character-assets/outfits/shoes/sneakers_blue.png', 'common', 160, 1, ['sport']),
  item('boots_black', 'shoes', 'بوت مشکی', '/character-assets/outfits/shoes/boots_black.png', 'rare', 320, 2, ['cool']),
  item('gold_steps', 'shoes', 'کفش طلایی', '/character-assets/outfits/shoes/gold_steps.png', 'legendary', 850, 5, ['winner'])
];

let seeded = false;

export async function ensureCharacterCatalogSeeded(): Promise<void> {
  if (seeded) return;
  const existing = await repositories.characters.listItems();
  if (!existing.length) {
    await Promise.all(defaultItems.map((item) => repositories.characters.saveItem(item)));
  }
  seeded = true;
}

export async function getCharacterCatalog(status: CharacterItemStatus = 'active') {
  await ensureCharacterCatalogSeeded();
  return { states, items: await repositories.characters.listItems(status), slots: ['head', 'body', 'shoes'] as CharacterSlot[], defaultLoadout: defaultLoadout() };
}

export async function listAdminCharacterItems(status?: CharacterItemStatus): Promise<CharacterItem[]> {
  await ensureCharacterCatalogSeeded();
  return repositories.characters.listItems(status);
}

export async function upsertCharacterItem(input: Partial<CharacterItem> & { id: string }): Promise<CharacterItem> {
  await ensureCharacterCatalogSeeded();
  const now = new Date().toISOString();
  const current = await repositories.characters.findItemById(input.id);
  const next: CharacterItem = {
    id: input.id,
    slot: (input.slot ?? current?.slot ?? 'head') as CharacterSlot,
    title: input.title ?? current?.title ?? input.id,
    src: input.src ?? current?.src ?? '/character-assets/outfits/head/none.png',
    rarity: (input.rarity ?? current?.rarity ?? 'common') as CharacterRarity,
    priceCoins: Number(input.priceCoins ?? current?.priceCoins ?? 0),
    unlockLevel: Number(input.unlockLevel ?? current?.unlockLevel ?? 1),
    tags: Array.isArray(input.tags) ? input.tags.map(String) : current?.tags ?? [],
    status: (input.status ?? current?.status ?? 'active') as CharacterItemStatus,
    createdAt: current?.createdAt ?? now,
    updatedAt: now
  };
  await repositories.characters.saveItem(next);
  return next;
}

export async function updateCharacterItemStatus(itemId: string, status: CharacterItemStatus): Promise<CharacterItem | null> {
  await ensureCharacterCatalogSeeded();
  return repositories.characters.updateItemStatus(itemId, status);
}

export async function getUserCharacter(userId: string): Promise<CharacterInventory> {
  await ensureCharacterCatalogSeeded();
  const existing = await repositories.characters.getInventory(userId);
  if (existing) return existing;
  const inv: CharacterInventory = { userId, unlockedItemIds: defaultUnlocked(), loadout: defaultLoadout(), updatedAt: new Date().toISOString() };
  await repositories.characters.saveInventory(inv);
  for (const itemId of inv.unlockedItemIds) await repositories.characters.appendUnlockEvent({ id: id(), userId, itemId, reason: 'default', createdAt: new Date().toISOString() });
  return inv;
}

export async function equipCharacterItem(userId: string, input: { slot?: CharacterSlot; itemId?: string; state?: CharacterStateKey }): Promise<CharacterInventory> {
  const inv = await getUserCharacter(userId);
  if (input.state) {
    if (!states.some((state) => state.id === input.state)) throw new Error('CHARACTER_STATE_NOT_FOUND');
    inv.loadout.state = input.state;
  }
  if (input.slot && input.itemId) {
    const catalogItem = await repositories.characters.findItemById(input.itemId);
    if (!catalogItem || catalogItem.slot !== input.slot || catalogItem.status !== 'active') throw new Error('CHARACTER_ITEM_NOT_FOUND');
    if (!inv.unlockedItemIds.includes(catalogItem.id)) throw new Error('CHARACTER_ITEM_LOCKED');
    inv.loadout.outfit[input.slot] = catalogItem.id;
  }
  inv.updatedAt = new Date().toISOString();
  await repositories.characters.saveInventory(inv);
  return inv;
}

export async function unlockCharacterItem(userId: string, itemId: string, reason: 'purchase' | 'admin' | 'reward' | 'level' = 'level'): Promise<CharacterInventory> {
  const inv = await getUserCharacter(userId);
  const catalogItem = await repositories.characters.findItemById(itemId);
  if (!catalogItem || catalogItem.status !== 'active') throw new Error('CHARACTER_ITEM_NOT_FOUND');
  const user = await repositories.users.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  if ((catalogItem.unlockLevel ?? 1) > user.level && reason !== 'admin' && reason !== 'reward') throw new Error('CHARACTER_LEVEL_REQUIRED');
  if (!inv.unlockedItemIds.includes(itemId)) {
    inv.unlockedItemIds.push(itemId);
    await repositories.characters.appendUnlockEvent({ id: id(), userId, itemId, reason, createdAt: new Date().toISOString() });
  }
  inv.updatedAt = new Date().toISOString();
  await repositories.characters.saveInventory(inv);
  return inv;
}

export async function purchaseCharacterItem(userId: string, itemId: string): Promise<CharacterInventory> {
  const catalogItem = await repositories.characters.findItemById(itemId);
  if (!catalogItem || catalogItem.status !== 'active') throw new Error('CHARACTER_ITEM_NOT_FOUND');
  const inv = await getUserCharacter(userId);
  if (inv.unlockedItemIds.includes(itemId)) return inv;
  const user = await repositories.users.findById(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.level < (catalogItem.unlockLevel ?? 1)) throw new Error('CHARACTER_LEVEL_REQUIRED');
  if (user.coins < catalogItem.priceCoins) throw new Error('INSUFFICIENT_COINS');
  user.coins -= catalogItem.priceCoins;
  await repositories.users.save(user);
  inv.unlockedItemIds.push(itemId);
  inv.updatedAt = new Date().toISOString();
  await repositories.characters.saveInventory(inv);
  await repositories.characters.appendUnlockEvent({ id: id(), userId, itemId, reason: 'purchase', createdAt: new Date().toISOString() });
  return inv;
}

export async function randomizeCharacter(userId: string): Promise<CharacterInventory> {
  const inv = await getUserCharacter(userId);
  const catalogItems = await repositories.characters.listItems('active');
  const bySlot = (slot: CharacterSlot) => inv.unlockedItemIds.map((id) => catalogItems.find((item) => item.id === id)).filter((item): item is CharacterItem => Boolean(item && item.slot === slot));
  inv.loadout.state = states[Math.floor(Math.random() * states.length)]!.id;
  for (const slot of ['head', 'body', 'shoes'] as CharacterSlot[]) {
    const choices = bySlot(slot);
    inv.loadout.outfit[slot] = choices[Math.floor(Math.random() * choices.length)]?.id ?? inv.loadout.outfit[slot];
  }
  inv.updatedAt = new Date().toISOString();
  await repositories.characters.saveInventory(inv);
  return inv;
}

export async function listCharacterUnlockEvents(userId: string, limit = 100) {
  return repositories.characters.listUnlockEvents(userId, limit);
}

function item(idValue: string, slot: CharacterSlot, title: string, src: string, rarity: CharacterRarity, priceCoins: number, unlockLevel: number, tags: string[]): CharacterItem {
  const now = new Date().toISOString();
  return { id: idValue, slot, title, src, rarity, priceCoins, unlockLevel, tags, status: 'active', createdAt: now, updatedAt: now };
}
function defaultUnlocked(): string[] { return ['none_head', 'none_body', 'none_shoes', 'cap_blue', 'hoodie_sky', 'sneakers_blue']; }
function defaultLoadout(): CharacterLoadout { return { state: 'idle', outfit: { head: 'none_head', body: 'none_body', shoes: 'none_shoes' } }; }
