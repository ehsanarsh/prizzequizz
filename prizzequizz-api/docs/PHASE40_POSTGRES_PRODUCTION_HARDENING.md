# Phase 40 — PostgreSQL Production Hardening

## Scope

Phase 40 adds production database verification, migration status inspection, PostgreSQL pool tuning, and admin DB diagnostics.

## Backend additions

### New migration service

```text
src/database/migrationService.ts
```

Capabilities:

- list SQL migration files
- ensure `schema_migrations` table
- apply pending migrations
- report migration status
- verify required tables
- verify required indexes

### Migration script refactor

```text
src/scripts/migrate.ts
```

Now uses the shared migration service instead of duplicating migration logic.

### New DB scripts

```bash
npm run db:status
npm run db:verify
```

`db:status` prints applied/pending migrations.

`db:verify` checks:

- migration status
- required production tables
- required indexes

It exits non-zero if a configured PostgreSQL database is missing required objects.

### PostgreSQL pool hardening

`src/database/postgres.ts` now supports:

```env
PG_POOL_MAX=10
PG_IDLE_TIMEOUT_MS=30000
PG_CONNECTION_TIMEOUT_MS=5000
PG_APP_NAME=prizzequizz-api
```

It also exposes pool stats for health diagnostics.

### Deep health expansion

`GET /v1/health/deep` now includes:

- repository check
- PostgreSQL check
- migration check
- schema table check
- pool stats

### Admin database endpoints

```http
GET /v1/admin/database/status
GET /v1/admin/database/verify
```

Both require admin access.

## PWA Admin Panel

The Admin panel now includes a `DB` tab showing:

- schema OK/FAIL
- applied migration count
- pending migration count
- table verification count
- migration rows

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

Phase 41 should implement Admin User Management:

- user search
- profile overview
- wallet/transactions
- devices/risk summary
- ban/unban
- role management
