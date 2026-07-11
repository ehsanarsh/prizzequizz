import { repositories } from '../repositories/index.js';
import type { Transaction } from '../types/domain.js';
import { id } from '../utils/id.js';
import { notifications } from './notificationService.js';

export interface FinanceDiagnostics {
  totalTopups: number;
  totalWithdrawRequests: number;
  pendingWithdrawAmount: number;
  paidWithdrawAmount: number;
  failedWithdrawAmount: number;
  totalRewardsPaid: number;
  pendingRewardHoldAmount: number;
  netCashFlow: number;
  pendingWithdrawCount: number;
}

export async function financeDiagnostics(): Promise<FinanceDiagnostics> {
  const cashTxns = await repositories.transactions.list({ currency: 'cash', limit: 1000 });
  const rewardHolds = await repositories.rewardHolds.list({ limit: 1000 });
  const totalTopups = sum(cashTxns.filter((t) => t.type === 'topup' && t.direction === 'in' && t.status !== 'failed'));
  const withdraws = cashTxns.filter((t) => t.type === 'withdraw' && t.direction === 'out');
  const totalWithdrawRequests = sum(withdraws.filter((t) => t.status !== 'failed'));
  const pendingWithdrawAmount = sum(withdraws.filter((t) => t.status === 'pending'));
  const paidWithdrawAmount = sum(withdraws.filter((t) => t.status === 'paid'));
  const failedWithdrawAmount = sum(withdraws.filter((t) => t.status === 'failed'));
  const totalRewardsPaid = sum(cashTxns.filter((t) => t.type === 'reward' && t.direction === 'in' && t.status === 'ok'));
  const pendingRewardHoldAmount = rewardHolds.filter((h) => h.status === 'pending' && h.rewardType === 'cash').reduce((total, hold) => total + hold.amount, 0);
  return {
    totalTopups,
    totalWithdrawRequests,
    pendingWithdrawAmount,
    paidWithdrawAmount,
    failedWithdrawAmount,
    totalRewardsPaid,
    pendingRewardHoldAmount,
    netCashFlow: totalTopups - paidWithdrawAmount - totalRewardsPaid,
    pendingWithdrawCount: withdraws.filter((t) => t.status === 'pending').length
  };
}

export async function listWithdrawals(status?: Transaction['status'], limit = 100): Promise<Transaction[]> {
  return repositories.transactions.list({ type: 'withdraw', currency: 'cash', direction: 'out', status, limit });
}

export async function reviewWithdrawal(id: string, action: 'approve' | 'reject', reviewedBy: string): Promise<Transaction | null> {
  const txn = await repositories.transactions.findById(id);
  if (!txn || txn.type !== 'withdraw' || txn.direction !== 'out') return null;
  if (action === 'approve') {
    const updated = await repositories.transactions.updateStatus(id, 'paid', `approved:${reviewedBy}:${txn.reference ?? id}`);
    if (updated) await notifications.create({ userId: updated.userId, type: 'wallet_update', title: 'برداشت پرداخت شد', body: `برداشت ${updated.amount.toLocaleString('fa-IR')} تومان پرداخت شد.`, data: { transactionId: updated.id, url: '/wallet' }, push: true });
    return updated;
  }
  const user = await repositories.users.findById(txn.userId);
  if (user && txn.status !== 'failed') {
    user.wallet += txn.amount;
    await repositories.users.save(user);
    await repositories.transactions.save({ id: idGen(), userId: user.id, type: 'withdraw_refund', currency: 'cash', amount: txn.amount, direction: 'in', status: 'ok', reference: txn.id, createdAt: new Date().toISOString() });
  }
  const updated = await repositories.transactions.updateStatus(id, 'failed', `rejected:${reviewedBy}:${txn.reference ?? id}`);
  if (updated) await notifications.create({ userId: updated.userId, type: 'wallet_update', title: 'برداشت رد شد', body: `درخواست برداشت ${updated.amount.toLocaleString('fa-IR')} تومان رد شد و مبلغ به کیف پول برگشت.`, data: { transactionId: updated.id, url: '/wallet' }, push: true });
  return updated;
}

export function transactionsToCsv(rows: Transaction[]): string {
  const header = ['id','userId','type','currency','amount','direction','status','reference','createdAt'];
  const lines = rows.map((t) => [t.id,t.userId,t.type,t.currency,t.amount,t.direction,t.status,t.reference ?? '',t.createdAt].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n');
}

function sum(rows: Transaction[]): number { return rows.reduce((total, txn) => total + Number(txn.amount || 0), 0); }
function csvCell(value: unknown): string { return `"${String(value).replaceAll('"', '""')}"`; }
function idGen(): string { return id(); }
