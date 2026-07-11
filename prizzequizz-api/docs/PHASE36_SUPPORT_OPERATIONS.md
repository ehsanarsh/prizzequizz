# Phase 36 — Support Operations + Complaint Review

## Scope

Phase 36 turns support from a simple in-memory ticket list into an operations console connected to the rest of the product.

## Backend

### New domain models

```text
SupportTicket
SupportMessage
```

Ticket status:

```text
open
answered
closed
escalated
```

Priority:

```text
low
normal
high
urgent
```

Tickets can be linked to:

- match
- transaction
- reward hold

### Repository

New `SupportRepository` implemented for:

- memory repository
- PostgreSQL repository

### Migration

```text
database/migrations/009_support_operations.sql
```

Tables:

```text
support_tickets
support_messages
```

### User endpoints

```http
GET  /v1/support/tickets
POST /v1/support/tickets
GET  /v1/support/tickets/:id
```

### Admin endpoints

```http
GET   /v1/admin/support/diagnostics
GET   /v1/admin/support/tickets
GET   /v1/admin/support/tickets/:id
POST  /v1/admin/support/tickets/:id/reply
PATCH /v1/admin/support/tickets/:id/status
PATCH /v1/admin/support/tickets/:id/assign
```

## PWA Admin Panel

A new Admin tab was added:

```text
Support
```

It shows:

- open tickets
- answered tickets
- escalated tickets
- unassigned tickets
- ticket priority
- ticket body preview
- reply input
- close / escalate actions

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

Phase 37 should implement Payment Gateway Integration Foundation.
