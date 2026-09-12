/* SPENDING AND EARNING COINS, WHEN TWO THINGS HAPPEN AT ONCE.
 *
 * Every coin movement used to be three steps done by hand: read the user, work
 * out the new figure, write the whole user back. Between the read and the write
 * is a gap, and in that gap another request has read the same figure. Two
 * grants landing together kept one of them. Two spends together charged for
 * one. Nothing was logged, nothing threw — the number was simply wrong.
 *
 * And because the write put back the WHOLE user from a snapshot taken before
 * the gap, a purchase could just as easily restore a stale heart count or undo
 * the XP a match had awarded in between.
 *
 * These tests do the thing that used to break it: run the movements together.
 *
 * Run: npx tsx src/tests/coins.test.ts
 *      DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/coins.test.ts */
import assert from 'node:assert/strict';
import { addCoins, getCoins, _resetCoinLocks } from '../services/coinService.js';
import { purchase, ShopError, _resetPurchaseMemory } from '../services/shopPurchaseService.js';
import { saveItem } from '../services/shopService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(coins: number): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'c' + uid.slice(0, 8), displayName: 'c',
    phone: '09' + String(200000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  return uid;
}
const uniq = () => 'k_' + id();

(async () => {
  console.log(`[coins] driver: ${process.env.DATABASE_URL ? 'postgres' : 'memory'}`);
  _resetCoinLocks();
  await _resetPurchaseMemory();

  /* ── the primitive ─────────────────────────────────────────────────── */

  await check('coins can be added', async () => {
    const uid = await player(100);
    assert.equal(await addCoins(uid, 50), 150);
    assert.equal(await getCoins(uid), 150);
  });

  await check('and spent', async () => {
    const uid = await player(100);
    assert.equal(await addCoins(uid, -30), 70);
    assert.equal(await getCoins(uid), 70);
  });

  await check('spending exactly what they have is allowed', async () => {
    const uid = await player(100);
    assert.equal(await addCoins(uid, -100), 0);
  });

  await check('spending more than they have is refused — and takes NOTHING', async () => {
    const uid = await player(100);
    assert.equal(await addCoins(uid, -101), null, 'refused');
    assert.equal(await getCoins(uid), 100, 'and the refusal did not take a partial payment');
  });

  await check('a player who does not exist cannot be charged', async () => {
    assert.equal(await addCoins(id(), -10), null);
  });

  await check('moving nothing is not a refusal', async () => {
    const uid = await player(0);
    assert.equal(await addCoins(uid, 0), 0, 'zero is a no-op, not «not enough»');
  });

  /* ── the gap that used to lose money ───────────────────────────────── */

  await check('ten spends at once charge ten times, not once', async () => {
    const uid = await player(1000);
    await Promise.all(Array.from({ length: 10 }, () => addCoins(uid, -100)));
    assert.equal(await getCoins(uid), 0,
      'read-modify-write left 900 here: nine of the ten charges vanished');
  });

  await check('ten grants at once all land', async () => {
    const uid = await player(0);
    await Promise.all(Array.from({ length: 10 }, () => addCoins(uid, 100)));
    assert.equal(await getCoins(uid), 1000, 'a reward the player watched arrive must not be lost');
  });

  await check('and a balance can never be raced below zero', async () => {
    /* Ten tries at 100 against 500: exactly five may succeed, however they
       interleave. This is the one that costs real money — five items handed
       over for five payments, not for two. */
    const uid = await player(500);
    const results = await Promise.all(Array.from({ length: 10 }, () => addCoins(uid, -100)));
    const taken = results.filter((r) => r !== null).length;
    assert.equal(taken, 5, 'took ' + taken + ' payments out of a balance that covers 5');
    assert.equal(await getCoins(uid), 0);
  });

  await check('spending and earning at the same time settle to the right total', async () => {
    const uid = await player(500);
    await Promise.all([
      ...Array.from({ length: 5 }, () => addCoins(uid, -50)),
      ...Array.from({ length: 5 }, () => addCoins(uid, 30))
    ]);
    assert.equal(await getCoins(uid), 500 - 250 + 150);
  });

  /* ── buying with coins ─────────────────────────────────────────────── */

  const coinItem = await saveItem({
    category: 'other', name: 'بستهٔ سکه‌ای', description: 'برای تست', icon: '🎁',
    price: 100, currency: 'coins', enabled: true, sortOrder: 1,
    rewards: [{ key: 'heart', value: 1 }]
  } as any);

  await check('a coin purchase charges exactly once', async () => {
    const uid = await player(300);
    await purchase({ userId: uid, itemId: coinItem.id, idempotencyKey: uniq() });
    assert.equal(await getCoins(uid), 200);
  });

  await check('and the same key twice charges once', async () => {
    const uid = await player(300);
    const k = uniq();
    await purchase({ userId: uid, itemId: coinItem.id, idempotencyKey: k });
    await purchase({ userId: uid, itemId: coinItem.id, idempotencyKey: k });
    assert.equal(await getCoins(uid), 200, 'one purchase, one charge');
  });

  await check('a player who cannot afford it is refused and charged nothing', async () => {
    const uid = await player(50);
    await assert.rejects(
      () => purchase({ userId: uid, itemId: coinItem.id, idempotencyKey: uniq() }),
      (e: unknown) => e instanceof ShopError && e.code === 'INSUFFICIENT_COINS'
    );
    assert.equal(await getCoins(uid), 50);
  });

  await check('three purchases at once are all three paid for', async () => {
    const uid = await player(300);
    await Promise.all(Array.from({ length: 3 }, () => purchase({ userId: uid, itemId: coinItem.id, idempotencyKey: uniq() })));
    assert.equal(await getCoins(uid), 0, 'three items, three charges');
  });

  /* ── THE BUG THIS WAS OPENED FOR ───────────────────────────────────── */

  /* An item whose reward cannot be granted: a league ticket is earned on the
     weekly board and the shop refuses to hand one over, whatever the catalogue
     says. So the charge succeeds and the grant then fails — which is the shape
     that used to leave the player poorer with nothing, and then charge them a
     SECOND time when they tried again. */
  const brokenItem = await saveItem({
    category: 'other', name: 'چیزی که تحویل نمی‌شود', description: 'برای تست', icon: '💥',
    price: 100, currency: 'coins', enabled: true, sortOrder: 2,
    rewards: [{ key: 'ticket-gold', value: 1 }]
  } as any);

  await check('a purchase that fails to deliver gives the coins back', async () => {
    const uid = await player(300);
    await assert.rejects(() => purchase({ userId: uid, itemId: brokenItem.id, idempotencyKey: uniq() }));
    assert.equal(await getCoins(uid), 300,
      'charged and given nothing — coins have no ledger to point at afterwards');
  });

  await check('and trying again does not charge a second time', async () => {
    const uid = await player(300);
    const k = uniq();
    await assert.rejects(() => purchase({ userId: uid, itemId: brokenItem.id, idempotencyKey: k }));
    await assert.rejects(() => purchase({ userId: uid, itemId: brokenItem.id, idempotencyKey: k }));
    await assert.rejects(() => purchase({ userId: uid, itemId: brokenItem.id, idempotencyKey: k }));
    assert.equal(await getCoins(uid), 300, 'three attempts, nothing delivered, nothing taken');
  });

  await check('a refunded key can still be used for a purchase that works', async () => {
    const uid = await player(300);
    const k = uniq();
    await assert.rejects(() => purchase({ userId: uid, itemId: brokenItem.id, idempotencyKey: k }));
    await purchase({ userId: uid, itemId: coinItem.id, idempotencyKey: k });
    assert.equal(await getCoins(uid), 200, 'the failed attempt must not burn the key');
  });

  /* ── the rest of the row is not collateral damage ──────────────────── */

  await check('charging coins does not write back a stale heart count', async () => {
    const uid = await player(300);
    const u = (await repositories.users.findById(uid))!;
    u.hearts = 9; await repositories.users.save(u);
    await addCoins(uid, -100);
    const after = (await repositories.users.findById(uid))!;
    assert.equal(Number(after.hearts), 9, 'a coin charge rewrote the whole user and undid this');
    assert.equal(Number(after.coins), 200);
  });

  await check('nor undo XP won while the purchase was in flight', async () => {
    const uid = await player(300);
    const u = (await repositories.users.findById(uid))!;
    u.xp = 4242; await repositories.users.save(u);
    await addCoins(uid, 100);
    assert.equal(Number((await repositories.users.findById(uid))!.xp), 4242);
  });

  console.log(`[coins] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
