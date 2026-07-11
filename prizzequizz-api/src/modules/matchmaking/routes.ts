import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { matchmakingQueue } from '../../services/matchmakingQueue.js';
import type { GameModeId, PlanType } from '../../types/domain.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

export function registerMatchmakingRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/matchmaking/stats`, async (ctx) => {
    json(ctx.res, 200, await matchmakingQueue.stats());
  });

  router.add('POST', `${base}/matchmaking/enqueue`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const modeId = requiredString(body, 'modeId') as GameModeId;
    const economyType = (optionalString(body, 'economyType', 'free') || 'free') as PlanType;
    const entry = typeof body.entry === 'object' && body.entry ? body.entry as Record<string, unknown> : {};
    const coinStake = entry.coinStake === undefined ? undefined : Number(entry.coinStake);
    const skill = body.skill === undefined ? undefined : Number(body.skill);
    const ticket = await matchmakingQueue.enqueue({ userId: ctx.userId ?? 'u1', modeId, economyType, coinStake, skill });
    json(ctx.res, ticket.status === 'matched' ? 200 : 202, ticket);
  });

  router.add('GET', `${base}/matchmaking/:ticketId`, async (ctx) => {
    const ticket = await matchmakingQueue.get(ctx.params.ticketId!);
    if (!ticket) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Matchmaking ticket not found');
    json(ctx.res, 200, ticket);
  });

  router.add('POST', `${base}/matchmaking/:ticketId/cancel`, async (ctx) => {
    const ticket = await matchmakingQueue.cancel(ctx.params.ticketId!, ctx.userId ?? 'u1');
    if (!ticket) return error(ctx.res, 409, 'CANNOT_CANCEL_TICKET', 'Ticket cannot be cancelled');
    json(ctx.res, 200, ticket);
  });

  router.add('POST', `${base}/matchmaking/:ticketId/bot`, async (ctx) => {
    const ticket = await matchmakingQueue.forceBot(ctx.params.ticketId!, ctx.userId ?? 'u1');
    if (!ticket) return error(ctx.res, 409, 'BOT_FALLBACK_FAILED', 'Bot fallback failed');
    json(ctx.res, 200, ticket);
  });
}
