import { repositories } from '../repositories/index.js';
import type { PaymentIntent, PaymentIntentStatus, PaymentProvider } from '../types/domain.js';
import { id } from '../utils/id.js';
import { notifications } from './notificationService.js';

export interface PaymentDiagnostics {
  provider: PaymentProvider;
  created: number;
  pending: number;
  paid: number;
  failed: number;
  totalPaidAmount: number;
  pendingAmount: number;
}

export async function createPaymentIntent(input: { userId: string; amount: number; callbackUrl?: string; idempotencyKey?: string }): Promise<PaymentIntent> {
  if (!Number.isFinite(input.amount) || input.amount < 10_000) throw new Error('PAYMENT_AMOUNT_INVALID');
  const key = input.idempotencyKey ?? `payment:${input.userId}:${input.amount}:${Date.now()}`;
  const existing = await repositories.payments.findByIdempotencyKey(key);
  if (existing) return existing;
  const intentId = id();
  const transactionId = id();
  const now = new Date().toISOString();
  await repositories.transactions.save({ id: transactionId, userId: input.userId, type: 'topup', currency: 'cash', amount: input.amount, direction: 'in', status: 'pending', reference: intentId, createdAt: now });
  const intent: PaymentIntent = {
    id: intentId,
    userId: input.userId,
    provider: provider(),
    amount: input.amount,
    currency: 'cash',
    status: 'pending',
    transactionId,
    paymentUrl: `/v1/payments/sandbox/${intentId}/pay`,
    callbackUrl: input.callbackUrl,
    providerReference: `sandbox_${intentId}`,
    idempotencyKey: key,
    metadata: { sandbox: true },
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

export async function verifyPaymentIntent(intentId: string, status: 'paid' | 'failed' = 'paid'): Promise<PaymentIntent | null> {
  const intent = await repositories.payments.findById(intentId);
  if (!intent) return null;
  if (intent.status === 'paid') return intent;
  if (status === 'failed') {
    await repositories.transactions.updateStatus(intent.transactionId, 'failed', intent.id);
    return repositories.payments.updateStatus(intent.id, 'failed', { failedAt: new Date().toISOString(), metadata: { ...intent.metadata, verifiedAt: new Date().toISOString() } });
  }
  const user = await repositories.users.findById(intent.userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  user.wallet += intent.amount;
  await repositories.users.save(user);
  await repositories.transactions.updateStatus(intent.transactionId, 'paid', intent.id);
  const paid = await repositories.payments.updateStatus(intent.id, 'paid', { paidAt: new Date().toISOString(), metadata: { ...intent.metadata, verifiedAt: new Date().toISOString() } });
  await notifications.create({ userId: intent.userId, type: 'wallet_update', title: 'پرداخت موفق بود', body: `${intent.amount.toLocaleString('fa-IR')} تومان به کیف پول اضافه شد.`, data: { paymentIntentId: intent.id, amount: intent.amount, url: '/wallet' }, push: true });
  return paid;
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
