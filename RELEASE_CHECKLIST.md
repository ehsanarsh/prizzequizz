# PrizzeQuizz Closed Beta Release Checklist

## 1. Required environment

Backend production env must be based on:

```text
prizzequizz-api/.env.production.example
```

Frontend production env must be based on:

```text
prizzequizz-pwa/.env.production.example
```

Minimum production requirements:

- `NODE_ENV=production`
- strong `JWT_ACCESS_SECRET`
- strong `JWT_REFRESH_SECRET`
- strong `ADMIN_KEY`
- `REPOSITORY_DRIVER=postgres`
- `REALTIME_ADAPTER=redis`
- `LEADERBOARD_ADAPTER=redis`
- real `DATABASE_URL`
- real `REDIS_URL`
- `CLOSED_BETA_REQUIRED=true`
- payment provider configured or explicitly sandbox for internal-only testing

## 2. Pre-deploy commands

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

## 3. Runtime smoke

After deployment:

```bash
curl https://api.example.com/v1/health
curl https://api.example.com/v1/health/deep
curl https://api.example.com/v1/release
curl https://api.example.com/v1/metrics
```

Admin checks:

```text
/v1/admin/database/verify
/v1/admin/beta/diagnostics
/v1/admin/payments/diagnostics
/v1/admin/monitoring/diagnostics
```

## 4. Closed beta launch

1. Set `CLOSED_BETA_REQUIRED=true`.
2. Create invite codes in Admin > Beta.
3. Verify at least one test account can redeem an invite.
4. Confirm wallet top-up sandbox/provider flow.
5. Confirm reward hold review flow.
6. Confirm monitoring tab receives frontend crash reports.
7. Confirm support tickets can be answered from Admin.

## 5. Rollback criteria

Rollback if any of these happen:

- `/health/deep` is unhealthy for more than 5 minutes.
- payment verification fails for valid payments.
- matchmaking fails to create matches.
- frontend cannot log in or redeem beta invites.
- error report volume spikes above expected baseline.

## 6. Release artifact

Each released phase package should include:

```text
prizzequizz-pwa/
prizzequizz-api/
prizzequizz-backend-architecture/
prizzequizz-character-lab/
docker-compose.yml
docs-local-development.md
RELEASE_CHECKLIST.md
DEPLOYMENT_GUIDE.md
CLOSED_BETA_RUNBOOK.md
```
