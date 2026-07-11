# Phase 17 — Admin Expansion: Import/Export, Reward Tuning, Feature Flags, Themes

## Completed

This phase expands the admin foundation into a more practical operations tool.

## Backend Additions

### Question Import / Export

Added endpoints:

```text
GET  /v1/admin/questions/export?format=json|csv&status=approved|pending|rejected
POST /v1/admin/questions/import
```

Import body:

```json
{
  "questions": [
    {
      "text": "Question text",
      "options": ["A", "B", "C", "D"],
      "correctIndex": 0,
      "category": "General",
      "difficulty": "easy",
      "tags": [],
      "status": "pending"
    }
  ]
}
```

### Reward Tuning

Added endpoints:

```text
GET   /v1/admin/rewards/tuning
PATCH /v1/admin/rewards/tuning/:modeId
```

### Feature Flags

Added endpoints:

```text
GET   /v1/admin/feature-flags
PATCH /v1/admin/feature-flags/:key
```

### Themes

Added endpoints:

```text
GET  /v1/admin/themes
POST /v1/admin/themes
```

### Admin Stores

Added:

```text
src/services/adminStores.ts
```

Currently memory-backed for MVP. Can later be persisted into PostgreSQL.

## Frontend Admin Additions

Updated:

```text
src/features/admin/admin.state.ts
src/screens/admin.screen.ts
src/main.ts
src/styles/components.css
```

Admin tabs now include:

- Overview
- Config
- Questions
- Rewards
- Flags
- Themes
- Audit

## Validation

Frontend:

```bash
npm run typecheck
npm run build
```

Backend:

```bash
npm run build
npm run test:integration
```

All passed.

## Next Phase Recommendation

Phase 18 should implement observability and operational readiness:

1. Structured logger
2. Request logging middleware
3. Metrics endpoint
4. Error tracking format
5. Health readiness/deep checks
6. Performance timing for critical endpoints
7. Admin analytics backed by repository queries instead of memory counters
