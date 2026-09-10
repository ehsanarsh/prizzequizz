/* «SOON» IS NOT «OFF».
 *
 * `enabled: boolean` had to answer two different questions at once — may this
 * gateway take money, and is the player told it exists. They come apart the
 * moment a second way to pay is announced before it is ready: the operator
 * wants the bank gateway VISIBLE and unselectable while card-to-card carries
 * the traffic, and a boolean cannot say that.
 *
 * The dangerous half is the middle state. A gateway marked «به‌زودی» is
 * advertised, and if anything ever picks it to take a payment, the player is
 * sent to a door that does not open — with an order and an intent already
 * created behind them.
 *
 * Run: npx tsx src/tests/gatewayAvailability.test.ts
 */
import assert from 'node:assert/strict';
import {
  GATEWAY_TYPES, GATEWAY_AVAILABILITY, isAvailability,
  saveGateway, listGateways, removeGateway, pickActiveGateway, updatePaymentSettings
} from '../services/paymentGatewayService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** Clear the field so priority order is the only thing deciding. */
async function clearGateways(): Promise<void> {
  for (const g of await listGateways()) await removeGateway(g.id);
  await updatePaymentSettings({ defaultGatewayId: null });
}

async function run(): Promise<void> {
  await check('card-to-card is a gateway kind, not a system beside the registry', async () => {
    assert.ok((GATEWAY_TYPES as readonly string[]).includes('card_to_card'),
      'so it inherits priority, on/off, connection test and the per-gateway report');
  });

  await check('there are three states, and only three', async () => {
    assert.deepEqual([...GATEWAY_AVAILABILITY], ['live', 'coming_soon', 'hidden']);
    assert.equal(isAvailability('live'), true);
    assert.equal(isAvailability('coming_soon'), true);
    assert.equal(isAvailability('enabled'), false, 'the old boolean is not a state');
    assert.equal(isAvailability(true), false);
  });

  await check('a «به‌زودی» gateway is NEVER picked, even at priority 1', async () => {
    await clearGateways();
    await saveGateway({ name: 'بانکی (به‌زودی)', type: 'zibal', availability: 'coming_soon', priority: 1 });
    await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'live', priority: 50 });
    const picked = await pickActiveGateway();
    assert.equal(picked?.type, 'card_to_card',
      'priority orders the LIVE gateways; it cannot promote one that takes no money');
  });

  await check('nor is a hidden one', async () => {
    await clearGateways();
    await saveGateway({ name: 'پنهان', type: 'zibal', availability: 'hidden', priority: 1 });
    assert.equal(await pickActiveGateway(), null, 'no live gateway means no payment, not a silent fallback');
  });

  await check('a live gateway still wins by priority', async () => {
    await clearGateways();
    await saveGateway({ name: 'دوم', type: 'zibal', availability: 'live', priority: 20 });
    await saveGateway({ name: 'اول', type: 'card_to_card', availability: 'live', priority: 5 });
    assert.equal((await pickActiveGateway())?.name, 'اول');
  });

  await check('and the default gateway setting cannot promote a «به‌زودی» one either', async () => {
    await clearGateways();
    const soon = await saveGateway({ name: 'بانکی (به‌زودی)', type: 'zibal', availability: 'coming_soon', priority: 90 });
    await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'live', priority: 90 });
    await updatePaymentSettings({ defaultGatewayId: soon.id });
    const picked = await pickActiveGateway();
    assert.equal(picked?.type, 'card_to_card',
      'the default is a preference among the open doors, not a way past a closed one');
    await updatePaymentSettings({ defaultGatewayId: null });
  });

  await check('an unknown availability falls back to live rather than to nothing', async () => {
    await clearGateways();
    /* A row written by an older build, or a typo in a panel POST. Refusing to
     * pick ANY gateway would take payments down; treating it as live keeps the
     * money flowing and the wrong value is visible in the panel. */
    await saveGateway({ name: 'قدیمی', type: 'sandbox', availability: 'yes' as never, priority: 1 });
    assert.equal((await pickActiveGateway())?.name, 'قدیمی');
    assert.equal((await listGateways())[0]!.availability, 'live');
  });

  await check('editing a gateway without naming availability keeps the one it had', async () => {
    await clearGateways();
    const g = await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'coming_soon', priority: 7 });
    await saveGateway({ id: g.id, name: 'کارت به کارت (ویرایش‌شده)', type: 'card_to_card', priority: 8 });
    const after = (await listGateways()).find((x) => x.id === g.id)!;
    assert.equal(after.availability, 'coming_soon', 'a rename must not quietly open a closed door');
    assert.equal(await pickActiveGateway(), null);
  });

  /* ── the value that did NOT come through saveGateway ──────────────────
   * `saveGateway` normalises what the panel sends, so the guard in the row
   * mapper only ever sees values it did not write: a row from an older build,
   * or an operator's manual UPDATE. That is exactly when payments must not
   * stop, so it needs a row written behind the service's back. */
  if (process.env.DATABASE_URL) {
    await check('a value written straight into the table does not take payments down', async () => {
      await clearGateways();
      const { getPgPool } = await import('../database/postgres.js');
      const pool = getPgPool();
      await pool.query(
        `INSERT INTO payment_gateways(id,name,type,availability,sandbox,priority) VALUES ($1,$2,$3,$4,$5,$6)`,
        ['gw-legacy-' + Date.now(), 'ردیف قدیمی', 'sandbox', 'bogus', true, 1]);
      const listed = await listGateways();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.availability, 'live', 'an unreadable value reads as live, not as an unknown state');
      assert.ok(await pickActiveGateway(), 'and the door stays open rather than closing on a typo');
    });
  } else {
    console.log('  … the stored-value check needs DATABASE_URL');
  }

  await clearGateways();
  console.log(`[gatewayAvailability] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
