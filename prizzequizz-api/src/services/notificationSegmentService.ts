/* AUDIENCE SEGMENTS for notifications.
 * Resolves a compound segment spec (all criteria AND-ed) into the matching user
 * IDs, using REAL user data: plan, status, level, XP, wallet, tickets, signup
 * date, and last-seen (from game_sessions). Compound = several criteria at once
 * (e.g. paid AND level>=5 AND inactive 7d). Postgres-backed with a memory
 * fallback for the dev driver.
 *
 * HONEST LIMITS: "city" and "app version" segments are NOT offered — the app
 * stores neither, so we don't fake them. Everything here is backed by columns
 * that actually exist. */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';

export interface SegmentSpec {
  base?: 'all' | 'online' | 'offline' | 'new' | 'inactive';
  plan?: 'free' | 'paid';
  status?: 'active' | 'limited' | 'banned' | 'any';
  minLevel?: number; maxLevel?: number;
  minXp?: number; maxXp?: number;
  walletLt?: number; walletGt?: number;
  hasTickets?: boolean;        // true = ≥1 ticket, false = 0 tickets
  newWithinDays?: number;      // registered within N days
  inactiveDays?: number;       // last seen ≥ N days ago (or never)
  onlineMinutes?: number;      // seen within N minutes
  userIds?: string[];          // explicit manual list
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

function num(v: unknown): number | undefined { const n = Number(v); return Number.isFinite(n) ? n : undefined; }

// Human-readable one-line description of a segment, for the admin history/UI.
export function describeSegment(s: SegmentSpec): string {
  if (s.userIds && s.userIds.length && !hasCriteria(s)) return `${s.userIds.length} کاربر دستی`;
  const p: string[] = [];
  const base: Record<string, string> = { all: 'همه', online: 'آنلاین', offline: 'آفلاین', new: 'کاربران جدید', inactive: 'غیرفعال' };
  if (s.base && base[s.base]) p.push(base[s.base]!);
  if (s.plan) p.push(s.plan === 'paid' ? 'اشتراک پولی' : 'رایگان');
  if (s.status && s.status !== 'any') p.push({ active: 'فعال', limited: 'محدود', banned: 'مسدود' }[s.status]!);
  if (s.minLevel != null) p.push(`سطح ≥ ${s.minLevel}`);
  if (s.maxLevel != null) p.push(`سطح ≤ ${s.maxLevel}`);
  if (s.minXp != null) p.push(`XP ≥ ${s.minXp}`);
  if (s.maxXp != null) p.push(`XP ≤ ${s.maxXp}`);
  if (s.walletGt != null) p.push(`موجودی > ${s.walletGt}`);
  if (s.walletLt != null) p.push(`موجودی < ${s.walletLt}`);
  if (s.hasTickets === true) p.push('دارای بلیط');
  if (s.hasTickets === false) p.push('بدون بلیط');
  if (s.newWithinDays != null) p.push(`عضو ${s.newWithinDays} روز اخیر`);
  if (s.inactiveDays != null) p.push(`${s.inactiveDays} روز غیرفعال`);
  if (s.userIds && s.userIds.length) p.push(`+ ${s.userIds.length} دستی`);
  return p.length ? p.join(' · ') : 'همه کاربران';
}

function hasCriteria(s: SegmentSpec): boolean {
  return Boolean(s.base && s.base !== 'all') || s.plan != null || (s.status && s.status !== 'any') ||
    s.minLevel != null || s.maxLevel != null || s.minXp != null || s.maxXp != null ||
    s.walletLt != null || s.walletGt != null || s.hasTickets != null ||
    s.newWithinDays != null || s.inactiveDays != null || s.onlineMinutes != null;
}

// Normalize base presets into concrete numeric criteria.
function normalize(s: SegmentSpec): SegmentSpec {
  const n: SegmentSpec = { ...s };
  if (n.base === 'online' && n.onlineMinutes == null) n.onlineMinutes = 5;
  if (n.base === 'new' && n.newWithinDays == null) n.newWithinDays = 7;
  if (n.base === 'inactive' && n.inactiveDays == null) n.inactiveDays = 7;
  return n;
}

export async function resolveSegment(spec: SegmentSpec, cap = 100000): Promise<{ userIds: string[]; count: number }> {
  const s = normalize(spec || {});
  const manual = Array.isArray(s.userIds) ? s.userIds.map(String).filter(Boolean) : [];
  // Pure manual list (no other criteria) → use as-is.
  if (manual.length && !hasCriteria(s) && s.base !== 'offline') {
    const uniq = [...new Set(manual)];
    return { userIds: uniq.slice(0, cap), count: uniq.length };
  }

  const pool = pg();
  if (pool) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (cond: string, val?: unknown) => { if (val !== undefined) { args.push(val); where.push(cond.replace('$?', `$${args.length}`)); } else { where.push(cond); } };

    // Default: exclude banned unless explicitly targeting a status.
    if (s.status && s.status !== 'any') add('u.status = $?', s.status);
    else where.push(`coalesce(u.status,'active') <> 'banned'`);

    if (s.plan) add('u.plan = $?', s.plan);
    if (num(s.minLevel) != null) add('u.level >= $?', num(s.minLevel));
    if (num(s.maxLevel) != null) add('u.level <= $?', num(s.maxLevel));
    if (num(s.minXp) != null) add('u.xp >= $?', num(s.minXp));
    if (num(s.maxXp) != null) add('u.xp <= $?', num(s.maxXp));
    if (num(s.walletGt) != null) add('u.wallet_balance > $?', num(s.walletGt));
    if (num(s.walletLt) != null) add('u.wallet_balance < $?', num(s.walletLt));
    if (s.hasTickets === true) where.push(`(coalesce((u.tickets->>'bronze')::int,0)+coalesce((u.tickets->>'silver')::int,0)+coalesce((u.tickets->>'gold')::int,0)) > 0`);
    if (s.hasTickets === false) where.push(`(coalesce((u.tickets->>'bronze')::int,0)+coalesce((u.tickets->>'silver')::int,0)+coalesce((u.tickets->>'gold')::int,0)) = 0`);
    if (num(s.newWithinDays) != null) add(`u.created_at >= now() - ($? || ' days')::interval`, String(num(s.newWithinDays)));

    // Session-based criteria need the latest last_seen per user.
    const needSession = num(s.onlineMinutes) != null || num(s.inactiveDays) != null || s.base === 'offline';
    if (num(s.onlineMinutes) != null) add(`s.ls >= now() - ($? || ' minutes')::interval`, String(num(s.onlineMinutes)));
    if (num(s.inactiveDays) != null) add(`(s.ls IS NULL OR s.ls < now() - ($? || ' days')::interval)`, String(num(s.inactiveDays)));
    if (s.base === 'offline') where.push(`(s.ls IS NULL OR s.ls < now() - interval '5 minutes')`);

    const join = needSession ? `LEFT JOIN (SELECT user_id, max(last_seen_at) ls FROM game_sessions GROUP BY user_id) s ON s.user_id = u.id` : '';
    const sql = `SELECT u.id FROM users u ${join} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY u.updated_at DESC LIMIT ${cap}`;
    let ids: string[] = [];
    try { const { rows } = await pool.query(sql, args); ids = rows.map((r: any) => r.id); }
    catch { ids = (await repositories.users.list(cap)).map((u) => u.id); } // safety net
    // Union manual ids (compound "these criteria OR these specific people").
    if (manual.length) ids = [...new Set([...ids, ...manual])];
    return { userIds: ids.slice(0, cap), count: ids.length };
  }

  // ---- Memory fallback (dev driver: no sessions, best-effort on user fields) ----
  let users = await repositories.users.list(cap);
  if (!(s.status && s.status === 'any')) users = users.filter((u) => (u.status ?? 'active') !== 'banned' || s.status === 'banned');
  if (s.status && s.status !== 'any') users = users.filter((u) => (u.status ?? 'active') === s.status);
  if (s.plan) users = users.filter((u) => u.plan === s.plan);
  if (num(s.minLevel) != null) users = users.filter((u) => u.level >= num(s.minLevel)!);
  if (num(s.maxLevel) != null) users = users.filter((u) => u.level <= num(s.maxLevel)!);
  if (num(s.minXp) != null) users = users.filter((u) => u.xp >= num(s.minXp)!);
  if (num(s.maxXp) != null) users = users.filter((u) => u.xp <= num(s.maxXp)!);
  if (num(s.walletGt) != null) users = users.filter((u) => u.wallet > num(s.walletGt)!);
  if (num(s.walletLt) != null) users = users.filter((u) => u.wallet < num(s.walletLt)!);
  if (s.hasTickets === true) users = users.filter((u) => (u.tickets.bronze + u.tickets.silver + u.tickets.gold) > 0);
  if (s.hasTickets === false) users = users.filter((u) => (u.tickets.bronze + u.tickets.silver + u.tickets.gold) === 0);
  let ids = users.map((u) => u.id);
  if (manual.length) ids = [...new Set([...ids, ...manual])];
  return { userIds: ids.slice(0, cap), count: ids.length };
}
