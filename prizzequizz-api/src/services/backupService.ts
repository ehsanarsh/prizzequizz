/* DATABASE BACKUP — a full data export the owner can download to their own
 * machine and keep.
 *
 * Deliberately not a shell-out to pg_dump: that binary is not in the API
 * container, and running one would need a shell. This reads every table through
 * the pool and writes a single JSON document, which restores anywhere and stays
 * readable.
 *
 * Access is the point of the feature: it is gated on a permission that only the
 * master admin holds by default, and which the owner can grant to a specific
 * account from the roles tab. */
import { getPgPool } from '../database/postgres.js';

/* Every table worth keeping. Anything missing in a given deployment is skipped
 * rather than failing the whole backup. */
export const BACKUP_TABLES = [
  'users', 'questions', 'matches', 'match_players', 'answers',
  'wallet_accounts', 'wallet_ledger', 'withdraw_requests', 'transactions',
  'company_expenses', 'shop_items', 'shop_purchases', 'shop_purchases',
  'ls_rooms', 'ls_room_players', 'ls_answers', 'ls_config',
  'admin_accounts', 'app_config', 'ticket_promos', 'user_avatars',
  'friendships', 'friend_messages', 'support_tickets', 'support_messages',
  'notifications', 'notification_preferences', 'scheduled_notifications',
  'question_answer_stats', 'reward_holds', 'integrity_signals', 'security_events',
  'devices', 'user_device_bindings', 'user_risk_profiles',
  'payment_intents', 'monitor_servers', 'gift_codes', 'beta_invites', 'beta_access'
];

export interface BackupResult {
  meta: {
    generatedAt: string;
    app: string;
    tables: number;
    rows: number;
    skipped: string[];
  };
  data: Record<string, unknown[]>;
}

/** Rows can be huge; this caps each table so one runaway log can't blow memory. */
const MAX_ROWS_PER_TABLE = 200_000;

export async function buildBackup(): Promise<BackupResult> {
  const generatedAt = new Date().toISOString();
  const data: Record<string, unknown[]> = {};
  const skipped: string[] = [];
  let rows = 0;

  let pool: ReturnType<typeof getPgPool>;
  try { pool = getPgPool(); } catch {
    return { meta: { generatedAt, app: 'prizzequizz', tables: 0, rows: 0, skipped: ['no-database'] }, data };
  }

  for (const table of [...new Set(BACKUP_TABLES)]) {
    try {
      // Identifier is from our own constant list, never from user input.
      const r = await pool.query(`SELECT * FROM ${table} LIMIT ${MAX_ROWS_PER_TABLE}`);
      data[table] = r.rows;
      rows += r.rows.length;
    } catch {
      skipped.push(table);
    }
  }
  return { meta: { generatedAt, app: 'prizzequizz', tables: Object.keys(data).length, rows, skipped }, data };
}

/** Filename the browser should save it under. */
export function backupFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `prizzequizz-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}
