/* WHO IS "TOO MANY REQUESTS"?
 *
 * This counted per `req.socket.remoteAddress` — and the API only ever sees one
 * socket address, because nginx proxies every request from 127.0.0.1. So the
 * bucket `127.0.0.1:/v1/last-survivor/rooms/<id>` was shared by EVERY player in
 * that room: twenty people polling their own match together spent the 120/min
 * allowance in seconds, and from then on the snapshot request returned 429 to
 * whoever asked next.
 *
 * In Last Survivor that is not a slow page. The client renders the round from
 * the snapshot; a 429 leaves it holding the previous round's screen, so the
 * player never sees the question, never answers, and the grader takes their
 * shield or their place. It looks exactly like what was reported: question 1
 * arrives for everybody, question 2 goes missing for a few, question 3 is fine
 * again.
 *
 * So the counter is per CALLER — the session token when there is one, otherwise
 * the real client address — and the forwarded address is only believed when the
 * connection genuinely came from our own proxy, because a header anyone can set
 * is not an identity.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { error } from '../http/response.js';
import { recordSecurityEvent } from '../services/securityEvents.js';
import { clientIp } from '../http/clientIp.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/* The session token identifies the caller far better than an address does:
 * a whole household, or a whole mobile carrier NAT, can share one IP. Hashed
 * because a bucket key lives in memory far longer than the request does. */
function callerKey(req: IncomingMessage): string {
  const auth = String(req.headers.authorization ?? '');
  const tok = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  if (tok) return 'u:' + createHash('sha256').update(tok).digest('base64url').slice(0, 22);
  return 'ip:' + clientIp(req);
}

/* Expired buckets are dropped as we go; the keys are per caller now, so a busy
 * night would otherwise leave a map that only ever grows. */
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}

export function rateLimit(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const key = `${callerKey(req)}:${path}`;
  const now = Date.now();
  sweep(now);
  const windowMs = 60_000;
  const max = path.includes('/auth/') ? 12 : 120;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  if (bucket.count > max) {
    recordSecurityEvent({ req, eventType: 'RATE_LIMITED', severity: 'warn', metadata: { path } });
    error(res, 429, 'RATE_LIMITED', 'Too many requests. Please slow down.');
    return false;
  }
  return true;
}

/** Test seam. */
export function _resetRateLimits(): void { buckets.clear(); lastSweep = 0; }
