/* BUYING FROM THE SHOP.
 *
 * The shop listed prices and had no endpoint to pay them — hearts and coins
 * were unbuyable because nothing on the server could sell anything. This
 * covers the half that was missing: the money really leaves, the item really
 * arrives, a repeat charges once, and a purchase nobody can afford is refused
 * before anything is granted. */
import assert from 'node:assert/strict';
import { ShopError, purchase, _resetPurchaseMemory } from '../services/shopPurchaseService.js';
import { listItems, saveItem } from '../services/shopService.js';
import { getHearts, _resetHeartMemory } from '../services/heartService.js';
import { postEntry } from '../services/walletLedgerService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}
async function makeUser(opts: { wallet?: number; coins?: number; hearts?: number } = {}): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'sh_' + userId.slice(0, 6),
    displayName: 'خریدار', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: opts.wallet ?? 0, coins: opts.coins ?? 0, hearts: opts.hearts ?? 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  if (opts.wallet) {
    await postEntry({ userId, entryType: 'deposit', kind: 'credit', amount: opts.wallet,
      idempotencyKey: 'seed:' + userId, description: 'شارژ تست' }).catch(() => undefined);
  }
  return userId;
}
const uniq = () => 'k-' + id();

async function run() {
  _resetPurchaseMemory(); _resetHeartMemory();
  const items = await listItems({ enabledOnly: true });

  const heartItem = items.find((i) => i.effectKey === 'heart' && i.effectValue === 1);
  const heartPack = items.find((i) => i.effectKey === 'heart' && i.effectValue >= 5);
  const coinItem = items.find((i) => i.effectKey === 'coins');

  await check('the shop actually sells hearts and coins', async () => {
    assert.ok(heartItem, 'a single heart must be on sale');
    assert.ok(heartPack, 'and a pack');
    assert.ok(coinItem, 'coins must be on sale — the header shows them, so they must be buyable');
  });

  await check('buying a heart takes the money and hands over the heart', async () => {
    const uid = await makeUser({ wallet: 500000, hearts: 1 });
    const r = await purchase({ userId: uid, itemId: heartItem!.id, idempotencyKey: uniq() });
    assert.equal(r.effectKey, 'heart');
    assert.equal((await getHearts(uid)).hearts, 2, 'the heart arrived');
    assert.equal(r.balances.wallet, 500000 - heartItem!.price, 'and the money left');
  });

  await check('the balances come back so the header can be updated at once', async () => {
    const uid = await makeUser({ wallet: 500000, coins: 10, hearts: 0 });
    const r = await purchase({ userId: uid, itemId: coinItem!.id, idempotencyKey: uniq() });
    assert.equal(r.balances.coins, 10 + coinItem!.effectValue);
    assert.equal(typeof r.balances.hearts, 'number');
    assert.equal(typeof r.balances.wallet, 'number');
  });

  await check('a heart pack grants the whole pack', async () => {
    const uid = await makeUser({ wallet: 500000, hearts: 0 });
    await purchase({ userId: uid, itemId: heartPack!.id, idempotencyKey: uniq() });
    assert.equal((await getHearts(uid)).hearts, heartPack!.effectValue);
  });

  await check('bought hearts may sit above the free cap', async () => {
    /* Otherwise the pack quietly evaporates for anyone who is nearly full. */
    const uid = await makeUser({ wallet: 500000, hearts: 5 });
    await purchase({ userId: uid, itemId: heartPack!.id, idempotencyKey: uniq() });
    assert.equal((await getHearts(uid)).hearts, 5 + heartPack!.effectValue);
  });

  await check('a double tap charges once', async () => {
    const uid = await makeUser({ wallet: 500000, hearts: 0 });
    const key = uniq();
    const a = await purchase({ userId: uid, itemId: heartItem!.id, idempotencyKey: key });
    const b = await purchase({ userId: uid, itemId: heartItem!.id, idempotencyKey: key });
    assert.equal(b.duplicate, true);
    assert.equal((await getHearts(uid)).hearts, 1, 'one heart, not two');
    assert.equal(a.balances.wallet, b.balances.wallet);
  });

  await check('an empty wallet is refused and nothing is granted', async () => {
    const uid = await makeUser({ wallet: 0, hearts: 0 });
    await assert.rejects(() => purchase({ userId: uid, itemId: heartItem!.id, idempotencyKey: uniq() }),
      (e: any) => e instanceof ShopError && e.code === 'INSUFFICIENT_FUNDS');
    assert.equal((await getHearts(uid)).hearts, 0, 'no heart on credit');
  });

  await check('a coin-priced item spends coins, not the wallet', async () => {
    const it = await saveItem({ name: 'تست سکه‌ای', category: 'util', icon: '🧪',
      price: 100, currency: 'coins', effectKey: 'heart', effectValue: 1, enabled: true } as any);
    const uid = await makeUser({ wallet: 0, coins: 250, hearts: 0 });
    const r = await purchase({ userId: uid, itemId: it.id, idempotencyKey: uniq() });
    assert.equal(r.balances.coins, 150);
    assert.equal((await getHearts(uid)).hearts, 1);
  });

  await check('not enough coins is refused too', async () => {
    const it = await saveItem({ name: 'تست گران', category: 'util', icon: '🧪',
      price: 9999, currency: 'coins', effectKey: 'heart', effectValue: 1, enabled: true } as any);
    const uid = await makeUser({ coins: 10 });
    await assert.rejects(() => purchase({ userId: uid, itemId: it.id, idempotencyKey: uniq() }),
      (e: any) => e instanceof ShopError && e.code === 'INSUFFICIENT_COINS');
  });

  await check('a switched-off item cannot be bought', async () => {
    const it = await saveItem({ name: 'خاموش', category: 'util', icon: '🧪',
      price: 0, currency: 'coins', effectKey: 'heart', effectValue: 1, enabled: false } as any);
    const uid = await makeUser({ wallet: 100000 });
    await assert.rejects(() => purchase({ userId: uid, itemId: it.id, idempotencyKey: uniq() }),
      (e: any) => e instanceof ShopError && e.code === 'ITEM_DISABLED');
  });

  await check('an item that does not exist is refused', async () => {
    const uid = await makeUser({ wallet: 100000 });
    await assert.rejects(() => purchase({ userId: uid, itemId: 'no-such-item', idempotencyKey: uniq() }),
      (e: any) => e instanceof ShopError && e.code === 'ITEM_NOT_FOUND');
  });

  await check('a purchase without an idempotency key is refused', async () => {
    const uid = await makeUser({ wallet: 100000 });
    await assert.rejects(() => purchase({ userId: uid, itemId: heartItem!.id, idempotencyKey: '' }),
      (e: any) => e instanceof ShopError && e.code === 'IDEMPOTENCY_REQUIRED');
  });

  await check('buying several at once charges for several', async () => {
    const uid = await makeUser({ wallet: 500000, hearts: 0 });
    const r = await purchase({ userId: uid, itemId: heartItem!.id, qty: 3, idempotencyKey: uniq() });
    assert.equal(r.price, heartItem!.price * 3);
    assert.equal((await getHearts(uid)).hearts, 3);
  });

  console.log(`[shopPurchase] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
run();
