# PrizzeQuizz — Real-time 2-player duel (surgical rewrite)

Human-vs-human, synchronized duel. **No bots, no fake/random opponent anywhere.**
UI/CSS is unchanged — only the *data source* and *flow control* were rewritten.

## Files changed
**Frontend** — `prizze-v56.html` (the `REAL-TIME DUEL` block near the bottom + a 1-line
`loadDuelQ` tweak).
**Backend** — `prizzequizz-api/src/`:
- `services/matchEngine.ts` — real per-player, round-based scoring (see below).
- `realtime/gateway.ts` — `submit_answer` now carries `round`; broadcasts `userId`+`round`; broadcasts `server:opponent_left` on disconnect.
- `realtime/protocol.ts` — adds `server:opponent_left`.
- `modules/matches/routes.ts` — `GET /matches/:id/question?round=N` (deterministic, identical for both players) + passes `round` to the answer route.
- `services/matchmakingWorker.ts` — bot fallback removed (tickets just expire at 60s).
- `types/domain.ts` — `Match.duelAnswers` / `duelSettled` (per-round tracking).

## How each requirement is met

**1. Two players connect to one room**
Matchmaking pairs them (`enqueue` → same `matchId`). Both then open the match-room
WebSocket (`ws://…/v1/realtime?token=…` → `client:join_match`). Presence confirms both.

**2. Real-time sync (see each other's live data, progress together)**
- Every answer goes to the server (`client:submit_answer`) which **broadcasts**
  `server:answer_result` (`userId`, `round`, `correct`) + a fresh `server:match_snapshot`
  with **real scores** to both players.
- The opponent's score/dots come *only* from those broadcasts — never `Math.random()`.
- **Lockstep:** after you answer round *N* you don't advance to *N+1* until the
  opponent's round-*N* answer arrives (shown as `⏳ در انتظار پاسخ حریف...`, text only —
  no UI change). A 15 s safety timeout guarantees it can never hard-freeze.

**3. Identical questions (same set, order, options, timing)**
`GET /matches/:id/question?round=N` derives the question deterministically from
`hash(matchId)+round`, so both players get byte-identical questions in identical order.
The client pre-fetches rounds 0–14 in parallel (5 core + sudden-death) at match start.

**4. No bots — human only**
- `matchmakingWorker` no longer creates bot matches; unmatched tickets expire at 60 s and
  the client shows **«حریفی برای شما یافت نشد»** and returns home.
- The server's fake `Math.random() < 0.58` opponent scoring is **removed**; each player is
  scored solely from their own answers.
- If a player disconnects mid-match, the server emits `server:opponent_left` and the
  remaining player wins by forfeit.

**5. First-question freeze / race conditions**
- Synced questions are swapped in *after* the original `runDuelRound()` runs (it used to
  overwrite them) and re-rendered under the "آماده‌ای؟" gate — no flicker.
- Malformed questions are rejected before render (a missing options array used to throw in
  `buildAnswers`).
- WS events that arrive early are stored per-round and applied when that round is reached
  (no lost signals); every wait has a timeout; per-match answer processing is serialized
  on the server with an async lock (no lost-update race on scores).

## Backend scoring model (matchEngine.submitAnswer)
- Answers tracked per `${userId}:${round}`, scored once each (idempotent).
- Match finishes only when **both** players have answered the same number of rounds and
  that number ≥ 5 **and** scores differ → higher score wins.
- Tie after 5 ⇒ stays in play for **sudden-death** on the next shared round (first
  divergence wins). Hard cap at 15 rounds → draw, so it always terminates.
- Verified locally against 6 scenarios (normal win, tie→sudden-death, cap-draw,
  idempotency, order-independence, post-result rejection) — all pass.

## Deploy
```bash
# 1) Backend (required — this is where the fake opponent lived)
cd /opt/prizzequizz && sudo docker-compose build api && sudo docker-compose up -d

# 2) Frontend
sudo cp prizze-v56.html /var/www/prizequiz/index.html
```
**Nginx must proxy the WebSocket** for `/v1/realtime` (Upgrade/Connection headers). If it
doesn't, the game still runs (answers fall back to HTTP) but the opponent's live data won't
stream — so make sure the WS location block has:
```
location /v1/realtime { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
```

## Test (2 devices / 2 browsers, **two different phone numbers**)
1. Both log in (OTP `1234` in dev). Player A → "شروع"/جستجوی حریف; Player B → same.
2. They match instantly; both get the **same** questions in the same order.
3. Answer at different speeds → the faster one shows "در انتظار پاسخ حریف..." then both
   advance together; opponent's score/dots reflect their **real** answers.
4. Close one tab mid-game → the other wins by forfeit.
5. Start a search with no second player → after 60 s: «حریفی برای شما یافت نشد» → home.

> I could not run this against your live server from here (egress is locked), so this is the
> one step to run on your side. I verified logic (backend simulation), types (`tsc` clean),
> and syntax (`node --check`). Report anything the live test surfaces and I'll fix it.
