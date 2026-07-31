/* THE prize calculator. Every screen, every payout and every quote in the app
 * goes through this file, so a number can never disagree with another one.
 *
 * The platform commission is read LIVE from the admin panel's Game Config
 * (economy.paid.rakePercent) — there is no hard-coded percentage anywhere in
 * the product. Change it in the panel and every quote and payout follows on the
 * next request, with no restart.
 *
 * The commission itself is an internal accounting detail: it is recorded as a
 * real `fee` ledger row, but it is NEVER part of anything sent to a player.
 * Clients receive only the final amount a winner takes home. */
import { getRakePercent, getTicketPrices } from './economyConfig.js';

/** The commission on a gross pot, in toman. Server-side only. */
export function feeFor(gross: number): number {
  const g = Math.max(0, Math.round(Number(gross) || 0));
  return Math.round((g * getRakePercent()) / 100);
}

/** What a winner actually receives from a gross pot — the only figure players see. */
export function netPrize(gross: number): number {
  const g = Math.max(0, Math.round(Number(gross) || 0));
  return Math.max(0, g - feeFor(g));
}

/** Gross pot for `players` entrants who each staked `ticketValue`. */
export function grossPot(ticketValue: number, players = 2): number {
  return Math.max(0, Math.round(Number(ticketValue) || 0)) * Math.max(1, Math.floor(players));
}

/** Take-home prize for a head-to-head match at a given ticket tier. */
export function duelPrize(ticketValue: number, players = 2): number {
  return netPrize(grossPot(ticketValue, players));
}

export interface TicketPrizeRow {
  key: string;
  /** Entry price of the tier (what the ticket costs). */
  ticketValue: number;
  /** Take-home prize for a 1-v-1 match at this tier — already net. */
  duelPrize: number;
}

/* The public prize table. Deliberately carries NO percentage and NO fee amount:
 * the client renders `duelPrize` verbatim and has no commission maths of its
 * own, which is what keeps every screen in step. */
export function ticketPrizeTable(): TicketPrizeRow[] {
  const prices = getTicketPrices();
  return ['green', 'blue', 'red']
    .filter((k) => Number.isFinite(prices[k]))
    .map((key) => ({ key, ticketValue: prices[key]!, duelPrize: duelPrize(prices[key]!, 2) }));
}
