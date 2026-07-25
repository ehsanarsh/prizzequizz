import { repositories } from '../repositories/index.js';
import type { Reward, RewardHold, RewardHoldStatus, User } from '../types/domain.js';
import { id } from '../utils/id.js';
import { calculateUserRisk } from './deviceRiskService.js';
import { leaderboards } from './leaderboardService.js';
import { logger } from './logger.js';
import { notifications } from './notificationService.js';
import { getRakePercent, getRewardHoldConfig } from './economyConfig.js';
import { getAccount, postEntry } from './walletLedgerService.js';

export interface RewardHoldDiagnostics {
  pending: number;
  approved: number;
  rejected: number;
  released: number;
  totalHeldAmount: number;
  pendingAmount: number;
}

export async function shouldHoldReward(user: User, reward: Reward, matchId: string): Promise<{ hold: boolean; riskScore: number; riskLevel: RewardHold['riskLevel']; reason: string; evidence: Record<string, unknown> }> {
  const profile = await calculateUserRisk(user.id);
  const paidCashReward = reward.type === 'cash';
  const cfg = getRewardHoldConfig();
  // Only hold when explicitly enabled AND the score crosses the configured
  // (high) threshold, or the user is outright critical. Default config keeps
  // this disabled, so legitimate wins are never parked.
  const highRisk = profile.riskScore >= cfg.riskThreshold || profile.riskLevel === 'critical';
  const hold = cfg.enabled && paidCashReward && highRisk;
  return {
    hold,
    riskScore: profile.riskScore,
    riskLevel: profile.riskLevel,
    reason: highRisk ? 'high_risk_reward_review' : 'low_risk_reward',
    evidence: { matchId, rewardType: reward.type, amount: reward.amount, riskProfile: profile }
  };
}

export async function createRewardHold(user: User, reward: Reward, matchId: string, idempotencyKey: string, risk: Awaited<ReturnType<typeof shouldHoldReward>>): Promise<RewardHold> {
  const existing = await repositories.rewardHolds.findByIdempotencyKey(idempotencyKey);
  if (existing) return existing;
  const rewardId = id();
  const hold: RewardHold = {
    id: id(),
    rewardId,
    userId: user.id,
    matchId,
    rewardType: reward.type,
    amount: reward.amount,
    status: 'pending',
    riskScore: risk.riskScore,
    riskLevel: risk.riskLevel,
    reason: risk.reason,
    evidence: risk.evidence,
    idempotencyKey,
    createdAt: new Date().toISOString()
  };
  await repositories.rewards.save({ ...reward, id: rewardId, userId: user.id, matchId, status: 'pending', idempotencyKey });
  await repositories.rewardHolds.save(hold);
  await notifications.create({ userId: user.id, type: 'wallet_update', title: 'جایزه در صف بررسی است', body: 'به دلیل بررسی امنیتی، جایزه نقدی بعد از تأیید ادمین آزاد می‌شود.', data: { matchId, holdId: hold.id, amount: reward.amount, url: '/wallet' }, push: true });
  logger.warn('reward_hold_created', { holdId: hold.id, userId: user.id, matchId, amount: reward.amount, riskScore: risk.riskScore, riskLevel: risk.riskLevel });
  return hold;
}

export async function listRewardHolds(filter: { userId?: string; matchId?: string; status?: RewardHoldStatus; limit?: number } = {}): Promise<RewardHold[]> {
  return repositories.rewardHolds.list(filter);
}

export async function rewardHoldDiagnostics(): Promise<RewardHoldDiagnostics> {
  const holds = await repositories.rewardHolds.list({ limit: 500 });
  return {
    pending: holds.filter((h) => h.status === 'pending').length,
    approved: holds.filter((h) => h.status === 'approved').length,
    rejected: holds.filter((h) => h.status === 'rejected').length,
    released: holds.filter((h) => h.status === 'released').length,
    totalHeldAmount: holds.reduce((sum, h) => sum + h.amount, 0),
    pendingAmount: holds.filter((h) => h.status === 'pending').reduce((sum, h) => sum + h.amount, 0)
  };
}

export async function reviewRewardHold(id: string, status: 'approved' | 'rejected', reviewedBy: string): Promise<RewardHold | null> {
  const hold = await repositories.rewardHolds.findById(id);
  if (!hold) return null;
  if (hold.status !== 'pending' && hold.status !== 'approved') return hold;
  if (status === 'rejected') {
    const rejected = await repositories.rewardHolds.updateStatus(id, 'rejected', reviewedBy);
    if (rejected) await notifications.create({ userId: rejected.userId, type: 'wallet_update', title: 'جایزه رد شد', body: 'جایزه این مسابقه بعد از بررسی امنیتی رد شد.', data: { holdId: rejected.id, matchId: rejected.matchId, url: '/support' }, push: true });
    return rejected;
  }
  await repositories.rewardHolds.updateStatus(id, 'approved', reviewedBy);
  return releaseRewardHold(id, reviewedBy);
}

export async function releaseRewardHold(id: string, reviewedBy = 'system'): Promise<RewardHold | null> {
  const hold = await repositories.rewardHolds.findById(id);
  if (!hold) return null;
  if (hold.status === 'released') return hold;
  if (hold.status !== 'pending' && hold.status !== 'approved') return hold;

  // The CRITICAL, must-not-fail step is crediting the user. Everything after it
  // (denormalized user row, legacy transaction, rewards ledger, leaderboard,
  // notification) is best-effort bookkeeping — a failure there must NOT block a
  // legitimate payout or leave the hold stuck as pending. We credit first, then
  // do the rest defensively.
  const user = await repositories.users.findById(hold.userId);
  try {
    if (hold.rewardType === 'cash') {
      // Cash releases go through the ledger — atomic + idempotent per hold — and
      // take the same platform rake as a normal win so a held win nets the same.
      const gross = hold.amount;
      const rakePercent = getRakePercent();
      const fee = Math.round((gross * rakePercent) / 100);
      await postEntry({ userId: hold.userId, entryType: 'match_reward', kind: 'credit', amount: gross, idempotencyKey: `hold_release:${hold.id}`, refType: 'match', refId: hold.matchId, description: 'جایزه آزادشده پس از بررسی', metadata: { gross, rakePercent, fee } });
      if (fee > 0) await postEntry({ userId: hold.userId, entryType: 'fee', kind: 'debit', amount: fee, idempotencyKey: `hold_release_fee:${hold.id}`, refType: 'match', refId: hold.matchId, description: `کارمزد پلتفرم ${rakePercent}٪` });
      if (user) { try { user.wallet = (await getAccount(hold.userId)).available; } catch { /* mirror only */ } }
    } else if (user) {
      if (hold.rewardType === 'coins') user.coins += hold.amount;
      if (hold.rewardType === 'xp') user.xp += hold.amount;
      await repositories.users.save(user);
      try { await repositories.transactions.save({ id: idGen(), userId: hold.userId, type: 'reward', currency: hold.rewardType, amount: hold.amount, direction: 'in', status: 'ok', reference: hold.matchId, createdAt: new Date().toISOString() }); } catch (e) { logger.warn('reward_hold_txn_failed', { holdId: hold.id, message: (e as Error).message }); }
    }
  } catch (e) {
    // The actual credit failed — surface it so the admin sees a real reason and
    // the hold stays pending (retryable), instead of silently doing nothing.
    logger.error('reward_hold_credit_failed', { holdId: hold.id, userId: hold.userId, amount: hold.amount, message: (e as Error).message });
    throw e;
  }

  // Best-effort bookkeeping — never let these throw out of a successful payout.
  try { await repositories.rewards.save({ id: hold.rewardId, userId: hold.userId, matchId: hold.matchId, type: hold.rewardType, amount: hold.amount, status: 'granted', idempotencyKey: hold.idempotencyKey }); } catch (e) { logger.warn('reward_hold_reward_save_failed', { holdId: hold.id, message: (e as Error).message }); }
  if (user) { try { await leaderboards.recordReward(user, { type: hold.rewardType, amount: hold.amount, status: 'granted' }); } catch (e) { logger.warn('reward_hold_leaderboard_failed', { holdId: hold.id, message: (e as Error).message }); } }
  const released = await repositories.rewardHolds.updateStatus(hold.id, 'released', reviewedBy, { releasedAt: new Date().toISOString() });
  try { await notifications.create({ userId: hold.userId, type: 'wallet_update', title: 'جایزه آزاد شد', body: `${hold.amount.toLocaleString('fa-IR')} ${hold.rewardType === 'cash' ? 'تومان' : 'سکه'} بعد از بررسی به حساب تو اضافه شد.`, data: { holdId: hold.id, matchId: hold.matchId, amount: hold.amount, url: '/wallet' }, push: true }); } catch (e) { logger.warn('reward_hold_notify_failed', { holdId: hold.id, message: (e as Error).message }); }
  logger.info('reward_hold_released', { holdId: hold.id, userId: hold.userId, amount: hold.amount });
  return released ?? hold;
}

function idGen(): string { return id(); }
