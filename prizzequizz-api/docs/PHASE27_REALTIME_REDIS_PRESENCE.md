# Phase 27 — Realtime Redis Presence + Multi-instance Smoke Test

## Completed

This phase strengthens realtime scalability by adding a presence store abstraction and a multi-server smoke test.

## Added / Updated

```text
src/realtime/presenceStore.ts
src/realtime/roomRegistry.ts
src/realtime/gateway.ts
src/tests/realtime-multi-instance.ts
package.json
```

## Presence Store

Added `RealtimePresenceStore` with:

- `MemoryRealtimePresenceStore`
- `RedisRealtimePresenceStore`

The Redis implementation stores presence per match using expiring keys:

```text
presence:match:<matchId>:clients
presence:match:<matchId>:client:<clientId>
```

## Presence TTL

Configurable via:

```env
REALTIME_PRESENCE_TTL_SECONDS=45
```

Memory mode also has TTL cleanup.

## Room Registry Integration

Room registry now writes presence on:

- join
- leave
- touch
- cleanup

Presence reads are now async so the gateway can return global presence when Redis is used.

## Realtime Gateway Updates

`client:join_match` now sends a direct `server:presence` response to the joining client and broadcasts presence to the match room.

## Multi-instance Smoke Test

Added:

```bash
npm run test:realtime
```

The smoke test starts two API server instances in the same process and verifies:

- WebSocket clients can connect to different server instances.
- Both can join the same match.
- Presence is emitted.
- Chat broadcast reaches the other client.

This is a local smoke test. True cross-process Redis testing can be added once CI has a Redis service available.

## Validation

```bash
npm run build
npm run test:integration
npm run test:realtime
```

## Next Phase Recommendation

Phase 28 should implement production matchmaking:

1. Matchmaking queue abstraction.
2. Memory queue implementation.
3. Redis sorted-set queue implementation.
4. Skill/rank filters.
5. Timeout fallback.
6. Bot fallback for long waits.
7. Realtime `server:match_found` event.
