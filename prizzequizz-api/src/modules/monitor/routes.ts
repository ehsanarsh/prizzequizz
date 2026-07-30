/* SERVER MONITORING — agent ingest (server API key) + admin management. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { bodyObject } from '../../utils/validation.js';
import { listServers, createServer, updateServer, removeServer, rotateKey, overview, historyFor, ingestByKey, getServer } from '../../services/serverMonitorService.js';

export function registerServerMonitorRoutes(router: Router, base: string): void {
  // Agent ingest — authed by the server's own API key (NOT an admin key).
  router.add('POST', `${base}/monitor/ingest`, async (ctx) => {
    const key = String(ctx.req.headers['x-monitor-key'] ?? '');
    if (!key) return error(ctx.res, 401, 'MONITOR_KEY_REQUIRED', 'x-monitor-key required.');
    const b = bodyObject(ctx.body) as any;
    const res = await ingestByKey(key, {
      cpuPercent: b.cpuPercent ?? b.cpu, memUsed: b.memUsed, memTotal: b.memTotal,
      diskUsed: b.diskUsed, diskTotal: b.diskTotal, load1: b.load1, load5: b.load5, load15: b.load15,
      uptimeSec: b.uptimeSec ?? b.uptime, netRx: b.netRx, netTx: b.netTx, extra: b.extra
    });
    if (!res.ok) return error(ctx.res, 403, 'MONITOR_KEY_INVALID', 'کلید سرور نامعتبر یا غیرفعال است.');
    json(ctx.res, 200, { ok: true, serverId: res.serverId });
  });

  const guard = (ctx: any) => requireAdmin(ctx, { tab: 'monitoring' });

  router.add('GET', `${base}/admin/monitor/overview`, async (ctx) => { if (!guard(ctx)) return; json(ctx.res, 200, { rows: await overview() }); });
  router.add('GET', `${base}/admin/monitor/servers`, async (ctx) => { if (!guard(ctx)) return; json(ctx.res, 200, { rows: (await listServers()).map((s) => ({ ...s, apiKeyMask: s.apiKey ? '••••' + s.apiKey.slice(-6) : '' })) }); });
  // The full key is shown ONCE on create/rotate (so the agent can be configured).
  router.add('POST', `${base}/admin/monitor/servers`, async (ctx) => {
    if (!guard(ctx)) return; const b = bodyObject(ctx.body) as any;
    if (b.id) { const up = await updateServer(String(b.id), { name: b.name, host: b.host, tags: b.tags, enabled: b.enabled }); if (!up) return error(ctx.res, 404, 'SERVER_NOT_FOUND', 'یافت نشد.'); return json(ctx.res, 200, up); }
    if (!b.name) return error(ctx.res, 422, 'NAME_REQUIRED', 'نام سرور لازم است.');
    const s = await createServer({ name: String(b.name), host: b.host ? String(b.host) : '', tags: b.tags ? String(b.tags) : '' });
    json(ctx.res, 201, { ...s, apiKeyFull: s.apiKey });
  });
  router.add('POST', `${base}/admin/monitor/servers/:id/rotate`, async (ctx) => { if (!guard(ctx)) return; const key = await rotateKey(ctx.params.id!); if (!key) return error(ctx.res, 404, 'SERVER_NOT_FOUND', 'یافت نشد.'); json(ctx.res, 200, { apiKeyFull: key }); });
  router.add('DELETE', `${base}/admin/monitor/servers/:id`, async (ctx) => { if (!guard(ctx)) return; const ok = await removeServer(ctx.params.id!); if (!ok) return error(ctx.res, 400, 'CANNOT_DELETE', 'این سرور قابل حذف نیست.'); json(ctx.res, 200, { removed: true }); });
  router.add('GET', `${base}/admin/monitor/servers/:id/history`, async (ctx) => { if (!guard(ctx)) return; const s = await getServer(ctx.params.id!); if (!s) return error(ctx.res, 404, 'SERVER_NOT_FOUND', 'یافت نشد.'); json(ctx.res, 200, { rows: await historyFor(ctx.params.id!, Number(ctx.query.get('limit') ?? 60)) }); });
}
