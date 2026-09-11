/* CARD-TO-CARD — the payment page, and the destination cards behind it.
 *
 * Only the destination cards for now; the transaction queue, the forwarder
 * devices and the bank patterns arrive with the stages that produce them,
 * rather than as empty screens waiting for data that cannot exist yet.
 *
 * The policy numbers (deadline, reservation window, suffix mode, per-player
 * cap) are NOT here: they live on the existing payment settings, under the
 * `payments` tab, because that is where an operator already goes to change how
 * money is taken. A second settings screen for five numbers would be a second
 * place to look.
 */
import type { RequestContext, Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { recordAdmin } from '../../services/adminAuditService.js';
import { bodyObject } from '../../utils/validation.js';
import {
  CARD_STATUSES, CardError, formatPan, listCards, removeCard, saveCard, takenTodayRial, type C2cCard
} from '../../services/c2c/cardService.js';
import { listSessions } from '../../services/c2c/sessionStore.js';
import { SessionError, cancelSession, viewSession } from '../../services/c2c/sessionService.js';

/* The operator's own card number, so it is not a secret from them — but a list
 * on a shared screen is not where it belongs either. The full number rides
 * along for the edit form; the panel shows the masked one until asked. */
async function describe(card: C2cCard): Promise<Record<string, unknown>> {
  const taken = await takenTodayRial(card.id);
  const live = await listSessions({ cardId: card.id, status: 'AWAITING', limit: 500 });
  return {
    ...card,
    panFormatted: formatPan(card.pan),
    panMasked: '**** **** **** ' + card.pan.slice(-4),
    takenTodayRial: taken,
    capLeftRial: card.dailyCapRial > 0 ? Math.max(0, card.dailyCapRial - taken) : null,
    /* How much of this card's amount space is spoken for at any one price.
     * The operator needs to see it CLIMB, not discover it at 100%. */
    openSessions: live.length
  };
}

function requireUser(ctx: RequestContext): string | null {
  if (!ctx.userId) { error(ctx.res, 401, 'UNAUTHORIZED', 'برای این کار باید وارد شوی.'); return null; }
  return ctx.userId;
}

function sessionError(ctx: RequestContext, e: unknown): void {
  if (e instanceof SessionError) {
    /* NOT_FOUND is also the answer for somebody else's session: a 403 would
     * confirm that the id exists, which is the one thing an id-guesser wants. */
    error(ctx.res, e.code === 'C2C_SESSION_NOT_FOUND' ? 404 : 409, e.code, e.message);
    return;
  }
  throw e;
}

export function registerC2cRoutes(router: Router, base: string): void {

  /* ---------- The player's own payment page ----------
   * Polled while the page is open, with the backoff the client applies
   * (2s → 5s → 15s). No limiter of its own: the global one already counts per
   * CALLER and per PATH, and this path carries the session id, so a polling
   * page gets its own 120/minute bucket — well clear of that backoff, and
   * still a wall for a client stuck in a tight loop. */
  router.add('GET', `${base}/c2c/sessions/:id`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    try {
      json(ctx.res, 200, await viewSession(ctx.params.id!, uid));
    } catch (e) { sessionError(ctx, e); }
  });

  router.add('POST', `${base}/c2c/sessions/:id/cancel`, async (ctx) => {
    const uid = requireUser(ctx); if (!uid) return;
    try {
      json(ctx.res, 200, await cancelSession(ctx.params.id!, uid));
    } catch (e) { sessionError(ctx, e); }
  });

  router.add('GET', `${base}/admin/c2c/cards`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2ccards' })) return;
    const cards = await listCards();
    json(ctx.res, 200, {
      rows: await Promise.all(cards.map(describe)),
      statuses: CARD_STATUSES
    });
  });

  router.add('POST', `${base}/admin/c2c/cards`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2ccards' })) return;
    const b = bodyObject(ctx.body) as any;
    try {
      const card = await saveCard({
        id: b.id || undefined,
        pan: b.pan != null ? String(b.pan) : undefined,
        accountNo: b.accountNo != null ? String(b.accountNo) : undefined,
        bankKey: b.bankKey != null ? String(b.bankKey) : undefined,
        bankName: b.bankName != null ? String(b.bankName) : undefined,
        holderName: b.holderName != null ? String(b.holderName) : undefined,
        status: b.status,
        priority: b.priority != null ? Number(b.priority) : undefined,
        dailyCapRial: b.dailyCapRial != null ? Number(b.dailyCapRial) : undefined,
        minAmountToman: b.minAmountToman != null ? Number(b.minAmountToman) : undefined
      });
      await recordAdmin({ adminId: (ctx as any).adminAccount?.id, action: b.id ? 'c2c_card_updated' : 'c2c_card_created', meta: { cardId: card.id, status: card.status, priority: card.priority } });
      json(ctx.res, b.id ? 200 : 201, await describe(card));
    } catch (e) {
      if (e instanceof CardError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  router.add('DELETE', `${base}/admin/c2c/cards/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'c2ccards' })) return;
    /* A card with sessions against it is history, not clutter: deleting it
     * would orphan the payments made to it. Turning it off is the way to stop
     * using one. */
    const used = await listSessions({ cardId: ctx.params.id!, limit: 1 });
    if (used.length) {
      return error(ctx.res, 409, 'CARD_IN_USE',
        'این کارت پرداخت ثبت‌شده دارد و حذف نمی‌شود. وضعیتش را «غیرفعال» کن.');
    }
    const removed = await removeCard(ctx.params.id!);
    if (!removed) return error(ctx.res, 404, 'CARD_NOT_FOUND', 'کارت یافت نشد.');
    await recordAdmin({ adminId: (ctx as any).adminAccount?.id, action: 'c2c_card_removed', meta: { cardId: ctx.params.id } });
    json(ctx.res, 200, { removed: true });
  });
}
