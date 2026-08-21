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
import { _resetMusic, MUSIC_MAX_BYTES } from '../services/waitingMusicService.js';

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
    });

    /* THE PROMISE: «بدون نام و مشخصات». */
    await check('the game is given a URL and nothing else', async () => {
      const res = await fetch(base + '/waiting-music');
      const parsed = await res.json() as any;
      assert.equal(res.status, 200);
      const t = parsed.data.tracks.find((x: any) => x.id === trackId);
      assert.ok(t, 'the track is not on the playlist');
      assert.deepEqual(Object.keys(t).sort(), ['id', 'url'], JSON.stringify(t));
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

    await check('while an ordinary route still stops at a megabyte', async () => {
      const res = await fetch(base + '/monitoring/reports', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(1_200_000) })
      });
      assert.ok(res.status >= 400, 'a 1.2MB body was accepted on an ordinary route: ' + res.status);
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
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

await main();
