/* MISSIONS — the board a player sees, and claiming a finished one. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import {
  MissionError, boardFor, claim, record, recordLogin, METRICS, type Metric,
  boxFor, openBox, getBoxConfig, setBoxConfig
} from '../../services/missionService.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { recordAdmin } from '../../services/adminAuditService.js';

export function registerMissionRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/missions`, async (ctx) => {
    const userId = ctx.userId ?? 'u1';
    /* Opening the app IS the login signal, and this is the request that proves
     * it: the home strip loads the board on every start. Recorded BEFORE the
     * board is built so today's streak is already in the numbers the player is
     * about to look at. Doing it at /auth/otp/verify instead would only ever
     * count the days someone typed an SMS code, not the days they played. */
    await recordLogin(userId);
    json(ctx.res, 200, await boardFor(userId));
  });

  router.add('POST', `${base}/missions/:id/claim`, async (ctx) => {
    try { json(ctx.res, 200, await claim(ctx.userId ?? 'u1', ctx.params.id!)); }
    catch (e) {
      if (e instanceof MissionError) {
        const status = e.code === 'MISSION_NOT_FOUND' ? 404 : e.code === 'ALREADY_CLAIMED' ? 409 : 422;
        return error(ctx.res, status, e.code, e.message);
      }
      throw e;
    }
  });

  /* Client-reported activity for the things only the client can see — opening
   * the shop, watching an ad. Anything with money or a score behind it is
   * reported by the server that already knows it happened, never from here. */
  const CLIENT_METRICS = new Set<Metric>(['shopVisit', 'adWatched', 'login']);
  router.add('POST', `${base}/missions/event`, async (ctx) => {
    const b = (ctx.body ?? {}) as any;
    const metric = String(b.metric ?? '') as Metric;
    if (!CLIENT_METRICS.has(metric)) {
      return error(ctx.res, 422, 'METRIC_NOT_CLIENT_REPORTABLE',
        'این شاخص از سمت بازی گزارش نمی‌شود.');
    }
    if (metric === 'login') await recordLogin(ctx.userId ?? 'u1');
    else await record(ctx.userId ?? 'u1', metric, 1, String(b.scope ?? ''));
    json(ctx.res, 200, { ok: true });
  });

  /* THE BOX. Its own endpoints because it has its own life: earned by
   * finishing the set, opened by a tap, and paid exactly once. */
  router.add('GET', `${base}/missions/box`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    json(ctx.res, 200, await boxFor(ctx.userId));
  });

  router.add('POST', `${base}/missions/box/open`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try { json(ctx.res, 200, await openBox(ctx.userId)); }
    catch (e) {
      if (e instanceof MissionError) {
        return error(ctx.res, e.code === 'BOX_ALREADY_OPEN' ? 409 : 422, e.code, e.message);
      }
      throw e;
    }
  });

  /* What is inside it, for the operator. */
  router.add('GET', `${base}/admin/missions/box`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'missions' })) return;
    json(ctx.res, 200, await getBoxConfig());
  });

  router.add('PUT', `${base}/admin/missions/box`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'missions' })) return;
    const next = await setBoxConfig((ctx.body ?? {}) as any);
    await recordAdmin({ action: 'mission_box_config', meta: next as any });
    json(ctx.res, 200, next);
  });

  router.add('GET', `${base}/missions/metrics`, async (ctx) => {
    json(ctx.res, 200, { metrics: METRICS });
  });
}
