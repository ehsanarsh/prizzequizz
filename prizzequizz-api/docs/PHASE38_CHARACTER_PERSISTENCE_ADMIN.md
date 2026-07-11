# Phase 38 — Character Persistence + Admin Character Catalog

## Scope

Phase 38 upgrades the Character System from an in-memory feature to repository-backed persistence and adds admin catalog management.

## Backend

### Domain models

```text
CharacterItem
CharacterInventory
CharacterUnlockEvent
CharacterLoadout
```

### Repository

New repository contract:

```text
CharacterRepository
```

Implemented for:

- memory repository
- PostgreSQL repository

### Migration

```text
database/migrations/010_character_persistence.sql
```

Tables:

```text
character_items
user_character_inventory
character_unlock_events
```

### Admin endpoints

```http
GET   /v1/admin/characters/catalog
POST  /v1/admin/characters/items
PATCH /v1/admin/characters/items/:id/status
POST  /v1/admin/characters/users/:userId/unlock
GET   /v1/admin/characters/users/:userId/events
```

## PWA Admin Panel

The Admin panel now includes a Character tab with:

- character item list
- item status
- item rarity / slot / price
- create/upsert item
- activate/archive item

## UX Fix

The opponent profile modal now shows only one profile avatar. The duplicated modal icon was removed for this profile modal by supporting `hideIcon` in the modal component.

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

## Next phase recommendation

Phase 39 should implement Payment Gateway Foundation.
