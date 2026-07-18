import { repositories } from '../repositories/index.js';
import type { Match, Reward, User } from '../types/domain.js';
import { id } from '../utils/id.js';
import { leaderboards } from './leaderboardService.js';
import { notifications } from './notificationService.js';
import { createRewardHold, shouldHoldReward } from './rewardReviewService.js';
import { postEntry } from './walletLedgerService.js';

/* Stake of a paid duel: the value tier is encoded in economyType ('v25000' →
 * 25,000 تومان per player). The server — never the client — derives it. */
export function duelStake(match: Match): number {
  const m = /^v(\d+)$/.exec(String(match.economyType));
  if (m) { const v = Number(m[1]); if (Number.isFinite(v) && v > 0) return v; }
  return 25_000;
}

export function calculateDuelReward(match: Match, user: User): Reward {
  if (match.economyType === 'free') return { type: 'coins', amount: 80 + match.round * 45, status: 'granted', animation: 'coin_reward' };
  // Winner takes the pot: both players staked `duelStake`, winner receives 2x.
  return { type: 'cash', amount: duelStake(match) * 2, status: 'granted', animation: 'cash_reward' };
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

  if (reward.type === 'cash') {
    // Ledger is the only money authority: atomic, idempotent, audit-ready.
    // (postEntry also writes the legacy `reward` transaction row and mirrors
    // users.wallet, so old screens keep working.)
    const posted = await postEntry({
      userId: user.id, entryType: 'match_reward', kind: 'credit', amount: reward.amount,
      idempotencyKey: `reward:${idempotencyKey}`, refType: 'match', refId: matchId,
      description: 'جایزه برد مسابقه'
    });
    if (posted.duplicate) return;
    user.wallet = posted.account.available;
  } else {
    if (reward.type === 'coins') user.coins += reward.amount;
    if (reward.type === 'xp') user.xp += reward.amount;
    await repositories.users.save(user);
    await repositories.transactions.save({
      id: id(), userId: user.id, type: 'reward', currency: reward.type, amount: reward.amount,
      direction: 'in', status: 'ok', reference: matchId, createdAt: new Date().toISOString()
    });
  }

  const rewardId = id();
  await repositories.rewards.save({ ...reward, id: rewardId, userId: user.id, matchId, idempotencyKey });
  await leaderboards.recordReward(user, reward);
  await notifications.create({ userId: user.id, type: 'wallet_update', title: 'جایزه دریافت شد', body: `${reward.amount.toLocaleString('fa-IR')} ${reward.type === 'cash' ? 'تومان' : 'سکه'} به حساب تو اضافه شد.`, data: { matchId, rewardType: reward.type, amount: reward.amount, url: '/wallet' }, push: true });
}
