/* HEARTS — the one balance, with its regeneration applied on read. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { HeartError, getHearts } from '../../services/heartService.js';

export function registerHeartRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/hearts`, async (ctx) => {
    /* An id with no user behind it is a 404, not a crash. Reading hearts is the
     * first call the header makes on every start, so letting HeartError escape
     * turned an unknown account into a 500 on the app's very first request. */
    try { json(ctx.res, 200, await getHearts(ctx.userId ?? 'u1')); }
    catch (e) {
      if (e instanceof HeartError) {
        return error(ctx.res, e.code === 'USER_NOT_FOUND' ? 404 : 422, e.code, e.message);
      }
      throw e;
    }
  });
}
