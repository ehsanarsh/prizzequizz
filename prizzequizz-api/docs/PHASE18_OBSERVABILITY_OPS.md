# Phase 18 — Observability and Operations Readiness

## Completed

This phase adds the first operations layer for PrizzeQuizz API: structured logging, request metrics, deep health checks, and operational endpoints.

## Added Files

```text
src/services/logger.ts
src/services/metrics.ts
src/services/healthService.ts
src/services/analyticsService.ts
src/modules/ops/routes.ts
```

## Structured Logging

The API now emits JSON logs through `logger.ts`.

Example:

```json
{
  "ts": "2026-07-07T14:16:10.183Z",
  "level": "info",
  "service": "prizzequizz-api",
  "message": "request_completed",
  "method": "GET",
  "path": "/v1/health",
  "route": "/v1/health",
  "statusCode": 200,
  "durationMs": 2
}
```

Configured with:

```env
LOG_LEVEL=debug|info|warn|error
```

## Request Metrics

Every request is recorded by route:

- total requests
- total errors
- per-route count
- per-route errors
- average duration
- max duration

Endpoints:

```text
GET /v1/metrics
GET /v1/metrics?format=prometheus
```

## Deep Health Check

Endpoint:

```text
GET /v1/health/deep
```

Checks:

- config
- repository
- postgres if configured
- redis placeholder

Returns `503` if any required check fails.

## Admin Analytics Improvements

`/v1/admin/analytics` now uses `analyticsService.ts`.

- In memory mode, it uses in-memory stores.
- In postgres mode, it attempts database counts.
- Falls back safely if database analytics fail.

## Router Instrumentation

The core router now records request duration in a `finally` block so both success and failure paths are tracked.

## Integration Test Coverage Added

The integration test now verifies:

- `/v1/health/deep`
- `/v1/metrics`

## Validation

Backend:

```bash
npm run build
npm run test:integration
```

Frontend remains valid from previous phase and can be validated with:

```bash
cd prizzequizz-pwa
npm run typecheck
npm run build
```

## Next Phase Recommendation

Phase 19 should improve backend production safety:

1. Centralized validation helpers for request bodies.
2. Standardized domain error classes.
3. Map known service errors to correct HTTP status codes.
4. Add request ID propagation.
5. Add structured security events for auth failures and rate limits.
6. Add test cases for negative paths.
