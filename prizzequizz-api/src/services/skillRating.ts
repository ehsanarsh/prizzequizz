import type { Match } from '../types/domain.js';

// XP and weekly 🏆cup are now awarded server-side by matchEngine from the single
// PZ_SCORING config (per-question difficulty + streak + speed + win/draw/loss,
// with the weekly reset). This function used to add a second, flat xp/weeklyScore
// bump here, which would double-count — so it is intentionally a no-op now.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function updateSkillAfterMatch(_match: Match): Promise<void> {
  return;
}
