/* ADAPTIVE DIFFICULTY — server-authoritative, synced across both players.
 *
 * The difficulty of every duel round is a PURE function of the match's recorded
 * answers, so BOTH players independently derive the identical level AND the
 * identical question — no shared mutable state, no drift.
 *
 * Rules (exactly as specified):
 *   • round 0 is always the easiest level;
 *   • after each round, from BOTH players' results for that round:
 *       both correct → one level harder,
 *       both wrong   → one level easier,
 *       split        → same level;
 *     clamped (never below «easy», never above «بسیار سخت»).
 *
 * Question selection is deterministic (seeded by matchId+round) from the current
 * level's bank for that round's topic, never repeating a question already used
 * earlier in the match. If a level is thin, selection widens to the nearest
 * levels (still no repeats). The «انتخاب موضوع» bank is a separate toss-only
 * pool and is NEVER served as a normal game question.
 */

export const DIFF_LEVELS = ['easy', 'medium', 'hard', 'veryhard'] as const;
export type DiffLevel = typeof DIFF_LEVELS[number];
export const TOPIC_SELECT_CATEGORY = 'انتخاب موضوع';

export interface AdaptiveQuestion { id: string; category: string; difficulty: string; }
export interface AdaptiveMatch {
  id: string;
  players?: { userId: string }[];
  duelTopic?: string;
  duelTopics?: Record<string, string>;
  duelAnswers?: Record<string, { selectedIndex: number; correct: boolean }>;
}

// Deterministic FNV-1a string hash → both players derive the same seed.
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Which topic a round belongs to: half 1 = rounds 0..4 (winner's topic), half 2
// = rounds 5..9 (loser's topic), sudden-death (10+) alternates halves — matching
// the client's golden-question topic alternation.
export function topicForRound(match: AdaptiveMatch, round: number): string {
  const t1 = (match.duelTopics && match.duelTopics['1']) || match.duelTopic || '';
  const t2 = (match.duelTopics && match.duelTopics['2']) || t1 || '';
  if (round < 5) return t1;
  if (round < 10) return t2;
  return ((round - 10) % 2 === 0) ? t1 : t2;
}

// Both players' results for a completed round, read from the server's answer log.
export function roundOutcome(match: AdaptiveMatch, round: number): { both: boolean; bothCorrect: boolean; bothWrong: boolean } {
  const ans = match.duelAnswers || {};
  const results: boolean[] = [];
  for (const p of (match.players || [])) {
    const a = ans[`${p.userId}:${round}`];
    if (a) results.push(!!a.correct);
  }
  const both = (match.players || []).length >= 2 && results.length >= 2;
  return { both, bothCorrect: both && results.every((c) => c === true), bothWrong: both && results.every((c) => c === false) };
}

// Deterministic pick from (topic, level) excluding already-used ids. When the
// exact level has nothing left, it widens to the NEAREST available level ONE
// STEP AT A TIME (so a veryhard target with no veryhard questions falls to hard,
// NOT to easy), preferring the same topic before crossing topics. Always avoids
// repeats, so a thin level never causes a repeat or an empty question.
export function pickDeterministic<T extends AdaptiveQuestion>(all: T[], topic: string, level: string, used: Set<string>, seed: number): T | null {
  const norm = (topic || '').trim();
  const topicOk = (q: T) => !norm || norm === '__popular__' || q.category === norm;
  const notUsed = (q: T) => !used.has(q.id);
  const notSelectCat = (q: T) => q.category !== TOPIC_SELECT_CATEGORY;
  const stable = (list: T[]) => list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Levels ordered by closeness to the target (target first, then ±1, ±2 …).
  const i0 = Math.max(0, DIFF_LEVELS.indexOf(level as DiffLevel));
  const nearest: string[] = [DIFF_LEVELS[i0]!];
  for (let d = 1; d < DIFF_LEVELS.length; d++) { if (i0 - d >= 0) nearest.push(DIFF_LEVELS[i0 - d]!); if (i0 + d < DIFF_LEVELS.length) nearest.push(DIFF_LEVELS[i0 + d]!); }
  const pickAt = (inTopic: boolean, lvl: string): T | null => {
    const cands = stable(all.filter((q) => notSelectCat(q) && notUsed(q) && q.difficulty === lvl && (!inTopic || topicOk(q))));
    return cands.length ? cands[seed % cands.length]! : null;
  };
  // 1) same topic, nearest level (closest first, one level at a time)
  for (const lvl of nearest) { const q = pickAt(true, lvl); if (q) return q; }
  // 2) any topic, nearest level (closest first) — last resort, still no repeats
  for (const lvl of nearest) { const q = pickAt(false, lvl); if (q) return q; }
  return null;
}

// Which difficulty LADDER a round belongs to. There is one ladder PER HALF /
// topic so each half starts fresh at «easy» and sudden-death (golden) questions
// continue the ladder of whichever half's topic they use:
//   half 1 (topic A): rounds 0..4  and golden 10,12,14…
//   half 2 (topic B): rounds 5..9  and golden 11,13,15…
export function ladderForRound(round: number): 'A' | 'B' {
  if (round < 5) return 'A';
  if (round < 10) return 'B';
  return ((round - 10) % 2 === 0) ? 'A' : 'B';
}

// Walks rounds 0..round, tracking difficulty ladders and a single match-wide
// used-set (no repeats anywhere), then returns the question chosen for `round`
// and its actual difficulty. Deterministic ⇒ identical for both players.
//   • Half 1 (rounds 0-4): ladder A, starts «easy».
//   • Half 2 (rounds 5-9): ladder B, starts «easy» — EXACTLY like half 1.
//   • Sudden death / golden (10+): ONE CONTINUOUS ladder that starts from the
//     level the last regular round (9) ended on and keeps adapting from the
//     PREVIOUS question — both answered the previous correctly ⇒ one step harder,
//     and so on. The golden TOPIC still alternates between the two halves.
export function selectQuestionForRound<T extends AdaptiveQuestion>(match: AdaptiveMatch, all: T[], round: number): { q: T | null; level: string } {
  const used = new Set<string>();
  let idxA = 0, idxB = 0;          // per-half ladders, each starts easy
  let idxG: number | null = null;  // golden ladder, seeded from round 9's end
  let chosen: T | null = null;
  let chosenLevel: string = DIFF_LEVELS[0];
  for (let r = 0; r <= round; r++) {
    let idx: number;
    if (r < 5) idx = idxA;
    else if (r < 10) idx = idxB;
    else { if (idxG === null) idxG = idxB; idx = idxG; }   // golden continues from the last question
    const level = DIFF_LEVELS[idx]!;
    const topic = topicForRound(match, r);
    const seed = hashString(`${match.id}|${r}|${topic}|${level}`);
    const q = pickDeterministic(all, topic, level, used, seed);
    if (q) used.add(q.id);
    if (r === round) { chosen = q; chosenLevel = q ? q.difficulty : level; }
    // Advance from THIS round's outcome (both-correct harder, both-wrong easier,
    // split unchanged; clamped easy..veryhard).
    const o = roundOutcome(match, r);
    let ni = idx;
    if (o.both) { if (o.bothCorrect) ni = Math.min(DIFF_LEVELS.length - 1, idx + 1); else if (o.bothWrong) ni = Math.max(0, idx - 1); }
    if (r < 5) idxA = ni; else if (r < 10) idxB = ni; else idxG = ni;
  }
  return { q: chosen, level: chosenLevel };
}
