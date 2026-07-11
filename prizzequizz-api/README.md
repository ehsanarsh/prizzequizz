# PrizzeQuizz API — Phase 10 Backend Skeleton

A dependency-light TypeScript backend scaffold matching the PWA API contracts.

## Run

```bash
npm install
npm run dev
```

Health endpoint:

```text
GET http://localhost:3000/v1/health
```

## Implemented Modules

- Auth mock OTP
- Users
- Matches
- Questions
- Wallet
- Friends
- Support
- In-memory repositories
- Config-driven mode entry
- Basic reward settlement
- SQL migration baseline

## Frontend Connection

Set in the PWA project:

```env
VITE_API_BASE_URL=http://localhost:3000/v1
```

## Next Backend Phase

Replace in-memory repositories with PostgreSQL adapters and add Redis-backed realtime match state.


## Phase 11 Update — Persistence and Realtime Foundation

Added:

- Idempotent answer submission
- Idempotent reward settlement
- Match event log
- Active match state store interface
- PostgreSQL migration runner
- Rewards/events/sessions/admin logs migration
- WebSocket realtime gateway scaffold

Validation:

```bash
npm run build
```

See:

```text
docs/PHASE11_PERSISTENCE_REALTIME.md
```


## Phase 12 Update — Repository Layer

The backend now has repository interfaces plus memory and PostgreSQL implementations.

Repository driver selection:

```text
REPOSITORY_DRIVER=memory
REPOSITORY_DRIVER=postgres
```

If `DATABASE_URL` exists, postgres is selected by default.

See:

```text
docs/PHASE12_REPOSITORY_LAYER.md
```


## Phase 13 Update — Tests and Docker

Added integration tests and a Docker Compose development environment.

Run tests:

```bash
npm run build
npm run test:integration
```

Run full stack:

```bash
docker compose up --build
```

See:

```text
docs/PHASE13_TESTING_DOCKER.md
../docs-local-development.md
```


## Phase 14 Update — Auth and Security

Added HMAC token signing, refresh token rotation, OTP provider abstraction, logout, global rate limiting, and security/session database migration.

New endpoints:

```text
POST /v1/auth/refresh
POST /v1/auth/logout
```

See:

```text
docs/PHASE14_AUTH_SECURITY.md
```


## Phase 15 Update — Admin Foundation

Added protected admin endpoints for config management, question management, analytics, and audit logs.

Development admin key:

```text
x-admin-key: dev-admin
```

See:

```text
docs/PHASE15_ADMIN_CONFIG.md
```


## Phase 18 Update — Observability and Ops

Added structured JSON logging, request metrics, deep health checks, and operational endpoints.

Endpoints:

```text
GET /v1/health/deep
GET /v1/metrics
GET /v1/metrics?format=prometheus
```

See:

```text
docs/PHASE18_OBSERVABILITY_OPS.md
```


## Phase 19 Update — Domain Errors and Validation

Added domain error classes, validation helpers, request ID propagation, security event logging, and negative-path integration tests.

See:

```text
docs/PHASE19_DOMAIN_ERRORS_VALIDATION.md
```


## Phase 20 Update — Realtime Match Infrastructure

The WebSocket gateway is now match-aware and supports room join/leave, presence, chat, answer submission, match snapshots, and match finished events.

Endpoint:

```text
ws://localhost:3000/v1/realtime
```

See:

```text
docs/PHASE20_REALTIME_MATCH_INFRA.md
```


## Phase 21 Update — Realtime Resilience

Realtime infrastructure now includes room registry improvements, pub/sub abstraction, presence cleanup, reconnect snapshot recovery, and `/v1/realtime/stats`.

See:

```text
docs/PHASE21_REALTIME_RESILIENCE.md
```


## Phase 26 Update — Redis Pub/Sub

Realtime pub/sub now has a real Redis adapter. Docker Compose enables it with:

```env
REALTIME_ADAPTER=redis
REDIS_URL=redis://redis:6379
```

See:

```text
docs/PHASE26_REDIS_PUBSUB.md
```


## Phase 27 Update — Redis Presence and Multi-instance Realtime Smoke

Added realtime presence store abstraction, Redis-backed presence TTL support, and a multi-server WebSocket smoke test.

Run:

```bash
npm run test:realtime
```

See:

```text
docs/PHASE27_REALTIME_REDIS_PRESENCE.md
```


## Phase 28 Update — Matchmaking System

Added matchmaking tickets, compatible queue matching, bot fallback, and PWA Duel integration with the matchmaking API.

See:

```text
docs/PHASE28_MATCHMAKING_SYSTEM.md
```


## Phase 29 Update — Matchmaking Hardening

Added Redis sorted-set matchmaking queue, bot fallback profiles, timeout worker, match quality, and load test.

Run:

```bash
npm run test:matchmaking
```

See:

```text
docs/PHASE29_MATCHMAKING_HARDENING.md
```

## Phase 30 Leaderboards

Public endpoints:

- `GET /v1/leaderboards/weekly?limit=50`
- `GET /v1/leaderboards/overall?limit=50`
- `GET /v1/leaderboards/winnings?limit=50`

Admin diagnostics:

- `GET /v1/admin/leaderboards/diagnostics` with `x-admin-key`

Adapters:

- `LEADERBOARD_ADAPTER=memory` for local/test default
- `LEADERBOARD_ADAPTER=redis` with `REDIS_URL` for Redis sorted sets

Realtime clients can send `client:subscribe_leaderboard` with `{ "kind": "weekly" }` and receive `server:leaderboard_update`.

## Phase 31 Notifications

User notification endpoints:

- `GET /v1/notifications`
- `GET /v1/notifications/preferences`
- `PUT /v1/notifications/preferences`
- `POST /v1/notifications/push-subscriptions`
- `POST /v1/notifications/:id/read`

Admin endpoints:

- `GET /v1/admin/notifications/diagnostics`
- `POST /v1/admin/notifications/broadcast`

Default provider is `PUSH_PROVIDER=log`. For real browser Push delivery use `PUSH_PROVIDER=webpush` plus VAPID keys.

## Phase 32 Anti-Cheat / Match Integrity

Admin integrity endpoints:

- `GET /v1/admin/integrity/diagnostics`
- `GET /v1/admin/integrity/signals?status=open&severity=critical&limit=100`
- `PATCH /v1/admin/integrity/signals/:id/status`

The integrity engine records non-blocking signals for suspicious answer speed, answer bursts, idempotency replays, repeated question answers, perfect fast matches, and score anomalies.

See `docs/PHASE32_ANTI_CHEAT_INTEGRITY.md`.

## Phase 33 Device Binding + Risk Scoring

User device endpoints:

- `GET /v1/devices/current`
- `GET /v1/devices`
- `POST /v1/devices/risk/recalculate`

Admin device/risk endpoints:

- `GET /v1/admin/devices/diagnostics`
- `GET /v1/admin/risk/users`
- `GET /v1/admin/users/:id/devices`
- `PATCH /v1/admin/devices/bindings/:id/status`

Clients should send `x-device-id`, `x-device-fingerprint`, and `x-platform` headers. See `docs/PHASE33_DEVICE_BINDING_RISK_SCORING.md`.

## Phase 34 Reward Hold Review

High-risk paid cash rewards can now be held for manual admin review.

Admin endpoints:

- `GET /v1/admin/rewards/holds/diagnostics`
- `GET /v1/admin/rewards/holds`
- `PATCH /v1/admin/rewards/holds/:id/status`

Config:

```env
REWARD_HOLD_ENABLED=true
REWARD_HOLD_RISK_THRESHOLD=55
```

See `docs/PHASE34_REWARD_HOLD_REVIEW.md`.

## Phase 35 Financial Operations

Admin finance endpoints:

- `GET /v1/admin/finance/diagnostics`
- `GET /v1/admin/finance/withdrawals`
- `PATCH /v1/admin/finance/withdrawals/:id/status`

Withdrawal review supports approve/reject. Rejected withdrawals are refunded to the user wallet.

See `docs/PHASE35_FINANCIAL_OPERATIONS.md`.

## Phase 36 Support Operations

Support is now backed by repository persistence and has admin operations endpoints:

- `GET /v1/admin/support/diagnostics`
- `GET /v1/admin/support/tickets`
- `POST /v1/admin/support/tickets/:id/reply`
- `PATCH /v1/admin/support/tickets/:id/status`

Tickets can link to matches, transactions, and reward holds.

## Phase 37 Character System

Character endpoints:

- `GET /v1/characters/catalog`
- `GET /v1/characters/me`
- `POST /v1/characters/equip`
- `POST /v1/characters/purchase`
- `POST /v1/characters/randomize`

See `docs/PHASE37_CHARACTER_SYSTEM_INTEGRATION.md`.

## Phase 38 Character Persistence + Admin Catalog

Character inventory and catalog are now repository-backed. Admin endpoints support catalog item listing, upsert, status changes, and user unlock events.

See `docs/PHASE38_CHARACTER_PERSISTENCE_ADMIN.md`.

## Phase 39 Payment Gateway Foundation

Payment-intent endpoints:

- `POST /v1/payments/intents`
- `GET /v1/payments/intents/:id`
- `POST /v1/payments/intents/:id/verify`
- `GET /v1/payments/sandbox/:id/pay`

Admin payment endpoints:

- `GET /v1/admin/payments/diagnostics`
- `GET /v1/admin/payments/intents`

Default provider is `PAYMENT_PROVIDER=sandbox`.

## Phase 40 PostgreSQL Hardening

New database operations:

- `npm run db:status`
- `npm run db:verify`
- `GET /v1/admin/database/status`
- `GET /v1/admin/database/verify`

PostgreSQL pool settings:

```env
PG_POOL_MAX=10
PG_IDLE_TIMEOUT_MS=30000
PG_CONNECTION_TIMEOUT_MS=5000
PG_APP_NAME=prizzequizz-api
```

See `docs/PHASE40_POSTGRES_PRODUCTION_HARDENING.md`.

## Phase 41 Admin User Management

Admin user endpoints:

- `GET /v1/admin/users?q=&limit=100`
- `GET /v1/admin/users/:id/overview`
- `PATCH /v1/admin/users/:id/status`
- `PATCH /v1/admin/users/:id/role`

User moderation status supports `active`, `limited`, and `banned`.

## Phase 42 Monitoring + Crash Reporting

Client error reporting endpoint:

- `POST /v1/monitoring/reports`

Admin monitoring endpoints:

- `GET /v1/admin/monitoring/diagnostics`
- `GET /v1/admin/monitoring/reports`
- `PATCH /v1/admin/monitoring/reports/:id/status`

See `docs/PHASE42_MONITORING_CRASH_REPORTING.md`.

## Phase 43 Closed Beta

Beta invite endpoints:

- `GET /v1/beta/status`
- `POST /v1/beta/redeem`
- `GET /v1/admin/beta/diagnostics`
- `POST /v1/admin/beta/invites`

Config:

```env
CLOSED_BETA_REQUIRED=false
```

See `docs/PHASE43_CLOSED_BETA_READINESS.md`.

## Phase 44 Release Package

Release helpers:

- `npm run env:validate`
- `GET /v1/release`

Production env example:

- `.env.production.example`

Root release docs:

- `RELEASE_CHECKLIST.md`
- `DEPLOYMENT_GUIDE.md`
- `CLOSED_BETA_RUNBOOK.md`
