/* PAYING OUT A LADDER — the one place a run's money reaches a wallet.
 *
 * Separate from duelRunService on purpose: that file is bookkeeping and knows
 * nothing about money, this one moves it. Both the player pressing «برداشت» and
 * the sweeper that settles a run nobody came back for land here, so there is a
 * single crediting path and a single idempotency key.
 *
 * The figure credited is the NET — what the wallet actually receives. That is
 * also the second half of the report: the prize used to be posted as the GROSS
 * with the commission as a separate row underneath, so a player reading their
 * transactions saw «۱۰۰٬۰۰۰» for a prize that was really 95,000. The
 * commission is still recorded — it has to be, it is real revenue — but as its
 * own internal row, and never as part of the number quoted as the prize.
 */
import { repositories } from '../repositories/index.js';
import { getRakePercent } from './economyConfig.js';
import { feeFor, netPrize } from './prizeService.js';
import { getAccount, postEntry } from './walletLedgerService.js';
import { settle, idleWonRuns } from './duelRunService.js';
import { notifications } from './notificationService.js';
import { logger } from './logger.js';

/** Settles the run and credits the player. Returns what was paid, 0 if there
 *  was nothing to pay (already settled, lost, or still in play). */
export async function settleRunToWallet(runId: string, userId: string): Promise<number> {
  /* settle() flips the run to 'settled' and hands back the gross exactly once,
     so two taps on «برداشت» — or a tap racing the sweeper — cannot both pay. */
  const done = await settle(runId);
  if (!done || done.run.userId !== userId) return 0;

  const gross = done.gross;
  const fee = feeFor(gross);
  const net = netPrize(gross);
  const rakePercent = getRakePercent();

  try {
    await postEntry({
      userId, entryType: 'match_reward', kind: 'credit', amount: net,
      idempotencyKey: `duel_run:${runId}`, refType: 'duel_run', refId: runId,
      description: 'جایزه برد دوئل', metadata: { gross, rakePercent, fee, net, stage: done.run.stage, entryTier: done.run.entryTier }
    });
    /* NO SEPARATE FEE ROW, on purpose. The old shape credited the player the
       GROSS and then took the commission back as a `fee` debit — and `fee` is
       hidden from the player's transaction list, so what they read was
       «۱۰۰٬۰۰۰» for a prize that put 95,000 in their wallet. The player never
       holds the gross; the pot is the platform's until it pays out. So the
       commission is simply not part of what is paid, and the row says exactly
       what arrived. The amount kept is on the entry (metadata.fee) for the
       books. */
    const user = await repositories.users.findById(userId);
    if (user) { user.wallet = (await getAccount(userId)).available; await repositories.users.save(user); }
    await notifications.create({
      userId, type: 'wallet_update', title: 'جایزه دریافت شد',
      body: `${net.toLocaleString('fa-IR')} تومان به حساب تو اضافه شد.`,
      data: { runId, amount: net, url: '/wallet' }, push: true
    }).catch(() => undefined);
  } catch (e) {
    logger.error('duel_run_payout_failed', { runId, userId, message: e instanceof Error ? e.message : 'unknown' });
    return 0;
  }
  return net;
}

/* THE RUNS NOBODY CAME BACK FOR.
 * A player who wins a rung and then closes the app has money parked in a run
 * they are no longer looking at. It is theirs, so after a quiet spell it is
 * paid to them at the rung they actually won — the game never keeps it, and
 * closing the app is never a way to dodge a loss, because a loss has already
 * closed its own run with nothing in it. */
export async function sweepIdleRuns(now = Date.now()): Promise<number> {
  let paid = 0;
  let runs: Awaited<ReturnType<typeof idleWonRuns>> = [];
  try { runs = await idleWonRuns(now); } catch { return 0; }
  for (const run of runs) {
    try { if (await settleRunToWallet(run.id, run.userId) > 0) paid += 1; }
    catch (e) { logger.error('duel_run_sweep_failed', { runId: run.id, message: e instanceof Error ? e.message : 'unknown' }); }
  }
  if (paid) logger.info('duel_runs_swept', { paid });
  return paid;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startDuelRunSweeper(intervalMs = 60_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweepIdleRuns(); }, intervalMs);
  sweepTimer.unref?.();
  logger.info('duel_run_sweeper_started', { intervalMs });
}
export function stopDuelRunSweeper(): void { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }
