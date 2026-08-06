/* HEARTS.
 *
 * They lived in the browser with a recharge clock the client ran itself, next
 * to a server count nothing reconciled — so the header could show five while
 * the server was sure there were none, and record mode refused entry to a
 * player staring at a full row. One balance now, on the server, refilling from
 * a timestamp so it is right across a closed app, a reboot, or two devices. */
import assert from 'node:assert/strict';
import { HeartError, addHearts, getHeartConfig, getHearts, saveHeartConfig, spendHearts, _resetHeartMemory, _setAnchor } from '../services/heartService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}
async function makeUser(hearts: number): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'h_' + userId.slice(0, 6),
    displayName: 'قلبی', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}
const HOUR = 3600_000;

async function run() {
  _resetHeartMemory();
  await saveHeartConfig({ max: 5, rechargeMinutes: 60 });

  await check('a full purse reports full and no countdown', async () => {
    const uid = await makeUser(5);
    const s = await getHearts(uid);
    assert.equal(s.hearts, 5);
    assert.equal(s.full, true);
    assert.equal(s.nextInMs, 0);
  });

  await check('time refills the purse', async () => {
    const uid = await makeUser(0);
    _setAnchor(uid, Date.now() - 3 * HOUR);
    assert.equal((await getHearts(uid)).hearts, 3, 'three hours, three hearts');
  });

  await check('regeneration stops at the cap', async () => {
    const uid = await makeUser(0);
    _setAnchor(uid, Date.now() - 99 * HOUR);
    assert.equal((await getHearts(uid)).hearts, 5, 'not ninety-nine');
  });

  await check('the leftover part of an hour is not thrown away', async () => {
    /* Anchoring to "now" on every read would restart the clock each time the
       player looked, and the next heart would never arrive. */
    const uid = await makeUser(0);
    _setAnchor(uid, Date.now() - (HOUR + 50 * 60_000));   // 1h50m
    const s = await getHearts(uid);
    assert.equal(s.hearts, 1);
    assert.ok(s.nextInMs <= 11 * 60_000, 'about ten minutes left, got ' + Math.round(s.nextInMs / 60000) + 'm');
  });

  await check('reading twice does not push the next heart further away', async () => {
    const uid = await makeUser(0);
    _setAnchor(uid, Date.now() - 30 * 60_000);
    const a = await getHearts(uid);
    await new Promise((r) => setTimeout(r, 40));
    const b = await getHearts(uid);
    assert.ok(b.nextInMs <= a.nextInMs, 'the countdown must not reset on a read');
  });

  await check('the purse persists — it is not the browser\'s', async () => {
    const uid = await makeUser(0);
    _setAnchor(uid, Date.now() - 2 * HOUR);
    await getHearts(uid);
    assert.equal(Number((await repositories.users.findById(uid))!.hearts), 2, 'written to the account');
  });

  await check('spending takes exactly what was asked', async () => {
    const uid = await makeUser(4);
    assert.equal((await spendHearts(uid, 1)).hearts, 3);
    assert.equal((await spendHearts(uid, 2)).hearts, 1);
  });

  await check('spending more than you have is refused, not floored', async () => {
    const uid = await makeUser(1);
    await assert.rejects(() => spendHearts(uid, 2),
      (e: any) => e instanceof HeartError && e.code === 'INSUFFICIENT_HEARTS');
    assert.equal((await getHearts(uid)).hearts, 1, 'and nothing was taken');
  });

  await check('spending from full starts the clock', async () => {
    const uid = await makeUser(5);
    const after = await spendHearts(uid, 1);
    assert.equal(after.hearts, 4);
    assert.ok(after.nextInMs > 55 * 60_000, 'a full hour ahead, got ' + Math.round(after.nextInMs / 60000) + 'm');
  });

  await check('spending while already below the cap does not delay the next one', async () => {
    const uid = await makeUser(0);
    _setAnchor(uid, Date.now() - 90 * 60_000);       // 1h30m: one heart, 30m to go
    const before = await getHearts(uid);
    const after = await spendHearts(uid, 1);
    assert.ok(after.nextInMs <= before.nextInMs + 1000, 'the wait must not restart');
  });

  await check('a purchase may exceed the free cap', async () => {
    const uid = await makeUser(5);
    const s = await addHearts(uid, 4);
    assert.equal(s.hearts, 9, 'bought hearts are not capped');
    assert.equal(s.full, true);
  });

  await check('a clock that ran backwards does not mint hearts', async () => {
    const uid = await makeUser(1);
    _setAnchor(uid, Date.now() + 100 * HOUR);
    assert.equal((await getHearts(uid)).hearts, 1);
  });

  await check('the panel can change the cap and the rate', async () => {
    await saveHeartConfig({ max: 3, rechargeMinutes: 15 });
    const cfg = await getHeartConfig();
    assert.equal(cfg.max, 3);
    assert.equal(cfg.rechargeMinutes, 15);
    const uid = await makeUser(0);
    _setAnchor(uid, Date.now() - 60 * 60_000);
    assert.equal((await getHearts(uid)).hearts, 3, 'four earned in an hour, capped at three');
    await saveHeartConfig({ max: 5, rechargeMinutes: 60 });
  });

  console.log(`[hearts] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
run();
