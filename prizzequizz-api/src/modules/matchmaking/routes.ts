import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { matchmakingQueue } from '../../services/matchmakingQueue.js';
import { logger } from '../../services/logger.js';
import { TicketError } from '../../services/ticketService.js';
import { bindHold, holdTicket, refundHoldById, refundHolds } from '../../services/ticketHoldService.js';
import { startRun, openRunFor, advance } from '../../services/duelRunService.js';
import { getInvite } from '../../services/gameInviteService.js';
import { voidMatchBeforeStart } from '../../services/matchEngine.js';
import type { GameModeId, PlanType } from '../../types/domain.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

/* The value bucket carries the stake: 'v25000' is 25,000 تومان a side. Same
 * shape the queue matches on, read here rather than trusted from the client. */
function ladderStake(economyType: string): number {
  const m = /^v(\d+)$/.exec(String(economyType || ''));
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
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
    const ticketTier = optionalString(body, 'ticketTier');

    /* Paid entry is TICKET-based. The ticket is HELD, not spent: it is only
     * really gone once the match starts, and any ending before that gives it
     * back — see ticketHoldService. economyType stays a pure value bucket
     * ('v25000') so equal-value players still meet. The winner's cash prize is
     * paid separately, server-side, when the match settles. */
    let holdId: string | null = null;
    if (ticketTier) {
      try {
        holdId = (await holdTicket(ctx.userId, ticketTier)).id;
      } catch (e) {
        if (e instanceof TicketError) return error(ctx.res, e.code === 'NO_TICKET' ? 402 : 400, e.code, e.message);
        throw e;
      }
    }
    /* THE LADDER'S BOOKKEEPING STARTS AND CONTINUES HERE.
     * A ticket means a fresh run at rung one. No ticket, with a rung already
     * won, means «ادامه» — the same run climbs, on the same entry, and the
     * winnings that were parked ride into it. Everything else (free play, a
     * player with nothing parked) opens no run and behaves as it always did. */
    /* Only a real party to the invite may use its key. */
    let pairKey = '';
    const wanted = String((body as any).pairKey ?? '').trim();
    if (wanted) {
      const inv = await getInvite(wanted).catch(() => null);
      if (inv && inv.status === 'accepted' && (inv.fromUserId === ctx.userId || inv.toUserId === ctx.userId)) pairKey = inv.id;
    }

    const stakeNow = ladderStake(economyType);
    if (modeId === 'duel' && economyType !== 'free' && stakeNow > 0) {
      try {
        if (ticketTier) await startRun(ctx.userId, ticketTier, stakeNow);
        else {
          const open = await openRunFor(ctx.userId);
          if (open && open.status === 'won') await advance(open.id);
        }
      } catch { /* the run is bookkeeping; it must never block entry */ }
    }
    let ticket;
    try {
      /* THE ARRANGEMENT IS HONOURED. Both sides of an accepted invitation queue
         with the invite's own id as their pair key, so they meet each other and
         nobody else — and the key is only trusted when this player really is on
         that invite, or anyone could jump into somebody else's game. */
      /* The tier travels with the ticket so the queue can report how many are
         waiting in each — the game then offers only the tiers somebody is
         actually in, instead of letting three players pick three tiers and all
         wait alone. It does NOT change who meets whom: economyType already
         keeps stakes equal. */
      ticket = await matchmakingQueue.enqueue({ userId: ctx.userId, modeId, economyType, coinStake, ticketTier: ticketTier || undefined, skill, pairKey });
    } catch (e) {
      if (holdId) { try { await refundHoldById(holdId, 'enqueue_failed'); } catch { /* best-effort */ } }
      throw e;
    }
    /* If the enqueue paired us immediately, createMatchForPlayers has already
     * moved both players' holds onto the match; binding to the queue ticket now
     * would drag ours back off it. */
    if (holdId && ticket.status !== 'matched') await bindHold(holdId, 'queue', ticket.id);
    json(ctx.res, ticket.status === 'matched' ? 200 : 202, ticket);
  });

  router.add('GET', `${base}/matchmaking/:ticketId`, async (ctx) => {
    const ticket = await matchmakingQueue.get(ctx.params.ticketId!);
    if (!ticket) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Matchmaking ticket not found');
    json(ctx.res, 200, ticket);
  });

  /* Cancel must actually cancel. It used to give up with a 409 whenever the
   * queue had already paired the player — the exact case the player complains
   * about, because from their side they pressed cancel and the game started
   * anyway. Pairing happens on the OPPONENT's enqueue, so there is always a
   * window between the tap and the request arriving.
   *
   * So: if we are still queued, cancel and refund. If a match was made but has
   * not started, void it — both players get their ticket back and the opponent
   * is told to leave. Only a match that has really begun is refused. */
  router.add('POST', `${base}/matchmaking/:ticketId/cancel`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const ticketId = ctx.params.ticketId!;
    const cancelled = await matchmakingQueue.cancel(ticketId, ctx.userId);
    if (cancelled) {
      await refundHolds('queue', cancelled.id, 'search_cancelled');
      return json(ctx.res, 200, { ...cancelled, cancelled: true });
    }

    const existing = await matchmakingQueue.get(ticketId);
    if (!existing || existing.userId !== ctx.userId) return error(ctx.res, 404, 'TICKET_NOT_FOUND', 'Matchmaking ticket not found');
    if (existing.status === 'cancelled' || existing.status === 'expired') {
      // Already cancelled by another tap or by expiry; the refund already ran.
      return json(ctx.res, 200, { ...existing, cancelled: true });
    }
    if (existing.status === 'matched' && existing.matchId) {
      const voided = await voidMatchBeforeStart(existing.matchId, 'search_cancelled');
      if (voided) return json(ctx.res, 200, { ...existing, status: 'cancelled', cancelled: true, voidedMatchId: existing.matchId });
      return error(ctx.res, 409, 'MATCH_ALREADY_STARTED', 'مسابقه شروع شده و دیگر قابل لغو نیست.');
    }
    return error(ctx.res, 409, 'CANNOT_CANCEL_TICKET', 'Ticket cannot be cancelled');
  });

  router.add('POST', `${base}/matchmaking/:ticketId/bot`, async (ctx) => {
    const ticket = await matchmakingQueue.forceBot(ctx.params.ticketId!, ctx.userId ?? 'u1');
    if (!ticket) return error(ctx.res, 409, 'BOT_FALLBACK_FAILED', 'Bot fallback failed');
    json(ctx.res, 200, ticket);
  });
}
