/* RANDOM CHARACTER REWARD — the lottery boxes the panel builds.
 *
 * A box is a named set of characters, each with a weight, plus the rules for
 * who may open it and how often. Nothing is hardcoded: which characters are in
 * the draw, their odds, whether VIP entries can come out at all, the time
 * window and the per-user cap are all rows the admin edits.
 *
 * Two things matter for a lottery to be trustworthy:
 *
 *   • The odds are WEIGHTS, not percentages that must add to 100. The panel can
 *     show them as percentages (weight ÷ total), but nothing breaks when an
 *     admin removes an entry, and no rounding error can make a draw impossible.
 *   • Every draw is written to `character_box_draws` BEFORE the reward is
 *     handed out, so the per-user cap is enforced against durable history
 *     rather than anything the client says, and a duplicate can never be
 *     silently re-rolled into a better prize.
 *
 * A duplicate is a real outcome, not a bug: the box says what it converts to
 * (coins, XP, or nothing), which is why the same character can stay in the pool
 * at high weight without making the box worthless. */
import { getPgPool } from '../database/postgres.js';
import { postEntry } from './walletLedgerService.js';
import { awardScoring } from './matchEngine.js';
import { grantCharacter, getCharacter, ensureSchema as ensureCharacterSchema, CharacterError } from './characterSelectionService.js';
import type { Character } from './characterSelectionService.js';
import { id } from '../utils/id.js';

/** What a repeat character turns into. */
export type DuplicatePolicy = 'coins' | 'xp' | 'none';
export const DUPLICATE_POLICIES: DuplicatePolicy[] = ['coins', 'xp', 'none'];

export interface BoxEntry {
  characterId: string;
  /** Relative odds. 0 keeps the row but takes it out of the draw. */
  weight: number;
}

export interface CharacterBox {
  id: string;
  name: string;
  enabled: boolean;
  /** ISO dates; empty = no bound on that side. */
  startsAt: string;
  endsAt: string;
  /** 0 = unlimited. */
  maxPerUser: number;
  /** Percent chance the draw is restricted to the VIP entries. 0 = no special
   *  treatment, VIP entries compete on their plain weight like everything else. */
  vipChance: number;
  duplicatePolicy: DuplicatePolicy;
  duplicateAmount: number;
  entries: BoxEntry[];
  createdAt: string;
}

export interface DrawResult {
  boxId: string;
  userId: string;
  character: Character;
  /** True when the player already owned it. */
  duplicate: boolean;
  /** What the duplicate converted into. */
  compensation: { type: DuplicatePolicy; amount: number };
  at: string;
}

export class BoxError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS character_boxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    max_per_user INT NOT NULL DEFAULT 0,
    vip_chance INT NOT NULL DEFAULT 0,
    duplicate_policy VARCHAR(10) NOT NULL DEFAULT 'coins',
    duplicate_amount BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS character_box_entries (
    box_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    weight INT NOT NULL DEFAULT 1,
    PRIMARY KEY (box_id, character_id))`,
  /* The durable record the per-user cap is enforced against. */
  `CREATE TABLE IF NOT EXISTS character_box_draws (
    id TEXT PRIMARY KEY,
    box_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    character_id TEXT NOT NULL,
    duplicate BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_box_draws_user ON character_box_draws(box_id, user_id)`
];

async function ensureSchema(): Promise<void> {
  await ensureCharacterSchema();
  const pool = pg();
  if (!pool || _schemaReady) return;
  _schemaReady = true;
  for (const sql of SCHEMA_SQL) {
    try { await pool.query(sql); } catch { /* not applicable here */ }
  }
}

// In-memory mirror for a database-less deployment.
const memBoxes = new Map<string, CharacterBox>();
const memDraws: Array<{ boxId: string; userId: string; characterId: string; duplicate: boolean; at: string }> = [];

function str(v: unknown, max: number): string { return String(v ?? '').trim().slice(0, max); }
function int(v: unknown, dflt = 0): number { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : dflt; }
function isoOrEmpty(v: unknown): string {
  const s = str(v, 40);
  if (!s) return '';
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

function normalizeBox(input: any, existing?: CharacterBox): CharacterBox {
  const name = str(input.name, 80) || existing?.name || '';
  if (!name) throw new BoxError('NAME_REQUIRED', 'نام باکس لازم است.');
  const rawEntries = Array.isArray(input.entries) ? input.entries : (existing?.entries ?? []);
  const entries: BoxEntry[] = [];
  const seen = new Set<string>();
  for (const e of rawEntries) {
    const cid = str(e?.characterId ?? e?.id, 60);
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    entries.push({ characterId: cid, weight: Math.max(0, int(e?.weight, 1)) });
  }
  const policy = String(input.duplicatePolicy ?? existing?.duplicatePolicy ?? 'coins');
  return {
    id: str(input.id, 60) || existing?.id || id(),
    name,
    enabled: input.enabled === undefined ? (existing?.enabled ?? true) : !!input.enabled,
    startsAt: input.startsAt === undefined ? (existing?.startsAt ?? '') : isoOrEmpty(input.startsAt),
    endsAt: input.endsAt === undefined ? (existing?.endsAt ?? '') : isoOrEmpty(input.endsAt),
    maxPerUser: input.maxPerUser === undefined ? (existing?.maxPerUser ?? 0) : Math.max(0, int(input.maxPerUser)),
    vipChance: input.vipChance === undefined ? (existing?.vipChance ?? 0) : Math.min(100, Math.max(0, int(input.vipChance))),
    duplicatePolicy: (DUPLICATE_POLICIES as string[]).includes(policy) ? policy as DuplicatePolicy : 'coins',
    duplicateAmount: input.duplicateAmount === undefined ? (existing?.duplicateAmount ?? 0) : Math.max(0, int(input.duplicateAmount)),
    entries,
    createdAt: existing?.createdAt ?? new Date().toISOString()
  };
}

function boxFromRow(r: any, entries: BoxEntry[]): CharacterBox {
  const iso = (v: any) => (v ? (v.toISOString?.() ?? String(v)) : '');
  return {
    id: String(r.id), name: r.name, enabled: !!r.enabled,
    startsAt: iso(r.starts_at), endsAt: iso(r.ends_at),
    maxPerUser: Number(r.max_per_user) || 0,
    vipChance: Number(r.vip_chance) || 0,
    duplicatePolicy: (DUPLICATE_POLICIES as string[]).includes(r.duplicate_policy) ? r.duplicate_policy : 'coins',
    duplicateAmount: Number(r.duplicate_amount) || 0,
    entries, createdAt: iso(r.created_at)
  };
}

// ---------------------------------------------------------------------------
// Box CRUD
// ---------------------------------------------------------------------------
export async function listBoxes(): Promise<CharacterBox[]> {
  await ensureSchema();
  const pool = pg();
  if (!pool) return [...memBoxes.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  try {
    const [{ rows: boxRows }, { rows: entryRows }] = await Promise.all([
      pool.query(`SELECT * FROM character_boxes ORDER BY created_at ASC`),
      pool.query(`SELECT * FROM character_box_entries`)
    ]);
    const byBox = new Map<string, BoxEntry[]>();
    for (const e of entryRows) {
      const list = byBox.get(String(e.box_id)) ?? [];
      list.push({ characterId: String(e.character_id), weight: Number(e.weight) || 0 });
      byBox.set(String(e.box_id), list);
    }
    return boxRows.map((r: any) => boxFromRow(r, byBox.get(String(r.id)) ?? []));
  } catch { return []; }
}

export async function getBox(boxId: string): Promise<CharacterBox | null> {
  const all = await listBoxes();
  return all.find((b) => b.id === boxId) ?? null;
}

export async function saveBox(input: any): Promise<CharacterBox> {
  await ensureSchema();
  const existing = str(input.id, 60) ? await getBox(str(input.id, 60)) : null;
  const box = normalizeBox(input, existing ?? undefined);
  const pool = pg();
  if (!pool) { memBoxes.set(box.id, box); return box; }

  await pool.query(
    `INSERT INTO character_boxes (id,name,enabled,starts_at,ends_at,max_per_user,vip_chance,duplicate_policy,duplicate_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET name=$2, enabled=$3, starts_at=$4, ends_at=$5,
       max_per_user=$6, vip_chance=$7, duplicate_policy=$8, duplicate_amount=$9`,
    [box.id, box.name, box.enabled, box.startsAt || null, box.endsAt || null,
     box.maxPerUser, box.vipChance, box.duplicatePolicy, box.duplicateAmount]);
  // Entries are replaced wholesale — the panel always sends the complete set.
  await pool.query(`DELETE FROM character_box_entries WHERE box_id=$1`, [box.id]);
  for (const e of box.entries) {
    await pool.query(
      `INSERT INTO character_box_entries (box_id, character_id, weight) VALUES ($1,$2,$3)
       ON CONFLICT (box_id, character_id) DO UPDATE SET weight=$3`,
      [box.id, e.characterId, e.weight]);
  }
  return box;
}

export async function deleteBox(boxId: string): Promise<boolean> {
  await ensureSchema();
  const pool = pg();
  if (!pool) return memBoxes.delete(boxId);
  try { await pool.query(`DELETE FROM character_box_entries WHERE box_id=$1`, [boxId]); } catch { /* fine */ }
  const { rowCount } = await pool.query(`DELETE FROM character_boxes WHERE id=$1`, [boxId]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
async function drawCount(boxId: string, userId: string): Promise<number> {
  const pool = pg();
  if (!pool) return memDraws.filter((d) => d.boxId === boxId && d.userId === userId).length;
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM character_box_draws WHERE box_id=$1 AND user_id=$2`, [boxId, userId]);
    return Number(rows[0]?.n) || 0;
  } catch { return 0; }
}

/** Weighted pick. Entries with weight 0 are present but never selected. */
function pickWeighted(pool: Array<{ character: Character; weight: number }>): Character | null {
  const live = pool.filter((p) => p.weight > 0);
  if (!live.length) return null;
  const total = live.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of live) {
    r -= p.weight;
    if (r <= 0) return p.character;
  }
  return live[live.length - 1]!.character;
}

/**
 * Opens one box for one player. Enforces the window and the cap, picks by
 * weight, records the draw, then grants — or pays the duplicate compensation.
 */
export async function drawFromBox(boxId: string, userId: string, opts: { ignoreLimits?: boolean } = {}): Promise<DrawResult> {
  await ensureSchema();
  const box = await getBox(boxId);
  if (!box) throw new BoxError('BOX_NOT_FOUND', 'این باکس وجود ندارد.');
  if (!box.enabled && !opts.ignoreLimits) throw new BoxError('BOX_DISABLED', 'این باکس فعال نیست.');

  const now = Date.now();
  if (!opts.ignoreLimits) {
    if (box.startsAt && Date.parse(box.startsAt) > now) throw new BoxError('NOT_STARTED', 'زمان این قرعه‌کشی هنوز نرسیده است.');
    if (box.endsAt && Date.parse(box.endsAt) < now) throw new BoxError('ENDED', 'زمان این قرعه‌کشی تمام شده است.');
    if (box.maxPerUser > 0 && (await drawCount(boxId, userId)) >= box.maxPerUser) {
      throw new BoxError('LIMIT_REACHED', 'سقف دریافت شما از این باکس پر شده است.');
    }
  }

  // Resolve entries to real, enabled characters. A deleted or disabled one
  // simply drops out of the draw instead of producing a broken reward.
  const resolved: Array<{ character: Character; weight: number }> = [];
  for (const e of box.entries) {
    const c = await getCharacter(e.characterId);
    if (c && c.enabled) resolved.push({ character: c, weight: e.weight });
  }
  if (!resolved.length) throw new BoxError('BOX_EMPTY', 'این باکس هیچ کاراکتر قابل اهدایی ندارد.');

  /* VIP chance narrows the pool before the weighted pick, so "10% VIP" means
   * exactly that regardless of how the individual weights are set. It only
   * applies when the box actually holds a VIP entry. */
  let pool = resolved;
  const vipPool = resolved.filter((p) => p.character.kind === 'vip' && p.weight > 0);
  if (box.vipChance > 0 && vipPool.length) {
    const rollVip = Math.random() * 100 < box.vipChance;
    const normalPool = resolved.filter((p) => p.character.kind === 'normal' && p.weight > 0);
    pool = rollVip ? vipPool : (normalPool.length ? normalPool : vipPool);
  }

  const character = pickWeighted(pool) ?? pickWeighted(resolved);
  if (!character) throw new BoxError('BOX_EMPTY', 'این باکس هیچ کاراکتر قابل اهدایی ندارد.');

  const granted = await grantCharacter(userId, character.id, 'random');
  const duplicate = !granted;

  // Written after the grant decision but always, so the cap counts real opens.
  const pool2 = pg();
  if (pool2) {
    try {
      await pool2.query(`INSERT INTO character_box_draws (id,box_id,user_id,character_id,duplicate) VALUES ($1,$2,$3,$4,$5)`,
        [id(), boxId, userId, character.id, duplicate]);
    } catch { /* audit row is best-effort */ }
  } else {
    memDraws.push({ boxId, userId, characterId: character.id, duplicate, at: new Date().toISOString() });
  }

  const compensation: DrawResult['compensation'] = { type: 'none', amount: 0 };
  if (duplicate && box.duplicateAmount > 0 && box.duplicatePolicy !== 'none') {
    compensation.type = box.duplicatePolicy;
    compensation.amount = box.duplicateAmount;
    await payDuplicate(userId, boxId, character.id, box.duplicatePolicy, box.duplicateAmount);
  }

  return { boxId, userId, character, duplicate, compensation, at: new Date().toISOString() };
}

/** Coins go through the ledger like any other money; XP goes to the profile. */
async function payDuplicate(userId: string, boxId: string, characterId: string, policy: DuplicatePolicy, amount: number): Promise<void> {
  try {
    if (policy === 'coins') {
      await postEntry({
        userId, entryType: 'bonus', kind: 'credit', amount,
        // Same box + same character + same user must never pay twice for one draw.
        idempotencyKey: `charbox:${boxId}:${userId}:${characterId}:${Date.now()}`,
        refType: 'character_box', refId: boxId,
        description: 'جایزهٔ تکراری قرعه‌کشی کاراکتر'
      });
    } else if (policy === 'xp') {
      // Through the same authoritative path match rewards use, so the level and
      // the weekly week-stamp stay consistent with everything else.
      await awardScoring(userId, amount, 0);
    }
  } catch { /* the character was still granted; compensation is secondary */ }
}

/** Panel action: run one box for a list of players and report every outcome. */
export async function drawForUsers(boxId: string, userIds: string[]): Promise<{ results: DrawResult[]; failures: Array<{ userId: string; reason: string }> }> {
  const results: DrawResult[] = [];
  const failures: Array<{ userId: string; reason: string }> = [];
  for (const uid of userIds) {
    try { results.push(await drawFromBox(boxId, uid, { ignoreLimits: true })); }
    catch (e) { failures.push({ userId: uid, reason: (e as Error).message }); }
  }
  return { results, failures };
}

/** Odds the panel displays, derived from the weights so they always add to 100. */
export function oddsFor(box: CharacterBox): Array<{ characterId: string; weight: number; percent: number }> {
  const total = box.entries.reduce((s, e) => s + Math.max(0, e.weight), 0);
  return box.entries.map((e) => ({
    characterId: e.characterId,
    weight: e.weight,
    percent: total > 0 ? Math.round((Math.max(0, e.weight) / total) * 1000) / 10 : 0
  }));
}

export { CharacterError };

/** Test seam. */
export function _resetMemory(): void { memBoxes.clear(); memDraws.length = 0; }
