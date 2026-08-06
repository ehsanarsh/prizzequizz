/* HEARTS — one balance, on the server, that refills with time.
 *
 * They used to live in the browser's localStorage with a recharge clock the
 * client ran itself, while `users.hearts` sat on the server as a separate
 * number nothing kept in step. So the header could show five hearts from
 * localStorage while the server was certain the account had none — which is
 * exactly what record mode hit when it refused entry to a player looking at a
 * full row of hearts.
 *
 * Regeneration is computed from a timestamp rather than ticked, so it is
 * correct across a closed app, a reboot, or several devices at once, and
 * cannot be advanced by moving the phone's clock.
 */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { logger } from './logger.js';

export interface HeartConfig {
  /** Free regeneration stops here. Purchased hearts may sit above it. */
  max: number;
  /** Minutes to earn one heart back. */
  rechargeMinutes: number;
}
export const HEART_DEFAULTS: HeartConfig = { max: 5, rechargeMinutes: 60 };

export interface HeartState {
  hearts: number;
  max: number;
  rechargeMinutes: number;
  /** Milliseconds until the next free heart; 0 when already full. */
  nextInMs: number;
  full: boolean;
}

export class HeartError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  /* The balance stays on the user record — everything else already reads it.
   * Only the regeneration anchor is new. */
  await pool.query(`CREATE TABLE IF NOT EXISTS user_hearts (
    user_id TEXT PRIMARY KEY,
    last_regen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS heart_config (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schemaReady = true;
}

let _memConfig: HeartConfig | null = null;
const _memAnchor = new Map<string, number>();

function normalise(raw: any): HeartConfig {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    max: Math.max(1, Math.min(99, Math.floor(Number(c.max ?? HEART_DEFAULTS.max) || HEART_DEFAULTS.max))),
    rechargeMinutes: Math.max(1, Math.min(1440, Math.floor(Number(c.rechargeMinutes ?? HEART_DEFAULTS.rechargeMinutes) || HEART_DEFAULTS.rechargeMinutes)))
  };
}

export async function getHeartConfig(): Promise<HeartConfig> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT data FROM heart_config WHERE id='default'`);
    return normalise(rows[0]?.data);
  }
  return normalise(_memConfig);
}

export async function saveHeartConfig(patch: any): Promise<HeartConfig> {
  const next = normalise({ ...(await getHeartConfig()), ...(patch ?? {}) });
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO heart_config(id,data,updated_at) VALUES('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else _memConfig = next;
  logger.info('heart_config_saved', next as any);
  return next;
}

async function readAnchor(userId: string): Promise<number> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT last_regen_at FROM user_hearts WHERE user_id=$1`, [userId]);
    return rows[0]?.last_regen_at ? new Date(rows[0].last_regen_at).getTime() : Date.now();
  }
  return _memAnchor.get(userId) ?? Date.now();
}
async function writeAnchor(userId: string, at: number): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO user_hearts(user_id,last_regen_at) VALUES($1,to_timestamp($2/1000.0))
       ON CONFLICT (user_id) DO UPDATE SET last_regen_at=to_timestamp($2/1000.0)`, [userId, at]);
  } else _memAnchor.set(userId, at);
}

/** Apply whatever time has earned since the anchor, then report the balance. */
export async function getHearts(userId: string): Promise<HeartState> {
  const cfg = await getHeartConfig();
  const user = await repositories.users.findById(userId);
  if (!user) throw new HeartError('USER_NOT_FOUND', 'کاربر پیدا نشد.');

  const stepMs = cfg.rechargeMinutes * 60_000;
  let hearts = Math.max(0, Number(user.hearts) || 0);
  let anchor = await readAnchor(userId);
  const now = Date.now();

  /* A clock that ran backwards (server moved, bad row) must not hand out an
   * enormous refill; re-anchor to now and carry on. */
  if (anchor > now) { anchor = now; await writeAnchor(userId, anchor); }

  if (hearts < cfg.max) {
    const earned = Math.floor((now - anchor) / stepMs);
    if (earned > 0) {
      const before = hearts;
      hearts = Math.min(cfg.max, hearts + earned);
      /* Advance by what was actually granted, not to now — the remainder of a
       * partly-elapsed hour belongs to the player. */
      anchor = hearts >= cfg.max ? now : anchor + earned * stepMs;
      await writeAnchor(userId, anchor);
      if (hearts !== before) {
        user.hearts = hearts;
        await repositories.users.save(user);
      }
    }
  } else {
    /* At or above the cap nothing accrues, so the countdown starts from the
     * moment they drop below it, not from whenever they last looked. */
    if (anchor !== now) await writeAnchor(userId, now);
    anchor = now;
  }

  const full = hearts >= cfg.max;
  return {
    hearts, max: cfg.max, rechargeMinutes: cfg.rechargeMinutes,
    nextInMs: full ? 0 : Math.max(0, stepMs - (now - anchor)),
    full
  };
}

/** Spend n hearts, regenerating first. Throws rather than going negative. */
export async function spendHearts(userId: string, n = 1): Promise<HeartState> {
  const state = await getHearts(userId);
  const need = Math.max(1, Math.floor(n));
  if (state.hearts < need) throw new HeartError('INSUFFICIENT_HEARTS', 'قلب کافی نداری.');
  const user = await repositories.users.findById(userId);
  if (!user) throw new HeartError('USER_NOT_FOUND', 'کاربر پیدا نشد.');

  const wasFull = state.hearts >= state.max;
  user.hearts = state.hearts - need;
  await repositories.users.save(user);
  /* Dropping below the cap is what starts the clock; spending while already
   * below it must not push the next heart further away. */
  if (wasFull) await writeAnchor(userId, Date.now());
  return getHearts(userId);
}

/** Grant hearts. Purchases and prizes may take the balance above the cap. */
export async function addHearts(userId: string, n: number): Promise<HeartState> {
  const amount = Math.max(0, Math.floor(n));
  if (!amount) return getHearts(userId);
  const state = await getHearts(userId);
  const user = await repositories.users.findById(userId);
  if (!user) throw new HeartError('USER_NOT_FOUND', 'کاربر پیدا نشد.');
  user.hearts = state.hearts + amount;
  await repositories.users.save(user);
  return getHearts(userId);
}

/** Test seam. */
export function _resetHeartMemory(): void { _memConfig = null; _memAnchor.clear(); }
export function _setAnchor(userId: string, at: number): void { _memAnchor.set(userId, at); }
