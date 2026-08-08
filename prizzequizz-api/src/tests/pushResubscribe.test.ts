/* OPENING THE GAME MUST NOT FILL THE INBOX.
 *
 * The browser re-registers its push subscription on every launch. Each
 * registration greeted the player with «اعلان‌ها فعال شد», so the inbox
 * collected one more copy every single time the game was opened — which is
 * exactly what was reported.
 *
 * Run: npx tsx src/tests/pushResubscribe.test.ts
 */
import assert from 'node:assert/strict';
import { notifications } from '../services/notificationService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function player(): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'ps' + uid.slice(0, 8), displayName: 'ps',
    phone: '09' + String(700000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return uid;
}

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p_' + endpoint, auth: 'a_' + endpoint } });
const enabledCount = async (uid: string) =>
  (await notifications.list(uid, 200)).filter((n) => n.title === 'اعلان‌ها فعال شد').length;

async function run(): Promise<void> {
  await check('the first time a device registers, it is announced once', async () => {
    const uid = await player();
    await notifications.subscribe(uid, sub('https://push.example/aaa') as any, 'ua');
    assert.equal(await enabledCount(uid), 1);
  });

  await check('opening the game again says nothing new', async () => {
    /* The heart of the report: same endpoint, same device, ten launches. */
    const uid = await player();
    for (let i = 0; i < 10; i++) {
      await notifications.subscribe(uid, sub('https://push.example/bbb') as any, 'ua');
    }
    assert.equal(await enabledCount(uid), 1, 'ten launches, one greeting');
  });

  await check('and the inbox does not grow at all across those launches', async () => {
    const uid = await player();
    await notifications.subscribe(uid, sub('https://push.example/ccc') as any, 'ua');
    const after1 = (await notifications.list(uid, 200)).length;
    for (let i = 0; i < 5; i++) await notifications.subscribe(uid, sub('https://push.example/ccc') as any, 'ua');
    assert.equal((await notifications.list(uid, 200)).length, after1, 'nothing was added');
  });

  await check('a genuinely different device IS announced', async () => {
    /* The message is worth saying once per device — silencing it entirely
       would hide the fact that a new phone started receiving alerts. */
    const uid = await player();
    await notifications.subscribe(uid, sub('https://push.example/phone-1') as any, 'ua');
    await notifications.subscribe(uid, sub('https://push.example/phone-2') as any, 'ua');
    assert.equal(await enabledCount(uid), 2, 'one per device');
  });

  await check('two players do not see each other’s greeting', async () => {
    const a = await player(), b = await player();
    await notifications.subscribe(a, sub('https://push.example/shared') as any, 'ua');
    assert.equal(await enabledCount(b), 0);
  });

  await check('the subscription itself is still saved on every launch', async () => {
    /* Skipping the notification must not skip the registration — the push
       endpoint has to stay current or the device stops receiving anything. */
    const uid = await player();
    for (let i = 0; i < 3; i++) await notifications.subscribe(uid, sub('https://push.example/keep') as any, 'ua');
    const subs = await repositories.notifications.listSubscriptions(uid);
    assert.ok(subs.some((s) => s.endpoint === 'https://push.example/keep'), 'still registered');
  });

  console.log(`[pushResubscribe] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
