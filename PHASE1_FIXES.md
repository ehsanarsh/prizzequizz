# PrizzeQuizz — Phase 1 Core Gameplay Fixes

This change fixes the four Phase 1 (core gameplay) bugs. All frontend changes are in
`prizze-v56.html` inside the `/* ======= PrizzeQuizz Real API ======= */` block near the
bottom. Backend changes are in `prizzequizz-api/`.

## What was broken and what changed

### 1. First question freeze  (frontend)
The original `runDuelRound()` **reassigns** `duelRoundQs` from the local pool and then
renders the first question — so the previous override, which injected the synced
questions *before* calling the original, had its questions immediately overwritten.
On top of that, if a fetched question had a missing/short `options` array,
`buildAnswers()` would throw and freeze the screen.

Fix (`runDuelRound` override):
- Let the original run first (it resets `dQ`, scores, opens the "آماده‌ای؟" gate),
  then swap in the synced questions and re-render the first question **while the gate
  modal still covers the screen** — no flicker, no freeze.
- Only inject when all 5 questions are well-formed (`_pzQsValid`); otherwise the game
  keeps the local questions instead of hanging.

### 2. Questions not synced between players  (frontend + backend)
- Backend: added `GET /v1/matches/:id/question?round=N`. It deterministically derives
  the question from `hash(matchId) + round`, so **both players, hitting the same
  `matchId` and same round numbers, get identical questions**. It is idempotent, so
  polling never changes the result. Returns `{id, text, options, correctIndex, category}`.
- Frontend: `_pzMatchFound()` fetches all 5 rounds up front, unwraps the `{ok,data}`
  envelope, and only keeps fully-formed questions.

### 3. Answers submitted for the wrong question  (frontend)
The original `answerDuel()` increments `dQ` later, inside its async reveal callback, so
at submit time `dQ` still points at the current question. The override used `dQ-1`,
which submitted the previous question's id (and never submitted the first answer).
Fix: capture `roundIdx = dQ` **before** calling the original, submit against that, and
use a stable `idempotencyKey` per (match, round, selection).

### 4. 60s timeout / no bots  (frontend + backend)
- Frontend: after 60s with no opponent, cancel the ticket and show the exact required
  message **«حریفی برای شما یافت نشد»**, then return home. `window._pzQs`/`_mid` are
  reset at the start of every search so stale data is never reused.
- Backend: `matchmakingWorker` no longer runs bot fallbacks — unmatched tickets simply
  expire after 60s. Human-only gameplay. (The manual `/matchmaking/:id/bot` route is
  left in place but is never triggered automatically.)

## Testing note (important)
The two players **must use two different phone numbers**. Matchmaking never pairs a user
with themselves (`userId !== userId`), so two tabs logged in with the same phone will
never match. In dev the OTP is always `1234`.

## Deploy
```bash
# Frontend
sudo cp prizze-v56.html /var/www/prizequiz/index.html

# Backend (only if you rebuild from this source)
cd /opt/prizzequizz && sudo docker-compose build api && sudo docker-compose up -d
```
