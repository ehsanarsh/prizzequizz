# Phase 43 — Closed Beta Readiness

## Scope

Phase 43 adds invite-code based closed beta access, beta user tracking, and admin beta rollout controls.

## Backend

### Domain

```text
BetaInvite
BetaAccess
```

Invite statuses:

```text
active
disabled
expired
```

### Repository

New `BetaRepository` implemented for:

- memory repository
- PostgreSQL repository

### Migration

```text
database/migrations/014_beta_access.sql
```

Tables:

```text
beta_invites
beta_access
```

### Service

```text
src/services/betaService.ts
```

Capabilities:

- create invite codes
- redeem invites
- list beta users
- beta diagnostics
- optional auth gating with `CLOSED_BETA_REQUIRED=true`

### API

User endpoints:

```http
GET  /v1/beta/status
POST /v1/beta/redeem
```

Admin endpoints:

```http
GET   /v1/admin/beta/diagnostics
GET   /v1/admin/beta/invites
POST  /v1/admin/beta/invites
PATCH /v1/admin/beta/invites/:code/status
GET   /v1/admin/beta/users
```

## PWA Admin

The Admin panel now includes a Beta tab with:

- beta required status
- active invite count
- beta users count
- remaining invite uses
- create invite form
- invite enable/disable controls
- beta user preview

## Config

```env
CLOSED_BETA_REQUIRED=false
```

When set to true, users without beta access must provide an invite code during OTP verification or redeem a valid invite.

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

Phase 44 should implement Release/Deployment Package hardening.
