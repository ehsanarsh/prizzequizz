/* CHARACTER BUILDER — layered parts catalog + per-user build.
 * Each part is a FULL-CANVAS transparent image (SVG data-URI now, real PNGs
 * later) so layers never shift when swapped. Admin-managed like the shop:
 * category + image + z-order + enabled. Postgres-backed with a memory fallback,
 * seeded once with a cohesive SVG set in the yellow-monster style. */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { buildSeedParts } from './characterPartsSeed.js';

// Fixed back→front stacking order. Every category renders on the same 300x300
// canvas at the same anchors, so nothing moves when a part is swapped.
export const CHARACTER_CATEGORIES = [
  'legs', 'body', 'arms', 'beard', 'eyesDouble', 'eyesSingle', 'eyebrows', 'glasses', 'hair', 'horns', 'hat', 'accessories', 'shoes'
] as const;
export type CharacterCategory = typeof CHARACTER_CATEGORIES[number];

// Default z per category (index in the array above = layer order).
export function defaultZ(category: string): number {
  const i = (CHARACTER_CATEGORIES as readonly string[]).indexOf(category);
  return i < 0 ? 50 : (i + 1) * 10;
}

export interface CharacterPart {
  id: string;
  category: string;
  name: string;
  imageUrl: string;    // data:image/svg+xml,... or a real /character-assets/... PNG url
  zIndex: number;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS character_parts (
    id TEXT PRIMARY KEY,
    category VARCHAR(32) NOT NULL,
    name VARCHAR(120) NOT NULL,
    image_url TEXT NOT NULL,
    z_index INT NOT NULL DEFAULT 50,
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_character_parts_cat ON character_parts(category, sort_order)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_character_build (
    user_id TEXT PRIMARY KEY,
    build JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  _schemaReady = true;
}

const memParts: CharacterPart[] = [];
const memBuilds = new Map<string, Record<string, string | null>>();

function rowToPart(r: any): CharacterPart {
  return {
    id: r.id, category: r.category, name: r.name, imageUrl: r.image_url,
    zIndex: Number(r.z_index ?? 50), enabled: r.enabled !== false, sortOrder: Number(r.sort_order ?? 0),
    createdAt: r.created_at?.toISOString?.() ?? String(r.created_at),
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at)
  };
}

let _seeded = false;
async function seedIfEmpty(): Promise<void> {
  if (_seeded) return;
  const existing = await listAllRaw();
  if (existing.length === 0) {
    const seed = buildSeedParts();
    for (const s of seed) await savePart({ category: s.category, name: s.name, imageUrl: s.imageUrl, sortOrder: s.sortOrder, zIndex: defaultZ(s.category), enabled: true });
  }
  _seeded = true;
}

async function listAllRaw(): Promise<CharacterPart[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM character_parts ORDER BY category, sort_order, created_at`);
    return rows.map(rowToPart);
  }
  return memParts.slice().sort((a, b) => a.category === b.category ? a.sortOrder - b.sortOrder : (a.category < b.category ? -1 : 1));
}

export async function listParts(opts: { category?: string; enabledOnly?: boolean } = {}): Promise<CharacterPart[]> {
  await seedIfEmpty();
  let parts = await listAllRaw();
  if (opts.category) parts = parts.filter((p) => p.category === opts.category);
  if (opts.enabledOnly) parts = parts.filter((p) => p.enabled);
  return parts;
}

export async function getPart(partId: string): Promise<CharacterPart | null> {
  return (await listAllRaw()).find((p) => p.id === partId) ?? null;
}

export async function savePart(input: Partial<CharacterPart> & { category: string; name: string; imageUrl: string }): Promise<CharacterPart> {
  const now = new Date().toISOString();
  const existing = input.id ? await getPart(input.id) : null;
  const part: CharacterPart = {
    id: input.id || id(),
    category: String(input.category).trim(),
    name: String(input.name).slice(0, 120),
    imageUrl: String(input.imageUrl),
    zIndex: Number(input.zIndex ?? existing?.zIndex ?? defaultZ(input.category)),
    enabled: input.enabled != null ? !!input.enabled : (existing?.enabled ?? true),
    sortOrder: Number(input.sortOrder ?? existing?.sortOrder ?? 0),
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (!part.category || !part.name || !part.imageUrl) throw new Error('FIELDS_REQUIRED');
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO character_parts(id,category,name,image_url,z_index,enabled,sort_order,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET category=$2,name=$3,image_url=$4,z_index=$5,enabled=$6,sort_order=$7,updated_at=$9`,
      [part.id, part.category, part.name, part.imageUrl, part.zIndex, part.enabled, part.sortOrder, part.createdAt, part.updatedAt]);
  } else {
    const i = memParts.findIndex((x) => x.id === part.id);
    if (i >= 0) memParts[i] = part; else memParts.push(part);
  }
  return part;
}

export async function removePart(partId: string): Promise<boolean> {
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rowCount } = await pool.query(`DELETE FROM character_parts WHERE id=$1`, [partId]); return (rowCount ?? 0) > 0; }
  const i = memParts.findIndex((x) => x.id === partId);
  if (i < 0) return false; memParts.splice(i, 1); return true;
}

// ---- Per-user build (selected part id per category, or null = None) ----
export async function getBuild(userId: string): Promise<Record<string, string | null>> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT build FROM user_character_build WHERE user_id=$1`, [userId]);
    return (rows[0]?.build as any) ?? {};
  }
  return memBuilds.get(userId) ?? {};
}

export async function saveBuild(userId: string, build: Record<string, string | null>): Promise<Record<string, string | null>> {
  // Keep only known categories; values must be strings or null.
  const clean: Record<string, string | null> = {};
  for (const cat of CHARACTER_CATEGORIES) {
    const v = (build as any)[cat];
    if (v === null || typeof v === 'string') clean[cat] = v || null;
  }
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(`INSERT INTO user_character_build(user_id,build,updated_at) VALUES ($1,$2,now()) ON CONFLICT (user_id) DO UPDATE SET build=$2, updated_at=now()`, [userId, JSON.stringify(clean)]);
  } else {
    memBuilds.set(userId, clean);
  }
  return clean;
}
