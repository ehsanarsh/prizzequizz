import { api } from '../../api';
import type { CharacterCatalogDto, CharacterInventoryDto, CharacterSlot, CharacterStateKey } from '../../api/contracts';
import { runTask } from '../../core/asyncTask';

let catalog: CharacterCatalogDto | null = null;
let inventory: CharacterInventoryDto | null = null;
let activeSlot: CharacterSlot = 'head';

export function getCharacterCatalog(): CharacterCatalogDto | null { return catalog; }
export function getCharacterInventory(): CharacterInventoryDto | null { return inventory; }
export function getActiveCharacterSlot(): CharacterSlot { return activeSlot; }
export function setActiveCharacterSlot(slot: CharacterSlot): void { activeSlot = slot; }

export async function hydrateCharacter(): Promise<void> {
  await runTask('character.hydrate', async () => {
    const [cat, inv] = await Promise.all([api.characters.catalog(), api.characters.me()]);
    catalog = cat;
    inventory = inv;
  });
}

export async function equipCharacter(input: { slot?: CharacterSlot; itemId?: string; state?: CharacterStateKey }): Promise<boolean> {
  const result = await runTask('character.equip', async () => api.characters.equip(input));
  if (result) inventory = result;
  return !!result;
}

export async function purchaseCharacterItem(itemId: string): Promise<boolean> {
  const result = await runTask('character.purchase', async () => api.characters.purchase(itemId));
  if (result) inventory = result;
  return !!result;
}

export async function unlockCharacterItem(itemId: string): Promise<boolean> {
  const result = await runTask('character.unlock', async () => api.characters.unlock(itemId));
  if (result) inventory = result;
  return !!result;
}

export async function randomizeCharacter(): Promise<boolean> {
  const result = await runTask('character.randomize', async () => api.characters.randomize());
  if (result) inventory = result;
  return !!result;
}
