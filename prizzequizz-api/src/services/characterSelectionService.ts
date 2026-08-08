/* CHARACTER SELECTION — the roster a player picks their avatar from.
 *
 * This replaces the old part-by-part builder. A character is now one whole
 * illustration the admin uploads, not a stack of layers, which is what makes an
 * unlimited roster possible: adding the hundredth character is a row and a PNG,
 * never a code change. Nothing about a character is hardcoded here — name, art,
 * type, unlock level, which routes can unlock it, price and ordering all live in
 * the database and are editable from the panel.
 *
 * Two ideas carry the whole unlock model:
 *
 *   • Level unlocks are DERIVED, not stored. A character with `viaLevel` and
 *     `unlockLevel: 5` is open to everyone who has reached level 5, computed at
 *     read time. No backfill job, no rows to write when someone levels up, and
 *     changing the level in the panel instantly re-gates every player.
 *   • Everything else is a ROW in `user_characters`, tagged with the route that
 *     granted it (reward, event, random, purchase, admin). That tag is what the
 *     statistics are counted from, so the numbers are a by-product of the real
 *     grants rather than counters that can drift.
 *
 * Locked characters are deliberately still returned to the client, with the
 * reason they are locked, because the roster is also a goal list. */
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import { levelForXp } from './scoringConfig.js';
import { id } from '../utils/id.js';

export type CharacterKind = 'normal' | 'vip';
/** How a player came to own one. `level` never appears here — it is derived. */
export type UnlockSource = 'reward' | 'event' | 'random' | 'purchase' | 'admin' | 'league' | 'mission';
export const UNLOCK_SOURCES: UnlockSource[] = ['reward', 'event', 'random', 'purchase', 'admin', 'league', 'mission'];

/** Hard ceiling for one character's artwork held inline as a data URI. */
export const CHARACTER_IMAGE_MAX_BYTES = 600 * 1024;

export interface Character {
  id: string;
  name: string;
  description: string;
  /** data: URI or https URL. */
  image: string;
  kind: CharacterKind;
  enabled: boolean;
  /** Level that opens it, when `viaLevel` is on. */
  unlockLevel: number;
  viaLevel: boolean;
  viaReward: boolean;
  viaPurchase: boolean;
  viaEvent: boolean;
  viaRandom: boolean;
  price: number;
  sortOrder: number;
  /** While in the future, the card carries a "new" badge. Empty = never new. */
  newUntil: string;
  createdAt: string;
}

/** A character as one particular player sees it. */
export interface CharacterView extends Character {
  unlocked: boolean;
  equipped: boolean;
  isNew: boolean;
  /** Why it is still locked, in the player's language. Empty when unlocked. */
  lockReason: string;
  /** How this player got it, or 'level' when the level derived it. */
  source: string;
}

export interface RosterView {
  characters: CharacterView[];
  equippedId: string;
  level: number;
  xp: number;
  hasDatabase: boolean;
}

export class CharacterError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
/* Statements run independently and the pass latches either way: one that cannot
 * apply in a given deployment must not take the rest of the roster down. */
let _schemaReady = false;
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    kind VARCHAR(10) NOT NULL DEFAULT 'normal',
    enabled BOOLEAN NOT NULL DEFAULT true,
    unlock_level INT NOT NULL DEFAULT 0,
    via_level BOOLEAN NOT NULL DEFAULT true,
    via_reward BOOLEAN NOT NULL DEFAULT false,
    via_purchase BOOLEAN NOT NULL DEFAULT false,
    via_event BOOLEAN NOT NULL DEFAULT false,
    via_random BOOLEAN NOT NULL DEFAULT false,
    price BIGINT NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    new_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_characters_order ON characters(sort_order, created_at)`,
  /* One row per character a player actually owns. `source` is the audit trail
   * the popularity statistics are counted from. */
  `CREATE TABLE IF NOT EXISTS user_characters (
    user_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, character_id))`,
  `CREATE INDEX IF NOT EXISTS idx_user_characters_char ON user_characters(character_id)`,
  /* Which one is in use. `picks` counts how often this player re-picked, and the
   * per-character total is summed from here. */
  `CREATE TABLE IF NOT EXISTS user_character_pick (
    user_id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    picks INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_user_pick_char ON user_character_pick(character_id)`,
  /* Every equip event, so "times selected" is a real count and not a counter
   * that resets when someone switches back and forth. */
  `CREATE TABLE IF NOT EXISTS character_pick_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_pick_events_char ON character_pick_events(character_id)`
];

export async function ensureSchema(): Promise<void> {
  const pool = pg();
  if (!pool || _schemaReady) return;
  _schemaReady = true;
  for (const sql of SCHEMA_SQL) {
    try { await pool.query(sql); } catch { /* not applicable here */ }
  }
}

// ---------------------------------------------------------------------------
// In-memory mirror, so the roster works with no database at all (tests, dev)
// ---------------------------------------------------------------------------
const memCharacters = new Map<string, Character>();
const memOwned = new Map<string, Map<string, { source: string; at: string }>>();
const memPick = new Map<string, string>();
const memPickEvents: Array<{ userId: string; characterId: string; at: string }> = [];

// ---------------------------------------------------------------------------
// Normalising input — the panel is the only writer, but never trust it blindly
// ---------------------------------------------------------------------------
function str(v: unknown, max: number): string { return String(v ?? '').trim().slice(0, max); }
function bool(v: unknown, dflt = false): boolean { return v === undefined || v === null ? dflt : !!v; }
function int(v: unknown, dflt = 0): number { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : dflt; }

function validImage(image: string): string {
  if (!image) return '';
  if (/^https:\/\//i.test(image)) return image.slice(0, 2000);
  const m = /^data:image\/(png|jpeg|webp|avif|gif);base64,/i.exec(image);
  if (!m) throw new CharacterError('BAD_IMAGE', 'تصویر باید PNG/JPEG/WebP/AVIF یا یک آدرس https باشد.');
  // base64 inflates by 4/3; measure the real decoded size.
  const bytes = Math.floor((image.length - image.indexOf(',') - 1) * 3 / 4);
  if (bytes > CHARACTER_IMAGE_MAX_BYTES) {
    throw new CharacterError('IMAGE_TOO_BIG', `حجم تصویر باید کمتر از ${Math.round(CHARACTER_IMAGE_MAX_BYTES / 1024)} کیلوبایت باشد.`);
  }
  return image;
}

function normalize(input: any, existing?: Character): Character {
  const now = new Date().toISOString();
  const name = str(input.name, 60) || existing?.name || '';
  if (!name) throw new CharacterError('NAME_REQUIRED', 'نام کاراکتر لازم است.');
  const image = input.image === undefined ? (existing?.image ?? '') : validImage(str(input.image, 900_000));
  return {
    id: str(input.id, 60) || existing?.id || id(),
    name,
    description: input.description === undefined ? (existing?.description ?? '') : str(input.description, 400),
    image,
    kind: input.kind === undefined ? (existing?.kind ?? 'normal') : (String(input.kind) === 'vip' ? 'vip' : 'normal'),
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : bool(input.enabled),
    unlockLevel: input.unlockLevel === undefined ? (existing?.unlockLevel ?? 0) : Math.max(0, int(input.unlockLevel)),
    viaLevel: input.viaLevel === undefined ? (existing?.viaLevel ?? true) : bool(input.viaLevel),
    viaReward: input.viaReward === undefined ? (existing?.viaReward ?? false) : bool(input.viaReward),
    viaPurchase: input.viaPurchase === undefined ? (existing?.viaPurchase ?? false) : bool(input.viaPurchase),
    viaEvent: input.viaEvent === undefined ? (existing?.viaEvent ?? false) : bool(input.viaEvent),
    viaRandom: input.viaRandom === undefined ? (existing?.viaRandom ?? false) : bool(input.viaRandom),
    price: input.price === undefined ? (existing?.price ?? 0) : Math.max(0, int(input.price)),
    sortOrder: input.sortOrder === undefined ? (existing?.sortOrder ?? 0) : int(input.sortOrder),
    newUntil: input.newUntil === undefined ? (existing?.newUntil ?? '') : str(input.newUntil, 40),
    createdAt: existing?.createdAt ?? now
  };
}

function fromRow(r: any): Character {
  const iso = (v: any) => (v ? (v.toISOString?.() ?? String(v)) : '');
  return {
    id: String(r.id), name: r.name, description: r.description ?? '', image: r.image ?? '',
    kind: r.kind === 'vip' ? 'vip' : 'normal', enabled: !!r.enabled,
    unlockLevel: Number(r.unlock_level) || 0,
    viaLevel: !!r.via_level, viaReward: !!r.via_reward, viaPurchase: !!r.via_purchase,
    viaEvent: !!r.via_event, viaRandom: !!r.via_random,
    price: Number(r.price) || 0, sortOrder: Number(r.sort_order) || 0,
    newUntil: iso(r.new_until), createdAt: iso(r.created_at)
  };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
export async function listCharacters(opts: { includeDisabled?: boolean } = {}): Promise<Character[]> {
  await ensureSchema();
  const pool = pg();
  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM characters ${opts.includeDisabled ? '' : 'WHERE enabled = true'}
          ORDER BY sort_order ASC, created_at ASC`);
      return rows.map(fromRow);
    } catch { return []; }
  }
  return [...memCharacters.values()]
    .filter((c) => opts.includeDisabled || c.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
}

export async function getCharacter(characterId: string): Promise<Character | null> {
  await ensureSchema();
  const pool = pg();
  if (pool) {
    try {
      const { rows } = await pool.query(`SELECT * FROM characters WHERE id=$1`, [characterId]);
      return rows[0] ? fromRow(rows[0]) : null;
    } catch { return null; }
  }
  return memCharacters.get(characterId) ?? null;
}

export async function saveCharacter(input: any): Promise<Character> {
  _catalogCache = null;   // an edit must show up at once, not after the TTL
  await ensureSchema();
  const existingId = str(input.id, 60);
  const existing = existingId ? await getCharacter(existingId) : null;
  const c = normalize(input, existing ?? undefined);
  const pool = pg();
  if (pool) {
    await pool.query(
      `INSERT INTO characters (id,name,description,image,kind,enabled,unlock_level,
                               via_level,via_reward,via_purchase,via_event,via_random,
                               price,sort_order,new_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, description=$3, image=$4, kind=$5, enabled=$6, unlock_level=$7,
         via_level=$8, via_reward=$9, via_purchase=$10, via_event=$11, via_random=$12,
         price=$13, sort_order=$14, new_until=$15`,
      [c.id, c.name, c.description, c.image, c.kind, c.enabled, c.unlockLevel,
       c.viaLevel, c.viaReward, c.viaPurchase, c.viaEvent, c.viaRandom,
       c.price, c.sortOrder, c.newUntil || null]);
  } else {
    memCharacters.set(c.id, c);
  }
  return c;
}

export async function deleteCharacter(characterId: string): Promise<boolean> {
  _catalogCache = null;
  await ensureSchema();
  const pool = pg();
  if (pool) {
    // Ownership and pick rows go too — a character that no longer exists must
    // not linger as somebody's equipped avatar.
    for (const sql of [
      `DELETE FROM user_characters WHERE character_id=$1`,
      `DELETE FROM user_character_pick WHERE character_id=$1`
    ]) { try { await pool.query(sql, [characterId]); } catch { /* table may not exist */ } }
    const { rowCount } = await pool.query(`DELETE FROM characters WHERE id=$1`, [characterId]);
    return (rowCount ?? 0) > 0;
  }
  for (const owned of memOwned.values()) owned.delete(characterId);
  for (const [u, cid] of [...memPick.entries()]) if (cid === characterId) memPick.delete(u);
  return memCharacters.delete(characterId);
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------
async function ownedMap(userId: string): Promise<Map<string, string>> {
  const pool = pg();
  if (pool) {
    try {
      const { rows } = await pool.query(`SELECT character_id, source FROM user_characters WHERE user_id=$1`, [userId]);
      return new Map(rows.map((r: any) => [String(r.character_id), String(r.source)]));
    } catch { return new Map(); }
  }
  const m = memOwned.get(userId);
  return new Map([...(m ?? new Map())].map(([k, v]) => [k, v.source]));
}

/** Records ownership. Returns false when the player already had it — the caller
 *  decides what a duplicate is worth. */
export async function grantCharacter(userId: string, characterId: string, source: UnlockSource): Promise<boolean> {
  await ensureSchema();
  const src = UNLOCK_SOURCES.includes(source) ? source : 'admin';
  const pool = pg();
  if (pool) {
    const { rowCount } = await pool.query(
      `INSERT INTO user_characters (user_id, character_id, source) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, character_id) DO NOTHING`, [userId, characterId, src]);
    return (rowCount ?? 0) > 0;
  }
  const m = memOwned.get(userId) ?? new Map();
  memOwned.set(userId, m);
  if (m.has(characterId)) return false;
  m.set(characterId, { source: src, at: new Date().toISOString() });
  return true;
}

export class CharacterPurchaseError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/* BUYING a character with coins.
 *
 * The roster has advertised a price and a «خرید (N سکه)» unlock line since it
 * was written, and there was no way to pay it — the price was decoration. This
 * is the missing half.
 *
 * Coins live on the user row (users.coins), the same balance the wheel and the
 * shop credit, so the charge happens there and the unlock is recorded with
 * source 'purchase'. Already owning it is not an error worth charging for: the
 * money is only taken when something is actually granted. */
export async function purchaseCharacter(userId: string, characterId: string): Promise<{
  characterId: string; charged: number; coins: number; alreadyOwned: boolean;
}> {
  await ensureSchema();
  const c = await getCharacter(characterId);
  if (!c || c.enabled === false) throw new CharacterPurchaseError('CHARACTER_NOT_FOUND', 'این کاراکتر پیدا نشد.');
  if (!c.viaPurchase) throw new CharacterPurchaseError('NOT_FOR_SALE', 'این کاراکتر فروشی نیست.');
  const price = Math.max(0, Math.floor(Number(c.price) || 0));

  const user: any = await repositories.users.findById(userId);
  if (!user) throw new CharacterPurchaseError('USER_NOT_FOUND', 'کاربر پیدا نشد.');

  /* Owned already — through a box, a reward or a previous purchase. Say so and
   * charge nothing, so a double tap cannot buy the same character twice. */
  const owned = await ownedMap(userId);
  if (owned.has(characterId)) {
    return { characterId, charged: 0, coins: Number(user.coins) || 0, alreadyOwned: true };
  }

  const coins = Number(user.coins) || 0;
  if (coins < price) {
    throw new CharacterPurchaseError('INSUFFICIENT_COINS',
      'سکهٔ کافی نداری — ' + price.toLocaleString('fa-IR') + ' سکه لازم است.');
  }

  /* Grant FIRST, then charge. If the grant fails nothing has been taken; if the
   * charge fails the player keeps a character they did not pay for, which is
   * the kinder way for it to break. */
  const granted = await grantCharacter(userId, characterId, 'purchase');
  if (!granted) return { characterId, charged: 0, coins, alreadyOwned: true };

  user.coins = coins - price;
  await repositories.users.save(user);
  return { characterId, charged: price, coins: user.coins, alreadyOwned: false };
}

// ---------------------------------------------------------------------------
// The roster, as one player sees it
// ---------------------------------------------------------------------------
function lockReasonFor(c: Character, level: number): string {
  // Persian digits throughout — a Latin numeral in the middle of a Persian
  // sentence is the kind of detail players read as unfinished.
  const fa = (n: number) => n.toLocaleString('fa-IR');
  if (c.viaLevel && c.unlockLevel > 0) {
    if (level >= c.unlockLevel) return '';
    return `در لول ${fa(c.unlockLevel)} آزاد می‌شود`;
  }
  // Not level-gated → it has to arrive some other way. Name the routes that are
  // actually switched on for this character, never a generic message.
  const ways: string[] = [];
  if (c.viaReward) ways.push('جایزهٔ مسابقات');
  if (c.viaEvent) ways.push('جایزهٔ رویدادها');
  if (c.viaRandom) ways.push('قرعه‌کشی');
  if (c.viaPurchase) ways.push(c.price > 0 ? `خرید (${fa(c.price)} سکه)` : 'خرید از فروشگاه');
  if (!ways.length) return 'فعلاً در دسترس نیست';
  return `آزادسازی با: ${ways.join(' یا ')}`;
}

export async function buildRoster(userId: string): Promise<RosterView> {
  await ensureSchema();
  const [characters, owned] = await Promise.all([listCharacters(), ownedMap(userId)]);

  let xp = 0;
  try { const u: any = await repositories.users.findById(userId); xp = Number(u?.xp ?? 0) || 0; } catch { /* level 1 */ }
  const level = levelForXp(xp);

  const equippedId = await equippedFor(userId);
  const now = Date.now();

  const views: CharacterView[] = characters.map((c) => {
    const grantSource = owned.get(c.id);
    // A level unlock is computed, never stored — see the file header.
    const byLevel = c.viaLevel && level >= c.unlockLevel;
    const unlocked = !!grantSource || byLevel;
    return {
      ...c,
      unlocked,
      equipped: c.id === equippedId,
      isNew: !!c.newUntil && Date.parse(c.newUntil) > now,
      lockReason: unlocked ? '' : lockReasonFor(c, level),
      source: grantSource ?? (byLevel ? 'level' : '')
    };
  });

  return { characters: views, equippedId, level, xp, hasDatabase: !!pg() };
}

export async function equippedFor(userId: string): Promise<string> {
  await ensureSchema();
  const pool = pg();
  if (pool) {
    try {
      const { rows } = await pool.query(`SELECT character_id FROM user_character_pick WHERE user_id=$1`, [userId]);
      return rows[0] ? String(rows[0].character_id) : '';
    } catch { return ''; }
  }
  return memPick.get(userId) ?? '';
}

/** Equipping is the one player-facing write, so it re-checks the unlock itself
 *  rather than trusting the client's view of the roster. */
export async function equipCharacter(userId: string, characterId: string): Promise<CharacterView> {
  const roster = await buildRoster(userId);
  const target = roster.characters.find((c) => c.id === characterId);
  if (!target) throw new CharacterError('NOT_FOUND', 'این کاراکتر وجود ندارد.');
  if (!target.enabled) throw new CharacterError('DISABLED', 'این کاراکتر فعال نیست.');
  if (!target.unlocked) throw new CharacterError('LOCKED', target.lockReason || 'این کاراکتر هنوز باز نشده است.');

  const pool = pg();
  if (pool) {
    await pool.query(
      `INSERT INTO user_character_pick (user_id, character_id, picks, updated_at)
       VALUES ($1,$2,1,now())
       ON CONFLICT (user_id) DO UPDATE SET character_id=$2, picks=user_character_pick.picks+1, updated_at=now()`,
      [userId, characterId]);
    try {
      await pool.query(`INSERT INTO character_pick_events (id,user_id,character_id) VALUES ($1,$2,$3)`,
        [id(), userId, characterId]);
    } catch { /* history is nice to have, not worth failing the equip */ }
  } else {
    memPick.set(userId, characterId);
    memPickEvents.push({ userId, characterId, at: new Date().toISOString() });
  }
  return { ...target, equipped: true };
}

// ---------------------------------------------------------------------------
// Statistics — every number counted from the grant and pick rows
// ---------------------------------------------------------------------------
export interface CharacterStat {
  id: string; name: string; kind: CharacterKind; enabled: boolean;
  owners: number;        // players who hold it (granted rows only)
  equipped: number;      // players using it right now
  picks: number;         // times it was equipped, ever
  fromRandom: number;
  fromReward: number;
  /** Share of players currently using it, as a percentage of all equipped players. */
  popularity: number;
}

export async function characterStats(): Promise<{ rows: CharacterStat[]; totalEquipped: number; hasDatabase: boolean }> {
  await ensureSchema();
  const characters = await listCharacters({ includeDisabled: true });
  const pool = pg();

  if (!pool) {
    const rows = characters.map((c) => {
      let owners = 0, fromRandom = 0, fromReward = 0;
      for (const m of memOwned.values()) {
        const e = m.get(c.id);
        if (!e) continue;
        owners += 1;
        if (e.source === 'random') fromRandom += 1;
        else if (e.source !== 'purchase') fromReward += 1;
      }
      const equipped = [...memPick.values()].filter((v) => v === c.id).length;
      return { id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, owners, equipped,
        picks: memPickEvents.filter((e) => e.characterId === c.id).length,
        fromRandom, fromReward, popularity: 0 };
    });
    const total = memPick.size;
    for (const r of rows) r.popularity = total ? Math.round((r.equipped / total) * 1000) / 10 : 0;
    return { rows, totalEquipped: total, hasDatabase: false };
  }

  const q = async (sql: string): Promise<any[]> => {
    try { const { rows } = await pool.query(sql); return rows; } catch { return []; }
  };
  const [ownRows, eqRows, pickRows] = await Promise.all([
    q(`SELECT character_id,
              count(*)::int AS owners,
              count(*) FILTER (WHERE source='random')::int AS from_random,
              count(*) FILTER (WHERE source NOT IN ('random','purchase'))::int AS from_reward
         FROM user_characters GROUP BY 1`),
    q(`SELECT character_id, count(*)::int AS n FROM user_character_pick GROUP BY 1`),
    q(`SELECT character_id, count(*)::int AS n FROM character_pick_events GROUP BY 1`)
  ]);
  const own = new Map(ownRows.map((r) => [String(r.character_id), r]));
  const eq = new Map(eqRows.map((r) => [String(r.character_id), Number(r.n) || 0]));
  const pk = new Map(pickRows.map((r) => [String(r.character_id), Number(r.n) || 0]));
  const totalEquipped = [...eq.values()].reduce((a, b) => a + b, 0);

  const rows: CharacterStat[] = characters.map((c) => {
    const o = own.get(c.id);
    const equipped = eq.get(c.id) ?? 0;
    return {
      id: c.id, name: c.name, kind: c.kind, enabled: c.enabled,
      owners: Number(o?.owners) || 0,
      equipped,
      picks: pk.get(c.id) ?? 0,
      fromRandom: Number(o?.from_random) || 0,
      fromReward: Number(o?.from_reward) || 0,
      popularity: totalEquipped ? Math.round((equipped / totalEquipped) * 1000) / 10 : 0
    };
  });
  return { rows, totalEquipped, hasDatabase: true };
}

// ---------------------------------------------------------------------------
// The equipped character, for anywhere a player is shown
// ---------------------------------------------------------------------------
/* The public face of a player: whatever they are currently wearing. Kept to
 * exactly what a card needs to draw, so a leaderboard page carrying fifty of
 * these does not also carry fifty descriptions and unlock rules. */
export interface EquippedCharacter { id: string; name: string; image: string; kind: CharacterKind }

/* The roster is small and changes rarely, while these lookups happen on every
 * leaderboard, match and friends list. One short-lived snapshot of the catalog
 * turns N queries into one. */
let _catalogCache: { at: number; byId: Map<string, Character> } | null = null;
const CATALOG_TTL_MS = 60_000;

async function catalogById(): Promise<Map<string, Character>> {
  const now = Date.now();
  if (_catalogCache && now - _catalogCache.at < CATALOG_TTL_MS) return _catalogCache.byId;
  const list = await listCharacters({ includeDisabled: true });
  const byId = new Map(list.map((c) => [c.id, c]));
  _catalogCache = { at: now, byId };
  return byId;
}

function publicFace(c: Character | undefined): EquippedCharacter | null {
  if (!c || !c.image) return null;   // no artwork → nothing worth drawing
  return { id: c.id, name: c.name, image: c.image, kind: c.kind };
}

export async function equippedCharacterFor(userId: string): Promise<EquippedCharacter | null> {
  if (!userId) return null;
  try {
    const [pickId, byId] = await Promise.all([equippedFor(userId), catalogById()]);
    return pickId ? publicFace(byId.get(pickId)) : null;
  } catch { return null; }
}

/** Batch form — one query for the picks, one cached read for the catalog. */
export async function equippedCharactersFor(userIds: string[]): Promise<Map<string, EquippedCharacter>> {
  const out = new Map<string, EquippedCharacter>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return out;
  await ensureSchema();

  const byId = await catalogById();
  const pool = pg();
  if (pool) {
    try {
      const { rows } = await pool.query(
        `SELECT user_id, character_id FROM user_character_pick WHERE user_id = ANY($1)`, [ids]);
      for (const r of rows) {
        const face = publicFace(byId.get(String(r.character_id)));
        if (face) out.set(String(r.user_id), face);
      }
    } catch { /* no table yet → nobody has picked anything */ }
    return out;
  }
  for (const uid of ids) {
    const cid = memPick.get(uid);
    const face = cid ? publicFace(byId.get(cid)) : null;
    if (face) out.set(uid, face);
  }
  return out;
}

/** Bulk grant used by the panel: one user, a list, or everyone. */
export async function grantToUsers(characterId: string, userIds: string[], source: UnlockSource): Promise<{ granted: number; already: number }> {
  const character = await getCharacter(characterId);
  if (!character) throw new CharacterError('NOT_FOUND', 'این کاراکتر وجود ندارد.');
  let granted = 0, already = 0;
  for (const uid of userIds) {
    if (await grantCharacter(uid, characterId, source)) granted += 1; else already += 1;
  }
  return { granted, already };
}

/** Every user id, for "grant to all". Paged so a large table cannot blow memory. */
export async function allUserIds(): Promise<string[]> {
  const pool = pg();
  if (pool) {
    try { const { rows } = await pool.query(`SELECT id FROM users LIMIT 200000`); return rows.map((r: any) => String(r.id)); }
    catch { return []; }
  }
  try { const users = await repositories.users.list?.(); return (users ?? []).map((u: any) => String(u.id)); }
  catch { return []; }
}

/** Test seam — lets the suite start from a clean roster. */
export function _resetMemory(): void {
  memCharacters.clear(); memOwned.clear(); memPick.clear(); memPickEvents.length = 0;
}
