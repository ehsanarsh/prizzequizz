import type { Match } from '../types/domain.js';

export interface MatchStateStore {
  get(matchId: string): Promise<Match | null>;
  set(match: Match, ttlSeconds?: number): Promise<void>;
  delete(matchId: string): Promise<void>;
}

export class MemoryMatchStateStore implements MatchStateStore {
  private store = new Map<string, { match: Match; expiresAt?: number }>();

  async get(matchId: string): Promise<Match | null> {
    const row = this.store.get(matchId);
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < Date.now()) {
      this.store.delete(matchId);
      return null;
    }
    return row.match;
  }

  async set(match: Match, ttlSeconds?: number): Promise<void> {
    this.store.set(match.id, { match, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined });
  }

  async delete(matchId: string): Promise<void> {
    this.store.delete(matchId);
  }
}

export const activeMatchState = new MemoryMatchStateStore();
