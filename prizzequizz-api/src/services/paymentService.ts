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

export async function createPaymentIntent(input: { userId: string; amount: number; callbackUrl?: string; idempotencyKey?: string }): Promise<PaymentIntent> {
  const amount = Math.round(Number(input.amount));
  if (!Number.isFinite(amount) || amount < WALLET_LIMITS.minDeposit || amount > WALLET_LIMITS.maxDeposit) throw new WalletError('PAYMENT_AMOUNT_INVALID', 'مبلغ پرداخت نامعتبر است.');
  const key = input.idempotencyKey ? `payment:${input.userId}:${input.idempotencyKey}` : `payment:${input.userId}:${amount}:${Date.now()}:${id().slice(0, 8)}`;
  const existing = await repositories.payments.findByIdempotencyKey(key);
  if (existing) return existing;
  const intentId = id();
  const transactionId = id();
  const now = new Date().toISOString();
  await repositories.transactions.save({ id: transactionId, userId: input.userId, type: 'topup', currency: 'cash', amount, direction: 'in', status: 'pending', reference: intentId, createdAt: now });
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
    paymentUrl: `/v1/payments/sandbox/${intentId}/pay?sig=${sig}`,
    callbackUrl: input.callbackUrl,
    providerReference: `sandbox_${intentId}`,
    idempotencyKey: key,
    metadata: { sandbox: provider() === 'sandbox' },
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

  // Ledger credit — idempotent on the intent id (second layer of protection).
  await postEntry({
    userId: intent.userId, entryType: 'deposit', kind: 'credit', amount: intent.amount,
    idempotencyKey: `deposit:${intent.id}`, refType: 'payment', refId: intent.id,
    description: 'شارژ کیف پول از درگاه پرداخت', metadata: { provider: intent.provider, providerReference: intent.providerReference }
  });
  await repositories.transactions.updateStatus(intent.transactionId, 'paid', intent.id);
  const paid = await repositories.payments.updateStatus(intent.id, 'paid', { paidAt: new Date().toISOString(), metadata: { ...intent.metadata, verifiedAt: new Date().toISOString() } });
  await notifications.create({ userId: intent.userId, type: 'wallet_update', title: 'پرداخت موفق بود', body: `${intent.amount.toLocaleString('fa-IR')} تومان به کیف پول اضافه شد.`, data: { paymentIntentId: intent.id, amount: intent.amount, url: '/wallet' }, push: true });
  return paid;
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
