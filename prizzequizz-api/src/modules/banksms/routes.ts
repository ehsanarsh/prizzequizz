/* THE FORWARDER'S OWN ENDPOINTS.
 *
 * Not behind a user token and not behind an admin key: a phone is neither.
 * Every request carries an HMAC over its own body, its own moment and a
 * one-use nonce — see `deviceAuth`, which is where the actual trust lives.
 *
 * THE BODY IS READ RAW. The signature covers the exact bytes the device sent,
 * so letting the router parse and re-serialise the JSON would change the hash
 * and every honest request would fail. That is why these routes opt out of
 * the shared body parser rather than reaching for the parsed object.
 *
 * These endpoints are deliberately generic. The Android app is the first
 * client; a script on a Mac reading messages forwarded from an iPhone could
 * be the second — iOS has no SMS-reading API at all, so an iPhone can never
 * be a forwarder itself and any iPhone story has to arrive here as a
 * different kind of client speaking the same protocol.
 */
import type { IncomingMessage } from 'node:http';
import type { RequestContext, Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import {
  DeviceAuthError, readAuthHeaders, verifyRequest
} from '../../services/c2c/deviceAuth.js';
import { DeviceError, pairDevice, touchDevice } from '../../services/c2c/deviceStore.js';
import { ingestSms } from '../../services/c2c/matchService.js';
import { logger } from '../../services/logger.js';

/** A phone's offline queue, capped. Fifty messages is a long outage. */
export const MAX_BATCH = 50;
/* Bank SMS are short. A body far larger than fifty of them is not a
 * forwarder, so it is refused before it is read into memory. */
const MAX_BODY_BYTES = 200_000;

function readRaw(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) reject(new DeviceError('BODY_TOO_LARGE', 'حجم درخواست بیش از حد مجاز است.'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function deviceError(ctx: RequestContext, e: unknown): void {
  if (e instanceof DeviceAuthError) {
    /* 401 for «I do not believe you», so a device knows to re-pair rather
     * than retry the same request forever. */
    error(ctx.res, 401, e.code, e.message);
    return;
  }
  if (e instanceof DeviceError) { error(ctx.res, 400, e.code, e.message); return; }
  throw e;
}

export function registerBankSmsRoutes(router: Router, base: string): void {
  /* ---------- Pairing ----------
   * The one unsigned endpoint, because the device has nothing to sign with
   * yet. What stands in for a signature is a six-digit code the operator just
   * generated in the panel: one-shot, ten minutes, five attempts. */
  router.add('POST', `${base}/bank-sms/pair`, async (ctx) => {
    try {
      const raw = await readRaw(ctx.req);
      const b = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const r = await pairDevice({
        code: String(b.pairingCode ?? ''),
        label: b.label != null ? String(b.label) : undefined,
        appVersion: b.appVersion != null ? String(b.appVersion) : undefined
      });
      /* The only time the secret exists outside the device. It is not
       * recoverable afterwards — a phone that loses it is re-paired. */
      json(ctx.res, 201, { deviceId: r.device.id, secret: r.secret, label: r.device.label });
    } catch (e) {
      if (e instanceof SyntaxError) return error(ctx.res, 400, 'BODY_INVALID', 'بدنهٔ درخواست معتبر نیست.');
      deviceError(ctx, e);
    }
  }, { rawBody: true });

  /* ---------- Messages ----------
   * Batched, because the phone queues while it is offline — which on a
   * daily-use phone is often. The response is PER MESSAGE so the device knows
   * exactly which ones to drop from its queue and which to keep trying. */
  router.add('POST', `${base}/bank-sms/transactions`, async (ctx) => {
    try {
      const raw = await readRaw(ctx.req);
      const auth = { ...readAuthHeaders(ctx.req), rawBody: raw };
      const device = await verifyRequest(auth);

      const b = (raw ? JSON.parse(raw) : {}) as { messages?: unknown };
      const messages = Array.isArray(b.messages) ? b.messages : [];
      if (messages.length > MAX_BATCH) {
        return error(ctx.res, 413, 'BATCH_TOO_LARGE', `حداکثر ${MAX_BATCH} پیام در هر درخواست.`);
      }

      const results = [];
      let newestSms = '';
      for (const m of messages as Array<Record<string, unknown>>) {
        const messageId = String(m.messageId ?? '').trim();
        if (!messageId) { results.push({ messageId: '', stored: false, error: 'MESSAGE_ID_REQUIRED' }); continue; }
        const receivedAt = m.receivedAt ? String(m.receivedAt) : undefined;
        if (receivedAt && receivedAt > newestSms) newestSms = receivedAt;
        try {
          const r = await ingestSms({
            deviceId: device.id,
            messageId,
            sender: m.sender != null ? String(m.sender) : '',
            body: String(m.body ?? ''),
            receivedAt
          });
          /* `stored` means «the server has taken responsibility — drop it
           * from your queue», which is true of every outcome that is not an
           * error. Including a dropped credential: «we refuse to keep this»
           * is a final answer, not a failure to redeliver. The only false is
           * in the catch below. */
          results.push({
            messageId,
            stored: true,
            duplicate: r.outcome === 'duplicate',
            dropped: r.outcome === 'sensitive',
            parsed: r.outcome === 'queued' || r.outcome === 'settled',
            matched: r.outcome === 'settled'
          });
        } catch (e) {
          /* Anything unexpected: tell the device to KEEP it. A message the
           * server failed on is a deposit that has not been recorded. */
          logger.error('bank_sms_ingest_failed', { deviceId: device.id, messageId, message: e instanceof Error ? e.message : 'unknown' });
          results.push({ messageId, stored: false, error: 'INGEST_FAILED' });
        }
      }

      await touchDevice(device.id, {
        received: results.filter((r) => r.stored).length,
        lastSmsAt: newestSms || undefined
      });
      json(ctx.res, 200, { results });
    } catch (e) {
      if (e instanceof SyntaxError) return error(ctx.res, 400, 'BODY_INVALID', 'بدنهٔ درخواست معتبر نیست.');
      deviceError(ctx, e);
    }
  }, { rawBody: true });

  /* ---------- Heartbeat ----------
   * On a dedicated phone this would be housekeeping. On the operator's daily
   * phone it is the alarm: Android will sleep a background service, and the
   * only way anyone finds out is that this stopped arriving. */
  router.add('POST', `${base}/bank-sms/heartbeat`, async (ctx) => {
    try {
      const raw = await readRaw(ctx.req);
      const auth = { ...readAuthHeaders(ctx.req), rawBody: raw };
      const device = await verifyRequest(auth);
      const b = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      const updated = await touchDevice(device.id, {
        appVersion: b.appVersion != null ? String(b.appVersion) : undefined,
        queueDepth: b.queueDepth != null ? Number(b.queueDepth) : undefined,
        batteryOptimized: b.batteryOptimized != null ? b.batteryOptimized === true : undefined,
        lastSmsAt: b.lastSmsAt != null ? String(b.lastSmsAt) : undefined
      });
      json(ctx.res, 200, { ok: true, serverTime: new Date().toISOString(), queueDepth: updated?.queueDepth ?? 0 });
    } catch (e) {
      if (e instanceof SyntaxError) return error(ctx.res, 400, 'BODY_INVALID', 'بدنهٔ درخواست معتبر نیست.');
      deviceError(ctx, e);
    }
  }, { rawBody: true });
}
