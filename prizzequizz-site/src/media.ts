/* THE MEDIA LIBRARY — the images the site is made of.
 *
 * Every image field in the panel used to be a text box holding a URL, which
 * meant the person writing the copy had to upload the picture somewhere else
 * first and paste a link back. That is not control of the site; it is control
 * of a string.
 *
 * Bytes live in Postgres, the same way the game stores its category art. It
 * costs a little space and buys a lot: no volume to mount, nothing to lose when
 * the container is recreated, and the site keeps working on a machine with no
 * writable disk at all. A brochure site's picture count is small enough that
 * this trade is not close.
 *
 * Uploads are checked by their MAGIC BYTES, not by what the browser calls them.
 * A file claiming to be a PNG is only stored if it actually begins like one —
 * a content-type header is a request, not a fact.
 */
import { getPgPool } from './db.js';
import { SiteError } from './content.js';

export interface MediaItem {
  id: string;
  filename: string;
  mime: string;
  size: number;
  alt: string;
  createdAt: string;
  /** Where the site serves it from. Paste-able into any image field. */
  url: string;
}

/** Big enough for a hero photo, small enough that nobody can fill the disk
 *  with one request. */
export const MEDIA_MAX_BYTES = 3_000_000;

/* Only formats a browser renders inline and that we can verify by their first
 * bytes. No SVG: it is a document, it can carry script, and it would be served
 * from the site's own origin. */
const KINDS: Array<{ mime: string; ext: string; magic: (b: Buffer) => boolean }> = [
  { mime: 'image/png', ext: 'png', magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', magic: (b) => b.length > 6 && b.subarray(0, 6).toString('ascii').startsWith('GIF8') },
  { mime: 'image/webp', ext: 'webp', magic: (b) => b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { mime: 'image/x-icon', ext: 'ico', magic: (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 }
];

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schema: Promise<void> | null = null;
function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  _schema ??= create(pool).catch((e) => { _schema = null; throw e; });
  return _schema;
}
async function create(pool: ReturnType<typeof getPgPool>): Promise<void> {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS site_media (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INT NOT NULL,
      alt TEXT NOT NULL DEFAULT '',
      bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code !== '23505' && code !== '42P07' && code !== '42710') throw e;
  }
}

/* In-memory fallback so the panel and the tests work without Postgres. */
const _mem = new Map<string, { item: MediaItem; bytes: Buffer }>();

function slugName(raw: string, ext: string): string {
  const base = String(raw || 'image').replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return (base || 'image') + '.' + ext;
}

function newId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function mediaUrl(id: string): string { return '/media/' + id; }

/** Accepts a data: URI (what a file input gives us after FileReader) or raw
 *  base64, and refuses anything whose bytes do not match a format we serve. */
export function parseUpload(dataUri: string): { mime: string; ext: string; bytes: Buffer } {
  const raw = String(dataUri ?? '');
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(raw);
  const b64 = m ? m[3]! : raw;
  let bytes: Buffer;
  try { bytes = Buffer.from(b64, 'base64'); }
  catch { throw new SiteError('MEDIA_INVALID', 'فایل خوانده نشد.'); }
  if (!bytes.length) throw new SiteError('MEDIA_INVALID', 'فایل خالی است.');
  if (bytes.length > MEDIA_MAX_BYTES) {
    throw new SiteError('MEDIA_TOO_LARGE',
      'حجم تصویر باید کمتر از ' + Math.round(MEDIA_MAX_BYTES / 1_000_000) + ' مگابایت باشد.');
  }
  /* The declared type is a hint we check, never trust: the bytes decide. */
  const kind = KINDS.find((k) => k.magic(bytes));
  if (!kind) throw new SiteError('MEDIA_TYPE', 'فقط PNG، JPG، GIF، WebP و ICO پذیرفته می‌شود.');
  return { mime: kind.mime, ext: kind.ext, bytes };
}

export async function saveMedia(input: { data: string; filename?: string; alt?: string }): Promise<MediaItem> {
  const { mime, ext, bytes } = parseUpload(input.data);
  const id = newId();
  const item: MediaItem = {
    id,
    filename: slugName(input.filename ?? '', ext),
    mime,
    size: bytes.length,
    alt: String(input.alt ?? '').slice(0, 300),
    createdAt: new Date().toISOString(),
    url: mediaUrl(id)
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO site_media(id,filename,mime,size,alt,bytes) VALUES($1,$2,$3,$4,$5,$6)`,
      [item.id, item.filename, item.mime, item.size, item.alt, bytes]);
  } else _mem.set(id, { item, bytes });
  return item;
}

export async function listMedia(limit = 300): Promise<MediaItem[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    /* Never select `bytes` here — the list is rendered on every panel load and
     * pulling every image through it would be pointless traffic. */
    const { rows } = await pool.query(
      `SELECT id,filename,mime,size,alt,created_at FROM site_media ORDER BY created_at DESC LIMIT $1`, [limit]);
    return rows.map((r: any) => ({
      id: r.id, filename: r.filename, mime: r.mime, size: Number(r.size), alt: r.alt ?? '',
      createdAt: new Date(r.created_at).toISOString(), url: mediaUrl(r.id)
    }));
  }
  return [..._mem.values()].map((v) => v.item)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function getMediaBytes(id: string): Promise<{ mime: string; bytes: Buffer } | null> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT mime,bytes FROM site_media WHERE id=$1`, [id]);
    if (!rows[0]) return null;
    return { mime: rows[0].mime, bytes: Buffer.from(rows[0].bytes) };
  }
  const hit = _mem.get(id);
  return hit ? { mime: hit.item.mime, bytes: hit.bytes } : null;
}

export async function updateMedia(id: string, alt: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`UPDATE site_media SET alt=$2 WHERE id=$1`, [id, String(alt ?? '').slice(0, 300)]);
    return (rowCount ?? 0) > 0;
  }
  const hit = _mem.get(id);
  if (!hit) return false;
  hit.item.alt = String(alt ?? '').slice(0, 300);
  return true;
}

export async function deleteMedia(id: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM site_media WHERE id=$1`, [id]);
    return (rowCount ?? 0) > 0;
  }
  return _mem.delete(id);
}

/** Test seam. */
export function _resetMedia(): void { _mem.clear(); }
