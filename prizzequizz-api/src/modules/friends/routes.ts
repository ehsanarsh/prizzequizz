import type { Router } from '../../http/router.js';
import { json, error } from '../../http/response.js';
import { getPgPool } from '../../database/postgres.js';
import { avatarUrlsFor } from '../../services/avatarService.js';
import { equippedCharactersFor } from '../../services/characterSelectionService.js';
import { recordSocial } from '../../services/missionService.js';
import { lastSeenFor, isOnline } from '../../services/presenceService.js';
import { notifications } from '../../services/notificationService.js';
import { repositories } from '../../repositories/index.js';
import { logger } from '../../services/logger.js';

/* A MESSAGE HAS TO REACH THE PHONE.
 *
 * Chat only ever wrote a row; the friend found out when they next opened the
 * game, which for a message is the same as not being told. It now goes out as
 * a real push — subject, as everything is, to the player's own switch and the
 * operator's game-wide one.
 *
 * A conversation is a burst, not a series of announcements: twenty messages in
 * a minute must not be twenty buzzes. One per sender per COALESCE_MS, and the
 * unread count in the app carries the rest. The window is per (sender →
 * recipient) so two different friends never silence each other.
 */
const COALESCE_MS = 60_000;
const lastPing = new Map<string, number>();
function shouldPing(from: string, to: string): boolean {
  const key = from + '>' + to;
  const now = Date.now();
  const prev = lastPing.get(key) ?? 0;
  if (now - prev < COALESCE_MS) return false;
  lastPing.set(key, now);
  /* The map is bounded by active conversations, but a long-running process
   * should not keep a row for a chat that ended last week. */
  if (lastPing.size > 5000) {
    for (const [k, t] of lastPing) if (now - t > COALESCE_MS * 10) lastPing.delete(k);
  }
  return true;
}
/** Test seam: forget the coalescing window. */
export function _resetChatPing(): void { lastPing.clear(); }

/* What the tray shows. A picture's URL is not a message anybody wants to read
 * on a lock screen, so it is described instead. */
function pushPreview(body: string): string {
  const t = String(body ?? '').trim();
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|bmp)(\?\S*)?$/i.test(t) || /^\/(uploads|media|img|images)\/\S+$/i.test(t)) return '📷 عکس فرستاد';
  return t.length > 120 ? t.slice(0, 117) + '…' : t;
}

// Real, DB-backed friends system: send request → accept/reject → friends list →
// 1:1 chat. All state lives in the `friendships` and `friend_messages` tables.
const pool = () => getPgPool();
/* No generated stand-in art: a player is their photo and their character, and
 * nothing else. When neither exists the client draws its own empty state. */

/* A friendship is mutual, so «اولین دوست» completes for BOTH sides the moment
 * the request is accepted — including the auto-accept path where two people
 * happened to request each other. Only an edge that really flipped to accepted
 * gets here, so a duplicate request cannot inflate the count. */
async function bothGainedAFriend(a: string, b: string): Promise<void> {
  await Promise.all([recordSocial(a, 'friendsAdded'), recordSocial(b, 'friendsAdded')]);
}

/* Sends the message on to the friend's phone. Never throws: a chat message is
 * saved either way, and a push service having a bad day must not turn a
 * delivered message into a 500. */
export async function notifyFriendOfMessage(from: string, to: string, body: string): Promise<boolean> {
  try {
    if (!from || !to || from === to) return false;
    if (!shouldPing(from, to)) return false;
    /* Through the repository, not a raw query: this has to work on the memory
     * store too, and a name lookup failing must never be the reason a friend
     * is not told they have a message. */
    const sender = await repositories.users.findById(from).catch(() => null);
    const name = sender?.displayName || sender?.username || 'یک دوست';
    const n = await notifications.create({
      userId: to,
      type: 'friend_message',
      title: String(name),
      body: pushPreview(body),
      /* Tapping it should land on the conversation, not the home screen. */
      data: { url: '/friends', friendId: String(from), kind: 'friend_message' }
    });
    return n.status === 'sent';
  } catch (e) {
    logger.warn('friend_message_notify_failed', { to, message: e instanceof Error ? e.message : 'unknown' });
    return false;
  }
}

export function registerFriendRoutes(router: Router, base: string): void {
  // Accepted friends of the current user (either direction), with unread counts.
  router.add('GET', `${base}/friends`, async (ctx) => {
    const me = ctx.userId; if (!me) return json(ctx.res, 200, []);
    try {
      const { rows } = await pool().query(
        `SELECT u.id, u.username, u.display_name, u.level,
                (SELECT count(*) FROM friend_messages m WHERE m.sender_id = u.id AND m.recipient_id = $1 AND m.read_at IS NULL) AS unread,
                (SELECT m.body FROM friend_messages m WHERE (m.sender_id = u.id AND m.recipient_id = $1) OR (m.sender_id = $1 AND m.recipient_id = u.id) ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                (SELECT m.created_at FROM friend_messages m WHERE (m.sender_id = u.id AND m.recipient_id = $1) OR (m.sender_id = $1 AND m.recipient_id = u.id) ORDER BY m.created_at DESC LIMIT 1) AS last_at
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
         WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)
         ORDER BY last_at DESC NULLS LAST, u.username`,
        [me]
      );
      const fids = rows.map((r) => String(r.id));
      /* `online` was the literal `false` for every friend since this endpoint
       * was written, so the green light could never come on for anybody. It is
       * now the real thing: presence is written by every authenticated request. */
      const [photos, characters, seen] = await Promise.all([
        avatarUrlsFor(fids), equippedCharactersFor(fids), lastSeenFor(fids)
      ]);
      json(ctx.res, 200, rows.map((r) => {
        const at = seen.get(String(r.id)) ?? null;
        return {
          id: r.id, username: r.username, displayName: r.display_name || r.username,
          avatar: photos.get(String(r.id)) ?? '', character: characters.get(String(r.id)) ?? null,
          level: r.level, online: isOnline(at), lastSeenAt: at ? at.toISOString() : null,
          unread: Number(r.unread || 0),
          lastMessage: r.last_body || '', lastAt: r.last_at?.toISOString?.() ?? r.last_at ?? null
        };
      }));
    } catch { json(ctx.res, 200, []); }
  });

  /* JUST THE NUMBERS BEHIND THE BADGES.
   *
   * The badge poller used to call GET /friends every thirty seconds, which
   * drags an avatar lookup, a character lookup and a presence lookup along for
   * two integers. This is the same information in one query, so the dot can be
   * kept honest everywhere in the app without that cost.
   *
   * `perFriend` is what lets the badge point at WHO: the nav shows the total,
   * the chat tab shows the messages, and each row shows its own count.
   */
  router.add('GET', `${base}/friends/summary`, async (ctx) => {
    const me = ctx.userId;
    const empty = { unread: 0, requests: 0, total: 0, perFriend: [] as Array<{ id: string; unread: number }> };
    if (!me) return json(ctx.res, 200, empty);
    try {
      const [msgs, reqs] = await Promise.all([
        pool().query(
          `SELECT sender_id, count(*)::int c FROM friend_messages
           WHERE recipient_id = $1 AND read_at IS NULL GROUP BY sender_id`, [me]),
        pool().query(`SELECT count(*)::int c FROM friendships WHERE addressee_id = $1 AND status = 'pending'`, [me])
      ]);
      const perFriend = msgs.rows.map((r: any) => ({ id: String(r.sender_id), unread: Number(r.c) || 0 }));
      const unread = perFriend.reduce((s, f) => s + f.unread, 0);
      const requests = Number(reqs.rows[0]?.c ?? 0) || 0;
      json(ctx.res, 200, { unread, requests, total: unread + requests, perFriend });
    } catch { json(ctx.res, 200, empty); }
  });

  // Incoming pending requests (I am the addressee) + my outgoing pending.
  router.add('GET', `${base}/friends/requests`, async (ctx) => {
    const me = ctx.userId; if (!me) return json(ctx.res, 200, { incoming: [], outgoing: [] });
    try {
      const inc = await pool().query(
        `SELECT f.id, u.id AS user_id, u.username, u.display_name, u.level, f.created_at
         FROM friendships f JOIN users u ON u.id = f.requester_id
         WHERE f.addressee_id = $1 AND f.status = 'pending' ORDER BY f.created_at DESC`, [me]);
      const out = await pool().query(
        `SELECT f.id, u.id AS user_id, u.username, u.display_name, u.level, f.created_at
         FROM friendships f JOIN users u ON u.id = f.addressee_id
         WHERE f.requester_id = $1 AND f.status = 'pending' ORDER BY f.created_at DESC`, [me]);
      const rids = [...inc.rows, ...out.rows].map((r: any) => String(r.user_id));
      const [photos, characters] = await Promise.all([avatarUrlsFor(rids), equippedCharactersFor(rids)]);
      const map = (r: any) => ({ id: r.id, userId: r.user_id, username: r.username, displayName: r.display_name || r.username,
        avatar: photos.get(String(r.user_id)) ?? '', character: characters.get(String(r.user_id)) ?? null,
        level: r.level, at: r.created_at?.toISOString?.() ?? r.created_at });
      json(ctx.res, 200, { incoming: inc.rows.map(map), outgoing: out.rows.map(map) });
    } catch { json(ctx.res, 200, { incoming: [], outgoing: [] }); }
  });

  // Send a friend request by username (or userId). Handles: self, unknown user,
  // already-friends, duplicate pending, and reverse-pending (auto-accept).
  router.add('POST', `${base}/friends/requests`, async (ctx) => {
    const me = ctx.userId; if (!me) return error(ctx.res, 401, 'UNAUTHENTICATED', 'ابتدا وارد شو');
    const body = (ctx.body ?? {}) as any;
    const rawUser = String(body.username ?? body.userId ?? body.to ?? '').trim().replace(/^@/, '');
    if (!rawUser) return error(ctx.res, 400, 'BAD_REQUEST', 'نام کاربری را وارد کن');
    try {
      const target = await pool().query('SELECT id, username, display_name FROM users WHERE lower(username) = lower($1) OR id::text = $1 LIMIT 1', [rawUser]);
      const t = target.rows[0];
      if (!t) return error(ctx.res, 404, 'USER_NOT_FOUND', 'کاربری با این نام پیدا نشد');
      if (String(t.id) === String(me)) return error(ctx.res, 400, 'SELF', 'نمی‌تونی برای خودت درخواست بفرستی');
      // Existing edge in either direction?
      const ex = await pool().query(
        `SELECT * FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1) LIMIT 1`, [me, t.id]);
      const e = ex.rows[0];
      if (e) {
        if (e.status === 'accepted') return error(ctx.res, 409, 'ALREADY_FRIENDS', 'شما از قبل دوست هستید');
        if (e.status === 'pending') {
          // If THEY already requested ME, accept it now (mutual → friends).
          if (String(e.requester_id) === String(t.id)) {
            await pool().query(`UPDATE friendships SET status='accepted', updated_at=now() WHERE id=$1`, [e.id]);
            await bothGainedAFriend(me, String(t.id));
            return json(ctx.res, 200, { status: 'accepted' });
          }
          return json(ctx.res, 200, { status: 'pending' }); // my duplicate request
        }
        // previously rejected → revive as a fresh pending request from me
        await pool().query(`UPDATE friendships SET requester_id=$1, addressee_id=$2, status='pending', updated_at=now() WHERE id=$3`, [me, t.id, e.id]);
        return json(ctx.res, 201, { status: 'pending' });
      }
      await pool().query(`INSERT INTO friendships(requester_id, addressee_id, status) VALUES($1,$2,'pending')`, [me, t.id]);
      json(ctx.res, 201, { status: 'pending', to: { id: t.id, username: t.username } });
    } catch (err) { error(ctx.res, 500, 'FRIEND_ERROR', 'خطا در ارسال درخواست'); }
  });

  // Accept / reject an incoming request (only the addressee may act).
  router.add('POST', `${base}/friends/requests/:id/accept`, async (ctx) => {
    const me = ctx.userId; if (!me) return error(ctx.res, 401, 'UNAUTHENTICATED', 'ابتدا وارد شو');
    try {
      const { rows } = await pool().query(`UPDATE friendships SET status='accepted', updated_at=now() WHERE id=$1 AND addressee_id=$2 AND status='pending' RETURNING id, requester_id`, [ctx.params.id, me]);
      if (!rows[0]) return error(ctx.res, 404, 'NOT_FOUND', 'درخواستی پیدا نشد');
      await bothGainedAFriend(me, String(rows[0].requester_id));
      json(ctx.res, 200, { status: 'accepted' });
    } catch { error(ctx.res, 500, 'FRIEND_ERROR', 'خطا'); }
  });
  router.add('POST', `${base}/friends/requests/:id/reject`, async (ctx) => {
    const me = ctx.userId; if (!me) return error(ctx.res, 401, 'UNAUTHENTICATED', 'ابتدا وارد شو');
    try {
      const { rows } = await pool().query(`UPDATE friendships SET status='rejected', updated_at=now() WHERE id=$1 AND addressee_id=$2 AND status='pending' RETURNING id`, [ctx.params.id, me]);
      if (!rows[0]) return error(ctx.res, 404, 'NOT_FOUND', 'درخواستی پیدا نشد');
      json(ctx.res, 200, { status: 'rejected' });
    } catch { error(ctx.res, 500, 'FRIEND_ERROR', 'خطا'); }
  });

  // Remove a friend (delete the edge in either direction).
  router.add('DELETE', `${base}/friends/:userId`, async (ctx) => {
    const me = ctx.userId; if (!me) return error(ctx.res, 401, 'UNAUTHENTICATED', 'ابتدا وارد شو');
    try {
      await pool().query(`DELETE FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)`, [me, ctx.params.userId]);
      json(ctx.res, 200, { removed: true });
    } catch { error(ctx.res, 500, 'FRIEND_ERROR', 'خطا'); }
  });

  // Chat: fetch the conversation with a friend (marks their messages read).
  router.add('GET', `${base}/friends/:userId/messages`, async (ctx) => {
    const me = ctx.userId; if (!me) return json(ctx.res, 200, { messages: [] });
    const other = ctx.params.userId!;
    try {
      const after = ctx.query.get('after');
      const params: any[] = [me, other];
      let where = `((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))`;
      if (after) { params.push(after); where += ` AND created_at > $3`; }
      const { rows } = await pool().query(`SELECT id, sender_id, body, created_at FROM friend_messages WHERE ${where} ORDER BY created_at ASC LIMIT 200`, params);
      // Mark the friend's messages to me as read.
      await pool().query(`UPDATE friend_messages SET read_at=now() WHERE recipient_id=$1 AND sender_id=$2 AND read_at IS NULL`, [me, other]);
      json(ctx.res, 200, { messages: rows.map((r) => ({ id: r.id, mine: String(r.sender_id) === String(me), body: r.body, at: r.created_at?.toISOString?.() ?? r.created_at })) });
    } catch { json(ctx.res, 200, { messages: [] }); }
  });

  // Chat: send a message to a friend (must be accepted friends).
  router.add('POST', `${base}/friends/:userId/messages`, async (ctx) => {
    const me = ctx.userId; if (!me) return error(ctx.res, 401, 'UNAUTHENTICATED', 'ابتدا وارد شو');
    const other = ctx.params.userId!;
    const text = String(((ctx.body ?? {}) as any).body ?? '').trim().slice(0, 800);
    if (!text) return error(ctx.res, 400, 'EMPTY', 'پیام خالی است');
    try {
      const fr = await pool().query(`SELECT 1 FROM friendships WHERE status='accepted' AND ((requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)) LIMIT 1`, [me, other]);
      if (!fr.rows[0]) return error(ctx.res, 403, 'NOT_FRIENDS', 'فقط با دوستان می‌تونی چت کنی');
      const { rows } = await pool().query(`INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES($1,$2,$3) RETURNING id, created_at`, [me, other, text]);
      json(ctx.res, 201, { id: rows[0].id, mine: true, body: text, at: rows[0].created_at?.toISOString?.() ?? rows[0].created_at });
      /* AFTER the reply, and never awaited: the person typing should not wait
       * on a push service, and a push that fails must not lose the message
       * that is already saved. */
      void notifyFriendOfMessage(me, other, text);
    } catch { error(ctx.res, 500, 'FRIEND_ERROR', 'خطا در ارسال پیام'); }
  });
}
