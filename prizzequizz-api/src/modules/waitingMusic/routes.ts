/* THE WAITING-ROOM PLAYLIST.
 *
 * Three doors: the operator's (upload, switch on and off, delete), the game's
 * (a list of anonymous URLs), and the audio file itself.
 *
 * The file endpoint answers RANGE requests. That is not a nicety: Safari on iOS
 * opens an <audio> source with `Range: bytes=0-1` and refuses to play anything
 * from a server that answers 200 with the whole body — so without this the
 * feature would be silent on every iPhone.
 */
import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { recordAdmin } from '../../services/adminAuditService.js';
import {
  addTrack, listTracks, playlistForPlayers, getTrack, setTrackEnabled, removeTrack,
  MusicError, MUSIC_MAX_BYTES
} from '../../services/waitingMusicService.js';

export function registerWaitingMusicRoutes(router: Router, base: string): void {
  /* WHAT THE GAME ASKS FOR. No titles, by design: «موزیک‌ها به صورت تصادفی پخش
     میشه بدون نام و مشخصات» — the player is offered music, not a library, and
     the name is not withheld in the client but simply never sent. */
  router.add('GET', `${base}/waiting-music`, async (ctx) => {
    json(ctx.res, 200, { tracks: await playlistForPlayers() });
  });

  /* The audio itself. Public — the URL is unguessable-ish and the content is
     background music, and requiring a token here would break the <audio>
     element, which sends no Authorization header. */
  router.add('GET', `${base}/waiting-music/:id`, async (ctx) => {
    const track = await getTrack(decodeURIComponent(ctx.params.id ?? ''));
    if (!track || !track.enabled) return error(ctx.res, 404, 'TRACK_NOT_FOUND', 'این قطعه پیدا نشد.');

    const total = track.data.length;
    const inm = ctx.req.headers['if-none-match'];
    if (inm && String(inm).replace(/"/g, '') === track.etag) { ctx.res.statusCode = 304; ctx.res.end(); return; }

    ctx.res.setHeader('content-type', track.mime);
    ctx.res.setHeader('etag', `"${track.etag}"`);
    ctx.res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    ctx.res.setHeader('accept-ranges', 'bytes');

    const range = String(ctx.req.headers.range ?? '');
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      let start: number, end: number;
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : total - 1;
      } else {
        /* `bytes=-500` means the LAST 500 bytes, not "up to byte 500". */
        const tail = Number(m[2]);
        start = Math.max(0, total - tail);
        end = total - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        ctx.res.statusCode = 416;
        ctx.res.setHeader('content-range', `bytes */${total}`);
        ctx.res.end();
        return;
      }
      end = Math.min(end, total - 1);
      const chunk = track.data.subarray(start, end + 1);
      ctx.res.statusCode = 206;
      ctx.res.setHeader('content-range', `bytes ${start}-${end}/${total}`);
      ctx.res.setHeader('content-length', String(chunk.length));
      ctx.res.end(chunk);
      return;
    }

    ctx.res.statusCode = 200;
    ctx.res.setHeader('content-length', String(total));
    ctx.res.end(track.data);
  });

  // ---------------- the operator ----------------
  router.add('GET', `${base}/admin/waiting-music`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, { rows: await listTracks(), maxBytes: MUSIC_MAX_BYTES });
  });

  /* The one route in the API that carries a file, so the one route with a body
     cap above a megabyte. */
  router.add('POST', `${base}/admin/waiting-music`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    try {
      const t = await addTrack({ title: b.title, audio: b.audio, sortOrder: b.sortOrder });
      void recordAdmin({ adminId: ctx.userId, action: 'WAITING_MUSIC_ADDED', meta: { trackId: t.id, bytes: t.bytes, mime: t.mime } });
      json(ctx.res, 201, t);
    } catch (e) {
      if (e instanceof MusicError) return error(ctx.res, 422, e.code, e.message);
      throw e;
    }
  }, { maxBody: 10 * 1024 * 1024 });

  router.add('PATCH', `${base}/admin/waiting-music/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const b = (ctx.body ?? {}) as any;
    try {
      const t = await setTrackEnabled(decodeURIComponent(ctx.params.id ?? ''), b.enabled !== false);
      void recordAdmin({ adminId: ctx.userId, action: 'WAITING_MUSIC_TOGGLED', meta: { trackId: t.id, enabled: t.enabled } });
      json(ctx.res, 200, t);
    } catch (e) {
      if (e instanceof MusicError) return error(ctx.res, 404, e.code, e.message);
      throw e;
    }
  });

  router.add('DELETE', `${base}/admin/waiting-music/:id`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const trackId = decodeURIComponent(ctx.params.id ?? '');
    const removed = await removeTrack(trackId);
    if (removed) void recordAdmin({ adminId: ctx.userId, action: 'WAITING_MUSIC_REMOVED', meta: { trackId } });
    json(ctx.res, 200, { removed });
  });
}
