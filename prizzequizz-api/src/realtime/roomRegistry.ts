import type { WebSocket } from 'ws';
import type { RealtimeClientMeta, ServerRealtimeMessage } from './protocol.js';
import { id } from '../utils/id.js';
import { realtimePubSub } from './pubSub.js';
import { realtimePresenceStore, type PresenceUser } from './presenceStore.js';

interface ClientRecord {
  socket: WebSocket;
  meta: RealtimeClientMeta;
}

export class RealtimeRoomRegistry {
  private clients = new Map<string, ClientRecord>();
  private rooms = new Map<string, Set<string>>();
  private topics = new Map<string, Set<string>>();
  private subscribedRooms = new Set<string>();
  private subscribedTopics = new Set<string>();
  private unsubscribeByRoom = new Map<string, () => void>();
  private unsubscribeByTopic = new Map<string, () => void>();

  add(socket: WebSocket, userId: string): RealtimeClientMeta {
    const meta: RealtimeClientMeta = { id: id(), userId, connectedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
    this.clients.set(meta.id, { socket, meta });
    return meta;
  }

  remove(clientId: string): void {
    const record = this.clients.get(clientId);
    if (record?.meta.matchId) this.leave(clientId, record.meta.matchId);
    for (const topic of [...this.topics.keys()]) this.leaveTopic(clientId, topic);
    this.clients.delete(clientId);
  }

  join(clientId: string, matchId: string): void {
    const record = this.clients.get(clientId);
    if (!record) return;
    if (record.meta.matchId && record.meta.matchId !== matchId) this.leave(clientId, record.meta.matchId);
    record.meta.matchId = matchId;
    record.meta.lastSeenAt = new Date().toISOString();
    if (!this.rooms.has(matchId)) this.rooms.set(matchId, new Set());
    this.rooms.get(matchId)!.add(clientId);
    void realtimePresenceStore.join(matchId, clientId, record.meta.userId);
  }

  leave(clientId: string, matchId: string): void {
    this.rooms.get(matchId)?.delete(clientId);
    const record = this.clients.get(clientId);
    if (record && record.meta.matchId === matchId) record.meta.matchId = undefined;
    void realtimePresenceStore.leave(matchId, clientId);
    if (this.rooms.get(matchId)?.size === 0) { this.rooms.delete(matchId); this.unsubscribeMatch(matchId); }
  }

  joinTopic(clientId: string, topic: string): void {
    const record = this.clients.get(clientId);
    if (!record) return;
    record.meta.lastSeenAt = new Date().toISOString();
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic)!.add(clientId);
  }

  leaveTopic(clientId: string, topic: string): void {
    this.topics.get(topic)?.delete(clientId);
    if (this.topics.get(topic)?.size === 0) {
      this.topics.delete(topic);
      this.unsubscribeTopic(topic);
    }
  }

  touch(clientId: string): void {
    const record = this.clients.get(clientId);
    if (record) {
      record.meta.lastSeenAt = new Date().toISOString();
      if (record.meta.matchId) void realtimePresenceStore.touch(record.meta.matchId, clientId);
    }
  }

  send(clientId: string, message: Omit<ServerRealtimeMessage, 'id' | 'createdAt'> | ServerRealtimeMessage): void {
    const record = this.clients.get(clientId);
    if (!record || record.socket.readyState !== record.socket.OPEN) return;
    record.socket.send(JSON.stringify({ ...message, id: id(), createdAt: new Date().toISOString() }));
  }

  broadcast(matchId: string, message: Omit<ServerRealtimeMessage, 'id' | 'createdAt'>): void {
    const finalMessage: ServerRealtimeMessage = { ...message, id: id(), matchId, createdAt: new Date().toISOString() };
    if (this.subscribedRooms.has(matchId)) {
      void realtimePubSub.publish(`match:${matchId}`, finalMessage);
    } else {
      this.broadcastLocal(matchId, finalMessage);
    }
  }

  broadcastLocal(matchId: string, message: ServerRealtimeMessage): void {
    const room = this.rooms.get(matchId);
    if (!room) return;
    for (const clientId of room) this.send(clientId, message);
  }

  broadcastTopic(topic: string, message: Omit<ServerRealtimeMessage, 'id' | 'createdAt'>): void {
    const finalMessage: ServerRealtimeMessage = { ...message, id: id(), createdAt: new Date().toISOString() };
    if (this.subscribedTopics.has(topic)) {
      void realtimePubSub.publish(`topic:${topic}`, finalMessage);
    } else {
      this.broadcastTopicLocal(topic, finalMessage);
    }
  }

  broadcastTopicLocal(topic: string, message: ServerRealtimeMessage): void {
    const clients = this.topics.get(topic);
    if (!clients) return;
    for (const clientId of clients) this.send(clientId, message);
  }

  async subscribeMatch(matchId: string): Promise<() => void> {
    if (this.subscribedRooms.has(matchId)) {
      return () => undefined;
    }
    const unsubscribe = await realtimePubSub.subscribe(`match:${matchId}`, (message) => this.broadcastLocal(matchId, message));
    this.subscribedRooms.add(matchId);
    this.unsubscribeByRoom.set(matchId, unsubscribe);
    return () => this.unsubscribeMatch(matchId);
  }

  unsubscribeMatch(matchId: string): void {
    const unsubscribe = this.unsubscribeByRoom.get(matchId);
    if (unsubscribe) unsubscribe();
    this.unsubscribeByRoom.delete(matchId);
    this.subscribedRooms.delete(matchId);
  }

  async subscribeTopic(topic: string): Promise<() => void> {
    if (this.subscribedTopics.has(topic)) return () => undefined;
    const unsubscribe = await realtimePubSub.subscribe(`topic:${topic}`, (message) => this.broadcastTopicLocal(topic, message));
    this.subscribedTopics.add(topic);
    this.unsubscribeByTopic.set(topic, unsubscribe);
    return () => this.unsubscribeTopic(topic);
  }

  unsubscribeTopic(topic: string): void {
    const unsubscribe = this.unsubscribeByTopic.get(topic);
    if (unsubscribe) unsubscribe();
    this.unsubscribeByTopic.delete(topic);
    this.subscribedTopics.delete(topic);
  }

  async presence(matchId: string): Promise<PresenceUser[]> {
    return realtimePresenceStore.list(matchId);
  }

  cleanupStale(ttlMs = 45_000): number {
    const now = Date.now();
    let removed = 0;
    for (const [clientId, record] of this.clients.entries()) {
      if (now - new Date(record.meta.lastSeenAt).getTime() > ttlMs) {
        try { record.socket.close(); } catch {}
        this.remove(clientId);
        removed += 1;
      }
    }
    void realtimePresenceStore.cleanup(ttlMs);
    return removed;
  }

  stats() {
    return { clients: this.clients.size, rooms: this.rooms.size, topics: this.topics.size };
  }
}

export const realtimeRooms = new RealtimeRoomRegistry();
