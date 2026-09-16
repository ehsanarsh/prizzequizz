/* THE CHAT, AND HOW MUCH OF IT IS SHOWN.
 *
 * «کلی چت کردیم، تو بازی دیگه پیاممون نمی‌ره به هم.»
 *
 * The query behind that sentence read `ORDER BY created_at ASC LIMIT 200` —
 * the first two hundred messages ever exchanged. Under two hundred it looks
 * perfect. From the two hundred and first onwards the screen shows the START of
 * the conversation and every new message is invisible: saved, delivered, pushed
 * to the other phone, and never drawn. From the outside that is
 * indistinguishable from «my messages are not going through», which is what it
 * was reported as.
 *
 * It lived inline in a route handler, which is why nothing ever tested it. It
 * is here now so that it can be.
 */
import { getPgPool } from '../database/postgres.js';

function pool() { return getPgPool(); }

/** How many of the most recent messages a chat screen is given at once. */
export const CHAT_PAGE = 200;

export interface ChatMessage {
  id: string;
  mine: boolean;
  body: string;
  at: string | null;
  readAt: string | null;
}

export interface ChatPage {
  messages: ChatMessage[];
  /* HOW FAR THE OTHER PERSON HAS READ, as one timestamp rather than a flag on
   * every row. A poll asks only for what is NEW, so a per-row flag would never
   * arrive for a message sent an hour ago and read just now — and «سین شد» is
   * mostly about exactly those. One number covers the whole history: everything
   * of mine up to it has been seen. */
  readThrough: string | null;
}

/* A TIMESTAMP THAT CAN BE HANDED BACK.
 *
 * `at` is not only shown — the client sends the last one back as `after` to ask
 * «what has arrived since». So it has to survive the round trip exactly, and a
 * JavaScript Date does not: Postgres keeps microseconds and `toISOString()`
 * gives milliseconds, so 20:15:30.123456 comes back as 20:15:30.123 — which is
 * EARLIER than the message it came from. `created_at > '…123'` is then true for
 * that very message, and every poll returns the last message again, for ever.
 *
 * So the string is built by the database, at the precision the database stores,
 * and never passes through a Date on the way out. */
const AT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const iso = (v: any): string | null => (typeof v === 'string' ? v : (v?.toISOString?.() ?? (v ?? null)));

/**
 * The END of the conversation, in reading order — plus how far the other side
 * has read. `after` narrows it to what has arrived since, for polling.
 *
 * Reading the messages is also what marks the other person's as read, because
 * that is what «seen» means: it happened when they were put on the screen.
 */
export async function listChat(me: string, other: string, after?: string | null): Promise<ChatPage> {
  const params: any[] = [me, other];
  let where = `((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))`;
  if (after) { params.push(after); where += ` AND created_at > $3`; }
  /* Newest first to take the right end, then put back in reading order. */
  const { rows } = await pool().query(
    `SELECT id, sender_id, body, at, read_at FROM (
       SELECT id, sender_id, body, created_at, read_at, ${AT} AS at FROM friend_messages
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${CHAT_PAGE}
     ) t ORDER BY created_at ASC`, params);

  const seen = await pool().query(
    `SELECT ${AT} AS t FROM friend_messages
      WHERE sender_id=$1 AND recipient_id=$2 AND read_at IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [me, other]);

  /* Marking THEIR messages read and asking how far MY messages have been read
   * touch disjoint rows — one is `recipient_id = me`, the other `sender_id = me`
   * — so the order of these two is free. (It is written here after the read
   * because that is the order it happens in, not because anything depends on
   * it; an earlier comment claimed it did, and a mutation proved otherwise.) */
  await pool().query(
    `UPDATE friend_messages SET read_at=now()
      WHERE recipient_id=$1 AND sender_id=$2 AND read_at IS NULL`, [me, other]);

  return {
    messages: rows.map((r) => ({
      id: String(r.id), mine: String(r.sender_id) === String(me),
      body: r.body, at: iso(r.at), readAt: iso(r.read_at)
    })),
    readThrough: iso(seen.rows[0]?.t)
  };
}
