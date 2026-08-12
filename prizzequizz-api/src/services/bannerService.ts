/* BANNERS, ON ANY SCREEN, MANAGED IN ONE PLACE.
 *
 * There were three promo slots, hard-coded to the three ticket screens, and
 * nothing else in the game could carry a banner at all. Adding one to the home
 * screen meant editing the client. This replaces that with a list: a banner
 * names the screen it belongs to, and any screen can have one.
 *
 * A banner can be a picture, an animated GIF, or a VIDEO. The kind is not
 * something the operator has to declare — a .mp4 is a video whether or not
 * anybody ticked a box — so it is worked out from the source and the client is
 * told what to render. Guessing wrong once means a black rectangle where a
 * picture should be, so the detection is explicit and tested.
 *
 * MIGRATION: the three old slots are read once and become three banners, so an
 * operator who had set them up does not lose them and does not have to do
 * anything. The old endpoint keeps working for a client that has not updated.
 */
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { getPromos, PROMO_SLOTS } from './ticketPromoService.js';

/** Where a banner can appear. The client has a host element for each of these. */
export const BANNER_SLOTS = [
  'home', 'shop', 'duel', 'lastSurvivor', 'rankings', 'friends', 'wallet',
  'missions', 'profile', 'result', 'support'
] as const;
export type BannerSlot = typeof BANNER_SLOTS[number];

export const BANNER_SLOT_LABELS: Record<string, string> = {
  home: 'خانه', shop: 'فروشگاه', duel: 'ورود دوئل', lastSurvivor: 'ورود آخرین بازمانده',
  rankings: 'رنکینگ', friends: 'دوستان', wallet: 'صندوق جایزه', missions: 'مأموریت‌ها',
  profile: 'پروفایل', result: 'صفحهٔ نتیجه', support: 'پشتیبانی'
};

export type BannerMedia = 'none' | 'image' | 'gif' | 'video';

export interface Banner {
  id: string;
  slot: string;
  enabled: boolean;
  title: string;
  text: string;
  /** data: URI or https URL. A .mp4/.webm here makes it a video banner. */
  media: string;
  /** Still shown while a video loads, and if it cannot play at all. */
  poster: string;
  /** In-app screen id to open on tap. Empty = not tappable. */
  link: string;
  /** Videos only. Muted autoplay is the only kind a phone will start by itself. */
  autoplay: boolean;
  loop: boolean;
  /** Lower sorts first when a slot has more than one. */
  order: number;
  updatedAt: string;
}

/* A banner is inlined into a JSON response, so it cannot be a film. Video gets
 * more room than a still because even a short clip is much larger, but both are
 * bounded — an operator pasting a 20MB clip should be told, not silently make
 * every screen slow. */
export const BANNER_IMAGE_MAX_BYTES = 400 * 1024;
export const BANNER_VIDEO_MAX_BYTES = 3 * 1024 * 1024;

export class BannerError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'BannerError'; }
}

/** What this source actually is. Never trusts a caller-supplied kind. */
export function mediaKind(src: string): BannerMedia {
  const s = String(src ?? '').trim();
  if (!s) return 'none';
  if (s.startsWith('data:')) {
    const m = /^data:([^;,]+)/.exec(s);
    const mime = (m && m[1] ? m[1] : '').toLowerCase();
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'image/gif') return 'gif';
    if (mime.startsWith('image/')) return 'image';
    return 'none';
  }
  /* A URL may carry a query string; the extension is what precedes it. */
  const path = s.split('?')[0]!.split('#')[0]!.toLowerCase();
  if (/\.(mp4|webm|ogv|mov|m4v)$/.test(path)) return 'video';
  if (/\.gif$/.test(path)) return 'gif';
  if (/\.(png|jpe?g|webp|avif|bmp|svg)$/.test(path)) return 'image';
  /* An https URL with no recognisable extension is treated as an image: that is
   * what a CDN link usually is, and an <img> that fails is a hidden element
   * rather than a broken player. */
  return /^https?:\/\//.test(s) ? 'image' : 'none';
}

function approxBytes(src: string): number {
  const s = String(src ?? '');
  const comma = s.indexOf(',');
  if (s.startsWith('data:') && comma > 0) return Math.floor((s.length - comma - 1) * 0.75);
  return 0;   // a URL costs us nothing to serve
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS banners (
    id TEXT PRIMARY KEY,
    slot TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    media TEXT NOT NULL DEFAULT '',
    poster TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    autoplay BOOLEAN NOT NULL DEFAULT true,
    loop BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_banners_slot ON banners(slot, enabled)`);
  _schemaReady = true;
}

const mem: Banner[] = [];
let _migrated = false;

/** Test seam. */
export function _resetBanners(): void { mem.length = 0; _migrated = false; _schemaReady = false; }

function fromRow(r: any): Banner {
  return {
    id: String(r.id), slot: String(r.slot), enabled: r.enabled !== false,
    title: r.title ?? '', text: r.text ?? '', media: r.media ?? '', poster: r.poster ?? '',
    link: r.link ?? '', autoplay: r.autoplay !== false, loop: r.loop !== false,
    order: Number(r.sort_order) || 0,
    updatedAt: r.updated_at?.toISOString?.() ?? String(r.updated_at)
  };
}

/* The three old promo slots become three banners, ONCE EVER.
 *
 * "Once" cannot mean "whenever the list is empty", which is what this did at
 * first and what the delete test caught: an operator who removed every banner
 * would find the three old promos back on the next page load, with no way to
 * be rid of them. So the fact that the migration ran is recorded, and an empty
 * list afterwards is simply an empty list.
 *
 * The marker lives in ticket_promos, which is already a keyed JSON store and
 * is exactly the thing being migrated away from. */
const MIGRATION_MARKER = 'banners_migrated_v1';

async function migrationDone(): Promise<boolean> {
  const pool = pg();
  if (!pool) return _migrated;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ticket_promos (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await pool.query('SELECT 1 FROM ticket_promos WHERE id=$1', [MIGRATION_MARKER]);
    return !!rows[0];
  } catch { return true; }   // cannot tell → do not migrate; never duplicate
}
async function markMigrated(): Promise<void> {
  const pool = pg();
  if (!pool) return;
  try {
    await pool.query(`INSERT INTO ticket_promos(id,data) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`,
      [MIGRATION_MARKER, JSON.stringify({ at: new Date().toISOString() })]);
  } catch { /* best effort: the in-process flag still stops a repeat this run */ }
}

async function migrateOnce(): Promise<void> {
  if (_migrated) return;
  _migrated = true;
  try {
    if (await migrationDone()) return;
    const existing = await listAll();
    if (existing.length) { await markMigrated(); return; }   // already has banners of its own
    const promos: any = await getPromos();
    for (const slot of PROMO_SLOTS) {
      const p = promos?.[slot];
      if (!p || (!p.image && !p.title && !p.text)) continue;
      await saveBanner({ slot, enabled: p.enabled !== false, title: p.title || '', text: p.text || '', media: p.image || '', link: p.link || '' });
    }
    await markMigrated();
    logger.info('banners_migrated_from_promos', {});
  } catch (e) {
    logger.warn('banner_migration_failed', { message: e instanceof Error ? e.message : 'unknown' });
  }
}

async function listAll(): Promise<Banner[]> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query('SELECT * FROM banners ORDER BY slot, sort_order, updated_at');
    return rows.map(fromRow);
  }
  return [...mem].sort((a, b) => a.slot.localeCompare(b.slot) || a.order - b.order);
}

/** Operator view: everything, including the switched-off ones. */
export async function listBanners(): Promise<Banner[]> {
  await migrateOnce();
  return listAll();
}

/** What the game should actually show, grouped by screen. */
export async function activeBanners(): Promise<Record<string, Array<Omit<Banner, 'updatedAt'> & { kind: BannerMedia }>>> {
  const rows = (await listBanners()).filter((b) => b.enabled && (b.media || b.title || b.text));
  const out: Record<string, any[]> = {};
  for (const b of rows) {
    const kind = mediaKind(b.media);
    (out[b.slot] ??= []).push({
      id: b.id, slot: b.slot, enabled: true, title: b.title, text: b.text,
      media: b.media, poster: b.poster, link: b.link,
      autoplay: b.autoplay, loop: b.loop, order: b.order, kind
    });
  }
  return out;
}

export async function saveBanner(input: Partial<Banner> & { slot: string }): Promise<Banner> {
  const slot = String(input.slot ?? '').trim();
  if (!slot) throw new BannerError('SLOT_REQUIRED', 'صفحهٔ بنر را انتخاب کن.');
  if (!(BANNER_SLOTS as readonly string[]).includes(slot)) throw new BannerError('SLOT_UNKNOWN', 'این صفحه برای بنر تعریف نشده است.');

  const media = String(input.media ?? '');
  const kind = mediaKind(media);
  const bytes = approxBytes(media);
  const cap = kind === 'video' ? BANNER_VIDEO_MAX_BYTES : BANNER_IMAGE_MAX_BYTES;
  if (bytes > cap) {
    throw new BannerError('MEDIA_TOO_LARGE', `حجم ${kind === 'video' ? 'ویدیو' : 'تصویر'} باید کمتر از ${Math.round(cap / 1024)} کیلوبایت باشد.`);
  }
  if (media && kind === 'none') throw new BannerError('MEDIA_UNSUPPORTED', 'فرمت فایل پشتیبانی نمی‌شود. عکس، GIF یا ویدیوی MP4/WebM بگذار.');
  if (approxBytes(String(input.poster ?? '')) > BANNER_IMAGE_MAX_BYTES) throw new BannerError('POSTER_TOO_LARGE', 'حجم تصویر پیش‌نمایش زیاد است.');

  const existing = input.id ? (await listAll()).find((b) => b.id === input.id) : null;
  const row: Banner = {
    id: existing?.id ?? input.id ?? id(),
    slot,
    enabled: input.enabled ?? existing?.enabled ?? true,
    title: String(input.title ?? existing?.title ?? '').slice(0, 120),
    text: String(input.text ?? existing?.text ?? '').slice(0, 300),
    media: input.media !== undefined ? media : (existing?.media ?? ''),
    poster: input.poster !== undefined ? String(input.poster) : (existing?.poster ?? ''),
    link: String(input.link ?? existing?.link ?? '').slice(0, 60),
    autoplay: input.autoplay ?? existing?.autoplay ?? true,
    loop: input.loop ?? existing?.loop ?? true,
    order: Number(input.order ?? existing?.order ?? 0) || 0,
    updatedAt: new Date().toISOString()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO banners(id,slot,enabled,title,text,media,poster,link,autoplay,loop,sort_order,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT (id) DO UPDATE SET slot=$2,enabled=$3,title=$4,text=$5,media=$6,poster=$7,link=$8,autoplay=$9,loop=$10,sort_order=$11,updated_at=now()`,
      [row.id, row.slot, row.enabled, row.title, row.text, row.media, row.poster, row.link, row.autoplay, row.loop, row.order]);
  } else {
    const i = mem.findIndex((b) => b.id === row.id);
    if (i >= 0) mem[i] = row; else mem.push(row);
  }
  return row;
}

export async function removeBanner(bannerId: string): Promise<boolean> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query('DELETE FROM banners WHERE id=$1', [bannerId]);
    return (rowCount ?? 0) > 0;
  }
  const i = mem.findIndex((b) => b.id === bannerId);
  if (i < 0) return false;
  mem.splice(i, 1);
  return true;
}
