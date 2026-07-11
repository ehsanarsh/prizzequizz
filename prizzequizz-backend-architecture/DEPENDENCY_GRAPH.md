# PrizzeQuizz — Dependency Graph

## Documentation Dependency Graph

```text
FILE_INDEX.md
  -> references all package files

PROJECT_OVERVIEW.md
  -> SYSTEM_ARCHITECTURE.md
  -> FEATURE_MODULE_MAP.md

SYSTEM_ARCHITECTURE.md
  -> GAME_CONFIG.json
  -> MATCH_LIFECYCLE.md
  -> REWARD_SYSTEM.md
  -> QUESTION_ENGINE.md
  -> API_SPECIFICATION.md
  -> DATABASE_SCHEMA.md

FEATURE_MODULE_MAP.md
  -> GAME_CONFIG.json
  -> SYSTEM_ARCHITECTURE.md

GAME_CONFIG.json
  -> MATCH_LIFECYCLE.md
  -> REWARD_SYSTEM.md
  -> API_SPECIFICATION.md

MATCH_LIFECYCLE.md
  -> GAME_CONFIG.json
  -> REWARD_SYSTEM.md
  -> QUESTION_ENGINE.md
  -> DATABASE_SCHEMA.md

REWARD_SYSTEM.md
  -> GAME_CONFIG.json
  -> DATABASE_SCHEMA.md
  -> API_SPECIFICATION.md

QUESTION_ENGINE.md
  -> QUESTION_SCHEMA.json
  -> DATABASE_SCHEMA.md

API_SPECIFICATION.md
  -> SYSTEM_ARCHITECTURE.md
  -> MATCH_LIFECYCLE.md
  -> REWARD_SYSTEM.md
  -> QUESTION_ENGINE.md

DATABASE_SCHEMA.md
  -> supports all backend modules
```

## Runtime Module Dependency Graph

```text
API Gateway
  -> Auth Module
  -> User Module
  -> Match Engine
      -> Config Service
      -> Mode Registry
          -> Duel Mode
          -> Last Survivor Mode
          -> All Or Nothing Mode
          -> Practice Economy Wrapper
      -> Question Engine
      -> Reward Engine
      -> Economy Engine
      -> Event Bus
  -> Admin Module
      -> Config Service
      -> Question Engine
      -> Analytics

Realtime Gateway
  -> Match Engine
  -> Presence Store
  -> Redis Pub/Sub

Workers
  -> Reward Settlement
  -> Match Cleanup
  -> Leaderboard Refresh
  -> Question Import
```

## Rule

Game mode modules can depend on core contracts, but core modules must never depend on a specific game mode implementation.
