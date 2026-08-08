/* TOPPING UP THE SHOP.
 *
 * The automatic seed only fills a catalogue that is COMPLETELY empty. That is
 * right for a fresh install and useless for a running one: a server seeded
 * before the coin packs existed never receives them, and the shop's coins tab
 * stays empty forever with nothing to explain why.
 *
 * Run: npx tsx src/tests/shopSeedMissing.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { listItems, saveItem, removeItem, seedMissing } from '../services/shopService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const coinsOf = async () => (await listItems({})).filter((i) => i.category === 'coins');

async function run(): Promise<void> {
  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const admin = { 'x-admin-key': 'dev-admin', 'content-type': 'application/json' };

  try {
    await check('a catalogue that lost its coin packs gets them back', async () => {
      /* Exactly the shape of the reported server: items exist, but none in the
         coins category, because the catalogue predates it. */
      await listItems({});                                   // triggers the normal seed
      for (const it of await coinsOf()) await removeItem(it.id);
      assert.equal((await coinsOf()).length, 0, 'starting with no coin packs');

      const res = await fetch(base + '/admin/shop/seed-missing', { method: 'POST', headers: admin });
      const body = (await res.json()).data;
      assert.equal(res.status, 200);
      assert.ok(body.addedCount >= 3, 'the three coin packs were added, got ' + body.addedCount);
      assert.equal((await coinsOf()).length, 3, 'and the shop can sell coins again');
    });

    await check('running it again adds nothing', async () => {
      const before = (await listItems({})).length;
      const res = await fetch(base + '/admin/shop/seed-missing', { method: 'POST', headers: admin });
      const body = (await res.json()).data;
      assert.equal(body.addedCount, 0, 'nothing was missing the second time');
      assert.equal((await listItems({})).length, before, 'and no duplicates appeared');
    });

    await check('an item the operator renamed or repriced is not duplicated', async () => {
      /* Identity is what an item DOES — category, effect and amount — not what
         it is called, so editing a seeded item must not make a twin appear. */
      const pack = (await coinsOf())[0]!;
      await saveItem({ ...pack, name: 'اسم دلخواه من', price: 99999 });
      const before = (await coinsOf()).length;
      await seedMissing();
      const after = await coinsOf();
      assert.equal(after.length, before, 'still ' + before + ' coin packs');
      assert.ok(after.some((i) => i.name === 'اسم دلخواه من'), 'and the rename survived');
      assert.ok(after.some((i) => i.price === 99999), 'as did the price');
    });

    await check('it never runs on its own', async () => {
      /* If this were a boot step it would resurrect anything an operator had
         deliberately deleted, on every restart. Deleting and then simply
         reading the catalogue must leave it deleted. */
      for (const it of await coinsOf()) await removeItem(it.id);
      await listItems({});
      await listItems({ category: 'coins' });
      assert.equal((await coinsOf()).length, 0, 'a plain read must not put them back');
      await seedMissing();                                    // …only asking does
      assert.equal((await coinsOf()).length, 3);
    });

    await check('and it is not open to anyone without the admin key', async () => {
      const res = await fetch(base + '/admin/shop/seed-missing', { method: 'POST' });
      assert.equal(res.status, 403);
    });
  } finally {
    server.close();
  }

  console.log(`[shopSeedMissing] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
