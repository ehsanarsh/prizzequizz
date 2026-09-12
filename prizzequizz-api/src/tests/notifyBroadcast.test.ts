/* SENDING A MESSAGE BY HAND FROM THE PANEL.
 *
 * «اعلان‌ها کار می‌کرد ولی الان اعلان رو از پنل دستی نمی‌فرسته، ولی اعلان‌های
 *  اتوماتیک بازی می‌ره.»
 *
 * Both go through the same `create`, so «automatic works, manual does not» can
 * only be something the manual path does differently: the TYPE it sends, the
 * audience it resolves, or a gate that lets a match update through and stops an
 * announcement.
 *
 * This drives the real service rather than reasoning about it, and reports what
 * actually reaches a device.
 *
 * Run: npx tsx src/tests/notifyBroadcast.test.ts */
import assert from 'node:assert/strict';
import { notifications } from '../services/notificationService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* A device that is actually listening, so «queued» and «sent» can be told
   apart — without a subscription every notification is queued and the whole
   question disappears. */
async function player(over: any = {}): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'n' + uid.slice(0, 8), displayName: 'n',
    phone: '09' + String(200000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0 }, ...over
  } as any);
  await repositories.notifications.saveSubscription({
    id: id(), userId: uid, endpoint: 'https://push.example/' + uid,
    keys: { p256dh: 'k', auth: 'a' }, createdAt: new Date().toISOString()
  } as any);
  return uid;
}

(async () => {
  await check('an automatic game notification reaches the player', async () => {
    const uid = await player();
    const r = await notifications.broadcast({ userIds: [uid], type: 'match_update', title: 'مسابقه', body: 'شروع شد', push: true });
    assert.equal(r.created, 1);
    assert.equal(r.skipped, 0, 'the automatic path is the one that is known to work');
  });

  await check('and a hand-written announcement reaches them too', async () => {
    /* The panel's own default type. Its label promises «همه دریافت می‌کنند». */
    const uid = await player();
    const r = await notifications.broadcast({ userIds: [uid], type: 'system', title: 'اطلاعیه', body: 'سلام', push: true });
    assert.equal(r.skipped, 0, 'an announcement was dropped before it was even created');
    assert.equal(r.created, 1);
  });

  await check('a PROMO is dropped for everybody, by default, silently', async () => {
    /* This is the one. Every account starts with promos OFF, so choosing
       «تبلیغی» in the panel sends to nobody at all — and the answer comes back
       as a success with a count, not as a refusal. */
    const uid = await player();
    const r = await notifications.broadcast({ userIds: [uid], type: 'promo', title: 'تخفیف', body: 'امروز', push: true });
    assert.equal(r.created, 0);
    assert.equal(r.skipped, 1);
  });

  await check('and the count that comes back says so rather than reading as sent', async () => {
    const uid = await player();
    const r = await notifications.broadcast({ userIds: [uid], type: 'promo', title: 'تخفیف', body: 'امروز', push: true });
    assert.equal(r.sent, 0, 'reporting a send here is what makes it look like the panel is broken');
  });

  await check('a player who turned promos ON does get them', async () => {
    const uid = await player();
    await repositories.notifications.savePreferences({
      userId: uid, matchUpdates: true, leaderboardUpdates: true, walletUpdates: true,
      promos: true, friendMessages: true, updatedAt: new Date().toISOString()
    } as any);
    const r = await notifications.broadcast({ userIds: [uid], type: 'promo', title: 'تخفیف', body: 'امروز', push: true });
    assert.equal(r.created, 1, 'an explicit opt-in must be honoured');
  });

  await check('quiet hours silence even an announcement', async () => {
    /* «عمومی/مهم (همه دریافت می‌کنند)» is what the panel calls this type, and
       quiet hours quietly contradict it. Worth knowing about before an operator
       wonders why a 2am announcement reached nobody. */
    const uid = await player();
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const from = new Date(now.getTime() - 3600_000), to = new Date(now.getTime() + 3600_000);
    await repositories.notifications.savePreferences({
      userId: uid, matchUpdates: true, leaderboardUpdates: true, walletUpdates: true,
      promos: true, friendMessages: true,
      quietHoursStart: p(from.getHours()) + ':' + p(from.getMinutes()),
      quietHoursEnd: p(to.getHours()) + ':' + p(to.getMinutes()),
      updatedAt: new Date().toISOString()
    } as any);
    const r = await notifications.broadcast({ userIds: [uid], type: 'system', title: 'مهم', body: 'خیلی مهم', push: true });
    assert.equal(r.skipped, 1);
  });

  await check('a broadcast to several reports each outcome separately', async () => {
    const a = await player(), b = await player();
    await repositories.notifications.savePreferences({
      userId: b, matchUpdates: true, leaderboardUpdates: true, walletUpdates: true,
      promos: true, friendMessages: true, updatedAt: new Date().toISOString()
    } as any);
    const r = await notifications.broadcast({ userIds: [a, b], type: 'promo', title: 'ت', body: 'ب', push: true });
    assert.equal(r.created, 1, 'only the one who opted in');
    assert.equal(r.skipped, 1, 'and the other has to be counted, not forgotten');
  });

  /* ── AND IT HAS TO SAY WHY ──────────────────────────────────────────
   * A count of skips that cannot explain itself is indistinguishable from a
   * broken button, which is exactly how this was reported. */

  await check('a skip says it was the setting, not the hour', async () => {
    const uid = await player();
    const r = await notifications.broadcast({ userIds: [uid], type: 'promo', title: 'ت', body: 'ب', push: true });
    assert.equal(r.skippedBy.preference, 1);
    assert.equal(r.skippedBy.quietHours, 0);
  });

  await check('and a quiet-hours skip says that instead', async () => {
    const uid = await player();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const now = Date.now();
    const from = new Date(now - 3600_000), to = new Date(now + 3600_000);
    await repositories.notifications.savePreferences({
      userId: uid, matchUpdates: true, leaderboardUpdates: true, walletUpdates: true,
      promos: true, friendMessages: true,
      quietHoursStart: p2(from.getHours()) + ':' + p2(from.getMinutes()),
      quietHoursEnd: p2(to.getHours()) + ':' + p2(to.getMinutes()),
      updatedAt: new Date().toISOString()
    } as any);
    const r = await notifications.broadcast({ userIds: [uid], type: 'system', title: 'م', body: 'ب', push: true });
    assert.equal(r.skippedBy.quietHours, 1);
    assert.equal(r.skippedBy.preference, 0, 'blaming the wrong thing sends the operator to the wrong setting');
  });

  await check('the two reasons are counted separately in one send', async () => {
    const offPromo = await player();
    const quiet = await player();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const from = new Date(Date.now() - 3600_000), to = new Date(Date.now() + 3600_000);
    await repositories.notifications.savePreferences({
      userId: quiet, matchUpdates: true, leaderboardUpdates: true, walletUpdates: true,
      promos: true, friendMessages: true,
      quietHoursStart: p2(from.getHours()) + ':' + p2(from.getMinutes()),
      quietHoursEnd: p2(to.getHours()) + ':' + p2(to.getMinutes()),
      updatedAt: new Date().toISOString()
    } as any);
    const r = await notifications.broadcast({ userIds: [offPromo, quiet], type: 'promo', title: 'ت', body: 'ب', push: true });
    assert.equal(r.skippedBy.preference, 1);
    assert.equal(r.skippedBy.quietHours, 1);
    assert.equal(r.created, 0);
  });

  await check('a delivery that worked reports nothing skipped', async () => {
    const uid = await player();
    const r = await notifications.broadcast({ userIds: [uid], type: 'system', title: 'م', body: 'ب', push: true });
    assert.equal(r.created, 1);
    assert.equal(r.skippedBy.preference + r.skippedBy.quietHours, 0);
  });

  console.log(`[notifyBroadcast] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
