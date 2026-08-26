import { repositories } from '../repositories/index.js';
import type { User, UserStatus } from '../types/domain.js';
import { calculateUserRisk, listCurrentUserDevices } from './deviceRiskService.js';

export interface AdminUserListItem {
  id: string;
  phone: string;
  username: string;
  displayName: string;
  plan: string;
  role: 'user' | 'admin';
  status: UserStatus;
  level: number;
  xp: number;
  weeklyScore: number;
  wallet: number;
  coins: number;
  hearts: number;
  riskScore?: number;
  riskLevel?: string;
}

/* SEARCH LOOKS AT EVERY ACCOUNT, NOT THE LAST TWO HUNDRED.
 *
 * This used to ask for `list(limit)` — the most recently updated accounts —
 * and filter those in memory. So the panel could only find somebody who had
 * played recently, which is close to the opposite of who an operator is
 * looking for: the account with a complaint against it has usually been quiet.
 * Typing a real phone number and getting «کاربری نیست» is what that looks like
 * from the outside.
 *
 * The repository does the search now, in the database, over the whole table —
 * and it knows that ۰۹۱۲…, +98912… and 0912… are one phone number. */
export async function searchAdminUsers(query = '', limit = 100): Promise<AdminUserListItem[]> {
  const cap = Math.min(1000, Math.max(1, limit));
  const q = query.trim();
  const filtered = q ? await repositories.users.search(q, cap) : await repositories.users.list(cap);
  const rows: AdminUserListItem[] = [];
  for (const user of filtered.slice(0, limit)) {
    const risk = await repositories.devices.getRiskProfile(user.id).catch(() => null);
    rows.push(toListItem(user, risk ?? undefined));
  }
  return rows;
}

export async function getAdminUserOverview(userId: string) {
  const user = await repositories.users.findById(userId);
  if (!user) return null;
  const [transactions, devices, riskProfile, tickets, integritySignals, rewardHolds] = await Promise.all([
    repositories.transactions.listByUser(userId),
    listCurrentUserDevices(userId).catch(() => []),
    calculateUserRisk(userId).catch(() => null),
    repositories.support.listTickets({ userId, limit: 20 }).catch(() => []),
    repositories.integrity.list({ userId, limit: 20 }).catch(() => []),
    repositories.rewardHolds.list({ userId, limit: 20 }).catch(() => [])
  ]);
  return {
    user: toListItem(user, riskProfile ?? undefined),
    balances: { wallet: user.wallet, coins: user.coins, hearts: user.hearts, tickets: user.tickets },
    transactions: transactions.slice(0, 20),
    devices,
    riskProfile,
    tickets,
    integritySignals,
    rewardHolds
  };
}

export async function updateUserStatus(userId: string, status: UserStatus, reason?: string): Promise<AdminUserListItem | null> {
  const user = await repositories.users.findById(userId);
  if (!user) return null;
  user.status = status;
  user.banReason = status === 'banned' || status === 'limited' ? reason : undefined;
  user.bannedAt = status === 'banned' ? new Date().toISOString() : undefined;
  await repositories.users.save(user);
  const risk = await repositories.devices.getRiskProfile(userId).catch(() => null);
  return toListItem(user, risk ?? undefined);
}

/* Edit core profile/progression fields directly (admin override). Wallet is NOT
 * edited here — money only moves through the ledger (/admin/wallet/adjust). */
export async function updateUserFields(userId: string, fields: Partial<{ displayName: string; username: string; xp: number; level: number; weeklyScore: number; coins: number; hearts: number }>): Promise<AdminUserListItem | null> {
  const user = await repositories.users.findById(userId);
  if (!user) return null;
  if (typeof fields.displayName === 'string' && fields.displayName.trim()) user.displayName = fields.displayName.trim();
  if (typeof fields.username === 'string' && fields.username.trim()) user.username = fields.username.trim();
  if (Number.isFinite(fields.xp as number)) user.xp = Math.max(0, Math.round(fields.xp as number));
  if (Number.isFinite(fields.level as number)) user.level = Math.max(1, Math.round(fields.level as number));
  if (Number.isFinite(fields.weeklyScore as number)) user.weeklyScore = Math.max(0, Math.round(fields.weeklyScore as number));
  if (Number.isFinite(fields.coins as number)) user.coins = Math.max(0, Math.round(fields.coins as number));
  if (Number.isFinite(fields.hearts as number)) user.hearts = Math.max(0, Math.round(fields.hearts as number));
  await repositories.users.save(user);
  const risk = await repositories.devices.getRiskProfile(userId).catch(() => null);
  return toListItem(user, risk ?? undefined);
}

/* Set (or add to) a user's ticket count for a tier — a granted asset, not a
 * wallet movement. mode 'set' overwrites, 'add' increments. */
export async function setUserTickets(userId: string, tier: string, count: number, mode: 'set' | 'add'): Promise<Record<string, number> | null> {
  const user = await repositories.users.findById(userId);
  if (!user) return null;
  // Go through the atomic ticket update — users.save does NOT persist the
  // tickets JSONB column, so writing it there silently loses the grant.
  const { grantTickets, setTickets } = await import('./ticketService.js');
  return mode === 'add' ? grantTickets(userId, tier, count) : setTickets(userId, tier, count);
}

/* Reset progression stats (xp/level/weekly cup) — does NOT touch the wallet. */
export async function resetUserStats(userId: string): Promise<AdminUserListItem | null> {
  const user = await repositories.users.findById(userId);
  if (!user) return null;
  user.xp = 0; user.level = 1; user.weeklyScore = 0;
  await repositories.users.save(user);
  const risk = await repositories.devices.getRiskProfile(userId).catch(() => null);
  return toListItem(user, risk ?? undefined);
}

export async function updateUserRole(userId: string, role: 'user' | 'admin'): Promise<AdminUserListItem | null> {
  const user = await repositories.users.findById(userId);
  if (!user) return null;
  user.role = role;
  await repositories.users.save(user);
  const risk = await repositories.devices.getRiskProfile(userId).catch(() => null);
  return toListItem(user, risk ?? undefined);
}

function toListItem(user: User, risk?: { riskScore: number; riskLevel: string }): AdminUserListItem {
  return {
    id: user.id,
    phone: user.phone,
    username: user.username,
    displayName: user.displayName,
    plan: user.plan,
    role: user.role ?? 'user',
    status: user.status ?? 'active',
    level: user.level,
    xp: user.xp,
    weeklyScore: user.weeklyScore,
    wallet: user.wallet,
    coins: user.coins,
    hearts: user.hearts,
    riskScore: risk?.riskScore,
    riskLevel: risk?.riskLevel
  };
}
