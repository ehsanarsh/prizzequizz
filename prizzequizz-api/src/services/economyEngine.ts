import { gameConfig } from '../core/config.js';
import { repositories } from '../repositories/index.js';
import type { GameModeId, PlanType, User } from '../types/domain.js';

export async function chargeEntry(user: User, modeId: GameModeId, economyType: PlanType, coinStake?: number): Promise<void> {
  const mode = gameConfig.modes[modeId];
  if (!mode) throw new Error('Unknown mode');
  if (economyType === 'free') {
    const hearts = mode.entry?.free?.hearts ?? 1;
    const coins = coinStake ?? mode.entry?.free?.coins ?? 0;
    if (user.hearts < hearts) throw new Error('INSUFFICIENT_HEARTS');
    if (user.coins < coins) throw new Error('INSUFFICIENT_COINS');
    user.hearts -= hearts;
    user.coins -= coins;
  } else {
    // Paid (cash) entries are charged as a real ledger `match_stake` at
    // matchmaking-enqueue time (see modules/matchmaking/routes.ts). Charging
    // here too would double-debit, and direct wallet mutation is forbidden —
    // the ledger is the only money authority.
  }
  await repositories.users.save(user);
}
