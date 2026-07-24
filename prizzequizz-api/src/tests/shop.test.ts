import { listItems, saveItem, getItem, removeItem } from '../services/shopService.js';

(async () => {
  let pass = 0, fail = 0; const ok = (n: boolean, m: string) => { n ? pass++ : (fail++, console.log('  x', m)); };

  // 1) seed populates the catalog on first read (memory driver)
  const seeded = await listItems();
  ok(seeded.length >= 10, 'catalog is seeded with the classic items');
  ok(seeded.every((i) => i.currency === 'cash'), 'seed items priced in cash');

  // 2) create a new item
  const it = await saveItem({ category: 'util', name: 'بوستر الماس', description: 'x2 سکه', price: 500, currency: 'coins', effectKey: 'coins', effectValue: 250, icon: '💎', sortOrder: 9, badge: 'جدید' });
  ok(!!it.id && it.name === 'بوستر الماس', 'item created');
  ok(it.currency === 'coins' && it.effectValue === 250, 'currency + effect value stored');

  // 3) it appears in listing + category filter
  const util = await listItems({ category: 'util' });
  ok(util.some((x) => x.id === it.id), 'item in its category');

  // 4) update it (price change)
  const upd = await saveItem({ id: it.id, category: 'util', name: it.name, price: 800 });
  ok(upd.price === 800, 'price updated');
  ok(upd.effectValue === 250, 'unspecified fields preserved on update');

  // 5) disable it → not in enabledOnly
  await saveItem({ id: it.id, category: 'util', name: it.name, enabled: false });
  const enabled = await listItems({ enabledOnly: true });
  ok(!enabled.some((x) => x.id === it.id), 'disabled item hidden from enabledOnly');

  // 6) getItem
  ok((await getItem(it.id))?.price === 800, 'getItem returns the item');

  // 7) delete
  ok(await removeItem(it.id), 'remove succeeds');
  ok(!(await getItem(it.id)), 'item gone after delete');

  // 8) name required
  let threw = false; try { await saveItem({ category: 'util', name: '' }); } catch { threw = true; }
  ok(threw, 'empty name rejected');

  console.log(`\nshop: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
