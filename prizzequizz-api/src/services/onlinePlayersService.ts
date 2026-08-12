/* WHO ELSE IS PLAYING RIGHT NOW.
 *
 * The home screen's «افراد آنلاین» shows ten people. Two things about it are
 * easy to get quietly wrong, and both cost the player something real:
 *
 *   — the refresh costs coins. Charging must happen exactly once per refresh,
 *     and NEVER when the refresh could not be served. A player who pays five
 *     coins for an error message has been robbed by a bug.
 *
 *   — "mostly the opposite gender" is a PREFERENCE, not a filter. Filtering
 *     would leave a player staring at two faces on a quiet evening, and would
 *     show nothing at all to anyone who never answered the question. So the
 *     opposite side goes first and the rest fills the list.
 *
 * The first look is free. Only asking for a NEW set of faces costs anything —
 * otherwise opening the home screen would drain coins by itself.
 */
import { repositories } from '../repositories/index.js';
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';
import { onlineUserIds, lastSeenFor } from './presenceService.js';
import { avatarUrlFor } from './avatarService.js';
import type { Gender, User } from '../types/domain.js';
import { randomInt } from 'node:crypto';

export class OnlinePlayersError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'OnlinePlayersError'; }
}

export interface OnlineConfig {
  /** How many faces the list shows. */
  size: number;
  /** Coins taken for each refresh after the free one. */
  refreshCost: number;
  /** How many refreshes are free each day, over and above the first load. */
  freeRefreshesPerDay: number;
}
export const ONLINE_DEFAULTS: OnlineConfig = { size: 10, refreshCost: 5, freeRefreshesPerDay: 1 };

const CFG_KEY = 'online_players';
let memCfg: Partial<OnlineConfig> | null = null;

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

export async function getOnlineConfig(): Promise<OnlineConfig> {
  let raw: Partial<OnlineConfig> = memCfg ?? {};
  const pool = pg();
  if (pool) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS app_config (key VARCHAR(64) PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT now(), updated_by VARCHAR(64))`);
      const { rows } = await pool.query(`SELECT value FROM app_config WHERE key=$1`, [CFG_KEY]);
      raw = (rows[0]?.value as Partial<OnlineConfig>) ?? {};
    } catch (e) { logger.warn('online_config_read_failed', { message: (e as Error).message }); }
  }
  return {
    size: Math.max(1, Math.min(50, Number(raw.size) || ONLINE_DEFAULTS.size)),
    refreshCost: Math.max(0, Math.min(1000, Number(raw.refreshCost ?? ONLINE_DEFAULTS.refreshCost))),
    freeRefreshesPerDay: Math.max(0, Math.min(100, Number(raw.freeRefreshesPerDay ?? ONLINE_DEFAULTS.freeRefreshesPerDay)))
  };
}
export async function setOnlineConfig(patch: Partial<OnlineConfig>): Promise<OnlineConfig> {
  const cur = await getOnlineConfig();
  const next: OnlineConfig = {
    size: patch.size != null ? Math.max(1, Math.min(50, Number(patch.size) || cur.size)) : cur.size,
    refreshCost: patch.refreshCost != null ? Math.max(0, Math.min(1000, Number(patch.refreshCost))) : cur.refreshCost,
    freeRefreshesPerDay: patch.freeRefreshesPerDay != null ? Math.max(0, Math.min(100, Number(patch.freeRefreshesPerDay))) : cur.freeRefreshesPerDay
  };
  memCfg = next;
  const pool = pg();
  if (pool) {
    try {
      await pool.query(`INSERT INTO app_config(key,value,updated_at) VALUES ($1,$2,now())
                        ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`, [CFG_KEY, JSON.stringify(next)]);
    } catch (e) { logger.warn('online_config_write_failed', { message: (e as Error).message }); }
  }
  return getOnlineConfig();
}

/* ── the free-refresh counter ──────────────────────────────────────────── */

/* Per day, per player, in memory. Losing it on a restart gives the player a
 * free refresh, never a wrongful charge — the only direction this is allowed
 * to be wrong in. */
const freeUsed = new Map<string, { day: string; n: number }>();
function today(): string { return new Date().toISOString().slice(0, 10); }
function freeLeft(userId: string, perDay: number): number {
  const r = freeUsed.get(userId);
  if (!r || r.day !== today()) return perDay;
  return Math.max(0, perDay - r.n);
}
function useFree(userId: string): void {
  const r = freeUsed.get(userId);
  if (!r || r.day !== today()) freeUsed.set(userId, { day: today(), n: 1 });
  else r.n += 1;
}

/** Test seam. */
export function _resetOnlinePlayers(): void { freeUsed.clear(); memCfg = null; }

/* ── the list ──────────────────────────────────────────────────────────── */

export interface OnlinePlayer {
  userId: string;
  username: string;
  displayName: string;
  gender: Gender | null;
  level: number;
  avatar: string | null;
  lastSeen: string;
}
export interface OnlineResult {
  players: OnlinePlayer[];
  charged: number;
  coins: number;
  /** Coins the NEXT refresh will cost — so the button can say so before it is pressed. */
  nextCost: number;
  freeLeft: number;
  onlineTotal: number;
}

function shuffle<T>(a: T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The opposite side first, then everybody else — never only one side. */
export function orderByPreference(candidates: User[], viewer: User): User[] {
  const mine = viewer.gender;
  const opposite: Gender | null = mine === 'male' ? 'female' : mine === 'female' ? 'male' : null;
  if (!opposite) return shuffle(candidates);
  const wanted = shuffle(candidates.filter((u) => u.gender === opposite));
  const rest = shuffle(candidates.filter((u) => u.gender !== opposite));
  return [...wanted, ...rest];
}

/**
 * The ten faces. `refresh` is what the player pressed the button for; the first
 * load of the screen passes false and is always free.
 */
export async function listOnlinePlayers(userId: string, refresh = false): Promise<OnlineResult> {
  const viewer = await repositories.users.findById(userId);
  if (!viewer) throw new OnlinePlayersError('USER_NOT_FOUND', 'کاربر پیدا نشد.');
  const cfg = await getOnlineConfig();

  /* Build the list BEFORE taking any coins. If anything here fails the player
   * has not paid for it. */
  const ids = (await onlineUserIds(300)).filter((id) => String(id) !== String(userId));
  const onlineTotal = ids.length;
  const loaded = await Promise.all(ids.slice(0, 120).map((id) => repositories.users.findById(id).catch(() => null)));
  const candidates = loaded.filter((u): u is User => !!u && u.status !== 'banned');
  const chosen = orderByPreference(candidates, viewer).slice(0, cfg.size);
  const seen = await lastSeenFor(chosen.map((u) => u.id));
  const players: OnlinePlayer[] = await Promise.all(chosen.map(async (u) => ({
    userId: u.id,
    username: u.username,
    displayName: u.displayName || u.username,
    gender: u.gender ?? null,
    level: Number(u.level) || 1,
    avatar: await avatarUrlFor(u.id).catch(() => null),
    lastSeen: (seen.get(u.id) ?? new Date()).toISOString()
  })));

  let charged = 0;
  if (refresh) {
    const free = freeLeft(userId, cfg.freeRefreshesPerDay);
    if (free > 0) {
      useFree(userId);
    } else if (cfg.refreshCost > 0) {
      if ((Number(viewer.coins) || 0) < cfg.refreshCost) {
        throw new OnlinePlayersError('INSUFFICIENT_COINS',
          'برای رفرش ' + cfg.refreshCost + ' سکه لازم است.');
      }
      viewer.coins = (Number(viewer.coins) || 0) - cfg.refreshCost;
      await repositories.users.save(viewer);
      charged = cfg.refreshCost;
    }
  }

  const left = freeLeft(userId, cfg.freeRefreshesPerDay);
  return {
    players,
    charged,
    coins: Number(viewer.coins) || 0,
    nextCost: left > 0 ? 0 : cfg.refreshCost,
    freeLeft: left,
    onlineTotal
  };
}
