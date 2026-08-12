/* THE LIMIT THAT COUNTED A WHOLE ROOM AS ONE PLAYER.
 *
 * nginx proxies every request from 127.0.0.1, and the limiter keyed its bucket
 * on `req.socket.remoteAddress`. So `127.0.0.1:/v1/last-survivor/rooms/<id>` was
 * ONE allowance of 120 a minute shared by every player in that room. Twenty
 * people polling their own match spend it in seconds, and everybody after that
 * gets a 429.
 *
 * In Last Survivor a 429 on the snapshot is not a slow page: the client draws
 * the round from that snapshot, so the player keeps the previous round's screen,
 * never sees the question, never answers, and is graded as having missed it —
 * a shield gone, or their place. Question one arrives for everybody, question
 * two goes missing for a few, question three is fine again.
 *
 * Run: npx tsx src/tests/rateLimitPerCaller.test.ts
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rateLimit, _resetRateLimits } from '../middleware/rateLimiter.js';
import { clientIp } from '../http/clientIp.js';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* A request as the API really sees it behind the proxy: the socket is always
 * loopback, the real caller is in the forwarded header. */
function req(opts: { path: string; token?: string; forwarded?: string; socket?: string }): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  if (opts.forwarded) headers['x-forwarded-for'] = opts.forwarded;
  return {
    url: opts.path,
    headers,
    socket: { remoteAddress: opts.socket ?? '127.0.0.1' }
  } as unknown as IncomingMessage;
}
function res(): ServerResponse {
  return {
    statusCode: 200,
    setHeader() { /* noop */ },
    getHeader() { return undefined; },
    end() { /* noop */ }
  } as unknown as ServerResponse;
}

/** How many of `n` requests got through. */
function allowed(make: () => IncomingMessage, n: number): number {
  let ok = 0;
  for (let i = 0; i < n; i++) if (rateLimit(make(), res())) ok++;
  return ok;
}

const ROOM = '/v1/last-survivor/rooms/room-1';

function run(): void {
  check('one player cannot use up another player’s allowance', () => {
    /* The reported bug, in one assertion. */
    _resetRateLimits();
    const heavy = allowed(() => req({ path: ROOM, token: 'tok-player-1' }), 400);
    assert.ok(heavy < 400, 'the busy player is still limited (' + heavy + ' allowed)');
    const quiet = allowed(() => req({ path: ROOM, token: 'tok-player-2' }), 20);
    assert.equal(quiet, 20, 'the player who did nothing wrong was throttled: only ' + quiet + '/20 got through');
  });

  check('twenty players in one room all get served', () => {
    /* A real room. Each phone asks for the snapshot ~30 times a minute. Before
       the fix, everybody past the first ~120 requests was refused. */
    _resetRateLimits();
    let refused = 0;
    for (let poll = 0; poll < 30; poll++) {
      for (let p = 0; p < 20; p++) {
        if (!rateLimit(req({ path: ROOM, token: 'tok-p' + p }), res())) refused++;
      }
    }
    assert.equal(refused, 0, refused + ' of 600 room snapshots were refused');
  });

  check('a caller with no token is still counted, by their real address', () => {
    _resetRateLimits();
    const a = allowed(() => req({ path: '/v1/questions/next', forwarded: '5.5.5.5' }), 400);
    assert.ok(a < 400, 'an anonymous flood is still stopped (' + a + ')');
    const b = allowed(() => req({ path: '/v1/questions/next', forwarded: '6.6.6.6' }), 20);
    assert.equal(b, 20, 'a different address must not inherit that flood');
  });

  check('the same person is still limited across two paths', () => {
    /* Per path is deliberate — polling a match must not eat the allowance for
       answering it — but each path must still have a ceiling. */
    _resetRateLimits();
    const a = allowed(() => req({ path: ROOM, token: 't' }), 300);
    const b = allowed(() => req({ path: ROOM + '/chat', token: 't' }), 300);
    assert.ok(a < 300 && b < 300, 'both paths must cap: ' + a + ', ' + b);
  });

  check('login attempts stay on the tight leash', () => {
    _resetRateLimits();
    const a = allowed(() => req({ path: '/v1/auth/otp/request', forwarded: '7.7.7.7' }), 60);
    assert.ok(a <= 12, 'auth allowed ' + a + ' — brute force is meant to be stopped here');
  });

  /* ── whose address is it ─────────────────────────────────────────── */

  check('the forwarded address is believed when our own proxy sent it', () => {
    assert.equal(clientIp(req({ path: '/x', forwarded: '85.9.1.2', socket: '127.0.0.1' })), '85.9.1.2');
    assert.equal(clientIp(req({ path: '/x', forwarded: '85.9.1.2, 10.0.0.9', socket: '::1' })), '85.9.1.2',
      'the first entry is the client, the rest are hops');
  });

  check('and NOT when the client itself claims it', () => {
    /* Otherwise anyone can spoof a new identity per request and the limiter is
       decorative. */
    assert.equal(clientIp(req({ path: '/x', forwarded: '1.2.3.4', socket: '203.0.113.9' })), '203.0.113.9');
  });

  check('a spoofed forwarded header cannot buy a fresh allowance', () => {
    _resetRateLimits();
    let ok = 0;
    for (let i = 0; i < 400; i++) {
      /* Direct connection, a different claimed address every time. */
      if (rateLimit(req({ path: '/v1/questions/next', forwarded: '9.9.9.' + (i % 250), socket: '203.0.113.9' }), res())) ok++;
    }
    assert.ok(ok < 400, 'the header bought ' + ok + ' requests');
  });

  console.log(`[rateLimitPerCaller] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
