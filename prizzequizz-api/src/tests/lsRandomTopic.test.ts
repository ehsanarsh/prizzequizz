/* LAST SURVIVOR — the «تصادفی» topic.
 *
 * It is the one topic that is playable out of the box, and it is not a category:
 * its questions come from the WHOLE approved bank. That matters twice over — a
 * single category rarely holds enough questions for twelve rounds across four
 * difficulty tiers, and filtering the bank by the name «تصادفی» would match
 * nothing at all, so the room would stall on an empty pool.
 *
 * Run: npx tsx src/tests/lsRandomTopic.test.ts
 */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import {
  getConfig, updateConfig, setTopicEnabled, removeTopic, setTopicHidden,
  isTopicPlayable, isTopicHidden, isRandomTopic, RANDOM_TOPIC
} from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, listActiveRooms } from '../services/lastSurvivorService.js';
import { advanceRoom } from '../services/lastSurvivorWorker.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let n = 0;
async function player(): Promise<string> {
  const id = 'rt' + (++n) + '-' + Math.random().toString(36).slice(2, 8);
  await repositories.users.save({
    id, username: 'r' + n, displayName: 'r' + n, phone: '09' + String(200000000 + n),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(id, 'green', 1);
  return id;
}

async function run(): Promise<void> {
  /* Questions spread across several categories and all four tiers — the shape
     the random topic exists to draw from. No question has the category
     «تصادفی», deliberately. */
  const cats = ['اطلاعات عمومی', 'فوتبال', 'سینما و سریال', 'تاریخ ایران'];
  const tiers = ['easy', 'medium', 'hard', 'veryhard'];
  let qid = 0;
  for (const c of cats) {
    for (const d of tiers) {
      for (let i = 0; i < 3; i++) {
        await repositories.questions.save({
          id: 'rq' + (qid++), category: c, difficulty: d, text: `${c}/${d}/${i}`,
          options: ['الف', 'ب', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
        } as any);
      }
    }
  }

  await updateConfig({
    room: { capacity: 2, minUsers: 2, waitSeconds: 0, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 12, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [RANDOM_TOPIC]: { enabled: true } }
  });

  await check('«تصادفی» is playable out of the box', async () => {
    assert.equal(isRandomTopic(RANDOM_TOPIC), true);
    assert.equal(isTopicPlayable(await getConfig(), RANDOM_TOPIC), true);
  });

  await check('a real category stays coming-soon until it is turned on', async () => {
    const cfg = await getConfig();
    assert.equal(isTopicPlayable(cfg, 'فوتبال'), false, 'not enabled → coming soon');
    await setTopicEnabled('فوتبال', true);
    assert.equal(isTopicPlayable(await getConfig(), 'فوتبال'), true);
    await setTopicEnabled('فوتبال', false);
    assert.equal(isTopicPlayable(await getConfig(), 'فوتبال'), false, 'and off again');
  });

  await check('a match on «تصادفی» really gets questions, from every category', async () => {
    for (const r of await listActiveRooms()) { r.status = 'finished'; await saveRoom(r); }
    const a = await player(), b = await player();
    const j = await joinTopic({ id: a, username: 'a' }, RANDOM_TOPIC, 'green');
    await joinTopic({ id: b, username: 'b' }, RANDOM_TOPIC, 'green');

    await advanceRoom((await getRoom(j.room.id))!);       // capacity 2 → starts
    const room = (await getRoom(j.room.id))!;
    assert.equal(room.status, 'running', 'the match should start');
    assert.ok(room.questionId, 'and it must have a question — an empty pool would stall here');

    /* The question it served belongs to a real category, never to «تصادفی». */
    const q = await repositories.questions.findById(room.questionId!);
    assert.ok(q, 'the served question exists');
    assert.ok(cats.includes(q!.category), 'drawn from the real bank, got: ' + q!.category);
    assert.notEqual(q!.category, RANDOM_TOPIC);
  });

  await check('repeated draws span the whole bank, not one category', async () => {
    /* The property that matters: the pool is the union of every category. One
       match only shows one question — players who never answer are eliminated
       in round one — so this opens several and looks at what each was served. */
    const seenCats = new Set<string>();
    for (let i = 0; i < 12; i++) {
      for (const r of await listActiveRooms()) { r.status = 'finished'; await saveRoom(r); }
      const a = await player(), b = await player();
      const j = await joinTopic({ id: a, username: 'a' }, RANDOM_TOPIC, 'green');
      await joinTopic({ id: b, username: 'b' }, RANDOM_TOPIC, 'green');
      await advanceRoom((await getRoom(j.room.id))!);
      const room = (await getRoom(j.room.id))!;
      assert.ok(room.questionId, 'every room must be served a question');
      const q = await repositories.questions.findById(room.questionId!);
      seenCats.add(q!.category);
    }
    assert.ok(seenCats.size > 1,
      'a whole-bank draw should reach more than one category, saw: ' + [...seenCats].join(', '));
    for (const c of seenCats) assert.ok(cats.includes(c), 'unexpected category ' + c);
  });

  await check('«تصادفی» cannot be deleted, only switched off', async () => {
    await assert.rejects(() => removeTopic(RANDOM_TOPIC));
    assert.ok((await getConfig()).topics[RANDOM_TOPIC], 'still there');
    /* Switching it off is allowed — that is the intended way to retire it. */
    await setTopicEnabled(RANDOM_TOPIC, false);
    assert.equal(isTopicPlayable(await getConfig(), RANDOM_TOPIC), false);
    await setTopicEnabled(RANDOM_TOPIC, true);
  });

  await check('deleting a category-backed topic takes it off the list for good', async () => {
    /* This used to just forget the override, which meant the topic reappeared —
       gated — on the very next read, because the list is derived from the
       question bank. "Delete" that undeletes is not a delete, so a topic with a
       category behind it is now HIDDEN, and stays off the picker until it is
       explicitly restored. */
    await setTopicEnabled('سینما و سریال', true, 7);
    assert.equal((await getConfig()).topics['سینما و سریال']?.minUsers, 7);
    const { config, action } = await removeTopic('سینما و سریال');
    assert.equal(action, 'hidden', 'a category still holds its questions, so it can only be hidden');
    assert.equal(isTopicHidden(config, 'سینما و سریال'), true, 'and it stays off the list');
    assert.equal(isTopicPlayable(config, 'سینما و سریال'), false,
      'hidden beats enabled — a topic off the list must not stay joinable');
    // …and putting it back is one call, with its settings intact.
    const back = await setTopicHidden('سینما و سریال', false);
    assert.equal(isTopicPlayable(back, 'سینما و سریال'), true, 'restored exactly as it was');
    assert.equal(back.topics['سینما و سریال']?.minUsers, 7, 'including its own minUsers');
  });

  console.log(`[lsRandomTopic] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
