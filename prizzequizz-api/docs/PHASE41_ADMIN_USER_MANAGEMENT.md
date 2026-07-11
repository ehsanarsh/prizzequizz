# Phase 41 — Admin User Management

## Scope

Phase 41 adds user search, moderation, role management, and a user overview endpoint to the Admin system.

## Backend

### Domain

`User` now supports moderation fields:

```text
status: active | limited | banned
banReason
bannedAt
```

Migration:

```text
database/migrations/012_user_moderation.sql
```

### Service

```text
src/services/adminUserService.ts
```

Capabilities:

- search users
- list admin user summaries
- aggregate user overview
- update user status
- update user role

User overview aggregates:

- user summary
- wallet balances
- recent transactions
- devices
- risk profile
- support tickets
- integrity signals
- reward holds

### Admin endpoints

```http
GET   /v1/admin/users?q=&limit=100
GET   /v1/admin/users/:id/overview
PATCH /v1/admin/users/:id/status
PATCH /v1/admin/users/:id/role
```

## PWA Admin Panel

The Admin panel now includes a `کاربران` tab showing:

- user list
- username/id/status/role/risk score
- quick overview
- ban/unban action
- role user/admin toggle

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

Phase 42 should add Monitoring + Crash Reporting.
