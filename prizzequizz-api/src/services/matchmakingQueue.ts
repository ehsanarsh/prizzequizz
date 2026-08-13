import { createClient } from 'redis';
import { createMatchForPlayers } from './matchEngine.js';
import type { GameModeId, PlanType } from '../types/domain.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { pickBotProfile } from './botProfiles.js';
import { refundHolds } from './ticketHoldService.js';

export type MatchmakingStatus = 'queued' | 'matched' | 'cancelled' | 'expired';
export type MatchQuality = 'excellent' | 'good' | 'wide' | 'bot';

export interface MatchmakingTicket {
  id: string;
  userId: string;
  modeId: GameModeId;
  economyType: PlanType;
  coinStake?: number;
  skill: number;
  status: MatchmakingStatus;
  matchId?: string;
  opponentUserId?: string;
  opponentIsBot?: boolean;
  matchQuality?: MatchQuality;
  waitMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MatchmakingStats {
  queued: number;
  matched: number;
  analytics: {
    enqueued: number;
    matched: number;
    botFallbacks: number;
    cancelled: number;
    expired: number;
  };
}

export interface MatchmakingQueue {
  enqueue(input: { userId: string; modeId: GameModeId; economyType: PlanType; coinStake?: number; skill?: number }): Promise<MatchmakingTicket>;
  get(ticketId: string): Promise<MatchmakingTicket | null>;
  cancel(ticketId: string, userId: string): Promise<MatchmakingTicket | null>;
  forceBot(ticketId: string, userId: string): Promise<MatchmakingTicket | null>;
  expireOldTickets(maxAgeMs?: number): Promise<number>;
  runBotFallbacks(maxWaitMs?: number): Promise<number>;
  stats(): Promise<MatchmakingStats>;
}

const DEFAULT_EXPIRE_MS = 60_000;
const DEFAULT_BOT_MS = 30_000;
// A queued ticket is only matchable while its owner is actively polling. The
// client polls every 2s; if we haven't heard from a ticket in this window we
// treat it as ABANDONED and never pair a live player with it (prevents the
// "ghost opponent": you get matched, but the other side already left/crashed).
const FRESH_MS = Number(process.env.MATCHMAKING_FRESH_MS ?? 9_000);
function isFresh(ticket: MatchmakingTicket): boolean {
  return Date.now() - new Date(ticket.updatedAt).getTime() <= FRESH_MS;
}

abstract class BaseMatchmakingQueue implements MatchmakingQueue {
  protected analytics = { enqueued: 0, matched: 0, botFallbacks: 0, cancelled: 0, expired: 0 };

  abstract enqueue(input: { userId: string; modeId: GameModeId; economyType: PlanType; coinStake?: number; skill?: number }): Promise<MatchmakingTicket>;
  abstract get(ticketId: string): Promise<MatchmakingTicket | null>;
  abstract cancel(ticketId: string, userId: string): Promise<MatchmakingTicket | null>;
  abstract forceBot(ticketId: string, userId: string): Promise<MatchmakingTicket | null>;
  abstract expireOldTickets(maxAgeMs?: number): Promise<number>;
  abstract runBotFallbacks(maxWaitMs?: number): Promise<number>;
  abstract stats(): Promise<MatchmakingStats>;

  protected async createBotMatch(ticket: MatchmakingTicket): Promise<MatchmakingTicket> {
    const bot = pickBotProfile(ticket.skill);
    const match = await createMatchForPlayers(ticket.userId, bot.id, ticket.modeId, ticket.economyType, ticket.coinStake, true, { username: bot.username, avatar: bot.avatar, skill: bot.skill });
    const now = new Date().toISOString();
    ticket.status = 'matched';
    ticket.matchId = match.id;
    ticket.opponentUserId = bot.id;
    ticket.opponentIsBot = true;
    ticket.matchQuality = 'bot';
    ticket.waitMs = Date.now() - new Date(ticket.createdAt).getTime();
    ticket.updatedAt = now;
    this.analytics.botFallbacks += 1;
    logger.info('matchmaking_bot_fallback', { ticketId: ticket.id, matchId: match.id, userId: ticket.userId, botId: bot.id });
    return ticket;
  }
}

export class MemoryMatchmakingQueue extends BaseMatchmakingQueue {
  private tickets = new Map<string, MatchmakingTicket>();

  async enqueue(input: { userId: string; modeId: GameModeId; economyType: PlanType; coinStake?: number; skill?: number }): Promise<MatchmakingTicket> {
    await this.expireOldTickets();
    const now = new Date().toISOString();
    const skill = input.skill ?? 1000;
    this.analytics.enqueued += 1;
    const compatible = [...this.tickets.values()].find((t) =>
      t.status === 'queued' && isFresh(t) && t.userId !== input.userId && t.modeId === input.modeId && t.economyType === input.economyType && Math.abs(t.skill - skill) <= wideningWindow(t.createdAt)
    );
    const ticket: MatchmakingTicket = { id: id(), userId: input.userId, modeId: input.modeId, economyType: input.economyType, coinStake: input.coinStake, skill, status: 'queued', createdAt: now, updatedAt: now };
    if (compatible) return this.matchTickets(ticket, compatible, skill);
    this.tickets.set(ticket.id, ticket);
    /* economyType and skill are what pairing is actually done on, so a player
       who waits forever is only explainable with them in the line: two people
       pressing «دوئل» at the same moment still never meet if they queued into
       different value buckets. */
    logger.info('matchmaking_queued', { ticketId: ticket.id, userId: input.userId, modeId: input.modeId, economyType: ticket.economyType, coinStake: ticket.coinStake, skill });
    return ticket;
  }

  async get(ticketId: string): Promise<MatchmakingTicket | null> {
    await this.expireOldTickets();
    const ticket = this.tickets.get(ticketId) ?? null;
    // A poll is a liveness heartbeat: keep this ticket "fresh" so it stays
    // matchable while its owner is still waiting.
    if (ticket && ticket.status === 'queued') ticket.updatedAt = new Date().toISOString();
    return ticket;
  }

  async cancel(ticketId: string, userId: string): Promise<MatchmakingTicket | null> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.userId !== userId || ticket.status !== 'queued') return null;
    ticket.status = 'cancelled'; ticket.updatedAt = new Date().toISOString(); this.analytics.cancelled += 1;
    return ticket;
  }

  async forceBot(ticketId: string, userId: string): Promise<MatchmakingTicket | null> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.userId !== userId || ticket.status !== 'queued') return null;
    const matched = await this.createBotMatch(ticket);
    this.tickets.set(ticket.id, matched);
    return matched;
  }

  async expireOldTickets(maxAgeMs = DEFAULT_EXPIRE_MS): Promise<number> {
    let count = 0; const now = Date.now();
    for (const ticket of this.tickets.values()) {
      if (ticket.status === 'queued' && now - new Date(ticket.createdAt).getTime() > maxAgeMs) {
        ticket.status = 'expired'; ticket.updatedAt = new Date().toISOString(); count += 1; this.analytics.expired += 1;
        /* Nobody turned up. The entry ticket was never spent on a game, so it
         * goes back — this used to depend entirely on the player's own client
         * still being open to send a cancel. */
        await refundHolds('queue', ticket.id, 'search_expired');
      }
    }
    return count;
  }

  async runBotFallbacks(maxWaitMs = DEFAULT_BOT_MS): Promise<number> {
    let count = 0; const now = Date.now();
    for (const ticket of this.tickets.values()) {
      if (ticket.status === 'queued' && now - new Date(ticket.createdAt).getTime() > maxWaitMs) {
        await this.forceBot(ticket.id, ticket.userId); count += 1;
      }
    }
    return count;
  }

  async stats(): Promise<MatchmakingStats> {
    await this.expireOldTickets();
    const all = [...this.tickets.values()];
    return { queued: all.filter((t) => t.status === 'queued').length, matched: all.filter((t) => t.status === 'matched').length, analytics: { ...this.analytics } };
  }

  private async matchTickets(ticket: MatchmakingTicket, compatible: MatchmakingTicket, skill: number): Promise<MatchmakingTicket> {
    const match = await createMatchForPlayers(ticket.userId, compatible.userId, ticket.modeId, ticket.economyType, ticket.coinStake ?? compatible.coinStake);
    const now = new Date().toISOString(); const quality = qualityFor(Math.abs(compatible.skill - skill));
    compatible.status = 'matched'; compatible.matchId = match.id; compatible.opponentUserId = ticket.userId; compatible.matchQuality = quality; compatible.waitMs = Date.now() - new Date(compatible.createdAt).getTime(); compatible.updatedAt = now;
    ticket.status = 'matched'; ticket.matchId = match.id; ticket.opponentUserId = compatible.userId; ticket.matchQuality = quality; ticket.waitMs = Date.now() - new Date(ticket.createdAt).getTime(); ticket.updatedAt = now;
    this.analytics.matched += 1;
    this.tickets.set(compatible.id, compatible); this.tickets.set(ticket.id, ticket);
    logger.info('matchmaking_matched', { matchId: match.id, users: [ticket.userId, compatible.userId], quality });
    return ticket;
  }
}

export class RedisMatchmakingQueue extends BaseMatchmakingQueue {
  private client: ReturnType<typeof createClient> | null = null;
  constructor(private readonly url = process.env.REDIS_URL ?? 'redis://localhost:6379') { super(); }

  async enqueue(input: { userId: string; modeId: GameModeId; economyType: PlanType; coinStake?: number; skill?: number }): Promise<MatchmakingTicket> {
    await this.expireOldTickets();
    const client = await this.getClient(); const now = new Date().toISOString(); const skill = input.skill ?? 1000;
    this.analytics.enqueued += 1;
    const queueKey = this.queueKey(input.modeId, input.economyType);
    const ids = await client.zRangeByScore(queueKey, skill - 1000, skill + 1000);
    for (const candidateId of ids) {
      const candidate = await this.getRaw(candidateId);
      if (!candidate || candidate.status !== 'queued' || candidate.userId === input.userId) continue;
      if (!isFresh(candidate)) { await client.zRem(queueKey, candidate.id); continue; }
      if (Math.abs(candidate.skill - skill) > wideningWindow(candidate.createdAt)) continue;
      await client.zRem(queueKey, candidate.id);
      const ticket: MatchmakingTicket = { id: id(), userId: input.userId, modeId: input.modeId, economyType: input.economyType, coinStake: input.coinStake, skill, status: 'queued', createdAt: now, updatedAt: now };
      return this.matchTickets(ticket, candidate, skill);
    }
    const ticket: MatchmakingTicket = { id: id(), userId: input.userId, modeId: input.modeId, economyType: input.economyType, coinStake: input.coinStake, skill, status: 'queued', createdAt: now, updatedAt: now };
    await this.saveTicket(ticket); await client.zAdd(queueKey, { score: skill, value: ticket.id });
    logger.info('redis_matchmaking_queued', { ticketId: ticket.id, userId: ticket.userId, modeId: ticket.modeId, economyType: ticket.economyType, coinStake: ticket.coinStake, skill });
    return ticket;
  }

  async get(ticketId: string): Promise<MatchmakingTicket | null> {
    await this.expireOldTickets();
    const ticket = await this.getRaw(ticketId);
    // A poll is a liveness heartbeat — refresh so the ticket stays matchable
    // while its owner is still waiting (see FRESH_MS / the ghost-opponent fix).
    if (ticket && ticket.status === 'queued') { ticket.updatedAt = new Date().toISOString(); await this.saveTicket(ticket); }
    return ticket;
  }

  private async getRaw(ticketId: string): Promise<MatchmakingTicket | null> {
    const raw = await (await this.getClient()).get(this.ticketKey(ticketId));
    return raw ? JSON.parse(raw) as MatchmakingTicket : null;
  }

  async cancel(ticketId: string, userId: string): Promise<MatchmakingTicket | null> {
    const ticket = await this.get(ticketId);
    if (!ticket || ticket.userId !== userId || ticket.status !== 'queued') return null;
    ticket.status = 'cancelled'; ticket.updatedAt = new Date().toISOString(); this.analytics.cancelled += 1;
    await this.removeFromQueue(ticket); await this.saveTicket(ticket); return ticket;
  }

  async forceBot(ticketId: string, userId: string): Promise<MatchmakingTicket | null> {
    const ticket = await this.get(ticketId);
    if (!ticket || ticket.userId !== userId || ticket.status !== 'queued') return null;
    const matched = await this.createBotMatch(ticket); await this.removeFromQueue(matched); await this.saveTicket(matched); return matched;
  }

  async expireOldTickets(maxAgeMs = DEFAULT_EXPIRE_MS): Promise<number> {
    const client = await this.getClient(); const keys = await client.keys('mm:ticket:*'); let count = 0; const now = Date.now();
    for (const key of keys) { const raw = await client.get(key); if (!raw) continue; const ticket = JSON.parse(raw) as MatchmakingTicket; if (ticket.status === 'queued' && now - new Date(ticket.createdAt).getTime() > maxAgeMs) { ticket.status = 'expired'; ticket.updatedAt = new Date().toISOString(); await this.removeFromQueue(ticket); await this.saveTicket(ticket); count++; this.analytics.expired++; await refundHolds('queue', ticket.id, 'search_expired'); } }
    return count;
  }

  async runBotFallbacks(maxWaitMs = DEFAULT_BOT_MS): Promise<number> {
    const client = await this.getClient(); const keys = await client.keys('mm:ticket:*'); let count = 0; const now = Date.now();
    for (const key of keys) { const raw = await client.get(key); if (!raw) continue; const ticket = JSON.parse(raw) as MatchmakingTicket; if (ticket.status === 'queued' && now - new Date(ticket.createdAt).getTime() > maxWaitMs) { await this.forceBot(ticket.id, ticket.userId); count++; } }
    return count;
  }

  async stats(): Promise<MatchmakingStats> {
    await this.expireOldTickets(); const client = await this.getClient(); const keys = await client.keys('mm:ticket:*'); let queued=0,matched=0;
    for (const key of keys) { const raw = await client.get(key); if (!raw) continue; const t = JSON.parse(raw) as MatchmakingTicket; if (t.status==='queued') queued++; if (t.status==='matched') matched++; }
    return { queued, matched, analytics: { ...this.analytics } };
  }

  private async matchTickets(ticket: MatchmakingTicket, compatible: MatchmakingTicket, skill: number): Promise<MatchmakingTicket> {
    const match = await createMatchForPlayers(ticket.userId, compatible.userId, ticket.modeId, ticket.economyType, ticket.coinStake ?? compatible.coinStake);
    const now = new Date().toISOString(); const quality = qualityFor(Math.abs(compatible.skill - skill));
    compatible.status='matched'; compatible.matchId=match.id; compatible.opponentUserId=ticket.userId; compatible.matchQuality=quality; compatible.waitMs=Date.now()-new Date(compatible.createdAt).getTime(); compatible.updatedAt=now;
    ticket.status='matched'; ticket.matchId=match.id; ticket.opponentUserId=compatible.userId; ticket.matchQuality=quality; ticket.waitMs=Date.now()-new Date(ticket.createdAt).getTime(); ticket.updatedAt=now;
    this.analytics.matched++;
    await this.saveTicket(compatible); await this.saveTicket(ticket); logger.info('redis_matchmaking_matched', { matchId: match.id, quality }); return ticket;
  }

  private async saveTicket(ticket: MatchmakingTicket): Promise<void> { await (await this.getClient()).set(this.ticketKey(ticket.id), JSON.stringify(ticket), { EX: 3600 }); }
  private async removeFromQueue(ticket: MatchmakingTicket): Promise<void> { await (await this.getClient()).zRem(this.queueKey(ticket.modeId, ticket.economyType), ticket.id); }
  private queueKey(modeId: GameModeId, economyType: PlanType): string { return `mm:q:${modeId}:${economyType}`; }
  private ticketKey(ticketId: string): string { return `mm:ticket:${ticketId}`; }
  private async getClient(): Promise<ReturnType<typeof createClient>> { if (!this.client) { this.client=createClient({url:this.url}); this.client.on('error',(e)=>logger.error('redis_matchmaking_error',{message:e.message})); await this.client.connect(); logger.info('redis_matchmaking_connected'); } return this.client; }
}

function qualityFor(delta: number): MatchQuality { if (delta <= 120) return 'excellent'; if (delta <= 360) return 'good'; return 'wide'; }
function wideningWindow(createdAt: string): number { const seconds = (Date.now() - new Date(createdAt).getTime()) / 1000; if (seconds > 20) return 800; if (seconds > 10) return 400; return 180; }

export const matchmakingQueue: MatchmakingQueue = process.env.REDIS_URL && process.env.MATCHMAKING_ADAPTER === 'redis'
  ? new RedisMatchmakingQueue()
  : new MemoryMatchmakingQueue();
