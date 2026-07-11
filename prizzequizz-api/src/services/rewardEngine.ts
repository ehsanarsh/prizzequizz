import { repositories } from '../repositories/index.js';
import type { Match, Reward, User } from '../types/domain.js';
import { id } from '../utils/id.js';
import { leaderboards } from './leaderboardService.js';
import { notifications } from './notificationService.js';
import { createRewardHold, shouldHoldReward } from './rewardReviewService.js';

export function calculateDuelReward(match: Match, user: User): Reward {
  if (match.economyType === 'free') return { type: 'coins', amount: 80 + match.round * 45, status: 'granted', animation: 'coin_reward' };
  return { type: 'cash', amount: 60000, status: 'granted', animation: 'cash_reward' };
}

export async function applyReward(user: User, reward: Reward, matchId: string): Promise<void> {
  const idempotencyKey = `${matchId}:${user.id}:${reward.type}:match_result`;
  const existing = await repositories.rewards.findByIdempotencyKey(idempotencyKey);
  if (existing) return;

  const risk = await shouldHoldReward(user, reward, matchId);
  if (risk.hold) {
    await createRewardHold(user, reward, matchId, idempotencyKey, risk);
    return;
  }

  if (reward.type === 'coins') user.coins += reward.amount;
  if (reward.type === 'cash') user.wallet += reward.amount;
  if (reward.type === 'xp') user.xp += reward.amount;
  await repositories.users.save(user);

  const rewardId = id();
  await repositories.rewards.save({ ...reward, id: rewardId, userId: user.id, matchId, idempotencyKey });

  await repositories.transactions.save({
    id: id(),
    userId: user.id,
    type: 'reward',
    currency: reward.type,
    amount: reward.amount,
    direction: 'in',
    status: 'ok',
    reference: matchId,
    createdAt: new Date().toISOString()
  });
  await leaderboards.recordReward(user, reward);
  await notifications.create({ userId: user.id, type: 'wallet_update', title: 'جایزه دریافت شد', body: `${reward.amount.toLocaleString('fa-IR')} ${reward.type === 'cash' ? 'تومان' : 'سکه'} به حساب تو اضافه شد.`, data: { matchId, rewardType: reward.type, amount: reward.amount, url: '/wallet' }, push: true });
}
