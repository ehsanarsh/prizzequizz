# Phase 9 — Production Hardening: Auth, Session, Loading/Error UX, API Readiness

## Completed

This phase moves the modular PWA closer to a production frontend by adding application bootstrap, auth/session management, network/realtime lifecycle hooks, and hardened API-connected feature modules.

## Added / Updated

### Auth and Session

```text
src/features/auth/session.ts
src/screens/login.screen.ts
```

Implemented:

- Access/refresh token storage keys.
- `bootstrapSession()` to hydrate the logged-in user from API.
- `loginWithOtp()` for login flow.
- `logout()` event hook.
- Login screen for real backend mode.

### API Readiness

Duel now uses the API contract layer more directly:

- `api.matches.create()`
- `api.matches.start()`
- `api.questions.next(matchId)`
- `api.questions.submitAnswer()`

### Realtime Readiness

```text
src/services/realtimeManager.ts
src/services/networkStatus.ts
```

Implemented:

- Network online/offline event bridge.
- Mock realtime lifecycle.
- Reconnect event hook.
- Snackbar feedback for connection state.

### Async UX

```text
src/core/asyncTask.ts
src/components/statusViews.ts
```

Implemented:

- Global loading state.
- Global error state.
- Retry-ready error components.
- Skeleton views.
- Empty states.

### Wallet / Friends / Support

These modules now hydrate through the API layer and expose loading/error UI.

## Validation

The project now passes:

```bash
npm run typecheck
npm run build
```

Production build output:

```text
dist/index.html
dist/assets/*.css
dist/assets/*.js
```

## Next Phase Recommendation

Phase 10 should implement the actual backend service skeleton matching the API contracts:

1. Node/TypeScript backend scaffold.
2. Auth endpoints.
3. Match endpoints.
4. Question endpoints.
5. Wallet endpoints.
6. WebSocket gateway.
7. PostgreSQL schema migrations.
8. Redis match state adapter.

At that point the frontend can be connected to a real server by setting:

```env
VITE_API_BASE_URL=http://localhost:3000/v1
```
