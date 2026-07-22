import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { matchmakingQueue } from '../../services/matchmakingQueue.js';
import { logger } from '../../services/logger.js';
import { TicketError, consumeTicket, refundTicket } from '../../services/ticketService.js';
import type { GameModeId, PlanType } from '../../types/domain.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

// Which ticket tier was consumed for a given matchmaking ticket, so cancel can
// refund exactly that one. In-memory is fine: a cancel happens in the same
// process during the same search session.
const consumedTicketTier = new Map<string, string>();

export function registerMatchmakingRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/matchmaking/stats`, async (ctx) => {
    json(ctx.res, 200, await matchmakingQueue.stats());
  });

  router.add('POST', `${base}/matchmaking/enqueue`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const body = bodyObject(ctx.body);
    const modeId = requiredString(body, 'modeId') as GameModeId;
    const economyType = (optionalString(body, 'economyType', 'free') || 'free') as PlanType;
    const entry = typeof body.entry === 'object' && body.entry ? body.entry as Record<string, unknown> : {};
    const coinStake = entry.coinStake === undefined ? undefined : Number(entry.coinStake);
    const skill = body.skill === undefined ? undefined : Number(body.skill);
    const ticketTier = optionalString(body, 'ticketTier');

    // Paid entry is TICKET-based: consume ONE ticket up front (atomic, no wallet
    // debit). If the player has no ticket we never enqueue. economyType stays a
    // pure value bucket ('v25000') so equal-value players still meet. The ticket
    // is refunded on cancel (no opponent). The winner's cash prize is paid
    // separately, server-side, when the match settles.
    if (ticketTier) {
      try {
        await consumeTicket(ctx.userId, ticketTier);
      } catch (e) {
        if (e instanceof TicketError) return error(ctx.res, e.code === 'NO_TICKET' ? 402 : 400, e.code, e.message);
        throw e;
      }
    }
    let ticket;
    try {
      ticket = await matchmakingQueue.enqueue({ userId: ctx.userId, modeId, economyType, coinStake, skill });
    } catch (e) {
      if (ticketTier) { try { await refundTicket(ctx.userId, ticketTier); } catch { /* best-effort */ } }
      throw e;
    }
    if (ticketTier) consumedTicketTier.set(ticket.id, ticketTier);
    json(ctx.res, ticket.status === 'matched' ? 200 : 202, ticket);
  });

  router.add('GET', `${base}/matchmaking/:ticketId`, async (ctx) => {
    const ticket = await matchmakingQueue.get(ctx.params.ticketId!);
    if (!ticket) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Matchmaking ticket not found');
    json(ctx.res, 200, ticket);
  });

  router.add('POST', `${base}/matchmaking/:ticketId/cancel`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const ticket = await matchmakingQueue.cancel(ctx.params.ticketId!, ctx.userId);
    if (!ticket) return error(ctx.res, 409, 'CANNOT_CANCEL_TICKET', 'Ticket cannot be cancelled');
    // No opponent → give the match ticket back (exactly once).
    const tier = consumedTicketTier.get(ticket.id);
    if (tier) {
      consumedTicketTier.delete(ticket.id);
      try { await refundTicket(ctx.userId, tier); }
      catch (e) { logger.error('ticket_refund_failed', { ticketId: ticket.id, message: e instanceof Error ? e.message : 'unknown' }); }
    }
    json(ctx.res, 200, ticket);
  });

  router.add('POST', `${base}/matchmaking/:ticketId/bot`, async (ctx) => {
    const ticket = await matchmakingQueue.forceBot(ctx.params.ticketId!, ctx.userId ?? 'u1');
    if (!ticket) return error(ctx.res, 409, 'BOT_FALLBACK_FAILED', 'Bot fallback failed');
    json(ctx.res, 200, ticket);
  });
}
