/* LAST SURVIVOR — player-facing REST. Authoritative snapshot + actions; the
 * realtime channel `ls:{roomId}` mirrors these for instant updates. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { bodyObject } from '../../utils/validation.js';
import { getConfig, updateConfig, setTopicEnabled, isTopicPlayable, removeTopic,
         RANDOM_TOPIC, isRandomTopic } from '../../services/lastSurvivorConfig.js';
import { joinTopic, snapshot, addVote, addChat, listChat, getRoom, saveRoom, listAllRooms, listPlayers,
         leaveRoom, touchPlayer, sweepIdlePlayers, LastSurvivorError, listActiveRooms} from '../../services/lastSurvivorService.js';
import { submitAnswer, submitDecision, useLifeline, advanceRoom } from '../../services/lastSurvivorWorker.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { avatarUrlFor } from '../../services/avatarService.js';
import { categoryList } from '../../services/configService.js';
import { categoryImageUrls } from '../../services/categoryImageService.js';
import { equippedCharacterFor } from '../../services/characterSelectionService.js';

/* Two lobby polls of grace. Long enough that a slow phone or a tunnel is not
 * thrown out, short enough that the list is honest. */
const LOBBY_IDLE_MS = 45_000;

export function registerLastSurvivorRoutes(router: Router, base: string): void {
  // ---------------- ADMIN: config + topic gating + live rooms ----------------
  router.add('GET', `${base}/admin/last-survivor/config`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    json(ctx.res, 200, await getConfig());
  });
  router.add('PUT', `${base}/admin/last-survivor/config`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    json(ctx.res, 200, await updateConfig(bodyObject(ctx.body) as any));
  });
  router.add('POST', `${base}/admin/last-survivor/topics/:topic`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    const body = bodyObject(ctx.body) as any;
    const topic = decodeURIComponent(ctx.params.topic!);
    const cfg = await setTopicEnabled(topic, !!body.enabled, body.minUsers != null ? Number(body.minUsers) : undefined);
    json(ctx.res, 200, { topic, config: cfg.topics[topic] });
  });
  /* Forget a topic's override. A category that still has questions returns to
   * the list gated, which is the only thing "delete" can honestly mean when the
   * list is derived from the question bank. */
  router.add('DELETE', `${base}/admin/last-survivor/topics/:topic`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    const topic = decodeURIComponent(ctx.params.topic!);
    try {
      const cfg = await removeTopic(topic);
      json(ctx.res, 200, { removed: topic, topics: cfg.topics });
    } catch (e) {
      return error(ctx.res, 422, 'TOPIC_PROTECTED', e instanceof Error ? e.message : 'حذف نشد.');
    }
  });

  /* One room in full: who played, what they staked, how they left and what they
   * were paid. The list view answers "what is happening"; this answers "what
   * happened to this person", which is the question support actually gets. */
  router.add('GET', `${base}/admin/last-survivor/rooms/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    const room = await getRoom(ctx.params.id!);
    if (!room) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'اتاق پیدا نشد.');
    const players = await listPlayers(room.id);
    json(ctx.res, 200, {
      room: {
        id: room.id, topic: room.topic, status: room.status, phase: room.phase,
        round: room.round, totalRounds: room.totalRounds, capacity: room.capacity,
        minUsers: room.minUsers, grossPool: room.grossPool, rakePercent: room.rakePercent,
        createdAt: room.createdAt, startsAt: room.startsAt, startedAt: room.startedAt, endedAt: room.endedAt
      },
      players: players.map((p) => ({
        userId: p.userId, username: p.username, color: p.color, units: p.units,
        status: p.status, eliminatedRound: p.eliminatedRound, cashedOutRound: p.cashedOutRound,
        payoutCash: p.payoutCash, joinedAt: p.joinedAt, lastSeenAt: p.lastSeenAt
      })),
      totals: {
        players: players.length,
        alive: players.filter((p) => p.status === 'alive').length,
        eliminated: players.filter((p) => p.status === 'eliminated').length,
        cashedOut: players.filter((p) => p.status === 'cashed_out').length,
        paidOut: players.reduce((sum, p) => sum + (p.payoutCash || 0), 0)
      }
    });
  });

  /* Cancel a room that has not started. Every stake goes back — this is the
   * only safe kind of cancel, because once a match is running the money has
   * already begun moving and unwinding it would mean deciding who "should"
   * have won. A running room is refused rather than half-refunded. */
  router.add('POST', `${base}/admin/last-survivor/rooms/:id/cancel`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    const room = await getRoom(ctx.params.id!);
    if (!room) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'اتاق پیدا نشد.');
    if (room.status !== 'waiting') {
      return error(ctx.res, 409, 'ROOM_STARTED', 'مسابقه شروع شده — لغو با برگشت وجه ممکن نیست.');
    }
    let refunded = 0;
    for (const p of await listPlayers(room.id)) {
      const out = await leaveRoom(room.id, p.userId).catch(() => ({ left: false, refunded: false }));
      if (out.refunded) refunded++;
    }
    const fresh = (await getRoom(room.id))!;
    fresh.status = 'finished'; fresh.phase = 'finished'; fresh.endedAt = Date.now();
    await saveRoom(fresh);
    json(ctx.res, 200, { cancelled: room.id, refunded });
  });

  /* Start a waiting room now, without waiting for the deadline or the vote.
   * The sweep inside maybeStart still runs, so this cannot start a room on
   * players who have already walked away. */
  router.add('POST', `${base}/admin/last-survivor/rooms/:id/start`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    const room = await getRoom(ctx.params.id!);
    if (!room) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'اتاق پیدا نشد.');
    if (room.status !== 'waiting') return error(ctx.res, 409, 'ROOM_STARTED', 'این اتاق در انتظار نیست.');
    room.startsAt = Date.now() - 1;          // deadline reached → advanceRoom starts it
    await saveRoom(room);
    await advanceRoom((await getRoom(room.id))!);
    const after = (await getRoom(room.id))!;
    json(ctx.res, 200, { id: after.id, status: after.status, round: after.round, players: (await listPlayers(after.id)).length });
  });

  // Live rooms monitor (read-only ops view).
  router.add('GET', `${base}/admin/last-survivor/rooms`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'lastsurvivor' })) return;
    const rooms = await listAllRooms(Number(ctx.query.get('limit') ?? 80));
    const withCounts = await Promise.all(rooms.map(async (r) => {
      const players = await listPlayers(r.id);
      return { id: r.id, topic: r.topic, status: r.status, phase: r.phase, round: r.round, totalRounds: r.totalRounds,
        players: players.length, alive: players.filter((p) => p.status === 'alive').length, cashedOut: players.filter((p) => p.status === 'cashed_out').length,
        capacity: r.capacity, grossPool: r.grossPool, createdAt: r.createdAt, startedAt: r.startedAt, endedAt: r.endedAt };
    }));
    json(ctx.res, 200, { rows: withCounts });
  });

  // Topic picker: every real category, each flagged playable or "coming soon".
  router.add('GET', `${base}/last-survivor/topics`, async (ctx) => {
    const cfg = await getConfig();
    const questions = await repositories.questions.listApproved();
    const counts = new Map<string, number>();
    for (const q of questions) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
    // Union of categories that have questions and topics named in config.
    const names = new Set<string>([...counts.keys(), ...Object.keys(cfg.topics || {})]);
    names.add(RANDOM_TOPIC);          // always offered, even before any category has questions
    /* Topic name, emoji and artwork all come from the one category list the
     * admin edits, so a picture uploaded once shows up in every mode. */
    const cats = new Map(categoryList().map((c) => [c.name, c]));
    const art = await categoryImageUrls().catch(() => ({} as Record<string, string>));
    /* What is actually at stake right now, per topic. Last Survivor's prize is
     * a SHARE of the pot the entrants build — it cannot be known before they
     * arrive — so the entry screen shows the live pot instead of a fixed
     * figure. Without this the client had nothing true to show and fell back on
     * the duel's number, which is a different game's arithmetic. */
    const live = new Map<string, { pool: number; players: number }>();
    for (const r of await listActiveRooms()) {
      if (r.status !== 'waiting') continue;
      const cur = live.get(r.topic) ?? { pool: 0, players: 0 };
      cur.pool += r.grossPool;
      cur.players += (await listPlayers(r.id)).length;
      live.set(r.topic, cur);
    }
    const topics = [...names].map((name) => ({
      name,
      icon: cats.get(name)?.icon ?? '❓',
      image: art[name] ?? '',
      /* «تصادفی» draws from every category, so its bank is the whole bank —
       * reporting a per-category count would show 0 and read as broken. */
      questionCount: isRandomTopic(name) ? questions.length : (counts.get(name) ?? 0),
      random: isRandomTopic(name),
      /* The waiting room's pot and head count for this topic, or zeros when
       * nobody is waiting yet. */
      livePool: live.get(name)?.pool ?? 0,
      livePlayers: live.get(name)?.players ?? 0,
      playable: isTopicPlayable(cfg, name),
      comingSoon: !isTopicPlayable(cfg, name),
      minUsers: cfg.topics?.[name]?.minUsers ?? cfg.room.minUsers
    })).sort((a, b) =>
      a.random !== b.random ? (a.random ? -1 : 1)
      : a.playable !== b.playable ? (a.playable ? -1 : 1)
      : b.questionCount - a.questionCount);
    json(ctx.res, 200, { topics, tickets: cfg.economy.tickets });
  });

  router.add('POST', `${base}/last-survivor/join`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    const topic = String(body.topic || '').trim();
    const color = String(body.color || '').trim();
    if (!topic || !color) return error(ctx.res, 422, 'FIELDS_REQUIRED', 'موضوع و رنگ بلیط لازم است.');
    const userId = ctx.userId;
    if (!userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    let user: any = null; try { user = await repositories.users.findById(userId); } catch { /* fallback below */ }
    try {
      const { room } = await joinTopic({ id: userId, username: user?.username || user?.displayName || 'بازیکن', avatar: await avatarUrlFor(userId), character: await equippedCharacterFor(userId) }, topic, color);
      json(ctx.res, 201, await snapshot(room.id, userId));
    } catch (e) {
      if (e instanceof LastSurvivorError) return error(ctx.res, 409, e.code, e.message);
      return error(ctx.res, 400, 'JOIN_FAILED', (e as Error).message || 'ورود ناموفق بود.');
    }
  });

  router.add('GET', `${base}/last-survivor/rooms/:id`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const roomId = ctx.params.id!;
    /* Having the room open IS being there — this is the heartbeat. Then drop
     * anyone whose heartbeat stopped, so the lobby the caller is about to see
     * lists the people actually in it. Both are best-effort: a stale list is a
     * far smaller problem than a room that will not load. */
    await touchPlayer(roomId, ctx.userId).catch(() => undefined);
    await sweepIdlePlayers(roomId, LOBBY_IDLE_MS).catch(() => undefined);
    const snap = await snapshot(roomId, ctx.userId);
    if (!snap) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'روم یافت نشد.');
    json(ctx.res, 200, snap);
  });

  /* Leaving the lobby. The ticket goes back and the pot shrinks by its value —
   * see leaveRoom. Re-joining afterwards is an ordinary join. */
  router.add('POST', `${base}/last-survivor/rooms/:id/leave`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    try {
      const out = await leaveRoom(ctx.params.id!, ctx.userId);
      json(ctx.res, 200, out);
    } catch (e) {
      if (e instanceof LastSurvivorError) {
        return error(ctx.res, e.code === 'ROOM_NOT_FOUND' ? 404 : 409, e.code, e.message);
      }
      throw e;
    }
  });

  router.add('POST', `${base}/last-survivor/rooms/:id/answer`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const res = await submitAnswer(ctx.params.id!, ctx.userId, Number(body.round), Number(body.selectedIndex));
    if (!res.accepted) return error(ctx.res, 409, res.reason || 'ANSWER_REJECTED', 'پاسخ پذیرفته نشد.');
    json(ctx.res, 200, { accepted: true });
  });

  // Lifelines (50:50 / second chance / stats). 50:50 is resolved server-side so
  // the correct index is never sent to the client.
  router.add('POST', `${base}/last-survivor/rooms/:id/lifeline`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const res = await useLifeline(ctx.params.id!, ctx.userId, String(body.type || ''));
    if (!res.ok) return error(ctx.res, 409, res.reason || 'LIFELINE_REJECTED', 'این کمک الان قابل استفاده نیست.');
    json(ctx.res, 200, res);
  });

  router.add('POST', `${base}/last-survivor/rooms/:id/decision`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    const decision = body.decision === 'cashout' ? 'cashout' : 'continue';
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const res = await submitDecision(ctx.params.id!, ctx.userId, Number(body.round), decision);
    if (!res.accepted) return error(ctx.res, 409, res.reason || 'DECISION_REJECTED', 'ثبت نشد.');
    json(ctx.res, 200, { accepted: true, decision });
  });

  router.add('POST', `${base}/last-survivor/rooms/:id/vote-start`, async (ctx) => {
    const room = await getRoom(ctx.params.id!);
    if (!room || room.status !== 'waiting') return error(ctx.res, 409, 'NOT_WAITING', 'روم در حالت انتظار نیست.');
    if (!room.manualStartEnabled) return error(ctx.res, 409, 'MANUAL_START_OFF', 'شروع دستی غیرفعال است.');
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    const votes = await addVote(ctx.params.id!, ctx.userId);
    json(ctx.res, 200, { votes });
  });

  router.add('GET', `${base}/last-survivor/rooms/:id/chat`, async (ctx) => {
    json(ctx.res, 200, { messages: await listChat(ctx.params.id!, Number(ctx.query.get('limit') ?? 60)) });
  });

  router.add('POST', `${base}/last-survivor/rooms/:id/chat`, async (ctx) => {
    const room = await getRoom(ctx.params.id!);
    if (!room) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'روم یافت نشد.');
    if (!room.config.features.chat || room.status !== 'waiting') return error(ctx.res, 409, 'CHAT_CLOSED', 'چت فقط در اتاق انتظار باز است.');
    const body = bodyObject(ctx.body) as any;
    const userId = ctx.userId;
    if (!userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'ابتدا وارد شو.');
    let user: any = null; try { user = await repositories.users.findById(userId); } catch { /* ignore */ }
    await addChat(ctx.params.id!, userId, user?.username || user?.displayName || 'بازیکن', String(body.body || ''));
    json(ctx.res, 201, { sent: true });
  });
}
