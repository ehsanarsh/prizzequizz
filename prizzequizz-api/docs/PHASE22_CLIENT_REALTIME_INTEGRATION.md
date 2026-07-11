# Phase 22 — Client-side Realtime Integration

## Completed

This phase connects the PWA to the realtime backend gateway and adds client-side match synchronization.

## Frontend Changes

### Real WebSocket Client

Updated:

```text
prizzequizz-pwa/src/api/realtime.ts
prizzequizz-pwa/src/api/index.ts
```

Added:

- `WebSocketRealtimeClient`
- message queue while connecting
- connection state tracking
- error event normalization
- automatic WebSocket URL derived from `VITE_API_BASE_URL`

If `VITE_API_BASE_URL` is set:

```env
VITE_API_BASE_URL=http://localhost:3000/v1
```

Realtime connects to:

```text
ws://localhost:3000/v1/realtime
```

with token query param when available.

### Realtime Manager

Updated:

```text
prizzequizz-pwa/src/services/realtimeManager.ts
```

Added:

- heartbeat ping
- reconnect backoff
- join match by event
- leave match helper
- realtime chat helper
- match snapshot application
- opponent score sync
- opponent profile sync

### Duel Integration

Updated:

```text
prizzequizz-pwa/src/features/duel/duel.logic.ts
```

After match creation, Duel emits:

```text
DUEL_MATCH_CREATED
```

The realtime manager then joins the match room and receives snapshots/presence.

## Backend Support

Uses Phase 20/21 backend realtime infrastructure:

- `client:join_match`
- `server:match_snapshot`
- `server:presence`
- `server:chat`
- `server:pong`

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

Phase 23 should implement real Redis Pub/Sub or improve frontend realtime UX further:

Recommended next step:

1. Realtime UI status badge in PWA.
2. Live presence indicator in Duel.
3. Live chat in Duel through `sendRealtimeChat()`.
4. Then Redis Pub/Sub implementation.
