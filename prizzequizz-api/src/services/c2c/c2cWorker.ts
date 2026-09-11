/* THE SWEEPER.
 *
 * Three things rot if nothing tends them, and all three end in money:
 *
 * 1. A SESSION PAST ITS DEADLINE still reads «منتظر واریز». Reading one
 *    expires it, but only for whoever opens the page — and the player who
 *    closed it is exactly the one who never will.
 *
 * 2. A RESERVATION THAT IS NEVER RELEASED fills the card's amount space. Each
 *    card has 99 slots per price; a payment that nobody completes holds one
 *    forever, and when they are gone every new payment is refused with
 *    «ظرفیت پر است» for a queue of abandoned pages. Releasing is what makes
 *    the space a space rather than a tally.
 *
 * 3. A DELIVERY INTERRUPTED MID-FLIGHT leaves a claimed `order_fulfilments`
 *    row with nothing granted — matrix row ۵. The player paid. Nobody else is
 *    coming to finish it.
 *
 * The reservation window is the reason (2) is not simply «delete the expired
 * ones»: an amount stays reserved for hours AFTER its page dies, so a transfer
 * made late is still recognisable instead of landing on the next player given
 * that figure. Releasing early would attach real money to the wrong order.
 */
import { getPaymentSettings } from '../paymentGatewayService.js';
import { listSessions, setSessionStatus, type C2cSession } from './sessionStore.js';
import { logger } from '../logger.js';

export interface SweepResult {
  expired: number;
  released: number;
  /** Ids touched, so a caller (or a test) can say exactly what happened. */
  expiredIds: string[];
  releasedIds: string[];
}

/**
 * One pass. Safe to run concurrently with itself and with a player's own
 * read-time expiry: every transition is idempotent and moves in one direction
 * only, so two sweepers racing produce the same end state as one.
 */
export async function sweepSessions(now = Date.now()): Promise<SweepResult> {
  const settings = await getPaymentSettings();
  const cooldownMs = Math.max(0, Number(settings.c2c.cancelCooldownMinutes) || 0) * 60_000;
  const out: SweepResult = { expired: 0, released: 0, expiredIds: [], releasedIds: [] };

  /* Deadline passed, page gone. The amount stays reserved — this is only the
   * change of what the player is told. */
  for (const s of await listSessions({ status: 'AWAITING', limit: 500 })) {
    if (Date.parse(s.expiresAt) > now) continue;
    await setSessionStatus(s.id, 'EXPIRED');
    out.expired++; out.expiredIds.push(s.id);
  }

  /* Reservation over: the slot goes back. After this the same figure may be
   * handed to someone else, which is why it waits for `reserved_until` and
   * not for the deadline. */
  for (const s of await listSessions({ status: 'EXPIRED', limit: 500 })) {
    if (Date.parse(s.reservedUntil) > now) continue;
    await setSessionStatus(s.id, 'RELEASED');
    out.released++; out.releasedIds.push(s.id);
  }

  /* A cancelled payment gets its own, shorter window: the player tapped
   * «انصراف» and may still have transferred seconds later, but they are not
   * going to do it three hours from now. */
  for (const s of await listSessions({ status: 'CANCELLED', limit: 500 })) {
    const freeAt = Date.parse(s.updatedAt) + cooldownMs;
    if (freeAt > now) continue;
    await setSessionStatus(s.id, 'RELEASED');
    out.released++; out.releasedIds.push(s.id);
  }

  if (out.expired || out.released) logger.info('c2c_sweep', { expired: out.expired, released: out.released });
  return out;
}

/**
 * Deliveries that were claimed and never finished.
 *
 * The claim carries a lease; once it lapses another caller may take the row
 * over. That is exactly what this is — the caller nobody else was going to
 * send. It re-runs the SAME idempotent fulfilment, so a row that actually
 * completed elsewhere is left alone.
 */
export async function retryStuckFulfilments(): Promise<{ retried: number; ids: string[] }> {
  const { listStuck } = await import('../orderFulfilmentService.js');
  const { retryFulfilment } = await import('./settlementService.js');
  const stuck = await listStuck();
  const ids: string[] = [];
  for (const rec of stuck) {
    try {
      await retryFulfilment(rec.ref);
      ids.push(rec.ref);
    } catch (e) {
      /* Logged and left claimed: the debt is still recorded and the next pass
       * will try again. Silence here would be a paid-for order nobody ever
       * delivers. */
      logger.error('c2c_fulfilment_retry_failed', { ref: rec.ref, message: e instanceof Error ? e.message : 'unknown' });
    }
  }
  if (ids.length) logger.warn('c2c_fulfilments_retried', { count: ids.length });
  return { retried: ids.length, ids };
}

let timer: NodeJS.Timeout | null = null;

/** Every minute: fine for a 20-minute deadline and a 24-hour reservation. */
export const SWEEP_INTERVAL_MS = 60_000;

export function startC2cWorker(): void {
  if (timer) return;
  if (process.env.C2C_WORKER === 'false') return;
  timer = setInterval(() => {
    void sweepSessions().catch((e) => logger.error('c2c_sweep_failed', { message: e instanceof Error ? e.message : 'unknown' }));
    void retryStuckFulfilments().catch((e) => logger.error('c2c_retry_failed', { message: e instanceof Error ? e.message : 'unknown' }));
  }, SWEEP_INTERVAL_MS);
  /* Never the reason a process stays alive. */
  timer.unref?.();
  logger.info('c2c_worker_started', { intervalMs: SWEEP_INTERVAL_MS });
}

export function stopC2cWorker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export type { C2cSession };
