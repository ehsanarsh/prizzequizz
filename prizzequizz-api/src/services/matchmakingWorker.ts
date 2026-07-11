import { matchmakingQueue } from './matchmakingQueue.js';
import { logger } from './logger.js';

let timer: NodeJS.Timeout | null = null;

export function startMatchmakingWorker(): void {
  if (timer) return;
  const intervalMs = Number(process.env.MATCHMAKING_WORKER_INTERVAL_MS ?? 5000);
  const expireMs = Number(process.env.MATCHMAKING_EXPIRE_MS ?? 60000);
  // Human-only gameplay: bot fallback is intentionally disabled. Unmatched
  // tickets simply expire after `expireMs` and the client returns home.
  timer = setInterval(async () => {
    try {
      const expired = await matchmakingQueue.expireOldTickets(expireMs);
      if (expired) logger.info('matchmaking_worker_tick', { expired });
    } catch (error) {
      logger.error('matchmaking_worker_error', { message: error instanceof Error ? error.message : 'unknown' });
    }
  }, intervalMs);
  timer.unref?.();
  logger.info('matchmaking_worker_started', { intervalMs, expireMs, botFallback: false });
}

export function stopMatchmakingWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
