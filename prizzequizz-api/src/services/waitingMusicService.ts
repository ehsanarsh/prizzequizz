/* MUSIC FOR THE WAITING ROOM.
 *
 * «یه قسمت در اتاق انتظار آخرین بازمانده اضافه میشه به نام پخش موزیک و
 * موزیک‌هایی که از پنل ادمین آپلود میشه به صورت تصادفی پخش میشه بدون نام و
 * مشخصات.»
 *
 * The operator uploads tracks in the panel; the room plays them at random while
 * people wait. TO THE PLAYER THEY ARE ANONYMOUS: the list handed to the game
 * carries an id and a URL and nothing else — no title, no artist, no duration —
 * because the player was promised music, not a library. The panel keeps a title
 * so the operator can tell their own files apart, and that title never leaves
 * the panel's own endpoint.
 *
 * The bytes live in their own table, like topic artwork, and are served from
 * their own URL with a long cache and RANGE SUPPORT — without ranges Safari on
 * iOS will not play an audio element at all, which would make the whole feature
 * silent on half the phones the game runs on.
 */
import { createHash } from 'node:crypto';
import { getPgPool } from '../database/postgres.js';
import { id } from '../utils/id.js';

/** «حجم فایل رو کم گذاشتی باید ۱۵ مگابایت میزاشتی، الان فایلای من حداقل ۱۰
 *  مگابایت هستن.» A file travels as base64, which costs a third more again, so
 *  fifteen megabytes here means about twenty on the wire — the route's own body
 *  cap and nginx's `client_max_body_size` are both set above that. */
export const MUSIC_MAX_BYTES = 15 * 1024 * 1024;

const ALLOWED = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-wav']);

export interface MusicTrack {
  id: string;
  /** The operator's own label. Never sent to the game. */
  title: string;
  mime: string;
  bytes: number;
  etag: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
}
export interface StoredTrack extends MusicTrack { data: Buffer }

export class MusicError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'MusicError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

const mem = new Map<string, StoredTrack>();
let _schemaReady = false;

async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS waiting_music (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    mime VARCHAR(32) NOT NULL,
    bytes INT NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    etag VARCHAR(64) NOT NULL DEFAULT '',
    enabled BOOLEAN NOT NULL DEFAULT true,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  /* The same rule as everywhere else here: CREATE TABLE IF NOT EXISTS does
     nothing to a table that already exists, so every column that could be added
     after the first release is repeated as an ALTER — see schemaUpgrade.test. */
  for (const col of [
    `title TEXT NOT NULL DEFAULT ''`,
    `bytes INT NOT NULL DEFAULT 0`,
    `etag VARCHAR(64) NOT NULL DEFAULT ''`,
    `enabled BOOLEAN NOT NULL DEFAULT true`,
    `sort_order INT NOT NULL DEFAULT 0`,
    `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  ]) {
    await pool.query(`ALTER TABLE waiting_music ADD COLUMN IF NOT EXISTS ${col}`);
  }
  _schemaReady = true;
}

const rowToTrack = (r: any): MusicTrack => ({
  id: String(r.id), title: String(r.title || ''), mime: String(r.mime || 'audio/mpeg'),
  bytes: Number(r.bytes) || 0, etag: String(r.etag || ''),
  enabled: r.enabled !== false, sortOrder: Number(r.sort_order) || 0,
  createdAt: new Date(r.created_at).toISOString()
});

/** Parse and check a `data:audio/...;base64,...` upload. */
export function parseAudioDataUri(dataUri: string): { mime: string; buf: Buffer } {
  const m = /^data:([a-z0-9/+.-]+);base64,([\s\S]+)$/i.exec(String(dataUri || '').trim());
  if (!m) throw new MusicError('AUDIO_INVALID', 'فرمت فایل صوتی نامعتبر است.');
  const mime = m[1]!.toLowerCase();
  if (!ALLOWED.has(mime)) throw new MusicError('AUDIO_TYPE_INVALID', 'فقط MP3، M4A/AAC، OGG یا WAV پذیرفته می‌شود.');
  const buf = Buffer.from(m[2]!, 'base64');
  if (!buf.length) throw new MusicError('AUDIO_EMPTY', 'فایل صوتی خالی است.');
  if (buf.length > MUSIC_MAX_BYTES) {
    throw new MusicError('AUDIO_TOO_LARGE', `حجم فایل باید کمتر از ${Math.round(MUSIC_MAX_BYTES / (1024 * 1024))} مگابایت باشد.`);
  }
  if (!magicOk(mime, buf)) throw new MusicError('AUDIO_CORRUPT', 'محتوای فایل با فرمت اعلام‌شده هم‌خوانی ندارد.');
  return { mime, buf };
}

/* Magic bytes, so a renamed file cannot be stored and then served back from our
   own origin as audio. Each container is recognised by its own header. */
function magicOk(mime: string, buf: Buffer): boolean {
  const ascii = (from: number, to: number) => buf.toString('ascii', from, to);
  const isMp3 = ascii(0, 3) === 'ID3' || (buf[0] === 0xff && ((buf[1]! & 0xe0) === 0xe0));
  const isMp4 = buf.length > 12 && ascii(4, 8) === 'ftyp';
  const isOgg = ascii(0, 4) === 'OggS';
  const isWav = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  const isWebm = buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  return ((mime === 'audio/mpeg' || mime === 'audio/mp3') && isMp3) ||
    ((mime === 'audio/mp4' || mime === 'audio/aac') && (isMp4 || isMp3)) ||
    (mime === 'audio/ogg' && isOgg) ||
    (mime === 'audio/webm' && isWebm) ||
    ((mime === 'audio/wav' || mime === 'audio/x-wav') && isWav);
}

export function musicUrl(trackId: string, etag: string): string {
  return `/v1/waiting-music/${encodeURIComponent(trackId)}?v=${encodeURIComponent(etag.slice(0, 12))}`;
}

/* THE SAME CHECKS, WITHOUT THE DETOUR THROUGH TEXT.
 * A file sent as base64 inside JSON is a third bigger on the wire and is copied
 * several times over on the way — by the encoder, by JSON.stringify, and by the
 * request body itself. For a ten-megabyte track that is the difference between
 * an upload that arrives and one that dies in the browser. Raw bytes go through
 * exactly the same validation; only the wrapping is gone. */
export function checkAudio(mime: string, buf: Buffer): { mime: string; buf: Buffer } {
  const type = String(mime || '').toLowerCase().split(';')[0]!.trim();
  if (!ALLOWED.has(type)) throw new MusicError('AUDIO_TYPE_INVALID', 'فقط MP3، M4A/AAC، OGG یا WAV پذیرفته می‌شود.');
  if (!buf.length) throw new MusicError('AUDIO_EMPTY', 'فایل صوتی خالی است.');
  if (buf.length > MUSIC_MAX_BYTES) {
    throw new MusicError('AUDIO_TOO_LARGE', `حجم فایل باید کمتر از ${Math.round(MUSIC_MAX_BYTES / (1024 * 1024))} مگابایت باشد.`);
  }
  if (!magicOk(type, buf)) throw new MusicError('AUDIO_CORRUPT', 'محتوای فایل با فرمت اعلام‌شده هم‌خوانی ندارد.');
  return { mime: type, buf };
}

export async function addTrackBytes(input: { title?: unknown; mime: string; buf: Buffer }): Promise<MusicTrack> {
  const { mime, buf } = checkAudio(input.mime, input.buf);
  return storeTrack(String(input.title ?? ''), mime, buf);
}

export async function addTrack(input: { title?: unknown; audio?: unknown; sortOrder?: unknown }): Promise<MusicTrack> {
  const { mime, buf } = parseAudioDataUri(String(input.audio ?? ''));
  return storeTrack(String(input.title ?? ''), mime, buf, Number(input.sortOrder) || 0);
}

async function storeTrack(rawTitle: string, mime: string, buf: Buffer, sortOrder = 0): Promise<MusicTrack> {
  const track: StoredTrack = {
    id: id(),
    title: String(rawTitle ?? '').trim().slice(0, 80) || 'قطعهٔ بدون نام',
    mime, bytes: buf.length,
    etag: createHash('sha1').update(buf).digest('hex').slice(0, 32),
    enabled: true, sortOrder,
    createdAt: new Date().toISOString(),
    data: buf
  };
  const pool = pg();
  if (!pool) { mem.set(track.id, track); return stripData(track); }
  await ensureSchema(pool);
  await pool.query(
    `INSERT INTO waiting_music(id,title,mime,bytes,data,etag,enabled,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7)`,
    [track.id, track.title, track.mime, track.bytes, buf.toString('base64'), track.etag, track.sortOrder]
  );
  /* Already decoded and in hand — the operator's own «play» button on the panel
     is usually the very next request for it. */
  cachePut(track);
  return stripData(track);
}

function stripData(t: StoredTrack): MusicTrack {
  const { data, ...rest } = t;
  void data;
  return rest;
}

/** The operator's list: everything, switched on or off, with its title. */
export async function listTracks(): Promise<MusicTrack[]> {
  const pool = pg();
  if (!pool) {
    return [...mem.values()].map(stripData)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `SELECT id,title,mime,bytes,etag,enabled,sort_order,created_at FROM waiting_music ORDER BY sort_order, created_at`);
  return rows.map(rowToTrack);
}

/* WHAT THE GAME GETS: a URL and nothing else.
 * «بدون نام و مشخصات» — so the player's list carries no title, and cannot,
 * because the title is not in the payload at all. */
export async function playlistForPlayers(): Promise<Array<{ id: string; url: string }>> {
  const rows = (await listTracks()).filter((t) => t.enabled);
  return rows.map((t) => ({ id: t.id, url: musicUrl(t.id, t.etag) }));
}

/* THE MUSIC MUST NOT COST THE GAME ANYTHING.
 *
 * «نباید رو سرعت بازی تاثیر منفی بزاره.» A browser does not fetch an audio file
 * once — it opens with a range, then asks for more as it plays, several requests
 * for one track. Reading fifteen megabytes out of Postgres and decoding it from
 * base64 on each of those, while matches are being run in the same process, is
 * exactly the kind of background work that turns into a slow answer somewhere
 * else.
 *
 * So a decoded track is kept, and the ones asked for most recently stay. The
 * cache is bounded in BYTES rather than in entries, because the entries are
 * enormous and a count would not bound anything: two 15MB tracks and twenty
 * 200KB ones are very different things to hold. Nothing here is authoritative —
 * it is dropped whenever a track is written or removed. */
let CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Test seam: the cap in bytes, so eviction can be exercised without moving
 *  sixty-four megabytes of audio through a test. */
export function _setMusicCacheCap(bytes: number): void { CACHE_MAX_BYTES = bytes; cacheDrop(); }
const cache = new Map<string, StoredTrack>();   // insertion order = age
let cacheBytes = 0;
function cacheGet(id: string): StoredTrack | null {
  const hit = cache.get(id);
  if (!hit) return null;
  cache.delete(id); cache.set(id, hit);         // touched → newest
  return hit;
}
function cachePut(t: StoredTrack): void {
  if (t.data.length > CACHE_MAX_BYTES) return;  // one track bigger than the cache
  if (cache.has(t.id)) cacheBytes -= cache.get(t.id)!.data.length;
  cache.set(t.id, t); cacheBytes += t.data.length;
  for (const [id, held] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(id); cacheBytes -= held.data.length;
  }
}
function cacheDrop(id?: string): void {
  if (id) { const held = cache.get(id); if (held) { cache.delete(id); cacheBytes -= held.data.length; } return; }
  cache.clear(); cacheBytes = 0;
}
/** What the cache is holding — for tests and for the panel's own curiosity. */
export function _musicCacheStats(): { tracks: number; bytes: number } {
  return { tracks: cache.size, bytes: cacheBytes };
}

export async function getTrack(trackId: string): Promise<StoredTrack | null> {
  const key = String(trackId ?? '');
  if (!key) return null;
  const pool = pg();
  if (!pool) return mem.get(key) ?? null;
  const hit = cacheGet(key);
  if (hit) return hit;
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT * FROM waiting_music WHERE id=$1`, [key]);
  const r = rows[0];
  if (!r) return null;
  const track: StoredTrack = { ...rowToTrack(r), data: Buffer.from(r.data, 'base64') };
  cachePut(track);
  return track;
}

export async function setTrackEnabled(trackId: string, enabled: boolean): Promise<MusicTrack> {
  cacheDrop(trackId);            // its `enabled` is part of what the file route reads
  const pool = pg();
  if (!pool) {
    const t = mem.get(trackId);
    if (!t) throw new MusicError('TRACK_NOT_FOUND', 'این قطعه پیدا نشد.');
    t.enabled = !!enabled;
    return stripData(t);
  }
  await ensureSchema(pool);
  const { rows } = await pool.query(
    `UPDATE waiting_music SET enabled=$2 WHERE id=$1
     RETURNING id,title,mime,bytes,etag,enabled,sort_order,created_at`, [trackId, !!enabled]);
  if (!rows[0]) throw new MusicError('TRACK_NOT_FOUND', 'این قطعه پیدا نشد.');
  return rowToTrack(rows[0]);
}

export async function removeTrack(trackId: string): Promise<boolean> {
  cacheDrop(trackId);
  const pool = pg();
  if (!pool) return mem.delete(trackId);
  await ensureSchema(pool);
  const { rowCount } = await pool.query(`DELETE FROM waiting_music WHERE id=$1`, [trackId]);
  return (rowCount ?? 0) > 0;
}

/** Test seam. */
export function _resetMusic(): void { mem.clear(); cacheDrop(); _schemaReady = false; }
