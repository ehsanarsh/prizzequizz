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
  return {
    bronze: num(p.bronze, envInt('WALLET_TICKET_PRICE_BRONZE', 50_000)),
    silver: num(p.silver, envInt('WALLET_TICKET_PRICE_SILVER', 150_000)),
    gold: num(p.gold, envInt('WALLET_TICKET_PRICE_GOLD', 400_000))
  };
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
