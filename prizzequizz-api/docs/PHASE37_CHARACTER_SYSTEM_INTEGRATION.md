# Phase 37 — Character System Integration

## Scope

Phase 37 integrates the standalone Character Lab into the main PrizzeQuizz PWA and backend.

## Backend

New files:

```text
src/services/characterService.ts
src/modules/characters/routes.ts
```

Endpoints:

```http
GET  /v1/characters/catalog
GET  /v1/characters/me
POST /v1/characters/equip
POST /v1/characters/unlock
POST /v1/characters/purchase
POST /v1/characters/randomize
```

The first implementation includes:

- character states
- item catalog
- user inventory
- loadout
- equip state/item
- purchase using coins
- randomize loadout

## PWA

Character Lab assets were copied into:

```text
public/character-assets
```

New PWA files:

```text
src/features/characters/character.state.ts
src/screens/character.screen.ts
```

The PWA now includes a Character screen with:

- layered character preview
- mood/state selection
- slot tabs
- item list
- equip
- buy/unlock
- randomize
- coins/level display

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

## Next steps for world-class characters

- replace placeholder assets with original PrizzeQuizz mascot art
- add more slots: aura, badge, pet, face
- persist inventory/loadout in PostgreSQL
- add admin character catalog management
- add unlock rules from missions, leaderboard, beta rewards
