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

export async function searchAdminUsers(query = '', limit = 100): Promise<AdminUserListItem[]> {
  const users = await repositories.users.list(Math.min(1000, Math.max(1, limit)));
  const q = query.trim().toLowerCase();
  const filtered = q
    ? users.filter((u) => [u.id, u.phone, u.username, u.displayName].some((value) => String(value ?? '').toLowerCase().includes(q)))
    : users;
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
