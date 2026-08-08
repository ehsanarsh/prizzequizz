/* WHICH NOTIFICATIONS THE GAME IS ALLOWED TO SEND AT ALL.
 *
 * Players already have their own per-type preferences; this is the other side
 * of it — an operator switch for the whole game. It exists because an inbox
 * that fills up is not fixed by asking every player to go and turn things off
 * one by one.
 *
 * A type switched off here is never written to anybody's inbox and never
 * pushed. That is deliberate: gating only the push would leave the bell
 * filling up exactly as before, which is the complaint this answers.
 *
 * Everything is on by default, so an install that never visits this screen
 * behaves precisely as it did before.
 */
import { getPgPool } from '../database/postgres.js';
import type { NotificationType } from '../types/domain.js';

export const NOTIFICATION_TYPES: NotificationType[] = ['match_update', 'leaderboard_update', 'wallet_update', 'system', 'promo'];

/** What each switch covers, in the operator's language. */
export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  match_update: 'نتیجهٔ مسابقه و دوئل',
  leaderboard_update: 'تغییر رتبه و لیدربرد',
  wallet_update: 'کیف پول، برداشت و جایزه',
  system: 'پیام‌های سیستمی و پشتیبانی',
  promo: 'تبلیغات و پیشنهادها'
};

export interface NotificationPolicy {
  types: Record<string, boolean>;
}

export const DEFAULT_POLICY: NotificationPolicy = {
  types: NOTIFICATION_TYPES.reduce((a, t) => { a[t] = true; return a; }, {} as Record<string, boolean>)
};

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS notification_policy (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schemaReady = true;
}

let _mem: NotificationPolicy | null = null;

/* A missing or half-written row must not silently disable anything: any type
 * the stored data does not mention stays ON. Losing a notification is worse
 * than sending one the operator forgot to switch off. */
function withDefaults(raw: any): NotificationPolicy {
  const types: Record<string, boolean> = { ...DEFAULT_POLICY.types };
  const given = raw && typeof raw === 'object' ? raw.types : null;
  if (given && typeof given === 'object') {
    for (const t of NOTIFICATION_TYPES) if (given[t] === false) types[t] = false;
  }
  return { types };
}

export async function getPolicy(): Promise<NotificationPolicy> {
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(`SELECT data FROM notification_policy WHERE id='default'`);
      return withDefaults(rows[0]?.data);
    } catch { return { ...DEFAULT_POLICY, types: { ...DEFAULT_POLICY.types } }; }
  }
  if (!_mem) _mem = withDefaults(null);
  return _mem;
}

export async function setPolicy(patch: { types?: Record<string, boolean> }): Promise<NotificationPolicy> {
  const current = await getPolicy();
  const next: NotificationPolicy = { types: { ...current.types } };
  if (patch && patch.types && typeof patch.types === 'object') {
    for (const t of NOTIFICATION_TYPES) {
      if (Object.prototype.hasOwnProperty.call(patch.types, t)) next.types[t] = patch.types[t] !== false;
    }
  }
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO notification_policy(id,data,updated_at) VALUES ('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else {
    _mem = next;
  }
  return next;
}

/** Is this kind of notification allowed to be produced at all? */
export async function typeAllowed(type: NotificationType | string): Promise<boolean> {
  const p = await getPolicy();
  return p.types[String(type)] !== false;
}

/** Test seam. */
export function _resetPolicy(): void { _mem = null; _schemaReady = false; }
