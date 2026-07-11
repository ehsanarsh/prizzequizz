# PrizzeQuizz — API Specification

## API Style

PrizzeQuizz uses REST for request/response operations and WebSocket for realtime match updates.

Base URL:

```text
https://api.prizzequizz.example/v1
```

## Authentication

### POST /auth/login

Request:

```json
{
  "phone": "+989120000000"
}
```

Response `200`:

```json
{
  "otpRequired": true,
  "requestId": "otp_req_123"
}
```

### POST /auth/otp/verify

Request:

```json
{
  "requestId": "otp_req_123",
  "code": "1234"
}
```

Response `200`:

```json
{
  "accessToken": "jwt",
  "refreshToken": "jwt",
  "user": {
    "id": "uuid",
    "username": "Shahab_9865",
    "plan": "free"
  }
}
```

## Users

### GET /users/me

Response:

```json
{
  "id": "uuid",
  "username": "Shahab_9865",
  "coins": 350,
  "hearts": 4,
  "walletBalance": 900000,
  "xp": 3400,
  "level": 3,
  "plan": "free"
}
```

### GET /users/:id/profile

Returns public profile for opponent cards.

## Matches

### POST /matches

Creates a match or starts matchmaking.

Request:

```json
{
  "modeId": "duel",
  "economyType": "free",
  "entry": {
    "coinStake": 25
  }
}
```

Response `201`:

```json
{
  "matchId": "uuid",
  "status": "WAITING_FOR_PLAYERS",
  "configVersion": "2026.07.06-prod-001"
}
```

### POST /matches/:id/start

Starts the match if all requirements are met.

Response:

```json
{
  "matchId": "uuid",
  "state": "QUESTION_LOADING"
}
```

### GET /matches/:id/question

Returns the current question without correct answer.

Response:

```json
{
  "questionId": "uuid",
  "text": "پایتخت فرانسه چیست؟",
  "options": ["رم", "پاریس", "لندن", "مادرید"],
  "timerSeconds": 15,
  "roundIndex": 1
}
```

### POST /matches/:id/answer

Request:

```json
{
  "questionId": "uuid",
  "selectedIndex": 1,
  "answerTimeMs": 4200,
  "idempotencyKey": "answer_abc_123"
}
```

Response:

```json
{
  "correct": true,
  "selectedIndex": 1,
  "correctIndex": 1,
  "score": 1,
  "phase": "QUESTION_RESOLVED",
  "events": [
    {
      "type": "ANSWER_CORRECT"
    }
  ]
}
```

### GET /matches/:id/result

Response:

```json
{
  "matchId": "uuid",
  "status": "RESULT",
  "winnerUserId": "uuid",
  "scoreboard": [
    {
      "userId": "uuid",
      "correctAnswers": 4,
      "wrongAnswers": 1,
      "score": 4
    }
  ],
  "rewardPreview": {
    "type": "coins",
    "amount": 250
  }
}
```

### POST /matches/:id/continue

Continues to next stage if mode allows.

Request:

```json
{
  "decision": "continue"
}
```

Response:

```json
{
  "phase": "QUESTION_LOADING",
  "rewardPreview": {
    "type": "coins",
    "amount": 500
  }
}
```

### POST /matches/:id/exit

Exits match and settles reward if allowed.

Request:

```json
{
  "reason": "collect_reward"
}
```

Response:

```json
{
  "status": "FINISHED",
  "reward": {
    "type": "coins",
    "amount": 250,
    "transactionId": "uuid"
  }
}
```

## Rewards

### POST /rewards/:id/claim

Claims a pending reward. Used when settlement is asynchronous.

Response:

```json
{
  "claimed": true,
  "balance": {
    "coins": 600,
    "walletBalance": 900000
  }
}
```

## Wallet

### GET /wallet

### POST /wallet/topup

### POST /wallet/withdraw

Withdraw requires KYC and paid economy.

## Error Format

```json
{
  "error": {
    "code": "INSUFFICIENT_HEARTS",
    "message": "Not enough hearts to enter this match.",
    "details": {
      "required": 1,
      "available": 0
    }
  }
}
```

## Common Status Codes

```text
200 OK
201 Created
400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
422 Validation Error
429 Rate Limited
500 Internal Server Error
```

## WebSocket

Endpoint:

```text
wss://api.prizzequizz.example/v1/realtime
```

Client events:

```text
client:join_match
client:submit_answer
client:send_chat
client:vote
client:leave_match
```

Server events:

```text
server:match_found
server:match_snapshot
server:question
server:answer_result
server:reward_preview
server:match_finished
server:error
```
