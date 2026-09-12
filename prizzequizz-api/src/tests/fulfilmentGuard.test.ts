/* THE GUARD THAT STOPS A PAID-FOR THING BEING HANDED OVER TWICE.
 *
 * A card-to-card gateway retries its callback until it is answered, and it
 * retries for a long time. So "the callback arrives twice" is the normal case,
 * not the failure case, and the only question is what stops the second one
 * granting a second ticket.
 *
 * The answer used to be a Set in the process's memory, which a deploy in the
 * middle of a retry run emptied. These tests hold the replacement to the three
 * things that actually cost money if they are wrong:
 *
 *   1. exactly one of N callers may deliver
 *   2. a delivery that FAILED must not burn the reference — the player paid
 *   3. a claim that is never settled must not wedge the payment shut forever
 *
 * Runs on whichever driver is configured: with a DATABASE_URL it exercises the
 * real INSERT ... ON CONFLICT; without one, the memory rules. The last block is
 * Postgres-only, because racing two callers is only meaningful there.
 *
 * Run: npx tsx src/tests/fulfilmentGuard.test.ts
 *      DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/fulfilmentGuard.test.ts */
import assert from 'node:assert/strict';
import {
  claimFulfilment, settleFulfilment, abandonFulfilment, _resetFulfilmentGuard,
  normaliseRef, leaseMs
} from '../services/fulfilmentGuard.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const driver = process.env.DATABASE_URL ? 'postgres' : 'memory';
const KEEP_LEASE = process.env.FULFILMENT_LEASE_MS;
const setLease = (v?: string) => { if (v === undefined) delete process.env.FULFILMENT_LEASE_MS; else process.env.FULFILMENT_LEASE_MS = v; };
const uniq = () => 'ref_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

(async () => {
  console.log(`[fulfilmentGuard] driver: ${driver}`);
  await _resetFulfilmentGuard();

  /* ── one delivery, one winner ──────────────────────────────────────── */

  await check('the first caller owns the delivery', async () => {
    const c = await claimFulfilment(uniq());
    assert.equal(c.fresh, true, 'nobody had it');
    assert.equal(c.payload, null, 'and nothing has been delivered yet');
  });

  await check('a second callback for the same payment is turned away', async () => {
    const ref = uniq();
    assert.equal((await claimFulfilment(ref)).fresh, true);
    const second = await claimFulfilment(ref);
    assert.equal(second.fresh, false, 'the duplicate must not deliver');
  });

  await check('and it is told what the first one handed over', async () => {
    const ref = uniq();
    await claimFulfilment(ref);
    await settleFulfilment(ref, [{ key: 'ticket-green', value: 2, label: 'بلیط سبز' }]);
    const again = await claimFulfilment(ref);
    assert.equal(again.fresh, false);
    assert.deepEqual(again.payload, [{ key: 'ticket-green', value: 2, label: 'بلیط سبز' }],
      'a duplicate must be able to show the same receipt, not an empty one');
  });

  await check('a settled reference stays settled however many times it is called', async () => {
    const ref = uniq();
    await claimFulfilment(ref);
    await settleFulfilment(ref, { n: 1 });
    for (let i = 0; i < 5; i++) assert.equal((await claimFulfilment(ref)).fresh, false, 'call ' + i);
  });

  await check('two different payments do not block each other', async () => {
    const a = uniq(), b = uniq();
    assert.equal((await claimFulfilment(a)).fresh, true);
    assert.equal((await claimFulfilment(b)).fresh, true, 'a different reference is a different payment');
  });

  /* ── a failed delivery must not burn the payment ───────────────────── */

  await check('abandoning lets a retry deliver after all', async () => {
    const ref = uniq();
    assert.equal((await claimFulfilment(ref)).fresh, true);
    await abandonFulfilment(ref);
    assert.equal((await claimFulfilment(ref)).fresh, true,
      'the player paid; a failed grant must not lock them out of their own purchase');
  });

  await check('but abandoning cannot un-do a delivery that succeeded', async () => {
    const ref = uniq();
    await claimFulfilment(ref);
    await settleFulfilment(ref, { granted: true });
    await abandonFulfilment(ref);
    const again = await claimFulfilment(ref);
    assert.equal(again.fresh, false, 'a late failure elsewhere must not re-open a settled delivery');
    assert.deepEqual(again.payload, { granted: true });
  });

  await check('abandoning something nobody claimed is harmless', async () => {
    await abandonFulfilment(uniq());
  });

  /* ── the lease: a crash must not wedge the payment shut ────────────── */

  await check('a claim inside its lease is respected', async () => {
    setLease('60000');
    const ref = uniq();
    await claimFulfilment(ref);
    assert.equal((await claimFulfilment(ref)).fresh, false, 'delivery is still in flight — do not race it');
    setLease(KEEP_LEASE);
  });

  await check('a claim that never settled is taken over once the lease expires', async () => {
    setLease('1000');
    const ref = uniq();
    await claimFulfilment(ref);
    await new Promise((r) => setTimeout(r, 1100));
    const retry = await claimFulfilment(ref);
    assert.equal(retry.fresh, true, 'a process killed mid-delivery must not leave a paying player with nothing');
    assert.equal(retry.recovered, true, 'and the takeover has to be visible — it means something crashed');
    setLease(KEEP_LEASE);
  });

  await check('a SETTLED claim is never taken over, however old it gets', async () => {
    setLease('1000');
    const ref = uniq();
    await claimFulfilment(ref);
    await settleFulfilment(ref, { granted: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await claimFulfilment(ref)).fresh, false, 'age is not a reason to deliver a second time');
    setLease(KEEP_LEASE);
  });

  await check('the lease has a sane default and refuses a silly one', () => {
    setLease(undefined); assert.equal(leaseMs(), 120_000, 'default');
    setLease('0'); assert.equal(leaseMs(), 120_000, 'zero would make every claim stealable');
    setLease('-5'); assert.equal(leaseMs(), 120_000, 'negative too');
    setLease('abc'); assert.equal(leaseMs(), 120_000, 'and nonsense');
    setLease('5000'); assert.equal(leaseMs(), 5000, 'a real value is honoured');
    setLease(KEEP_LEASE);
  });

  /* ── references ────────────────────────────────────────────────────── */

  await check('a blank reference is refused rather than shared', () => {
    assert.throws(() => normaliseRef(''));
    assert.throws(() => normaliseRef('   '));
    assert.throws(() => normaliseRef(undefined as any));
  });

  await check('a long reference is hashed, not truncated', () => {
    const a = 'intent:' + 'x'.repeat(400) + 'A';
    const b = 'intent:' + 'x'.repeat(400) + 'B';
    assert.notEqual(normaliseRef(a), normaliseRef(b),
      'truncating would let two different payments share one mark — the one thing this must never do');
    assert.ok(normaliseRef(a).startsWith('sha256:'));
    assert.ok(normaliseRef(a).length <= 200, 'and it still fits the column');
    assert.equal(normaliseRef(a), normaliseRef(a), 'and it is stable');
  });

  await check('a short reference is left exactly as it is', () => {
    assert.equal(normaliseRef('intent:abc-123'), 'intent:abc-123');
    assert.equal(normaliseRef('  vault:k1  '), 'vault:k1', 'surrounding space is not a second payment');
  });

  await check('a long reference still guards a real delivery end to end', async () => {
    const ref = 'intent:' + 'y'.repeat(500);
    assert.equal((await claimFulfilment(ref)).fresh, true);
    assert.equal((await claimFulfilment(ref)).fresh, false, 'hashed or not, it is still one payment');
  });

  /* ── payloads ──────────────────────────────────────────────────────── */

  await check('settling with nothing still marks the delivery done', async () => {
    const ref = uniq();
    await claimFulfilment(ref);
    await settleFulfilment(ref);
    const again = await claimFulfilment(ref);
    assert.equal(again.fresh, false, 'done is done, receipt or no receipt');
    assert.equal(again.payload, null);
  });

  await check('a receipt survives the round trip unchanged', async () => {
    const ref = uniq();
    const receipt = { itemId: 'hearts-5', price: 12000, granted: [{ key: 'heart', value: 5, label: 'قلب' }], duplicate: false };
    await claimFulfilment(ref);
    await settleFulfilment(ref, receipt);
    assert.deepEqual((await claimFulfilment(ref)).payload, receipt);
  });

  /* ── racing, which only Postgres can really be asked about ─────────── */

  if (driver === 'postgres') {
    await check('twenty simultaneous callbacks produce exactly one winner', async () => {
      const ref = uniq();
      const results = await Promise.all(Array.from({ length: 20 }, () => claimFulfilment(ref)));
      const winners = results.filter((r) => r.fresh).length;
      assert.equal(winners, 1, 'got ' + winners + ' winners — that is ' + winners + ' tickets for one payment');
    });

    await check('and twenty simultaneous takeovers of a dead claim produce one winner too', async () => {
      setLease('1000');
      const ref = uniq();
      await claimFulfilment(ref);
      await new Promise((r) => setTimeout(r, 1100));
      const results = await Promise.all(Array.from({ length: 20 }, () => claimFulfilment(ref)));
      const winners = results.filter((r) => r.fresh).length;
      assert.equal(winners, 1, 'a stale lease must be handed to one retry, not twenty');
      setLease(KEEP_LEASE);
    });

    await check('the mark outlives the process that wrote it', async () => {
      /* The whole point. A fresh pool is as close as a test gets to a restart:
         nothing of the first caller is left in memory, and the answer is still
         "already delivered". */
      const ref = uniq();
      await claimFulfilment(ref);
      await settleFulfilment(ref, { survived: true });
      const { closePgPool } = await import('../database/postgres.js');
      await closePgPool();
      const again = await claimFulfilment(ref);
      assert.equal(again.fresh, false, 'a restart mid-retry must not pay out a second time');
      assert.deepEqual(again.payload, { survived: true });
    });
  }

  setLease(KEEP_LEASE);
  if (process.env.DATABASE_URL) {
    await _resetFulfilmentGuard();
    const { closePgPool } = await import('../database/postgres.js');
    await closePgPool();
  }
  console.log(`[fulfilmentGuard] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
