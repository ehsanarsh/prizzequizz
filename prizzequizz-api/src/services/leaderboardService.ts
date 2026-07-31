import { createClient } from 'redis';
import { repositories } from '../repositories/index.js';
import type { Reward, User } from '../types/domain.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { realtimePubSub } from '../realtime/pubSub.js';
import { avatarUrlsFor } from './avatarService.js';

export type LeaderboardKind = 'weekly' | 'overall' | 'winnings';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  level: number;
  score: number;
  metric: LeaderboardKind;
  highlighted?: boolean;
}

export interface LeaderboardResponse {
  kind: LeaderboardKind;
  title: string;
  metricLabel: string;
  generatedAt: string;
  entries: LeaderboardEntry[];
}

interface RawScoreRow {
  userId: string;
  score: number;
}

interface LeaderboardDiagnostics {
  adapter: 'memory' | 'redis';
  redisUrl?: string;
  boardSizes: Record<LeaderboardKind, number>;
  lastUpdatedAt?: string;
}

interface LeaderboardAdapter {
  readonly name: 'memory' | 'redis';
  top(kind: LeaderboardKind, limit: number): Promise<RawScoreRow[]>;
  setScore(kind: LeaderboardKind, userId: string, score: number): Promise<void>;
  increment(kind: LeaderboardKind, userId: string, amount: number): Promise<number>;
  diagnostics(): Promise<LeaderboardDiagnostics>;
}

class MemoryLeaderboardAdapter implements LeaderboardAdapter {
  readonly name = 'memory' as const;
  private boards: Record<LeaderboardKind, Map<string, number>> = {
    weekly: new Map(),
    overall: new Map(),
    winnings: new Map()
  };
  private lastUpdatedAt?: string;

  async top(kind: LeaderboardKind, limit: number): Promise<RawScoreRow[]> {
    return [...this.boards[kind].entries()]
      .map(([userId, score]) => ({ userId, score }))
      .sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId))
      .slice(0, limit);
  }

  async setScore(kind: LeaderboardKind, userId: string, score: number): Promise<void> {
    this.boards[kind].set(userId, score);
    this.lastUpdatedAt = new Date().toISOString();
  }

  async increment(kind: LeaderboardKind, userId: string, amount: number): Promise<number> {
    const next = (this.boards[kind].get(userId) ?? 0) + amount;
    this.boards[kind].set(userId, next);
    this.lastUpdatedAt = new Date().toISOString();
    return next;
  }

  async diagnostics(): Promise<LeaderboardDiagnostics> {
    return {
      adapter: this.name,
      boardSizes: {
        weekly: this.boards.weekly.size,
        overall: this.boards.overall.size,
        winnings: this.boards.winnings.size
      },
      lastUpdatedAt: this.lastUpdatedAt
    };
  }
}

class RedisLeaderboardAdapter implements LeaderboardAdapter {
  readonly name = 'redis' as const;
  private client: ReturnType<typeof createClient> | null = null;
  private lastUpdatedAt?: string;

  constructor(private readonly url = process.env.REDIS_URL ?? 'redis://localhost:6379') {}

  async top(kind: LeaderboardKind, limit: number): Promise<RawScoreRow[]> {
    const client = await this.getClient();
    const raw = await client.sendCommand(['ZREVRANGE', this.key(kind), '0', String(Math.max(0, limit - 1)), 'WITHSCORES']);
    const rows: any[] = Array.isArray(raw) ? raw : [];
    const result: RawScoreRow[] = [];
    // Handle BOTH shapes: RESP2 flat [member, score, member, score, …] and RESP3
    // tuples [[member, score], …]. The old code assumed only the flat form, so
    // under RESP3 it stringified the whole [id, score] pair into the userId
    // (e.g. "a08b29…,191") — an invalid UUID that crashed the enrich lookup.
    if (rows.length && Array.isArray(rows[0])) {
      for (const pair of rows) {
        result.push({ userId: String((pair as any[])[0]), score: Number((pair as any[])[1] ?? 0) });
      }
    } else {
      for (let i = 0; i < rows.length; i += 2) {
        result.push({ userId: String(rows[i]), score: Number(rows[i + 1] ?? 0) });
      }
    }
    return result;
  }

  async setScore(kind: LeaderboardKind, userId: string, score: number): Promise<void> {
    const client = await this.getClient();
    await client.sendCommand(['ZADD', this.key(kind), String(score), userId]);
    this.lastUpdatedAt = new Date().toISOString();
  }

  async increment(kind: LeaderboardKind, userId: string, amount: number): Promise<number> {
    const client = await this.getClient();
    const next = await client.sendCommand(['ZINCRBY', this.key(kind), String(amount), userId]);
    this.lastUpdatedAt = new Date().toISOString();
    return Number(next);
  }

  async diagnostics(): Promise<LeaderboardDiagnostics> {
    const client = await this.getClient();
    const [weekly, overall, winnings] = await Promise.all([
      client.sendCommand(['ZCARD', this.key('weekly')]),
      client.sendCommand(['ZCARD', this.key('overall')]),
      client.sendCommand(['ZCARD', this.key('winnings')])
    ]);
    return {
      adapter: this.name,
      redisUrl: this.redactedUrl(),
      boardSizes: { weekly: Number(weekly), overall: Number(overall), winnings: Number(winnings) },
      lastUpdatedAt: this.lastUpdatedAt
    };
  }

  private key(kind: LeaderboardKind): string {
    return `prizzequizz:leaderboard:${kind}`;
  }

  private async getClient(): Promise<ReturnType<typeof createClient>> {
    if (!this.client) {
      this.client = createClient({ url: this.url });
      this.client.on('error', (error) => logger.error('redis_leaderboard_error', { message: error.message }));
      await this.client.connect();
      logger.info('redis_leaderboard_connected', { url: this.redactedUrl() });
    }
    return this.client;
  }

  private redactedUrl(): string {
    try {
      const u = new URL(this.url);
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return 'redis-url';
    }
  }
}

export class LeaderboardService {
  constructor(private readonly adapter: LeaderboardAdapter) {}

  async get(kind: LeaderboardKind, limit = 50, viewerUserId?: string): Promise<LeaderboardResponse> {
    const safeLimit = clampLimit(limit);
    // weekly (🏆cup) and overall (XP) are read STRAIGHT from the users table so the
    // board always reflects the real, current scores — the in-memory/redis adapter
    // is only a cache and could be stale/empty (which showed an empty leaderboard
    // even though users had real xp/cup). 'winnings' still uses the adapter/txns.
    let rows: RawScoreRow[];
    if (kind === 'winnings') {
      rows = await this.safeAdapterTop(kind, safeLimit);
      if (!rows.length) rows = await this.deriveRows(kind, safeLimit);
    } else {
      rows = await this.deriveRows(kind, safeLimit);
    }
    const entries = await this.enrich(kind, rows, viewerUserId);
    return {
      kind,
      title: titleFor(kind),
      metricLabel: metricLabelFor(kind),
      generatedAt: new Date().toISOString(),
      entries
    };
  }

  async updateUser(user: User): Promise<void> {
    if (user.id.startsWith('bot_')) return;
    await Promise.all([
      this.safeSetScore('weekly', user.id, Number(user.weeklyScore ?? 0)),
      this.safeSetScore('overall', user.id, Number(user.xp ?? 0))
    ]);
    await Promise.all([this.publish('weekly'), this.publish('overall')]);
  }

  async recordReward(user: User, reward: Reward): Promise<void> {
    if (user.id.startsWith('bot_')) return;
    if (reward.amount <= 0 || !['cash', 'coins'].includes(reward.type)) return;
    await this.safeIncrement('winnings', user.id, reward.amount);
    await this.publish('winnings');
  }

  async diagnostics(): Promise<LeaderboardDiagnostics & { fallbackAvailable: boolean }> {
    try {
      return { ...(await this.adapter.diagnostics()), fallbackAvailable: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'diagnostics failed';
      logger.warn('leaderboard_diagnostics_failed', { message });
      return { adapter: this.adapter.name, boardSizes: { weekly: 0, overall: 0, winnings: 0 }, fallbackAvailable: true };
    }
  }

  private async publish(kind: LeaderboardKind): Promise<void> {
    try {
      const leaderboard = await this.get(kind, 20);
      await realtimePubSub.publish(`topic:leaderboard:${kind}`, {
        id: id(),
        type: 'server:leaderboard_update',
        payload: { kind, leaderboard },
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'publish failed';
      logger.warn('leaderboard_publish_failed', { kind, message });
    }
  }

  private async safeAdapterTop(kind: LeaderboardKind, limit: number): Promise<RawScoreRow[]> {
    try {
      return await this.adapter.top(kind, limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'leaderboard adapter top failed';
      logger.warn('leaderboard_adapter_top_failed', { kind, message });
      return [];
    }
  }

  private async safeSetScore(kind: LeaderboardKind, userId: string, score: number): Promise<void> {
    try { await this.adapter.setScore(kind, userId, score); }
    catch (error) { logger.warn('leaderboard_set_failed', { kind, userId, message: error instanceof Error ? error.message : 'failed' }); }
  }

  private async safeIncrement(kind: LeaderboardKind, userId: string, amount: number): Promise<void> {
    try { await this.adapter.increment(kind, userId, amount); }
    catch (error) { logger.warn('leaderboard_increment_failed', { kind, userId, message: error instanceof Error ? error.message : 'failed' }); }
  }

  private async deriveRows(kind: LeaderboardKind, limit: number): Promise<RawScoreRow[]> {
    if (kind === 'winnings') return repositories.transactions.listWinnings(limit);
    const users = await repositories.users.list(1000);
    return users
      .filter((user) => !user.id.startsWith('bot_'))
      .map((user) => ({ userId: user.id, score: kind === 'weekly' ? Number(user.weeklyScore ?? 0) : Number(user.xp ?? 0) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId))
      .slice(0, limit);
  }

  private async enrich(kind: LeaderboardKind, rows: RawScoreRow[], viewerUserId?: string): Promise<LeaderboardEntry[]> {
    const entries: LeaderboardEntry[] = [];
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // One batched lookup so a 50-row board costs a single avatar query.
    const photos = await avatarUrlsFor(rows.map((r) => String(r.userId)).filter((u) => UUID_RE.test(u)));
    for (const row of rows) {
      const uid = String(row.userId);
      if (!UUID_RE.test(uid)) continue; // defensively skip any corrupt id — never 500 the board
      let user = null;
      try { user = await repositories.users.findById(uid); } catch { user = null; }
      const rank = entries.length + 1;
      entries.push({
        rank,
        userId: uid,
        username: user?.username ?? uid,
        displayName: user?.displayName ?? user?.username ?? uid,
        avatar: photos.get(uid) ?? avatarFor(rank - 1, uid),
        level: user?.level ?? 1,
        score: Math.round(Number(row.score ?? 0)),
        metric: kind,
        highlighted: viewerUserId === uid
      });
    }
    return entries;
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function titleFor(kind: LeaderboardKind): string {
  if (kind === 'weekly') return 'Weekly XP League';
  if (kind === 'overall') return 'Overall XP';
  return 'Highest Winnings';
}

function metricLabelFor(kind: LeaderboardKind): string {
  if (kind === 'weekly') return 'weeklyScore';
  if (kind === 'overall') return 'xp';
  return 'winnings';
}

function avatarFor(index: number, userId: string): string {
  const avatars = ['🦁', '🦊', '🐼', '🐯', '👾', '🐙', '🦄', '🐲'];
  let hash = index;
  for (const ch of userId) hash += ch.charCodeAt(0);
  return avatars[Math.abs(hash) % avatars.length]!;
}

const adapter: LeaderboardAdapter = process.env.LEADERBOARD_ADAPTER === 'redis' && process.env.REDIS_URL
  ? new RedisLeaderboardAdapter()
  : new MemoryLeaderboardAdapter();

export const leaderboards = new LeaderboardService(adapter);
