import { repositories } from '../repositories/index.js';
import type { Match } from '../types/domain.js';
import { leaderboards } from './leaderboardService.js';

export async function updateSkillAfterMatch(match: Match): Promise<void> {
  if (!match.winnerUserId) return;
  for (const player of match.players) {
    const user = await repositories.users.findById(player.userId);
    if (!user || player.userId.startsWith('bot_')) continue;
    const won = player.userId === match.winnerUserId;
    user.weeklyScore += won ? 35 : 8;
    user.xp += won ? 50 : 15;
    await repositories.users.save(user);
    await leaderboards.updateUser(user);
  }
}
