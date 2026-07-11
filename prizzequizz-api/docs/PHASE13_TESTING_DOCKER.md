# Phase 13 — Integration Tests + Docker Compose Environment

## Completed

This phase adds local development infrastructure and integration testing.

## Added

```text
docker-compose.yml
prizzequizz-api/Dockerfile
prizzequizz-pwa/Dockerfile
docs-local-development.md
prizzequizz-api/src/tests/integration.ts
```

## Integration Test Coverage

The integration test verifies:

1. Health endpoint
2. Auth login
3. OTP verify
4. User hydration
5. Match creation
6. Match start
7. Question delivery
8. Answer submission
9. Idempotent answer retry
10. Wallet topup
11. Friend invite
12. Support ticket creation

Run:

```bash
cd prizzequizz-api
npm run build
npm run test:integration
```

## Docker Compose

Services:

- PostgreSQL
- Redis
- API
- PWA static server

Run:

```bash
docker compose up --build
```

## Validation

Verified:

```bash
npm run build
npm run test:integration
```

## Next Phase Recommendation

Phase 14 should add production-grade authentication internals:

- signed JWT access tokens
- refresh token rotation
- OTP provider abstraction
- session table
- rate limiting
- auth middleware with roles
- admin role guard
