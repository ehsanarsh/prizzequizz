# Phase 24 — Realtime UX Hardening

## Completed

This phase makes realtime Duel interactions safer and clearer for users.

## Added

### Duel Reconnect Overlay

The Duel screen now shows an inline reconnect overlay when realtime is disconnected or reconnecting.

The overlay explains:

- connection is being restored
- answer and chat interactions are temporarily disabled
- current match state will be recovered from snapshot

### Answer Lock During Disconnect

Answer buttons are disabled when:

```ts
!ui.realtime.connected || ui.realtime.reconnecting
```

This prevents unsafe submissions while the client is out of sync with the server.

### Optimistic Chat

When sending a Duel chat message:

- the message appears immediately with a pending state
- when the server echoes `server:chat`, the pending message is confirmed
- duplicate local echo is avoided

### Realtime Chat UX

The Duel live chat now supports:

- pending message label
- disabled input while disconnected
- system messages for missing room or offline state

## Backend Test Update

Realtime integration test now also covers:

```text
client:submit_answer -> server:answer_result
client:submit_answer -> server:match_snapshot
```

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

Phase 25 should implement Redis Pub/Sub for multi-instance realtime scaling.
