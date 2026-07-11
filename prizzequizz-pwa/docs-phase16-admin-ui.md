# Phase 16 — Embedded Admin UI Scaffold

## Completed

This phase adds the first admin user interface inside the PWA for fast MVP iteration.

## Added

```text
src/features/admin/admin.state.ts
src/screens/admin.screen.ts
```

## Admin Features

- Admin key input
- Config dashboard
- Game config JSON viewer/editor
- Duel timer quick editor
- Question manager
- Question creation form
- Question status update buttons
- Analytics cards
- Audit log viewer

## Access

The Home menu button opens a quick menu that includes an Admin entry.

For development backend access, use:

```text
dev-admin
```

This is stored as:

```text
localStorage.pq_admin_key
```

The HTTP adapter sends it as:

```text
x-admin-key
```

## Notes

This is intentionally embedded in the PWA for MVP speed. If the admin area grows, it should later be extracted into a separate `prizzequizz-admin` app.

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
