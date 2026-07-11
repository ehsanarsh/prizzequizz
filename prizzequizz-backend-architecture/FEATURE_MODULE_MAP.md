# PrizzeQuizz — Feature Module Map

## Module Dependency Graph

```text
API Layer
  -> Auth Module
  -> User Module
  -> Match Engine
       -> Mode Registry
            -> Duel Module
            -> Last Survivor Module
            -> All Or Nothing Module
            -> Practice Module
       -> Question Engine
       -> Reward Engine
       -> Economy Engine
       -> Event Bus
       -> Config Service
  -> Admin Module
       -> Config Service
       -> Question Engine
       -> User Module
       -> Analytics Module
```

## Core Modules

### Auth Module

Depends on:

- User Module
- OTP Provider
- Session Store

Provides:

- Login
- OTP verification
- Session refresh
- Role and permission claims

### User Module

Depends on:

- Database
- Economy Engine for balances

Provides:

- User profile
- Public opponent profile
- XP and level summary
- Plan state: free or paid

### Match Engine

Depends on:

- Config Service
- Mode Registry
- Question Engine
- Reward Engine
- Economy Engine
- Event Bus
- Redis state store

Provides:

- Match creation
- Match state machine
- Answer processing
- Reconnect state
- Finish and settlement trigger

### Question Engine

Depends on:

- Database
- Question config
- User question history

Provides:

- Question selection
- Answer validation
- Anti-repeat rules
- Admin approval workflow

### Reward Engine

Depends on:

- Economy Engine
- Config Service
- Match result

Provides:

- Reward preview
- Final reward calculation
- Ledger settlement
- Animation trigger events

### Economy Engine

Depends on:

- Users
- Transactions
- Config Service

Provides:

- Entry validation
- Entry charge
- Heart recharge
- Coin settlement
- Cash settlement
- Wallet operations

## Game Mode Modules

### Duel Module

Uses:

- Match Engine lifecycle
- Question Engine question loop
- Reward Engine result calculation
- Economy entry config

Public states:

```text
WAITING_FOR_OPPONENT
INTRO
QUESTION_ACTIVE
QUESTION_RESOLVED
TIE_BREAK
RESULT
FINISHED
```

### Last Survivor Module

Public states:

```text
ROOM
COUNTDOWN
QUESTION_ACTIVE
QUESTION_RESOLVED
ELIMINATION
POST_QUESTION_DECISION
RESULT
FINISHED
```

### All Or Nothing Module

Public states:

```text
ROOM
QUESTION_ACTIVE
QUESTION_RESOLVED
GROUP_CHAT
VOTE
GROUP_DECISION
RESULT
FINISHED
```

### Practice Module

Practice is not a separate rules engine for every mode. It is an economy and reward wrapper over other modes.

Provides:

- Free entry cost
- Coin rewards
- Heart consumption
- No cash display
- Same post-question flow as paid mode

## UI Module Dependencies

The UI should consume events only:

```text
Game Event -> UI State Adapter -> Screen / Modal / Animation
```

UI must never calculate:

- Winner
- Reward
- Entry cost
- Question validity

## Admin Modules

### Config Editor

Depends on:

- Config schemas
- Admin logs

### Question Manager

Depends on:

- Question Engine
- Question tables
- Bulk import worker

### Analytics Dashboard

Depends on:

- Match events
- Reward ledger
- Question usage stats

## Extension Points

### Add New Mode

Add module under mode registry and config under `game_modes`.

### Add New Reward

Register reward handler in Reward Engine.

### Add New Theme

Add theme config and asset bundle.

### Add Tournament

Add feature module that schedules matches and uses Match Engine.
