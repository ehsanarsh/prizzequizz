# PrizzeQuizz PWA — Modular Frontend Scaffold

This is the first modular PWA phase extracted from the approved HTML prototype.

## Baseline Prototype

The approved prototype is archived at:

```text
public/prototype-baseline-v54.html
```

## What is implemented in this scaffold

- Vite + TypeScript project structure
- Core state store
- Router
- Screen manager
- Event bus
- Config-driven game mode definitions
- Mock question API
- Practice economy module
- Duel feature skeleton
- Reward animation hook
- Theme tokens
- Safe-area-ready mobile shell
- PWA manifest and service worker

## Current screens

- Splash
- Home
- Mode Entry
- Duel
- Result
- Placeholder pages for Wallet, Missions, Friends, Support, Rankings, Settings

## Run locally

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:5173
```

## Build

```bash
npm run build
```

## Development plan

Next migration order:

1. Finish shared UI components: Modal, BottomSheet, Snackbar, TimerRing.
2. Port Free/Paid economy UI from the approved prototype.
3. Complete Duel mode UI parity.
4. Port Wallet.
5. Port Missions.
6. Port Friends.
7. Port Support.
8. Port Lucky Wheel.
9. Add mock API contracts matching backend architecture package.
10. Replace mock services with real backend endpoints.

## Important rule

The old prototype must not be edited directly after this point except for emergency fixes. New work should happen inside this modular PWA structure.


## Phase 7 Update — API Contract Layer

The project now includes a backend contract layer under:

```text
src/api/
```

Added:

- `contracts.ts` — shared DTOs and response contracts
- `client.ts` — `PrizzeQuizzApi` interface
- `mockAdapter.ts` — in-memory mock backend
- `httpAdapter.ts` — production HTTP adapter with timeout and retry
- `realtime.ts` — WebSocket/realtime event contract and mock realtime client
- `index.ts` — adapter selector

The legacy `services/mockApi.ts` now delegates to the API layer, so features can migrate gradually without breaking existing UI.

To use a real backend later, set:

```env
VITE_API_BASE_URL=https://api.example.com/v1
```

See:

```text
docs-phase7-api-contracts.md
```


## Phase 8 Update — Feature API Integration

Wallet, Friends, and Support now call the centralized API contract layer. Loading and error states are stored in the global UI state and retry actions are wired at screen level.

See:

```text
docs-phase8-api-integration.md
```


## Phase 9 Update — Production Hardening

Added auth/session bootstrap, login screen, network/realtime lifecycle hooks, loading/error UI, retry-ready status views, and deeper API usage inside Duel and feature modules.

Validation completed:

```bash
npm run typecheck
npm run build
```

See:

```text
docs-phase9-production-hardening.md
```


## Phase 22 Update — Client-side Realtime Integration

The PWA now has a real WebSocket client that is automatically selected when `VITE_API_BASE_URL` is configured. Duel match creation emits a realtime join event, and realtime snapshots can update local Duel state.

See backend docs:

```text
../prizzequizz-api/docs/PHASE22_CLIENT_REALTIME_INTEGRATION.md
```


## Phase 24 Update — Realtime UX Hardening

Duel now includes reconnect overlay, disables unsafe answer/chat interactions while disconnected, and supports optimistic chat with pending confirmation.

See:

```text
docs-phase24-realtime-ux-hardening.md
```

## Phase 30 Rankings

The Rankings screen is now API-backed and realtime-capable. It exposes three tabs:

- Weekly score / weekly XP
- Overall XP
- Highest winnings

When `VITE_API_BASE_URL` is set, the PWA fetches `/v1/leaderboards/*` and subscribes to `server:leaderboard_update` over the existing realtime WebSocket.

## Phase 31 Notifications

The Settings screen now includes notification preferences, recent in-app notifications, and Push enablement.

To enable real browser Push subscription in connected mode, configure:

```env
VITE_VAPID_PUBLIC_KEY=...
```

The service worker handles `push` and `notificationclick` events.

## Phase 32 Admin Anti-Cheat

The Admin panel now includes an Anti-Cheat tab for match integrity monitoring, signal review, confirmation, and dismissal.

## Phase 33 Device Risk

The PWA now sends stable device headers with API requests and the Admin panel includes a Devices tab for risk users and device binding management.

## Phase 34 Reward Review

The Admin panel now includes a Review tab for pending high-risk cash rewards. Admins can approve to release the reward or reject it.

## Phase 35 Finance Admin

The Admin panel now includes a Finance tab for financial KPIs and withdrawal approve/reject operations.

## Phase 36 Support Admin

The Admin panel now includes a Support tab with ticket diagnostics, replies, closing, and escalation.

## Phase 37 Character Screen

The standalone Character Lab is now integrated into the main PWA as the Character screen. The PWA uses local layered PNG assets from `public/character-assets`.

## Phase 38 Character Admin

The Admin panel now includes a Character tab for catalog item management. The opponent profile modal was also polished to show a single avatar.

## Phase 39 Payment Foundation

Wallet top-up now uses the payment-intent flow where available. The Admin panel includes a Payment tab for payment diagnostics.

## Phase 40 Database Admin

The Admin panel now includes a DB tab for migration and schema verification.

## Phase 41 Admin Users

The Admin panel now includes a Users tab for user search/listing, overview, ban/unban, and role toggling.

## Phase 42 Client Error Reporting

The PWA now installs a global error reporter for JavaScript runtime errors and unhandled promise rejections. Admin has a Monitoring tab for crash reports.

## Phase 43 Closed Beta Admin

The Admin panel now includes a Beta tab for invite codes and beta user tracking.

## Phase 44 Release Package

Production env example:

- `.env.production.example`

Release docs are available at the repository root.
