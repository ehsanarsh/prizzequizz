# Phase 32 — Anti-Cheat Foundation + Match Integrity Monitoring

## Scope

Phase 32 adds the first production-grade integrity monitoring layer for PrizzeQuizz. This phase does not block gameplay yet; it records and surfaces risk signals so the product team can monitor suspicious matches safely before stricter enforcement is introduced.

## Backend Additions

### New service

```text
src/services/integrityService.ts
```

The service inspects answer submissions and finished matches.

### Signal types

```text
IMPOSSIBLE_ANSWER_TIME
FAST_CORRECT_ANSWER
ANSWER_BURST
IDEMPOTENCY_REPLAY
REPEATED_QUESTION_ANSWER
PERFECT_FAST_MATCH
SCORE_ANOMALY
```

### Signal fields

Each integrity signal contains:

```text
id
matchId
userId
questionId
type
severity
riskScore
status
evidence
createdAt
reviewedAt
reviewedBy
```

### Status lifecycle

```text
open -> reviewing -> confirmed / dismissed
```

## Repository / Persistence

New domain model:

```text
IntegritySignal
```

New repository contract:

```text
IntegrityRepository
```

Implemented for:

- Memory repository
- PostgreSQL repository

New migration:

```text
database/migrations/006_integrity_signals.sql
```

New table:

```text
integrity_signals
```

## Admin API

```http
GET   /v1/admin/integrity/diagnostics
GET   /v1/admin/integrity/signals?status=open&severity=critical&limit=100
PATCH /v1/admin/integrity/signals/:id/status
```

## Match Integration

`submitAnswer()` now records non-blocking integrity signals for:

- impossible answer times
- very fast correct answers
- answer bursts
- repeated answers to the same question
- idempotency replay attempts

When a match finishes, it checks for:

- perfect fast matches
- impossible score anomalies

## Frontend Admin Panel

The admin panel now has an **Anti-Cheat** tab.

It displays:

- open signals
- critical signals
- average risk
- confirmed signals
- top risk users
- recent signals
- evidence preview
- Review / Confirm / Dismiss actions

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

## Future Enforcement Recommendations

Next anti-cheat hardening steps:

1. Device fingerprint binding
2. IP/device/user risk graph
3. reward-hold for high-risk matches
4. admin review queue SLA
5. automatic ban / cooldown rules
6. appeal workflow
7. fraud analytics dashboard
