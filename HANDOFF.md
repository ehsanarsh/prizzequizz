# PrizzeQuizz — Handoff / Continuation Guide

Read this first. It explains the architecture, everything implemented so far, how
to deploy, what's pending, and the gotchas — so you can continue safely without
re-breaking working features.

## 1. What this project is
Persian RTL real-money competitive quiz app. The flagship mode is **دوئل (Duel)** —
a synchronous 1v1 real-time quiz over WebSocket.

- **Frontend**: ONE self-contained file, `prizze-v56.html` (~7000-line inline
  `<script>`, RTL Persian UI, dark theme). No build step. Deployed to
  `/var/www/prizequiz/index.html` and served by Nginx by IP.
- **Backend**: `prizzequizz-api/` — TypeScript, a small custom HTTP router
  (`src/http/router.ts`) + a `ws` WebSocket gateway (`src/realtime/gateway.ts`).
  NOT NestJS despite the name. Runs in Docker.
- **Server**: Ubuntu at `193.93.169.245`. `docker-compose` in `/opt/prizzequizz`
  with services: `postgres`, `redis`, `api` (:3000), `pwa` (:4173). Nginx serves
  the static HTML and proxies `/v1/*` (incl. the `/v1/realtime` WebSocket) to :3000.
- Dev mode: OTP is always `1234`.

## 2. How to deploy (exact)
Frontend only:
```
scp -i <key> prizze-v56.html ubuntu@193.93.169.245:/home/ubuntu/
ssh: sudo cp /home/ubuntu/prizze-v56.html /var/www/prizequiz/index.html
```
Backend (after editing any `prizzequizz-api/src/**`):
```
# copy changed files into /opt/prizzequizz preserving paths, then:
cd /opt/prizzequizz && sudo docker-compose build api && sudo docker-compose up -d
```
Migrations (apply raw SQL files, prod image has no tsx):
```
for f in /opt/prizzequizz/prizzequizz-api/database/migrations/*.sql; do
  sudo docker-compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d prizzequizz < "$f"; done
```
**Always test after: two DIFFERENT phone numbers, in a normal window + an
incognito window (same-window tabs share the login and will never match).**
Test only via the IP `http://193.93.169.245` (the `prizequiz.ir` vhost points at
the old `pwa` container, not our HTML).

## 3. Real-time duel — how it actually works (critical)
The frontend "real API" block lives at the BOTTOM of the `<script>` in
`prizze-v56.html`, marked by comment banners. It OVERRIDES the original mock duel
functions and only engages for REAL matches (`pzRt.active`); non-real modes
(weekly-league / WTA) fall back to the untouched originals.

Global real-time state: `pzRt` (matchId, ws, myId, oppId, oppName, per-round
answer maps, waiters, grace timer…). It is REBUILT per match by `pzNewRt(mid)`.
⚠️ `pzNewRt` must NOT reference `pzRt` (TDZ crash — this already bit us once).

Flow:
1. `startMatchmaking` (overridden) → `POST /v1/matchmaking/enqueue`
   `{modeId:'duel', economyType, skill}`. Poll `GET /v1/matchmaking/:id` every 2s;
   60s timeout → refund + "حریفی برای شما یافت نشد" → home.
   - `economyType` encodes the ecosystem/ladder tier: `free`, or `v<value>` for
     paid (value-based ladder — see §5). The backend queue key separates by it.
2. On match → `_pzMatchFound(mid)` (guarded to run ONCE per matchId): `POST
   /matches/:id/start`, open the room WebSocket (`ws://…/v1/realtime?token=…` →
   `client:join_match`), and PREFETCH 15 questions via
   `GET /matches/:id/question?round=N` into `window._pzQs`. The question endpoint
   is deterministic (`hash(matchId)+round`) so BOTH players get identical
   questions/options in identical order.
3. Toss ("سوال تعیین موضوع"): deterministic question (`TOSS_QS[hash(matchId)%3]`).
   Both answer; each sends `{k:'toss',correct,t}` over the room chat channel
   (`client:send_chat`, prefix `PZ1:`); both compute the SAME winner (correct
   then fastest). Winner sees topic-pick; loser sees "منتظر انتخاب موضوع…" and
   receives the topic via `{k:'topic'}`.
4. Each duel question: select → LOCK (no reveal) → wait until BOTH answered (via
   `server:answer_result`, or 15s timeout) → 1.2s suspense → reveal green/red
   together → RESULT MODAL (`pzResultGate`: my/opp result + animated score, 5s) →
   auto-advance. Answers go to `client:submit_answer` (server scores + broadcasts)
   with an HTTP fallback; idempotency key = `a-<match>-<round>-<sel>`.
5. Disconnect resilience: heartbeat `client:ping`/20s; auto-reconnect + re-join on
   `ws.onclose`; `server:opponent_left` starts a **15s reconnect grace window**
   (cancelled the moment the opponent's presence/answer returns) before forfeiting.

Backend scoring: `matchEngine.submitAnswer` tracks answers per `${userId}:${round}`
(idempotent), scores each player from their OWN answers (NO random/bot scoring),
finishes only when BOTH answered ≥5 equal rounds with a decisive leader; ties →
sudden-death; hard cap 15 rounds. Serialized per match with an async lock.

## 4. Ticket economy (implemented, frontend)
- `mTickets = {green,blue,red}` (localStorage `pz_mtickets`). Values
  12,500 / 25,000 / 50,000. Header shows one 🎫 + three counts colored per tier.
- Shop tab "بلیط مسابقات" → `renderTicketShop()` (buy with wallet money).
- Paid duel entry is TICKET-gated (`ticketEnterDuel`): no ticket → modal + "خرید
  بلیط" → shop. Entry consumes a ticket and sets `curStake = ticket.value`, so the
  existing win→withdraw→`endGame`→`earn` flow pays the COMBINED prize (2× value)
  to the wallet with transaction + animation. No-opponent refund returns the
  TICKET (not wallet cash) — see `_pzRefundEntry`.
- Weekly-league tickets (`tickets.{gold,silver,bronze}`) are NOT purchasable;
  shown colored in the profile/league area.

## 5. Value-based ladder (item just implemented)
Matchmaking is keyed by PRIZE VALUE, not color: `economyType = 'v'+matchValue`.
- Fresh green=12,500; blue=25,000; red=50,000.
- On win → `duelContinue` doubles the stake → `matchValue = duelStakeVal`, no new
  ticket → the ascended player now meets players at that value tier (e.g. green
  winner at 25,000 meets fresh blue entrants at 25,000). Backend `chargeEntry`
  was made NON-FATAL so paid/`v…` tiers never 409 (client gates the wallet/ticket).

## 6. Backend files changed this engagement
- `services/matchEngine.ts` — real per-player round scoring; opponent MatchPlayer
  exposes PUBLIC `username` only (privacy); non-fatal `chargeEntry`.
- `services/matchmakingWorker.ts` — bot fallback removed (human-only).
- `realtime/gateway.ts` — `submit_answer` carries `round`; `answer_result`
  broadcast includes `userId`+`round`; broadcasts `server:opponent_left` on
  disconnect. `realtime/protocol.ts` — added `server:opponent_left`.
- `modules/matches/routes.ts` — `GET /matches/:id/question?round=N` (deterministic);
  `round` on the answer route.
- `modules/users/routes.ts` — `PATCH /users/me` (displayName+unique username);
  `/users/:id/profile` returns public handle only (no real name).
- `types/domain.ts` — `Match.duelAnswers/duelSettled`.
- `database/migrations/015_widen_phone.sql` — widen `users.phone` to VARCHAR(64)
  (match-save upserts `mock-<uuid>` placeholders that overflowed VARCHAR(32)).

## 7. Pending / next steps
- **Full multi-stage cross-tier ladder rules**: value-based stage-1/ascension
  works; the exact bracket rules for higher stages need finalizing with the owner
  (how many stages, whether ascension grants a higher-tier ticket, etc.).
- **Real server-side paid economy**: today the wallet/tickets are frontend
  (localStorage). For real money, move wallet + transaction history + ticket
  inventory server-side (DB) with sandbox payment.
- **Deeper resilience**: persist full match state server-side + exact resume after
  a long reconnect (current handling degrades gracefully via lockstep timeouts).
- **Color standardization (winner=green/loser=red)**: done in the result modal;
  audit the in-game live score row and the end screen for consistency.
- **Purge "تو" from mock leaderboard data** (low priority — it's placeholder data).
- **Required tests** (owner runs them on 2 devices): green⇄green, ascension
  green⇄blue, blue⇄blue→red, mid-question disconnect+return, multiple concurrent
  matches, prize→wallet.

## 8. Gotchas / do-not-break
- Deploy + test via the IP, two different phones, normal + incognito windows.
- Don't reintroduce `typeof pzRt` inside `pzNewRt` (TDZ).
- Don't add on-focus `scrollIntoView` to the auth screens (it surfaced/stuck the
  more-menu sheet). `openMenu()` is now a no-op on login/otp/register/splash/intro.
- A global `@media (prefers-reduced-motion:reduce)` rule zeroes ALL animations;
  the radar sweep is explicitly exempted. Users with Windows "reduce motion" on
  will otherwise see a static app.
- Keep changes ADDITIVE and guarded on `pzRt.active` so mock/WTA modes stay intact.
- The frontend can't be pushed to GitHub from the assistant's sandbox (403 — the
  GitHub App lacks write). Deliver files directly; the owner deploys via scp.
- Verify frontend edits with `node --check` on the extracted `<script>`; verify
  backend with `npx tsc --noEmit` in `prizzequizz-api/`.
