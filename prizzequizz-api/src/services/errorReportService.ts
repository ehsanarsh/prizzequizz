import { repositories } from '../repositories/index.js';
import type { ErrorReport, ErrorReportSeverity, ErrorReportSource, ErrorReportStatus } from '../types/domain.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';

export interface ErrorReportInput {
  userId?: string;
  source?: ErrorReportSource;
  severity?: ErrorReportSeverity;
  message: string;
  stack?: string;
  route?: string;
  userAgent?: string;
  appVersion?: string;
  buildId?: string;
  deviceId?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorReportDiagnostics {
  open: number;
  triaged: number;
  resolved: number;
  ignored: number;
  fatal: number;
  frontend: number;
  backend: number;
  last24h: number;
  topMessages: Array<{ message: string; count: number }>;
}

export async function createErrorReport(input: ErrorReportInput): Promise<ErrorReport> {
  const report: ErrorReport = {
    id: id(),
    userId: input.userId,
    source: input.source ?? 'frontend',
    severity: input.severity ?? 'error',
    status: 'open',
    message: input.message.slice(0, 1000),
    stack: input.stack?.slice(0, 8000),
    route: input.route?.slice(0, 1000),
    userAgent: input.userAgent?.slice(0, 1000),
    appVersion: input.appVersion?.slice(0, 80),
    buildId: input.buildId?.slice(0, 120),
    deviceId: input.deviceId?.slice(0, 120),
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString()
  };
  await repositories.errorReports.save(report);
  logger.warn('error_report_created', { id: report.id, source: report.source, severity: report.severity, message: report.message });
  return report;
}

export async function listErrorReports(filter: { source?: ErrorReportSource; severity?: ErrorReportSeverity; status?: ErrorReportStatus; userId?: string; limit?: number } = {}): Promise<ErrorReport[]> {
  return repositories.errorReports.list(filter);
}

export async function updateErrorReportStatus(id: string, status: ErrorReportStatus, resolvedBy: string): Promise<ErrorReport | null> {
  return repositories.errorReports.updateStatus(id, status, resolvedBy);
}

export async function errorReportDiagnostics(): Promise<ErrorReportDiagnostics> {
  const reports = await repositories.errorReports.list({ limit: 500 });
  const since = Date.now() - 24 * 60 * 60 * 1000;
  return {
    open: reports.filter((r) => r.status === 'open').length,
    triaged: reports.filter((r) => r.status === 'triaged').length,
    resolved: reports.filter((r) => r.status === 'resolved').length,
    ignored: reports.filter((r) => r.status === 'ignored').length,
    fatal: reports.filter((r) => r.severity === 'fatal').length,
    frontend: reports.filter((r) => r.source === 'frontend').length,
    backend: reports.filter((r) => r.source === 'backend').length,
    last24h: reports.filter((r) => new Date(r.createdAt).getTime() >= since).length,
    topMessages: topMessages(reports)
  };
}

function topMessages(reports: ErrorReport[]): Array<{ message: string; count: number }> {
  const counts = new Map<string, number>();
  for (const report of reports) {
    const key = report.message.slice(0, 120);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([message, count]) => ({ message, count }));
}
