/* A SESSION THAT SURVIVES A RESTART.
 *
 * «هرموقع برنامه رو می‌بندی دوباره کد می‌خواد… این‌طوری نبودا، جدیداً شد.»
 *
 * This kept every session in a plain Map:
 *
 *     const sessions = new Map<string, SessionRecord>();
 *
 * and `refreshSession` refused any token it could not find there. A Map lives
 * in the process. So every time the API restarted, every refresh token in the
 * world stopped working at once — the JWT itself still had weeks left and was
 * signed by us, but the server had forgotten it existed, answered 401, and the
 * app did the only correct thing with a 401: asked the player to log in again.
 *
 * And what restarts the API? Every deploy. That is why it «started recently»:
 * nothing about the session code changed, the deploys got frequent.
 *
 * So the record lives in Postgres now, and the Map is kept only as the
 * same-process fast path and as the whole store when there is no database
 * (tests, the memory driver).
 *
 * ADOPTING WHAT CAME BEFORE. After this change the table is empty, so every
 * session issued before it would still be refused — the very logout this is
 * meant to end, one last time, for everybody. A refresh token that we signed,
 * has not expired, and is not on record as REVOKED is therefore adopted: a row
 * is written for it and it carries on. Nothing is weakened by that — those
 * revocations were in the Map that the restart already destroyed — and from
 * this deploy forward a revocation is permanent, because it is a row.
 */
import { id } from '../utils/id.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokenService.js';
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export interface SessionRecord {
  id: string;
  userId: string;
  refreshJti: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}

/* The same-process cache. Not the record — the record is the row. */
const sessions = new Map<string, SessionRecord>();

function pg() { try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; } }

let _ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  const pool = pg();
  if (!pool) return Promise.resolve();
  if (!_ready) {
    /* Created at runtime rather than by a migration: the server is deployed as
       a built `dist/` and migrations do not travel with it, so a table that
       only exists in a migration file is a table that never exists. */
    _ready = pool.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        refresh_jti TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        revoked_at BIGINT
      )`)
      .then(() => pool.query(`CREATE INDEX IF NOT EXISTS ix_auth_sessions_user ON auth_sessions(user_id)`))
      .then(() => undefined)
      .catch((e) => { _ready = null; logger.warn('auth_sessions_schema_failed', { message: e instanceof Error ? e.message : 'unknown' }); });
  }
  return _ready;
}

/* Writing the row does not hold up the login. A player waiting on a database
 * insert to be told their code was right is a player watching a spinner for
 * something that has already happened; if the write fails, the Map still has
 * it and this process can still refresh. */
function persist(rec: SessionRecord): void {
  const pool = pg(); if (!pool) return;
  void ensureSchema()
    .then(() => pool.query(
      `INSERT INTO auth_sessions(id, user_id, refresh_jti, created_at, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,NULL) ON CONFLICT (refresh_jti) DO NOTHING`,
      [rec.id, rec.userId, rec.refreshJti, Date.parse(rec.createdAt), Date.parse(rec.expiresAt)]))
    .catch((e) => logger.warn('auth_session_persist_failed', { message: e instanceof Error ? e.message : 'unknown' }));
}

export function createSession(userId: string, role: 'user' | 'admin' = 'user'): { accessToken: string; refreshToken: string; sessionId: string } {
  const accessToken = signAccessToken(userId, role);
  const refreshToken = signRefreshToken(userId, role);
  const payload = verifyRefreshToken(refreshToken)!;
  const sessionId = id();
  const rec: SessionRecord = {
    id: sessionId,
    userId,
    refreshJti: payload.jti,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString()
  };
  sessions.set(sessionId, rec);
  persist(rec);
  return { accessToken, refreshToken, sessionId };
}

/** Mark a jti spent, in both places. */
async function revoke(jti: string): Promise<void> {
  for (const s of sessions.values()) if (s.refreshJti === jti && !s.revokedAt) s.revokedAt = new Date().toISOString();
  const pool = pg(); if (!pool) return;
  await ensureSchema();
  await pool.query(`UPDATE auth_sessions SET revoked_at=$2 WHERE refresh_jti=$1 AND revoked_at IS NULL`, [jti, Date.now()])
    .catch((e) => logger.warn('auth_session_revoke_failed', { message: e instanceof Error ? e.message : 'unknown' }));
}

/** Has this jti been explicitly revoked? Unknown is NOT revoked. */
async function revokedOnRecord(jti: string): Promise<boolean> {
  for (const s of sessions.values()) if (s.refreshJti === jti && s.revokedAt) return true;
  const pool = pg(); if (!pool) return false;
  try {
    await ensureSchema();
    const { rows } = await pool.query(`SELECT revoked_at FROM auth_sessions WHERE refresh_jti=$1`, [jti]);
    if (!rows[0]) return false;                       // no row at all — see «adopting» above
    return rows[0].revoked_at != null;
  } catch { return false; }
}

export async function refreshSession(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; sessionId: string } | null> {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return null;                          // not ours, or expired — that IS an answer
  if (await revokedOnRecord(payload.jti)) return null; // used once already, or logged out
  /* Spent before the new one is minted, so a token replayed twice in the same
     breath cannot produce two live sessions. */
  await revoke(payload.jti);
  return createSession(payload.sub, payload.role ?? 'user');
}

export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return false;
  if (await revokedOnRecord(payload.jti)) return false;
  await revoke(payload.jti);
  return true;
}

/** Rows for tokens that have expired anyway. Housekeeping, not security. */
export async function pruneExpiredSessions(): Promise<number> {
  const pool = pg(); if (!pool) return 0;
  try {
    await ensureSchema();
    const { rowCount } = await pool.query(`DELETE FROM auth_sessions WHERE expires_at < $1`, [Date.now()]);
    return rowCount ?? 0;
  } catch { return 0; }
}

/** Test seam. */
export function _resetSessions(): void { sessions.clear(); _ready = null; }
