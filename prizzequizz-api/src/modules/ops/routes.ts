import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { getDeepHealth } from '../../services/healthService.js';
import { getMetricsJson, getMetricsText } from '../../services/metrics.js';
import { realtimeRooms } from '../../realtime/roomRegistry.js';
import { verifyDatabase, getMigrationStatus } from '../../database/migrationService.js';
import { requireAdmin } from '../../services/adminGuard.js';

export function registerOpsRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/health/deep`, async (ctx) => {
    const health = await getDeepHealth();
    json(ctx.res, health.ok ? 200 : 503, health);
  });


  router.add('GET', `${base}/admin/database/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await getMigrationStatus());
  });

  router.add('GET', `${base}/admin/database/verify`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const verification = await verifyDatabase();
    json(ctx.res, verification.ok ? 200 : 503, verification);
  });

  router.add('GET', `${base}/metrics`, (ctx) => {
    const format = ctx.query.get('format');
    if (format === 'prometheus') {
      ctx.res.statusCode = 200;
      ctx.res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      ctx.res.end(getMetricsText());
      return;
    }
    json(ctx.res, 200, getMetricsJson());
  });

  router.add('GET', `${base}/realtime/stats`, (ctx) => {
    json(ctx.res, 200, realtimeRooms.stats());
  });
}
