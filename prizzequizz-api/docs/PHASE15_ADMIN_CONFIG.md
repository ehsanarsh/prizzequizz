# Phase 15 — Admin Foundation + Config Management

## Completed

This phase adds the first production-oriented admin backend surface.

## Added

```text
src/modules/admin/routes.ts
src/services/adminGuard.ts
src/services/configService.ts
```

## Admin Authentication

Admin endpoints are protected by either:

1. Access token with `role = admin`.
2. Development/admin key header:

```text
x-admin-key: dev-admin
```

In production, configure:

```env
ADMIN_KEY=strong-secret
```

## Admin Endpoints

```text
GET   /v1/admin/config
PUT   /v1/admin/config
PATCH /v1/admin/config/modes/:modeId
GET   /v1/admin/questions
POST  /v1/admin/questions
PATCH /v1/admin/questions/:id/status
GET   /v1/admin/users
GET   /v1/admin/analytics
GET   /v1/admin/audit-logs
```

## Config Management

`configService.ts` provides:

- `getEditableGameConfig()`
- `validateGameConfig()`
- `updateGameConfig()`
- `updateModeConfig()`

Config changes mutate the in-process config object so existing imports keep a stable reference.

## Audit Logs

Admin actions create audit entries for:

- config updates
- mode config patches
- question creation
- question status updates

The current audit log storage is memory-backed. The database migration from previous phases already includes an `admin_logs` table for future persistence.

## Frontend API Contract

PWA API contracts now include:

```ts
api.admin.getConfig()
api.admin.updateConfig()
api.admin.patchMode()
api.admin.analytics()
api.admin.auditLogs()
```

Both mock and HTTP adapters implement the admin interface.

## Validation

Backend:

```bash
npm run build
npm run test:integration
```

Frontend:

```bash
npm run typecheck
npm run build
```

## Next Phase Recommendation

Phase 16 should introduce an Admin UI scaffold:

1. Admin login / key input for development.
2. Config viewer/editor.
3. Mode config editor.
4. Question manager.
5. Analytics dashboard.
6. Audit log viewer.

This can live either inside the PWA as `/admin` or as a separate `apps/admin` package. The recommended approach for long-term maintainability is a separate admin app, but an embedded admin screen is faster for MVP.
