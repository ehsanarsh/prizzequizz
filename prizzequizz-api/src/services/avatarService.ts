/* USER AVATAR STORAGE.
 *
 * The client shrinks the picture BEFORE upload (canvas → WebP, falling back to
 * JPEG) so what arrives here is already a small square thumbnail — we never
 * store the original camera file. This service is the last line of defence: it
 * re-checks the format and hard-caps the size, then keeps the bytes in their own
 * table (not on the users row) so user reads stay light.
 *
 * Avatars are served from GET /v1/users/:id/avatar with a strong ETag and a long
 * cache lifetime; the URL carries a ?v= stamp that changes on every upload, so
 * a new photo appears instantly while old ones stay cached. */
import { getPgPool } from '../database/postgres.js';
import { createHash } from 'node:crypto';

/** Hard ceiling AFTER client-side compression. A 256px WebP is normally 8–25KB. */
export const AVATAR_MAX_BYTES = 120 * 1024;
const ALLOWED = new Set(['image/avif', 'image/webp', 'image/jpeg', 'image/png']);

export interface StoredAvatar { userId: string; mime: string; bytes: number; data: Buffer; etag: string; updatedAt: number; }

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS user_avatars (
    user_id TEXT PRIMARY KEY,
    mime VARCHAR(32) NOT NULL,
    bytes INT NOT NULL,
    data TEXT NOT NULL,
    etag VARCHAR(64) NOT NULL,
    updated_at BIGINT NOT NULL)`);
  _schemaReady = true;
}

const mem = new Map<string, StoredAvatar>();

/* Version cache: userId → updated_at stamp (or null when the user has no photo).
 * Every screen that draws a player needs the avatar URL, so we keep the lookup
 * off the database for a minute at a time and drop the entry on every write. */
const versionCache = new Map<string, { v: number | null; at: number }>();
const VERSION_TTL_MS = 60_000;

export class AvatarError extends Error { constructor(public code: string, message: string) { super(message); } }

/** Parse a `data:image/...;base64,...` URI into a validated buffer. */
export function parseDataUri(dataUri: string): { mime: string; buf: Buffer } {
  const m = /^data:([a-z0-9/+.-]+);base64,([\s\S]+)$/i.exec(String(dataUri || '').trim());
  if (!m) throw new AvatarError('IMAGE_INVALID', 'فرمت تصویر نامعتبر است.');
  const mime = m[1]!.toLowerCase();
  if (!ALLOWED.has(mime)) throw new AvatarError('IMAGE_TYPE_INVALID', 'فقط AVIF، WebP، JPEG یا PNG پذیرفته می‌شود.');
  const buf = Buffer.from(m[2]!, 'base64');
  if (!buf.length) throw new AvatarError('IMAGE_EMPTY', 'تصویر خالی است.');
  if (buf.length > AVATAR_MAX_BYTES) throw new AvatarError('IMAGE_TOO_LARGE', `حجم تصویر باید کمتر از ${Math.round(AVATAR_MAX_BYTES / 1024)} کیلوبایت باشد.`);
  // Magic-byte check so a renamed/forged mime can't slip through.
  const okMagic =
    (mime === 'image/png' && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) ||
    (mime === 'image/jpeg' && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) ||
    (mime === 'image/webp' && buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') ||
    // AVIF is an ISO-BMFF file: a `ftyp` box whose major brand is an AV1 brand.
    (mime === 'image/avif' && buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis', 'mif1', 'msf1'].includes(buf.toString('ascii', 8, 12)));
  if (!okMagic) throw new AvatarError('IMAGE_CORRUPT', 'محتوای تصویر با فرمت اعلام‌شده هم‌خوانی ندارد.');
  return { mime, buf };
}

export async function saveAvatar(userId: string, dataUri: string): Promise<{ url: string; bytes: number; mime: string }> {
  const { mime, buf } = parseDataUri(dataUri);
  const etag = createHash('sha1').update(buf).digest('hex').slice(0, 32);
  const updatedAt = Date.now();
  const b64 = buf.toString('base64');
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO user_avatars(user_id,mime,bytes,data,etag,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET mime=$2,bytes=$3,data=$4,etag=$5,updated_at=$6`,
      [userId, mime, buf.length, b64, etag, updatedAt]);
  } else {
    mem.set(userId, { userId, mime, bytes: buf.length, data: buf, etag, updatedAt });
  }
  versionCache.set(userId, { v: updatedAt, at: Date.now() });
  return { url: avatarUrl(userId, updatedAt), bytes: buf.length, mime };
}

export function avatarUrl(userId: string, version: number): string {
  return `/v1/users/${encodeURIComponent(userId)}/avatar?v=${version}`;
}

export async function getAvatar(userId: string): Promise<StoredAvatar | null> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM user_avatars WHERE user_id=$1`, [userId]);
    const r = rows[0];
    if (!r) return null;
    return { userId, mime: r.mime, bytes: Number(r.bytes), data: Buffer.from(r.data, 'base64'), etag: r.etag, updatedAt: Number(r.updated_at) };
  }
  return mem.get(userId) ?? null;
}

export async function removeAvatar(userId: string): Promise<boolean> {
  versionCache.set(userId, { v: null, at: Date.now() });
  const pool = pg();
  if (pool) { await ensureSchema(pool); const { rowCount } = await pool.query(`DELETE FROM user_avatars WHERE user_id=$1`, [userId]); return (rowCount ?? 0) > 0; }
  return mem.delete(userId);
}

/* ---- Lookups used by every screen that draws a player ----
 * The photo itself lives in its own table, so the users row never needs an
 * avatar column and there is exactly one source of truth. */

/** The photo URL for a user, or null when they haven't uploaded one. */
export async function avatarUrlFor(userId: string): Promise<string | null> {
  if (!userId) return null;
  const hit = versionCache.get(userId);
  if (hit && Date.now() - hit.at < VERSION_TTL_MS) return hit.v == null ? null : avatarUrl(userId, hit.v);
  let v: number | null = null;
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(`SELECT updated_at FROM user_avatars WHERE user_id=$1`, [userId]);
      v = rows[0] ? Number(rows[0].updated_at) : null;
    } catch { v = null; }
  } else {
    v = mem.get(userId)?.updatedAt ?? null;
  }
  versionCache.set(userId, { v, at: Date.now() });
  return v == null ? null : avatarUrl(userId, v);
}

/** Batch variant for player lists (leaderboard, room grid, friends). */
export async function avatarUrlsFor(userIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return out;
  const missing: string[] = [];
  for (const id of ids) {
    const hit = versionCache.get(id);
    if (hit && Date.now() - hit.at < VERSION_TTL_MS) { if (hit.v != null) out.set(id, avatarUrl(id, hit.v)); }
    else missing.push(id);
  }
  if (!missing.length) return out;
  const pool = pg();
  const now = Date.now();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(`SELECT user_id, updated_at FROM user_avatars WHERE user_id = ANY($1::text[])`, [missing]);
      const found = new Map<string, number>(rows.map((r: any) => [String(r.user_id), Number(r.updated_at)]));
      for (const id of missing) {
        const v = found.get(id) ?? null;
        versionCache.set(id, { v, at: now });
        if (v != null) out.set(id, avatarUrl(id, v));
      }
    } catch { /* leave those users on their fallback avatar */ }
  } else {
    for (const id of missing) {
      const v = mem.get(id)?.updatedAt ?? null;
      versionCache.set(id, { v, at: now });
      if (v != null) out.set(id, avatarUrl(id, v));
    }
  }
  return out;
}
