import { gameConfig } from '../core/config.js';
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Persistence: admin edits are saved to app_config so they survive restarts.
// ---------------------------------------------------------------------------
let _cfgSchemaReady = false;
async function ensureConfigSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_cfgSchemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS app_config (key VARCHAR(64) PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT now(), updated_by VARCHAR(64))`);
  _cfgSchemaReady = true;
}

/* Load the saved game_config override at boot and merge it over the on-disk
 * defaults (so a config written by an older version still gets any new default
 * keys). No DB / no saved row → keep the on-disk config. */
export async function loadPersistedConfig(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const pool = getPgPool();
    await ensureConfigSchema(pool);
    const { rows } = await pool.query(`SELECT value FROM app_config WHERE key='game_config'`);
    if (rows[0]?.value) {
      const saved = rows[0].value;
      // defaults first, saved on top → new default keys survive, edits win.
      const merged = deepMerge(structuredClone(gameConfig), saved);
      for (const key of Object.keys(gameConfig)) delete (gameConfig as any)[key];
      Object.assign(gameConfig, merged);
      logger.info('game_config_loaded_from_db', { version: gameConfig.version });
    }
  } catch (e) {
    logger.warn('game_config_load_failed', { message: e instanceof Error ? e.message : 'unknown' });
  }
}

async function persistConfig(updatedBy?: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const pool = getPgPool();
    await ensureConfigSchema(pool);
    await pool.query(
      `INSERT INTO app_config(key,value,updated_by,updated_at) VALUES ('game_config',$1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`,
      [JSON.stringify(gameConfig), updatedBy ?? null]);
  } catch (e) {
    logger.warn('game_config_persist_failed', { message: e instanceof Error ? e.message : 'unknown' });
  }
}

function deepMerge(base: any, over: any): any {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export function getEditableGameConfig(): any {
  return structuredClone(gameConfig);
}

export function validateGameConfig(input: any): ConfigValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') errors.push('Config must be an object.');
  if (!input.version || typeof input.version !== 'string') errors.push('Config version is required.');
  if (!input.modes || typeof input.modes !== 'object') errors.push('Config modes are required.');
  for (const mode of ['duel', 'lastSurvivor', 'allOrNothing', 'weeklyLeague']) {
    if (!input.modes?.[mode]) errors.push(`Missing mode config: ${mode}`);
  }
  if (!input.economy?.free) errors.push('Missing free economy config.');
  if (!input.economy?.paid) errors.push('Missing paid economy config.');
  return { valid: errors.length === 0, errors };
}

export function updateGameConfig(next: any, updatedBy?: string): any {
  const validation = validateGameConfig(next);
  if (!validation.valid) {
    const err = new Error(validation.errors.join(' | '));
    err.name = 'CONFIG_VALIDATION_ERROR';
    throw err;
  }
  // Mutate the loaded config object so existing imports keep the same reference.
  for (const key of Object.keys(gameConfig)) delete (gameConfig as any)[key];
  Object.assign(gameConfig, structuredClone(next));
  void persistConfig(updatedBy);
  return getEditableGameConfig();
}

export function updateModeConfig(modeId: string, patch: any, updatedBy?: string): any {
  if (!gameConfig.modes?.[modeId]) throw new Error('MODE_NOT_FOUND');
  gameConfig.modes[modeId] = { ...gameConfig.modes[modeId], ...structuredClone(patch) };
  void persistConfig(updatedBy);
  return getEditableGameConfig();
}

/* Deep-merge a partial patch into the live config (what the admin panel sends
 * when it edits a handful of fields) — validated, then persisted. */
export function patchGameConfig(patch: any, updatedBy?: string): any {
  if (!patch || typeof patch !== 'object') throw new Error('CONFIG_PATCH_INVALID');
  const merged = deepMerge(structuredClone(gameConfig), patch);
  return updateGameConfig(merged, updatedBy);
}

/* Public, non-sensitive slice the game client reads so live economy edits
 * (rake %, ticket prices, wallet limits, per-mode stakes) reach players without
 * a redeploy. */
export function getPublicConfig(): any {
  const e = (gameConfig as any).economy ?? {};
  const modes = (gameConfig as any).modes ?? {};
  return {
    version: (gameConfig as any).version,
    rakePercent: e.paid?.rakePercent ?? 5,
    withdrawFeePercent: e.paid?.withdrawFeePercent ?? 5,
    wallet: e.wallet ?? {},
    free: e.free ?? {},
    modes: Object.fromEntries(Object.entries(modes).map(([k, v]: any) => [k, { entry: v.entry, timerSeconds: v.timerSeconds, questionCount: v.questionCount, reward: v.reward }]))
  };
}
