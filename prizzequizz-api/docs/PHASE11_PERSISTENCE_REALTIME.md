# Phase 11 — Persistence, Idempotency, and Realtime Backend Scaffold

## Completed

This phase hardens the backend foundation beyond the initial in-memory API skeleton.

## Added

### Idempotent Answer Submission

`matchEngine.submitAnswer()` now accepts:

- `matchId`
- `userId`
- `questionId`
- `selectedIndex`
- `correct`
- `answerTimeMs`
- `idempotencyKey`

Duplicate answer submissions with the same idempotency key return the existing match state without double-scoring.

### Reward Settlement Idempotency

`rewardEngine.applyReward()` now prevents duplicate reward settlement with:

```text
matchId:userId:rewardType:match_result
```

### Match Event Log

An in-memory event log was added for important transitions:

- `MATCH_CREATED`
- `MATCH_STARTED`
- `ANSWER_SUBMITTED`
- `MATCH_FINISHED`

This maps directly to the future PostgreSQL `match_events` table.

### Active Match State Store

Added:

```text
src/services/matchStateStore.ts
```

Includes:

- `MatchStateStore` interface
- `MemoryMatchStateStore`
- TTL-ready active match state

This prepares the backend for Redis-backed active match state.

### PostgreSQL Migration Runner

Added:

```text
src/database/postgres.ts
src/scripts/migrate.ts
```

Run:

```bash
DATABASE_URL=postgres://... npm run migrate
```

If `DATABASE_URL` is not set, migrations are skipped safely.

### New Migrations

Added:

```text
database/migrations/002_rewards_events_sessions.sql
```

Tables:

- `rewards`
- `match_events`
- `game_sessions`
- `admin_logs`

### Realtime Gateway

Added:

```text
src/realtime/gateway.ts
```

WebSocket endpoint:

```text
ws://localhost:3000/v1/realtime
```

Current behavior:

- sends `server:connected`
- echoes client events as `server:ack_*`
- provides a stable scaffold for real match events

## Verification

Backend build passes:

```bash
npm run build
```

Health endpoint verified:

```text
GET /v1/health
```

Frontend build still passes:

```bash
npm run typecheck
npm run build
```

## Next Phase Recommendation

Phase 12 should implement real PostgreSQL repository adapters and switch services from direct memory maps to repository interfaces.

Recommended order:

1. `UserRepository`
2. `QuestionRepository`
3. `MatchRepository`
4. `TransactionRepository`
5. `RewardRepository`
6. `AnswerRepository`
7. Environment-based repository selection: memory vs postgres
8. Integration tests for both modes
