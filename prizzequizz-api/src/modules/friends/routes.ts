import type { Router } from '../../http/router.js';
import { json, error } from '../../http/response.js';
import { getPgPool } from '../../database/postgres.js';

// Real, DB-backed friends system: send request → accept/reject → friends list →
// 1:1 chat. All state lives in the `friendships` and `friend_messages` tables.
const pool = () => getPgPool();
const avatarFor = (username: string): string => {
  const pool = ['🦊', '🐼', '🦁', '🐯', '🐸', '🐵', '🦄', '🐧', '🐨', '🦉'];
  let h = 0; for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
  return pool[h % pool.length]!;
};

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
      json(ctx.res, 200, rows.map((r) => ({
        id: r.id, username: r.username, displayName: r.display_name || r.username, avatar: avatarFor(r.username),
        level: r.level, online: false, unread: Number(r.unread || 0),
        lastMessage: r.last_body || '', lastAt: r.last_at?.toISOString?.() ?? r.last_at ?? null
      })));
    } catch { json(ctx.res, 200, []); }
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
      const map = (r: any) => ({ id: r.id, userId: r.user_id, username: r.username, displayName: r.display_name || r.username, avatar: avatarFor(r.username), level: r.level, at: r.created_at?.toISOString?.() ?? r.created_at });
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
      const { rows } = await pool().query(`UPDATE friendships SET status='accepted', updated_at=now() WHERE id=$1 AND addressee_id=$2 AND status='pending' RETURNING id`, [ctx.params.id, me]);
      if (!rows[0]) return error(ctx.res, 404, 'NOT_FOUND', 'درخواستی پیدا نشد');
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
    } catch { error(ctx.res, 500, 'FRIEND_ERROR', 'خطا در ارسال پیام'); }
  });
}
