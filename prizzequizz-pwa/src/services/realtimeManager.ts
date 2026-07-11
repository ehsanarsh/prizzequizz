import { eventBus } from '../core/eventBus';
import { store } from '../core/stateStore';
import { realtime } from '../api';
import type { MatchSnapshotDto } from '../api/contracts';

let installed = false;
let reconnectTimer = 0;
let heartbeatTimer = 0;
let attempts = 0;
let currentMatchId: string | null = null;

export function installRealtimeManager(): void {
  if (installed) return;
  installed = true;

  realtime.on((evt) => {
    eventBus.emit(evt.type, evt.payload);

    if (evt.type === 'server:connected') {
      attempts = 0;
      store.set((draft) => {
        draft.ui.realtime.connected = true;
        draft.ui.realtime.reconnecting = false;
      });
      startHeartbeat();
      if (currentMatchId) joinRealtimeMatch(currentMatchId);
    }

    if (evt.type === 'server:disconnected') {
      stopHeartbeat();
      store.set((draft) => {
        draft.ui.realtime.connected = false;
        draft.ui.realtime.reconnecting = true;
      });
      const manual = Boolean((evt.payload as any)?.manual);
      if (!manual) scheduleReconnect();
    }

    if (evt.type === 'server:presence') {
      const users = ((evt.payload as any)?.users ?? []) as Array<{ userId: string; lastSeenAt: string }>;
      store.set((draft) => {
        draft.ui.realtime.presence = users;
      });
    }

    if (evt.type === 'server:chat') {
      const payload = evt.payload as any;
      const myId = store.get().user.id;
      const text = String(payload.text ?? '');
      const time = new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
      store.set((draft) => {
        if (payload.userId === myId) {
          const pending = [...draft.ui.realtime.duelChat].reverse().find((m) => m.from === 'me' && m.pending && m.text === text);
          if (pending) {
            pending.pending = false;
            pending.time = time;
          } else {
            draft.ui.realtime.duelChat.push({ from: 'me', text, time });
          }
        } else {
          draft.ui.realtime.duelChat.push({ from: 'opponent', text, time });
        }
        draft.ui.realtime.duelChat = draft.ui.realtime.duelChat.slice(-20);
      });
    }

    if (evt.type === 'server:match_snapshot') {
      applyMatchSnapshot(evt.payload as Partial<MatchSnapshotDto>);
      store.set((draft) => {
        draft.ui.realtime.lastRecoveredAt = new Date().toISOString();
      });
    }

    if (evt.type === 'server:match_finished') applyMatchSnapshot(evt.payload as Partial<MatchSnapshotDto>);
    if (evt.type === 'server:error') eventBus.emit('REALTIME_ERROR', evt.payload);
  });

  eventBus.on<{ matchId: string }>('DUEL_MATCH_CREATED', ({ matchId }) => joinRealtimeMatch(matchId));
  realtime.connect();
}

export function joinRealtimeMatch(matchId: string): void {
  currentMatchId = matchId;
  store.set((draft) => {
    draft.ui.realtime.duelChat = [{ from: 'system', text: 'اتصال زنده دوئل در حال آماده‌سازی است...', time: '' }];
  });
  if (!realtime.isConnected()) realtime.connect();
  realtime.send('client:join_match', { matchId }, `join_${matchId}_${Date.now()}`);
}

export function leaveRealtimeMatch(): void {
  if (!currentMatchId) return;
  realtime.send('client:leave_match', { matchId: currentMatchId }, `leave_${currentMatchId}_${Date.now()}`);
  currentMatchId = null;
  store.set((draft) => {
    draft.ui.realtime.presence = [];
    draft.ui.realtime.duelChat = [];
  });
}

export function sendRealtimeChat(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  if (!currentMatchId) {
    store.set((draft) => {
      draft.ui.realtime.duelChat.push({ from: 'system', text: 'هنوز به اتاق دوئل وصل نیستی.', time: '' });
    });
    return;
  }
  if (!realtime.isConnected()) {
    store.set((draft) => {
      draft.ui.realtime.duelChat.push({ from: 'system', text: 'اتصال زنده قطع است؛ بعد از اتصال مجدد پیام بفرست.', time: '' });
    });
    return;
  }
  const messageId = `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  store.set((draft) => {
    draft.ui.realtime.duelChat.push({ id: messageId, from: 'me', text: clean, time: 'در حال ارسال...', pending: true });
    draft.ui.realtime.duelChat = draft.ui.realtime.duelChat.slice(-20);
  });
  realtime.send('client:send_chat', { matchId: currentMatchId, text: clean, localId: messageId }, `chat_${Date.now()}`);
}

function scheduleReconnect(): void {
  window.clearTimeout(reconnectTimer);
  attempts += 1;
  const delay = Math.min(8000, 500 * 2 ** attempts);
  eventBus.emit('REALTIME_RECONNECTING', { attempts, delay });
  reconnectTimer = window.setTimeout(() => realtime.connect(), delay);
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = window.setInterval(() => {
    if (realtime.isConnected()) realtime.send('client:ping', { t: Date.now() }, `ping_${Date.now()}`);
  }, 25000);
}

function stopHeartbeat(): void {
  window.clearInterval(heartbeatTimer);
}

function applyMatchSnapshot(snapshot: Partial<MatchSnapshotDto>): void {
  if (!snapshot?.players?.length) return;
  const me = snapshot.players.find((p) => p.userId === store.get().user.id) ?? snapshot.players[0];
  const opp = snapshot.players.find((p) => p.userId !== me?.userId);
  store.set((draft) => {
    if (snapshot.phase === 'result') draft.match.phase = 'result';
    if (typeof snapshot.round === 'number') draft.match.duel.round = snapshot.round;
    if (me) draft.match.duel.myScore = me.score;
    if (opp) {
      draft.match.duel.opponentScore = opp.score;
      draft.match.duel.opponent = { id: opp.userId, name: opp.username, avatar: opp.avatar };
    }
  });
}
