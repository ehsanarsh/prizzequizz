import type { Router } from '../../http/router.js';
import { json } from '../../http/response.js';
import { repositories } from '../../repositories/index.js';
import { id } from '../../utils/id.js';
import { bodyObject, requiredNumber } from '../../utils/validation.js';
import { notifications } from '../../services/notificationService.js';

export function registerWalletRoutes(router: Router, base: string): void {
  router.add('GET', `${base}/wallet`, async (ctx) => json(ctx.res, 200, await walletDto(ctx.userId ?? 'u1')));
  router.add('POST', `${base}/wallet/topup`, async (ctx) => {
    const amount = requiredNumber(bodyObject(ctx.body), 'amount');
    const u = (await repositories.users.findById(ctx.userId ?? 'u1'))!;
    u.wallet += amount;
    await repositories.users.save(u);
    await addTxn(u.id, 'topup', 'cash', amount, 'in', 'ok');
    await notifications.create({ userId: u.id, type: 'wallet_update', title: 'کیف پول شارژ شد', body: `${amount.toLocaleString('fa-IR')} تومان به کیف پول اضافه شد.`, data: { amount, url: '/wallet' }, push: true });
    json(ctx.res, 200, await walletDto(u.id));
  });
  router.add('POST', `${base}/wallet/withdraw`, async (ctx) => {
    const amount = requiredNumber(bodyObject(ctx.body), 'amount');
    const u = (await repositories.users.findById(ctx.userId ?? 'u1'))!;
    u.wallet -= amount;
    await repositories.users.save(u);
    await addTxn(u.id, 'withdraw', 'cash', amount, 'out', 'pending');
    await notifications.create({ userId: u.id, type: 'wallet_update', title: 'درخواست برداشت ثبت شد', body: `${amount.toLocaleString('fa-IR')} تومان برای برداشت در صف بررسی قرار گرفت.`, data: { amount, url: '/wallet' }, push: true });
    json(ctx.res, 200, await walletDto(u.id));
  });
}

async function walletDto(userId: string) {
  const u = (await repositories.users.findById(userId))!;
  return { wallet: u.wallet, coins: u.coins, hearts: u.hearts, tickets: u.tickets, transactions: await repositories.transactions.listByUser(userId) };
}

async function addTxn(userId: string, type: string, currency: any, amount: number, direction: any, status: any) {
  await repositories.transactions.save({ id: id(), userId, type, currency, amount, direction, status, reference: id(), createdAt: new Date().toISOString() });
}
