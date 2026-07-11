# Phase 8 — Feature Modules Connected to API Contracts

## Completed

Wallet, Friends, and Support feature modules now use the centralized `PrizzeQuizzApi` contract instead of isolated local-only logic.

## Updated Modules

```text
src/features/wallet/wallet.state.ts
src/features/friends/friends.state.ts
src/features/support/support.state.ts
src/core/asyncTask.ts
src/screens/wallet.screen.ts
src/screens/friends.screen.ts
src/screens/support.screen.ts
src/main.ts
```

## Loading and Error State

The global UI state now supports:

```ts
ui.loading: Record<string, boolean>
ui.errors: Record<string, string | null>
ui.lastFailedAction?: string
```

`runTask()` standardizes async calls and emits `API_ERROR` events.

## Retry Actions

Screens can render retry buttons using `data-action="retry-wallet"`, `retry-friends`, or `retry-support`. The main binder maps these actions to their hydrate functions.

## API Migration Status

- Wallet: `api.wallet.get/topup/withdraw`
- Friends: `api.friends.list/sendRequest/invite`
- Support: `api.support.listTickets/createTicket`
- Duel questions already flow through `api.questions.next/submitAnswer`

## Next Phase

Phase 9 should focus on production hardening:

1. Auth session management.
2. Token refresh flow.
3. Real WebSocket client implementation.
4. Match Engine API integration for Duel.
5. E2E happy path test script.
