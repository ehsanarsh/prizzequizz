# Phase 42 — Monitoring + Crash Reporting

## Scope

Phase 42 adds application crash/error reporting across the PWA and API, plus admin monitoring diagnostics.

## Backend

### Domain

```text
ErrorReport
ErrorReportSource
ErrorReportSeverity
ErrorReportStatus
```

Sources:

```text
frontend
backend
worker
realtime
```

Severities:

```text
info
warn
error
fatal
```

Statuses:

```text
open
triaged
resolved
ignored
```

### Repository

New repository contract:

```text
ErrorReportRepository
```

Implemented for:

- memory repository
- PostgreSQL repository

### Migration

```text
database/migrations/013_error_reports.sql
```

Table:

```text
error_reports
```

### Service

```text
src/services/errorReportService.ts
```

Capabilities:

- create error reports
- list reports with filters
- update report status
- diagnostics/top messages

### API

Client endpoint:

```http
POST /v1/monitoring/reports
```

Admin endpoints:

```http
GET   /v1/admin/monitoring/diagnostics
GET   /v1/admin/monitoring/reports
PATCH /v1/admin/monitoring/reports/:id/status
```

## PWA

New client reporter:

```text
src/services/errorReporter.ts
```

It captures:

- `window.error`
- `unhandledrejection`

and sends:

- message
- stack
- route
- user agent
- app version/build id
- device id
- metadata

Telemetry failures are swallowed to avoid recursive reporting loops.

## Admin Panel

New Admin tab:

```text
Monitoring
```

It shows:

- open reports
- fatal reports
- frontend report count
- last 24h count
- report list
- Triage / Resolve / Ignore actions

## Validation

Validated with:

```bash
cd prizzequizz-api
npm run build
npm run test:integration
npm run test:realtime
npm run test:matchmaking
npm run db:verify

cd ../prizzequizz-pwa
npm run typecheck
npm run build
```

## Next phase recommendation

Phase 43 should implement Closed Beta Readiness: invite codes, beta access, rollout controls, release checklist, and deployment package hardening.
