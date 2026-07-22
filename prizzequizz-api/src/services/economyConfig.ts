/* Single source of truth for every tunable money/economy variable, read LIVE
 * from gameConfig so admin-panel edits take effect immediately (no restart).
 * Each getter falls back to the env var, then a safe default, so a partial
 * config can never crash a money path. */
import { gameConfig } from '../core/config.js';

function num(v: unknown, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
function wallet(): any { return (gameConfig as any)?.economy?.wallet ?? {}; }
function paid(): any { return (gameConfig as any)?.economy?.paid ?? {}; }

export interface WalletLimits {
  minDeposit: number; maxDeposit: number; minWithdraw: number; maxWithdraw: number;
  dailyWithdrawCap: number; withdrawFee: number;
}

export function getWalletLimits(): WalletLimits {
  const w = wallet();
  return {
    minDeposit: num(w.minDeposit, envInt('WALLET_MIN_DEPOSIT', 10_000)),
    maxDeposit: num(w.maxDeposit, envInt('WALLET_MAX_DEPOSIT', 100_000_000)),
    minWithdraw: num(w.minWithdraw, envInt('WALLET_MIN_WITHDRAW', 200_000)),
    maxWithdraw: num(w.maxWithdraw, envInt('WALLET_MAX_WITHDRAW', 50_000_000)),
    dailyWithdrawCap: num(w.dailyWithdrawCap, envInt('WALLET_DAILY_WITHDRAW_CAP', 10_000_000)),
    withdrawFee: num(w.withdrawFee, envInt('WALLET_WITHDRAW_FEE', 0))
  };
}

export function getTicketPrices(): Record<string, number> {
  const p = wallet().ticketPrices ?? {};
  // Defaults for the well-known tiers, then EVERY tier present in the config —
  // so match tickets (green/blue/red) and any future tier are all purchasable.
  const out: Record<string, number> = {
    green: 12_500, blue: 25_000, red: 50_000,
    bronze: envInt('WALLET_TICKET_PRICE_BRONZE', 50_000),
    silver: envInt('WALLET_TICKET_PRICE_SILVER', 150_000),
    gold: envInt('WALLET_TICKET_PRICE_GOLD', 400_000)
  };
  if (p && typeof p === 'object') for (const k of Object.keys(p)) { const v = Number(p[k]); if (Number.isFinite(v) && v > 0) out[k] = v; }
  return out;
}

/* Platform commission (rake) taken from a paid-match cash win, as a percent.
 * The winner receives the pot minus this fee; the fee is recorded as a real
 * `fee` ledger entry (platform revenue). Clamped to 0..90. */
export function getRakePercent(): number {
  const raw = paid().rakePercent;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 5;
  return Math.min(90, n);
}

/* Reward-hold (fraud review) gating — DEFAULT OFF. A won cash prize must be
 * credited IMMEDIATELY to wallet + transactions + leaderboard + financial
 * report; holding is opt-in and only kicks in when an admin explicitly enables
 * it AND the risk score crosses a high threshold. The risk scoring is still
 * maturing (VPN/multi-account detection not fully implemented), so holding
 * legitimate winnings by default was wrong — wins must pay out. Admin can turn
 * this on later from config once the scoring is trustworthy. Env
 * REWARD_HOLD_ENABLED=true is an additional opt-in override. */
export function getRewardHoldConfig(): { enabled: boolean; riskThreshold: number } {
  const r = (gameConfig as any)?.rewards?.hold ?? {};
  const enabled = r.enabled === true || process.env.REWARD_HOLD_ENABLED === 'true';
  const riskThreshold = Math.min(100, Math.max(1, num(r.riskThreshold, 90)));
  return { enabled, riskThreshold };
}
