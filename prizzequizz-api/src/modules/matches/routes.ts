import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { createMatch, createMatchForPlayers, getMatch, startMatch, submitAnswer } from '../../services/matchEngine.js';
import { validateAnswer } from '../../services/questionEngine.js';
import { repositories } from '../../repositories/index.js';
import type { GameModeId, PlanType } from '../../types/domain.js';

// Deterministic string hash so both players in a match derive the SAME
// question list from the same matchId — no shared state required.
function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function registerMatchRoutes(router: Router, base: string): void {
  router.add('POST', `${base}/matches`, async (ctx) => {
    const body = ctx.body as any;
    const match = await createMatch(ctx.userId ?? 'u1', body.modeId as GameModeId, body.economyType as PlanType, body.entry?.coinStake);
    json(ctx.res, 201, { matchId: match.id, status: match.phase, configVersion: match.configVersion });
  });

  // Rematch handshake (same two players). Requester opens it; the opponent
  // polls, then accepts/rejects. On accept the server mints a fresh match and
  // both sides read newMatchId to enter it.
  router.add('POST', `${base}/matches/:id/rematch/request`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const by = ctx.userId ?? 'u1';
    // A fresh request (or re-request after a rejection) resets the handshake.
    if (!match.rematch || match.rematch.status !== 'pending' || match.rematch.by !== by) {
      match.rematch = { by, status: 'pending', at: new Date().toISOString() };
      match.updatedAt = new Date().toISOString();
      await repositories.matches.save(match);
    }
    json(ctx.res, 200, match.rematch);
  });
  router.add('GET', `${base}/matches/:id/rematch`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    json(ctx.res, 200, match.rematch ?? { status: 'none' });
  });
  router.add('POST', `${base}/matches/:id/rematch/respond`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const me = ctx.userId ?? 'u1';
    if (!match.rematch || match.rematch.status !== 'pending') return error(ctx.res, 409, 'NO_PENDING_REMATCH', 'No pending rematch');
    if (match.rematch.by === me) return error(ctx.res, 409, 'CANNOT_RESPOND_OWN', 'Requester cannot respond');
    const accept = !!(ctx.body as any)?.accept;
    if (accept) {
      const opponentId = match.players.find((p) => p.userId !== match.rematch!.by)?.userId ?? me;
      const fresh = await createMatchForPlayers(match.rematch.by, opponentId, match.modeId, match.economyType, undefined, false);
      match.rematch.status = 'accepted';
      match.rematch.newMatchId = fresh.id;
    } else {
      match.rematch.status = 'rejected';
    }
    match.updatedAt = new Date().toISOString();
    await repositories.matches.save(match);
    json(ctx.res, 200, match.rematch);
  });

  // Start barrier: each player marks the round they've reached; both enter a
  // round together only once BOTH have marked it (so no one gets a head start).
  router.add('POST', `${base}/matches/:id/ready`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const uid = ctx.userId ?? 'u1';
    const round = Math.max(0, Math.floor(Number((ctx.body as any)?.round ?? 0)) || 0);
    if (!match.duelReady) match.duelReady = {};
    match.duelReady[uid] = Math.max(match.duelReady[uid] ?? -1, round);
    match.updatedAt = new Date().toISOString();
    await repositories.matches.save(match);
    json(ctx.res, 200, readyState(match, round));
  });
  router.add('GET', `${base}/matches/:id/ready`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const round = Math.max(0, Math.floor(Number(ctx.query.get('round') ?? 0)) || 0);
    json(ctx.res, 200, readyState(match, round));
  });

  // Speed-round (toss): each player submits their result; the SERVER decides the
  // winner (fastest correct answer, userId breaks an exact tie) so the two
  // clients can never both think they won and both open topic-selection.
  router.add('POST', `${base}/matches/:id/toss`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const uid = ctx.userId ?? 'u1';
    const body = (ctx.body ?? {}) as any;
    if (!match.duelToss) match.duelToss = {};
    if (!match.duelToss[uid]) match.duelToss[uid] = { correct: !!body.correct, timeMs: Math.max(0, Number(body.timeMs ?? 999999)) };
    resolveToss(match);
    match.updatedAt = new Date().toISOString();
    await repositories.matches.save(match);
    json(ctx.res, 200, tossState(match, uid));
  });
  // Both players poll this until `winner` is set (then winner picks, loser waits).
  router.add('GET', `${base}/matches/:id/toss`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    resolveToss(match);
    json(ctx.res, 200, tossState(match, ctx.userId ?? 'u1'));
  });

  // The toss winner stores the chosen topic on the match; the server is the
  // single source of truth (no client-to-client rebroadcast to the loser).
  router.add('POST', `${base}/matches/:id/topic`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const topic = String((ctx.body as any)?.topic ?? '').trim() || '__popular__';
    match.duelTopic = topic;
    match.updatedAt = new Date().toISOString();
    await repositories.matches.save(match);
    json(ctx.res, 200, { topic });
  });
  // The loser polls this until the winner has chosen (topic !== null).
  router.add('GET', `${base}/matches/:id/topic`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    json(ctx.res, 200, { topic: match.duelTopic ?? null });
  });

  // Same question for the same (matchId, round, topic) for BOTH players. Callable
  // repeatedly (idempotent) so polling clients always see identical content.
  //  - topic: from ?topic=, else the match's stored duelTopic (winner's choice);
  //    empty / "__popular__" = whole bank.
  //  - Rounds map to DISTINCT questions until the pool is exhausted, so a player
  //    never sees a repeat within a match unless questions genuinely run out;
  //    and because the order is derived purely from (matchId, topic), BOTH
  //    players get the identical set — a question shown to one is shown to both.
  router.add('GET', `${base}/matches/:id/question`, async (ctx) => {
    const round = Math.max(0, Math.floor(Number(ctx.query.get('round') ?? 0)) || 0);
    let topic = (ctx.query.get('topic') ?? '').trim();
    if (!topic) { try { topic = (await getMatch(ctx.params.id!)).duelTopic ?? ''; } catch { /* no stored topic yet */ } }
    const all = await repositories.questions.listApproved();
    if (!all.length) return error(ctx.res, 404, 'NO_QUESTIONS', 'No approved questions available');
    let pool = all;
    if (topic && topic !== '__popular__') {
      const filtered = all.filter((q) => q.category === topic);
      if (filtered.length) pool = filtered; // fall back to the whole bank if the topic is empty
    }
    const ordered = [...pool].sort((a, b) => a.id.localeCompare(b.id));
    const start = hashString(`${ctx.params.id!}|${topic}`) % ordered.length;
    const q = ordered[(start + round) % ordered.length]!;
    json(ctx.res, 200, { id: q.id, text: q.text, options: q.options, correctIndex: q.correctIndex, category: q.category });
  });

  router.add('GET', `${base}/matches/:id`, async (ctx) => json(ctx.res, 200, toSnapshot(await getMatch(ctx.params.id!))));
  router.add('POST', `${base}/matches/:id/start`, async (ctx) => json(ctx.res, 200, toSnapshot(await startMatch(ctx.params.id!))));
  router.add('POST', `${base}/matches/:id/continue`, async (ctx) => json(ctx.res, 200, toSnapshot(await startMatch(ctx.params.id!))));
  router.add('POST', `${base}/matches/:id/exit`, async (ctx) => { const m = await getMatch(ctx.params.id!); m.phase = 'finished'; json(ctx.res, 200, toSnapshot(m)); });

  router.add('POST', `${base}/matches/:id/answer`, async (ctx) => {
    const body = ctx.body as any;
    const validation = await validateAnswer(body.questionId, body.selectedIndex);
    const { match, duplicate } = await submitAnswer({
      matchId: ctx.params.id!,
      userId: ctx.userId ?? 'u1',
      questionId: body.questionId,
      selectedIndex: Number(body.selectedIndex),
      round: body.round === undefined ? undefined : Number(body.round),
      correct: validation.correct,
      answerTimeMs: Number(body.answerTimeMs ?? 0),
      idempotencyKey: String(body.idempotencyKey ?? `${ctx.params.id}:${ctx.userId ?? 'u1'}:${body.round ?? body.questionId}:${body.selectedIndex}`)
    });
    json(ctx.res, 200, { correct: validation.correct, selectedIndex: body.selectedIndex, correctIndex: validation.correctIndex, score: match.players.find((p) => p.userId === (ctx.userId ?? 'u1'))?.score ?? 0, phase: match.phase, duplicate, events: [] });
  });
}

function toSnapshot(match: any) {
  return { matchId: match.id, modeId: match.modeId, phase: match.phase, round: match.round, timerSeconds: 10, players: match.players, rewardPreview: match.rewardPreview };
}

// Decide the toss winner once BOTH players have submitted: a correct answer
// beats a wrong one, then the faster time, then the smaller userId (a stable,
// deterministic tiebreak). Idempotent — the winner is fixed once set.
function resolveToss(match: any): void {
  if (match.duelTossWinner || !match.duelToss) return;
  const ids = (match.players ?? []).map((p: any) => p.userId);
  if (!ids.length || !ids.every((id: string) => match.duelToss[id])) return; // wait for both
  const better = (a: string, b: string): string => {
    const x = match.duelToss[a], y = match.duelToss[b];
    if (x.correct !== y.correct) return x.correct ? a : b;
    if (x.timeMs !== y.timeMs) return x.timeMs < y.timeMs ? a : b;
    return a < b ? a : b;
  };
  match.duelTossWinner = ids.reduce((best: string, id: string) => (best ? better(best, id) : id), '');
}

function tossState(match: any, uid: string) {
  const submitted = match.duelToss ? Object.keys(match.duelToss) : [];
  return { winner: match.duelTossWinner ?? null, iWon: match.duelTossWinner ? match.duelTossWinner === uid : null, submitted, waiting: !match.duelTossWinner };
}

function readyState(match: any, round: number) {
  const ids = (match.players ?? []).map((p: any) => p.userId);
  const ready = match.duelReady ?? {};
  const allReady = ids.length > 0 && ids.every((id: string) => (ready[id] ?? -1) >= round);
  return { round, allReady, ready: Object.keys(ready).length };
}
