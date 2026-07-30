import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyAccessToken } from '../services/tokenService.js';
import { validateAnswer } from '../services/questionEngine.js';
import { getMatch, submitAnswer } from '../services/matchEngine.js';
import { logger } from '../services/logger.js';
import { id } from '../utils/id.js';
import { realtimeRooms } from './roomRegistry.js';
import { leaderboards, type LeaderboardKind } from '../services/leaderboardService.js';
import type { ClientRealtimeMessage } from './protocol.js';

export function attachRealtimeGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/v1/realtime' });

  const cleanupTimer = setInterval(() => {
    const removed = realtimeRooms.cleanupStale();
    if (removed) logger.info('realtime_stale_cleanup', { removed });
  }, 30_000);
  cleanupTimer.unref?.();
  wss.on('close', () => clearInterval(cleanupTimer));

  wss.on('connection', (socket, req) => {
    const userId = readUserId(req) ?? 'u1';
    const meta = realtimeRooms.add(socket, userId);
    realtimeRooms.send(meta.id, { type: 'server:connected', payload: { clientId: meta.id, userId, heartbeatMs: 25000 }, requestId: undefined });
    logger.info('realtime_connected', { clientId: meta.id, userId });

    socket.on('pong', () => realtimeRooms.touch(meta.id));
    socket.on('message', (raw) => void handleMessage(socket, meta.id, userId, raw));
    socket.on('close', () => {
      const matchId = meta.matchId;
      realtimeRooms.remove(meta.id);
      // Human-only: if a player drops out of an active match, tell the other
      // player so they can win by forfeit instead of waiting forever.
      if (matchId) {
        void realtimeRooms.presence(matchId).then((users) => {
          realtimeRooms.broadcast(matchId, { type: 'server:presence', matchId, payload: { users } });
          realtimeRooms.broadcast(matchId, { type: 'server:opponent_left', matchId, payload: { userId } });
        }).catch(() => undefined);
      }
      logger.info('realtime_disconnected', { clientId: meta.id, userId });
    });
    socket.on('error', (error) => logger.warn('realtime_socket_error', { clientId: meta.id, userId, message: error.message }));
  });

  return wss;
}

async function handleMessage(socket: WebSocket, clientId: string, userId: string, raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
  let msg: ClientRealtimeMessage;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    realtimeRooms.send(clientId, { type: 'server:error', payload: { code: 'INVALID_MESSAGE' } });
    return;
  }

  realtimeRooms.touch(clientId);

  try {
    if (msg.type === 'client:ping') {
      realtimeRooms.send(clientId, { type: 'server:pong', payload: { t: Date.now() }, requestId: msg.requestId });
      return;
    }

    if (msg.type === 'client:join_match') {
      const matchId = String((msg.payload as any)?.matchId ?? '');
      const match = await getMatch(matchId);
      realtimeRooms.join(clientId, matchId);
      void realtimeRooms.subscribeMatch(matchId);
      realtimeRooms.send(clientId, { type: 'server:match_snapshot', matchId, payload: snapshot(match), requestId: msg.requestId });
      const users = await realtimeRooms.presence(matchId);
      realtimeRooms.send(clientId, { type: 'server:presence', matchId, payload: { users } });
      realtimeRooms.broadcast(matchId, { type: 'server:presence', payload: { users } });
      return;
    }

    if (msg.type === 'client:leave_match') {
      const matchId = String((msg.payload as any)?.matchId ?? '');
      realtimeRooms.leave(clientId, matchId);
      realtimeRooms.broadcast(matchId, { type: 'server:presence', payload: { users: await realtimeRooms.presence(matchId) } });
      return;
    }


    // Last Survivor: subscribe to a room's realtime topic and get an initial
    // snapshot. All `ls:*` events (state, question, elimination, cashout, ended)
    // are pushed by the orchestrator to `ls:{roomId}`. Reconnecting just re-joins
    // and re-snapshots — the authoritative state is always in the DB.
    if (msg.type === 'client:join_ls_room') {
      const roomId = String((msg.payload as any)?.roomId ?? '');
      if (roomId) {
        const topic = `ls:${roomId}`;
        realtimeRooms.joinTopic(clientId, topic);
        void realtimeRooms.subscribeTopic(topic);
        const { snapshot } = await import('../services/lastSurvivorService.js');
        realtimeRooms.send(clientId, { type: 'server:ls_snapshot', payload: await snapshot(roomId, userId), requestId: msg.requestId } as any);
      }
      return;
    }
    if (msg.type === 'client:leave_ls_room') {
      const roomId = String((msg.payload as any)?.roomId ?? '');
      if (roomId) realtimeRooms.leaveTopic(clientId, `ls:${roomId}`);
      return;
    }

    if (msg.type === 'client:subscribe_leaderboard') {
      const kind = normalizeLeaderboardKind((msg.payload as any)?.kind);
      const topic = `leaderboard:${kind}`;
      realtimeRooms.joinTopic(clientId, topic);
      void realtimeRooms.subscribeTopic(topic);
      realtimeRooms.send(clientId, { type: 'server:leaderboard_update', payload: { kind, leaderboard: await leaderboards.get(kind, 20, userId) }, requestId: msg.requestId });
      return;
    }

    if (msg.type === 'client:unsubscribe_leaderboard') {
      const kind = normalizeLeaderboardKind((msg.payload as any)?.kind);
      realtimeRooms.leaveTopic(clientId, `leaderboard:${kind}`);
      return;
    }

    if (msg.type === 'client:send_chat') {
      const matchId = String((msg.payload as any)?.matchId ?? '');
      const text = String((msg.payload as any)?.text ?? '').slice(0, 240);
      realtimeRooms.broadcast(matchId, { type: 'server:chat', matchId, payload: { userId, text } });
      return;
    }

    if (msg.type === 'client:submit_answer') {
      const payload = msg.payload as any;
      const matchId = String(payload?.matchId ?? '');
      const questionId = String(payload?.questionId ?? '');
      const selectedIndex = Number(payload?.selectedIndex ?? -1);
      const round = payload?.round === undefined ? undefined : Number(payload.round);
      const validation = await validateAnswer(questionId, selectedIndex);
      const { match, duplicate } = await submitAnswer({
        matchId,
        userId,
        questionId,
        selectedIndex,
        round,
        correct: validation.correct,
        answerTimeMs: Number(payload?.answerTimeMs ?? 0),
        idempotencyKey: String(payload?.idempotencyKey ?? `${matchId}:${userId}:${round ?? questionId}:${selectedIndex}`)
      });
      // Include userId + round so the OTHER player knows whose answer this is and which round.
      realtimeRooms.broadcast(matchId, { type: 'server:answer_result', matchId, payload: { userId, round: round ?? match.round, questionId, correct: validation.correct, selectedIndex, correctIndex: validation.correctIndex, duplicate } });
      realtimeRooms.broadcast(matchId, { type: 'server:match_snapshot', matchId, payload: snapshot(match) });
      if (match.phase === 'result') realtimeRooms.broadcast(matchId, { type: 'server:match_finished', matchId, payload: snapshot(match) });
      return;
    }

    realtimeRooms.send(clientId, { type: 'server:error', payload: { code: 'UNKNOWN_EVENT', type: msg.type }, requestId: msg.requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Realtime error';
    realtimeRooms.send(clientId, { type: 'server:error', payload: { code: 'REALTIME_ERROR', message }, requestId: msg.requestId });
  }
}

function readUserId(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const token = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  return verifyAccessToken(token)?.sub ?? null;
}

function snapshot(match: any) {
  return { matchId: match.id, modeId: match.modeId, phase: match.phase, round: match.round, players: match.players, winnerUserId: match.winnerUserId, duelPointsFinal: match.duelPointsFinal };
}

function normalizeLeaderboardKind(value: unknown): LeaderboardKind {
  return value === 'overall' || value === 'winnings' || value === 'weekly' ? value : 'weekly';
}
