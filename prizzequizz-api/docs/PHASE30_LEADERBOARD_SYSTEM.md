# Phase 30 — Leaderboard System + Realtime Leaderboard

## Scope

Phase 30 adds a production-oriented leaderboard layer for PrizzeQuizz:

- Weekly leaderboard based on `weeklyScore`
- Overall leaderboard based on total `xp`
- Highest winnings leaderboard based on granted reward/win transactions
- Memory adapter for local/dev/test mode
- Redis sorted-set adapter for scalable production mode
- Public leaderboard API endpoints
- Admin diagnostics endpoint
- WebSocket subscription for realtime leaderboard updates
- PWA rankings screen connected to the API and realtime updates

## Backend

### API endpoints

```http
GET /v1/leaderboards/weekly?limit=50
GET /v1/leaderboards/overall?limit=50
GET /v1/leaderboards/winnings?limit=50
GET /v1/leaderboards/:kind?limit=50
GET /v1/admin/leaderboards/diagnostics
```

`kind` can be one of:

- `weekly`
- `overall`
- `winnings`

### Service

Main implementation:

```text
src/services/leaderboardService.ts
```

The service exposes:

- `get(kind, limit, viewerUserId)`
- `updateUser(user)`
- `recordReward(user, reward)`
- `diagnostics()`

It updates weekly/overall scores after match skill updates and increments winnings after reward settlement.

### Redis adapter

Enable Redis sorted-set leaderboards with:

```env
LEADERBOARD_ADAPTER=redis
REDIS_URL=redis://localhost:6379
```

Redis keys:

```text
prizzequizz:leaderboard:weekly
prizzequizz:leaderboard:overall
prizzequizz:leaderboard:winnings
```

The service falls back to repository-derived rankings if the adapter has no rows or if Redis is unavailable.

### Realtime protocol

Client events:

```text
client:subscribe_leaderboard
client:unsubscribe_leaderboard
```

Server event:

```text
server:leaderboard_update
```

Payload:

```json
{
  "kind": "weekly",
  "leaderboard": {
    "kind": "weekly",
    "title": "Weekly XP League",
    "metricLabel": "weeklyScore",
    "generatedAt": "...",
    "entries": []
  }
}
```

## Frontend PWA

### API contract

The PWA API client now includes:

```ts
api.leaderboards.weekly(limit)
api.leaderboards.overall(limit)
api.leaderboards.winnings(limit)
api.leaderboards.get(kind, limit)
```

### Rankings screen

`src/screens/rankings.screen.ts` now renders live API-backed tabs:

- Weekly
- Overall XP
- Winnings

It supports loading, error, empty, cached and realtime-updated states.

### Feature state

```text
src/features/leaderboards/leaderboard.state.ts
```

Handles leaderboard cache, API hydration, and WebSocket subscriptions.

## Validation

Phase 30 was validated with:

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
