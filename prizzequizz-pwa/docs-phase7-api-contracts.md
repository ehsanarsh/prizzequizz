# Phase 7 — Backend Contract Layer + API Client

## Goal

This phase introduces a backend-facing contract layer without forcing the UI to depend directly on a real backend. The app can continue using mock data, while every feature now has a clear path to production APIs.

## Added Files

```text
src/api/contracts.ts
src/api/client.ts
src/api/errors.ts
src/api/mockAdapter.ts
src/api/httpAdapter.ts
src/api/realtime.ts
src/api/index.ts
src/vite-env.d.ts
```

## What This Enables

- API DTOs are centralized.
- Mock and real API clients share the same interface.
- The UI can migrate endpoint by endpoint.
- Realtime contracts are available before WebSocket implementation.
- Errors can be normalized consistently.
- Retry and timeout behavior are centralized in the HTTP adapter.

## API Adapter Strategy

By default, the app uses the mock adapter:

```ts
export const api = createMockApi();
```

If `VITE_API_BASE_URL` exists, the app uses the HTTP adapter:

```env
VITE_API_BASE_URL=https://api.prizzequizz.example/v1
```

## Current Integration

The existing `services/mockApi.ts` now routes through the new API contract layer:

```ts
api.questions.next()
api.questions.submitAnswer(...)
```

This preserves current Duel behavior while preparing for backend replacement.

## Next Suggested Phase

Phase 8 should migrate feature modules to use the API client directly:

1. Duel match creation through `api.matches.create()`
2. Question loading through `api.questions.next(matchId)`
3. Answer submission through `api.questions.submitAnswer()`
4. Reward settlement through `api.rewards.claim()`
5. Wallet through `api.wallet.*`
6. Friends and Support through their respective API modules

## Production Notes

- Backend must remain authoritative for reward calculation.
- Client rewards are UI previews only until backend settlement.
- Idempotency keys are required for answer submission and reward claiming.
- Active match state should eventually come from WebSocket snapshots.
