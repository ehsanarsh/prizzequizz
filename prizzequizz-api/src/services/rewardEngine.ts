import { repositories } from '../repositories/index.js';
import type { Match, Reward, User } from '../types/domain.js';
import { id } from '../utils/id.js';
import { leaderboards } from './leaderboardService.js';
import { notifications } from './notificationService.js';
import { createRewardHold, shouldHoldReward } from './rewardReviewService.js';
import { getRakePercent, getRewardHoldConfig } from './economyConfig.js';
import { getAccount, postEntry } from './walletLedgerService.js';

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

  // Fraud-review holding is OPT-IN and default OFF: a won prize pays out
  // immediately. Only when an admin enables it do we compute risk and possibly
  // park the reward — so a risk-calc hiccup can never silently swallow a payout.
  if (getRewardHoldConfig().enabled) {
    const risk = await shouldHoldReward(user, reward, matchId);
    if (risk.hold) {
      await createRewardHold(user, reward, matchId, idempotencyKey, risk);
      return;
    }
  }

  if (reward.type === 'cash') {
    // Ledger is the only money authority: atomic, idempotent, audit-ready.
    // The winner is credited the GROSS pot, then the platform commission (rake)
    // is taken as a real `fee` ledger entry — so the wallet ends up with exactly
    // the NET the result screen shows (gross − rake), and the fee rows sum to
    // platform revenue. (postEntry also mirrors users.wallet + writes the legacy
    // reward transaction row so old screens keep working.)
    const gross = reward.amount;
    const rakePercent = getRakePercent();
    const fee = Math.round((gross * rakePercent) / 100);
    const net = gross - fee;
    const posted = await postEntry({
      userId: user.id, entryType: 'match_reward', kind: 'credit', amount: gross,
      idempotencyKey: `reward:${idempotencyKey}`, refType: 'match', refId: matchId,
      description: 'جایزه برد مسابقه', metadata: { gross, rakePercent, fee, net }
    });
    if (posted.duplicate) return;
    if (fee > 0) {
      await postEntry({
        userId: user.id, entryType: 'fee', kind: 'debit', amount: fee,
        idempotencyKey: `reward_fee:${idempotencyKey}`, refType: 'match', refId: matchId,
        description: `کارمزد پلتفرم ${rakePercent}٪`, metadata: { gross, rakePercent }
      });
    }
    user.wallet = (await getAccount(user.id)).available;
    reward = { ...reward, amount: net }; // record/leaderboard reflect NET winnings
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
