/* LIFELINES — player-facing inventory + use, and the admin catalogue. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { bodyObject } from '../../utils/validation.js';
import {
  LifelineError, activeCatalog, getCatalog, saveCatalog, inventoryFor, grantLifeline, useLifeline, usedIn, purchaseLifeline
} from '../../services/lifelineService.js';
import { repositories } from '../../repositories/index.js';

export function registerLifelineRoutes(router: Router, base: string): void {
  /* Everything the row of help buttons needs: what exists, how many I own, and
   * which I have already spent in this match. */
  router.add('GET', `${base}/lifelines`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const scopeId = ctx.query.get('scopeId') || '';
    const [catalog, inventory, used] = await Promise.all([
      activeCatalog(),
      inventoryFor(ctx.userId),
      scopeId ? usedIn(scopeId, ctx.userId) : Promise.resolve([] as string[])
    ]);
    json(ctx.res, 200, { catalog, inventory, used });
  });

  /* Spend one. The server decides — owning none, or having already used this
   * help in this match, is refused here rather than in the browser. */
  router.add('POST', `${base}/lifelines/:key/use`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const body = bodyObject(ctx.body) as any;
    const scopeId = String(body.scopeId || '').trim();
    try {
      const res = await useLifeline(ctx.userId, ctx.params.key!, scopeId);
      json(ctx.res, 200, { key: res.key, remaining: res.remaining, seconds: res.seconds, label: res.def.label });
    } catch (e) {
      if (e instanceof LifelineError) {
        const status = e.code === 'LIFELINE_EMPTY' ? 402 : e.code === 'LIFELINE_UNKNOWN' ? 404 : 409;
        return error(ctx.res, status, e.code, e.message);
      }
      throw e;
    }
  });

  /* Buy one or more. The price comes from the catalogue and the money leaves
   * through the wallet ledger, so neither is the browser's to decide. */
  router.add('POST', `${base}/lifelines/:key/buy`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const body = bodyObject(ctx.body) as any;
    try {
      const res = await purchaseLifeline({
        userId: ctx.userId, key: ctx.params.key!, qty: body.qty,
        idempotencyKey: String(body.idempotencyKey || `ll:${ctx.userId}:${ctx.params.key}:${Date.now()}`),
        ip: (ctx.req.socket as any)?.remoteAddress
      });
      json(ctx.res, 200, res);
    } catch (e) {
      if (e instanceof LifelineError) return error(ctx.res, e.code === 'LIFELINE_UNKNOWN' ? 404 : 422, e.code, e.message);
      const msg = e instanceof Error ? e.message : 'خطا';
      return error(ctx.res, 402, 'PURCHASE_FAILED', /INSUFFICIENT|موجودی/.test(msg) ? 'موجودی کیف پول کافی نیست.' : msg);
    }
  });

  // ---- admin ----
  const guard = (ctx: any) => requireAdmin(ctx, { tab: 'lifelines' });

  router.add('GET', `${base}/admin/lifelines`, async (ctx) => {
    if (!guard(ctx)) return;
    json(ctx.res, 200, { rows: await getCatalog() });
  });

  router.add('PUT', `${base}/admin/lifelines`, async (ctx) => {
    if (!guard(ctx)) return;
    const body = bodyObject(ctx.body) as any;
    const rows = Array.isArray(body.rows) ? body.rows : [];
    try { json(ctx.res, 200, { rows: await saveCatalog(rows) }); }
    catch (e) {
      if (e instanceof LifelineError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });

  /* Hand helps out — to one player by id, username or phone, or to everybody. */
  router.add('POST', `${base}/admin/lifelines/grant`, async (ctx) => {
    if (!guard(ctx)) return;
    const body = bodyObject(ctx.body) as any;
    const key = String(body.key || '').trim();
    const amount = Math.round(Number(body.amount) || 0);
    if (!key) return error(ctx.res, 422, 'KEY_REQUIRED', 'کمک را انتخاب کن.');
    if (!amount) return error(ctx.res, 422, 'AMOUNT_REQUIRED', 'تعداد را وارد کن.');

    try {
      if (body.everyone) {
        const users = await repositories.users.list(100000);
        let n = 0;
        for (const u of users as any[]) { try { await grantLifeline(u.id, key, amount); n++; } catch { /* skip */ } }
        return json(ctx.res, 200, { granted: n, everyone: true });
      }
      const who = String(body.userId || body.user || '').trim();
      if (!who) return error(ctx.res, 422, 'USER_REQUIRED', 'کاربر را مشخص کن.');
      const user = (await repositories.users.findById(who))
        ?? (await repositories.users.findByPhone(who))
        ?? null;
      if (!user) return error(ctx.res, 404, 'USER_NOT_FOUND', 'کاربر پیدا نشد.');
      const inventory = await grantLifeline(user.id, key, amount);
      json(ctx.res, 200, { granted: 1, userId: user.id, inventory });
    } catch (e) {
      if (e instanceof LifelineError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  });
}
