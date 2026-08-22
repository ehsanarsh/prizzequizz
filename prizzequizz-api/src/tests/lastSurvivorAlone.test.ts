/* THE ROOM NOBODY ELSE CAME TO.
 *
 *   «وقتی کاربر تنها در روم میمونه و وقت تموم میشه مینویسه مسابقه تمام شد و
 *    همونجا میمونه… باید هر موقع وقت تموم شد و فقط یه کاربر داخل روم بود باید
 *    اونو بندازه بیرون و بهش بگه فعلا حریفی برای تو وجود نداره.»
 *
 * A passed deadline used to wind the countdown back up, so a lone player waited
 * through window after window with a spent ticket and nothing saying it would
 * never start. Here the clock runs out on them once and they are let out, with
 * the ticket back and the room closed behind them — while a room that merely
 * has not filled YET still gets its extra window, which is a different thing
 * and must not be caught by the same rule.
 *
 * Run: REPOSITORY_DRIVER=memory npx tsx src/tests/lastSurvivorAlone.test.ts
 */
import assert from 'node:assert';
import { repositories } from '../repositories/index.js';
import { grantTickets, getTickets } from '../services/ticketService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, listPlayers, snapshot } from '../services/lastSurvivorService.js';
import { advanceRoom } from '../services/lastSurvivorWorker.js';
import { gameConfig } from '../core/config.js';

(gameConfig as any).economy = (gameConfig as any).economy ?? {};
(gameConfig as any).economy.paid = { ...((gameConfig as any).economy.paid ?? {}), rakePercent: 0 };

const TOPIC = 'اطلاعات عمومی';
const SOLO_TOPIC = 'ورزشی';
let passed = 0; const ok = (n: string) => { console.log('✔', n); passed++; };
let seq = 0;

async function player(color: string) {
  const id = 'alone' + (++seq);
  await repositories.users.save({ id, username: id, displayName: id, wallet: 0, coins: 0, xp: 0, level: 1, createdAt: new Date().toISOString() } as any);
  await grantTickets(id, color, 1);
  return { id, username: id, color };
}

/* The waiting deadline is the only clock in play, so it is moved rather than
 * waited on — the same thing the passage of time would do. */
async function expireWait(roomId: string) {
  const r = (await getRoom(roomId))!;
  r.startsAt = Date.now() - 1000;
  await saveRoom(r);
  return r;
}

(async () => {
  await updateConfig({
    room: { capacity: 8, minUsers: 3, waitSeconds: 120, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 5, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  });

  // ── 1. ALONE, AND THE CLOCK RUNS OUT ──────────────────────────────────
  {
    const u = await player('green');
    const snap0 = await joinTopic({ id: u.id, username: u.username }, TOPIC, u.color);
    const roomId = snap0.room.id;
    assert.equal((await getTickets(u.id))[u.color] ?? 0, 0);          // paid to get in
    assert.equal((await getRoom(roomId))!.grossPool, 12500);

    /* Still inside the window: nobody is going anywhere. */
    await advanceRoom((await getRoom(roomId))!, Date.now());
    assert.equal((await listPlayers(roomId)).length, 1);
    assert.equal((await getRoom(roomId))!.status, 'waiting');
    ok('a lone player is left alone while the countdown is still running');
    /* AND IS NOT TOLD ANYTHING YET. A room that has not started is not a room
       that ended without opponents — a client reading this flag off a waiting
       room would walk its player straight back out of a lobby that is still
       perfectly good. */
    assert.equal((await snapshot(roomId, u.id)).room.noOpponents, false);
    ok('and is told nothing while the room is still open');

    await expireWait(roomId);
    await advanceRoom((await getRoom(roomId))!, Date.now());

    const room = (await getRoom(roomId))!;
    assert.equal((await listPlayers(roomId)).length, 0);
    ok('when it runs out they are taken out of the room');
    assert.equal(room.status, 'finished');
    assert.equal(room.phase, 'finished');
    ok('and the room closes behind them');
    /* «باید کامل برنامه رو ببندی تا بیاد بیرون» — nothing is left half-open for
       the next player to inherit. */
    assert.equal(room.grossPool, 0);
    assert.equal(room.startedAt, null);
    assert.equal(room.round, 0);
    ok('with the pot emptied and no match ever recorded');
    /* They paid for a match they never got. */
    assert.equal((await getTickets(u.id))[u.color] ?? 0, 1);
    ok('and the ticket back in their pocket');

    /* What the client, still polling, is told. */
    const snap = await snapshot(roomId, u.id);
    assert.equal(snap.room.status, 'finished');
    assert.equal(snap.room.noOpponents, true);
    ok('the snapshot says plainly that there was never an opponent');
    assert.equal(snap.me, undefined);
    ok('and no longer counts them as being in it');
  }

  // ── 2. A ROOM THAT SIMPLY HAS NOT FILLED YET ──────────────────────────
  /* Two players below a floor of three is a room waiting for a third, not a
   * person waiting alone. The rule above must not reach it. */
  {
    const a = await player('green');
    const b = await player('blue');
    const s1 = await joinTopic({ id: a.id, username: a.username }, TOPIC, a.color);
    const roomId = s1.room.id;
    await joinTopic({ id: b.id, username: b.username }, TOPIC, b.color);
    assert.equal((await listPlayers(roomId)).length, 2);

    await expireWait(roomId);
    const now = Date.now();
    await advanceRoom((await getRoom(roomId))!, now);

    const room = (await getRoom(roomId))!;
    assert.equal(room.status, 'waiting');
    assert.equal((await listPlayers(roomId)).length, 2);
    ok('two players below the floor keep their seats');
    assert.ok(room.startsAt > now, 'the countdown should have been wound back up');
    ok('and are given another window to fill in');
    assert.equal((await getTickets(a.id))[a.color] ?? 0, 0);
    ok('with nothing refunded, because nothing is over');
  }

  // ── 3. A ROOM THAT ALLOWS ONE PLAYER STILL STARTS ─────────────────────
  /* «به منطق بازی دست نزن» — where the operator has set the floor to one, a
   * single player at the deadline is a match starting, not a room emptying.
   * The eject must never get there first. */
  {
    /* A topic of its own, so the half-full room left standing by the section
       above cannot be the room this one joins. */
    await updateConfig({ room: { capacity: 8, minUsers: 1, waitSeconds: 120, manualStartEnabled: false, startPct: 70 },
      topics: { [TOPIC]: { enabled: true }, [SOLO_TOPIC]: { enabled: true } } });
    for (let i = 0; i < 6; i++) {
      await repositories.questions.save({ id: 'aloneq' + i, category: SOLO_TOPIC, difficulty: 'easy', text: 'سوال ' + i,
        options: ['درست', 'غلط', 'سه', 'چهار'], correctIndex: 0, tags: [], status: 'approved', version: 1 } as any);
    }
    const u = await player('green');
    const s = await joinTopic({ id: u.id, username: u.username }, SOLO_TOPIC, u.color);
    const roomId = s.room.id;
    await expireWait(roomId);
    await advanceRoom((await getRoom(roomId))!, Date.now());

    const room = (await getRoom(roomId))!;
    assert.equal(room.status, 'running');
    assert.equal((await listPlayers(roomId)).length, 1);
    ok('a room whose floor is one starts with the one player it has');
    assert.equal((await getTickets(u.id))[u.color] ?? 0, 0);
    ok('and their ticket stays spent, because they got their match');
    const snap = await snapshot(roomId, u.id);
    assert.equal(snap.room.noOpponents, false);
    ok('and nothing tells them there was no opponent');

    /* AND WHEN THAT MATCH IS OVER. A room that was played and then finished is
       an ending, not an empty room — the two must never be confused, or every
       finished match would send its players home with «حریفی نبود». */
    const played = (await getRoom(roomId))!;
    played.status = 'finished'; played.phase = 'finished'; played.endedAt = Date.now();
    await saveRoom(played);
    const after = await snapshot(roomId, u.id);
    assert.equal(after.room.status, 'finished');
    assert.equal(after.room.noOpponents, false);
    ok('and a match that was actually played never reads as an empty room');
  }

  console.log('\nALL LONE-PLAYER TESTS PASSED (' + passed + ')');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
