/* LAST SURVIVOR — prize engine (units-based, conservation-guaranteed).
 *
 * The pot is the sum of every entrant's ticket VALUE (minus optional house
 * rake). Payout is split by SHARE UNITS, never by headcount:
 *   green = 1 unit, blue = 2 units, red = 4 units (all admin-tunable).
 *
 * Headcount is always the real number of people (a red ticket is ONE player,
 * not four). Only the money split uses units.
 *
 * Model (matches the spec):
 *  - Elimination pays the player nothing; their units simply leave the active
 *    pool, so survivors' shares rise.
 *  - Cash-out pays the player their CURRENT share of the REMAINING pot and
 *    removes both the payout (from the remaining pot) and their units.
 *  - Current share = remainingPot * myUnits / (sum of units of players still
 *    ALIVE, including this one).
 *  - At the end, remaining survivors split the remaining pot by units.
 *  - Sum of all cash-outs + final split == net pot, exactly (integer tomans,
 *    remainder handled deterministically). */
import type { LastSurvivorConfig, TicketTier } from './lastSurvivorConfig.js';
import { netPrize } from './prizeService.js';

export type TicketColor = string; // 'green' | 'blue' | 'red' | admin-defined
export type PlayerStatus = 'waiting' | 'alive' | 'eliminated' | 'cashed_out';

export interface PrizePlayer {
  userId: string;
  color: TicketColor;
  units: number;
  status: PlayerStatus;
  payoutCash?: number;
}

function tier(cfg: LastSurvivorConfig, color: TicketColor): TicketTier {
  return cfg.economy.tickets[color] || { value: 0, units: 0 };
}

export function ticketValue(cfg: LastSurvivorConfig, color: TicketColor): number {
  return Math.max(0, Math.round(tier(cfg, color).value));
}
export function ticketUnits(cfg: LastSurvivorConfig, color: TicketColor): number {
  return Math.max(0, Math.round(tier(cfg, color).units));
}

/** Gross pot (sum of ticket values), the house commission, and the net pot
 *  players split. The commission comes from the SAME shared calculator every
 *  other mode uses, so no two screens can ever quote different prizes. */
export function buildPool(cfg: LastSurvivorConfig, colors: TicketColor[]): { gross: number; rake: number; net: number } {
  const gross = colors.reduce((s, c) => s + ticketValue(cfg, c), 0);
  const net = netPrize(gross);
  return { gross, rake: gross - net, net };
}

/** Sum of units of players still in the running (alive). */
export function activeUnits(players: PrizePlayer[]): number {
  return players.filter((p) => p.status === 'alive').reduce((s, p) => s + Math.max(0, p.units), 0);
}

/**
 * A single player's current cash-out share of the remaining pot. Floored to an
 * integer toman (the house keeps sub-toman dust; final split reconciles the
 * remainder so nothing is lost).
 */
export function currentShare(remainingPot: number, myUnits: number, aliveUnits: number): number {
  if (aliveUnits <= 0 || myUnits <= 0 || remainingPot <= 0) return 0;
  return Math.floor((remainingPot * myUnits) / aliveUnits);
}

/** Cash-out share for a specific alive player given the current field. */
export function cashoutShareFor(player: PrizePlayer, players: PrizePlayer[], remainingPot: number): number {
  if (player.status !== 'alive') return 0;
  return currentShare(remainingPot, Math.max(0, player.units), activeUnits(players));
}

/**
 * Final split when the match ends: distribute the ENTIRE remaining pot among the
 * still-alive players by units. Any integer remainder (from flooring) goes to the
 * player with the most units (ties → first), so sum(payouts) === remainingPot.
 * Returns a map userId → payout.
 */
export function finalSplit(players: PrizePlayer[], remainingPot: number): Record<string, number> {
  const alive = players.filter((p) => p.status === 'alive' && p.units > 0);
  const out: Record<string, number> = {};
  const totalUnits = alive.reduce((s, p) => s + p.units, 0);
  if (remainingPot <= 0 || totalUnits <= 0 || alive.length === 0) { for (const p of alive) out[p.userId] = 0; return out; }
  let distributed = 0;
  for (const p of alive) { const share = Math.floor((remainingPot * p.units) / totalUnits); out[p.userId] = share; distributed += share; }
  const remainder = remainingPot - distributed;
  if (remainder > 0) {
    // Give the dust to the largest stake (deterministic, tie → first listed).
    const top = alive.slice().sort((a, b) => b.units - a.units || (a.userId < b.userId ? -1 : 1))[0];
    if (top) out[top.userId] = (out[top.userId] ?? 0) + remainder;
  }
  return out;
}

/** Live dashboard numbers, all derived from the persisted player list + pot. */
export interface SurvivorStats {
  totalPlayers: number;
  alive: number;
  eliminated: number;
  cashedOut: number;
  grossPot: number;
  paidOut: number;      // sum of cash-outs already paid
  remainingPot: number; // what is still on the table
  activeUnits: number;
}
export function computeStats(players: PrizePlayer[], grossPot: number): SurvivorStats {
  const paidOut = players.filter((p) => p.status === 'cashed_out').reduce((s, p) => s + (p.payoutCash || 0), 0);
  return {
    totalPlayers: players.length,
    alive: players.filter((p) => p.status === 'alive').length,
    eliminated: players.filter((p) => p.status === 'eliminated').length,
    cashedOut: players.filter((p) => p.status === 'cashed_out').length,
    grossPot,
    paidOut,
    remainingPot: Math.max(0, grossPot - paidOut),
    activeUnits: activeUnits(players)
  };
}
