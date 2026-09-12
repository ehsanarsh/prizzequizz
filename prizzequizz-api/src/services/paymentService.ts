/* Deposit (gateway) flow — hardened.
 *
 * Security model:
 *  - Amounts are validated server-side; the wallet is NEVER credited directly
 *    by any user-facing endpoint.
 *  - An intent is only settled through `settlePaymentIntent`, which requires a
 *    valid HMAC signature (what a real gateway callback carries; the sandbox
 *    pay URL embeds it). The old client "verify" endpoint is read-only now.
 *  - Settlement is atomic: a conditional status flip claims the intent exactly
 *    once, and the ledger credit is idempotent on `deposit:{intentId}` — so a
 *    replayed/raced callback can never double-credit.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getPgPool } from '../database/postgres.js';
import { repositories } from '../repositories/index.js';
import type { PaymentIntent, PaymentIntentStatus, PaymentProvider } from '../types/domain.js';
import { id } from '../utils/id.js';
import { logger } from './logger.js';
import { notifications } from './notificationService.js';
import { WALLET_LIMITS, WalletError, postEntry } from './walletLedgerService.js';
import { recordMoney } from './missionService.js';
import { getPaymentSettings, pickActiveGateway } from './paymentGatewayService.js';
import { fulfil, isGatewayPayable, parseOrder, quote, type PurchaseOrder } from './purchaseOrderService.js';
import { blupalConfigured, blupalMode, createInvoice as createBlupalInvoice, verifyPaid as verifyBlupalPaid } from './blupalService.js';

export interface PaymentDiagnostics {
  provider: PaymentProvider;
  created: number;
  pending: number;
  paid: number;
  failed: number;
  totalPaidAmount: number;
  pendingAmount: number;
}

function webhookSecret(): string {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') logger.warn('payment_webhook_secret_missing', { hint: 'set PAYMENT_WEBHOOK_SECRET' });
  return secret || 'dev-sandbox-secret';
}

export function paymentSignature(intentId: string, amount: number, status: 'paid' | 'failed'): string {
  return createHmac('sha256', webhookSecret()).update(`${intentId}:${amount}:${status}`).digest('hex');
}

function signatureValid(intent: PaymentIntent, sig: string, status: 'paid' | 'failed'): boolean {
  try {
    const expected = Buffer.from(paymentSignature(intent.id, intent.amount, status), 'hex');
    const got = Buffer.from(String(sig ?? ''), 'hex');
    return expected.length > 0 && expected.length === got.length && timingSafeEqual(expected, got);
  } catch { return false; }
}

/* THERE IS NO TOPPING UP ANY MORE.
 *
 * A payment must be FOR something. `order` says what, its price is taken from
 * the catalogue server-side — never from the client — and settlement delivers
 * that thing instead of crediting a balance. An intent with no order is a bare
 * wallet top-up, which the game no longer has, so it is refused rather than
 * quietly credited.
 *
 * The old deposit limits still guard the amount, because they are also a sane
 * bound on what a single purchase may cost. */
export async function createPaymentIntent(input: { userId: string; amount?: number; callbackUrl?: string; idempotencyKey?: string; order?: PurchaseOrder }): Promise<PaymentIntent> {
  if (!input.order) throw new WalletError('DEPOSIT_REMOVED', 'شارژ کیف پول حذف شده است؛ پرداخت باید برای یک خرید مشخص باشد.');
  const q = await quote(input.order);
  if (!isGatewayPayable(q)) throw new WalletError('ORDER_NOT_PAYABLE', 'این مورد از درگاه قابل پرداخت نیست.');
  const amount = q.amount;
  if (!Number.isFinite(amount) || amount < 1 || amount > WALLET_LIMITS.maxDeposit) throw new WalletError('PAYMENT_AMOUNT_INVALID', 'مبلغ پرداخت نامعتبر است.');
  const settings = await getPaymentSettings();
  // Pick the highest-priority enabled gateway (auto-switch handled at retry).
  const gateway = await pickActiveGateway();
  const key = input.idempotencyKey ? `payment:${input.userId}:${input.idempotencyKey}` : `payment:${input.userId}:${amount}:${Date.now()}:${id().slice(0, 8)}`;
  const existing = await repositories.payments.findByIdempotencyKey(key);
  if (existing) return existing;
  const intentId = id();
  const transactionId = id();
  const now = new Date().toISOString();

  /* THE CARD-TO-CARD GATEWAY.
   *
   * BluPal opens an invoice and gives back a page the player pays on. That call
   * happens BEFORE anything is written down, so a gateway that refuses (amount
   * out of their range, key rejected, their service down) leaves no half-made
   * intent behind for a callback to stumble on later.
   *
   * What is written down is the part settlement will need and must not take
   * from anybody else afterwards: which invoice this is, and the exact rial
   * figure that counts as paid. */
  let blupal: { invoiceId: number; finalRial: number; link: string; card: string; mode: string } | null = null;
  if (blupalConfigured()) {
    const inv = await createBlupalInvoice(amount);
    blupal = { invoiceId: inv.invoiceId, finalRial: inv.finalAmountRial, link: inv.paymentLink, card: inv.cardNumber, mode: inv.mode };
    if (inv.mode !== 'live' && process.env.NODE_ENV === 'production') {
      /* A test key on a live system can only make test invoices, and a test
       * invoice can be marked paid without any money moving. Everything still
       * matches — which is exactly why it has to be said out loud. */
      logger.warn('blupal_sandbox_key_in_production', { intentId, hint: 'BLUPAL_API_KEY is not a blu_live_ key; nothing sold through it is really paid for' });
    }
  }
  /* 'purchase', not 'topup': nothing is being added to a balance. */
  await repositories.transactions.save({ id: transactionId, userId: input.userId, type: 'purchase' as any, currency: 'cash', amount, direction: 'out', status: 'pending', reference: intentId, createdAt: now });
  const sig = paymentSignature(intentId, amount, 'paid');
  const intent: PaymentIntent = {
    id: intentId,
    userId: input.userId,
    provider: provider(),
    amount,
    currency: 'cash',
    status: 'pending',
    transactionId,
    // The sandbox pay URL carries the same signed proof a real gateway callback
    // would; without it, settlement is impossible.
    paymentUrl: blupal ? blupal.link : `/v1/payments/sandbox/${intentId}/pay?sig=${sig}`,
    callbackUrl: input.callbackUrl,
    providerReference: blupal ? `blupal:${blupal.invoiceId}` : `sandbox_${intentId}`,
    idempotencyKey: key,
    /* The order travels WITH the intent, because the callback that settles it
     * may arrive minutes later on a different process with no memory of the
     * request that started it. */
    metadata: blupal
      ? { sandbox: blupal.mode !== 'live', gatewayType: 'blupal', blupalInvoiceId: blupal.invoiceId, blupalFinalRial: blupal.finalRial, blupalCard: blupal.card, order: input.order, orderLabel: q.label }
      : { sandbox: gateway ? gateway.sandbox : provider() === 'sandbox', gatewayId: gateway?.id, gatewayName: gateway?.name, gatewayType: gateway?.type, order: input.order, orderLabel: q.label },
    createdAt: now,
    updatedAt: now
  };
  await repositories.payments.save(intent);
  return intent;
}

export async function getPaymentIntent(id: string, userId?: string): Promise<PaymentIntent | null> {
  const intent = await repositories.payments.findById(id);
  if (!intent) return null;
  if (userId && intent.userId !== userId) return null;
  return intent;
}

/* Atomically claim the intent (exactly one caller wins) and credit the ledger.
 * Called ONLY from signature-verified callback paths. */
export async function settlePaymentIntent(intentId: string, sig: string, status: 'paid' | 'failed' = 'paid'): Promise<PaymentIntent | null> {
  const intent = await repositories.payments.findById(intentId);
  if (!intent) return null;
  if (!signatureValid(intent, sig, status)) throw new WalletError('PAYMENT_SIGNATURE_INVALID', 'امضای پرداخت معتبر نیست.');
  if (intent.status === 'paid') return intent; // already settled — idempotent

  if (status === 'failed') {
    await repositories.transactions.updateStatus(intent.transactionId, 'failed', intent.id);
    return repositories.payments.updateStatus(intent.id, 'failed', { failedAt: new Date().toISOString(), metadata: { ...intent.metadata, verifiedAt: new Date().toISOString() } });
  }

  // Claim: conditional flip so concurrent callbacks race to exactly one winner.
  const claimed = await claimIntent(intentId);
  if (!claimed) return repositories.payments.findById(intentId); // another caller settled it

  /* DELIVER THE ORDER. The money paid at the gateway belongs to the house, not
   * to the player's صندوق — crediting it there and debiting it again would let
   * a purchase be laundered into a withdrawable prize, which is exactly what
   * removing top-ups is meant to prevent. So nothing is posted to the ledger:
   * the goods are simply handed over. */
  const order = parseOrder((intent.metadata as any)?.order);
  if (order) {
    try {
      await fulfil(intent.userId, order, `intent:${intent.id}`);
    } catch (e) {
      /* Paid but undelivered is the one outcome that must never be silent. */
      logger.error('payment_fulfilment_failed', { intentId: intent.id, userId: intent.userId, message: e instanceof Error ? e.message : 'unknown' });
      await notifications.create({ userId: intent.userId, type: 'wallet_update', title: 'پرداخت انجام شد، تحویل ناموفق', body: 'پرداختت موفق بود ولی تحویل انجام نشد. پشتیبانی پیگیری می‌کند.', data: { paymentIntentId: intent.id, url: '/support' }, push: true }).catch(() => undefined);
    }
  } else {
    logger.error('payment_settled_without_order', { intentId: intent.id, userId: intent.userId });
  }
  await repositories.transactions.updateStatus(intent.transactionId, 'paid', intent.id);
  const paid = await repositories.payments.updateStatus(intent.id, 'paid', { paidAt: new Date().toISOString(), metadata: { ...intent.metadata, verifiedAt: new Date().toISOString() } });
  const what = (intent.metadata as any)?.orderLabel || 'خریدت';
  await notifications.create({ userId: intent.userId, type: 'wallet_update', title: 'پرداخت موفق بود', body: `${what} فعال شد.`, data: { paymentIntentId: intent.id, amount: intent.amount, url: '/shop' }, push: true });
  return paid;
}

/* ---------------------------------------------------------------------------
 * BLUPAL SETTLEMENT — the one door, used by both ways the news can arrive.
 *
 * BluPal's webhook carries no signature. None. Their whole verification advice
 * is «check the invoice_id against your database», which only proves that WE
 * opened that invoice — it says nothing whatever about anybody having paid it.
 * Anyone who learns an invoice id could post it.
 *
 * So a webhook body is treated as a NUDGE and never as evidence: all it does is
 * name an invoice. What decides is `verifyPaid`, which asks BluPal over our own
 * connection with our own key, and refuses anything whose status, amount or
 * mode is not exactly what we recorded when we opened the invoice.
 *
 * The player coming back from the payment page goes through the same function,
 * so they do not sit staring at a spinner waiting for a webhook — and because
 * both doors lead here, and settlement is claimed exactly once, the two of them
 * arriving together still delivers one order.
 * ------------------------------------------------------------------------- */
export interface BlupalSettlement { paid: boolean; reason?: string; intent: PaymentIntent | null }

export async function settleBlupalIntent(intentId: string): Promise<BlupalSettlement> {
  const intent = await repositories.payments.findById(intentId);
  if (!intent) return { paid: false, reason: 'not_found', intent: null };
  /* Already delivered. Saying so is not the same as delivering again: nothing
   * below runs, and the answer a repeat callback gets is the true one. */
  if (intent.status === 'paid') return { paid: true, intent };
  if (intent.status === 'failed') return { paid: false, reason: 'failed', intent };

  const meta = (intent.metadata ?? {}) as Record<string, unknown>;
  const invoiceId = Number(meta.blupalInvoiceId ?? 0);
  const expected = Number(meta.blupalFinalRial ?? 0);
  if (!invoiceId || !expected) return { paid: false, reason: 'not_a_blupal_intent', intent };

  const v = await verifyBlupalPaid({ invoiceId, expectedFinalAmountRial: expected });
  if (!v.paid) {
    logger.info('blupal_not_paid_yet', { intentId: intent.id, invoiceId, reason: v.reason });
    return { paid: false, reason: v.reason, intent };
  }
  /* Who paid, for the support case that always follows a card-to-card payment.
   * It is written to the log rather than into the intent because BluPal's own
   * panel is the record of the transfer; this is the thread back to it. */
  logger.info('blupal_paid', {
    intentId: intent.id, userId: intent.userId, invoiceId,
    transactionId: v.invoice?.transactionId, payerBank: v.invoice?.payerBank, amountToman: intent.amount
  });

  /* The proof is the answer BluPal just gave us. The signature below is not a
   * second proof — it is simply how settlePaymentIntent is addressed, and the
   * secret it is made with is ours. Settlement itself claims the intent
   * exactly once, so two callbacks reaching this line still deliver one order. */
  const settled = await settlePaymentIntent(intent.id, paymentSignature(intent.id, intent.amount, 'paid'), 'paid');
  return { paid: settled?.status === 'paid', intent: settled };
}

/** Find the intent an invoice id belongs to. The id in a webhook body is the
 *  only thing it may be used for: naming which intent to go and verify. */
export async function findIntentByBlupalInvoice(invoiceId: number): Promise<PaymentIntent | null> {
  const ref = 'blupal:' + Math.floor(Number(invoiceId) || 0);
  try {
    if (process.env.DATABASE_URL) {
      const pool = getPgPool();
      const { rows } = await pool.query(`SELECT id FROM payment_intents WHERE provider_reference = $1 ORDER BY created_at DESC LIMIT 1`, [ref]);
      return rows[0]?.id ? repositories.payments.findById(String(rows[0].id)) : null;
    }
  } catch (e) {
    logger.warn('blupal_invoice_lookup_failed', { invoiceId, message: e instanceof Error ? e.message : 'unknown' });
  }
  const rows = await repositories.payments.list({ limit: 1000 });
  return rows.find((i) => i.providerReference === ref) ?? null;
}

/** Is the card-to-card gateway the one a payment would go to right now? */
export function blupalActive(): { configured: boolean; mode: ReturnType<typeof blupalMode> } {
  return { configured: blupalConfigured(), mode: blupalMode() };
}

/* One-winner claim of a pending intent. */
async function claimIntent(intentId: string): Promise<boolean> {
  try {
    if (process.env.DATABASE_URL) {
      const pool = getPgPool();
      const { rowCount } = await pool.query(`UPDATE payment_intents SET status='processing', updated_at=now() WHERE id=$1 AND status IN ('created','pending')`, [intentId]);
      return (rowCount ?? 0) > 0;
    }
  } catch { /* fall through to repo path (memory driver) */ }
  const intent = await repositories.payments.findById(intentId);
  if (!intent || intent.status === 'paid' || (intent.status as string) === 'processing') return false;
  await repositories.payments.updateStatus(intentId, 'processing' as PaymentIntentStatus, {});
  return true;
}

export async function listPaymentIntents(filter: { userId?: string; status?: PaymentIntentStatus; provider?: PaymentProvider; limit?: number } = {}): Promise<PaymentIntent[]> {
  return repositories.payments.list(filter);
}

export async function paymentDiagnostics(): Promise<PaymentDiagnostics> {
  const rows = await repositories.payments.list({ limit: 1000 });
  return {
    provider: provider(),
    created: rows.filter((i) => i.status === 'created').length,
    pending: rows.filter((i) => i.status === 'pending').length,
    paid: rows.filter((i) => i.status === 'paid').length,
    failed: rows.filter((i) => i.status === 'failed').length,
    totalPaidAmount: rows.filter((i) => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0),
    pendingAmount: rows.filter((i) => i.status === 'pending').reduce((sum, i) => sum + i.amount, 0)
  };
}

function provider(): PaymentProvider { return (process.env.PAYMENT_PROVIDER as PaymentProvider) || 'sandbox'; }
