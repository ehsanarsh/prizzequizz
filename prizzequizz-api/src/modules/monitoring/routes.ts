import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { createErrorReport, errorReportDiagnostics, listErrorReports, updateErrorReportStatus } from '../../services/errorReportService.js';
import type { ErrorReportSeverity, ErrorReportSource, ErrorReportStatus } from '../../types/domain.js';
import { bodyObject, optionalString, requiredString } from '../../utils/validation.js';

export function registerMonitoringRoutes(router: Router, base: string): void {
  router.add('POST', `${base}/monitoring/reports`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const report = await createErrorReport({
      userId: ctx.userId,
      source: (optionalString(body, 'source', 'frontend') ?? 'frontend') as ErrorReportSource,
      severity: (optionalString(body, 'severity', 'error') ?? 'error') as ErrorReportSeverity,
      message: requiredString(body, 'message'),
      stack: optionalString(body, 'stack'),
      route: optionalString(body, 'route'),
      userAgent: optionalString(body, 'userAgent', String(ctx.req.headers['user-agent'] ?? '')),
      appVersion: optionalString(body, 'appVersion'),
      buildId: optionalString(body, 'buildId'),
      deviceId: ctx.deviceId ?? optionalString(body, 'deviceId'),
      metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : {}
    });
    json(ctx.res, 201, report);
  });

  router.add('GET', `${base}/admin/monitoring/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await errorReportDiagnostics());
  });

  router.add('GET', `${base}/admin/monitoring/reports`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listErrorReports({
      source: (ctx.query.get('source') || undefined) as ErrorReportSource | undefined,
      severity: (ctx.query.get('severity') || undefined) as ErrorReportSeverity | undefined,
      status: (ctx.query.get('status') || undefined) as ErrorReportStatus | undefined,
      userId: ctx.query.get('userId') || undefined,
      limit: Number(ctx.query.get('limit') ?? 100)
    }));
  });

  router.add('PATCH', `${base}/admin/monitoring/reports/:id/status`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const status = String((ctx.body as any)?.status ?? 'triaged') as ErrorReportStatus;
    if (!['open','triaged','resolved','ignored'].includes(status)) return error(ctx.res, 422, 'ERROR_REPORT_STATUS_INVALID', 'Invalid error report status.');
    const updated = await updateErrorReportStatus(ctx.params.id!, status, ctx.userId ?? 'system');
    if (!updated) return error(ctx.res, 404, 'ERROR_REPORT_NOT_FOUND', 'Error report not found.');
    json(ctx.res, 200, updated);
  });
}
