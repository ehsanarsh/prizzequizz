/* LIFELINES — two rules that must hold together:
 *   1. you own a stock, like tickets;
 *   2. in one match you may use each help once, however many you own.
 *
 * Getting either alone is what broke it before: the first release gated on the
 * stock and drained it, so a starting grant of one meant one use per ACCOUNT;
 * my first fix dropped the stock entirely, which made buying pointless. */
import assert from 'node:assert/strict';
import {
  LifelineError, LIFELINE_DEFAULTS, getCatalog, saveCatalog, activeCatalog,
  inventoryFor, grantLifeline, useLifeline, usedIn, _resetLifelineMemory
} from '../services/lifelineService.js';
import { repositories } from '../repositories/index.js';
import { postEntry, getAccount } from '../services/walletLedgerService.js';
import { purchaseLifeline } from '../services/lifelineService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function makeUser(): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'l_' + userId.slice(0, 6),
    displayName: 'بازیکن', plan: 'free', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}

async function run() {
  _resetLifelineMemory();
  await saveCatalog(LIFELINE_DEFAULTS);

  // ---- the catalogue is data ----
  await check('وقت اضافه ships in the catalogue with its seconds', async () => {
    const cat = await getCatalog();
    const t = cat.find((d) => d.key === 'ptime');
    assert.ok(t, 'the time-extension help must exist');
    assert.equal(t!.seconds, 8);
    assert.equal(t!.sellable, true);
    assert.equal(t!.awardable, true);
    assert.ok(t!.price > 0, 'it must have a shop price');
  });

  await check('the seconds it adds is admin-editable', async () => {
    const cat = await getCatalog();
    const next = cat.map((d) => d.key === 'ptime' ? { ...d, seconds: 15 } : d);
    await saveCatalog(next);
    assert.equal((await getCatalog()).find((d) => d.key === 'ptime')!.seconds, 15);
    await saveCatalog(cat);   // put it back
  });

  await check('every help can be priced, disabled and reordered from the panel', async () => {
    const cat = await getCatalog();
    await saveCatalog(cat.map((d) => d.key === 'pstats' ? { ...d, price: 99000, enabled: false, sortOrder: 9 } : d));
    const after = await getCatalog();
    const s = after.find((d) => d.key === 'pstats')!;
    assert.equal(s.price, 99000);
    assert.equal(s.enabled, false);
    assert.ok(!(await activeCatalog()).some((d) => d.key === 'pstats'), 'a disabled help is not offered');
    await saveCatalog(LIFELINE_DEFAULTS);
  });

  await check('a help added to the catalogue needs no migration', async () => {
    const cat = await getCatalog();
    await saveCatalog([...cat, { key: 'pskip', label: 'رد کردن سؤال', icon: '⏭️', description: '', enabled: true, startingGrant: 1, price: 5000, sellable: true, awardable: true, seconds: 0, sortOrder: 5 }]);
    const u = await makeUser();
    assert.equal((await inventoryFor(u)).pskip, 1, 'the new help appears with its starting grant');
    await saveCatalog(LIFELINE_DEFAULTS);
  });

  // ---- the stock is real ----
  await check('a new player starts with the configured grant', async () => {
    const u = await makeUser();
    const inv = await inventoryFor(u);
    assert.equal(inv.p5050, 2);
    assert.equal(inv.psecond, 1);
    assert.equal(inv.ptime, 2);
  });

  await check('buying ten shows ten', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'p5050', 10);
    assert.equal((await inventoryFor(u)).p5050, 12, '2 to start plus the 10 bought');
  });

  await check('using one takes exactly one off the stock', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'p5050', 8);      // 10 total
    const r = await useLifeline(u, 'p5050', 'match-A');
    assert.equal(r.remaining, 9);
    assert.equal((await inventoryFor(u)).p5050, 9);
  });

  await check('owning none is refused', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'psecond', -1);   // starts at 1, now 0
    await assert.rejects(() => useLifeline(u, 'psecond', 'match-B'), (e: any) => e instanceof LifelineError && e.code === 'LIFELINE_EMPTY');
  });

  // ---- once per match, whatever the stock ----
  await check('ten in stock still buys only one use in a match', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'p5050', 8);      // 10 total
    await useLifeline(u, 'p5050', 'match-C');
    await assert.rejects(() => useLifeline(u, 'p5050', 'match-C'),
      (e: any) => e instanceof LifelineError && e.code === 'LIFELINE_USED_THIS_MATCH');
    assert.equal((await inventoryFor(u)).p5050, 9, 'the refused second use must not cost anything');
  });

  await check('the next match opens it again', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'p5050', 8);
    await useLifeline(u, 'p5050', 'match-D1');
    const r = await useLifeline(u, 'p5050', 'match-D2');
    assert.equal(r.remaining, 8, 'two matches, two uses, two off the stock');
  });

  await check('a used help does not block the others in the same match', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'pstats', 1);
    await useLifeline(u, 'p5050', 'match-E');
    await useLifeline(u, 'pstats', 'match-E');
    await useLifeline(u, 'ptime', 'match-E');
    assert.deepEqual((await usedIn('match-E', u)).sort(), ['p5050', 'pstats', 'ptime']);
  });

  await check('one match cannot spend the stock down to nothing', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'p5050', 98);     // 100 total
    await useLifeline(u, 'p5050', 'match-F');
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => useLifeline(u, 'p5050', 'match-F'));
    }
    assert.equal((await inventoryFor(u)).p5050, 99, 'exactly one spent');
  });

  await check('the time help reports the seconds to add', async () => {
    const u = await makeUser();
    const r = await useLifeline(u, 'ptime', 'match-G');
    assert.equal(r.seconds, 8, 'the client is told how much time to add — it does not decide');
  });

  await check('a disabled help cannot be used even if owned', async () => {
    const u = await makeUser();
    const cat = await getCatalog();
    await saveCatalog(cat.map((d) => d.key === 'ptime' ? { ...d, enabled: false } : d));
    await assert.rejects(() => useLifeline(u, 'ptime', 'match-H'),
      (e: any) => e instanceof LifelineError && e.code === 'LIFELINE_DISABLED');
    await saveCatalog(LIFELINE_DEFAULTS);
  });

  await check('an unknown key is refused rather than invented', async () => {
    const u = await makeUser();
    await assert.rejects(() => useLifeline(u, 'pnope', 'match-I'),
      (e: any) => e instanceof LifelineError && e.code === 'LIFELINE_UNKNOWN');
    await assert.rejects(() => grantLifeline(u, 'pnope', 3));
  });

  await check('a use without a match is refused', async () => {
    const u = await makeUser();
    await assert.rejects(() => useLifeline(u, 'p5050', ''),
      (e: any) => e instanceof LifelineError && e.code === 'SCOPE_REQUIRED');
  });

  await check('two players do not share a match slot', async () => {
    const a = await makeUser(), b = await makeUser();
    await useLifeline(a, 'p5050', 'match-J');
    const r = await useLifeline(b, 'p5050', 'match-J');   // same match, other player
    assert.equal(r.remaining, 1);
  });

  await check('granting can also take away, and never goes negative', async () => {
    const u = await makeUser();
    await grantLifeline(u, 'p5050', -99);
    assert.equal((await inventoryFor(u)).p5050, 0);
  });

  // ---- buying, like a ticket ----
  const fund = async (userId: string, amount: number) =>
    /* Funded by WINNING, because that is now the only way money enters the
       صندوق جایزه — a deposit is refused at the ledger. */
    postEntry({ userId, entryType: 'match_reward', kind: 'credit', amount, idempotencyKey: 'fund:' + userId + ':' + amount });

  await check('buying charges the wallet and raises the count', async () => {
    const u = await makeUser();
    await fund(u, 500000);
    const r = await purchaseLifeline({ userId: u, key: 'p5050', qty: 10, idempotencyKey: 'buy1:' + u });
    assert.equal(r.qty, 10);
    assert.equal(r.price, 200000, '10 × 20,000');
    assert.equal(r.inventory.p5050, 12, '2 to start plus the 10 bought');
    assert.equal((await getAccount(u)).available, 300000, 'the money really left the wallet');
  });

  await check('the same purchase twice does not double-charge', async () => {
    const u = await makeUser();
    await fund(u, 100000);
    const key = 'buy2:' + u;
    await purchaseLifeline({ userId: u, key: 'ptime', qty: 1, idempotencyKey: key });
    const again = await purchaseLifeline({ userId: u, key: 'ptime', qty: 1, idempotencyKey: key });
    assert.equal(again.duplicate, true);
    assert.equal((await getAccount(u)).available, 85000, 'charged once at 15,000');
    assert.equal((await inventoryFor(u)).ptime, 3, 'granted once');
  });

  await check('buying without the money changes nothing', async () => {
    const u = await makeUser();
    await assert.rejects(() => purchaseLifeline({ userId: u, key: 'p5050', qty: 1, idempotencyKey: 'broke:' + u }));
    assert.equal((await inventoryFor(u)).p5050, 2, 'the stock must not move');
  });

  await check('a help marked not-for-sale cannot be bought', async () => {
    const u = await makeUser();
    await fund(u, 500000);
    const cat = await getCatalog();
    await saveCatalog(cat.map((d) => d.key === 'pstats' ? { ...d, sellable: false } : d));
    await assert.rejects(() => purchaseLifeline({ userId: u, key: 'pstats', qty: 1, idempotencyKey: 'ns:' + u }),
      (e: any) => e instanceof LifelineError && e.code === 'LIFELINE_NOT_FOR_SALE');
    await saveCatalog(LIFELINE_DEFAULTS);
  });

  await check('the price charged is the admin\'s, not the caller\'s', async () => {
    const u = await makeUser();
    await fund(u, 500000);
    const cat = await getCatalog();
    await saveCatalog(cat.map((d) => d.key === 'ptime' ? { ...d, price: 1000 } : d));
    const r = await purchaseLifeline({ userId: u, key: 'ptime', qty: 3, idempotencyKey: 'px:' + u });
    assert.equal(r.price, 3000);
    await saveCatalog(LIFELINE_DEFAULTS);
  });

  await check('bought helps are still one per match', async () => {
    const u = await makeUser();
    await fund(u, 500000);
    await purchaseLifeline({ userId: u, key: 'p5050', qty: 10, idempotencyKey: 'many:' + u });
    await useLifeline(u, 'p5050', 'match-K');
    await assert.rejects(() => useLifeline(u, 'p5050', 'match-K'),
      (e: any) => e instanceof LifelineError && e.code === 'LIFELINE_USED_THIS_MATCH');
    assert.equal((await inventoryFor(u)).p5050, 11, 'twelve owned, one spent');
  });

  console.log(`[lifelines] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
