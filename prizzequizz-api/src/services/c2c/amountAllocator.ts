/* THE UNIQUE AMOUNT.
 *
 * Card-to-card carries no message. The payer cannot attach an order number,
 * and the bank's own reference is created at transfer time — so it cannot be
 * given out beforehand. The only identifier we can put in the player's hands
 * before they pay is the amount, which is why it has to be unique.
 *
 * The base price is a round Toman figure the player understands; the payable
 * figure adds a small suffix in Rial:
 *
 *   ۵۰٬۰۰۰ تومان  →  ۵۰۰٬۰۴۷ ریال
 *
 * Three decisions here are worth more than the code around them:
 *
 * 1. THE DATABASE DECIDES, NOT THIS FILE. Everything below only proposes
 *    candidates; a partial unique index accepts one and rejects the rest. Any
 *    number of processes, any number of simultaneous requests — two live
 *    sessions on one card cannot share an amount.
 *
 * 2. CANDIDATES ARE RANDOM, NOT SEQUENTIAL. Walking 1, 2, 3… makes every new
 *    payment collide with the previous one, and leaks how many payments are
 *    open: read two payable amounts, subtract, and you know. Random costs
 *    nothing and removes both.
 *
 * 3. SUFFIX ZERO IS NEVER USED. A round transfer is what an unrelated deposit
 *    — somebody's salary, a refund — most often looks like. Leaving zero out
 *    means no round amount can ever auto-match a session.
 */
import { tomanToRial } from '../money.js';
import { getPaymentSettings } from '../paymentGatewayService.js';
import { eligibleCards, lowestFloorToman, type C2cCard } from './cardService.js';
import { reservingSessionsForUser, setSessionStatus, tryInsertSession, type C2cSession } from './sessionStore.js';
import { logger } from '../logger.js';

export const SUFFIX_MODES = ['rial', 'toman'] as const;
export type SuffixMode = (typeof SUFFIX_MODES)[number];

/**
 * How many random candidates to try on one card before moving to the next.
 *
 * Not all 99: if 25 random picks are all taken, this card is very likely over
 * 80% full, and another card will answer faster than the remaining 74 probes.
 * The chance of 25 misses at 50% occupancy is 0.5²⁵ ≈ 3×10⁻⁸.
 */
export const CANDIDATES_PER_CARD = 25;

export class AllocationError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message); this.name = 'AllocationError';
  }
}

/**
 * The suffixes a mode may use.
 *
 *   rial   1…99      — hidden inside the Rial figure; ≤ 9.9 Toman of difference
 *   toman  10…990    — a whole number of Toman, for banking apps that refuse
 *                      anything else. Same 99 slots, a larger visible gap.
 */
export function suffixSpace(mode: SuffixMode): number[] {
  const out: number[] = [];
  if (mode === 'toman') { for (let i = 1; i <= 99; i++) out.push(i * 10); return out; }
  for (let i = 1; i <= 99; i++) out.push(i);
  return out;
}

/** Fisher–Yates on a copy — the caller's array is never reordered. */
function shuffled<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface AllocateInput {
  userId: string;
  /** The round price the player was quoted, in Toman. */
  baseAmountToman: number;
  intentId?: string | null;
}

export interface Allocation {
  session: C2cSession;
  card: C2cCard;
  /** Sessions cancelled to make room, so the caller can tell the player. */
  supersededSessionIds: string[];
}

export async function allocate(input: AllocateInput): Promise<Allocation> {
  /* Through money.ts, so the one place a factor of ten exists stays the one
   * place — and so a fractional or negative price is refused here rather than
   * becoming an unpayable amount on a page. */
  const baseRial = tomanToRial(input.baseAmountToman);
  if (baseRial <= 0) throw new AllocationError('C2C_AMOUNT_INVALID', 'مبلغ سفارش نامعتبر است.');

  const settings = await getPaymentSettings();
  const mode: SuffixMode = settings.c2c.suffixMode === 'toman' ? 'toman' : 'rial';
  const ttlMs = Math.max(1, settings.c2c.ttlMinutes) * 60_000;
  const reserveMs = Math.max(0, settings.c2c.reserveHours) * 3_600_000;

  const { eligible, rejected } = await eligibleCards(input.baseAmountToman);
  if (!eligible.length) {
    /* Why there is no card matters more than the fact: «too small» is the
     * player's to fix, «all full» is ours, and telling them apart is the
     * difference between a useful message and «try again later». */
    if (rejected.some((r) => r.why === 'BELOW_SMS_FLOOR')) {
      const floor = await lowestFloorToman();
      throw new AllocationError('C2C_BELOW_MIN',
        `برای پرداخت کارت‌به‌کارت، مبلغ خرید باید بیشتر از ${Number(floor ?? 0).toLocaleString('fa-IR')} تومان باشد.`,
        { floorToman: floor });
    }
    if (rejected.some((r) => r.why === 'DAILY_CAP_REACHED')) {
      throw new AllocationError('C2C_DAILY_CAP',
        'سقف واریز امروز تکمیل شده است. فردا دوباره تلاش کن یا از راه دیگری پرداخت کن.');
    }
    throw new AllocationError('C2C_NO_CARD', 'در حال حاضر پرداخت کارت‌به‌کارت در دسترس نیست.');
  }

  /* One player may not hold the amount space open. The oldest is cancelled
   * rather than the new request refused, because somebody who started again
   * from the shop wants the new payment, not the abandoned one. */
  const superseded: string[] = [];
  const open = await reservingSessionsForUser(input.userId);
  const maxOpen = Math.max(1, Number(settings.c2c.maxActivePerUser) || 1);
  for (const stale of open.slice(0, Math.max(0, open.length - (maxOpen - 1)))) {
    await setSessionStatus(stale.id, 'CANCELLED');
    superseded.push(stale.id);
  }

  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const reservedUntil = new Date(now + ttlMs + reserveMs).toISOString();
  const space = suffixSpace(mode);

  for (const card of eligible) {
    for (const suffix of shuffled(space).slice(0, CANDIDATES_PER_CARD)) {
      const session = await tryInsertSession({
        intentId: input.intentId ?? null,
        userId: input.userId,
        cardId: card.id,
        baseAmountToman: input.baseAmountToman,
        amountRial: baseRial + suffix,
        suffixRial: suffix,
        expiresAt,
        reservedUntil
      });
      if (session) {
        logger.info('c2c_amount_allocated', {
          sessionId: session.id, cardId: card.id, amountRial: session.amountRial, superseded: superseded.length
        });
        return { session, card, supersededSessionIds: superseded };
      }
    }
    logger.warn('c2c_card_amount_space_busy', { cardId: card.id, baseAmountToman: input.baseAmountToman });
  }

  /* Every eligible card was full at this price. No duplicate amount is handed
   * out and no vague error is shown — the operator is told, because this means
   * either too few cards or somebody churning the space on purpose. */
  logger.error('c2c_amount_space_exhausted', { baseAmountToman: input.baseAmountToman, cards: eligible.length });
  throw new AllocationError('C2C_CAPACITY_FULL',
    'الان ظرفیت پرداخت هم‌زمان تکمیل است. چند دقیقهٔ دیگر دوباره تلاش کن.',
    { cardsTried: eligible.length });
}
