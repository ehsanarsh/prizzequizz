import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { matchmakingQueue } from '../../services/matchmakingQueue.js';
import { logger } from '../../services/logger.js';
import { WalletError, auditLog, findEntryByIdempotencyKey, postEntry } from '../../services/walletLedgerService.js';
import type { GameModeId, PlanType } from '../../types/domain.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

/* Paid value tiers arrive as economyType 'v<amount>' — the SERVER derives the
 * stake from it; the client can never name an arbitrary number. */
function stakeOf(economyType: string): number {
  const m = /^v(\d+)$/.exec(economyType);
  if (!m) return 0;
  const v = Number(m[1]);
  return Number.isFinite(v) && v >= 1000 && v <= 10_000_000 ? v : 0;
}

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
    const stake = stakeOf(String(economyType));
    if (String(economyType) !== 'free' && stake === 0 && String(economyType) !== 'paid') {
      return error(ctx.res, 400, 'ECONOMY_TYPE_INVALID', 'Invalid economy tier.');
    }
    const ticket = await matchmakingQueue.enqueue({ userId: ctx.userId, modeId, economyType, coinStake, skill });
    if (stake > 0) {
      // Real server-side stake: debited from the ledger, idempotent per ticket.
      try {
        await postEntry({ userId: ctx.userId, entryType: 'match_stake', kind: 'debit', amount: stake, idempotencyKey: `stake:${ticket.id}`, refType: 'matchmaking', refId: ticket.id, description: `ورودی دوئل ${stake.toLocaleString('fa-IR')} تومانی` });
      } catch (e) {
        // Not enough money → pull the ticket back out of the queue.
        const cancelled = await matchmakingQueue.cancel(ticket.id, ctx.userId);
        if (!cancelled) {
          // Matched in the tiny window before the failed charge — flag for ops.
          logger.error('stake_charge_failed_after_match', { ticketId: ticket.id, userId: ctx.userId });
          await auditLog({ userId: ctx.userId, action: 'stake_charge_failed_after_match', request: { ticketId: ticket.id, stake } });
        }
        if (e instanceof WalletError) return error(ctx.res, 402, e.code, e.message);
        throw e;
      }
    }
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
    // If a stake was charged for this ticket, give it back — exactly once.
    const staked = await findEntryByIdempotencyKey(`stake:${ticket.id}`);
    if (staked) {
      try {
        await postEntry({ userId: ctx.userId, entryType: 'stake_refund', kind: 'credit', amount: staked.amount, idempotencyKey: `stake_refund:${ticket.id}`, refType: 'matchmaking', refId: ticket.id, description: 'برگشت ورودی: حریف پیدا نشد' });
      } catch (e) {
        logger.error('stake_refund_failed', { ticketId: ticket.id, message: e instanceof Error ? e.message : 'unknown' });
      }
    }
    json(ctx.res, 200, ticket);
  });

  router.add('POST', `${base}/matchmaking/:ticketId/bot`, async (ctx) => {
    const ticket = await matchmakingQueue.forceBot(ctx.params.ticketId!, ctx.userId ?? 'u1');
    if (!ticket) return error(ctx.res, 409, 'BOT_FALLBACK_FAILED', 'Bot fallback failed');
    json(ctx.res, 200, ticket);
  });
}
