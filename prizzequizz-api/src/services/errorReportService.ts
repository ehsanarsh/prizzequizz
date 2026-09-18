import { repositories } from '../repositories/index.js';
import { getPgPool } from '../database/postgres.js';
import { scrubText, scrubRoute, scrubMeta, fingerprint } from './errorScrub.js';
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

/* SCRUBBED HERE, not only in the client. The endpoint is public, an old build
   already on somebody's phone has no scrubber, and a table that five employees
   can read is the wrong place to discover a phone number later. */
export async function createErrorReport(input: ErrorReportInput): Promise<ErrorReport> {
  const report: ErrorReport = {
    id: id(),
    userId: input.userId,
    source: input.source ?? 'frontend',
    severity: input.severity ?? 'error',
    status: 'open',
    message: scrubText(input.message, 1000),
    stack: input.stack ? scrubText(input.stack, 8000) : undefined,
    route: input.route ? scrubRoute(input.route) : undefined,
    userAgent: input.userAgent?.slice(0, 1000),
    appVersion: input.appVersion?.slice(0, 80),
    buildId: input.buildId?.slice(0, 120),
    deviceId: input.deviceId?.slice(0, 120),
    metadata: scrubMeta(input.metadata),
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

/* ── ONE CRASH, NOT FOUR THOUSAND OCCURRENCES ──────────────────────────────
 * A flat list is unreadable the first time anything loops: one bug fills the
 * screen and every other bug is on page forty. Grouping is what makes this a
 * queue somebody can work — «this crash, 120 times, only on version 643».
 *
 * Grouped in SQL where there is a database, because the point is to see the
 * rare crash UNDER the noisy one, and grouping the first 500 rows in memory
 * would only ever show the noisy one.
 */
export interface ErrorGroup {
  fingerprint: string;
  message: string;          // one real example, scrubbed
  count: number;
  users: number;            // how many different players hit it
  firstAt: string;
  lastAt: string;
  source: ErrorReportSource;
  severity: ErrorReportSeverity;
  appVersions: string[];
  sampleId: string;
  route?: string;
  stack?: string;
}

function pgPool(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

export async function errorGroups(filter: { status?: ErrorReportStatus; source?: ErrorReportSource; limit?: number } = {}): Promise<ErrorGroup[]> {
  const status = filter.status ?? 'open';
  const limit = Math.min(200, Math.max(1, Number(filter.limit ?? 50)));
  const pool = pgPool();
  if (pool) {
    const args: unknown[] = [status];
    let where = `status = $1`;
    if (filter.source) { args.push(filter.source); where += ` AND source = $${args.length}`; }
    args.push(limit);
    /* The fingerprint is computed in SQL the same way errorScrub does it —
       digits out, so «line 41» and «line 88» of one bug stay one bug. */
    const { rows } = await pool.query(
      `WITH g AS (
         SELECT regexp_replace(lower(message), '[0-9]+', 'N', 'g') AS fp, *
           FROM error_reports WHERE ${where})
       SELECT fp,
              count(*)::int                        AS n,
              count(DISTINCT user_id)::int         AS users,
              min(created_at)                      AS first_at,
              max(created_at)                      AS last_at,
              (array_agg(message      ORDER BY created_at DESC))[1] AS message,
              (array_agg(id::text     ORDER BY created_at DESC))[1] AS sample_id,
              (array_agg(source       ORDER BY created_at DESC))[1] AS source,
              (array_agg(severity     ORDER BY created_at DESC))[1] AS severity,
              (array_agg(route        ORDER BY created_at DESC))[1] AS route,
              (array_agg(stack        ORDER BY created_at DESC))[1] AS stack,
              array_remove(array_agg(DISTINCT app_version), NULL)   AS versions
         FROM g GROUP BY fp
        ORDER BY n DESC, last_at DESC
        LIMIT $${args.length}`, args);
    return rows.map((r: any) => ({
      fingerprint: String(r.fp), message: String(r.message ?? ''), count: Number(r.n), users: Number(r.users ?? 0),
      firstAt: r.first_at?.toISOString?.() ?? String(r.first_at), lastAt: r.last_at?.toISOString?.() ?? String(r.last_at),
      source: (r.source ?? 'frontend') as ErrorReportSource, severity: (r.severity ?? 'error') as ErrorReportSeverity,
      appVersions: (r.versions ?? []).map(String), sampleId: String(r.sample_id ?? ''),
      route: r.route ?? undefined, stack: r.stack ?? undefined
    }));
  }
  /* No database: the in-memory repository holds few enough rows that grouping
     them here says the same thing. */
  const rows = (await repositories.errorReports.list({ status, source: filter.source, limit: 500 })) as ErrorReport[];
  const by = new Map<string, ErrorReport[]>();
  for (const r of rows) { const f = fingerprint(r.message); by.set(f, [...(by.get(f) ?? []), r]); }
  return [...by.entries()].map(([fp, list]) => {
    const sorted = list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const newest = sorted[0]!;
    return {
      fingerprint: fp, message: newest.message, count: list.length,
      users: new Set(list.map((r) => r.userId).filter(Boolean)).size,
      firstAt: sorted[sorted.length - 1]!.createdAt, lastAt: newest.createdAt,
      source: newest.source, severity: newest.severity,
      appVersions: [...new Set(list.map((r) => r.appVersion).filter(Boolean))] as string[],
      sampleId: newest.id, route: newest.route, stack: newest.stack
    };
  }).sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1)).slice(0, limit);
}

/* Triage by GROUP, because that is the unit of work. Marking four thousand
   rows one at a time is not a thing anybody will do, so the queue would never
   empty and the count would stop meaning anything. */
export async function updateErrorGroupStatus(fp: string, status: ErrorReportStatus, resolvedBy: string): Promise<number> {
  const pool = pgPool();
  if (pool) {
    const { rowCount } = await pool.query(
      /* `$2::text` in every place it appears. Without the cast Postgres sees the
         same parameter used as a column value and inside `IN (...)`, cannot
         deduce one type for it, and refuses the whole statement — so group
         triage failed against a real database while passing in memory. */
      `UPDATE error_reports
          SET status = $2::text,
              resolved_by = CASE WHEN $2::text IN ('resolved','ignored') THEN $3::uuid ELSE resolved_by END,
              resolved_at = CASE WHEN $2::text IN ('resolved','ignored') THEN now() ELSE resolved_at END
        WHERE regexp_replace(lower(message), '[0-9]+', 'N', 'g') = $1`,
      [fp, status, /^[0-9a-f-]{36}$/i.test(String(resolvedBy)) ? resolvedBy : null]);
    return rowCount ?? 0;
  }
  const rows = await repositories.errorReports.list({ limit: 500 });
  let n = 0;
  for (const r of rows) if (fingerprint(r.message) === fp) { await repositories.errorReports.updateStatus(r.id, status, resolvedBy); n++; }
  return n;
}
