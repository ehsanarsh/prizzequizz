# Phase 35 — Financial Operations Dashboard + Withdraw Review

## Scope

Phase 35 adds financial operations tooling for PrizzeQuizz admin.

## Backend

### New service

```text
src/services/financeService.ts
```

Responsibilities:

- calculate financial KPIs
- list withdrawal requests
- approve/reject withdrawals
- refund rejected withdrawal amounts
- export transactions as CSV
- notify users after withdrawal review

### Repository updates

`TransactionRepository` now supports:

```text
findById
list(filter)
updateStatus
```

Implemented for:

- memory repositories
- PostgreSQL repositories

### Admin endpoints

```http
GET   /v1/admin/finance/diagnostics
GET   /v1/admin/finance/withdrawals?status=pending&limit=100
GET   /v1/admin/finance/withdrawals?format=csv
PATCH /v1/admin/finance/withdrawals/:id/status
```

Review payloads:

```json
{ "action": "approve" }
{ "action": "reject" }
```

Approve changes a withdrawal transaction to `paid`.

Reject changes a withdrawal transaction to `failed` and refunds the amount to the user wallet with a `withdraw_refund` transaction.

## PWA Admin Panel

A new Admin tab was added:

```text
Finance
```

It displays:

- total topups
- pending withdrawals
- paid rewards
- net cash flow
- pending reward-hold liability
- pending withdrawal list
- approve/reject withdrawal actions

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

Phase 36 should add Support Operations / Complaint Review, connecting tickets to users, matches, withdrawals, reward holds, and admin actions.
