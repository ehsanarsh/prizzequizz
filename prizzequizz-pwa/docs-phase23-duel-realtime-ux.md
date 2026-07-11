# Phase 23 — Duel Realtime UX

## Completed

This phase connects the client-side realtime layer to the Duel screen experience.

## Added

### Realtime status in Duel

The Duel screen now shows a compact live status strip:

- Online
- Reconnecting
- Offline
- Snapshot recovered
- Opponent presence if available

### Live Duel chat

The Duel screen now includes a lightweight realtime chat panel:

- recent messages
- system connection messages
- local user messages
- opponent messages
- disabled input while disconnected

### Realtime Manager improvements

Updated:

```text
src/services/realtimeManager.ts
```

Now handles:

- `server:connected`
- `server:disconnected`
- `server:presence`
- `server:chat`
- `server:match_snapshot`
- `server:match_finished`

And writes realtime state into:

```ts
ui.realtime
```

### Duel UI updates

Updated:

```text
src/screens/duel.screen.ts
```

Added:

- `duel-live-strip`
- `duel-live-chat`
- chat send input
- presence-aware status

### Main binding

Updated:

```text
src/main.ts
```

Added handler for:

```text
data-action="duel-live-chat"
```

## Validation

Frontend:

```bash
npm run typecheck
npm run build
```

Both passed.

## Next Phase Recommendation

Phase 24 should implement real-time UI hardening:

1. Disable answer submission while reconnecting in production API mode.
2. Add reconnect overlay for active matches.
3. Add optimistic chat pending state.
4. Add client-side WebSocket integration test.
5. Add backend Redis Pub/Sub implementation.
