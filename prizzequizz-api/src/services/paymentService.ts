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
import { getGateway, getPaymentSettings, pickActiveGateway } from './paymentGatewayService.js';
import { fulfil, isGatewayPayable, parseOrder, quote, type PurchaseOrder } from './purchaseOrderService.js';
import type { FulfilSource } from './orderFulfilmentService.js';

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

/** The gateway the player picked — if it is still open. */
async function requireLiveGateway(gatewayId: string) {
  const g = await getGateway(gatewayId);
  if (!g) throw new WalletError('GATEWAY_NOT_FOUND', 'این روش پرداخت وجود ندارد.');
  if (g.availability !== 'live') {
    throw new WalletError('GATEWAY_NOT_AVAILABLE', 'این روش پرداخت فعلاً در دسترس نیست.');
  }
  return g;
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
export async function createPaymentIntent(input: { userId: string; amount?: number; callbackUrl?: string; idempotencyKey?: string; order?: PurchaseOrder; gatewayId?: string }): Promise<PaymentIntent> {
  if (!input.order) throw new WalletError('DEPOSIT_REMOVED', 'شارژ کیف پول حذف شده است؛ پرداخت باید برای یک خرید مشخص باشد.');
  const q = await quote(input.order);
  if (!isGatewayPayable(q)) throw new WalletError('ORDER_NOT_PAYABLE', 'این مورد از درگاه قابل پرداخت نیست.');
  const amount = q.amount;
  if (!Number.isFinite(amount) || amount < 1 || amount > WALLET_LIMITS.maxDeposit) throw new WalletError('PAYMENT_AMOUNT_INVALID', 'مبلغ پرداخت نامعتبر است.');
  const settings = await getPaymentSettings();
  /* The player may name the gateway they chose in the sheet — but it is their
   * CHOICE, never their permission: it is re-checked here, because a client
   * that sends the id of a «coming soon» gateway must not be able to open a
   * door the panel has closed. With nothing named, the highest-priority live
   * gateway is used (auto-switch handled at retry). */
  const gateway = input.gatewayId
    ? await requireLiveGateway(input.gatewayId)
    : await pickActiveGateway();
  /* NO GATEWAY MEANS NO PAYMENT — it does not mean the ambient provider.
   *
   * This used to fall through to `provider()`, which defaults to 'sandbox':
   * an operator who set every gateway to «به‌زودی» would not be closing the
   * door, they would be handing every player a self-settling sandbox link. */
  if (!gateway) throw new WalletError('GATEWAY_NOT_AVAILABLE', 'در حال حاضر هیچ روش پرداخت آنلاینی فعال نیست.');
  /* CARD-TO-CARD HAS TO BE CHOSEN, NEVER FALLEN INTO.
   *
   * It settles on a page the client has to render — a card, an exact figure, a
   * deadline. A client that did not name it (an old cached build, which sends
   * no `gatewayId`) cannot show any of that: it would follow a `paymentUrl`
   * that is not there, and an amount slot would be held for a payment its
   * owner never saw. Better a sentence telling them to refresh. */
  if (!input.gatewayId && gateway.type === 'card_to_card') {
    throw new WalletError('GATEWAY_SELECTION_REQUIRED',
      'برای پرداخت کارت‌به‌کارت باید روش پرداخت را انتخاب کنی. صفحه را تازه کن و دوباره تلاش کن.');
  }
  const key = input.idempotencyKey ? `payment:${input.userId}:${input.idempotencyKey}` : `payment:${input.userId}:${amount}:${Date.now()}:${id().slice(0, 8)}`;
  const existing = await repositories.payments.findByIdempotencyKey(key);
  if (existing) return existing;
  const intentId = id();
  const transactionId = id();
  const now = new Date().toISOString();
  /* 'purchase', not 'topup': nothing is being added to a balance. */
  await repositories.transactions.save({ id: transactionId, userId: input.userId, type: 'purchase' as any, currency: 'cash', amount, direction: 'out', status: 'pending', reference: intentId, createdAt: now });
  /* THE SANDBOX PAY LINK IS A SELF-SETTLING URL, AND ONLY THE SANDBOX MAY HAVE ONE.
   *
   * It carries the HMAC that settles the intent, which is the whole point of a
   * simulated gateway: the client fetches it and the purchase completes. Handed
   * to any other kind of gateway it is a hole — a card-to-card payer could
   * settle their own order, take the goods, and never transfer a rial.
   *
   * The test is the TYPE, not the `sandbox` flag: a card-to-card gateway is
   * created with `sandbox: true` by default, and that flag must not be what
   * decides whether a payment can settle itself. */
  const isSandboxGateway = gateway.type === 'sandbox';
  const sig = paymentSignature(intentId, amount, 'paid');
  const intent: PaymentIntent = {
    id: intentId,
    userId: input.userId,
    provider: (gateway.type === 'card_to_card' ? 'card_to_card' : provider()) as PaymentProvider,
    amount,
    currency: 'cash',
    status: 'pending',
    transactionId,
    paymentUrl: isSandboxGateway ? `/v1/payments/sandbox/${intentId}/pay?sig=${sig}` : '',
    callbackUrl: input.callbackUrl,
    providerReference: isSandboxGateway ? `sandbox_${intentId}` : '',
    idempotencyKey: key,
    /* The order travels WITH the intent, because the callback that settles it
     * may arrive minutes later on a different process with no memory of the
     * request that started it. */
    metadata: { sandbox: gateway.sandbox, gatewayId: gateway.id, gatewayName: gateway.name, gatewayType: gateway.type, order: input.order, orderLabel: q.label },
    createdAt: now,
    updatedAt: now
  };
  await repositories.payments.save(intent);
  return intent;
}

/* AN INTENT WHOSE PAYMENT PAGE NEVER OPENED.
 *
 * The intent row is written before the card-to-card session is allocated,
 * because the session has to point at something. If no amount can be reserved
 * there is nothing for the player to pay, and a `pending` intent left behind
 * would sit in the payments screen forever and count as pending money in the
 * gateway report.
 *
 * Deliberately NOT a settlement path: it only ever moves an unsettled intent
 * to `failed`, never touches the ledger, and refuses to act on one that is
 * already paid — so it can never be used to bury a real payment.
 */
export async function abandonPaymentIntent(intentId: string, reason: string): Promise<void> {
  const intent = await repositories.payments.findById(intentId);
  if (!intent || intent.status === 'paid' || intent.status === 'failed') return;
  await repositories.transactions.updateStatus(intent.transactionId, 'failed', intent.id);
  await repositories.payments.updateStatus(intent.id, 'failed', {
    failedAt: new Date().toISOString(),
    metadata: { ...intent.metadata, abandonedReason: reason }
  });
  logger.warn('payment_intent_abandoned', { intentId, userId: intent.userId, reason });
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

  return deliverAndMarkPaid(intent, 'gateway');
}

/* THE ONE DELIVERY PATH, WHATEVER PROVED THE MONEY ARRIVED.
 *
 * A gateway callback carries an HMAC; a card-to-card payment carries a bank
 * SMS an operator or a matcher tied to a session. Those are two ways of
 * BELIEVING the money came — not two ways of handing over the goods. Keeping
 * one delivery path is what stops the two drifting: an order that gets a
 * mission counter or a receipt on one route and not the other.
 *
 * Everything that decides WHETHER to believe stays in the caller. By the time
 * this runs, that question is settled.
 */
async function deliverAndMarkPaid(intent: PaymentIntent, source: FulfilSource): Promise<PaymentIntent | null> {
  // Claim: conditional flip so concurrent callers race to exactly one winner.
  const claimed = await claimIntent(intent.id);
  if (!claimed) return repositories.payments.findById(intent.id); // another caller settled it

  /* DELIVER THE ORDER. The money paid outside belongs to the house, not to the
   * player's صندوق — crediting it there and debiting it again would let a
   * purchase be laundered into a withdrawable prize, which is exactly what
   * removing top-ups is meant to prevent. So nothing is posted to the ledger:
   * the goods are simply handed over. */
  const order = parseOrder((intent.metadata as any)?.order);
  if (order) {
    try {
      await fulfil(intent.userId, order, `intent:${intent.id}`, {
        source, amountToman: intent.amount, paymentRef: intent.id
      });
    } catch (e) {
      /* Paid but undelivered is the one outcome that must never be silent. */
      logger.error('payment_fulfilment_failed', { intentId: intent.id, userId: intent.userId, source, message: e instanceof Error ? e.message : 'unknown' });
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

/**
 * Settle a card-to-card intent. NO SIGNATURE, deliberately.
 *
 * There is nothing to sign: the bank does not call us back. What stands in for
 * the HMAC is the transfer itself — a deposit of an amount that was reserved
 * for exactly this session, tied to it by the caller. So this function is
 * dangerous in a way `settlePaymentIntent` is not, and the rule that keeps it
 * safe is that ONLY the card-to-card settlement path may call it: a route that
 * exposes it to anything a player can reach is a free-goods button.
 */
export async function settleCardToCardIntent(intentId: string): Promise<PaymentIntent | null> {
  const intent = await repositories.payments.findById(intentId);
  if (!intent) return null;
  if (intent.status === 'paid') return intent;   // idempotent
  if ((intent.metadata as any)?.gatewayType !== 'card_to_card') {
    /* A gateway intent settles by callback and nothing else. Letting this
     * settle one would be a way around the signature check. */
    throw new WalletError('INTENT_NOT_CARD_TO_CARD', 'این پرداخت از مسیر کارت‌به‌کارت نیست.');
  }
  return deliverAndMarkPaid(intent, 'card_to_card');
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
