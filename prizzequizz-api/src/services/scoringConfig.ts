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

/* ────────────────────────────────────────────────────────────────────────────
 * EVERY NUMBER THE PANEL SHOWS IS READ FROM HERE.
 *
 * The rule for this whole block: the fallback is the constant the game used
 * before the field was wired, so switching a previously-ignored field on
 * changes NOTHING until an operator actually edits it in the panel. A setting
 * that silently moves the balance the moment it is deployed is worse than a
 * setting that does nothing — at least the dead one was honest.
 *
 * The other rule: a number lives in exactly one place. Where the panel already
 * owns a value under another tab (mission rewards, the daily wheel, league
 * thresholds), it is NOT re-read here — two editable copies of one number is
 * how they drift apart.
 * ──────────────────────────────────────────────────────────────────────────── */

function cfg(): any { return (gameConfig as any) ?? {}; }
function num(v: unknown, dflt: number): number { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

/** Paid matches pay this many times the free numbers. */
export function paidMultiplier(): number {
  const n = Number(cfg().scoring?.paidMultiplier);
  return Number.isFinite(n) && n > 0 ? n : PZ_SCORING.paidMultiplier;
}

/* The XP of a correct answer at «medium». The per-difficulty table is expressed
 * as a ratio of it, so moving the one number an operator understands («XP هر
 * پاسخ درست») scales easy/hard/very-hard with it and keeps the spread between
 * difficulties intact. At the shipped 15 it reproduces 10 / 15 / 20 / 28. */
const PERQ_BASE_XP = 15;

/** XP + cup for one correct answer of the given difficulty. */
export function questionPoints(difficulty: string): Points {
  const pq = PZ_SCORING.perQuestion[difficulty] ?? PZ_SCORING.perQuestion.medium!;
  const base = num(cfg().xp?.perCorrect, PERQ_BASE_XP);
  if (base === PERQ_BASE_XP || base <= 0) return pq;
  return { xp: Math.round(pq.xp * base / PERQ_BASE_XP), cup: pq.cup };
}

/** The consolation for a wrong answer. Not scaled by «XP هر پاسخ درست» — that
 *  field is about right answers, and scaling it here would make an operator
 *  raising the reward also raise what a mistake pays. */
export function wrongAnswerPoints(): Points { return PZ_SCORING.perQuestion.wrong!; }

/** The bonus at exactly N correct in a row, or null if N is not a milestone.
 *  `xp.combo` is an EXTRA on top of the built-in ladder, so 0 = today. */
export function streakBonus(n: number): Points | null {
  const sb = PZ_SCORING.streak.find((x) => x.n === n);
  if (!sb) return null;
  return { xp: sb.xp + Math.max(0, num(cfg().xp?.combo, 0)), cup: sb.cup };
}

/** Extra XP for a correct answer in sudden death (the «golden» rounds past the
 *  base length, where the match is already tied). 0 = today. */
export function goldenBonusXp(): number { return Math.max(0, num(cfg().xp?.golden, 0)); }

/** Paid to a duel winner who presses «ادامه میدهم» instead of walking away.
 *  0/0 = today. */
export function continueBonus(): Points {
  return { xp: Math.max(0, num(cfg().xp?.continue, 0)), cup: Math.max(0, num(cfg().cup?.continue, 0)) };
}

/** Coins and tickets granted for each level gained. 0/0 = today. */
export function levelRewards(): { coins: number; tickets: number } {
  return {
    coins: Math.max(0, Math.round(num(cfg().level?.rewardCoinsPerLevel, 0))),
    tickets: Math.max(0, Math.round(num(cfg().level?.rewardTicketPerLevel, 0)))
  };
}

/** XP that buys the first level. The curve is a ratio of it, so 100 = today. */
export function levelXpBase(): number { const n = num(cfg().level?.xpPerLevelBase, 100); return n > 0 ? n : 100; }
/** 'sqrt' (each level costs more than the last) or 'linear' (a flat price). */
export function levelCurve(): 'sqrt' | 'linear' { return String(cfg().level?.curve ?? 'sqrt').trim() === 'linear' ? 'linear' : 'sqrt'; }

/** Does 🏆 go back to zero every week? Off means one running total forever —
 *  the league table then ranks lifetime cup rather than this week's. */
export function cupResetsWeekly(): boolean { return cfg().cup?.weeklyReset !== false; }

/** 🏆 a player must hold to enter a paid match. 0 = no gate, which is today. */
export function minCupToPlay(): number { return Math.max(0, Math.round(num(cfg().cup?.minEntry, 0))); }

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
/* The cup a user holds RIGHT NOW. weekly_score is only meaningful for the week
 * it was earned in, and it is rewritten lazily — the next time that player
 * scores. Someone who played last week and not this one still carries last
 * week's number in the column, so every read goes through here and sees 0 once
 * the week has rolled over. */
export function effectiveWeeklyScore(user: { weeklyScore?: number; weeklyWeek?: string } | null | undefined): number {
  if (!user) return 0;
  // No stored week at all → memory driver / legacy row; trust the value.
  if (user.weeklyWeek === undefined || user.weeklyWeek === null || user.weeklyWeek === '') return Number(user.weeklyScore ?? 0);
  // Weekly reset switched off in the panel → the column is a running total and
  // the week it was stamped with stops meaning anything.
  if (!cupResetsWeekly()) return Number(user.weeklyScore ?? 0);
  return user.weeklyWeek === isoWeekId() ? Number(user.weeklyScore ?? 0) : 0;
}

export function levelForXp(xp: number): number {
  const x = Math.max(0, Number(xp) || 0);
  const b = levelXpBase();
  return levelCurve() === 'linear'
    ? Math.max(1, Math.floor(x / b) + 1)
    : Math.max(1, Math.floor(Math.sqrt(x / b)) + 1);
}

/* THE LEVEL A PLAYER HAS — the one number every screen and every gate must use.
 *
 * There were two answers to this question. Everything a player READS — the
 * header, the profile, the menu, their friends' cards — comes from the stored
 * `users.level` column. Everything that GATES — the character shelf, the
 * purchase check — recomputed it from XP. They agree only for as long as the
 * curve stays put: `levelXpBase` and `levelCurve` are panel settings, and the
 * moment either is re-tuned the recomputed answer moves while the stored column
 * stays where the last XP award left it. That is how a player at level ۱۵ was
 * told a character opens at level ۵.
 *
 * A level is a rank that has been reached, so it is a high-water mark: the
 * stored column and the curve, whichever is higher. That can never take a
 * character back off a player who already had it, and it can never show one
 * number and enforce another. */
export function playerLevel(user: { level?: number | null; xp?: number | null } | null | undefined): number {
  if (!user) return 1;
  /* No floor of its own: levelForXp already refuses to answer below 1, and it is
     always one of the two candidates — so a zeroed or negative column is lifted
     by the curve rather than by a second guard saying the same thing. */
  return Math.max(Math.floor(Number(user.level ?? 0) || 0), levelForXp(Number(user.xp ?? 0) || 0));
}

/* The SAME formula as levelForXp, as a SQL expression over a column.
 *
 * matchEngine adds XP and recomputes the level inside one UPDATE, so the
 * database has to know the curve too. It used to carry its own hardcoded
 * `floor(sqrt(xp/100.0))+1`, which meant changing the base in the panel moved
 * the TypeScript answer and left the stored column behind. There is one
 * formula; this is that formula, written for Postgres. */
export function levelSqlExpr(xpExpr: string): string {
  const b = levelXpBase();
  return levelCurve() === 'linear'
    ? `GREATEST(1, floor((${xpExpr}) / ${b}.0)::int + 1)`
    : `GREATEST(1, floor(sqrt((${xpExpr}) / ${b}.0))::int + 1)`;
}
