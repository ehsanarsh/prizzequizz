import type { IncomingMessage, ServerResponse } from 'node:http';
import { error } from '../http/response.js';
import { recordSecurityEvent } from '../services/securityEvents.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const path = (req.url ?? '/').split('?')[0];
  const key = `${ip}:${path}`;
  const now = Date.now();
  const windowMs = 60_000;
  const max = path?.includes('/auth/') ? 12 : 120;
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
