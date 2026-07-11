# Phase 31 — Push Notification System + Notification Preferences

## Scope

Phase 31 adds a notification foundation for PrizzeQuizz:

- In-app notification records
- Browser Push subscription registration
- User notification preferences
- Quiet-hours support
- Match, wallet and reward notification hooks
- Admin diagnostics
- Admin broadcast tooling
- PWA settings screen for notification preferences
- Service worker `push` and `notificationclick` handling

## Backend API

User endpoints:

```http
GET    /v1/notifications
GET    /v1/notifications/preferences
PUT    /v1/notifications/preferences
POST   /v1/notifications/push-subscriptions
DELETE /v1/notifications/push-subscriptions/:id
POST   /v1/notifications/:id/read
POST   /v1/notifications/read-all
```

Admin endpoints:

```http
GET  /v1/admin/notifications/diagnostics
POST /v1/admin/notifications/broadcast
```

## Persistence

Migration:

```text
database/migrations/005_notifications.sql
```

Tables:

```text
push_subscriptions
notification_preferences
notifications
```

Both memory and PostgreSQL repositories implement the notification repository contract.

## Push providers

Default provider:

```env
PUSH_PROVIDER=log
```

Production Web Push provider:

```env
PUSH_PROVIDER=webpush
VAPID_SUBJECT=mailto:admin@prizzequizz.local
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

The PWA also needs:

```env
VITE_VAPID_PUBLIC_KEY=...
```

## Notification types

```text
match_update
leaderboard_update
wallet_update
system
promo
```

## Automatic notifications

The backend now creates notifications for:

- wallet top-up
- withdrawal request
- reward settlement
- match result

If a Push subscription exists and preferences allow it, the notification is dispatched through the active push provider.

## PWA

New files:

```text
src/features/notifications/notification.state.ts
src/screens/settings.screen.ts
```

Updated service worker:

```text
public/sw.js
```

The Settings screen now supports:

- Push enablement
- notification permission status
- match update preference
- leaderboard update preference
- wallet update preference
- promo preference
- recent notifications
- mark one / mark all as read

## Admin panel

The admin panel now has a Notifications tab showing:

- provider: log/webpush
- VAPID configured: yes/no
- subscriptions count
- unread count
- queued/sent/failed counts
- broadcast form

## Validation

Validated with:

```bash
cd prizzequizz-api
npm run build
npm run test:integration
npm run test:realtime
npm run test:matchmaking

cd ../prizzequizz-pwa
npm run typecheck
npm run build
```
