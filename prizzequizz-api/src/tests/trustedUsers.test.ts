/* THE ACCOUNTS THE ANTI-CHEAT MUST LEAVE ALONE, AND CLEARING THE BACKLOG.
 *
 * «اکثر کاربران مشکوک برای خودمه که دارم تست میکنم» — the accounts playing
 * hardest before launch are the operator's own, and every thing that makes an
 * account look like a cheat is something a tester does on purpose: answering in
 * 200ms, answering the same question ten times, sharing one device.
 *
 * Two things are checked here, and the first matters more than it looks:
 *
 *   • a trusted account has NO SIGNAL WRITTEN for it — not written and then
 *     filtered. A filter leaves the table growing forever behind it, which is
 *     the «۲۰۰ سیگنال» problem with a nicer view on top.
 *   • the backlog can be closed in one go. «باید تک‌تک رسیدگی رو بزنی» was the
 *     complaint, and one at a time was never going to finish.
 */
import assert from 'node:assert/strict';
import { integrity } from '../services/integrityService.js';
import { isTrusted, listTrusted, trust, untrust, _resetTrusted } from '../services/trustedUserService.js';
import { repositories } from '../repositories/index.js';
import { suspiciousUsers } from '../services/adminOpsService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const U = 'trusted-tester-1';
const V = 'ordinary-player-2';

/** A signal of the shape the detectors produce, saved the way they save it. */
async function fireSignal(userId: string): Promise<void> {
  await integrity.recordReplay({ matchId: id(), userId, questionId: id(), idempotencyKey: id() });
}
const openFor = async (userId: string) =>
  (await repositories.integrity.list({ userId, status: 'open', limit: 500 } as any)).length;

async function run(): Promise<void> {
  _resetTrusted();

  await check('nobody is trusted to begin with', async () => {
    assert.equal(await isTrusted(U), false);
    assert.deepEqual(await listTrusted(), []);
  });

  await check('an ordinary player still gets flagged', async () => {
    await fireSignal(V);
    assert.ok(await openFor(V) >= 1, 'the detector stopped working');
  });

  /* THE POINT OF THE WHOLE FEATURE. */
  await check('a trusted account has no signal written for it at all', async () => {
    await trust(U, 'حساب تستِ خودم', 'admin1');
    const before = await openFor(U);
    await fireSignal(U);
    await fireSignal(U);
    assert.equal(await openFor(U), before, 'signals were still written for a trusted account');
  });

  await check('and it is written down who trusted them and why', async () => {
    const rows = await listTrusted();
    const me = rows.find((r) => r.userId === U)!;
    assert.equal(me.note, 'حساب تستِ خودم');
    assert.equal(me.addedBy, 'admin1');
  });

  await check('untrusting puts them back under the same rules as everybody', async () => {
    assert.equal(await untrust(U), true);
    assert.equal(await isTrusted(U), false);
    const before = await openFor(U);
    await fireSignal(U);
    assert.equal(await openFor(U), before + 1, 'an untrusted account is still being skipped');
  });

  await check('untrusting somebody who was never on the list is not an error', async () => {
    assert.equal(await untrust('nobody-at-all'), false);
  });

  await check('trusting one account does not quiet the others', async () => {
    await trust(U, '', 'admin1');
    const before = await openFor(V);
    await fireSignal(V);
    assert.equal(await openFor(V), before + 1, 'a different player stopped being watched');
  });

  // ── clearing the backlog ────────────────────────────────────────────────
  await check('every open signal can be closed in one call', async () => {
    await untrust(U);
    for (let i = 0; i < 5; i++) await fireSignal(V);
    for (let i = 0; i < 3; i++) await fireSignal(U);
    assert.ok(await openFor(V) >= 5);
    const n = await integrity.bulkUpdateStatus({ status: 'dismissed', reviewedBy: 'admin1' });
    assert.ok(n >= 8, `only ${n} were closed`);
    assert.equal(await openFor(V), 0, 'signals were left open');
    assert.equal(await openFor(U), 0);
  });

  await check('or only the ones belonging to one player', async () => {
    for (let i = 0; i < 4; i++) await fireSignal(V);
    for (let i = 0; i < 2; i++) await fireSignal(U);
    await integrity.bulkUpdateStatus({ status: 'dismissed', userId: U, reviewedBy: 'admin1' });
    assert.equal(await openFor(U), 0, 'the named player’s signals were not closed');
    assert.equal(await openFor(V), 4, 'somebody else’s signals were closed too');
  });

  await check('closing an already-empty backlog is a no-op, not an error', async () => {
    await integrity.bulkUpdateStatus({ status: 'dismissed', reviewedBy: 'admin1' });
    const n = await integrity.bulkUpdateStatus({ status: 'dismissed', reviewedBy: 'admin1' });
    assert.equal(n, 0);
  });

  /* The count in the panel's header is what makes «the signal moved to another
     user» make sense: it did not move, there were simply more than fitted. */
  await check('the open count is the real total, not the size of a page', async () => {
    for (let i = 0; i < 7; i++) await fireSignal(V);
    assert.equal(await integrity.openCount(), 7);
    assert.equal(await integrity.openCount(V), 7);
    assert.equal(await integrity.openCount(U), 0);
  });

  /* A page is capped at 500. The complaint was about a list that only ever
     showed part of the backlog, so «cleared» has to mean cleared — not «the
     first page is clear and the rest reappear on the next refresh». */
  await check('a backlog larger than one page is still cleared completely', async () => {
    await integrity.bulkUpdateStatus({ status: 'dismissed', reviewedBy: 'admin1' });
    for (let i = 0; i < 560; i++) await fireSignal(V);
    /* A read is capped at 500 too, so «more than a page» cannot be observed
       directly — a full page is the signal that there is a second one. */
    assert.equal(await openFor(V), 500, 'the fixture did not build a backlog worth testing');
    await integrity.bulkUpdateStatus({ status: 'dismissed', reviewedBy: 'admin1' });
    /* If the loop gave up after one page the leftover 60 are still open, and
       the operator who pressed «clear» would find them back on the next look. */
    assert.equal(await openFor(V), 0, 'signals past the first page were left open');
  });

  /* Signals recorded BEFORE an account was trusted are still on file. The
     operator marked it trusted so as to stop looking at it, so the list has to
     honour that too — not only the writer. */
  await check('an account trusted after the fact drops off the suspicious list', async () => {
    await untrust(U);
    await repositories.users.save({ id: U, phone: '0912' + Math.floor(Math.random() * 1e7),
      username: 'tester', displayName: 'تستر', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
      wallet: 0, coins: 0, hearts: 5, tickets: {} } as any);
    await fireSignal(U);
    const before = await suspiciousUsers();
    assert.ok(before.some((r: any) => r.userId === U), 'the fixture did not make them suspicious');

    await trust(U, 'حساب تست', 'admin1');
    const after = await suspiciousUsers();
    assert.ok(!after.some((r: any) => r.userId === U), 'a trusted account is still listed as suspicious');
  });

  console.log(`[trustedUsers] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
