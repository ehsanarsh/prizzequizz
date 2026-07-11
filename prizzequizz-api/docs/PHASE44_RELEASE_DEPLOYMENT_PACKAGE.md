# Phase 44 — Release / Deployment Package Hardening

## Scope

Phase 44 prepares PrizzeQuizz for a controlled Closed Beta release package.

## Added

### Environment validation

New script:

```bash
npm run env:validate
```

Implementation:

```text
src/scripts/validate-env.ts
```

It checks production requirements such as:

- JWT secrets are present and not development placeholders
- `REPOSITORY_DRIVER=postgres`
- Redis-backed realtime/leaderboard adapters
- real payment provider in production
- admin key configured
- database and Redis configured

### Production env examples

```text
prizzequizz-api/.env.production.example
prizzequizz-pwa/.env.production.example
```

### Release endpoint

```http
GET /v1/release
```

Returns:

```json
{
  "service": "prizzequizz-api",
  "version": "...",
  "buildId": "...",
  "env": "...",
  "checkedAt": "..."
}
```

### Health endpoint versioning

`GET /v1/health` now also returns:

```text
version
buildId
```

### Root release docs

```text
RELEASE_CHECKLIST.md
DEPLOYMENT_GUIDE.md
CLOSED_BETA_RUNBOOK.md
```

## Recommended release flow

```bash
cd prizzequizz-api
npm ci
npm run build
npm run env:validate
npm run migrate
npm run db:verify
npm run test:integration
npm run test:realtime
npm run test:matchmaking

cd ../prizzequizz-pwa
npm ci
npm run typecheck
npm run build
```

## Validation

Validated with:

```bash
cd prizzequizz-api
npm run build
npm run env:validate
npm run test:integration
npm run test:realtime
npm run test:matchmaking
npm run db:verify

cd ../prizzequizz-pwa
npm run typecheck
npm run build
```

## Next phase recommendation

After this release hardening phase, the next meaningful work is final launch polish:

- deployment automation / CI pipeline
- real payment provider adapter
- original character art assets
- final beta content pass
