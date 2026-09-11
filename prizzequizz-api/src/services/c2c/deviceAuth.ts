/* PROVING A REQUEST CAME FROM THE PHONE.
 *
 * A forwarder posts deposits that can hand over goods, so «who sent this» is
 * the whole security boundary. A bearer token would be enough to replay — one
 * captured request re-sent is a second delivery — so every request is signed
 * over its own body, its own moment, and a number it may only use once:
 *
 *   signature = HMAC-SHA256(secret, deviceId \n timestamp \n nonce \n sha256(body))
 *
 * Four things have to be true, and each closes a different attack:
 *
 *   the device is known and ACTIVE   a revoked phone stops working immediately
 *   the signature matches            nobody without the secret can speak
 *   the timestamp is recent          a captured request expires
 *   the nonce is unseen              and cannot be replayed inside that window
 *
 * The secret never leaves the phone after pairing and is stored here only as
 * a hash — which means this file has to be handed the secret by the caller's
 * header, and cannot reconstruct it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { getDevice, openDevice, type ForwarderDevice } from './deviceStore.js';
import { logger } from '../logger.js';

/* A request older than this is refused. Wide enough for a phone whose clock
 * drifts and a slow network; narrow enough that a captured request is stale
 * before anyone can do much with it. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;

/* Nonces are remembered for the length of the window and no longer: outside
 * it the timestamp check already refuses the request, so keeping them would
 * grow a map forever to re-answer a question that is already answered. */
const seenNonces = new Map<string, number>();

function sweepNonces(now: number): void {
  if (seenNonces.size < 512) return;
  for (const [k, t] of seenNonces) if (now - t > SIGNATURE_WINDOW_MS) seenNonces.delete(k);
}

export class DeviceAuthError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DeviceAuthError'; }
}

export function signPayload(secret: string, deviceId: string, timestamp: string, nonce: string, rawBody: string): string {
  const bodyHash = createHash('sha256').update(rawBody ?? '', 'utf8').digest('hex');
  return createHmac('sha256', secret)
    .update(`${deviceId}\n${timestamp}\n${nonce}\n${bodyHash}`)
    .digest('hex');
}

function hexEquals(a: string, b: string): boolean {
  try {
    const x = Buffer.from(a, 'hex'); const y = Buffer.from(b, 'hex');
    return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}

export interface DeviceAuthInput {
  deviceId: string;
  timestamp: string;
  nonce: string;
  signature: string;
  /** The body EXACTLY as received. Re-serialising it changes the hash. */
  rawBody: string;
}

export function readAuthHeaders(req: IncomingMessage): DeviceAuthInput {
  const h = (name: string) => String(req.headers[name] ?? '').trim();
  return {
    deviceId: h('x-device-id'),
    timestamp: h('x-timestamp'),
    nonce: h('x-nonce'),
    signature: h('x-signature'),
    rawBody: ''
  };
}

/**
 * Authenticate one signed request.
 *
 * The header carries the SIGNATURE, never the secret — so the secret crosses
 * the wire exactly once in a device's life, at pairing. Here the server opens
 * its own sealed copy, recomputes the signature over this request's body, and
 * compares. Nothing about the request is trusted until all four checks pass.
 */
export async function verifyRequest(input: DeviceAuthInput): Promise<ForwarderDevice> {
  const now = Date.now();
  if (!input.deviceId || !input.timestamp || !input.nonce || !input.signature) {
    throw new DeviceAuthError('DEVICE_AUTH_INCOMPLETE', 'هدرهای احراز هویت دستگاه کامل نیست.');
  }

  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_WINDOW_MS) {
    /* Also refuses a timestamp from the FUTURE: a phone whose clock is hours
     * ahead could otherwise mint requests that stay valid for hours. */
    throw new DeviceAuthError('DEVICE_AUTH_STALE', 'زمان درخواست معتبر نیست؛ ساعت دستگاه را درست کن.');
  }

  const opened = await openDevice(input.deviceId);
  if (!opened) {
    logger.warn('bank_sms_device_auth_failed', { deviceId: input.deviceId });
    throw new DeviceAuthError('DEVICE_UNKNOWN', 'دستگاه شناخته نشد یا ابطال شده است.');
  }
  const { device, secret } = opened;

  const expected = signPayload(secret, input.deviceId, input.timestamp, input.nonce, input.rawBody);
  if (!hexEquals(expected, input.signature)) {
    logger.warn('bank_sms_device_signature_invalid', { deviceId: input.deviceId });
    throw new DeviceAuthError('DEVICE_SIGNATURE_INVALID', 'امضای درخواست معتبر نیست.');
  }

  /* LAST, so a replay is only recorded once the request was otherwise valid —
   * otherwise an attacker could burn a legitimate nonce by guessing it. */
  const key = `${input.deviceId}:${input.nonce}`;
  sweepNonces(now);
  if (seenNonces.has(key)) {
    logger.warn('bank_sms_device_replay', { deviceId: input.deviceId });
    throw new DeviceAuthError('DEVICE_REPLAY', 'این درخواست قبلاً پردازش شده است.');
  }
  seenNonces.set(key, now);
  return device;
}

/** Test seam. */
export function _resetNonces(): void { seenNonces.clear(); }
export { getDevice };
