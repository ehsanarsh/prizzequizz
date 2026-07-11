# Phase 19 — Domain Errors, Validation Hardening, and Negative Tests

## Completed

This phase replaces ad-hoc `throw new Error()` behavior with a safer error and validation layer, and adds negative-path integration tests.

## Added Files

```text
src/core/errors.ts
src/utils/validation.ts
```

## Domain Error System

Added:

- `AppError`
- `ValidationError`
- `UnauthorizedError`
- `ForbiddenError`
- `NotFoundError`
- `ConflictError`
- `toAppError()`

Known domain errors are mapped to proper HTTP status codes:

- `INSUFFICIENT_HEARTS` → 409
- `INSUFFICIENT_COINS` → 409
- `INSUFFICIENT_BALANCE` → 409
- `QUESTION_NOT_FOUND` → 404
- `MATCH_NOT_FOUND` → 404
- `NO_QUESTIONS` → 503
- validation errors → 422

## Validation Helpers

Added helpers for request bodies:

- `bodyObject()`
- `requiredString()`
- `optionalString()`
- `requiredNumber()`
- `optionalNumber()`
- `requiredOptions()`

Applied to:

- Auth login
- OTP verify
- Refresh/logout
- Wallet topup/withdraw

## Request ID Propagation

The router now sets:

```text
x-request-id
```

Responses reuse the same request id where available.

## Security Event Logging

Added:

```text
src/services/securityEvents.ts
```

Security events are recorded for:

- invalid OTP
- rate limit hits
- invalid access token
- refresh failure

Currently memory-backed and logged as structured JSON.

## Router Error Handling

Router now:

- normalizes unknown errors
- maps domain errors to proper status codes
- logs structured failure details
- records metrics for success and failure paths

## Negative Integration Tests

Added tests for:

- invalid OTP → 401
- invalid wallet topup body → 422
- unauthorized admin access → 403

## Validation

Backend:

```bash
npm run build
npm run test:integration
```

Frontend remains valid:

```bash
cd prizzequizz-pwa
npm run typecheck
npm run build
```

## Next Phase Recommendation

Phase 20 should focus on real-time game infrastructure:

1. WebSocket room registry
2. Match channel join/leave
3. Server push match snapshots
4. Presence tracking
5. Reconnect snapshot recovery
6. Realtime integration tests
