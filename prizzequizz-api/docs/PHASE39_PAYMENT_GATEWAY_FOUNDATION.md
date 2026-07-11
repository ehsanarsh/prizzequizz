# Phase 39 — Payment Gateway Foundation

## Scope

Phase 39 adds payment-gateway abstraction and a sandbox provider for wallet top-ups.

## Backend

### Domain

```text
PaymentIntent
PaymentProvider
PaymentIntentStatus
```

Statuses:

```text
created
pending
paid
failed
expired
```

### Repository

New `PaymentRepository` implemented for:

- memory repository
- PostgreSQL repository

### Migration

```text
database/migrations/011_payment_intents.sql
```

Table:

```text
payment_intents
```

### Service

```text
src/services/paymentService.ts
```

Responsibilities:

- create payment intent
- create pending top-up transaction
- verify payment
- idempotency support
- credit wallet after successful payment
- update transaction status
- payment diagnostics

### API

User endpoints:

```http
POST /v1/payments/intents
GET  /v1/payments/intents/:id
POST /v1/payments/intents/:id/verify
GET  /v1/payments/sandbox/:id/pay
```

Admin endpoints:

```http
GET /v1/admin/payments/diagnostics
GET /v1/admin/payments/intents
```

## PWA

The API client now includes:

```ts
api.payments.createIntent()
api.payments.getIntent()
api.payments.verifyIntent()
```

Wallet top-up now uses the payment-intent flow when available, with sandbox verification in development.

Admin panel now includes a Payment tab showing provider, pending count, paid count, and paid amount.

## Config

```env
PAYMENT_PROVIDER=sandbox
```

## Validation

Validated with:

```bash
cd prizzequizz-api
npm run build
npm run test:integration
npm run test:realtime
npm run test:matchmaking

cd ../prizzequizz-pwa
npm run typecheck
npm run build
```

## Next phase recommendation

Phase 40 should harden PostgreSQL production persistence and migrations.
