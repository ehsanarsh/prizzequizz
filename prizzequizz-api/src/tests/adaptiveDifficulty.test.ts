/* Adaptive-difficulty state-machine tests. Run: npx tsx src/tests/adaptiveDifficulty.test.ts
 * Proves: round 0 = easy; ladder (both-correct↑ / split= / both-wrong↓, clamped);
 * widening prefers the NEAREST level (veryhard→hard, never drops to easy); half 2
 * restarts at easy; golden rounds resume each half's ladder; no repeats within a
 * match; both players derive the identical question; toss bank excluded. */
import { selectQuestionForRound, topicForRound, TOPIC_SELECT_CATEGORY, type AdaptiveMatch } from '../services/adaptiveDifficultyService.js';

let passed = 0, failed = 0;
function ok(name: string, cond: boolean) { if (cond) { passed++; } else { failed++; console.log('  ✗ FAIL:', name); } }

type Q = { id: string; category: string; difficulty: string; text: string; options: string[]; correctIndex: number };
function makeBank(): Q[] {
  const bank: Q[] = [];
  const topics = ['ورزش', 'سینما و سریال'];
  const levels = ['easy', 'medium', 'hard', 'veryhard'];
  for (const t of topics) for (const lv of levels) for (let i = 0; i < 8; i++) bank.push({ id: `${t}-${lv}-${i}`, category: t, difficulty: lv, text: `${t}/${lv}/${i}`, options: ['a', 'b', 'c', 'd'], correctIndex: 0 });
  for (let i = 0; i < 10; i++) bank.push({ id: `toss-${i}`, category: TOPIC_SELECT_CATEGORY, difficulty: 'easy', text: `toss ${i}`, options: ['x', 'y', 'z', 'w'], correctIndex: 1 });
  return bank;
}
// A bank with NO veryhard questions (the real deployment right now).
function bankNoVeryhard(topic = 'فوتبال'): Q[] {
  const bank: Q[] = [];
  for (const lv of ['easy', 'medium', 'hard']) for (let i = 0; i < 8; i++) bank.push({ id: `${topic}-${lv}-${i}`, category: topic, difficulty: lv, text: 't', options: ['a', 'b', 'c', 'd'], correctIndex: 0 });
  return bank;
}
function match(over: Partial<AdaptiveMatch> = {}): AdaptiveMatch {
  return { id: 'M1', players: [{ userId: 'A' }, { userId: 'B' }], duelTopics: { '1': 'ورزش', '2': 'سینما و سریال' }, duelTopic: 'ورزش', duelAnswers: {}, ...over };
}
function ans(m: AdaptiveMatch, round: number, a: boolean, b: boolean) { m.duelAnswers![`A:${round}`] = { selectedIndex: 0, correct: a }; m.duelAnswers![`B:${round}`] = { selectedIndex: 0, correct: b }; }

const bank = makeBank();

// 1) Round 0 is always easy.
{
  const m = match();
  const r0 = selectQuestionForRound(m, bank, 0);
  ok('round 0 is easy', r0.level === 'easy' && !!r0.q && r0.q.difficulty === 'easy');
}

// 2) Half 1 climb: both-correct easy→medium→hard→veryhard, clamps at veryhard.
{
  const m = match();
  const seq: string[] = [];
  for (let r = 0; r < 5; r++) { seq.push(selectQuestionForRound(m, bank, r).level); ans(m, r, true, true); }
  ok('half-1 climb + clamp at veryhard', JSON.stringify(seq) === JSON.stringify(['easy', 'medium', 'hard', 'veryhard', 'veryhard']));
}

// 3) Half 2 RESTARTS at easy and climbs independently (the requested behavior).
{
  const m = match();
  for (let r = 0; r < 5; r++) ans(m, r, true, true);   // half 1 climbs to veryhard
  const seq: string[] = [];
  for (let r = 5; r < 10; r++) { seq.push(selectQuestionForRound(m, bank, r).level); ans(m, r, true, true); }
  ok('half 2 restarts at easy then climbs', JSON.stringify(seq) === JSON.stringify(['easy', 'medium', 'hard', 'veryhard', 'veryhard']));
}

// 4) Both-wrong drops, clamps at easy (within a half).
{
  const m = match();
  for (let r = 0; r < 3; r++) ans(m, r, true, true);   // r3 level = veryhard
  ok('reached veryhard by round 3', selectQuestionForRound(m, bank, 3).level === 'veryhard');
  ans(m, 3, false, false); ans(m, 4, false, false);
  const seq = [4].map((r) => selectQuestionForRound(m, bank, r).level);   // r4: veryhard→hard
  ok('both-wrong drops one step', seq[0] === 'hard');
}

// 5) Split keeps the same level.
{
  const m = match();
  ans(m, 0, true, true);   // → medium at r1
  ok('r1 medium after both-correct', selectQuestionForRound(m, bank, 1).level === 'medium');
  ans(m, 1, true, false);  // split → stay medium
  ok('split keeps medium at r2', selectQuestionForRound(m, bank, 2).level === 'medium');
}

// 6) THE BUG FIX: with no veryhard questions, climbing past hard STAYS at hard
//    (widening picks the nearest available level) and NEVER drops back to easy.
{
  const nb = bankNoVeryhard('فوتبال');
  const m = match({ duelTopics: { '1': 'فوتبال', '2': 'فوتبال' }, duelTopic: 'فوتبال' });
  const seq: string[] = [];
  for (let r = 0; r < 5; r++) { seq.push(selectQuestionForRound(m, nb, r).level); ans(m, r, true, true); }
  // easy, medium, hard, then ladder=veryhard but none exist → served as hard, hard
  ok('no-veryhard bank stays at hard, never drops to easy', JSON.stringify(seq) === JSON.stringify(['easy', 'medium', 'hard', 'hard', 'hard']));
}

// 7) Golden continues from the LAST question: both-correct on the previous round
//    → one step harder, and keeps adapting. Topic still alternates halves.
{
  const m = match();
  for (let r = 0; r < 5; r++) ans(m, r, true, false);   // half 1 splits (irrelevant to golden)
  ans(m, 5, true, true);                                  // r5 easy → medium
  ans(m, 6, true, false); ans(m, 7, true, false); ans(m, 8, true, false); // stay medium
  ok('round 9 sits at medium (half-2 ladder)', selectQuestionForRound(m, bank, 9).level === 'medium');
  ans(m, 9, true, true);                                  // both correct on the LAST round
  const g10 = selectQuestionForRound(m, bank, 10);
  ok('golden r10 = one step harder than round 9 (hard), topic A', g10.level === 'hard' && g10.q!.category === 'ورزش');
  ans(m, 10, true, true);                                 // both correct again
  const g11 = selectQuestionForRound(m, bank, 11);
  ok('golden r11 climbs again (veryhard), topic B', g11.level === 'veryhard' && g11.q!.category === 'سینما و سریال');
  ans(m, 11, false, false);                               // both wrong
  const g12 = selectQuestionForRound(m, bank, 12);
  ok('golden r12 drops one step (hard), topic A', g12.level === 'hard' && g12.q!.category === 'ورزش');
  ok('golden topic alternates', topicForRound(m, 10) === 'ورزش' && topicForRound(m, 11) === 'سینما و سریال' && topicForRound(m, 12) === 'ورزش');
}

// 8) No repeats across a whole match (mixed outcomes), both players identical.
{
  const m = match();
  const seen = new Set<string>();
  let noRepeat = true, identical = true;
  const pattern = [[true, true], [true, false], [true, true], [false, false], [true, true], [false, true], [true, true], [true, true], [false, false], [true, true]];
  for (let r = 0; r < 12; r++) {
    const qA = selectQuestionForRound(m, bank, r).q;
    const qB = selectQuestionForRound(m, bank, r).q;
    if (!qA || !qB || qA.id !== qB.id) identical = false;
    if (qA) { if (seen.has(qA.id)) noRepeat = false; seen.add(qA.id); }
    const p = pattern[r] ?? [true, false];
    ans(m, r, p[0]!, p[1]!);
  }
  ok('no repeated question in a match', noRepeat);
  ok('both players get the identical question each round', identical);
}

// 9) Topic per round + toss bank never leaks.
{
  const m = match();
  ok('topics per half', topicForRound(m, 0) === 'ورزش' && topicForRound(m, 5) === 'سینما و سریال');
  let leaked = false;
  for (let r = 0; r < 10; r++) { const q = selectQuestionForRound(m, bank, r).q; if (q && q.category === TOPIC_SELECT_CATEGORY) leaked = true; ans(m, r, true, true); }
  ok('toss bank never leaks into game questions', !leaked);
}

console.log(`\nadaptiveDifficulty: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
