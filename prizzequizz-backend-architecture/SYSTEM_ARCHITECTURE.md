# PrizzeQuizz — System Architecture

## Backend Architecture

PrizzeQuizz is designed as a modular service-oriented backend. A monolith can implement the same boundaries initially, but modules must remain isolated so they can later be extracted into services.

```text
Client PWA / Mobile Web
        |
        | REST + WebSocket
        v
API Gateway / Backend Application
        |
        +-- Auth Module
        +-- User Module
        +-- Match Engine
        +-- Question Engine
        +-- Reward Engine
        +-- Economy Engine
        +-- Config Service
        +-- Event Bus
        +-- Admin Module
        |
        +-- PostgreSQL
        +-- Redis
        +-- Object Storage
        +-- Analytics Sink
```

## Recommended Runtime Stack

- **Backend language:** TypeScript / Node.js or Go. TypeScript is recommended for AI-friendly schemas and shared types.
- **Primary database:** PostgreSQL.
- **Realtime / cache:** Redis.
- **Async jobs:** BullMQ, Temporal, or a queue abstraction.
- **Realtime transport:** WebSocket gateway.
- **Object storage:** S3-compatible storage for media questions and uploads.
- **Observability:** OpenTelemetry, structured logs, metrics, tracing.

## Core Modules

### Match Engine

The Match Engine manages match lifecycle and state transitions. It does not hardcode mode rules. It delegates mode behavior to registered mode modules.

Responsibilities:

- Create match sessions.
- Track lifecycle state.
- Accept answer submissions.
- Call Question Engine for question delivery.
- Call Reward Engine for reward preview and settlement.
- Publish events for UI and analytics.
- Handle timeout, leave, disconnect, and reconnect.

### Question Engine

The Question Engine selects, serves, and validates questions.

Responsibilities:

- Filter by category, difficulty, tags, mode, locale, and version.
- Avoid recent repeats.
- Validate submitted answers.
- Track question usage and performance.
- Support media questions.
- Provide admin approval workflow.

### Reward Engine

The Reward Engine calculates and applies rewards based on match result and config.

Responsibilities:

- Reward preview after each stage.
- Final reward calculation.
- Reward settlement into ledger.
- Event emission for reward animations.
- Support coins, cash, XP, tickets, items, hearts.

### Economy Engine

The Economy Engine decides whether a player can enter a mode and charges the correct entry cost.

Responsibilities:

- Free entry: hearts + coins.
- Paid entry: wallet cash.
- League entry: tickets.
- Heart recharge rules.
- Coin balances.
- Wallet transaction ledger.

### Config Service

The Config Service loads versioned game configuration and validates it against schemas.

Responsibilities:

- Load active config by environment.
- Validate mode, reward, economy, UI, and animation config.
- Provide immutable config snapshot per match.
- Allow admin-edited config with audit logs.

### Event System

The Event Bus decouples gameplay from UI and analytics.

Example events:

```text
MATCH_CREATED
MATCH_STARTED
QUESTION_SELECTED
QUESTION_SHOWN
ANSWER_SUBMITTED
ANSWER_VALIDATED
QUESTION_RESOLVED
REWARD_PREVIEWED
REWARD_GRANTED
MATCH_FINISHED
PLAYER_DISCONNECTED
PLAYER_RECONNECTED
```

## Match Engine Design

```ts
interface MatchEngine {
  createMatch(input: CreateMatchInput): Promise<MatchSnapshot>;
  startMatch(matchId: string): Promise<MatchSnapshot>;
  submitAnswer(input: SubmitAnswerInput): Promise<MatchSnapshot>;
  advance(matchId: string, userId: string): Promise<MatchSnapshot>;
  exit(matchId: string, userId: string): Promise<MatchSnapshot>;
  finish(matchId: string): Promise<MatchResult>;
}
```

## Mode Module Contract

```ts
interface GameModeModule {
  id: string;
  createInitialState(ctx: ModeContext): ModeState;
  onMatchStart(ctx: ModeContext, state: ModeState): ModeState;
  onAnswer(ctx: AnswerContext, state: ModeState): ModeState;
  onTimeout(ctx: TimeoutContext, state: ModeState): ModeState;
  onAdvance(ctx: AdvanceContext, state: ModeState): ModeState;
  calculateResult(ctx: ResultContext, state: ModeState): MatchResult;
}
```

## State Ownership

- PostgreSQL stores durable match records, submissions, rewards, and ledgers.
- Redis stores hot match state for active realtime matches.
- Every important state transition is persisted as a match event.
- Backend snapshots are sent to clients; clients should not infer hidden state.

## Config System

Every match stores `config_version`. If admin changes config mid-match, the active match continues with its original config snapshot.

```text
admin edits config → validation → publish new config version → future matches use new version
```

## Scalability Strategy

- Stateless API servers.
- Sticky or room-based WebSocket routing.
- Redis pub/sub or message bus for realtime fanout.
- PostgreSQL read replicas for analytics-heavy reads.
- Background workers for settlement and leaderboard updates.
- Idempotency keys for answer submission and reward claiming.

## Performance Requirements

- API p95 under 150ms for common reads.
- Answer submission p95 under 120ms excluding network.
- WebSocket message payloads under 8KB where possible.
- Question payloads omit correct answer until resolution.
- Active match state stored in Redis with TTL.
- Minimal database writes per answer: submission + event append.
