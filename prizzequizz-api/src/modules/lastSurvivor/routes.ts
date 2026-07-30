/* LAST SURVIVOR — player-facing REST. Authoritative snapshot + actions; the
 * realtime channel `ls:{roomId}` mirrors these for instant updates. */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { bodyObject } from '../../utils/validation.js';
import { getConfig, updateConfig, setTopicEnabled, isTopicPlayable } from '../../services/lastSurvivorConfig.js';
import { joinTopic, snapshot, addVote, addChat, listChat, getRoom, listAllRooms, listPlayers, LastSurvivorError } from '../../services/lastSurvivorService.js';
import { submitAnswer, submitDecision, useLifeline } from '../../services/lastSurvivorWorker.js';
import { requireAdmin } from '../../services/adminGuard.js';

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
    const topics = [...names].map((name) => ({
      name,
      questionCount: counts.get(name) ?? 0,
      playable: isTopicPlayable(cfg, name),
      comingSoon: !isTopicPlayable(cfg, name),
      minUsers: cfg.topics?.[name]?.minUsers ?? cfg.room.minUsers
    })).sort((a, b) => (a.playable === b.playable ? b.questionCount - a.questionCount : a.playable ? -1 : 1));
    json(ctx.res, 200, { topics, tickets: cfg.economy.tickets });
  });

  router.add('POST', `${base}/last-survivor/join`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    const topic = String(body.topic || '').trim();
    const color = String(body.color || '').trim();
    if (!topic || !color) return error(ctx.res, 422, 'FIELDS_REQUIRED', 'موضوع و رنگ بلیط لازم است.');
    const userId = ctx.userId ?? 'u1';
    let user: any = null; try { user = await repositories.users.findById(userId); } catch { /* fallback below */ }
    try {
      const { room } = await joinTopic({ id: userId, username: user?.username || user?.displayName || 'بازیکن', avatar: user?.avatarUrl ?? null }, topic, color);
      json(ctx.res, 201, await snapshot(room.id, userId));
    } catch (e) {
      if (e instanceof LastSurvivorError) return error(ctx.res, 409, e.code, e.message);
      return error(ctx.res, 400, 'JOIN_FAILED', (e as Error).message || 'ورود ناموفق بود.');
    }
  });

  router.add('GET', `${base}/last-survivor/rooms/:id`, async (ctx) => {
    const snap = await snapshot(ctx.params.id!, ctx.userId ?? 'u1');
    if (!snap) return error(ctx.res, 404, 'ROOM_NOT_FOUND', 'روم یافت نشد.');
    json(ctx.res, 200, snap);
  });

  router.add('POST', `${base}/last-survivor/rooms/:id/answer`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    const res = await submitAnswer(ctx.params.id!, ctx.userId ?? 'u1', Number(body.round), Number(body.selectedIndex));
    if (!res.accepted) return error(ctx.res, 409, res.reason || 'ANSWER_REJECTED', 'پاسخ پذیرفته نشد.');
    json(ctx.res, 200, { accepted: true });
  });

  // Lifelines (50:50 / second chance / stats). 50:50 is resolved server-side so
  // the correct index is never sent to the client.
  router.add('POST', `${base}/last-survivor/rooms/:id/lifeline`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    const res = await useLifeline(ctx.params.id!, ctx.userId ?? 'u1', String(body.type || ''));
    if (!res.ok) return error(ctx.res, 409, res.reason || 'LIFELINE_REJECTED', 'این کمک الان قابل استفاده نیست.');
    json(ctx.res, 200, res);
  });

  router.add('POST', `${base}/last-survivor/rooms/:id/decision`, async (ctx) => {
    const body = bodyObject(ctx.body) as any;
    const decision = body.decision === 'cashout' ? 'cashout' : 'continue';
    const res = await submitDecision(ctx.params.id!, ctx.userId ?? 'u1', Number(body.round), decision);
    if (!res.accepted) return error(ctx.res, 409, res.reason || 'DECISION_REJECTED', 'ثبت نشد.');
    json(ctx.res, 200, { accepted: true, decision });
  });

  router.add('POST', `${base}/last-survivor/rooms/:id/vote-start`, async (ctx) => {
    const room = await getRoom(ctx.params.id!);
    if (!room || room.status !== 'waiting') return error(ctx.res, 409, 'NOT_WAITING', 'روم در حالت انتظار نیست.');
    if (!room.manualStartEnabled) return error(ctx.res, 409, 'MANUAL_START_OFF', 'شروع دستی غیرفعال است.');
    const votes = await addVote(ctx.params.id!, ctx.userId ?? 'u1');
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
    const userId = ctx.userId ?? 'u1';
    let user: any = null; try { user = await repositories.users.findById(userId); } catch { /* ignore */ }
    await addChat(ctx.params.id!, userId, user?.username || user?.displayName || 'بازیکن', String(body.body || ''));
    json(ctx.res, 201, { sent: true });
  });
}
