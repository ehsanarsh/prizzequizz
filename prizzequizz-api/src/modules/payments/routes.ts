import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { WalletError } from '../../services/walletLedgerService.js';
import { createPaymentIntent, getPaymentIntent, listPaymentIntents, paymentDiagnostics, paymentSignature, settlePaymentIntent } from '../../services/paymentService.js';
import type { PaymentIntentStatus, PaymentProvider } from '../../types/domain.js';
import { bodyObject, optionalString, requiredNumber } from '../../utils/validation.js';

export function registerPaymentRoutes(router: Router, base: string): void {
  router.add('POST', `${base}/payments/intents`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const body = bodyObject(ctx.body);
    try {
      const intent = await createPaymentIntent({ userId: ctx.userId, amount: requiredNumber(body, 'amount'), callbackUrl: optionalString(body, 'callbackUrl'), idempotencyKey: optionalString(body, 'idempotencyKey') });
      json(ctx.res, 201, intent);
    } catch (e) {
      if (e instanceof WalletError) return error(ctx.res, 400, e.code, e.message);
      throw e;
    }
  });

  router.add('GET', `${base}/payments/intents/:id`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const intent = await getPaymentIntent(ctx.params.id!, ctx.userId);
    if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
    json(ctx.res, 200, intent);
  });

  // READ-ONLY now: a client can only ask for the current status; it can never
  // flip an intent to paid (that required hole let players self-credit).
  router.add('POST', `${base}/payments/intents/:id/verify`, async (ctx) => {
    if (!ctx.userId) return error(ctx.res, 401, 'UNAUTHORIZED', 'Login required.');
    const intent = await getPaymentIntent(ctx.params.id!, ctx.userId);
    if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
    json(ctx.res, 200, intent);
  });

  // Gateway-side settlement: requires the HMAC signature the gateway (or the
  // sandbox pay link) carries. This is the ONLY path that credits a deposit.
  router.add('GET', `${base}/payments/sandbox/:id/pay`, async (ctx) => {
    const status = ctx.query.get('status') === 'failed' ? 'failed' : 'paid';
    const sig = ctx.query.get('sig') ?? '';
    try {
      const intent = await settlePaymentIntent(ctx.params.id!, sig, status);
      if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
      json(ctx.res, 200, { paid: intent.status === 'paid', intent });
    } catch (e) {
      if (e instanceof WalletError) return error(ctx.res, 403, e.code, e.message);
      throw e;
    }
  });

  // Real-gateway callback endpoint (POST, signed): a production PSP webhook
  // posts {intentId, status, signature}; signature must be the HMAC this server
  // computes with PAYMENT_WEBHOOK_SECRET.
  router.add('POST', `${base}/payments/callback`, async (ctx) => {
    const body = bodyObject(ctx.body);
    const intentId = String((body as any).intentId ?? '');
    const status = (body as any).status === 'failed' ? 'failed' : 'paid';
    const sig = String((body as any).signature ?? '');
    try {
      const intent = await settlePaymentIntent(intentId, sig, status);
      if (!intent) return error(ctx.res, 404, 'PAYMENT_INTENT_NOT_FOUND', 'Payment intent not found.');
      json(ctx.res, 200, { ok: true, status: intent.status });
    } catch (e) {
      if (e instanceof WalletError) return error(ctx.res, 403, e.code, e.message);
      throw e;
    }
  });

  router.add('GET', `${base}/admin/payments/diagnostics`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await paymentDiagnostics());
  });

  router.add('GET', `${base}/admin/payments/intents`, async (ctx) => {
    if (!requireAdmin(ctx)) return;
    json(ctx.res, 200, await listPaymentIntents({ userId: ctx.query.get('userId') || undefined, status: (ctx.query.get('status') || undefined) as PaymentIntentStatus | undefined, provider: (ctx.query.get('provider') || undefined) as PaymentProvider | undefined, limit: Number(ctx.query.get('limit') ?? 100) }));
  });
}
