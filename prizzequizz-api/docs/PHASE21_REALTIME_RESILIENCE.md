# Phase 21 — Realtime Production Resilience

## Completed

This phase hardens realtime infrastructure beyond a single-process WebSocket gateway.

## Added / Updated

```text
src/realtime/pubSub.ts
src/realtime/roomRegistry.ts
src/realtime/gateway.ts
src/modules/ops/routes.ts
```

## Pub/Sub Abstraction

Added `RealtimePubSub` interface with:

- `MemoryRealtimePubSub`
- `RedisRealtimePubSub` placeholder

The adapter is selected by:

```env
REALTIME_ADAPTER=redis
REDIS_URL=redis://localhost:6379
```

The Redis adapter is currently a safe placeholder that logs warnings. It preserves the interface and allows future cross-instance pub/sub implementation without changing the gateway API.

## Room Registry Enhancements

`RealtimeRoomRegistry` now supports:

- direct client send
- room broadcast
- join/leave
- presence
- stale connection cleanup
- room stats
- match channel subscription

## Presence Cleanup

The gateway runs a periodic stale-client cleanup loop.

The interval is `unref()`-ed so it does not block tests or graceful shutdown.

## Reconnect Recovery

Clients can recover current match state by sending:

```json
{
  "type": "client:join_match",
  "payload": { "matchId": "..." }
}
```

Server responds with:

```text
server:match_snapshot
server:presence
```

## Ops Endpoint

Added:

```text
GET /v1/realtime/stats
```

Returns:

```json
{
  "clients": 0,
  "rooms": 0
}
```

## Integration Tests

Realtime integration test covers:

- WebSocket connection
- match join
- match snapshot
- ping/pong
- chat broadcast

## Validation

```bash
npm run build
npm run test:integration
```

## Next Phase Recommendation

Phase 22 should implement real Redis pub/sub using a Redis client and add multi-instance realtime tests. If Redis infrastructure is not available yet, continue with client-side realtime integration in the PWA.
