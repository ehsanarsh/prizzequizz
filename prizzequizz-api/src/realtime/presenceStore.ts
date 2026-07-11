import { createClient } from 'redis';
import { logger } from '../services/logger.js';

export interface PresenceUser {
  userId: string;
  lastSeenAt: string;
}

export interface RealtimePresenceStore {
  join(matchId: string, clientId: string, userId: string): Promise<void>;
  leave(matchId: string, clientId: string): Promise<void>;
  touch(matchId: string, clientId: string): Promise<void>;
  list(matchId: string): Promise<PresenceUser[]>;
  cleanup(ttlMs?: number): Promise<number>;
}

interface PresenceRecord extends PresenceUser {
  clientId: string;
  matchId: string;
  updatedAt: number;
}

export class MemoryRealtimePresenceStore implements RealtimePresenceStore {
  private records = new Map<string, PresenceRecord>();

  async join(matchId: string, clientId: string, userId: string): Promise<void> {
    const now = Date.now();
    this.records.set(clientId, { clientId, matchId, userId, updatedAt: now, lastSeenAt: new Date(now).toISOString() });
  }

  async leave(matchId: string, clientId: string): Promise<void> {
    this.records.delete(clientId);
  }

  async touch(matchId: string, clientId: string): Promise<void> {
    const record = this.records.get(clientId);
    if (!record) return;
    const now = Date.now();
    record.updatedAt = now;
    record.lastSeenAt = new Date(now).toISOString();
  }

  async list(matchId: string): Promise<PresenceUser[]> {
    await this.cleanup();
    return [...this.records.values()].filter((r) => r.matchId === matchId).map(({ userId, lastSeenAt }) => ({ userId, lastSeenAt }));
  }

  async cleanup(ttlMs = 45_000): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [clientId, record] of this.records.entries()) {
      if (now - record.updatedAt > ttlMs) {
        this.records.delete(clientId);
        removed += 1;
      }
    }
    return removed;
  }
}

export class RedisRealtimePresenceStore implements RealtimePresenceStore {
  private client: ReturnType<typeof createClient> | null = null;
  private ttlSeconds = Number(process.env.REALTIME_PRESENCE_TTL_SECONDS ?? 45);

  constructor(private readonly url = process.env.REDIS_URL ?? 'redis://localhost:6379') {}

  async join(matchId: string, clientId: string, userId: string): Promise<void> {
    const client = await this.getClient();
    const key = this.clientKey(matchId, clientId);
    const now = new Date().toISOString();
    await client.multi()
      .sAdd(this.roomKey(matchId), clientId)
      .set(key, JSON.stringify({ userId, lastSeenAt: now }), { EX: this.ttlSeconds })
      .expire(this.roomKey(matchId), this.ttlSeconds + 10)
      .exec();
  }

  async leave(matchId: string, clientId: string): Promise<void> {
    const client = await this.getClient();
    await client.multi().sRem(this.roomKey(matchId), clientId).del(this.clientKey(matchId, clientId)).exec();
  }

  async touch(matchId: string, clientId: string): Promise<void> {
    const client = await this.getClient();
    const key = this.clientKey(matchId, clientId);
    const raw = await client.get(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as PresenceUser;
    parsed.lastSeenAt = new Date().toISOString();
    await client.set(key, JSON.stringify(parsed), { EX: this.ttlSeconds });
  }

  async list(matchId: string): Promise<PresenceUser[]> {
    const client = await this.getClient();
    const ids = await client.sMembers(this.roomKey(matchId));
    if (!ids.length) return [];
    const keys = ids.map((clientId) => this.clientKey(matchId, clientId));
    const values = await client.mGet(keys);
    const stale: string[] = [];
    const users: PresenceUser[] = [];
    values.forEach((raw, index) => {
      if (!raw) { stale.push(ids[index]!); return; }
      try { users.push(JSON.parse(raw) as PresenceUser); }
      catch { stale.push(ids[index]!); }
    });
    if (stale.length) await client.sRem(this.roomKey(matchId), stale);
    return users;
  }

  async cleanup(): Promise<number> {
    // Redis key expiration performs cleanup. list() opportunistically removes stale ids.
    return 0;
  }

  private async getClient(): Promise<ReturnType<typeof createClient>> {
    if (!this.client) {
      this.client = createClient({ url: this.url });
      this.client.on('error', (error) => logger.error('redis_presence_error', { message: error.message }));
      await this.client.connect();
      logger.info('redis_presence_connected', { url: this.redactedUrl() });
    }
    return this.client;
  }

  private roomKey(matchId: string): string { return `presence:match:${matchId}:clients`; }
  private clientKey(matchId: string, clientId: string): string { return `presence:match:${matchId}:client:${clientId}`; }
  private redactedUrl(): string { try { const u = new URL(this.url); if (u.password) u.password = '***'; return u.toString(); } catch { return 'redis-url'; } }
}

export const realtimePresenceStore: RealtimePresenceStore = process.env.REDIS_URL && process.env.REALTIME_ADAPTER === 'redis'
  ? new RedisRealtimePresenceStore()
  : new MemoryRealtimePresenceStore();
