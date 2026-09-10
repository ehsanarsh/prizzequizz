import type { Router } from '../../http/router.js';
import { error, json } from '../../http/response.js';
import { requireAdmin } from '../../services/adminGuard.js';
import { WalletError } from '../../services/walletLedgerService.js';
import { getPaymentIntent, listPaymentIntents, paymentDiagnostics, settlePaymentIntent } from '../../services/paymentService.js';
import { listGatewaysMasked, saveGateway, removeGateway, getPaymentSettings, updatePaymentSettings, testConnection, gatewayReports } from '../../services/paymentGatewayService.js';
import type { PaymentIntentStatus, PaymentProvider } from '../../types/domain.js';
import { bodyObject } from '../../utils/validation.js';

export function registerPaymentRoutes(router: Router, base: string): void {
/* TWO ROUTES USED TO SIT AROUND THIS ONE, AND BOTH WERE DEAD.
 *
 *   POST /payments/intents         answered 400 to every caller alive. It sent
 *                                  only an `amount`, and `createPaymentIntent`
 *                                  refuses an intent with no `order` — there is
 *                                  no topping up any more, so a payment must be
 *                                  FOR something. Buying goes through
 *                                  POST /orders/pay, which carries the order.
 *   POST /payments/intents/:id/verify   was reduced to a read after the hole
 *                                  that let a client flip its own intent to
 *                                  paid was closed. What it then did, the GET
 *                                  below already did.
 *
 * Both are gone rather than left as decoration: a route that cannot succeed is
 * a trap for the next person who finds it in the router and assumes it works. */
  router.add('GET', `${base}/payments/intents/:id`, async (ctx) => {
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
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await listPaymentIntents({ userId: ctx.query.get('userId') || undefined, status: (ctx.query.get('status') || undefined) as PaymentIntentStatus | undefined, provider: (ctx.query.get('provider') || undefined) as PaymentProvider | undefined, limit: Number(ctx.query.get('limit') ?? 100) }));
  });

  // ---- Multi-gateway management (tab 'payments') ----
  router.add('GET', `${base}/admin/payments/gateways`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, { rows: await listGatewaysMasked() });
  });
  router.add('POST', `${base}/admin/payments/gateways`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    const b = bodyObject(ctx.body) as any;
    if (!b.name || !b.type) return error(ctx.res, 422, 'FIELDS_REQUIRED', 'نام و نوع درگاه لازم است.');
    const input: any = { id: b.id, name: String(b.name), type: String(b.type), merchantId: b.merchantId != null ? String(b.merchantId) : undefined, callbackUrl: b.callbackUrl != null ? String(b.callbackUrl) : undefined, availability: b.availability != null ? String(b.availability) : undefined, sandbox: b.sandbox != null ? !!b.sandbox : undefined, priority: b.priority != null ? Number(b.priority) : undefined };
    // Only overwrite secrets when a fresh (non-masked) value is provided.
    if (b.apiKey && !String(b.apiKey).startsWith('••••')) input.apiKey = String(b.apiKey);
    if (b.secret && !String(b.secret).startsWith('••••')) input.secret = String(b.secret);
    json(ctx.res, b.id ? 200 : 201, await saveGateway(input));
  });
  router.add('DELETE', `${base}/admin/payments/gateways/:id`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    const ok = await removeGateway(ctx.params.id!);
    if (!ok) return error(ctx.res, 404, 'GATEWAY_NOT_FOUND', 'درگاه یافت نشد.');
    json(ctx.res, 200, { removed: true });
  });
  router.add('POST', `${base}/admin/payments/gateways/:id/test`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await testConnection(ctx.params.id!));
  });
  router.add('GET', `${base}/admin/payments/settings`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await getPaymentSettings());
  });
  router.add('PUT', `${base}/admin/payments/settings`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, await updatePaymentSettings(bodyObject(ctx.body) as any));
  });
  router.add('GET', `${base}/admin/payments/reports`, async (ctx) => {
    if (!requireAdmin(ctx, { tab: 'payments' })) return;
    json(ctx.res, 200, { rows: await gatewayReports() });
  });
}
