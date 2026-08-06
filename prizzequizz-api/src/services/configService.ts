import { gameConfig } from '../core/config.js';
import { getPgPool } from '../database/postgres.js';
import { categoryImageUrls } from './categoryImageService.js';
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

/* System categories that must ALWAYS exist regardless of admin edits. The
 * «انتخاب موضوع» bank feeds the toss/topic-selection step and is kept separate
 * from the real game questions. Because the admin panel persists the whole
 * `categories` array to the DB (arrays replace wholesale on merge), a saved
 * array could otherwise drop this system category — so we re-add it after every
 * load/edit. It is enabled:false so it never shows in the in-game topic picker,
 * but the admin can still manage its questions. */
export function ensureSystemCategories(): void {
  const cats = Array.isArray((gameConfig as any).categories) ? (gameConfig as any).categories : ((gameConfig as any).categories = []);
  const has = (name: string) => cats.some((c: any) => c && String(c.name).trim() === name);
  // Canonical topics that must exist even if a saved DB array (which replaces the
  // file's array wholesale on merge) omits them. Only ADDED when missing — an
  // admin's edits to an existing category (rename/disable/reorder) are preserved.
  const ensure: { name: string; icon: string; enabled?: boolean; order: number; role?: string; note?: string }[] = [
    { name: 'ادبیات', icon: '📚', order: 13 },
    { name: 'زبان انگلیسی', icon: '🔤', order: 14 },
    { name: 'جغرافیا', icon: '🗺️', order: 15 },
    { name: 'بازی‌های کامپیوتری', icon: '🎮', order: 16 },
    { name: 'فرهنگ و هنر', icon: '🎨', order: 17 },
    { name: 'طبیعت و جانداران', icon: '🌿', order: 18 },
    { name: 'لوگو و سرگرمی', icon: '🧠', order: 19 },
    { name: 'ریاضی و هوش', icon: '➗', order: 20 },
    { name: 'غذا و نوشیدنی', icon: '🍔', order: 21 },
    { name: 'انتخاب موضوع', icon: '⚡', enabled: false, order: 99, role: 'toss', note: 'بانک جدا و فقط برای مرحلهٔ انتخاب موضوع (سؤالات ساده و سریع). در لیست موضوعات بازی نمایش داده نمی‌شود.' }
  ];
  for (const c of ensure) if (!has(c.name)) cats.push({ enabled: true, ...c });
}

/* Load the saved game_config override at boot and merge it over the on-disk
 * defaults (so a config written by an older version still gets any new default
 * keys). No DB / no saved row → keep the on-disk config. */
export async function loadPersistedConfig(): Promise<void> {
  ensureSystemCategories();
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
      ensureSystemCategories();   // re-add system categories a saved array may have dropped
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
  ensureSystemCategories();   // admin edits must never drop the toss category
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
/** Every playable topic the admin has configured, in display order. The one
 *  place that reads `gameConfig.categories`, so a topic's emoji and artwork are
 *  the same object in the duel, in Last Survivor and on the record board.
 *  `role:'toss'` is the internal bank behind topic selection, not a topic
 *  anybody plays, so it never appears here. */
export function categoryList(): Array<{ name: string; icon: string; order: number }> {
  const cats = Array.isArray((gameConfig as any).categories) ? (gameConfig as any).categories : [];
  return cats
    .filter((c: any) => c && c.enabled !== false && c.role !== 'toss' && String(c.name || '').trim())
    .map((c: any) => ({ name: String(c.name).trim(), icon: String(c.icon || '❓'), order: Number(c.order) || 99 }))
    .sort((a: any, b: any) => a.order - b.order);
}

export async function getPublicConfig(): Promise<any> {
  const e = (gameConfig as any).economy ?? {};
  const modes = (gameConfig as any).modes ?? {};
  // Only ENABLED topics reach the game, sorted by admin order — so toggling a
  // category in the panel adds/removes it from the in-game topic picker.
  const cats = Array.isArray((gameConfig as any).categories) ? (gameConfig as any).categories : [];
  /* `image` is a URL, never the bytes: this payload is fetched by every client
   * on boot and twenty inlined pictures would make it enormous. Empty string
   * when the topic has no artwork, and the client falls back to the emoji. */
  const art = await categoryImageUrls().catch(() => ({} as Record<string, string>));
  const categories = cats
    .filter((c: any) => c && c.enabled !== false && c.name)
    .sort((a: any, b: any) => (Number(a.order) || 99) - (Number(b.order) || 99))
    .map((c: any) => ({ name: String(c.name), icon: String(c.icon || '❓'), image: art[String(c.name).trim()] ?? '' }));
  return {
    version: (gameConfig as any).version,
    // The platform commission is deliberately NOT published. Prize figures are
    // computed server-side (see prizeService / GET /economy/prizes) and sent as
    // final take-home amounts, so no client can display or recompute a fee.
    wallet: e.wallet ?? {},
    free: e.free ?? {},
    categories,
    modes: Object.fromEntries(Object.entries(modes).map(([k, v]: any) => [k, { entry: v.entry, timerSeconds: v.timerSeconds, questionCount: v.questionCount, reward: v.reward }]))
  };
}
