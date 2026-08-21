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

/** nginx in front of the API allows 12m; base64 costs a third on top, so this
 *  is the largest file that can actually arrive. A three-minute MP3 at 128kbps
 *  is about 3MB, so this fits ordinary music with room to spare. */
export const MUSIC_MAX_BYTES = 6 * 1024 * 1024;

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
  /* Magic bytes, so a renamed file cannot be stored and then served back from
     our own origin as audio. Each container is recognised by its own header. */
  const ascii = (from: number, to: number) => buf.toString('ascii', from, to);
  const isMp3 = ascii(0, 3) === 'ID3' || (buf[0] === 0xff && ((buf[1]! & 0xe0) === 0xe0));
  const isMp4 = buf.length > 12 && ascii(4, 8) === 'ftyp';
  const isOgg = ascii(0, 4) === 'OggS';
  const isWav = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  const isWebm = buf.length > 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  const okMagic =
    ((mime === 'audio/mpeg' || mime === 'audio/mp3') && isMp3) ||
    ((mime === 'audio/mp4' || mime === 'audio/aac') && (isMp4 || isMp3)) ||
    (mime === 'audio/ogg' && isOgg) ||
    (mime === 'audio/webm' && isWebm) ||
    ((mime === 'audio/wav' || mime === 'audio/x-wav') && isWav);
  if (!okMagic) throw new MusicError('AUDIO_CORRUPT', 'محتوای فایل با فرمت اعلام‌شده هم‌خوانی ندارد.');
  return { mime, buf };
}

export function musicUrl(trackId: string, etag: string): string {
  return `/v1/waiting-music/${encodeURIComponent(trackId)}?v=${encodeURIComponent(etag.slice(0, 12))}`;
}

export async function addTrack(input: { title?: unknown; audio?: unknown; sortOrder?: unknown }): Promise<MusicTrack> {
  const { mime, buf } = parseAudioDataUri(String(input.audio ?? ''));
  const track: StoredTrack = {
    id: id(),
    title: String(input.title ?? '').trim().slice(0, 80) || 'قطعهٔ بدون نام',
    mime, bytes: buf.length,
    etag: createHash('sha1').update(buf).digest('hex').slice(0, 32),
    enabled: true, sortOrder: Number(input.sortOrder) || 0,
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

export async function getTrack(trackId: string): Promise<StoredTrack | null> {
  const key = String(trackId ?? '');
  if (!key) return null;
  const pool = pg();
  if (!pool) return mem.get(key) ?? null;
  await ensureSchema(pool);
  const { rows } = await pool.query(`SELECT * FROM waiting_music WHERE id=$1`, [key]);
  const r = rows[0];
  if (!r) return null;
  return { ...rowToTrack(r), data: Buffer.from(r.data, 'base64') };
}

export async function setTrackEnabled(trackId: string, enabled: boolean): Promise<MusicTrack> {
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
  const pool = pg();
  if (!pool) return mem.delete(trackId);
  await ensureSchema(pool);
  const { rowCount } = await pool.query(`DELETE FROM waiting_music WHERE id=$1`, [trackId]);
  return (rowCount ?? 0) > 0;
}

/** Test seam. */
export function _resetMusic(): void { mem.clear(); _schemaReady = false; }
