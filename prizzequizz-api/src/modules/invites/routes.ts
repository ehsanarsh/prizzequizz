/* THE INVITE DOOR.
 *
 * Sending one, listing the ones waiting for me, and answering. Deliberately
 * thin: an accepted invite is an ANSWER, not an entry — it tells the client
 * which screen to open, and the player then walks in through the ordinary door
 * and pays the ordinary entry. Nothing here moves a ticket or a toman, which is
 * what keeps a brand-new feature away from the parts that handle money.
 */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { currentMatchOf } from '../../services/matchEngine.js';
import {
  createInvite, incomingFor, respond, cancelInvite, getInvite, InviteError, type InviteMode
} from '../../services/gameInviteService.js';
import { notifications } from '../../services/notificationService.js';
import { getRoom } from '../../services/lastSurvivorService.js';
import { callAfterWin, pendingFor, markSeen, isTier } from '../../services/duelCallService.js';
import { getMatch } from '../../services/matchEngine.js';

const MODES: InviteMode[] = ['duel', 'ls', 'wta'];

export function registerInviteRoutes(router: Router, base: string): void {
  /* Send one. The ticket tier rides along for a duel so both sides know what
     they are being asked to play for; it is quoted back on the other screen and
     spent by the ordinary entry, not here. */
  router.add('POST', `${base}/invites`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const toUserId = String(body.toUserId ?? '').trim();
    const mode = String(body.mode ?? 'duel') as InviteMode;
    if (!toUserId) return error(ctx.res, 400, 'BAD_INVITE', 'گیرنده مشخص نیست');
    if (!MODES.includes(mode)) return error(ctx.res, 400, 'BAD_MODE', 'این حالت بازی را نمی‌شناسم');

    /* A person already inside a match is not someone to invite — «فقط
       می‌تونی به افرادی که داخل هیچ مسابقه‌ای نشده‌اند بره». */
    if (currentMatchOf(toUserId)) return error(ctx.res, 409, 'PLAYER_BUSY', 'این بازیکن الان وسط یک مسابقه است');

    const me = await repositories.users.findById(ctx.userId);
    const them = await repositories.users.findById(toUserId);
    if (!them) return error(ctx.res, 404, 'USER_NOT_FOUND', 'این بازیکن پیدا نشد');

    /* The room's own topic travels with the invite, so accepting lands on the
       ticket screen FOR that room instead of on topic-selection, where the
       invitee has to guess which room they were asked into — and picking the
       wrong topic puts them in a different room entirely. */
    let roomTopic = '';
    const roomId = String(body.roomId ?? '');
    if (roomId) { try { roomTopic = (await getRoom(roomId))?.topic ?? ''; } catch { /* best effort */ } }

    try {
      const inv = await createInvite({
        fromUserId: ctx.userId,
        fromName: me?.displayName || me?.username || 'بازیکن',
        toUserId, mode,
        ticketTier: String(body.ticketTier ?? ''),
        /* Friendly duels are arranged for coins instead of a ticket. The number
           is the sender's own — they type it — so it is cleaned and capped by
           the service, not trusted as it arrives. */
        coinStake: Number(body.coinStake ?? 0),
        roomId, roomTopic,
        fromRoomId: String(body.fromRoomId ?? '')
      });
      /* Reaches them even with the game closed — an invite nobody sees is not
         an invite. Best-effort: a push that fails must not fail the send. */
      await notifications.create({
        userId: toUserId, type: 'game_invite', title: 'دعوت به بازی',
        body: `${inv.fromName} تو را به بازی دعوت کرد`,
        data: { inviteId: inv.id, mode: inv.mode, ticketTier: inv.ticketTier, coinStake: inv.coinStake, roomId: inv.roomId, roomTopic: inv.roomTopic, url: '/' },
        push: true
      }).catch(() => undefined);
      json(ctx.res, 201, publicInvite(inv));
    } catch (e) {
      if (e instanceof InviteError) {
        return error(ctx.res, e.code === 'ALREADY_INVITED' ? 409 : 400, e.code, e.message);
      }
      throw e;
    }
  });

  /* What is waiting for me. Polled by the client; also what a push wakes it to
     come and read. */
  router.add('GET', `${base}/invites/incoming`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const list = await incomingFor(ctx.userId);
    json(ctx.res, 200, { invites: list.map(publicInvite) });
  });

  router.add('POST', `${base}/invites/:id/respond`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const accept = !!(ctx.body as any)?.accept;
    try {
      const inv = await respond(ctx.params.id!, ctx.userId, accept);
      /* The sender is told either way, so «منتظر جواب» does not sit there for
         a minute after the answer already came. */
      await notifications.create({
        userId: inv.fromUserId, type: 'game_invite_reply',
        title: accept ? 'دعوتت پذیرفته شد' : 'دعوتت رد شد',
        body: accept ? 'حریفت دارد می‌آید' : 'الان نمی‌تواند بازی کند',
        data: { inviteId: inv.id, accepted: accept, mode: inv.mode, roomId: inv.roomId }, push: false
      }).catch(() => undefined);
      json(ctx.res, 200, publicInvite(inv));
    } catch (e) {
      if (e instanceof InviteError) return error(ctx.res, e.code === 'NOT_YOURS' ? 403 : 409, e.code, e.message);
      throw e;
    }
  });

  /* The sender's side of the wait. They are sitting on «منتظر جواب» and need to
     know the moment it turns — an invitation nobody can see the answer to is
     just a message into the dark. */
  router.add('GET', `${base}/invites/:id`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const inv = await getInvite(ctx.params.id!);
    if (!inv) return error(ctx.res, 404, 'INVITE_NOT_FOUND', 'این دعوت پیدا نشد');
    if (inv.fromUserId !== ctx.userId && inv.toUserId !== ctx.userId) {
      return error(ctx.res, 403, 'NOT_YOURS', 'این دعوت برای تو نیست');
    }
    json(ctx.res, 200, publicInvite(inv));
  });

  router.add('POST', `${base}/invites/:id/cancel`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    await cancelInvite(ctx.params.id!, ctx.userId);
    json(ctx.res, 200, { cancelled: true });
  });

  /* ── «حریفت ادامه داد» ──────────────────────────────────────────────────
     The winner's client says it has gone on to the next stage; the loser is
     told, once, while it is still true. The caller supplies only the match id —
     WHO won it and WHO lost it are read from the match itself, so a client
     cannot summon a stranger or nominate itself the winner of a game it lost. */
  router.add('POST', `${base}/duel-calls`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const matchId = String(body.matchId ?? '').trim();
    if (!matchId) return error(ctx.res, 400, 'BAD_MATCH', 'مسابقه مشخص نیست');
    /* The tier is the whole point of the call — «میتونی با بلیط آبی حقتو
       ازش بگیری» — so a call that cannot name one is not sent. */
    const tier = String(body.tier ?? '').toLowerCase();
    if (!isTier(tier)) return error(ctx.res, 400, 'BAD_TIER', 'بلیطی برای این مرحله وجود ندارد');

    let match;
    try { match = await getMatch(matchId); } catch { return error(ctx.res, 404, 'MATCH_NOT_FOUND', 'این مسابقه پیدا نشد'); }
    /* Only the real winner of a real, finished duel gets to knock. */
    if (match.phase !== 'finished' && match.phase !== 'result') return error(ctx.res, 409, 'MATCH_NOT_FINISHED', 'این مسابقه هنوز تمام نشده');
    if (!match.winnerUserId || String(match.winnerUserId) !== ctx.userId) return error(ctx.res, 403, 'NOT_THE_WINNER', 'این مسابقه را تو نبردی');
    const loser = (match.players ?? []).map((p: any) => String(p.userId)).find((uid: string) => uid !== ctx.userId);
    /* A duel against a bot has nobody on the other side to tell. */
    if (!loser) return json(ctx.res, 200, { called: false, reason: 'NO_OPPONENT' });

    const me = await repositories.users.findById(ctx.userId);
    const call = await callAfterWin({
      toUserId: loser, fromUserId: ctx.userId,
      fromName: me?.displayName || me?.username || 'حریف',
      tier,
      matchId, stage: Number(body.stage ?? 2)
    });
    json(ctx.res, 201, { called: true, call: publicCall(call) });
  });

  /* What the loser's ordinary poll picks up. */
  router.add('GET', `${base}/duel-calls`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const list = await pendingFor(ctx.userId);
    json(ctx.res, 200, { calls: list.map(publicCall) });
  });

  /* Shown — so it is not shown again on the next tick. */
  router.add('POST', `${base}/duel-calls/:id/seen`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const ok = await markSeen(ctx.params.id!, ctx.userId);
    json(ctx.res, 200, { seen: ok });
  });
}

function publicCall(c: any) {
  return {
    id: c.id, fromUserId: c.fromUserId, fromName: c.fromName,
    tier: c.tier || 'blue', matchId: c.matchId, stage: c.stage,
    secondsLeft: Math.max(0, Math.round((c.expiresAt - Date.now()) / 1000))
  };
}

function publicInvite(inv: any) {
  return {
    id: inv.id, fromUserId: inv.fromUserId, fromName: inv.fromName,
    mode: inv.mode, ticketTier: inv.ticketTier, coinStake: inv.coinStake ?? 0,
    roomId: inv.roomId, roomTopic: inv.roomTopic,
    status: inv.status, expiresAt: inv.expiresAt,
    secondsLeft: Math.max(0, Math.round((inv.expiresAt - Date.now()) / 1000))
  };
}
