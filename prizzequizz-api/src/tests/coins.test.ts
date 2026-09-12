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
import { addCoins, getCoins, setUserNumber, addUserNumber, _resetCoinLocks } from '../services/coinService.js';
import { purchase, ShopError, _resetPurchaseMemory } from '../services/shopPurchaseService.js';
import { addHearts } from '../services/heartService.js';
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

  /* ── ONE NUMBER AT A TIME ──────────────────────────────────────────
   * The deeper half of the same bug, and the one that made three purchases at
   * once charge for two. Granting a heart read the user, changed hearts, and
   * saved the WHOLE row back — carrying the coin figure as it had been a moment
   * earlier. So the heart an item granted undid the coins that paid for it.
   *
   * Driven step by step rather than by racing, because a race reproduces it
   * only sometimes and a test that catches a money bug «sometimes» is not
   * catching it. This is the exact order that used to lose the charge. */

  await check('a write to one number does not put back another', async () => {
    const uid = await player(300);
    const stale = (await repositories.users.findById(uid))!;   // what addHearts reads
    const hearts = Number(stale.hearts) || 0;
    await addCoins(uid, -100);                                  // a charge lands in between
    await setUserNumber(uid, 'hearts', hearts + 1);             // and the heart write follows
    assert.equal(await getCoins(uid), 200,
      'the heart write put the old coin figure back — the item was free');
    assert.equal(Number((await repositories.users.findById(uid))!.hearts), hearts + 1,
      'and the heart still has to actually arrive');
  });

  await check('a heart granted MID-CHARGE does not put the coins back', async () => {
    /* THE ACTUAL SHAPE OF THE BUG, and the reason three purchases at once only
       charged for two: addHearts reads the user, works out the new heart count,
       and writes it — and a charge landing in THAT window used to be put
       straight back, because the write carried every other column along from
       the object that was read before it.
       Two things had to be got right for this to mean anything. Starting the
       grant and hoping the charge lands inside the window does NOT reproduce
       it: tried, and it passed against the bug every time. And the window has
       to be held open on the heart write itself — holding the first save that
       comes along can catch the charge's own write instead, which deadlocks.
       So the save carrying the new heart count is the one that is paused, and
       the charge is not made until it is definitely the thing being held.
       On the memory driver this cannot bite at all: every read hands back the
       SAME live row, so there is no stale copy for a write to carry. It bites
       on Postgres, where each read is its own object — which is exactly where
       the money is. */
    const uid = await player(300);
    const before = Number((await repositories.users.findById(uid))!.hearts) || 0;
    const users: any = repositories.users;
    const realSave = users.save.bind(users);
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let armed = true, engaged = false;
    users.save = async (u: any) => {
      if (armed && u && u.id === uid && Number(u.hearts) > before) { armed = false; engaged = true; await held; }
      return realSave(u);
    };
    try {
      const flying = addHearts(uid, 1);
      /* Do not charge until the heart write is the thing being held. */
      for (let i = 0; i < 200 && !engaged && armed; i++) await new Promise((r) => setTimeout(r, 5));
      await addCoins(uid, -100);
      release();
      await flying;
    } finally { users.save = realSave; release(); }
    assert.equal(await getCoins(uid), 200,
      'the heart write carried an older coin figure with it — the purchase was free');
    assert.ok(Number((await repositories.users.findById(uid))!.hearts) > before, 'and the heart arrived');
  });

  await check('the same holds for a number that is added rather than set', async () => {
    const uid = await player(300);
    await repositories.users.findById(uid);
    await addCoins(uid, -100);
    await addUserNumber(uid, 'xp', 50);
    assert.equal(await getCoins(uid), 200);
    assert.equal(Number((await repositories.users.findById(uid))!.xp), 50);
  });

  await check('and a granted heart really lands', async () => {
    /* setUserNumber quietly doing nothing would look exactly like success to
       everything above, so the value is read back. */
    const uid = await player(0);
    await setUserNumber(uid, 'hearts', 7);
    assert.equal(Number((await repositories.users.findById(uid))!.hearts), 7);
  });

  await check('a number added to cannot be driven below zero', async () => {
    const uid = await player(0);
    await addUserNumber(uid, 'xp', 30);
    await addUserNumber(uid, 'xp', -1000);
    assert.equal(Number((await repositories.users.findById(uid))!.xp), 0,
      'negative XP is not a thing the rest of the game knows how to read');
  });

  await check('coins move in whole numbers', async () => {
    const uid = await player(100);
    await addCoins(uid, 10.6);
    assert.equal(await getCoins(uid), 111, 'rounded, not truncated and not left a fraction');
    assert.equal(Number.isInteger(await getCoins(uid)), true);
  });

  await check('and nonsense moves nothing', async () => {
    const uid = await player(100);
    assert.equal(await addCoins(uid, NaN as any), 100);
    assert.equal(await addCoins(uid, undefined as any), 100);
    assert.equal(await getCoins(uid), 100);
  });

  await check('two movements at once on the memory driver keep both', async () => {
    /* The memory path has no lock because it needs none: the repository hands
       back the live row and nothing awaits between reading a number and writing
       it. If that repository is ever changed to hand back copies, this is the
       test that says so. */
    const uid = await player(0);
    await Promise.all([addCoins(uid, 100), addCoins(uid, 100)]);
    assert.equal(await getCoins(uid), 200);
  });

  console.log(`[coins] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
