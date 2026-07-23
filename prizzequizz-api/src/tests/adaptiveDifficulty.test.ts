/* Adaptive-difficulty state-machine tests. Run: npx tsx src/tests/adaptiveDifficulty.test.ts
 * Proves: round 0 = easy; ladder rules (both-correct↑ / split= / both-wrong↓, clamped);
 * no repeats within a match; both players derive the identical question; topic-per-round;
 * thin-level widening without repeat; toss bank excluded. */
import { selectQuestionForRound, topicForRound, roundOutcome, TOPIC_SELECT_CATEGORY, type AdaptiveMatch } from '../services/adaptiveDifficultyService.js';

let passed = 0, failed = 0;
function ok(name: string, cond: boolean) { if (cond) { passed++; } else { failed++; console.log('  ✗ FAIL:', name); } }

// A rich bank: 8 per level per topic, plus a toss bank.
type Q = { id: string; category: string; difficulty: string; text: string; options: string[]; correctIndex: number };
function makeBank(): Q[] {
  const bank: Q[] = [];
  const topics = ['ورزش', 'سینما و سریال'];
  const levels = ['easy', 'medium', 'hard', 'veryhard'];
  for (const t of topics) for (const lv of levels) for (let i = 0; i < 8; i++) bank.push({ id: `${t}-${lv}-${i}`, category: t, difficulty: lv, text: `${t}/${lv}/${i}`, options: ['a', 'b', 'c', 'd'], correctIndex: 0 });
  for (let i = 0; i < 10; i++) bank.push({ id: `toss-${i}`, category: TOPIC_SELECT_CATEGORY, difficulty: 'easy', text: `toss ${i}`, options: ['x', 'y', 'z', 'w'], correctIndex: 1 });
  return bank;
}

function match(over: Partial<AdaptiveMatch> = {}): AdaptiveMatch {
  return { id: 'M1', players: [{ userId: 'A' }, { userId: 'B' }], duelTopics: { '1': 'ورزش', '2': 'سینما و سریال' }, duelTopic: 'ورزش', duelAnswers: {}, ...over };
}
// Set both players' correctness for a round.
function ans(m: AdaptiveMatch, round: number, a: boolean, b: boolean) { m.duelAnswers![`A:${round}`] = { selectedIndex: 0, correct: a }; m.duelAnswers![`B:${round}`] = { selectedIndex: 0, correct: b }; }

const bank = makeBank();

// 1) Round 0 is always easy.
{
  const m = match();
  const r0 = selectQuestionForRound(m, bank, 0);
  ok('round 0 is easy', r0.level === 'easy' && !!r0.q && r0.q.difficulty === 'easy');
}

// 2) Ladder: both correct climbs easy→medium→hard→veryhard and clamps.
{
  const m = match();
  const seq: string[] = [];
  for (let r = 0; r < 6; r++) { seq.push(selectQuestionForRound(m, bank, r).level); ans(m, r, true, true); }
  ok('both-correct climbs and clamps at veryhard', JSON.stringify(seq) === JSON.stringify(['easy', 'medium', 'hard', 'veryhard', 'veryhard', 'veryhard']));
}

// 3) Ladder: both wrong drops and clamps at easy.
{
  const m = match();
  // climb to veryhard first
  for (let r = 0; r < 3; r++) ans(m, r, true, true); // after r0,r1,r2 both-correct → idx at round3 = 3 (veryhard)
  ok('reached veryhard by round 3', selectQuestionForRound(m, bank, 3).level === 'veryhard');
  ans(m, 3, false, false); ans(m, 4, false, false); ans(m, 5, false, false); ans(m, 6, false, false);
  const seq = [4, 5, 6, 7].map((r) => selectQuestionForRound(m, bank, r).level);
  ok('both-wrong drops and clamps at easy', JSON.stringify(seq) === JSON.stringify(['hard', 'medium', 'easy', 'easy']));
}

// 4) Split keeps the same level.
{
  const m = match();
  ans(m, 0, true, true);   // → medium at r1
  ok('r1 is medium after both-correct', selectQuestionForRound(m, bank, 1).level === 'medium');
  ans(m, 1, true, false);  // split → stay medium
  ok('split keeps medium at r2', selectQuestionForRound(m, bank, 2).level === 'medium');
  ans(m, 2, false, true);  // split → stay medium
  ok('split keeps medium at r3', selectQuestionForRound(m, bank, 3).level === 'medium');
}

// 5) No repeats across a whole match (mixed outcomes), and both "players" identical.
{
  const m = match();
  const seen = new Set<string>();
  let noRepeat = true, identical = true;
  const pattern = [[true, true], [true, false], [true, true], [false, false], [true, true], [false, true], [true, true], [true, true], [false, false]];
  for (let r = 0; r < 10; r++) {
    const qA = selectQuestionForRound(m, bank, r).q; // player A's fetch
    const qB = selectQuestionForRound(m, bank, r).q; // player B's fetch (same pure fn, same state)
    if (!qA || !qB || qA.id !== qB.id) identical = false;
    if (qA) { if (seen.has(qA.id)) noRepeat = false; seen.add(qA.id); }
    const p = pattern[r] ?? [true, false];
    ans(m, r, p[0]!, p[1]!);
  }
  ok('no repeated question in a match', noRepeat);
  ok('both players get the identical question each round', identical);
}

// 6) Topic per round: rounds 0-4 half1, 5-9 half2.
{
  const m = match();
  ok('topicForRound half1', topicForRound(m, 0) === 'ورزش' && topicForRound(m, 4) === 'ورزش');
  ok('topicForRound half2', topicForRound(m, 5) === 'سینما و سریال' && topicForRound(m, 9) === 'سینما و سریال');
  // Questions in half 2 come from half-2 topic
  for (let r = 0; r < 6; r++) ans(m, r, false, true); // split each round → stay easy; harmless
  const q5 = selectQuestionForRound(m, bank, 5).q;
  ok('round 5 question is from half-2 topic', !!q5 && q5.category === 'سینما و سریال');
}

// 7) Toss bank is never served as a normal game question.
{
  const m = match();
  let leaked = false;
  for (let r = 0; r < 10; r++) { const q = selectQuestionForRound(m, bank, r).q; if (q && q.category === TOPIC_SELECT_CATEGORY) leaked = true; ans(m, r, true, true); }
  ok('توس bank never leaks into game questions', !leaked);
}

// 8) Thin level: only 2 hard questions in-topic; climbing past them must widen
//    (nearest level) WITHOUT repeating.
{
  const thin: Q[] = [];
  for (let i = 0; i < 8; i++) thin.push({ id: `e${i}`, category: 'ورزش', difficulty: 'easy', text: 'e', options: ['a','b','c','d'], correctIndex: 0 });
  for (let i = 0; i < 8; i++) thin.push({ id: `m${i}`, category: 'ورزش', difficulty: 'medium', text: 'm', options: ['a','b','c','d'], correctIndex: 0 });
  for (let i = 0; i < 2; i++) thin.push({ id: `h${i}`, category: 'ورزش', difficulty: 'hard', text: 'h', options: ['a','b','c','d'], correctIndex: 0 });
  const m = match({ duelTopics: { '1': 'ورزش', '2': 'ورزش' }, duelTopic: 'ورزش' });
  const seen = new Set<string>(); let noRepeat = true, allFilled = true;
  // Force climb to hard and stay: both-correct every round.
  for (let r = 0; r < 8; r++) { const q = selectQuestionForRound(m, thin, r).q; if (!q) allFilled = false; else { if (seen.has(q.id)) noRepeat = false; seen.add(q.id); } ans(m, r, true, true); }
  ok('thin level: every round still gets a question', allFilled);
  ok('thin level: no repeats even when a level runs out', noRepeat);
}

console.log(`\nadaptiveDifficulty: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
