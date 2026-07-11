# PrizzeQuizz — Reward System

## Reward Principles

- Rewards are backend-authoritative.
- Every reward is represented by a ledger record.
- UI animations are triggered by reward events but never calculate reward values.
- Free rewards are coins, XP, hearts, tickets, or items.
- Paid rewards can include cash, XP, tickets, and items.

## Reward Types

```text
coins
cash
xp
ticket
item
heart
```

## Free Coin System

Free mode uses coins as the main progression currency.

Examples:

```text
Duel win: base + stage bonus
Last Survivor correct path: base + per-question reward
All or Nothing: group bonus + per-question reward
```

Coins are added to `users.coins` and logged in `transactions`.

## Cash System

Paid mode uses wallet cash.

Rules:

- Entry is charged or reserved before match start.
- Reward is calculated after finish.
- Withdrawal is separate from reward earning.
- Fees are applied only during withdrawal or configured settlement.

## Multipliers

Multipliers are config-driven:

```json
{
  "continueMultiplier": 2,
  "streakMultiplier": 1.1,
  "leagueMultiplier": 1.25
}
```

## Streak Bonuses

A streak bonus is calculated only if enabled by config.

```text
finalReward = baseReward * streakMultiplier
```

The bonus must be visible in reward preview.

## Double Reward Logic

For modes that support "Continue & Double":

- The current reward preview is not settled yet.
- The next match or round starts with increased reward potential.
- Settlement happens only when the user exits or loses according to mode config.

## Reward Preview vs Settlement

### Reward Preview

Shown to UI after each question or stage.

### Reward Settlement

Final authoritative ledger write.

```text
reward_preview != reward_granted
```

## Backend Reward Events

```text
REWARD_PREVIEWED
REWARD_GRANTED
REWARD_MULTIPLIED
REWARD_FORFEITED
REWARD_SETTLEMENT_FAILED
```

## Animation Triggers

Backend emits the event and value. Client decides presentation.

```json
{
  "event": "REWARD_GRANTED",
  "payload": {
    "type": "coins",
    "amount": 250,
    "animation": "coin_fly_to_header"
  }
}
```

## Idempotency

Reward settlement must be idempotent using:

```text
match_id + user_id + reward_type + settlement_reason
```

## Fraud Prevention

- Server validates every answer.
- Server calculates every reward.
- Client-submitted reward values are ignored.
- Suspicious match timing is logged.
- Admin corrections create reversal transactions.
