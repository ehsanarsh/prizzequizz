export interface HttpMetricInput {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

interface RouteMetric {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

const startedAt = Date.now();
const routes = new Map<string, RouteMetric>();
let totalRequests = 0;
let totalErrors = 0;

export function recordHttpRequest(input: HttpMetricInput): void {
  totalRequests += 1;
  if (input.statusCode >= 500) totalErrors += 1;
  const key = `${input.method} ${input.route}`;
  const metric = routes.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
  metric.count += 1;
  if (input.statusCode >= 400) metric.errors += 1;
  metric.totalMs += input.durationMs;
  metric.maxMs = Math.max(metric.maxMs, input.durationMs);
  routes.set(key, metric);
}

export function getMetricsJson() {
  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    totalRequests,
    totalErrors,
    routes: [...routes.entries()].map(([route, metric]) => ({
      route,
      count: metric.count,
      errors: metric.errors,
      avgMs: metric.count ? Math.round(metric.totalMs / metric.count) : 0,
      maxMs: Math.round(metric.maxMs)
    }))
  };
}

export function getMetricsText(): string {
  const lines = [
    '# HELP prizzequizz_http_requests_total Total HTTP requests',
    '# TYPE prizzequizz_http_requests_total counter',
    `prizzequizz_http_requests_total ${totalRequests}`,
    '# HELP prizzequizz_http_errors_total Total HTTP 5xx errors',
    '# TYPE prizzequizz_http_errors_total counter',
    `prizzequizz_http_errors_total ${totalErrors}`,
    '# HELP prizzequizz_uptime_seconds Process uptime in seconds',
    '# TYPE prizzequizz_uptime_seconds gauge',
    `prizzequizz_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`
  ];
  for (const [route, metric] of routes.entries()) {
    const safe = route.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push(`prizzequizz_route_requests_total{route="${safe}"} ${metric.count}`);
    lines.push(`prizzequizz_route_avg_ms{route="${safe}"} ${metric.count ? Math.round(metric.totalMs / metric.count) : 0}`);
  }
  return `${lines.join('\n')}\n`;
}
