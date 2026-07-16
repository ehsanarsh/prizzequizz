import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { createMatch, createMatchForPlayers, getMatch, startMatch, submitAnswer } from '../../services/matchEngine.js';
import { validateAnswer } from '../../services/questionEngine.js';
import { repositories } from '../../repositories/index.js';
import { activeMatchState } from '../../services/matchStateStore.js';
import type { GameModeId, Match, PlanType } from '../../types/domain.js';

// Persist a mutated match to BOTH the repository AND the in-memory active-match
// store. getMatch() reads the active store first, so writing only to the repo
// (as several endpoints used to) left the active copy stale — which desynced the
// chosen topic, the toss winner and the rematch handshake between the two clients.
async function persist(match: Match): Promise<void> {
  await repositories.matches.save(match);
  await activeMatchState.set(match, 60 * 60);
}

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
      await persist(match);
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
    await persist(match);
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
    await persist(match);
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
    const cur = match.duelTossRound ?? 0;
    const round = Number.isInteger(body.round) ? Number(body.round) : cur;
    if (!match.duelToss) match.duelToss = {};
    // Only record a submission for the CURRENT round, once, and only while the
    // winner is undecided (ignores late/stale submissions from a previous round).
    if (round === cur && !match.duelTossWinner) {
      const prev = match.duelToss[uid];
      if (!prev || prev.round !== cur) match.duelToss[uid] = { correct: !!body.correct, timeMs: Math.max(0, Number(body.timeMs ?? 999999)), round: cur };
    }
    resolveToss(match);
    match.updatedAt = new Date().toISOString();
    await persist(match);
    json(ctx.res, 200, tossState(match, uid));
  });
  // Both players poll this until `winner` is set (then winner picks, loser waits).
  // `round` tells the client which toss question to show (it grows on a both-wrong retry).
  router.add('GET', `${base}/matches/:id/toss`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    json(ctx.res, 200, tossState(match, ctx.userId ?? 'u1'));
  });

  // Permanently finish a match (e.g. a forfeit when the opponent disconnected).
  // Once finished the phase is locked so a reconnecting client cannot resume a
  // match the other player has already won and left.
  router.add('POST', `${base}/matches/:id/finish`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    if (match.phase !== 'finished') {
      const w = (ctx.body as any)?.winnerUserId;
      if (w) match.winnerUserId = String(w);
      match.phase = 'finished';
      match.duelSettled = true;
      match.updatedAt = new Date().toISOString();
      await persist(match);
    }
    json(ctx.res, 200, toSnapshot(match));
  });

  // The toss winner stores the chosen topic on the match; the server is the
  // single source of truth (no client-to-client rebroadcast to the loser).
  router.add('POST', `${base}/matches/:id/topic`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const body = (ctx.body ?? {}) as any;
    const topic = String(body.topic ?? '').trim() || '__popular__';
    const half = String(Math.max(1, Math.floor(Number(body.half ?? 1)) || 1));
    if (!match.duelTopics) match.duelTopics = {};
    match.duelTopics[half] = topic;
    if (half === '1') match.duelTopic = topic; // back-compat: half 1 mirrors duelTopic
    match.updatedAt = new Date().toISOString();
    await persist(match);
    json(ctx.res, 200, { topic, half: Number(half) });
  });
  // The waiting player polls this until the picker has chosen (topic !== null).
  // ?half=2 reads the second-half topic (chosen by the toss loser).
  router.add('GET', `${base}/matches/:id/topic`, async (ctx) => {
    const match = await getMatch(ctx.params.id!);
    const half = String(Math.max(1, Math.floor(Number(ctx.query.get('half') ?? 1)) || 1));
    const t = (match.duelTopics && match.duelTopics[half]) ?? (half === '1' ? match.duelTopic : undefined) ?? null;
    json(ctx.res, 200, { topic: t, half: Number(half) });
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

// Decide the toss winner for the CURRENT round once BOTH players have submitted:
//  - at least one correct  → the fastest CORRECT answer wins (userId breaks an
//    exact tie); a wrong answer can never win.
//  - both wrong            → nobody wins; bump duelTossRound so a fresh toss
//    question is shown, and repeat until someone is correct.
// Idempotent — the winner is fixed once set.
function resolveToss(match: any): void {
  if (match.duelTossWinner || !match.duelToss) return;
  const cur = match.duelTossRound ?? 0;
  const ids = (match.players ?? []).map((p: any) => p.userId);
  if (!ids.length) return;
  const subFor = (id: string) => { const s = match.duelToss[id]; return s && s.round === cur ? s : null; };
  if (!ids.every((id: string) => subFor(id))) return; // still waiting for both this round
  const correctIds = ids.filter((id: string) => subFor(id)!.correct);
  if (correctIds.length === 0) { match.duelTossRound = cur + 1; return; } // both wrong → retry
  const faster = (a: string, b: string): string => {
    const x = subFor(a)!, y = subFor(b)!;
    if (x.timeMs !== y.timeMs) return x.timeMs < y.timeMs ? a : b;
    return a < b ? a : b;
  };
  match.duelTossWinner = correctIds.reduce((best: string, id: string) => (best ? faster(best, id) : id), '');
}

function tossState(match: any, uid: string) {
  const cur = match.duelTossRound ?? 0;
  const submitted = match.duelToss ? Object.keys(match.duelToss).filter((k) => match.duelToss[k]?.round === cur) : [];
  return { round: cur, winner: match.duelTossWinner ?? null, iWon: match.duelTossWinner ? match.duelTossWinner === uid : null, submitted, waiting: !match.duelTossWinner };
}

function readyState(match: any, round: number) {
  const ids = (match.players ?? []).map((p: any) => p.userId);
  const ready = match.duelReady ?? {};
  const allReady = ids.length > 0 && ids.every((id: string) => (ready[id] ?? -1) >= round);
  return { round, allReady, ready: Object.keys(ready).length };
}
