/* USERS THE ANTI-CHEAT MUST LEAVE ALONE.
 *
 * «اکثر کاربران مشکوک برای خودمه که دارم تست میکنم» — and that is not a quirk
 * of this deployment, it is what every game looks like before launch: the
 * accounts playing hardest are the operator's own. They answer in 200ms because
 * they are clicking through a flow, they answer the same question ten times
 * because they are testing that screen, and they share one device because there
 * is only one device. Every one of those is a real cheat signal and every one of
 * them is noise here.
 *
 * So a user can be marked trusted, and then:
 *
 *   1. NO NEW SIGNAL IS EVER WRITTEN for them. Not written and hidden — not
 *      written at all. Hiding would leave the table growing forever and the
 *      «۲۰۰ سیگنال» problem exactly where it was.
 *   2. Signals already on record stop counting them as suspicious.
 *
 * The check runs on every answer submitted by anybody, so it is served from a
 * small cached set rather than a query per answer, and the cache is dropped the
 * moment the list changes.
 */
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export interface TrustedUser {
  userId: string;
  note: string;
  addedBy: string;
  addedAt: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  if (!process.env.DATABASE_URL) return null;
  try { return getPgPool(); } catch { return null; }
}

let _schema: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  const pool = pg(); if (!pool) return;
  _schema ??= (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS trusted_users (
      user_id   TEXT PRIMARY KEY,
      note      TEXT NOT NULL DEFAULT '',
      added_by  TEXT NOT NULL DEFAULT '',
      added_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
  })().catch((e) => { _schema = null; throw e; });
  return _schema;
}

/** The memory-driver store, and the test seam. */
let _mem: Map<string, TrustedUser> | null = null;
function mem(): Map<string, TrustedUser> { _mem ??= new Map(); return _mem; }

/* The cache the hot path reads. Short-lived so a second server instance picks
 * up a change within the minute, and cleared outright on this instance's own
 * writes so the panel's «trust» button is felt immediately. */
let _set: Set<string> | null = null;
let _setAt = 0;
const TTL_MS = Number(process.env.TRUSTED_CACHE_MS ?? 30_000);
function invalidate(): void { _set = null; _setAt = 0; }

async function loadSet(): Promise<Set<string>> {
  if (_set && Date.now() - _setAt < TTL_MS) return _set;
  const pool = pg();
  if (!pool) { _set = new Set(mem().keys()); _setAt = Date.now(); return _set; }
  try {
    await ensureSchema();
    const { rows } = await pool.query(`SELECT user_id FROM trusted_users`);
    _set = new Set(rows.map((r: any) => String(r.user_id)));
  } catch (e) {
    /* A failure here must never make the game refuse an answer, and it must not
     * silently un-trust everybody either — the last known set is kept. */
    logger.warn('trusted_users_load_failed', { message: (e as Error).message });
    _set ??= new Set();
  }
  _setAt = Date.now();
  return _set;
}

/** Is this user exempt from anti-cheat? Cheap enough for the answer path. */
export async function isTrusted(userId: string): Promise<boolean> {
  const u = String(userId ?? ''); if (!u) return false;
  return (await loadSet()).has(u);
}

/** The same answer without waiting, for callers already holding the set. */
export function isTrustedCached(userId: string): boolean {
  return !!_set && _set.has(String(userId ?? ''));
}

export async function listTrusted(): Promise<TrustedUser[]> {
  const pool = pg();
  if (!pool) return [...mem().values()].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  await ensureSchema();
  const { rows } = await pool.query(`SELECT * FROM trusted_users ORDER BY added_at DESC`);
  return rows.map((r: any) => ({
    userId: String(r.user_id), note: String(r.note ?? ''), addedBy: String(r.added_by ?? ''),
    addedAt: r.added_at?.toISOString?.() ?? String(r.added_at)
  }));
}

export async function trust(userId: string, note = '', addedBy = ''): Promise<TrustedUser> {
  const u = String(userId ?? '').trim();
  if (!u) throw new Error('USER_ID_REQUIRED');
  const rec: TrustedUser = { userId: u, note: String(note ?? '').slice(0, 300), addedBy: String(addedBy ?? ''), addedAt: new Date().toISOString() };
  const pool = pg();
  if (!pool) { mem().set(u, rec); invalidate(); return rec; }
  await ensureSchema();
  await pool.query(
    `INSERT INTO trusted_users(user_id,note,added_by) VALUES($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET note=$2, added_by=$3, added_at=now()`,
    [u, rec.note, rec.addedBy]);
  invalidate();
  return rec;
}

export async function untrust(userId: string): Promise<boolean> {
  const u = String(userId ?? '').trim(); if (!u) return false;
  const pool = pg();
  if (!pool) { const had = mem().delete(u); invalidate(); return had; }
  await ensureSchema();
  const { rowCount } = await pool.query(`DELETE FROM trusted_users WHERE user_id=$1`, [u]);
  invalidate();
  return Number(rowCount) > 0;
}

/** Testing seam: forget everything, store and cache. */
export function _resetTrusted(): void { _mem = null; invalidate(); }
