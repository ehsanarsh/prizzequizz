# Phase 20 — Realtime Match Infrastructure

## Completed

This phase upgrades the WebSocket gateway from a basic echo scaffold into a match-aware realtime infrastructure layer.

## Added / Updated

```text
src/realtime/protocol.ts
src/realtime/roomRegistry.ts
src/realtime/gateway.ts
src/tests/integration.ts
```

## Realtime Endpoint

```text
ws://localhost:3000/v1/realtime
```

Supports token via query string:

```text
/v1/realtime?token=<access-token>
```

## Client Events

```text
client:ping
client:join_match
client:leave_match
client:submit_answer
client:send_chat
```

## Server Events

```text
server:connected
server:pong
server:match_snapshot
server:answer_result
server:match_finished
server:chat
server:presence
server:error
```

## Room Registry

`RealtimeRoomRegistry` manages:

- connected clients
- user metadata
- match rooms
- join / leave
- presence snapshots
- room broadcast
- direct send

## Match-Aware Realtime Flow

### Join Match

Client sends:

```json
{
  "type": "client:join_match",
  "payload": { "matchId": "..." }
}
```

Server responds:

```text
server:match_snapshot
server:presence
```

### Submit Answer

Client sends:

```json
{
  "type": "client:submit_answer",
  "payload": {
    "matchId": "...",
    "questionId": "...",
    "selectedIndex": 2,
    "answerTimeMs": 1500,
    "idempotencyKey": "..."
  }
}
```

Server broadcasts:

```text
server:answer_result
server:match_snapshot
server:match_finished  // if result phase reached
```

### Chat

Client sends:

```json
{
  "type": "client:send_chat",
  "payload": {
    "matchId": "...",
    "text": "سلام"
  }
}
```

Server broadcasts:

```text
server:chat
```

## Performance / Stability

- Room broadcasts only target clients in the match room.
- Presence payload is minimal.
- Message validation is defensive.
- Unknown events return `server:error`.
- Uses existing match engine and answer idempotency.

## Integration Test

The integration test now verifies:

- WebSocket connection
- `server:connected`
- `client:join_match` → `server:match_snapshot`
- `client:ping` → `server:pong`
- `client:send_chat` → `server:chat`

Run:

```bash
npm run test:integration
```

## Next Phase Recommendation

Phase 21 should implement production-grade realtime persistence and resilience:

1. Redis room adapter.
2. Cross-instance pub/sub.
3. Reconnect recovery with match snapshots.
4. Presence TTL cleanup.
5. WebSocket auth hardening.
6. Realtime load tests.
7. Client-side realtime integration in the PWA.
