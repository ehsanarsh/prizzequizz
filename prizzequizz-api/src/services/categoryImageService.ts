/* TOPIC ARTWORK.
 *
 * Every category has always had an emoji. This adds a real picture alongside it,
 * uploaded from the admin panel and shown wherever a topic is named — the duel's
 * topic pick, the Last Survivor topic list, the record-mode board.
 *
 * The bytes live in their own table rather than in `gameConfig.categories`,
 * which is deliberate: the categories array is part of the public config that
 * every client fetches on boot, and twenty base64 images inside it would turn a
 * 4KB payload into half a megabyte on every cold start. The config carries only
 * a URL; the picture is fetched once and then cached hard.
 *
 * Serving mirrors user avatars: a strong ETag, a long max-age, and a ?v= stamp
 * that changes on every upload — so a new picture appears at once and old ones
 * are never re-downloaded.
 *
 * Keyed by category NAME. Renaming a topic in the panel therefore orphans its
 * picture, which `renameCategoryImage` handles so the admin does not have to
 * upload it again. */
import { createHash } from 'node:crypto';
import { getPgPool } from '../database/postgres.js';

/** Hard ceiling AFTER the panel's client-side resize. Topic art renders at
 *  around 64px, so a 256px WebP (10–30KB) is plenty; this is the backstop. */
export const CATEGORY_IMAGE_MAX_BYTES = 200 * 1024;
const ALLOWED = new Set(['image/avif', 'image/webp', 'image/jpeg', 'image/png', 'image/svg+xml']);

export interface StoredCategoryImage {
  name: string; mime: string; bytes: number; data: Buffer; etag: string; updatedAt: number;
}

export class CategoryImageError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS category_images (
    name TEXT PRIMARY KEY,
    mime VARCHAR(32) NOT NULL,
    bytes INT NOT NULL,
    data TEXT NOT NULL,
    etag VARCHAR(64) NOT NULL,
    updated_at BIGINT NOT NULL)`);
  _schemaReady = true;
}

const mem = new Map<string, StoredCategoryImage>();

/* Which topics have a picture, and at what version. Every topic list in the
 * game needs this, and it changes only when an admin uploads — so it is read
 * once and kept, then dropped on any write. */
let versionCache: { map: Map<string, number>; at: number } | null = null;
const VERSION_TTL_MS = 60_000;
function dropVersionCache(): void { versionCache = null; }

const key = (name: string) => String(name ?? '').trim();

/** Parse and validate a `data:image/...;base64,...` upload. */
export function parseImageDataUri(dataUri: string): { mime: string; buf: Buffer } {
  const m = /^data:([a-z0-9/+.-]+);base64,([\s\S]+)$/i.exec(String(dataUri || '').trim());
  if (!m) throw new CategoryImageError('IMAGE_INVALID', 'فرمت تصویر نامعتبر است.');
  const mime = m[1]!.toLowerCase();
  if (!ALLOWED.has(mime)) throw new CategoryImageError('IMAGE_TYPE_INVALID', 'فقط WebP، PNG، JPEG، AVIF یا SVG پذیرفته می‌شود.');
  const buf = Buffer.from(m[2]!, 'base64');
  if (!buf.length) throw new CategoryImageError('IMAGE_EMPTY', 'تصویر خالی است.');
  if (buf.length > CATEGORY_IMAGE_MAX_BYTES) {
    throw new CategoryImageError('IMAGE_TOO_LARGE',
      `حجم تصویر باید کمتر از ${Math.round(CATEGORY_IMAGE_MAX_BYTES / 1024)} کیلوبایت باشد.`);
  }
  /* Magic bytes, so a renamed .exe with an image mime cannot be stored and then
   * served back from our own origin. SVG is text, so it is checked by shape. */
  const ascii = (from: number, to: number) => buf.toString('ascii', from, to);
  const okMagic =
    (mime === 'image/png' && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) ||
    (mime === 'image/jpeg' && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) ||
    (mime === 'image/webp' && buf.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') ||
    (mime === 'image/avif' && buf.length > 12 && ascii(4, 8) === 'ftyp' &&
      ['avif', 'avis', 'mif1', 'msf1'].includes(ascii(8, 12))) ||
    (mime === 'image/svg+xml' && /<svg[\s>]/i.test(buf.toString('utf8', 0, Math.min(buf.length, 2048))));
  if (!okMagic) throw new CategoryImageError('IMAGE_CORRUPT', 'محتوای تصویر با فرمت اعلام‌شده هم‌خوانی ندارد.');
  return { mime, buf };
}

export function categoryImageUrl(name: string, version: number): string {
  return `/v1/categories/${encodeURIComponent(key(name))}/image?v=${version}`;
}

export async function saveCategoryImage(name: string, dataUri: string): Promise<{ url: string; bytes: number; mime: string }> {
  const cat = key(name);
  if (!cat) throw new CategoryImageError('CATEGORY_REQUIRED', 'نام موضوع لازم است.');
  const { mime, buf } = parseImageDataUri(dataUri);
  const etag = createHash('sha1').update(buf).digest('hex').slice(0, 32);
  const updatedAt = Date.now();
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO category_images(name,mime,bytes,data,etag,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (name) DO UPDATE SET mime=$2,bytes=$3,data=$4,etag=$5,updated_at=$6`,
      [cat, mime, buf.length, buf.toString('base64'), etag, updatedAt]);
  } else {
    mem.set(cat, { name: cat, mime, bytes: buf.length, data: buf, etag, updatedAt });
  }
  dropVersionCache();
  return { url: categoryImageUrl(cat, updatedAt), bytes: buf.length, mime };
}

export async function getCategoryImage(name: string): Promise<StoredCategoryImage | null> {
  const cat = key(name);
  if (!cat) return null;
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM category_images WHERE name=$1`, [cat]);
    const r = rows[0];
    if (!r) return null;
    return { name: cat, mime: r.mime, bytes: Number(r.bytes), data: Buffer.from(r.data, 'base64'),
             etag: r.etag, updatedAt: Number(r.updated_at) };
  }
  return mem.get(cat) ?? null;
}

export async function removeCategoryImage(name: string): Promise<boolean> {
  const cat = key(name);
  dropVersionCache();
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM category_images WHERE name=$1`, [cat]);
    return (rowCount ?? 0) > 0;
  }
  return mem.delete(cat);
}

/** Carry a picture across a rename, so renaming a topic in the panel does not
 *  silently lose its artwork. No-op when the old name had none. */
export async function renameCategoryImage(from: string, to: string): Promise<boolean> {
  const a = key(from), b = key(to);
  if (!a || !b || a === b) return false;
  const img = await getCategoryImage(a);
  if (!img) return false;
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO category_images(name,mime,bytes,data,etag,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (name) DO UPDATE SET mime=$2,bytes=$3,data=$4,etag=$5,updated_at=$6`,
      [b, img.mime, img.bytes, img.data.toString('base64'), img.etag, Date.now()]);
    await pool.query(`DELETE FROM category_images WHERE name=$1`, [a]);
  } else {
    mem.set(b, { ...img, name: b, updatedAt: Date.now() });
    mem.delete(a);
  }
  dropVersionCache();
  return true;
}

/** name → version stamp, for every topic that has a picture. */
async function versions(): Promise<Map<string, number>> {
  if (versionCache && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.map;
  const map = new Map<string, number>();
  const pool = pg();
  if (pool) {
    try {
      await ensureSchema(pool);
      const { rows } = await pool.query(`SELECT name, updated_at FROM category_images`);
      for (const r of rows) map.set(String(r.name), Number(r.updated_at));
    } catch { /* no table yet → nothing has art, which is a valid answer */ }
  } else {
    for (const [n, v] of mem) map.set(n, v.updatedAt);
  }
  versionCache = { map, at: Date.now() };
  return map;
}

/**
 * The picture URL for one topic, or '' when it has none. Synchronous callers
 * (the public config builder) use `categoryImageUrls` and read from the map.
 */
export async function categoryImageUrlFor(name: string): Promise<string> {
  const v = (await versions()).get(key(name));
  return v ? categoryImageUrl(name, v) : '';
}

/** Picture URLs for every topic that has one, keyed by name. */
export async function categoryImageUrls(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, v] of await versions()) out[name] = categoryImageUrl(name, v);
  return out;
}

/** Test seam. */
export function _resetCategoryImages(): void { mem.clear(); dropVersionCache(); }
