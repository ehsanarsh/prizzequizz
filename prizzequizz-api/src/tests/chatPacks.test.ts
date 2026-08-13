/* QUICK-CHAT PACKS.
 *
 * The things that would cost real money or leak paid content if they were
 * wrong: a locked pack must not send its sentences, a purchase must charge
 * exactly once, and an admin must not be able to save a catalogue that leaves
 * players unable to say anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_PACK_DEFAULTS, CHAT_PACK_MAX_LEN, CHAT_PACK_MAX_PHRASES,
  ChatPackError, _resetChatPacks, canSay, grantPack, listPacks, ownedKeys,
  packsFor, purchasePack, savePacks
} from '../services/chatPackService.js';
import { repositories } from '../repositories/index.js';

async function mkUser(id: string, coins: number) {
  const now = new Date().toISOString();
  const u: any = {
    id, username: id, displayName: id, phone: '0912' + id, level: 1, xp: 0,
    coins, hearts: 5, wallet: 0, createdAt: now, updatedAt: now
  };
  await repositories.users.save(u);
  return u;
}

test('the shipped catalogue is four packs, one free, twenty sentences each', () => {
  assert.equal(CHAT_PACK_DEFAULTS.length, 4);
  assert.equal(CHAT_PACK_DEFAULTS.filter((p) => p.free).length, 1);
  assert.equal(CHAT_PACK_DEFAULTS.find((p) => p.free)!.key, 'friendly');
  for (const p of CHAT_PACK_DEFAULTS) {
    assert.equal(p.phrases.length, 20, p.key + ' has ' + p.phrases.length);
    assert.equal(new Set(p.phrases).size, 20, p.key + ' repeats a sentence');
    assert.ok(p.phrases.every((s) => s.trim().length && s.length <= CHAT_PACK_MAX_LEN), p.key);
  }
});

test('the free pack arrives unlocked and the paid ones arrive silent', async () => {
  _resetChatPacks();
  await mkUser('cp-a', 9999);
  const packs = await packsFor('cp-a');
  const free = packs.find((p) => p.key === 'friendly')!;
  const paid = packs.find((p) => p.key === 'fun')!;

  assert.equal(free.owned, true);
  assert.equal(free.phrases.length, 20);

  assert.equal(paid.owned, false);
  assert.equal(paid.locked, true);
  /* The price and the size are advertised — the sentences are not. */
  assert.equal(paid.phrases.length, 0);
  assert.equal(paid.phraseCount, 20);
  assert.ok(paid.price > 0);
});

test('a locked pack cannot be spoken from, a free one can', async () => {
  _resetChatPacks();
  await mkUser('cp-b', 9999);
  const funPhrase = CHAT_PACK_DEFAULTS.find((p) => p.key === 'fun')!.phrases[0]!;
  const friendlyPhrase = CHAT_PACK_DEFAULTS.find((p) => p.key === 'friendly')!.phrases[0]!;

  assert.equal(await canSay('cp-b', 'fun', funPhrase), false);
  assert.equal(await canSay('cp-b', 'friendly', friendlyPhrase), true);
  /* Not in the pack at all — the pack being owned is not a licence to send
     arbitrary text through the quick-chat path. */
  assert.equal(await canSay('cp-b', 'friendly', 'یک جملهٔ ساختگی'), false);

  await grantPack('cp-b', 'fun');
  assert.equal(await canSay('cp-b', 'fun', funPhrase), true);
});

test('buying a pack charges the coins once and unlocks the sentences', async () => {
  _resetChatPacks();
  await mkUser('cp-c', 5000);
  const fun = (await listPacks()).find((p) => p.key === 'fun')!;

  const r1 = await purchasePack({ userId: 'cp-c', key: 'fun', idempotencyKey: 'k1' });
  assert.equal(r1.duplicate, false);
  assert.equal(r1.price, fun.price);
  assert.equal(r1.balances.coins, 5000 - fun.price);
  assert.equal(r1.phrases.length, 20);

  const after = await packsFor('cp-c');
  assert.equal(after.find((p) => p.key === 'fun')!.owned, true);
  assert.equal(after.find((p) => p.key === 'fun')!.phrases.length, 20);
});

test('the same purchase key never charges twice', async () => {
  _resetChatPacks();
  await mkUser('cp-d', 5000);
  const fun = (await listPacks()).find((p) => p.key === 'fun')!;

  await purchasePack({ userId: 'cp-d', key: 'fun', idempotencyKey: 'same' });
  const again = await purchasePack({ userId: 'cp-d', key: 'fun', idempotencyKey: 'same' });
  assert.equal(again.duplicate, true);

  const u = await repositories.users.findById('cp-d');
  assert.equal(Number(u!.coins), 5000 - fun.price);
});

test('buying a pack already owned takes nothing, even under a new key', async () => {
  _resetChatPacks();
  await mkUser('cp-e', 5000);
  const fun = (await listPacks()).find((p) => p.key === 'fun')!;
  await purchasePack({ userId: 'cp-e', key: 'fun', idempotencyKey: 'first' });
  const second = await purchasePack({ userId: 'cp-e', key: 'fun', idempotencyKey: 'second' });

  assert.equal(second.duplicate, true);
  assert.equal(second.price, 0);
  const u = await repositories.users.findById('cp-e');
  assert.equal(Number(u!.coins), 5000 - fun.price);
});

test('a player without the coins is refused and keeps every coin', async () => {
  _resetChatPacks();
  await mkUser('cp-f', 10);
  await assert.rejects(
    () => purchasePack({ userId: 'cp-f', key: 'fun', idempotencyKey: 'poor' }),
    (e: any) => e instanceof ChatPackError && e.code === 'INSUFFICIENT_COINS'
  );
  const u = await repositories.users.findById('cp-f');
  assert.equal(Number(u!.coins), 10);
  assert.deepEqual(await ownedKeys('cp-f'), []);
});

test('the free pack is not for sale', async () => {
  _resetChatPacks();
  await mkUser('cp-g', 5000);
  await assert.rejects(
    () => purchasePack({ userId: 'cp-g', key: 'friendly', idempotencyKey: 'ff' }),
    (e: any) => e instanceof ChatPackError && e.code === 'PACK_IS_FREE'
  );
  const u = await repositories.users.findById('cp-g');
  assert.equal(Number(u!.coins), 5000);
});

test('a purchase needs an idempotency key at all', async () => {
  _resetChatPacks();
  await mkUser('cp-h', 5000);
  await assert.rejects(
    () => purchasePack({ userId: 'cp-h', key: 'fun', idempotencyKey: '' }),
    (e: any) => e instanceof ChatPackError && e.code === 'IDEMPOTENCY_REQUIRED'
  );
});

test('the admin can rename a pack, reprice it and switch it to cash', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  const edited = packs.map((p) => p.key === 'trash'
    ? { ...p, name: 'کری‌خوانی', emoji: '🥊', price: 30000, currency: 'cash' as const }
    : p);
  const saved = await savePacks({ packs: edited });
  const trash = saved.find((p) => p.key === 'trash')!;

  assert.equal(trash.name, 'کری‌خوانی');
  assert.equal(trash.emoji, '🥊');
  assert.equal(trash.price, 30000);
  assert.equal(trash.currency, 'cash');
  /* And it survives being read back, not just returned from the save. */
  assert.equal((await listPacks()).find((p) => p.key === 'trash')!.currency, 'cash');
});

test('the admin can rewrite the sentences of a pack', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  const edited = packs.map((p) => p.key === 'fun' ? { ...p, phrases: ['یک', 'دو', 'سه'] } : p);
  await savePacks({ packs: edited });

  await mkUser('cp-i', 5000);
  await grantPack('cp-i', 'fun');
  const view = (await packsFor('cp-i')).find((p) => p.key === 'fun')!;
  assert.deepEqual(view.phrases, ['یک', 'دو', 'سه']);
  assert.equal(view.phraseCount, 3);
  /* The sentence that was removed can no longer be sent. */
  assert.equal(await canSay('cp-i', 'fun', CHAT_PACK_DEFAULTS[1]!.phrases[0]!), false);
});

test('sentences are trimmed, deduped, capped and length-limited', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  const many = Array.from({ length: CHAT_PACK_MAX_PHRASES + 15 }, (_, i) => 'جمله ' + i);
  const edited = packs.map((p) => p.key === 'fun'
    ? { ...p, phrases: ['  سلام  ', 'سلام', '', '  ', 'ا'.repeat(CHAT_PACK_MAX_LEN + 40), ...many] }
    : p);
  const saved = await savePacks({ packs: edited });
  const fun = saved.find((p) => p.key === 'fun')!;

  assert.equal(fun.phrases.length, CHAT_PACK_MAX_PHRASES);
  assert.equal(fun.phrases[0], 'سلام');
  assert.equal(new Set(fun.phrases).size, fun.phrases.length);
  assert.ok(fun.phrases.every((s) => s.length <= CHAT_PACK_MAX_LEN));
  assert.ok(!fun.phrases.includes(''));
});

test('a catalogue with no free pack is refused', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  const edited = packs.map((p) => ({ ...p, free: false, price: p.price || 100 }));
  await assert.rejects(
    () => savePacks({ packs: edited }),
    (e: any) => e instanceof ChatPackError && e.code === 'NO_FREE_PACK'
  );
  /* And the stored catalogue is untouched — a rejected save must not half-apply. */
  assert.equal((await listPacks()).find((p) => p.key === 'friendly')!.free, true);
});

test('a paid pack priced at zero is refused rather than silently free', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  const edited = packs.map((p) => p.key === 'fun' ? { ...p, price: 0 } : p);
  await assert.rejects(
    () => savePacks({ packs: edited }),
    (e: any) => e instanceof ChatPackError && e.code === 'ZERO_PRICE'
  );
});

test('an empty pack and a duplicate key are both refused', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  await assert.rejects(
    () => savePacks({ packs: packs.map((p) => p.key === 'fun' ? { ...p, phrases: [] } : p) }),
    (e: any) => e instanceof ChatPackError && e.code === 'EMPTY_PACK'
  );
  await assert.rejects(
    () => savePacks({ packs: [...packs, { ...packs[1]! }] }),
    (e: any) => e instanceof ChatPackError && e.code === 'DUPLICATE_KEY'
  );
});

test('a disabled pack disappears from the game and cannot be bought or spoken', async () => {
  _resetChatPacks();
  await mkUser('cp-j', 5000);
  const packs = await listPacks();
  await savePacks({ packs: packs.map((p) => p.key === 'fun' ? { ...p, enabled: false } : p) });

  assert.equal((await packsFor('cp-j')).some((p) => p.key === 'fun'), false);
  assert.equal(await canSay('cp-j', 'fun', CHAT_PACK_DEFAULTS[1]!.phrases[0]!), false);
  await assert.rejects(
    () => purchasePack({ userId: 'cp-j', key: 'fun', idempotencyKey: 'off' }),
    (e: any) => e instanceof ChatPackError && e.code === 'PACK_DISABLED'
  );
});

test('a free pack is stored at zero however it was priced', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  const saved = await savePacks({ packs: packs.map((p) => p.key === 'friendly' ? { ...p, price: 9999 } : p) });
  assert.equal(saved.find((p) => p.key === 'friendly')!.price, 0);
});

test('removing a pack takes its ownership rows with it', async () => {
  _resetChatPacks();
  await mkUser('cp-k', 9999);
  await purchasePack({ userId: 'cp-k', key: 'fun', idempotencyKey: 'buy' });
  assert.deepEqual(await ownedKeys('cp-k'), ['fun']);

  const packs = await listPacks();
  await savePacks({ packs: packs.filter((p) => p.key !== 'fun') });
  /* Otherwise a later pack that reuses the key would arrive already owned. */
  assert.equal((await ownedKeys('cp-k')).includes('fun'), false);
});

test('a pack key is a slug — anything else is refused', async () => {
  _resetChatPacks();
  const packs = await listPacks();
  await assert.rejects(
    () => savePacks({ packs: [...packs, { key: '  ', name: 'x', phrases: ['a'], price: 10 }] }),
    (e: any) => e instanceof ChatPackError && e.code === 'BAD_KEY'
  );
  const saved = await savePacks({ packs: [...packs, { key: 'My Pack/../x', name: 'تازه', phrases: ['سلام'], price: 10 }] });
  assert.ok(saved.some((p) => p.key === 'mypackx'), JSON.stringify(saved.map((p) => p.key)));
});

test('savePacks rejects a body that is not a list', async () => {
  _resetChatPacks();
  await assert.rejects(
    () => savePacks({ nope: 1 } as any),
    (e: any) => e instanceof ChatPackError && e.code === 'BAD_INPUT'
  );
});
