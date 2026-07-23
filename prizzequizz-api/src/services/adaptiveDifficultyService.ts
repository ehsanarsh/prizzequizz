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

// Deterministic pick from (topic, level) excluding already-used ids. Widens to
// the nearest levels, then any topic, then any level — always avoiding repeats —
// so a thin level never causes a repeat or an empty question.
export function pickDeterministic<T extends AdaptiveQuestion>(all: T[], topic: string, level: string, used: Set<string>, seed: number): T | null {
  const norm = (topic || '').trim();
  const topicOk = (q: T) => !norm || norm === '__popular__' || q.category === norm;
  const notUsed = (q: T) => !used.has(q.id);
  const notSelectCat = (q: T) => q.category !== TOPIC_SELECT_CATEGORY;
  const stable = (list: T[]) => list.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nearestLevels = (() => {
    const i = Math.max(0, DIFF_LEVELS.indexOf(level as DiffLevel));
    const order = [i];
    for (let d = 1; d < DIFF_LEVELS.length; d++) { if (i - d >= 0) order.push(i - d); if (i + d < DIFF_LEVELS.length) order.push(i + d); }
    return order.map((k) => DIFF_LEVELS[k] as string);
  })();
  const tiers: ((q: T) => boolean)[] = [
    (q) => notSelectCat(q) && topicOk(q) && notUsed(q) && q.difficulty === level,
    (q) => notSelectCat(q) && topicOk(q) && notUsed(q) && nearestLevels.includes(q.difficulty),
    (q) => notSelectCat(q) && topicOk(q) && notUsed(q),
    (q) => notSelectCat(q) && notUsed(q) && q.difficulty === level,
    (q) => notSelectCat(q) && notUsed(q)
  ];
  for (const pass of tiers) {
    const cands = stable(all.filter(pass));
    if (cands.length) return cands[seed % cands.length]!;
  }
  return null;
}

// Walks rounds 0..round advancing the level from each round's real outcome and
// accumulating used-ids, then returns the question chosen for `round` and its
// level. Deterministic ⇒ identical for both players.
export function selectQuestionForRound<T extends AdaptiveQuestion>(match: AdaptiveMatch, all: T[], round: number): { q: T | null; level: string } {
  const used = new Set<string>();
  let idx = 0;
  let chosen: T | null = null;
  let chosenLevel: string = DIFF_LEVELS[0];
  for (let r = 0; r <= round; r++) {
    const level = DIFF_LEVELS[idx]!;
    const topic = topicForRound(match, r);
    const seed = hashString(`${match.id}|${r}|${topic}|${level}`);
    const q = pickDeterministic(all, topic, level, used, seed);
    if (q) used.add(q.id);
    if (r === round) { chosen = q; chosenLevel = q ? q.difficulty : level; }
    const o = roundOutcome(match, r);
    if (o.both) { if (o.bothCorrect) idx = Math.min(DIFF_LEVELS.length - 1, idx + 1); else if (o.bothWrong) idx = Math.max(0, idx - 1); }
  }
  return { q: chosen, level: chosenLevel };
}
