# PrizzeQuizz Deployment Guide

## Architecture

Production stack:

```text
PWA static frontend
Node.js TypeScript API
PostgreSQL
Redis
Payment provider
Web Push provider
```

## Recommended deployment order

1. Provision PostgreSQL.
2. Provision Redis.
3. Configure backend environment.
4. Run migrations.
5. Verify database.
6. Deploy API.
7. Deploy PWA with `VITE_API_BASE_URL` pointed to the API.
8. Run smoke checks.
9. Enable closed beta.

## Backend deployment

```bash
cd prizzequizz-api
npm ci
npm run build
npm run env:validate
npm run migrate
npm run db:verify
npm run start
```

## Frontend deployment

```bash
cd prizzequizz-pwa
npm ci
npm run build
```

Deploy the `dist/` folder to a static host.

## Docker Compose local beta simulation

```bash
docker compose up --build
```

Then visit:

```text
PWA: http://localhost:4173
API: http://localhost:3000/v1
```

## Operational endpoints

Public:

```text
GET /v1/health
GET /v1/health/deep
GET /v1/release
GET /v1/metrics
```

Admin:

```text
GET /v1/admin/database/verify
GET /v1/admin/monitoring/diagnostics
GET /v1/admin/finance/diagnostics
GET /v1/admin/payments/diagnostics
GET /v1/admin/beta/diagnostics
```

## Production security notes

- Never use `dev-admin` in production.
- Never use `replace-in-production` JWT secrets.
- Use HTTPS for API and PWA.
- Restrict admin key access.
- Use Redis for realtime and leaderboard.
- Use PostgreSQL as the repository driver.
- Keep `PAYMENT_PROVIDER=sandbox` only for internal testing.
