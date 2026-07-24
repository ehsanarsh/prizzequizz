/* ADMIN ACCOUNTS + per-tab permissions.
 * The owner (env ADMIN_KEY, the master) can create named admin accounts, each
 * with a password and a hand-picked set of panel tabs it may access. Login
 * returns a session token that the panel sends as x-admin-key; requireAdmin
 * resolves it to the account and enforces the tab permission for the request.
 * Postgres-backed with a memory fallback. Passwords are salted+hashed (scrypt).*/
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface AdminAccount {
  id: string;
  username: string;
  perms: string[];          // list of allowed tab keys, or ['*'] for all
  isOwner: boolean;
  active: boolean;
  token: string;            // session credential (x-admin-key)
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

function hashPassword(password: string, salt?: string): { salt: string; hash: string } {
  const s = salt || randomBytes(16).toString('hex');
  const h = scryptSync(String(password), s, 32).toString('hex');
  return { salt: s, hash: h };
}
function verifyPassword(password: string, salt: string, hash: string): boolean {
  try {
    const h = scryptSync(String(password), salt, 32);
    const stored = Buffer.from(hash, 'hex');
    return h.length === stored.length && timingSafeEqual(h, stored);
  } catch { return false; }
}
function newToken(): string { return 'at_' + randomBytes(24).toString('hex'); }

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_accounts (
    id TEXT PRIMARY KEY,
    username VARCHAR(60) UNIQUE NOT NULL,
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    perms JSONB NOT NULL DEFAULT '[]',
    is_owner BOOLEAN NOT NULL DEFAULT false,
    active BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_accounts_token ON admin_accounts(token)`);
  _schemaReady = true;
}

interface Row { id: string; username: string; pass_salt: string; pass_hash: string; token: string; perms: any; is_owner: boolean; active: boolean; created_by?: string; created_at: any; updated_at: any; }
const mem: Row[] = [];

function rowToAccount(r: Row): AdminAccount {
  return {
    id: r.id, username: r.username, perms: Array.isArray(r.perms) ? r.perms : (r.perms ? JSON.parse(r.perms) : []),
    isOwner: !!r.is_owner, active: r.active !== false, token: r.token, createdBy: r.created_by ?? undefined,
    createdAt: (r.created_at as any)?.toISOString?.() ?? String(r.created_at),
    updatedAt: (r.updated_at as any)?.toISOString?.() ?? String(r.updated_at)
  };
}

async function allRows(): Promise<Row[]> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rows } = await pool.query(`SELECT * FROM admin_accounts ORDER BY created_at`); return rows as Row[]; }
  return mem.slice();
}

async function insertRow(r: Row): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`INSERT INTO admin_accounts(id,username,pass_salt,pass_hash,token,perms,is_owner,active,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.id, r.username, r.pass_salt, r.pass_hash, r.token, JSON.stringify(r.perms), r.is_owner, r.active, r.created_by ?? null]);
  } else mem.push(r);
}

// Seed the built-in owner from the master key once (so the panel keeps working
// and there is always a way in). Its token = master key, password = master key.
export async function ensureOwnerSeed(): Promise<void> {
  const masterKey = process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev-admin');
  if (!masterKey) return;
  const rows = await allRows();
  if (rows.some((r) => r.is_owner)) return;
  const { salt, hash } = hashPassword(masterKey);
  await insertRow({ id: id(), username: process.env.ADMIN_ROOT_USER || 'owner', pass_salt: salt, pass_hash: hash, token: masterKey, perms: ['*'], is_owner: true, active: true, created_by: 'system', created_at: new Date().toISOString() as any, updated_at: new Date().toISOString() as any });
}

export async function findByToken(token: string): Promise<AdminAccount | null> {
  if (!token) return null;
  const rows = await allRows();
  const r = rows.find((x) => x.token === token && x.active !== false);
  return r ? rowToAccount(r) : null;
}

export async function login(username: string, password: string): Promise<AdminAccount | null> {
  await ensureOwnerSeed();
  const rows = await allRows();
  const r = rows.find((x) => x.username.toLowerCase() === String(username).toLowerCase() && x.active !== false);
  if (!r || !verifyPassword(password, r.pass_salt, r.pass_hash)) return null;
  return rowToAccount(r);
}

export async function listAccounts(): Promise<Array<Omit<AdminAccount, 'token'> & { hasToken: boolean }>> {
  await ensureOwnerSeed();
  const rows = await allRows();
  return rows.map((r) => { const a = rowToAccount(r); return { id: a.id, username: a.username, perms: a.perms, isOwner: a.isOwner, active: a.active, hasToken: !!a.token, createdBy: a.createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt }; });
}

export async function createAccount(input: { username: string; password: string; perms: string[]; createdBy?: string }): Promise<AdminAccount> {
  const username = String(input.username || '').trim();
  if (!username) throw new Error('USERNAME_REQUIRED');
  if (!/^[a-zA-Z0-9_.-]{3,60}$/.test(username)) throw new Error('USERNAME_INVALID');
  if (String(input.password || '').length < 4) throw new Error('PASSWORD_TOO_SHORT');
  const rows = await allRows();
  if (rows.some((r) => r.username.toLowerCase() === username.toLowerCase())) throw new Error('USERNAME_TAKEN');
  const { salt, hash } = hashPassword(input.password);
  const row: Row = { id: id(), username, pass_salt: salt, pass_hash: hash, token: newToken(), perms: normalizePerms(input.perms), is_owner: false, active: true, created_by: input.createdBy, created_at: new Date().toISOString() as any, updated_at: new Date().toISOString() as any };
  await insertRow(row);
  await refreshTokenCache();
  return rowToAccount(row);
}

function normalizePerms(perms: unknown): string[] {
  if (!Array.isArray(perms)) return [];
  const p = perms.map(String).filter(Boolean);
  return p.includes('*') ? ['*'] : [...new Set(p)];
}

export async function updateAccount(accountId: string, patch: { perms?: string[]; password?: string; active?: boolean }): Promise<boolean> {
  const pool = pg();
  const sets: string[] = []; const args: unknown[] = [];
  if (patch.perms) { args.push(JSON.stringify(normalizePerms(patch.perms))); sets.push(`perms=$${args.length}`); }
  if (typeof patch.active === 'boolean') { args.push(patch.active); sets.push(`active=$${args.length}`); }
  if (patch.password) { const { salt, hash } = hashPassword(patch.password); args.push(salt); sets.push(`pass_salt=$${args.length}`); args.push(hash); sets.push(`pass_hash=$${args.length}`); args.push(newToken()); sets.push(`token=$${args.length}`); }
  if (!sets.length) return false;
  if (pool) {
    await ensureSchema(pool);
    args.push(accountId);
    const { rowCount } = await pool.query(`UPDATE admin_accounts SET ${sets.join(',')}, updated_at=now() WHERE id=$${args.length} AND is_owner=false`, args);
    await refreshTokenCache();
    return (rowCount ?? 0) > 0;
  }
  const r = mem.find((x) => x.id === accountId && !x.is_owner);
  if (!r) return false;
  if (patch.perms) r.perms = normalizePerms(patch.perms);
  if (typeof patch.active === 'boolean') r.active = patch.active;
  if (patch.password) { const { salt, hash } = hashPassword(patch.password); r.pass_salt = salt; r.pass_hash = hash; r.token = newToken(); }
  await refreshTokenCache();
  return true;
}

// Change your OWN password (works for owner too) — verifies current, rotates token.
export async function changeOwnPassword(accountId: string, current: string, next: string): Promise<{ ok: boolean; token?: string; error?: string }> {
  if (String(next || '').length < 4) return { ok: false, error: 'PASSWORD_TOO_SHORT' };
  const rows = await allRows();
  const r = rows.find((x) => x.id === accountId);
  if (!r) return { ok: false, error: 'NOT_FOUND' };
  if (!verifyPassword(current, r.pass_salt, r.pass_hash)) return { ok: false, error: 'CURRENT_WRONG' };
  const { salt, hash } = hashPassword(next);
  const token = newToken();
  const pool = pg();
  if (pool) { await pool.query(`UPDATE admin_accounts SET pass_salt=$1, pass_hash=$2, token=$3, updated_at=now() WHERE id=$4`, [salt, hash, token, accountId]); }
  else { r.pass_salt = salt; r.pass_hash = hash; r.token = token; }
  await refreshTokenCache();
  return { ok: true, token };
}

export async function deleteAccount(accountId: string): Promise<boolean> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rowCount } = await pool.query(`DELETE FROM admin_accounts WHERE id=$1 AND is_owner=false`, [accountId]); await refreshTokenCache(); return (rowCount ?? 0) > 0; }
  const i = mem.findIndex((x) => x.id === accountId && !x.is_owner);
  if (i < 0) return false; mem.splice(i, 1); await refreshTokenCache(); return true;
}

// The tab keys that exist in the panel (kept in sync with the admin nav).
export const ADMIN_TABS = [
  'dashboard', 'finance', 'users', 'matches', 'support',
  'questions', 'qreports', 'aistudio', 'pipeline', 'categories', 'shop',
  'wallet', 'withdrawals', 'rewardholds', 'tickets', 'giftcodes',
  'cfg_xp', 'cfg_level', 'cfg_cup', 'cfg_gameplay', 'leagues', 'missions', 'rewards',
  'leaderboard', 'campaign', 'events', 'banners', 'notifications',
  'anticheat', 'suspicious', 'reports', 'logs', 'reset', 'roles', 'accounts', 'general', 'rawcfg'
] as const;

// Map a request path to the tab it belongs to (for backend enforcement). Only
// tabs with distinct endpoints can be enforced server-side; the rest are gated
// in the panel UI. Returns null → no specific tab (allow any authenticated admin).
export function tabForPath(path: string): string | null {
  const p = path;
  if (p.includes('/admin/accounts')) return 'accounts';
  if (p.includes('/admin/shop')) return 'shop';
  if (p.includes('/admin/question-reports')) return 'qreports';
  if (p.includes('/admin/questions/ai') || p.includes('/admin/questions/draft')) return 'aistudio';
  if (p.includes('/admin/questions/pipeline')) return 'pipeline';
  if (p.includes('/admin/questions')) return 'questions';
  if (p.includes('/admin/wallet/withdrawals')) return 'withdrawals';
  if (p.includes('/admin/reward') && p.includes('hold')) return 'rewardholds';
  if (p.includes('/admin/wallet')) return 'wallet';
  if (p.includes('/admin/users')) return 'users';
  if (p.includes('/admin/notifications')) return 'notifications';
  if (p.includes('/admin/tickets')) return 'tickets';
  if (p.includes('/admin/gift')) return 'giftcodes';
  if (p.includes('/admin/matches')) return 'matches';
  if (p.includes('/admin/support')) return 'support';
  if (p.includes('/admin/leaderboard')) return 'leaderboard';
  if (p.includes('/admin/integrity') || p.includes('/admin/risk')) return 'anticheat';
  if (p.includes('/admin/finance')) return 'finance';
  if (p.includes('/admin/reset')) return 'reset';
  return null;
}

export function hasTab(perms: string[] | undefined, tab: string | null): boolean {
  if (!tab) return true;                 // unmapped → any authenticated admin
  if (!perms) return false;
  return perms.includes('*') || perms.includes(tab);
}

/* ---- Synchronous token cache so requireAdmin() stays sync at ~80 call sites ---- */
export interface CachedAccount { id: string; username: string; perms: string[]; isOwner: boolean; }
let _cache = new Map<string, CachedAccount>();
let _cacheAt = 0;
let _refreshing = false;

export async function refreshTokenCache(): Promise<void> {
  if (_refreshing) return;
  _refreshing = true;
  try {
    await ensureOwnerSeed();
    const rows = await allRows();
    const m = new Map<string, CachedAccount>();
    for (const r of rows) {
      if (r.active === false) continue;
      m.set(r.token, { id: r.id, username: r.username, perms: normalizePerms(r.perms), isOwner: !!r.is_owner });
    }
    _cache = m; _cacheAt = Date.now();
  } catch { /* keep old cache */ } finally { _refreshing = false; }
}

// Sync lookup used by requireAdmin. Triggers a background refresh if stale so a
// newly created/edited account becomes usable within a few seconds.
export function resolveTokenSync(token: string): CachedAccount | null {
  if (Date.now() - _cacheAt > 8000) { void refreshTokenCache(); }
  return token ? (_cache.get(token) ?? null) : null;
}
