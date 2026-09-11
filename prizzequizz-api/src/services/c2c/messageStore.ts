/* THE RAW MESSAGES.
 *
 * One row per SMS the forwarder sent — or, until it exists, per message an
 * operator pasted in. Kept even when nothing could be parsed out of them,
 * because an unparsed message is not noise: it is real money that arrived
 * and the exact sample needed to write the pattern that would have read it.
 *
 * TWO THINGS NEVER REACH THIS TABLE:
 *
 * 1. Anything that looks like a credential — رمز پویا, a verification code,
 *    CVV2. Dropped whole, before any row exists. See `smsSensitive`.
 * 2. A message already stored. `(device_id, message_id)` is unique, which is
 *    the ONLY defence against a forwarder that retries its queue: three of
 *    the operator's four banks print no tracking code, so there is nothing
 *    else in the text to tell two identical deposits apart.
 */
import { getPgPool } from '../../database/postgres.js';
import { id } from '../../utils/id.js';

export const MESSAGE_STATUSES = ['PARSED', 'PARSE_FAILED', 'IGNORED'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export interface BankSmsMessage {
  id: string;
  deviceId: string;
  /** The device's own id for this SMS — the dedupe key with `deviceId`. */
  messageId: string;
  sender: string;
  body: string;
  receivedAt: string;
  status: MessageStatus;
  patternId: string | null;
  transactionId: string | null;
  note: string;
  createdAt: string;
}

export class MessageError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'MessageError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
export async function ensureMessageSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_sms_messages (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL DEFAULT 'manual',
      message_id TEXT NOT NULL,
      sender TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'PARSE_FAILED',
      pattern_id TEXT,
      transaction_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS bank_sms_dedupe ON bank_sms_messages(device_id, message_id);
    CREATE INDEX IF NOT EXISTS bank_sms_status_time ON bank_sms_messages(status, received_at DESC);
  `);
  _schemaReady = true;
}

const mem = new Map<string, BankSmsMessage>();

function rowToMessage(r: any): BankSmsMessage {
  return {
    id: r.id,
    deviceId: r.device_id ?? 'manual',
    messageId: r.message_id,
    sender: r.sender ?? '',
    body: r.body ?? '',
    receivedAt: r.received_at?.toISOString?.() ?? String(r.received_at),
    status: (MESSAGE_STATUSES as readonly string[]).includes(r.status) ? r.status : 'PARSE_FAILED',
    patternId: r.pattern_id ?? null,
    transactionId: r.transaction_id ?? null,
    note: r.note ?? '',
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at)
  };
}

export interface NewMessage {
  deviceId?: string;
  messageId: string;
  sender?: string;
  body: string;
  receivedAt?: string;
}

/**
 * Store a message, or report that it was already stored.
 *
 * Returns null for a duplicate rather than throwing: a forwarder replaying its
 * offline queue is doing the right thing, and the answer it needs is «already
 * have it, drop it from your queue», not an error.
 */
export async function insertMessage(input: NewMessage): Promise<BankSmsMessage | null> {
  const now = new Date().toISOString();
  const msg: BankSmsMessage = {
    id: id(),
    deviceId: (input.deviceId ?? 'manual').trim() || 'manual',
    messageId: String(input.messageId ?? '').trim(),
    sender: (input.sender ?? '').trim(),
    body: String(input.body ?? ''),
    receivedAt: input.receivedAt ?? now,
    status: 'PARSE_FAILED',
    patternId: null,
    transactionId: null,
    note: '',
    createdAt: now
  };
  if (!msg.messageId) throw new MessageError('MESSAGE_ID_REQUIRED', 'شناسهٔ پیام لازم است.');

  const pool = pg();
  if (pool) {
    await ensureMessageSchema(pool);
    const { rows } = await pool.query(
      `INSERT INTO bank_sms_messages(id,device_id,message_id,sender,body,received_at,status,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (device_id, message_id) DO NOTHING RETURNING *`,
      [msg.id, msg.deviceId, msg.messageId, msg.sender, msg.body, msg.receivedAt, msg.status, now]);
    return rows[0] ? rowToMessage(rows[0]) : null;
  }
  for (const m of mem.values()) {
    if (m.deviceId === msg.deviceId && m.messageId === msg.messageId) return null;
  }
  mem.set(msg.id, msg);
  return { ...msg };
}

export async function updateMessage(msgId: string, patch: Partial<Pick<BankSmsMessage, 'status' | 'patternId' | 'transactionId' | 'note'>>): Promise<BankSmsMessage | null> {
  const pool = pg();
  if (pool) {
    await ensureMessageSchema(pool);
    const { rows } = await pool.query(
      `UPDATE bank_sms_messages SET
         status = COALESCE($2, status),
         pattern_id = COALESCE($3, pattern_id),
         transaction_id = COALESCE($4, transaction_id),
         note = COALESCE($5, note)
       WHERE id=$1 RETURNING *`,
      [msgId, patch.status ?? null, patch.patternId ?? null, patch.transactionId ?? null, patch.note ?? null]);
    return rows[0] ? rowToMessage(rows[0]) : null;
  }
  const m = mem.get(msgId);
  if (!m) return null;
  Object.assign(m, patch);
  return { ...m };
}

export async function getMessage(msgId: string): Promise<BankSmsMessage | null> {
  const pool = pg();
  if (pool) {
    await ensureMessageSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM bank_sms_messages WHERE id=$1`, [msgId]);
    return rows[0] ? rowToMessage(rows[0]) : null;
  }
  const m = mem.get(msgId);
  return m ? { ...m } : null;
}

export async function listMessages(filter: { status?: MessageStatus; limit?: number } = {}): Promise<BankSmsMessage[]> {
  const limit = Math.max(1, Math.min(500, Number(filter.limit ?? 100)));
  const pool = pg();
  if (pool) {
    await ensureMessageSchema(pool);
    const where = filter.status ? 'WHERE status=$1' : '';
    const params = filter.status ? [filter.status, limit] : [limit];
    const { rows } = await pool.query(
      `SELECT * FROM bank_sms_messages ${where} ORDER BY received_at DESC LIMIT $${params.length}`, params);
    return rows.map(rowToMessage);
  }
  return [...mem.values()]
    .filter((m) => !filter.status || m.status === filter.status)
    .sort((a, b) => (a.receivedAt > b.receivedAt ? -1 : 1))
    .slice(0, limit);
}

/**
 * Forget the words, keep the fact.
 *
 * A bank SMS is not just «a deposit arrived»: it prints the operator's account
 * number and their running balance, in full, in every message. Once the figure
 * has been read into a transaction the sentence has no further job, and a
 * table of them is a standing liability that grows every day.
 *
 * The ROW stays — status, which pattern read it, which transaction it became —
 * so the audit trail is intact and a deposit can still be traced back to the
 * message that reported it. Only the text goes.
 *
 * An unparsed message is the exception that proves the rule: its text is the
 * raw material for the pattern that would have read it, so the window is also
 * the deadline for writing that pattern. The panel says so.
 */
export async function purgeOldBodies(olderThanDays: number): Promise<number> {
  const days = Math.max(1, Math.floor(olderThanDays));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const pool = pg();
  if (pool) {
    await ensureMessageSchema(pool);
    const { rowCount } = await pool.query(
      `UPDATE bank_sms_messages SET body = '', note = CASE WHEN note = '' THEN $2 ELSE note END
        WHERE body <> '' AND received_at < $1`, [cutoff, PURGED_NOTE]);
    return rowCount ?? 0;
  }
  let n = 0;
  for (const m of mem.values()) {
    if (m.body && m.receivedAt < cutoff) {
      m.body = '';
      if (!m.note) m.note = PURGED_NOTE;
      n++;
    }
  }
  return n;
}

/* Left behind so an empty body reads as «deliberately cleared» rather than
 * «arrived empty», which are very different things to find in a queue. */
export const PURGED_NOTE = 'متن خام پس از دورهٔ نگهداری پاک شد';

/** Test seam. */
export function _resetMessages(): void { mem.clear(); _schemaReady = false; }
