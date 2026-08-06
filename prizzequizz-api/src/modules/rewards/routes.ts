/* DAILY REWARD + WHEEL — player endpoints. The prize is chosen and paid here;
 * the client is only told which segment to stop on so the animation agrees with
 * what already happened. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { RewardsError, claimDaily, spin, status } from '../../services/rewardsService.js';

function fail(res: any, e: unknown): boolean {
  if (e instanceof RewardsError) {
    const code = e.code === 'WHEEL_COOLDOWN' || e.code === 'ALREADY_CLAIMED' ? 429 : 422;
    error(res, code, e.code, e.message);
    return true;
  }
  return false;
}

export function registerRewardsRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/rewards/status`, async (ctx) => {
    json(ctx.res, 200, await status(ctx.userId ?? 'u1'));
  });

  router.add('POST', `${base}/rewards/wheel/spin`, async (ctx) => {
    try { json(ctx.res, 200, await spin(ctx.userId ?? 'u1')); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });

  router.add('POST', `${base}/rewards/daily/claim`, async (ctx) => {
    try { json(ctx.res, 200, await claimDaily(ctx.userId ?? 'u1')); }
    catch (e) { if (!fail(ctx.res, e)) throw e; }
  });
}
