# Phase 34 — Reward Hold + Manual Review Queue

## Scope

Phase 34 adds a manual review queue for high-risk rewards. Paid cash rewards from high-risk or critical-risk users are no longer granted immediately. They are held until an admin approves or rejects them.

## Backend

### New domain model

```text
RewardHold
```

Statuses:

```text
pending
approved
rejected
released
```

### New repository

```text
RewardHoldRepository
```

Implemented for:

- memory repositories
- PostgreSQL repositories

### New migration

```text
database/migrations/008_reward_holds.sql
```

Table:

```text
reward_holds
```

### New service

```text
src/services/rewardReviewService.ts
```

Responsibilities:

- decide whether a reward should be held
- create reward holds
- list reward holds
- expose diagnostics
- approve/reject holds
- release approved rewards

### Admin endpoints

```http
GET   /v1/admin/rewards/holds/diagnostics
GET   /v1/admin/rewards/holds?status=pending&limit=100
PATCH /v1/admin/rewards/holds/:id/status
```

Supported review actions:

```json
{ "status": "approved" }
{ "status": "rejected" }
```

Approving a hold releases the reward, updates the user wallet/coins/xp, writes a transaction, updates reward status, and updates winnings leaderboard.

## Reward Engine Integration

`applyReward()` now checks the user risk profile before granting paid cash rewards.

A hold is created when:

- `REWARD_HOLD_ENABLED` is not `false`
- reward type is `cash`
- user risk level is `high` or `critical`, or risk score is at least 55

## PWA Admin Panel

The admin panel now includes a `Review` tab showing:

- pending holds
- pending amount
- released count
- rejected count
- approve/reject buttons

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

Phase 35 should add a financial operations dashboard for withdrawals, reward liability, held rewards, and CSV/Excel exports.
