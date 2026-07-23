// ============================================================================
// PrizzeQuizz scoring — the SINGLE source of truth for both systems.
//   • XP  → permanent progression (level, unlocks, titles). Never decreases.
//   • Cup → 🏆 weekly competitive score (rank + league). Resets every week.
// Free mode uses the base numbers; paid mode multiplies them by PAID_MULTIPLIER.
// Every value here is safe to change — the client only DISPLAYS what the server
// computes, so the leaderboard stays real and cheat-resistant.
// ============================================================================

import { gameConfig } from '../core/config.js';

export interface Points { xp: number; cup: number; }

/* Live end-of-match outcome bonus — reads the admin-editable `scoring` config
 * (winBonusXp/winBonusCup/…) and falls back to the constants below. So the
 * panel's XP/cup edits take effect immediately without a redeploy. */
export function getResultBonus(outcome: 'win' | 'draw' | 'loss'): Points {
  const xpc: any = (gameConfig as any)?.xp ?? {};
  const cupc: any = (gameConfig as any)?.cup ?? {};
  const s: any = (gameConfig as any)?.scoring ?? {};
  const base = PZ_SCORING.result[outcome] ?? { xp: 0, cup: 0 };
  // Priority: the panel-facing xp/cup blocks → legacy scoring block → constants.
  const xpKey = { win: 'perWin', draw: 'perDraw', loss: 'perLoss' }[outcome];
  const cupKey = { win: 'win', draw: 'draw', loss: 'loss' }[outcome];
  const scXp = { win: 'winBonusXp', draw: 'drawBonusXp', loss: 'lossBonusXp' }[outcome];
  const scCup = { win: 'winBonusCup', draw: 'drawBonusCup', loss: 'lossBonusCup' }[outcome];
  const pick = (...vals: unknown[]) => { for (const v of vals) { const n = Number(v); if (Number.isFinite(n)) return n; } return 0; };
  const mult = Number((xpc as any).multiplier); const m = Number.isFinite(mult) && mult > 0 ? mult : 1;
  return {
    xp: Math.round(pick(xpc[xpKey], s[scXp], base.xp) * m),
    cup: pick(cupc[cupKey], s[scCup], base.cup)
  };
}

export const PZ_SCORING = {
  paidMultiplier: 3,

  // Per answered question (by difficulty), plus a small consolation for a wrong one.
  perQuestion: {
    easy: { xp: 10, cup: 1 },
    medium: { xp: 15, cup: 2 },
    hard: { xp: 20, cup: 3 },
    veryhard: { xp: 28, cup: 5 },
    wrong: { xp: 2, cup: 0 }
  } as Record<string, Points>,

  // End-of-match outcome — even the loser keeps earning, so they stay in the league.
  result: {
    win: { xp: 40, cup: 20 },
    draw: { xp: 20, cup: 10 },
    loss: { xp: 10, cup: 5 }
  } as Record<string, Points>,

  // Consecutive-correct bonuses (checked at exactly N in a row).
  streak: [
    { n: 3, xp: 5, cup: 1 },
    { n: 5, xp: 10, cup: 2 },
    { n: 10, xp: 20, cup: 5 }
  ] as Array<{ n: number } & Points>,

  // Speed = a small BONUS only (never a big point gap) for the first correct
  // answer of a round, so a faster connection can't dominate the leaderboard.
  speedFirstCorrect: { xp: 3, cup: 1 } as Points,

  // Ascension: reward pushing further (stage 1..N). NOT wired to awarding yet —
  // ready for the next phase (the client will report the stage, capped server-side).
  stageBonus: [
    { stage: 1, xp: 20, cup: 10 },
    { stage: 2, xp: 30, cup: 15 },
    { stage: 3, xp: 40, cup: 20 }
    // …每 stage +10 XP / +5 cup; final (stage 10) ≈ { xp: 100, cup: 50 }.
  ] as Array<{ stage: number } & Points>,
  stageStepXp: 10,   // extra XP per stage beyond the table
  stageStepCup: 5,   // extra cup per stage beyond the table

  // Missions (phase 2): XP-heavy, cup light — for the collector / progression player.
  missions: {
    firstWinToday: { xp: 50, cup: 5 },
    play5: { xp: 80, cup: 5 },
    tenNoMistake: { xp: 100, cup: 10 },
    inviteFriend: { xp: 150, cup: 10 },
    winByFive: { xp: 120, cup: 10 }
  } as Record<string, Points>
};

// ISO-week id like "2026-W29". The weekly cup board resets when this changes.
export function isoWeekId(date: Date = new Date()): string {
  const t = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Gentle level curve from TOTAL xp: level 1 at 0 xp, then ~sqrt growth.
export function levelForXp(xp: number): number {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1);
}
