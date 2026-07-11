# Phase 29 — Matchmaking Production Hardening

## Completed

This phase hardens matchmaking beyond a simple memory queue.

## Added / Updated

```text
src/services/matchmakingQueue.ts
src/services/matchmakingWorker.ts
src/services/botProfiles.ts
src/services/skillRating.ts
src/modules/matchmaking/routes.ts
src/tests/matchmaking-load.ts
```

## Redis Sorted Set Queue

Added `RedisMatchmakingQueue`.

Queue key pattern:

```text
mm:q:<modeId>:<economyType>
```

Ticket key pattern:

```text
mm:ticket:<ticketId>
```

Redis mode is enabled with:

```env
MATCHMAKING_ADAPTER=redis
REDIS_URL=redis://localhost:6379
```

## Memory Queue Preserved

`MemoryMatchmakingQueue` remains available for local development and tests.

Default:

```env
MATCHMAKING_ADAPTER=memory
```

## Match Quality

Matchmaking tickets now include:

```text
excellent
good
wide
bot
```

Quality is based on skill delta.

## Skill Widening

Skill window expands over wait time:

- initial: strict
- after 10s: wider
- after 20s: very wide

## Bot Fallback

Added bot profiles:

```text
FoxRush
PandaMind
TigerQuiz
AlienXP
```

Bot fallback chooses the closest bot by skill.

## Timeout Worker

`matchmakingWorker.ts` periodically:

- expires old tickets
- triggers bot fallback for long waiters

Config:

```env
MATCHMAKING_WORKER=true
MATCHMAKING_WORKER_INTERVAL_MS=5000
MATCHMAKING_BOT_FALLBACK_MS=30000
MATCHMAKING_EXPIRE_MS=60000
```

## Admin Analytics

The existing matchmaking stats endpoint is available:

```text
GET /v1/matchmaking/stats
```

Admin can also inspect matchmaking through backend logs and future admin analytics UI.

## PWA Integration

Duel search now uses:

```ts
api.matchmaking.enqueue()
api.matchmaking.get()
api.matchmaking.bot()
```

The matchmaking screen displays:

- wait time
- match quality
- bot fallback indicator

## Load Test

Added:

```bash
npm run test:matchmaking
```

The test creates users and enqueues them into the memory matchmaking queue.

## Validation

```bash
npm run build
npm run test:integration
npm run test:realtime
npm run test:matchmaking
```

## Next Phase Recommendation

Phase 30 should implement Leaderboard service and realtime leaderboard updates:

1. Weekly XP leaderboard
2. Overall XP leaderboard
3. Highest cash winnings leaderboard
4. Redis sorted set leaderboard adapter
5. Admin leaderboard diagnostics
6. PWA leaderboard live updates
