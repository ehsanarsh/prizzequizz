# PrizzeQuizz — Match Lifecycle

## Match State Machine

```text
CREATED
  -> WAITING_FOR_ENTRY_CHARGE
  -> WAITING_FOR_PLAYERS
  -> STARTING
  -> QUESTION_LOADING
  -> QUESTION_ACTIVE
  -> ANSWER_LOCKED
  -> QUESTION_RESOLVED
  -> POST_QUESTION
  -> CONTINUE_DECISION
  -> QUESTION_LOADING
  -> RESULT
  -> REWARD_SETTLEMENT
  -> FINISHED
```

## State Definitions

### CREATED

The match record exists but no entry cost has been charged.

### WAITING_FOR_ENTRY_CHARGE

Economy Engine checks whether each user can enter.

Free:

- Validate hearts.
- Validate coins.
- Charge hearts + coins.

Paid:

- Validate wallet balance.
- Reserve or charge cash entry.

### WAITING_FOR_PLAYERS

Match waits for required players or matchmaking completion.

### STARTING

Countdown and initial match snapshot are broadcast to clients.

### QUESTION_LOADING

Question Engine selects a question according to config and anti-repeat rules.

### QUESTION_ACTIVE

Question is visible. Timer begins. Server records `question_started_at`.

### ANSWER_LOCKED

Player answer is accepted and locked. Duplicate submissions are ignored by idempotency key.

### QUESTION_RESOLVED

Server validates answers, updates score, and emits result events.

### POST_QUESTION

UI shows correct/wrong state, reward preview, elimination summary, or group vote entry.

### CONTINUE_DECISION

Player or group decides whether to continue or exit if mode allows it.

### RESULT

Winner and match result are calculated.

### REWARD_SETTLEMENT

Reward Engine calculates final reward and creates ledger entry.

### FINISHED

Match is immutable except for admin correction flows.

## Answer Submission Flow

```text
Client submits answer
  -> API validates session and match membership
  -> API checks match phase
  -> API checks idempotency key
  -> Match Engine records answer
  -> Question Engine validates correctness
  -> Mode Module updates score / elimination state
  -> Event Bus emits ANSWER_VALIDATED
  -> Client receives snapshot
```

## Winner Calculation

### Duel

- Higher score wins.
- If tied and `tieBreaker = sudden_death`, continue until one player answers correctly while the other fails.

### Last Survivor

- Last non-eliminated player wins.
- If max questions reached, configured scoring decides winner or split.

### All or Nothing

- Group result depends on majority decision and survival state.

## Continue / Exit Logic

### Free

- Continue increases coin reward preview.
- Exit settles current coin reward.

### Paid

- Continue increases cash exposure according to config.
- Exit settles current cash amount after fees if configured.

## Edge Cases

### Disconnect

- If user reconnects within `reconnectGraceSeconds`, restore active state.
- If not, mark as timed out or bot-controlled according to mode config.

### Timeout

- No answer is treated as wrong unless mode config says otherwise.

### Leave Match

- Free: consumed heart/coins are not refunded unless match never started.
- Paid: entry refund depends on phase and config.

### Duplicate Answer

- Same idempotency key returns the original submission result.

### Server Crash

- Active state is reconstructed from Redis snapshot or event log.

### Reward Settlement Retry

- Reward settlement is idempotent by `(match_id, user_id, reward_type)`.

## Reconnect Logic

```text
Client reconnects
  -> sends session token and last known match_id
  -> server validates membership
  -> server returns current match snapshot
  -> client resumes correct screen
```

## Event Timeline Example

```text
MATCH_CREATED
ENTRY_CHARGED
MATCH_STARTED
QUESTION_SELECTED
QUESTION_SHOWN
ANSWER_SUBMITTED
ANSWER_VALIDATED
QUESTION_RESOLVED
REWARD_PREVIEWED
PLAYER_DECISION_CONTINUE
QUESTION_SELECTED
MATCH_FINISHED
REWARD_GRANTED
```
