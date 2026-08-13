/* QUICK-CHAT PACKS — the shelf and the till. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import {
  ChatPackError, CHAT_PACK_MAX_LEN, CHAT_PACK_MAX_PHRASES,
  listPacks, packsFor, purchasePack, savePacks
} from '../../services/chatPackService.js';
import { requireAdmin } from '../../services/adminGuard.js';

function fail(res: any, e: unknown): boolean {
  if (e instanceof ChatPackError) {
    const status = e.code === 'PACK_NOT_FOUND' ? 404
      : (e.code === 'INSUFFICIENT_COINS' || e.code === 'INSUFFICIENT_FUNDS') ? 409
      : 422;
    error(res, status, e.code, e.message);
    return true;
  }
  return false;
}

export function registerChatPackRoutes(router: Router, base: string): void {
  /* What this player may say. Locked packs come back priced but silent. */
  router.add('GET', `${base}/chat-packs`, async (ctx) => {
    json(ctx.res, 200, { packs: await packsFor(ctx.userId ?? 'u1') });
  });

  router.add('POST', `${base}/chat-packs/:key/purchase`, async (ctx) => {
    const b = (ctx.body ?? {}) as any;
    try {
      json(ctx.res, 200, await purchasePack({
        userId: ctx.userId ?? 'u1',
        key: String(ctx.params.key ?? ''),
        idempotencyKey: String(b.idempotencyKey ?? '')
      }));
    } catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  /* ---- admin ---- */
  router.add('GET', `${base}/admin/chat-packs`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'chatpacks' })) return;
    json(ctx.res, 200, {
      packs: await listPacks(),
      maxPhrases: CHAT_PACK_MAX_PHRASES,
      maxLength: CHAT_PACK_MAX_LEN
    });
  });

  router.add('PUT', `${base}/admin/chat-packs`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'chatpacks' })) return;
    try { json(ctx.res, 200, { packs: await savePacks(ctx.body) }); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });
}
