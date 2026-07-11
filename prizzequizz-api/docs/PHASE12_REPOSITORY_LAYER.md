# Phase 12 — Repository Layer + PostgreSQL Adapter

## Completed

This phase introduces the repository abstraction layer and starts moving backend services away from direct in-memory maps.

## Added

```text
src/repositories/contracts.ts
src/repositories/memoryRepositories.ts
src/repositories/postgresRepositories.ts
src/repositories/index.ts
```

## Repository Interfaces

- `UserRepository`
- `QuestionRepository`
- `MatchRepository`
- `AnswerRepository`
- `RewardRepository`
- `TransactionRepository`
- `MatchEventRepository`

## Implementations

### Memory

`memoryRepositories.ts` wraps the existing memory maps and preserves current behavior.

### PostgreSQL

`postgresRepositories.ts` implements the same contracts using `pg`.

The active repository driver is selected by:

```text
REPOSITORY_DRIVER=memory
REPOSITORY_DRIVER=postgres
```

If `DATABASE_URL` exists and `REPOSITORY_DRIVER` is not set, postgres is selected automatically.

## Service Refactors

Updated services to use repositories:

- `economyEngine.ts`
- `questionEngine.ts`
- `rewardEngine.ts`
- `matchEngine.ts`
- `wallet/routes.ts`
- `users/routes.ts`
- `auth/routes.ts`
- `matches/routes.ts`
- `questions/routes.ts`

## Database Migration

Added:

```text
database/migrations/003_user_tickets_json.sql
```

Adds JSON ticket storage to users.

## Validation

Backend build passes:

```bash
npm run build
```

Frontend build still passes:

```bash
npm run typecheck
npm run build
```

## Next Phase Recommendation

Phase 13 should implement automated integration tests and a local docker-compose environment for:

- PostgreSQL
- Redis
- API
- PWA dev server

Then add test coverage for:

1. Auth flow
2. Match create/start/answer/result
3. Idempotent answer submission
4. Reward idempotency
5. Wallet topup/withdraw
6. Friends request/invite
7. Support ticket creation
