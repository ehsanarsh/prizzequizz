/* THE ADDRESS A REQUEST REALLY CAME FROM.
 *
 * nginx proxies every request from 127.0.0.1, so `req.socket.remoteAddress` is
 * the same value for every player in the country. Anything that counts, limits
 * or flags "per address" was therefore treating the whole player base as one
 * machine.
 *
 * The forwarded header is believed ONLY when the connection came from our own
 * proxy — a header any client can set is a claim, not an identity.
 */
import type { IncomingMessage } from 'node:http';

function isTrustedHop(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost'
    || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

export function clientIp(req: IncomingMessage): string {
  const socket = req.socket.remoteAddress ?? 'unknown';
  if (!isTrustedHop(socket)) return socket;
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  const real = String(req.headers['x-real-ip'] ?? '').trim();
  return fwd || real || socket;
}
