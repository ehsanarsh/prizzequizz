/* WHO IS ONLINE, AND DOES A CHAT MESSAGE REACH THE PHONE.
 *
 * Two things were missing from the friends system:
 *
 *   1. GET /friends returned the literal `online: false` for every friend, so
 *      the green light in the client could never come on for anybody. Presence
 *      is now looked up per-person.
 *   2. Sending a chat message only wrote a row. The friend found out the next
 *      time they happened to open the game, which for a message is the same as
 *      not being told.
 *
 * Run: npx tsx src/tests/friendPresenceAndChatPush.test.ts
 */
import assert from 'node:assert/strict';
import { lastSeenFor, isOnline, touchPresence, _resetPresence, _seed, ONLINE_MINUTES } from '../services/presenceService.js';
import { notifications } from '../services/notificationService.js';
import { setPolicy, _resetPolicy } from '../services/notificationPolicyService.js';
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
    id: uid, username: 'fp' + uid.slice(0, 8), displayName: 'fp',
    phone: '09' + String(300000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return uid;
}

const ago = (mins: number) => new Date(Date.now() - mins * 60_000);

async function run(): Promise<void> {
  _resetPresence(); _resetPolicy();

  /* ── who is here ────────────────────────────────────────────────────── */

  await check('somebody seen just now reads as online', async () => {
    _resetPresence();
    const a = await player();
    await touchPresence(a);
    const seen = await lastSeenFor([a]);
    assert.ok(seen.has(a), 'has a last-seen stamp');
    assert.equal(isOnline(seen.get(a)), true);
  });

  await check('somebody who has never opened the game is simply absent', async () => {
    _resetPresence();
    const a = await player();
    const seen = await lastSeenFor([a]);
    assert.equal(seen.has(a), false, 'no stamp at all');
    assert.equal(isOnline(seen.get(a)), false, 'and that reads as offline');
  });

  await check('the light goes out after the window, not before', async () => {
    _resetPresence();
    const a = await player(), b = await player();
    _seed(a, ago(ONLINE_MINUTES - 1));
    _seed(b, ago(ONLINE_MINUTES + 1));
    const seen = await lastSeenFor([a, b]);
    assert.equal(isOnline(seen.get(a)), true, 'inside the window: online');
    assert.equal(isOnline(seen.get(b)), false, 'outside it: offline');
  });

  await check('the write throttle cannot make a live player look offline', async () => {
    /* Presence is written at most once every 30s, so the "online" window has
       to be comfortably wider than that or a player who is right there would
       blink out between writes. */
    _resetPresence();
    const a = await player();
    await touchPresence(a);
    await touchPresence(a);              // throttled: no second write
    const seen = await lastSeenFor([a]);
    assert.equal(isOnline(seen.get(a)), true);
    assert.ok(ONLINE_MINUTES * 60_000 > 30_000 * 2, 'window is wider than two throttle periods');
  });

  await check('one lookup answers for a whole friends list', async () => {
    _resetPresence();
    const a = await player(), b = await player(), c = await player();
    _seed(a, ago(1)); _seed(c, ago(90));
    const seen = await lastSeenFor([a, b, c]);
    assert.deepEqual([isOnline(seen.get(a)), isOnline(seen.get(b)), isOnline(seen.get(c))], [true, false, false]);
  });

  await check('asking about nobody asks the database nothing', async () => {
    const seen = await lastSeenFor([]);
    assert.equal(seen.size, 0);
  });

  /* ── the message reaching the phone ─────────────────────────────────── */

  const { notifyFriendOfMessage, _resetChatPing } = await import('../modules/friends/routes.js');

  const inbox = async (uid: string) => (await notifications.list(uid, 100)).filter((n) => n.type === 'friend_message');

  await check('a chat message becomes a notification for the recipient', async () => {
    _resetChatPing();
    const from = await player(), to = await player();
    await notifyFriendOfMessage(from, to, 'سلام');
    const got = await inbox(to);
    assert.equal(got.length, 1, 'one notification');
    assert.equal(got[0]!.body, 'سلام', 'carrying the message');
  });

  await check('and it points back at the person who wrote it', async () => {
    _resetChatPing();
    const from = await player(), to = await player();
    await notifyFriendOfMessage(from, to, 'هستی؟');
    const got = await inbox(to);
    const n0 = got[0]!;
    assert.equal(n0.data.friendId, from, 'so tapping it opens THAT chat');
    assert.equal(n0.data.url, '/friends');
  });

  await check('the sender is not notified of their own message', async () => {
    _resetChatPing();
    const me = await player();
    await notifyFriendOfMessage(me, me, 'خودم');
    assert.equal((await inbox(me)).length, 0);
  });

  await check('a burst of messages is one buzz, not twenty', async () => {
    /* The point of the whole feature is that a friend hears about a message.
       The point of this is that a conversation does not become an alarm. */
    _resetChatPing();
    const from = await player(), to = await player();
    for (let i = 0; i < 20; i++) await notifyFriendOfMessage(from, to, 'پیام ' + i);
    assert.equal((await inbox(to)).length, 1, 'twenty messages, one notification');
  });

  await check('but two different friends never silence each other', async () => {
    _resetChatPing();
    const a = await player(), b = await player(), to = await player();
    await notifyFriendOfMessage(a, to, 'از الف');
    await notifyFriendOfMessage(b, to, 'از ب');
    assert.equal((await inbox(to)).length, 2, 'one from each');
  });

  await check('a photo is described, not pasted as a web address', async () => {
    _resetChatPing();
    const from = await player(), to = await player();
    await notifyFriendOfMessage(from, to, 'https://cdn.example/photos/cat.jpg');
    const got = await inbox(to);
    assert.equal(got[0]!.body, '📷 عکس فرستاد', 'a lock screen should not show a URL');
  });

  await check('a long message is trimmed rather than dumped whole', async () => {
    _resetChatPing();
    const from = await player(), to = await player();
    await notifyFriendOfMessage(from, to, 'ب'.repeat(400));
    const got = await inbox(to);
    const body = got[0]!.body;
    assert.ok(body.length <= 120, 'length ' + body.length);
    assert.ok(body.endsWith('…'), 'and says it was cut');
  });

  /* A player with no device registered can never have anything DELIVERED, so
     asserting "nothing was sent" against one proves nothing at all. Every
     delivery check below gives its player a phone first. */
  const withPhone = async () => {
    const uid = await player();
    await notifications.subscribe(uid, { endpoint: 'https://push.example/' + uid, keys: { p256dh: 'p', auth: 'a' } } as any, 'ua');
    return uid;
  };

  await check('with a phone registered, the message really is delivered', async () => {
    _resetChatPing();
    const from = await player(), to = await withPhone();
    await notifyFriendOfMessage(from, to, 'سلام');
    const got = await inbox(to);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.status, 'sent', 'it reached the device');
  });

  await check('a player who switched chat notifications off gets none', async () => {
    _resetChatPing();
    const from = await player(), to = await withPhone();
    await notifications.updatePreferences(to, { friendMessages: false } as any);
    await notifyFriendOfMessage(from, to, 'سلام');
    const got = await inbox(to);
    assert.equal(got.length, 1, 'still in their own inbox');
    assert.notEqual(got[0]!.status, 'sent', 'but never pushed to the phone');
  });

  await check('switching chat off does not silence their match alerts', async () => {
    const to = await withPhone();
    await notifications.updatePreferences(to, { friendMessages: false } as any);
    const n = await notifications.create({ userId: to, type: 'match_update', title: 'مسابقه', body: 'شروع شد' });
    assert.equal(n.status, 'sent', 'other categories still reach the phone');
  });

  await check('the other switches are untouched by that choice', async () => {
    const to = await player();
    await notifications.updatePreferences(to, { friendMessages: false } as any);
    const p = await notifications.preferences(to);
    assert.equal(p.friendMessages, false);
    assert.equal(p.matchUpdates, true, 'match updates still on');
    assert.equal(p.walletUpdates, true, 'wallet updates still on');
  });

  await check('chat notifications default to ON for an existing player', async () => {
    const to = await player();
    const p = await notifications.preferences(to);
    assert.equal(p.friendMessages, true, 'never seen the setting → still gets the message');
  });

  await check('the operator can switch chat notifications off game-wide', async () => {
    _resetChatPing(); _resetPolicy();
    const from = await player(), to = await player();
    await setPolicy({ types: { friend_message: false } });
    await notifyFriendOfMessage(from, to, 'سلام');
    assert.equal((await inbox(to)).length, 0, 'never created at all');
    _resetPolicy();
  });

  await check('and switching chat off leaves the other categories alone', async () => {
    _resetPolicy();
    await setPolicy({ types: { friend_message: false } });
    const to = await player();
    const n = await notifications.create({ userId: to, type: 'wallet_update', title: 'جایزه', body: 'واریز شد' });
    assert.notEqual(n.status, 'failed', 'a wallet notification still goes out');
    _resetPolicy();
  });

  await check('notifying never throws, whatever it is handed', async () => {
    _resetChatPing();
    await notifyFriendOfMessage('', 'nobody', 'x');
    await notifyFriendOfMessage('no-such-user', 'no-such-user-either', 'x');
    assert.ok(true, 'no exception escaped');
  });

  console.log(`[friendPresenceAndChatPush] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
