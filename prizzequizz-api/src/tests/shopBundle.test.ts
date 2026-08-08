/* BUNDLES — one item that hands over several things.
 *
 * «۳ بلیط + ۴۰۰ سکه + ۲ کمک» used to be impossible to sell: an item had a
 * single effectKey and a single amount, so a package needed three separate
 * purchases. It also meant the game could only ever say "something was
 * bought", never what.
 *
 * Run: npx tsx src/tests/shopBundle.test.ts
 */
import assert from 'node:assert/strict';
import { saveItem, getItem, rewardsOf, rewardLabel } from '../services/shopService.js';
import { purchase, _resetPurchaseMemory } from '../services/shopPurchaseService.js';
import { getTickets } from '../services/ticketService.js';
import { inventoryFor } from '../services/lifelineService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function buyer(coins = 100000): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'bn' + uid.slice(0, 8), displayName: 'bn',
    phone: '09' + String(600000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins, hearts: 0, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return uid;
}
const uniq = () => 'k_' + Math.random().toString(36).slice(2);

async function run(): Promise<void> {
  _resetPurchaseMemory();

  const bundle = await saveItem({
    category: 'tickets', name: 'بستهٔ شروع', description: 'برای شروع', icon: '🎁',
    price: 900, currency: 'coins', enabled: true, sortOrder: 1,
    rewards: [{ key: 'ticket-green', value: 3 }, { key: 'coins', value: 400 }, { key: 'p5050', value: 2 }]
  } as any);

  await check('a bundle keeps all three rows', async () => {
    const it = (await getItem(bundle.id))!;
    assert.equal(it.rewards?.length, 3, JSON.stringify(it.rewards));
    assert.deepEqual(rewardsOf(it).map((r) => r.key), ['ticket-green', 'coins', 'p5050']);
  });

  await check('buying it grants every one of them', async () => {
    /* A new account does not start empty — it is handed some helps — so every
       assertion here is a DELTA. Measuring the baseline rather than assuming
       it is zero is the only way this says what it claims to say. */
    const uid = await buyer();
    const t0 = await getTickets(uid), inv0 = await inventoryFor(uid);
    const r = await purchase({ userId: uid, itemId: bundle.id, idempotencyKey: uniq() });
    const t = await getTickets(uid), inv = await inventoryFor(uid);
    const u: any = await repositories.users.findById(uid);
    assert.equal(Number(t.green) - Number(t0.green || 0), 3, 'three green tickets');
    assert.equal(Number(u.coins), 100000 - 900 + 400, 'charged 900, credited 400');
    assert.equal(Number(inv.p5050 || 0) - Number(inv0.p5050 || 0), 2, 'two 50:50 helps');
    assert.equal(r.granted.length, 3);
  });

  await check('the receipt says exactly what arrived, in Persian', async () => {
    /* This is what «۳ عدد بلیط سبز خریداری شد» is built from. The game must
       not have to guess it from effectKey. */
    const uid = await buyer();
    const r = await purchase({ userId: uid, itemId: bundle.id, idempotencyKey: uniq() });
    assert.deepEqual(r.granted, [
      { key: 'ticket-green', value: 3, label: 'بلیط سبز' },
      { key: 'coins', value: 400, label: 'سکه' },
      { key: 'p5050', value: 2, label: 'کمک حذف دو گزینه' }
    ]);
  });

  await check('quantity multiplies every row, not just the first', async () => {
    const uid = await buyer();
    const t0 = await getTickets(uid), inv0 = await inventoryFor(uid);
    const r = await purchase({ userId: uid, itemId: bundle.id, qty: 2, idempotencyKey: uniq() });
    const t = await getTickets(uid), inv = await inventoryFor(uid);
    assert.equal(Number(t.green) - Number(t0.green || 0), 6, 'six tickets');
    assert.equal(Number(inv.p5050 || 0) - Number(inv0.p5050 || 0), 4, 'four helps');
    assert.deepEqual(r.granted.map((g) => g.value), [6, 800, 4]);
  });

  await check('a plain single-effect item still works untouched', async () => {
    const plain = await saveItem({
      category: 'coins', name: '۵۰ سکه', icon: '🪙', price: 10, currency: 'coins',
      effectKey: 'coins', effectValue: 50, enabled: true
    } as any);
    const uid = await buyer(1000);
    const r = await purchase({ userId: uid, itemId: plain.id, idempotencyKey: uniq() });
    const u: any = await repositories.users.findById(uid);
    assert.equal(Number(u.coins), 1000 - 10 + 50);
    assert.deepEqual(r.granted, [{ key: 'coins', value: 50, label: 'سکه' }]);
  });

  await check('the single-effect pair follows the first row of a bundle', async () => {
    /* The mission counters and every older reader still look at
       effectKey/effectValue; a bundle whose pair said «gift ×1» would
       miscount «۱۰۰۰ سکه خرج کن». */
    const it = (await getItem(bundle.id))!;
    assert.equal(it.effectKey, 'ticket-green');
    assert.equal(it.effectValue, 3);
  });

  await check('a ticket bundle really moves the ticket balance, not a counter', async () => {
    const uid = await buyer();
    const before = await getTickets(uid);
    await purchase({ userId: uid, itemId: bundle.id, idempotencyKey: uniq() });
    const after = await getTickets(uid);
    assert.equal(Number(after.green) - Number(before.green), 3);
  });

  await check('rows with a zero or missing amount are dropped, not granted', async () => {
    const messy = await saveItem({
      category: 'util', name: 'بستهٔ نصفه', icon: '🎁', price: 0, currency: 'coins', enabled: true,
      rewards: [{ key: 'coins', value: 0 }, { key: '', value: 5 }, { key: 'heart', value: 2 }]
    } as any);
    const it = (await getItem(messy.id))!;
    assert.deepEqual(it.rewards, [{ key: 'heart', value: 2 }], JSON.stringify(it.rewards));
  });

  await check('an item can carry artwork instead of an emoji', async () => {
    const art = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    const withArt = await saveItem({ category: 'tickets', name: 'با عکس', icon: '🎫', price: 1, currency: 'coins', enabled: true, image: art } as any);
    assert.equal((await getItem(withArt.id))!.image, art);
  });

  await check('editing an item without mentioning rewards keeps them', async () => {
    /* The panel saves the whole form; a screen that does not know about
       bundles must not silently empty one. */
    const it = (await getItem(bundle.id))!;
    await saveItem({ id: it.id, name: 'بستهٔ شروع', category: it.category, price: 950 } as any);
    const after = (await getItem(bundle.id))!;
    assert.equal(after.price, 950, 'the edit applied');
    assert.equal(after.rewards?.length, 3, 'and the bundle survived');
  });

  await check('labels are defined for everything a bundle can contain', async () => {
    for (const k of ['coins', 'heart', 'xp', 'ticket-green', 'ticket-blue', 'ticket-red', 'p5050', 'psecond', 'pstats']) {
      assert.notEqual(rewardLabel(k), k, k + ' has no Persian name');
    }
  });

  console.log(`[shopBundle] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
