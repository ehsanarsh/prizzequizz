/* THE SAME QUESTIONS, GAME AFTER GAME.
 *
 *   «وقتی موضوعی رو انتخاب میکنی و سوالات رو جواب میدی، در بازی بعدی اگه باز هم
 *    همون موضوع رو انتخاب کنی سوالات تکراری میاد — با اینکه اون موضوع سوالات
 *    زیادی داره. سوالات تکراری باید به حداقل‌ترین برسه؛ نباید سوال تکراری پخش
 *    بشه، اگه چاره‌ای نبود تکراری باشه.»
 *
 * The reason a big topic still repeated is that neither mode drew from the big
 * topic. Both narrow to one difficulty tier first, so a bank of two hundred
 * with a dozen easy ones is a dozen-question bank for the opening rounds — and
 * out of a dozen, two games running collide about half the time. These tests
 * are built the same way: a topic with plenty in it, and a count of how much of
 * the second game the player had already seen in the first.
 *
 * Run: REPOSITORY_DRIVER=memory npx tsx src/tests/questionRepeats.test.ts
 */
import assert from 'node:assert';
import { repositories } from '../repositories/index.js';
import { pickQuestion } from '../services/lastSurvivorWorker.js';
import { selectQuestionForRound } from '../services/adaptiveDifficultyService.js';
import { seenElsewhere, markSeen, seenCounts, leastSeen, _resetSeen, prune, SEEN_MAX_PER_USER } from '../services/questionSeenService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); }
};

const TOPIC = 'اطلاعات عمومی';
/* Enough that an honest picker never has to repeat, and spread across the tiers
 * the way a real bank is — thinner at the top, which is where the ladder starts
 * and where the collisions were. */
const TIERS: Array<[string, number]> = [['easy', 14], ['medium', 14], ['hard', 10], ['veryhard', 8]];
let made = 0;
for (const [difficulty, n] of TIERS) {
  for (let i = 0; i < n; i++) {
    await repositories.questions.save({
      id: 'qr-' + difficulty + '-' + i, category: TOPIC, difficulty,
      text: 'سوال ' + difficulty + ' ' + i, options: ['یک', 'دو', 'سه', 'چهار'],
      correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
    made++;
  }
}

await updateConfig({
  room: { capacity: 8, minUsers: 2, waitSeconds: 30, manualStartEnabled: false, startPct: 70 },
  match: { totalRounds: 12, questionsPerRound: 1, minSurvivors: 1 },
  topics: { [TOPIC]: { enabled: true } }
});

/* ── 1. THE MEMORY ITSELF ─────────────────────────────────────────────── */
{
  console.log('what the record remembers:');
  _resetSeen();
  await markSeen(['u1', 'u2'], 'q-a', 'game-1');
  await markSeen(['u1'], 'q-b', 'game-1');

  const all = await seenElsewhere(['u1'], '');
  ok('it remembers what was served', all.has('q-a') && all.has('q-b'), [...all].join(','));

  /* The one property the duel depends on: a question served in THIS game is not
     part of what «has been seen before» while that game is still running. */
  const during = await seenElsewhere(['u1'], 'game-1');
  ok('but not while you are still in that game', during.size === 0, [...during].join(','));

  await markSeen(['u1'], 'q-c', 'game-2');
  const later = await seenElsewhere(['u1'], 'game-2');
  ok('and the earlier game counts again once you are out of it', later.has('q-a') && later.has('q-b') && !later.has('q-c'), [...later].join(','));

  /* Seen again in a later game, the FIRST game is the one that sticks —
     otherwise a re-served question would drop out of its own match's exclusion. */
  await markSeen(['u1'], 'q-a', 'game-2');
  const again = await seenElsewhere(['u1'], 'game-2');
  ok('a second sighting does not move it into the new game', again.has('q-a'), [...again].join(','));

  const counts = await seenCounts(['u1', 'u2'], '');
  ok('and it can say how many of a group have seen a question', counts.get('q-a') === 2 && counts.get('q-b') === 1, JSON.stringify([...counts]));

  const picked = leastSeen([{ id: 'q-a' }, { id: 'q-b' }, { id: 'q-fresh' }], counts);
  ok('the least-seen of a set is the unseen one', picked.length === 1 && picked[0]!.id === 'q-fresh', picked.map((p) => p.id).join(','));
  const allSeen = leastSeen([{ id: 'q-a' }, { id: 'q-b' }], counts);
  ok('and when everything has been seen it still offers the least-seen', allSeen.length === 1 && allSeen[0]!.id === 'q-b', allSeen.map((p) => p.id).join(','));
  /* «اگه چاره‌ای نبود تکراری باشه» — it must never hand back nothing. */
  const tied = leastSeen([{ id: 'q-a' }, { id: 'q-a2' }], new Map([['q-a', 3], ['q-a2', 3]]));
  ok('a tie leaves both in play rather than none', tied.length === 2, String(tied.length));
}

/* ── 2. LAST SURVIVOR: TWO MATCHES IN A ROW ───────────────────────────── */
{
  console.log('\nplaying Last Survivor twice on the same topic:');
  _resetSeen();
  const players = ['p1', 'p2'];
  const roundsPerMatch = 12;

  const play = async (roomId: string) => {
    const seen: string[] = [];
    for (let r = 1; r <= roundsPerMatch; r++) {
      const q = await pickQuestion(TOPIC, roomId, r, roundsPerMatch, players);
      assert.ok(q, 'the room must never run out of questions in round ' + r);
      seen.push(q!.id);
    }
    return seen;
  };

  const first = await play('room-1');
  ok('a full match got a question every round', first.length === roundsPerMatch, String(first.length));
  ok('and never asked the same one twice inside it', new Set(first).size === roundsPerMatch, String(new Set(first).size));

  const second = await play('room-2');
  const repeats = second.filter((id) => first.includes(id));
  /* The whole complaint. With 46 questions and 12 a match there is no reason to
     repeat at all, and the picker must find that. */
  ok('the next match repeats nothing from the last', repeats.length === 0, repeats.length + ' repeated: ' + repeats.join(','));
  ok('and is still a full match', second.length === roundsPerMatch && new Set(second).size === roundsPerMatch, String(second.length));

  /* «اگه چاره‌ای نبود تکراری باشه» — a third and fourth match run the bank dry,
     and the game must carry on rather than stall. */
  const third = await play('room-3');
  const fourth = await play('room-4');
  ok('a third match still fills', third.length === roundsPerMatch, String(third.length));
  ok('and a fourth, once the bank is exhausted, repeats rather than stalling',
    fourth.length === roundsPerMatch && fourth.every(Boolean), String(fourth.length));

  /* Across four matches of twelve, 48 draws from a bank of 46: at most a
     handful of repeats, and only once there was no alternative. */
  const drawn = [...first, ...second, ...third, ...fourth];
  const distinct = new Set(drawn).size;
  ok('almost the whole bank was used before anything came round again', distinct >= made - 4, distinct + ' of ' + made);
}

/* ── 3. LAST SURVIVOR: ONE PLAYER'S HISTORY IS NOT ANOTHER'S ──────────── */
{
  console.log('\na newcomer joining a room of veterans:');
  _resetSeen();
  const vets = ['v1', 'v2'];
  for (let r = 1; r <= 12; r++) await pickQuestion(TOPIC, 'vet-room', r, 12, vets);

  /* The newcomer has seen nothing. The room asks for what the ROOM has seen
     least, so the veterans' history still steers it — but a question is always
     produced, and the newcomer's first match must not be starved. */
  const fresh = await pickQuestion(TOPIC, 'mixed-room', 1, 12, [...vets, 'newbie']);
  ok('the room still gets a question', !!fresh, fresh?.id);
  const newbieSeen = await seenElsewhere(['newbie'], 'mixed-room');
  ok('and the newcomer starts with a clean slate', newbieSeen.size === 0, String(newbieSeen.size));
}

/* ── 4. THE DUEL ──────────────────────────────────────────────────────── */
{
  console.log('\nplaying a duel twice on the same topic:');
  _resetSeen();
  const all = await repositories.questions.listApproved();
  const mkMatch = (id: string) => ({
    id, duelTopic: TOPIC, duelTopics: { '1': TOPIC, '2': TOPIC },
    players: [{ userId: 'd1' }, { userId: 'd2' }],
    duelAnswers: {} as Record<string, { selectedIndex: number; correct: boolean }>
  }) as any;

  const playDuel = async (matchId: string) => {
    const m = mkMatch(matchId);
    const seen = await seenElsewhere(['d1', 'd2'], matchId);
    const out: string[] = [];
    for (let r = 0; r < 10; r++) {
      const { q } = selectQuestionForRound(m, all, r, seen);
      assert.ok(q, 'round ' + r + ' must have a question');
      out.push(q!.id);
      await markSeen(['d1', 'd2'], q!.id, matchId);
    }
    return out;
  };

  const a = await playDuel('duel-1');
  ok('ten rounds, ten questions', a.length === 10, String(a.length));
  ok('none repeated inside the match', new Set(a).size === 10, String(new Set(a).size));

  /* WITH NO ANSWERS RECORDED THE LADDER NEVER CLIMBS, so all ten rounds of both
     duels want «easy» — and the topic has fourteen easy questions. Ten went in
     the first duel, so four are left and six of the rematch MUST repeat. That
     is «اگه چاره‌ای نبود تکراری باشه», and the thing worth testing is that it
     takes every fresh one it has before it repeats anything at all. */
  const easyIds = all.filter((q) => q.difficulty === 'easy').map((q) => q.id);
  const b = await playDuel('duel-2');
  const stillFresh = easyIds.filter((id) => !a.includes(id));
  const usedFresh = stillFresh.filter((id) => b.includes(id));
  ok('the rematch uses every question that was still unseen', usedFresh.length === stillFresh.length,
    usedFresh.length + ' of ' + stillFresh.length);
  const dupes = b.filter((id) => a.includes(id));
  ok('and repeats only what it had no way to avoid', dupes.length === 10 - stillFresh.length,
    dupes.length + ' repeats, ' + stillFresh.length + ' were available');
  ok('and never repeats inside itself either', new Set(b).size === 10, String(new Set(b).size));

  /* BOTH PLAYERS MUST GET THE IDENTICAL QUESTION. The exclusion is built from
     the pair together and frozen for the match, so re-deriving a round — which
     is what the second player's request does — gives the same answer. */
  const m2 = mkMatch('duel-2');
  const seenNow = await seenElsewhere(['d1', 'd2'], 'duel-2');
  const replay = [];
  for (let r = 0; r < 10; r++) replay.push(selectQuestionForRound(m2, all, r, seenNow).q!.id);
  ok('the other player re-deriving the match gets exactly the same questions',
    replay.join(',') === b.join(','), replay.slice(0, 3).join(',') + ' vs ' + b.slice(0, 3).join(','));

  /* And a third and fourth duel, past the point where the topic can still be
     fresh, must keep producing questions. */
  const c = await playDuel('duel-3');
  const d = await playDuel('duel-4');
  ok('a fourth duel still gets a full set', c.length === 10 && d.length === 10, c.length + '/' + d.length);
}

/* ── 4b. A TIER WITH ROOM IN IT REPEATS NOTHING ───────────────────────── */
/* The section above is bounded by a thin easy tier. Given a bank that can
 * actually cover two matches, the answer must be zero repeats — that is the
 * complaint as it was reported: «با اینکه اون موضوع سوالات زیادی داره». */
{
  console.log('\ntwo duels on a topic with enough easy questions:');
  _resetSeen();
  const BIG = 'موضوع پرسوال';
  for (let i = 0; i < 40; i++) {
    await repositories.questions.save({
      id: 'big-easy-' + i, category: BIG, difficulty: 'easy',
      text: 'سوال بزرگ ' + i, options: ['یک', 'دو', 'سه', 'چهار'],
      correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  const all = await repositories.questions.listApproved();
  const playBig = async (matchId: string) => {
    const m = { id: matchId, duelTopic: BIG, duelTopics: { '1': BIG, '2': BIG }, players: [{ userId: 'b1' }, { userId: 'b2' }], duelAnswers: {} } as any;
    const seen = await seenElsewhere(['b1', 'b2'], matchId);
    const out: string[] = [];
    for (let r = 0; r < 10; r++) {
      const { q } = selectQuestionForRound(m, all, r, seen);
      out.push(q!.id);
      await markSeen(['b1', 'b2'], q!.id, matchId);
    }
    return out;
  };
  const one = await playBig('big-1');
  const two = await playBig('big-2');
  const shared = two.filter((id) => one.includes(id));
  ok('the rematch repeats nothing at all', shared.length === 0, shared.join(','));
  ok('both matches were full and distinct', new Set([...one, ...two]).size === 20, String(new Set([...one, ...two]).size));
  /* Four matches, forty rounds, forty questions — every one of them different. */
  const three = await playBig('big-3');
  const four = await playBig('big-4');
  ok('and four matches use the whole bank without one repeat',
    new Set([...one, ...two, ...three, ...four]).size === 40, String(new Set([...one, ...two, ...three, ...four]).size));
}

/* ── 5. THE LADDER IS NOT BENT TO AVOID A REPEAT ──────────────────────── */
/* «به منطق بازی دست نزن.» Repetition is a nuisance; a hard question in round
 * one is a different game. The memory may only choose among questions the
 * difficulty rules already allow. */
{
  console.log('\nwhat the memory is not allowed to do:');
  _resetSeen();
  const all = await repositories.questions.listApproved();
  const m = { id: 'ladder-1', duelTopic: TOPIC, duelTopics: { '1': TOPIC, '2': TOPIC }, players: [{ userId: 'L1' }, { userId: 'L2' }], duelAnswers: {} } as any;

  const plain = selectQuestionForRound(m, all, 0);
  ok('round one is easy to begin with', plain.q!.difficulty === 'easy', String(plain.q!.difficulty));

  /* Every easy question already seen — the picker must still open on easy. */
  const easies = all.filter((q) => q.difficulty === 'easy').map((q) => q.id);
  for (const id of easies) await markSeen(['L1'], id, 'somewhere-else');
  const starved = await seenElsewhere(['L1', 'L2'], 'ladder-1');
  const after = selectQuestionForRound(m, all, 0, starved);
  ok('and still easy when every easy one has been seen', after.q!.difficulty === 'easy', String(after.q!.difficulty));
  ok('rather than reaching for a harder unseen one', easies.includes(after.q!.id), after.q!.id);

  /* Same for the topic: a played-out topic repeats inside itself rather than
     wandering into another one mid-match. */
  ok('and stays in its own topic', after.q!.category === TOPIC, String(after.q!.category));
}

/* ── 5b. A PLAYER WHO IS OUT DOES NOT NARROW WHAT THE REST GET ────────── */
/* Only the people who will actually be shown the question have a say in it.
 * An eliminated player is not asked again, so their history must not steer the
 * survivors away from questions THEY have never seen. */
{
  console.log('\nan eliminated player’s history:');
  _resetSeen();
  const ghost = 'ghost-1';
  const survivor = 'alive-1';
  /* The ghost has seen every easy question; the survivor none of them. */
  const all = await repositories.questions.listApproved();
  const easy = all.filter((q) => q.difficulty === 'easy' && q.category === TOPIC).map((q) => q.id);
  for (const id of easy) await markSeen([ghost], id, 'ghost-history');

  /* The room asks with only the survivor seated — which is what beginRound
     passes: alive and waiting players, never the eliminated. */
  const q = await pickQuestion(TOPIC, 'ghost-room', 1, 12, [survivor]);
  ok('the survivor still gets a question', !!q, q?.id);
  ok('and it is one THEY have not seen', easy.includes(q!.id), q!.id + ' (easy: ' + easy.length + ')');
  const ghostCounts = await seenCounts([ghost], '');
  ok('the ghost’s history is real, so this was a live choice', ghostCounts.size === easy.length, String(ghostCounts.size));
}

/* ── 5b-ii. THROUGH A REAL ROOM, NOT JUST THE PICKER ──────────────────── */
/* The section above hands the picker a list of seated players directly. Which
 * players a ROOM hands it is a separate decision, made where the round begins,
 * and it is the one that can silently go wrong: pass everybody and an
 * eliminated player's history keeps narrowing the bank for people still in the
 * game. So this drives a genuine room — join, start, knock one out, next round —
 * and watches which question comes out the other end. */
{
  console.log('\nan eliminated player in a running room:');
  _resetSeen();
  const { joinTopic, getRoom, saveRoom, listPlayers, savePlayer } = await import('../services/lastSurvivorService.js');
  const { advanceRoom } = await import('../services/lastSurvivorWorker.js');
  const { grantTickets } = await import('../services/ticketService.js');

  await updateConfig({
    room: { capacity: 3, minUsers: 2, waitSeconds: 0, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 12, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  });
  const cast = [
    { id: 'rr-ghost', color: 'green' },
    { id: 'rr-a', color: 'blue' },
    { id: 'rr-b', color: 'red' }
  ];
  let roomId = '';
  for (const u of cast) {
    await repositories.users.save({ id: u.id, username: u.id, displayName: u.id, wallet: 0, coins: 0, xp: 0, level: 1, createdAt: new Date().toISOString() } as any);
    await grantTickets(u.id, u.color, 1);
    const snap = await joinTopic({ id: u.id, username: u.id }, TOPIC, u.color);
    roomId = snap.room.id;
  }
  await advanceRoom((await getRoom(roomId))!, Date.now());
  let room = (await getRoom(roomId))!;
  ok('the room started', room.status === 'running', room.status);

  /* One player is out — and they are the only one who has ever seen HALF the
     easy bank. The survivors have seen none of it. */
  const all = await repositories.questions.listApproved();
  const easy = all.filter((q) => q.difficulty === 'easy' && q.category === TOPIC).map((q) => q.id);
  const ghostSaw = easy.slice(0, Math.floor(easy.length / 2));
  for (const id of ghostSaw) await markSeen(['rr-ghost'], id, 'ghost-past');
  for (const p of await listPlayers(roomId)) {
    if (p.userId === 'rr-ghost') { p.status = 'eliminated'; await savePlayer(p); }
  }

  /* Walk the room to the next round. Which question it opens on is pinned so
     the answer is the seating list and not the dice. */
  const realRandom = Math.random;
  Math.random = () => 0;
  let nextQ = '';
  try {
    for (let guard = 0; guard < 12 && room.round < 2; guard++) {
      room = (await getRoom(roomId))!;
      room.phaseEndsAt = 0; await saveRoom(room);
      await advanceRoom((await getRoom(roomId))!, Date.now());
      room = (await getRoom(roomId))!;
      if (room.status !== 'running') break;
    }
    nextQ = String(room.questionId || '');
  } finally { Math.random = realRandom; }

  ok('the room reached another round', room.round >= 2 && !!nextQ, 'round ' + room.round + ' q=' + nextQ);
  /* Pinned to the first of the least-seen, so with the ghost correctly left out
     every easy question is equally unseen and the first of the bank wins. If
     the ghost were still counted, the half they had seen would be pushed down
     and the pick would land in the OTHER half. */
  ok('the eliminated player’s history did not steer it', ghostSaw.includes(nextQ),
    nextQ + ' — ghost had seen ' + ghostSaw.length + ' of ' + easy.length);
}

/* ── 5c. THE FRESHNESS RULE STAYS INSIDE THE TOPIC ────────────────────── */
/* «topic-switch mid-match is the bug we must never cause» — the note was
 * already in the picker before any of this. Preferring an unseen question must
 * not become a way out of the chosen topic. */
{
  console.log('\nfreshness must not cross into another topic:');
  _resetSeen();
  const OTHER = 'موضوع دیگر';
  for (let i = 0; i < 30; i++) {
    await repositories.questions.save({
      id: 'other-easy-' + i, category: OTHER, difficulty: 'easy',
      text: 'سوال دیگر ' + i, options: ['یک', 'دو', 'سه', 'چهار'],
      correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  const all = await repositories.questions.listApproved();
  /* Every question of the CHOSEN topic already seen; a whole other topic sitting
     there untouched and unseen. The match must repeat inside its own topic. */
  for (const q of all.filter((x) => x.category === TOPIC)) await markSeen(['t1'], q.id, 'long-ago');
  const m = { id: 'topic-lock', duelTopic: TOPIC, duelTopics: { '1': TOPIC, '2': TOPIC }, players: [{ userId: 't1' }, { userId: 't2' }], duelAnswers: {} } as any;
  const seen = await seenElsewhere(['t1', 't2'], 'topic-lock');
  ok('the other topic really is unseen', all.some((q) => q.category === OTHER && !seen.has(q.id)), String(seen.size));
  for (let r = 0; r < 5; r++) {
    const { q } = selectQuestionForRound(m, all, r, seen);
    assert.ok(q, 'round ' + r + ' must still have a question');
    assert.strictEqual(q!.category, TOPIC, 'round ' + r + ' left the topic to find something unseen');
  }
  ok('every round stays in the chosen topic, repeats and all', true, TOPIC);
}

/* ── 5d. A ROOM MUST NOT LIE TO ITSELF ───────────────────────────────── */
/* When a match outlasts its own topic the used-set is cleared and the bank
 * comes round again. At that moment the room has to weigh what the player has
 * seen — INCLUDING what this very room showed them ten minutes ago. Leaving its
 * own asks out would have it believe those questions were fresh, which is not a
 * preference, it is a false statement about the player's history.
 *
 * Math.random is pinned so that «which of the equally-seen» is decided here and
 * not by luck; the point being tested is which questions end up tied. */
{
  console.log('\na room that outlasts its own topic:');
  _resetSeen();
  const TINY = 'موضوع کم‌سوال';
  for (let i = 0; i < 3; i++) {
    await repositories.questions.save({
      id: 'tiny-' + i, category: TINY, difficulty: 'easy',
      text: 'سوال کم ' + i, options: ['یک', 'دو', 'سه', 'چهار'],
      correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
  await updateConfig({ topics: { [TOPIC]: { enabled: true }, [TINY]: { enabled: true } } });

  /* One of the three was already seen somewhere else, so the three are NOT
     interchangeable at the start — that asymmetry is what makes the wrap
     readable. */
  await markSeen(['tiny-p'], 'tiny-0', 'an-older-room');

  const realRandom = Math.random;
  Math.random = () => 0;                       // always the first of the least-seen
  let asked: string[] = [];
  try {
    for (let r = 1; r <= 4; r++) {
      const q = await pickQuestion(TINY, 'tiny-room', r, 4, ['tiny-p']);
      assert.ok(q, 'round ' + r + ' must have a question even past exhaustion');
      asked.push(q!.id);
    }
  } finally { Math.random = realRandom; }

  ok('four rounds out of three questions still fills', asked.length === 4, asked.join(','));
  ok('the first three are all different', new Set(asked.slice(0, 3)).size === 3, asked.slice(0, 3).join(','));
  /* Round 1 skipped the one already seen elsewhere. */
  ok('and it opened on one the player had never seen', asked[0] !== 'tiny-0', asked[0]);
  /* THE WRAP. By now the player has seen all three exactly once, so all three
     are equally stale and the first of the bank is as good as any. If the room
     had left its own two asks out of the count it would rate them unseen and
     reach for one of those instead — believing it had something fresh to offer
     when it had already shown both. */
  ok('after the wrap it knows it has shown all three', asked[3] === 'tiny-0',
    asked.join(',') + ' — picked ' + asked[3]);
}

/* ── 6. THE RECORD DOES NOT GROW FOREVER ──────────────────────────────── */
{
  console.log('\nkeeping the record to a size:');
  _resetSeen();
  ok('the cap is a real number', SEEN_MAX_PER_USER > 100, String(SEEN_MAX_PER_USER));
  const gone = await prune('nobody');
  ok('pruning a player with no history is harmless', gone === 0, String(gone));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
