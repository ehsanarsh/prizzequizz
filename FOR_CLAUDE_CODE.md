# PrizzeQuizz — Task for Claude Code

## Server Info
- IP: 193.93.169.245
- OS: Ubuntu 24
- Stack: Docker + NestJS + PostgreSQL + Redis

## What's Already Working
- API running: http://193.93.169.245/v1/health ✅
- Auth (OTP login) ✅  
- Matchmaking queue ✅
- Questions in DB (260 questions) ✅
- Match question endpoint: GET /matches/:id/question?round=N ✅
- Bot fallback DISABLED ✅

## HTML File
`prizze-v56.html` — Single file prototype based on v53.
Already has: sendOtp, verifyOtp, matchmaking override, question injection.

## QUESTION FORMAT in HTML (v53 original)
```js
{t:'موضوع', q:'متن سوال', a:['گ1','گ2','گ3','گ4'], c:2}
```

## KEY FUNCTIONS TO OVERRIDE (in HTML)
- `startMatchmaking()` — do NOT call original (has mock bot timer)
- `runDuelRound()` — sets `duelRoundQs` array, then calls `loadDuelQ`
- `tossAnswer(sel, correct)` — topic pick answer  
- `answerDuel(sel, correct)` — actual duel answer

## CURRENT BUGS TO FIX
1. Two players not connecting in matchmaking
2. Same questions not synced between players  
3. First question sometimes freezes

## API Endpoints
```
POST /v1/auth/login          {phone}
POST /v1/auth/otp/verify     {requestId, code}  → code is '1234' in dev
POST /v1/matchmaking/enqueue {modeId:'duel', economyType:'free', skill:800}
GET  /v1/matchmaking/:id     → {status:'matched', matchId}
POST /v1/matches/:id/start   → {players:[{userId,username,avatar}]}
GET  /v1/matches/:id/question?round=N → {id, text, options, correctIndex, category}
POST /v1/matches/:id/answer  {questionId, selectedIndex, answerTimeMs, idempotencyKey}
WS   ws://193.93.169.245/v1/realtime?token=TOKEN
```
