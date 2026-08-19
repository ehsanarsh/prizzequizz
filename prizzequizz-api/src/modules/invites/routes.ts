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

    try {
      const inv = await createInvite({
        fromUserId: ctx.userId,
        fromName: me?.displayName || me?.username || 'بازیکن',
        toUserId, mode,
        ticketTier: String(body.ticketTier ?? ''),
        roomId: String(body.roomId ?? ''),
        fromRoomId: String(body.fromRoomId ?? '')
      });
      /* Reaches them even with the game closed — an invite nobody sees is not
         an invite. Best-effort: a push that fails must not fail the send. */
      await notifications.create({
        userId: toUserId, type: 'game_invite', title: 'دعوت به بازی',
        body: `${inv.fromName} تو را به بازی دعوت کرد`,
        data: { inviteId: inv.id, mode: inv.mode, ticketTier: inv.ticketTier, roomId: inv.roomId, url: '/' },
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
}

function publicInvite(inv: any) {
  return {
    id: inv.id, fromUserId: inv.fromUserId, fromName: inv.fromName,
    mode: inv.mode, ticketTier: inv.ticketTier, roomId: inv.roomId,
    status: inv.status, expiresAt: inv.expiresAt,
    secondsLeft: Math.max(0, Math.round((inv.expiresAt - Date.now()) / 1000))
  };
}
