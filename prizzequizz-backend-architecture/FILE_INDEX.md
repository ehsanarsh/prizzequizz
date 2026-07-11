# PrizzeQuizz Backend Architecture Package — File Index

## Core System Files

1. `PROJECT_OVERVIEW.md` — Product vision, game modes, Free/Paid economy, long-term direction.
2. `SYSTEM_ARCHITECTURE.md` — Backend architecture, engines, event system, scalability model.
3. `FEATURE_MODULE_MAP.md` — Module boundaries, dependencies, extension points.

## Game Logic Layer

4. `GAME_CONFIG.json` — Central config for duel, last survivor, all or nothing, and practice.
5. `MATCH_LIFECYCLE.md` — Match state machine, transitions, edge cases, reconnect, timeout.
6. `REWARD_SYSTEM.md` — Coins, cash, multipliers, settlement, reward animation events.

## Question System

7. `QUESTION_ENGINE.md` — Selection, validation, anti-repeat, difficulty scaling, admin workflow.
8. `QUESTION_SCHEMA.json` — JSON Schema for production question objects.

## API & Database

9. `API_SPECIFICATION.md` — REST and WebSocket API design, request/response examples, errors.
10. `DATABASE_SCHEMA.md` — PostgreSQL schema, indexes, relationships, performance notes.

## Package Meta

11. `DEPENDENCY_GRAPH.md` — Cross-file and module dependency graph.
12. `FILE_INDEX.md` — This index.
