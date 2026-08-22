/* MUSIC WHILE THE ROOM FILLS.
 *
 * «موزیک‌هایی که از پنل ادمین آپلود میشه به صورت تصادفی پخش میشه بدون نام و
 * مشخصات.»
 *
 * Two promises are load-bearing here and both are checked:
 *
 *   — THE PLAYER'S LIST CARRIES NO NAMES. Not hidden by the client: the title
 *     is not in the payload at all, so no screen can print it by accident.
 *
 *   — THE FILE ANSWERS RANGE REQUESTS. Safari on iOS opens an <audio> with
 *     `Range: bytes=0-1` and will not play from a server that replies 200 with
 *     the whole body. Without 206 the feature is silent on every iPhone.
 *
 * Run: npx tsx src/tests/waitingMusic.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { _resetMusic, MUSIC_MAX_BYTES, isNightHour } from '../services/waitingMusicService.js';
import { createSession } from '../services/sessionService.js';
import { repositories } from '../repositories/index.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

/* A real-shaped MP3: the ID3 header a tagged file starts with, then bytes. */
function mp3(size = 4096, seed = 7): string {
  const buf = Buffer.alloc(size);
  buf.write('ID3', 0, 'ascii');
  for (let i = 3; i < size; i++) buf[i] = (i * seed) % 251;
  return 'data:audio/mpeg;base64,' + buf.toString('base64');
}

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const adminKey = process.env.ADMIN_KEY || 'dev-admin';
  _resetMusic();
  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}/v1`;

  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const parsed = await res.json().catch(() => null) as any;
    return { status: res.status, data: parsed?.data, code: parsed?.error?.code ?? '' };
  };

  /* A real signed-in player, because a heart belongs to somebody. */
  const tokens = new Map<string, string>();
  const asUser = async (method: string, path: string, body?: unknown, who = 'music-fan') => {
    let tok = tokens.get(who);
    if (!tok) {
      await repositories.users.save({
        id: who, username: who, displayName: who, wallet: 0, coins: 0, xp: 0, level: 1,
        createdAt: new Date().toISOString()
      } as any);
      tok = createSession(who).accessToken;
      tokens.set(who, tok);
    }
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const parsed = await res.json().catch(() => null) as any;
    return { status: res.status, data: parsed?.data, code: parsed?.error?.code ?? '' };
  };

  try {
    console.log('the operator uploads a track:');
    let trackId = '';
    await check('a real audio file is accepted', async () => {
      const r = await admin('POST', '/admin/waiting-music', { title: 'بی‌کلام ۱', audio: mp3() });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.ok(r.data.id, 'no id came back');
      assert.equal(r.data.title, 'بی‌کلام ۱');
      assert.equal(r.data.bytes, 4096);
      assert.equal(r.data.enabled, true);
      trackId = r.data.id;
    });

    await check('and the panel lists it with the name the operator typed', async () => {
      const r = await admin('GET', '/admin/waiting-music');
      const row = r.data.rows.find((x: any) => x.id === trackId);
      assert.ok(row, 'not in the panel list');
      assert.equal(row.title, 'بی‌کلام ۱');
      assert.equal(r.data.maxBytes, MUSIC_MAX_BYTES);
      assert.equal(r.data.maxBytes, 15 * 1024 * 1024, 'the panel is told the wrong limit');
    });

    /* THE PROMISE: «بدون نام و مشخصات». */
    await check('the game is given a URL and nothing else', async () => {
      const res = await fetch(base + '/waiting-music');
      const parsed = await res.json() as any;
      assert.equal(res.status, 200);
      const t = parsed.data.tracks.find((x: any) => x.id === trackId);
      assert.ok(t, 'the track is not on the playlist');
      /* Nothing that IDENTIFIES the track. `slot` says which part of the day it
         belongs to and `likes` is a count — the room needs both and neither
         names anything, so the rule is a deny-list of identifying fields rather
         than an allow-list that has to be edited every time the room learns
         something new. */
      assert.deepEqual(Object.keys(t).sort(), ['id', 'likes', 'slot', 'url'], JSON.stringify(t));
      for (const leak of ['title', 'name', 'mime', 'bytes', 'artist', 'createdAt']) {
        assert.ok(!(leak in t), 'the playlist leaked ' + leak);
      }
      /* Belt and braces: the whole payload must not contain the title anywhere. */
      assert.ok(!JSON.stringify(parsed).includes('بی‌کلام'), 'a title reached the player');
    });

    console.log('\nplaying it:');
    await check('the file comes back as audio', async () => {
      const res = await fetch(base + '/waiting-music/' + trackId);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'audio/mpeg');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, 4096);
      assert.equal(buf.toString('ascii', 0, 3), 'ID3');
    });

    /* THE iOS ONE. */
    await check('a range request is answered with 206 and just that range', async () => {
      const res = await fetch(base + '/waiting-music/' + trackId, { headers: { range: 'bytes=0-1' } });
      assert.equal(res.status, 206, 'iOS will not play from a 200');
      assert.equal(res.headers.get('content-range'), 'bytes 0-1/4096');
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, 2, 'the whole file came back for a two-byte range');
    });

    await check('an open-ended range runs to the end of the file', async () => {
      const res = await fetch(base + '/waiting-music/' + trackId, { headers: { range: 'bytes=4000-' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 4000-4095/4096');
      assert.equal((await res.arrayBuffer()).byteLength, 96);
    });

    await check('«the last N bytes» means the last N bytes', async () => {
      const res = await fetch(base + '/waiting-music/' + trackId, { headers: { range: 'bytes=-100' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 3996-4095/4096');
      assert.equal((await res.arrayBuffer()).byteLength, 100);
    });

    await check('a range past the end is refused, not clamped silently', async () => {
      const res = await fetch(base + '/waiting-music/' + trackId, { headers: { range: 'bytes=9000-9100' } });
      assert.equal(res.status, 416);
      assert.equal(res.headers.get('content-range'), 'bytes */4096');
    });

    await check('an unchanged file is not sent twice', async () => {
      const first = await fetch(base + '/waiting-music/' + trackId);
      const etag = first.headers.get('etag') ?? '';
      assert.ok(etag, 'no etag');
      const second = await fetch(base + '/waiting-music/' + trackId, { headers: { 'if-none-match': etag } });
      assert.equal(second.status, 304);
    });

    console.log('\nwhat is refused:');
    await check('a file that is not audio at all', async () => {
      const r = await admin('POST', '/admin/waiting-music', { title: 'x', audio: 'data:image/png;base64,iVBORw0KGgo=' });
      assert.equal(r.status, 422, JSON.stringify(r));
      assert.equal(r.code, 'AUDIO_TYPE_INVALID');
    });

    await check('a file whose contents do not match what it claims to be', async () => {
      const fake = 'data:audio/mpeg;base64,' + Buffer.from('this is plain text, not an mp3 at all').toString('base64');
      const r = await admin('POST', '/admin/waiting-music', { title: 'x', audio: fake });
      assert.equal(r.status, 422, JSON.stringify(r));
      assert.equal(r.code, 'AUDIO_CORRUPT');
    });

    await check('and one too big to carry', async () => {
      const r = await admin('POST', '/admin/waiting-music', { title: 'x', audio: mp3(MUSIC_MAX_BYTES + 1024) });
      assert.equal(r.status, 422, JSON.stringify(r));
      assert.equal(r.code, 'AUDIO_TOO_LARGE');
    });

    /* THE CAP THAT MADE THE UPLOAD POSSIBLE AT ALL. Every other route stops at
       a megabyte; a three-minute MP3 is several. */
    await check('a file bigger than an ordinary request body still gets through', async () => {
      const r = await admin('POST', '/admin/waiting-music', { title: 'بلند', audio: mp3(2 * 1024 * 1024) });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.bytes, 2 * 1024 * 1024);
      await admin('DELETE', '/admin/waiting-music/' + r.data.id);
    });

    /* THE SIZE THE OPERATOR ACTUALLY HAS. «الان فایلای من حداقل ۱۰ مگابایت
       هستن» — so a ten-megabyte file has to go all the way through, and the
       limit has to be the fifteen they asked for. */
    await check('the limit is fifteen megabytes', () => {
      assert.equal(MUSIC_MAX_BYTES, 15 * 1024 * 1024, String(MUSIC_MAX_BYTES));
    });

    await check('a ten-megabyte track uploads and plays', async () => {
      const r = await admin('POST', '/admin/waiting-music', { title: 'ده مگ', audio: mp3(10 * 1024 * 1024, 11) });
      assert.equal(r.status, 201, JSON.stringify({ status: r.status, code: r.code }));
      assert.equal(r.data.bytes, 10 * 1024 * 1024);
      /* And it really comes back, byte for byte, in pieces a browser would ask
         for. */
      const head = await fetch(base + '/waiting-music/' + r.data.id, { headers: { range: 'bytes=0-1023' } });
      assert.equal(head.status, 206);
      assert.equal(head.headers.get('content-range'), 'bytes 0-1023/' + (10 * 1024 * 1024));
      const tail = await fetch(base + '/waiting-music/' + r.data.id, { headers: { range: 'bytes=10485000-' } });
      assert.equal(tail.status, 206);
      assert.equal((await tail.arrayBuffer()).byteLength, 10 * 1024 * 1024 - 10485000);
      await admin('DELETE', '/admin/waiting-music/' + r.data.id);
    });

    await check('while an ordinary route still stops at a megabyte', async () => {
      const res = await fetch(base + '/monitoring/reports', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(1_200_000) })
      });
      assert.ok(res.status >= 400, 'a 1.2MB body was accepted on an ordinary route: ' + res.status);
    });

    /* ── THE RAW DOOR ────────────────────────────────────────────────────
       The one the panel uses now: the file as itself, no base64, no JSON. */
    console.log('\nuploading the file as bytes:');
    const raw = async (body: Buffer, mime = 'audio/mpeg', title = 'خام', key = adminKey) => {
      const res = await fetch(base + '/admin/waiting-music/raw?title=' + encodeURIComponent(title), {
        method: 'POST', headers: { 'content-type': mime, 'x-admin-key': key },
        body: new Uint8Array(body)
      });
      const parsed = await res.json().catch(() => null) as any;
      return { status: res.status, data: parsed?.data, code: parsed?.error?.code ?? '' };
    };
    const bytes = (size: number, seed = 5) => {
      const buf = Buffer.alloc(size);
      buf.write('ID3', 0, 'ascii');
      for (let i = 3; i < size; i++) buf[i] = (i * seed) % 251;
      return buf;
    };

    let rawId = '';
    await check('a file sent as bytes is stored', async () => {
      const r = await raw(bytes(8192));
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.bytes, 8192, 'the bytes changed on the way in');
      assert.equal(r.data.mime, 'audio/mpeg');
      assert.equal(r.data.title, 'خام', 'the operator’s name did not travel');
      rawId = r.data.id;
    });

    await check('and comes back byte for byte', async () => {
      const res = await fetch(base + '/waiting-music/' + rawId);
      const back = Buffer.from(await res.arrayBuffer());
      assert.equal(back.length, 8192);
      assert.deepEqual(back, bytes(8192), 'the file was altered in storage');
    });

    /* THE WHOLE POINT: ten megabytes, the size the operator actually has, with
       no base64 inflation in front of it. */
    await check('a ten-megabyte file goes through this door too', async () => {
      const r = await raw(bytes(10 * 1024 * 1024, 3), 'audio/mpeg', 'ده مگ خام');
      assert.equal(r.status, 201, JSON.stringify({ status: r.status, code: r.code }));
      assert.equal(r.data.bytes, 10 * 1024 * 1024);
      await admin('DELETE', '/admin/waiting-music/' + r.data.id);
    });

    await check('the same checks apply — a file that is not audio is refused', async () => {
      const r = await raw(Buffer.from('this is not audio at all, it is a sentence'), 'audio/mpeg');
      assert.equal(r.status, 422, JSON.stringify(r));
      assert.equal(r.code, 'AUDIO_CORRUPT');
    });

    await check('and a type nobody asked for', async () => {
      const r = await raw(bytes(1024), 'application/zip');
      assert.equal(r.status, 422, JSON.stringify(r));
      assert.equal(r.code, 'AUDIO_TYPE_INVALID');
    });

    await check('a browser’s «audio/mpeg; charset=…» is still audio/mpeg', async () => {
      const r = await raw(bytes(2048), 'audio/mpeg; charset=binary', 'با پارامتر');
      assert.equal(r.status, 201, JSON.stringify(r));
      await admin('DELETE', '/admin/waiting-music/' + r.data.id);
    });

    await check('one over the limit is refused rather than stored', async () => {
      const r = await raw(bytes(MUSIC_MAX_BYTES + 4096), 'audio/mpeg', 'خیلی بزرگ');
      assert.equal(r.status, 422, JSON.stringify({ status: r.status, code: r.code }));
      assert.equal(r.code, 'AUDIO_TOO_LARGE');
      const list = await admin('GET', '/admin/waiting-music');
      assert.ok(!list.data.rows.some((x: any) => x.title === 'خیلی بزرگ'), 'the oversized file was stored anyway');
    });

    await check('and nobody without the admin key may use it', async () => {
      const r = await raw(bytes(1024), 'audio/mpeg', 'دزدکی', 'not-the-key');
      assert.ok(r.status === 401 || r.status === 403, 'status ' + r.status);
      const list = await admin('GET', '/admin/waiting-music');
      assert.ok(!list.data.rows.some((x: any) => x.title === 'دزدکی'), 'an unauthenticated upload got through');
    });

    /* THE FAILURE THAT LOOKED LIKE A BROKEN INTERNET.
     *
     * Answering a big upload BEFORE reading its body cuts the connection from
     * under the sender: the browser never sees the status, only a dead socket,
     * and reports «ارتباط با سرور قطع شد». Both early answers — a route this
     * build does not have, and a key it will not accept — have to come back as
     * real HTTP while a large body is still being sent. */
    /* SENT SLOWLY, THE WAY A REAL UPLOAD ARRIVES. Over loopback a few megabytes
       are gone before the server has finished thinking, and the fault hides.
       A body that trickles in over a couple of seconds is what a phone on a
       home line actually does — and it is while that is still happening that an
       early answer cuts the connection. */
    const trickle = (chunks: number, size = 512 * 1024, gapMs = 120) => new ReadableStream({
      async pull(controller) {
        if (chunks-- <= 0) { controller.close(); return; }
        controller.enqueue(new Uint8Array(bytes(size)));
        await new Promise((r) => setTimeout(r, gapMs));
      }
    });
    const slowPost = async (path: string, key: string) => {
      try {
        const res = await fetch(base + path, {
          method: 'POST', headers: { 'content-type': 'audio/mpeg', 'x-admin-key': key },
          body: trickle(16), duplex: 'half'
        } as any);
        return res.status;
      } catch (e) { return 'network: ' + ((e as Error).cause as any)?.code || 'network'; }
    };

    await check('a slow upload to a route that does not exist gets a 404, not a dead socket', async () => {
      const status = await slowPost('/admin/waiting-music/no-such-door', adminKey);
      assert.equal(status, 404, String(status));
    });

    await check('and a slow upload with the wrong key gets a real refusal', async () => {
      const status = await slowPost('/admin/waiting-music/raw', 'not-the-key');
      assert.ok(status === 401 || status === 403, String(status));
      const list = await admin('GET', '/admin/waiting-music');
      assert.ok(!list.data.rows.some((x: any) => x.title === 'دزدکی بزرگ'), 'it was stored anyway');
    });

    await check('the raw upload leaves the same anonymous playlist behind it', async () => {
      const res = await fetch(base + '/waiting-music');
      const parsed = await res.json() as any;
      const t = parsed.data.tracks.find((x: any) => x.id === rawId);
      assert.ok(t, 'the raw track is not on the playlist');
      assert.deepEqual(Object.keys(t).sort(), ['id', 'likes', 'slot', 'url'], JSON.stringify(t));
      for (const leak of ['title', 'name', 'mime', 'bytes']) assert.ok(!(leak in t), 'the playlist leaked ' + leak);
      await admin('DELETE', '/admin/waiting-music/' + rawId);
    });

    console.log('\nswitching one off:');
    await check('it leaves the players’ playlist', async () => {
      const off = await admin('PATCH', '/admin/waiting-music/' + trackId, { enabled: false });
      assert.equal(off.status, 200, JSON.stringify(off));
      assert.equal(off.data.enabled, false);
      const res = await fetch(base + '/waiting-music');
      const parsed = await res.json() as any;
      assert.ok(!parsed.data.tracks.some((t: any) => t.id === trackId), 'still on the playlist');
    });

    await check('and the file itself stops being served', async () => {
      const res = await fetch(base + '/waiting-music/' + trackId);
      assert.equal(res.status, 404);
    });

    await check('but the operator still sees it, so it can be switched back on', async () => {
      const r = await admin('GET', '/admin/waiting-music');
      assert.ok(r.data.rows.some((x: any) => x.id === trackId), 'it vanished from the panel too');
      const on = await admin('PATCH', '/admin/waiting-music/' + trackId, { enabled: true });
      assert.equal(on.data.enabled, true);
      const res = await fetch(base + '/waiting-music/' + trackId);
      assert.equal(res.status, 200);
    });

    await check('deleting one really removes it', async () => {
      const r = await admin('DELETE', '/admin/waiting-music/' + trackId);
      assert.equal(r.status, 200);
      assert.equal(r.data.removed, true);
      const res = await fetch(base + '/waiting-music/' + trackId);
      assert.equal(res.status, 404);
    });

    console.log('\nwho may upload:');
    await check('not somebody without the admin key', async () => {
      const res = await fetch(base + '/admin/waiting-music', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x', audio: mp3(512) })
      });
      assert.ok(res.status === 401 || res.status === 403, 'status ' + res.status);
      const list = await fetch(base + '/waiting-music');
      const parsed = await list.json() as any;
      assert.equal(parsed.data.tracks.length, 0, 'an unauthenticated upload got through');
    });

    await check('and the playlist itself needs no login — the audio element has no token', async () => {
      const res = await fetch(base + '/waiting-music');
      assert.equal(res.status, 200);
    });

    /* ── DAY AND NIGHT ────────────────────────────────────────────────── */
    /* «باید بتونم موزیک‌ها رو با عنوان روزانه و شبانه انتخاب کنم، و اگه شبانه
       باشن باید در ساعت ۱۰ شب تا ۶ صبح فعال باشن… ساعت پخش موزیک شبانه رو هم
       خودم بتونم تنظیم کنم.» */
    console.log('\nday and night:');
    let dayId = '', nightId = '';
    await check('a track can be uploaded as daytime or night-time', async () => {
      const d = await admin('POST', '/admin/waiting-music', { title: 'روز', audio: mp3(512), slot: 'day' });
      const n = await admin('POST', '/admin/waiting-music', { title: 'شب', audio: mp3(700), slot: 'night' });
      assert.equal(d.status, 201, JSON.stringify(d));
      dayId = d.data.id; nightId = n.data.id;
      assert.equal(d.data.slot, 'day');
      assert.equal(n.data.slot, 'night');
    });

    await check('and moved between them afterwards', async () => {
      const r = await admin('PUT', '/admin/waiting-music/' + dayId + '/slot', { slot: 'night' });
      assert.equal(r.data.slot, 'night');
      const back = await admin('PUT', '/admin/waiting-music/' + dayId + '/slot', { slot: 'day' });
      assert.equal(back.data.slot, 'day');
    });

    await check('a nonsense slot falls back to «any» rather than being stored', async () => {
      const r = await admin('PUT', '/admin/waiting-music/' + dayId + '/slot', { slot: 'حالا هرچی' });
      assert.equal(r.data.slot, 'any');
      await admin('PUT', '/admin/waiting-music/' + dayId + '/slot', { slot: 'day' });
    });

    await check('the player’s list says which is which', async () => {
      const parsed = await (await fetch(base + '/waiting-music')).json() as any;
      const d = parsed.data.tracks.find((x: any) => x.id === dayId);
      const n = parsed.data.tracks.find((x: any) => x.id === nightId);
      assert.equal(d.slot, 'day');
      assert.equal(n.slot, 'night');
    });

    await check('and carries the night window, because the phone decides', async () => {
      const parsed = await (await fetch(base + '/waiting-music')).json() as any;
      /* The server runs on UTC and cannot know what time it is where the player
         is — «ساعت گوشیِ خود بازیکن» — so it states the window and the client
         compares it against its own clock. */
      assert.ok(parsed.data.night, 'no night window on the playlist');
      assert.equal(parsed.data.night.startHour, 22);
      assert.equal(parsed.data.night.endHour, 6);
    });

    await check('the operator can move the window', async () => {
      const r = await admin('PUT', '/admin/waiting-music/night', { startHour: 23, endHour: 7 });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.deepEqual(r.data, { startHour: 23, endHour: 7 });
      const parsed = await (await fetch(base + '/waiting-music')).json() as any;
      assert.deepEqual(parsed.data.night, { startHour: 23, endHour: 7 });
    });

    await check('a window of no length is refused rather than silencing the night', async () => {
      const r = await admin('PUT', '/admin/waiting-music/night', { startHour: 3, endHour: 3 });
      assert.equal(r.status, 422, JSON.stringify(r));
      const parsed = await (await fetch(base + '/waiting-music')).json() as any;
      assert.deepEqual(parsed.data.night, { startHour: 23, endHour: 7 }, 'the refused window was stored anyway');
    });

    await check('an hour outside 0..23 is clamped, not stored', async () => {
      const r = await admin('PUT', '/admin/waiting-music/night', { startHour: 99, endHour: -4 });
      assert.equal(r.status, 200);
      assert.equal(r.data.startHour, 22, 'a nonsense start should fall back to the default');
      assert.equal(r.data.endHour, 6);
    });

    /* ── THE HEART ────────────────────────────────────────────────────── */
    /* «یه علامت قلب باشه تا کاربر بتونه لایک کنه.» */
    console.log('\nliking a track:');
    await check('a signed-in player can heart one', async () => {
      const r = await asUser('POST', '/waiting-music/' + nightId + '/like', { liked: true });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal(r.data.liked, true);
      assert.equal(r.data.likes, 1);
    });

    await check('pressing it twice is one person, not two likes', async () => {
      const r = await asUser('POST', '/waiting-music/' + nightId + '/like', { liked: true });
      assert.equal(r.data.likes, 1, 'the same player counted twice');
    });

    await check('a second player is a second heart', async () => {
      const r = await asUser('POST', '/waiting-music/' + nightId + '/like', { liked: true }, 'other-user');
      assert.equal(r.data.likes, 2, JSON.stringify(r.data));
    });

    await check('and taking it back removes exactly one', async () => {
      const r = await asUser('POST', '/waiting-music/' + nightId + '/like', { liked: false });
      assert.equal(r.data.liked, false);
      assert.equal(r.data.likes, 1);
      /* Un-liking something never liked must not push the count below zero. */
      const again = await asUser('POST', '/waiting-music/' + nightId + '/like', { liked: false });
      assert.equal(again.data.likes, 1, 'the count moved on a no-op');
    });

    await check('the room can ask which ones this player has hearted', async () => {
      await asUser('POST', '/waiting-music/' + dayId + '/like', { liked: true });
      const r = await asUser('GET', '/waiting-music/likes');
      assert.ok(r.data.liked.includes(dayId), JSON.stringify(r.data));
      assert.ok(!r.data.liked.includes(nightId), 'a track this player un-liked is still listed');
    });

    await check('and a stranger cannot heart anything', async () => {
      const res = await fetch(base + '/waiting-music/' + dayId + '/like', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ liked: true })
      });
      assert.equal(res.status, 401, 'status ' + res.status);
    });

    await check('the operator sees the count, which is the point of it', async () => {
      const r = await admin('GET', '/admin/waiting-music');
      const row = r.data.rows.find((x: any) => x.id === dayId);
      assert.ok(row, 'the track vanished from the panel');
      assert.equal(row.likes, 1, JSON.stringify(row));
      assert.equal(row.slot, 'day');
    });

    await check('hearting something that is not there says so', async () => {
      const r = await asUser('POST', '/waiting-music/no-such-track/like', { liked: true });
      assert.equal(r.status, 404, JSON.stringify(r));
    });

    /* ── THE WINDOW THAT CROSSES MIDNIGHT ─────────────────────────────── */
    /* «۱۰ شب تا ۶ صبح» goes over midnight, so start > end is the ORDINARY
       case here, not an error — and it is exactly the comparison that is easy
       to write backwards. The client implements the same rule against its own
       clock, so this pins the rule itself. */
    console.log('\nwhen night is:');
    await check('ten at night to six in the morning covers the small hours', () => {
      const w = { startHour: 22, endHour: 6 };
      for (const h of [22, 23, 0, 1, 3, 5]) assert.ok(isNightHour(h, w), h + ':00 should be night');
      for (const h of [6, 7, 12, 18, 21]) assert.ok(!isNightHour(h, w), h + ':00 should be day');
    });

    await check('the boundaries belong to the right side', () => {
      const w = { startHour: 22, endHour: 6 };
      assert.ok(isNightHour(22, w), 'night starts AT the start hour');
      assert.ok(!isNightHour(6, w), 'and ends the moment the end hour arrives');
    });

    await check('a window that does not cross midnight still works', () => {
      const w = { startHour: 1, endHour: 6 };
      for (const h of [1, 3, 5]) assert.ok(isNightHour(h, w), h + ':00 should be night');
      for (const h of [0, 6, 23]) assert.ok(!isNightHour(h, w), h + ':00 should be day');
    });

    await check('an hour outside the clock is wrapped, not mis-answered', () => {
      const w = { startHour: 22, endHour: 6 };
      assert.equal(isNightHour(25, w), isNightHour(1, w));
      assert.equal(isNightHour(-1, w), isNightHour(23, w));
    });
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

await main();
