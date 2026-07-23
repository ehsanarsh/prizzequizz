/* New-user reward campaign — fully automatic. When enabled and within its date
 * window, every NEW user gets the configured wallet bonus + free tickets + XP on
 * signup. Config lives at gameConfig.campaign so the admin controls it live.
 * Dates are ISO (YYYY-MM-DD); empty = unbounded on that side. Never throws. */
import { gameConfig } from '../core/config.js';
import { repositories } from '../repositories/index.js';
import { postEntry } from './walletLedgerService.js';
import { grantTickets } from './ticketService.js';
import { notifications } from './notificationService.js';
import { logger } from './logger.js';

export async function grantNewUserCampaign(userId: string): Promise<void> {
  try {
    const c: any = (gameConfig as any).campaign;
    if (!c || c.enabled !== true) return;
    const now = Date.now();
    if (c.startDate && now < Date.parse(String(c.startDate) + 'T00:00:00')) return;
    if (c.endDate && now > Date.parse(String(c.endDate) + 'T23:59:59')) return;
    const wallet = Number(c.walletBonus) || 0;
    const tickets = Number(c.ticketCount) || 0;
    const xp = Number(c.xp) || 0;
    if (wallet <= 0 && tickets <= 0 && xp <= 0) return;

    if (wallet > 0) {
      // Idempotency-keyed so a retry never double-grants.
      await postEntry({ userId, entryType: 'bonus', kind: 'credit', amount: wallet, idempotencyKey: `campaign_bonus:${userId}`, description: 'هدیهٔ کاربر جدید' }).catch(() => undefined);
    }
    if (tickets > 0) await grantTickets(userId, String(c.ticketTier || 'green'), tickets).catch(() => undefined);
    if (xp > 0) { const u = await repositories.users.findById(userId); if (u) { u.xp = (Number(u.xp) || 0) + xp; await repositories.users.save(u); } }

    const parts: string[] = [];
    if (wallet > 0) parts.push(`${wallet.toLocaleString('fa-IR')} تومان اعتبار`);
    if (tickets > 0) parts.push(`${tickets} بلیت ${c.ticketTier || 'green'}`);
    if (xp > 0) parts.push(`${xp} XP`);
    await notifications.create({ userId, type: 'system', title: 'هدیهٔ خوش‌آمد 🎁', body: 'به‌عنوان کاربر جدید دریافت کردی: ' + parts.join(' + '), data: { url: '/wallet' }, push: true }).catch(() => undefined);
    logger.info('campaign_granted', { userId, wallet, tickets, xp });
  } catch (e) {
    logger.warn('campaign_grant_failed', { userId, message: e instanceof Error ? e.message : 'unknown' });
  }
}
