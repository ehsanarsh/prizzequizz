# Phase 14 — Auth Hardening + Security Layer

## Completed

This phase improves authentication and basic API protection.

## Added

```text
src/services/tokenService.ts
src/services/otpProvider.ts
src/services/sessionService.ts
src/middleware/rateLimiter.ts
database/migrations/004_sessions_security.sql
```

## Auth Changes

- HMAC-signed access tokens.
- HMAC-signed refresh tokens.
- Refresh token rotation.
- Logout / revoke refresh token.
- OTP provider abstraction with memory implementation.
- Production guard requiring JWT secrets.

## New Auth Endpoints

```text
POST /v1/auth/login
POST /v1/auth/otp/verify
POST /v1/auth/refresh
POST /v1/auth/logout
```

## Rate Limiting

A lightweight in-memory rate limiter is applied globally at the router layer.

Defaults:

- Auth endpoints: 12 requests per minute per IP/path.
- Other endpoints: 120 requests per minute per IP/path.

## Security Migration

Added tables:

- `sessions`
- `security_events`

Added column:

- `users.role`

## Notes

The current session store is in-memory for development. The migration prepares the database for persistent sessions in a future phase.

## Validation

Run:

```bash
npm run build
npm run test:integration
```
