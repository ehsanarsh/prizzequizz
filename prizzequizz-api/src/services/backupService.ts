/* DATABASE BACKUP — a full data export the owner can download to their own
 * machine and keep.
 *
 * Deliberately not a shell-out to pg_dump: that binary is not in the API
 * container, and running one would need a shell. This reads every table through
 * the pool and writes a single JSON document, which restores anywhere and stays
 * readable.
 *
 * It is written STREAMING, one page of rows at a time, and never holds the whole
 * dump in memory. A naive version that collected every table into an object and
 * then stringified it would peak at roughly three copies of the database — the
 * rows, the JSON string, and the buffer — which is enough to get the container
 * OOM-killed on a small machine, and an OOM-killed API is a 502 for every user,
 * not just the one who pressed the button. Peak memory here is one page.
 *
 * Access is the point of the feature: it is gated on a permission that only the
 * master admin holds by default, and which the owner can grant to a specific
 * account from the roles tab. */
import type { ServerResponse } from 'node:http';
import { getPgPool } from '../database/postgres.js';

/* Every table worth keeping. Anything missing in a given deployment is skipped
 * rather than failing the whole backup. */
export const BACKUP_TABLES = [
  'users', 'questions', 'matches', 'match_players', 'answers',
  'wallet_accounts', 'wallet_ledger', 'withdraw_requests', 'transactions',
  'company_expenses', 'shop_items', 'shop_purchases',
  'ls_rooms', 'ls_room_players', 'ls_answers', 'ls_config',
  'admin_accounts', 'app_config', 'ticket_promos', 'user_avatars',
  'friendships', 'friend_messages', 'support_tickets', 'support_messages',
  'notifications', 'notification_preferences', 'scheduled_notifications',
  'question_answer_stats', 'reward_holds', 'integrity_signals', 'security_events',
  'devices', 'user_device_bindings', 'user_risk_profiles',
  'payment_intents', 'monitor_servers', 'gift_codes', 'beta_invites', 'beta_access'
];

/** Rows read per round-trip. Small enough that one page is never a memory event. */
const PAGE = 2_000;
/** Hard cap per table, so one runaway log table can't make the file unusable. */
const MAX_ROWS_PER_TABLE = 200_000;

/** Wait for the socket to drain before queueing more, or a slow client turns a
 *  streaming export straight back into an in-memory one. */
function write(res: ServerResponse, chunk: string): Promise<void> {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise<void>((resolve) => res.once('drain', resolve));
}

export interface BackupSummary { tables: number; rows: number; skipped: string[] }

/**
 * Streams the whole dump into `res`. `meta` is written LAST — the totals are
 * only known once every table has been read, and key order is irrelevant to a
 * JSON parser.
 */
export async function streamBackup(res: ServerResponse): Promise<BackupSummary> {
  const generatedAt = new Date().toISOString();
  const skipped: string[] = [];
  let rows = 0;
  let tables = 0;

  let pool: ReturnType<typeof getPgPool> | null = null;
  try { pool = process.env.DATABASE_URL ? getPgPool() : null; } catch { pool = null; }

  await write(res, '{"data":{');

  if (pool) {
    let firstTable = true;
    for (const table of [...new Set(BACKUP_TABLES)]) {
      let opened = false;
      try {
        for (let offset = 0; offset < MAX_ROWS_PER_TABLE; offset += PAGE) {
          // Identifier is from our own constant list, never from user input.
          // Ordered by ctid so paging is stable without assuming a sort column.
          const r = await pool.query(
            `SELECT * FROM ${table} ORDER BY ctid LIMIT ${PAGE} OFFSET ${offset}`);

          if (!opened) {
            // Opened only after the first query succeeds, so a missing table
            // leaves no half-written key behind.
            await write(res, `${firstTable ? '' : ','}${JSON.stringify(table)}:[`);
            firstTable = false;
            opened = true;
            tables += 1;
          }
          for (let i = 0; i < r.rows.length; i++) {
            await write(res, (offset === 0 && i === 0 ? '' : ',') + JSON.stringify(r.rows[i]));
          }
          rows += r.rows.length;
          if (r.rows.length < PAGE) break;   // last page
        }
        if (opened) await write(res, ']');
      } catch {
        if (opened) await write(res, ']');   // keep the document well-formed
        else skipped.push(table);
      }
    }
  } else {
    skipped.push('no-database');
  }

  const meta = { generatedAt, app: 'prizzequizz', tables, rows, skipped };
  await write(res, `},"meta":${JSON.stringify(meta)}}`);
  return { tables, rows, skipped };
}

/** Filename the browser should save it under. */
export function backupFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `prizzequizz-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}
