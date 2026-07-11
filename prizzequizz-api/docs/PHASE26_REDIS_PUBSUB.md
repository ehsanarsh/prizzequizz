# Phase 26 — Redis Pub/Sub for Multi-instance Realtime

## Completed

This phase replaces the realtime pub/sub placeholder with a real Redis-backed adapter while preserving the memory adapter for local and test environments.

## Added / Updated

```text
src/realtime/pubSub.ts
src/realtime/roomRegistry.ts
docker-compose.yml
package.json
```

## Redis Adapter

`RedisRealtimePubSub` now uses the official `redis` package.

It creates separate clients for:

- publishing
- subscribing

This is required because Redis pub/sub subscriber connections cannot be used for normal commands.

## Adapter Selection

```env
REALTIME_ADAPTER=redis
REDIS_URL=redis://localhost:6379
```

If `REALTIME_ADAPTER=redis` and `REDIS_URL` are configured, Redis is used. Otherwise the in-memory adapter remains active.

## Duplicate Broadcast Protection

The room registry now tracks subscribed rooms.

When a room is subscribed:

```text
broadcast -> Redis publish -> local subscriber handler -> local delivery
```

When a room is not subscribed:

```text
broadcast -> local delivery
```

This prevents duplicate messages in single-instance mode while allowing cross-instance broadcast in Redis mode.

## Docker Compose

The API service now sets:

```yaml
REALTIME_ADAPTER: redis
REDIS_URL: redis://redis:6379
```

So Docker Compose runs the API in Redis realtime mode.

## Validation

Backend:

```bash
npm run build
npm run test:integration
```

Passed.

## Next Phase Recommendation

Phase 27 should add multi-instance realtime testing and client UX polish for server-driven match events:

1. Start two API instances in test mode.
2. Connect two WebSocket clients to different instances.
3. Verify Redis pub/sub broadcasts across instances.
4. Add room presence TTL in Redis.
5. Add match snapshot recovery from Redis state.
