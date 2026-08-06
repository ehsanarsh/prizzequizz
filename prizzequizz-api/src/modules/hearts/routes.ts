/* HEARTS — the one balance, with its regeneration applied on read. */
import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { getHearts } from '../../services/heartService.js';

export function registerHeartRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/hearts`, async (ctx) => {
    json(ctx.res, 200, await getHearts(ctx.userId ?? 'u1'));
  });
}
