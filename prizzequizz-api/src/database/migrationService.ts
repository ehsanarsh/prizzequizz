import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPgPool } from './postgres.js';

export interface MigrationStatusRow {
  version: string;
  applied: boolean;
  appliedAt?: string;
}

export interface DatabaseVerificationResult {
  ok: boolean;
  checkedAt: string;
  migrations: {
    configured: boolean;
    pending: number;
    applied: number;
    total: number;
    rows: MigrationStatusRow[];
  };
  tables: Array<{ table: string; ok: boolean; detail?: string }>;
  indexes: Array<{ index: string; ok: boolean; detail?: string }>;
}

const requiredTables = [
  'users', 'questions', 'matches', 'match_players', 'answers', 'transactions', 'rewards', 'match_events',
  'sessions', 'security_events', 'push_subscriptions', 'notification_preferences', 'notifications',
  'integrity_signals', 'devices', 'user_device_bindings', 'user_risk_profiles', 'reward_holds',
  'support_tickets', 'support_messages', 'character_items', 'user_character_inventory', 'character_unlock_events',
  'payment_intents', 'beta_invites', 'beta_access'
];

const requiredIndexes = [
  'idx_transactions_user_time',
  'idx_match_events_match_time',
  'idx_security_events_user_time',
  'idx_integrity_signals_user_time',
  'idx_devices_fingerprint',
  'idx_reward_holds_status_time',
  'idx_support_tickets_status_time',
  'idx_character_items_slot_status',
  'idx_payment_intents_status_time',
  'idx_beta_invites_status',
  'idx_beta_access_invite'
];

export function listMigrationFiles(): string[] {
  const dir = resolve(process.cwd(), 'database/migrations');
  return readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
}

export async function ensureMigrationTable(): Promise<void> {
  await getPgPool().query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text primary key, applied_at timestamp not null default now())`);
}

export async function getMigrationStatus(): Promise<MigrationStatusRow[]> {
  if (!process.env.DATABASE_URL) return [];
  await ensureMigrationTable();
  const files = listMigrationFiles();
  const { rows } = await getPgPool().query('select version, applied_at from schema_migrations');
  const applied = new Map<string, string>(rows.map((row: any) => [row.version, row.applied_at?.toISOString?.() ?? String(row.applied_at)]));
  return files.map((version) => ({ version, applied: applied.has(version), appliedAt: applied.get(version) }));
}

export async function applyPendingMigrations(): Promise<MigrationStatusRow[]> {
  if (!process.env.DATABASE_URL) return [];
  const pool = getPgPool();
  await ensureMigrationTable();
  const dir = resolve(process.cwd(), 'database/migrations');
  for (const file of listMigrationFiles()) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (done.rowCount) continue;
    const sql = readFileSync(resolve(dir, file), 'utf8');
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  return getMigrationStatus();
}

export async function verifyDatabase(): Promise<DatabaseVerificationResult> {
  const checkedAt = new Date().toISOString();
  if (!process.env.DATABASE_URL) {
    return {
      ok: true,
      checkedAt,
      migrations: { configured: false, pending: 0, applied: 0, total: 0, rows: [] },
      tables: requiredTables.map((table) => ({ table, ok: true, detail: 'DATABASE_URL not configured' })),
      indexes: requiredIndexes.map((index) => ({ index, ok: true, detail: 'DATABASE_URL not configured' }))
    };
  }

  const pool = getPgPool();
  const migrations = await getMigrationStatus();
  const tableRows = await pool.query(`select table_name from information_schema.tables where table_schema='public'`);
  const existingTables = new Set(tableRows.rows.map((row: any) => row.table_name));
  const indexRows = await pool.query(`select indexname from pg_indexes where schemaname='public'`);
  const existingIndexes = new Set(indexRows.rows.map((row: any) => row.indexname));
  const tables = requiredTables.map((table) => ({ table, ok: existingTables.has(table), detail: existingTables.has(table) ? undefined : 'missing' }));
  const indexes = requiredIndexes.map((index) => ({ index, ok: existingIndexes.has(index), detail: existingIndexes.has(index) ? undefined : 'missing' }));
  const pending = migrations.filter((row) => !row.applied).length;
  const applied = migrations.filter((row) => row.applied).length;
  const ok = pending === 0 && tables.every((table) => table.ok) && indexes.every((index) => index.ok);
  return { ok, checkedAt, migrations: { configured: true, pending, applied, total: migrations.length, rows: migrations }, tables, indexes };
}
