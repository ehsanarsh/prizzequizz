/* «از کی بپرسم؟» ON THE SERVER.
 *
 * The game only ever existed in the browser: bot names, a coin flip for the
 * "opponent", and nothing leaving the phone. A league final pays real money, so
 * every rule that decides the winner now lives here — and these are the ways a
 * server-authoritative version can quietly hand somebody a match:
 *
 *   — another player answering your question for you.
 *   — the correct index reachable while the question is open.
 *   — picking yourself, and keeping the turn for ever.
 *   — going quiet costing nothing, so silence beats guessing.
 *   — a room that ends twice and pays its prize twice.
 *
 * Run: npx tsx src/tests/wta.test.ts
 */
import assert from 'node:assert/strict';
import {
  openForLeagueRoom, join, start, answer, pick, tick, snapshot,
  _resetWta, _room, _settle, WtaError, WTA_LIVES, WTA_ANSWER_SECONDS
} from '../services/wtaService.js';
import {
  setLeagueConfig, closeSeason, drawRound, listSeats, listRooms, _resetLeague, LEAGUE_DEFAULTS
} from '../services/leagueService.js';
import { repositories } from '../repositories/index.js';
import { isoWeekId } from '../services/scoringConfig.js';
import { getAccount } from '../services/walletLedgerService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let seq = 0, band = 0;
async function seedQuestions(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await repositories.questions.save({
      id: id(), category: 'استودیو', difficulty: 'easy', text: 'س' + i,
      options: ['درست', 'ب', 'ج', 'د'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }
}

/** A drawn league room with `n` players, ready to open. */
async function room(n: number, opts: { participation?: number; winner?: number } = {}) {
  _resetWta(); _resetLeague();
  await setLeagueConfig({
    roomSize: 50,
    tiers: [{ ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: n,
      participationPrize: opts.participation ?? 0, winnerPrize: opts.winner ?? 0 }]
  });
  const base = ++band * 1_000_000;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const uid = 'wt' + (++seq).toString().padStart(3, '0');
    await repositories.users.save({
      id: uid, username: uid, displayName: uid, phone: '0918' + String(seq).padStart(7, '0'),
      plan: 'free', level: 1, xp: 0, weeklyScore: base - i * 10, weeklyWeek: isoWeekId(),
      wallet: 0, coins: 0, hearts: 5, tickets: {}
    } as any);
    ids.push(uid);
  }
  const season = 'wta-' + band;
  await closeSeason(season);
  const [lr] = await drawRound(season, 1);
  const seats = (await listSeats(lr!.id)).map((s) => s.userId);
  await openForLeagueRoom(lr!);
  return { leagueRoomId: lr!.id, seats, season };
}

/** Everyone takes their seat. */
function joinAll(roomId: string, seats: string[]): void { for (const s of seats) join(roomId, s); }

/** Answer correctly and pass the turn on to somebody who is still standing. */
async function correctThenPass(roomId: string, to?: string): Promise<void> {
  const r = _room(roomId)!;
  const me = r.turnUserId!;
  await answer(roomId, me, r.correctIndex!);
  const target = to ?? r.players.find((p) => !p.out && p.userId !== me)!.userId;
  await pick(roomId, me, target);
}
/** Answer wrongly — a life gone, and the turn moves on by itself. */
async function wrong(roomId: string): Promise<string> {
  const r = _room(roomId)!;
  const me = r.turnUserId!;
  const bad = r.correctIndex === 0 ? 1 : 0;
  await answer(roomId, me, bad);
  return me;
}

async function run(): Promise<void> {
  await seedQuestions();

  /* ── taking a seat ────────────────────────────────────────────────── */

  await check('the match opens on whoever turned up', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    assert.equal(r.phase, 'turn', 'a question is open');
    assert.equal(r.players.filter((p) => !p.out).length, 4);
    assert.ok(seats.includes(r.turnUserId!), 'and somebody in the room has the turn');
    assert.equal(r.players[0]!.lives, WTA_LIVES);
  });

  await check('whoever did not turn up is out before the first question', async () => {
    const { leagueRoomId, seats } = await room(4);
    join(leagueRoomId, seats[0]!);
    join(leagueRoomId, seats[1]!);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    assert.equal(r.players.filter((p) => !p.out).length, 2, 'only the two who came are playing');
    assert.ok(r.players.find((p) => p.userId === seats[2]!)!.out);
    assert.ok(!seats.slice(2).includes(r.turnUserId!), 'and an absentee never gets the turn');
  });

  await check('a room only one player attends is a walkover', async () => {
    const { leagueRoomId, seats } = await room(4);
    join(leagueRoomId, seats[1]!);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    assert.equal(r.phase, 'finished');
    assert.equal(r.winnerUserId, seats[1]!, 'the one who came wins it');
  });

  await check('a room nobody attends has no winner at all', async () => {
    const { leagueRoomId } = await room(4);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    assert.equal(r.phase, 'finished');
    assert.equal(r.winnerUserId, null, 'an empty room must not crown anybody');
  });

  await check('the door shuts once the match has started', async () => {
    const { leagueRoomId, seats } = await room(4);
    join(leagueRoomId, seats[0]!); join(leagueRoomId, seats[1]!);
    await start(leagueRoomId);
    assert.throws(() => join(leagueRoomId, seats[2]!), (e: any) => e instanceof WtaError && e.code === 'ALREADY_STARTED');
  });

  /* ── the turn ─────────────────────────────────────────────────────── */

  await check('only the player being asked may answer', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    const other = seats.find((s) => s !== r.turnUserId)!;
    await assert.rejects(() => answer(leagueRoomId, other, r.correctIndex!),
      (e: any) => e instanceof WtaError && e.code === 'NOT_YOUR_TURN');
    assert.equal(_room(leagueRoomId)!.phase, 'turn', 'and the question is still open');
  });

  await check('the correct answer is never in what a client can read', async () => {
    /* A client that knew it would win every turn — and a league final is money. */
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const snap = await snapshot(leagueRoomId, seats[0]!);
    const blob = JSON.stringify(snap);
    assert.ok(snap.question && snap.question.options.length === 4, 'the question is there to answer');
    assert.ok(!/correctIndex/.test(blob), 'correctIndex leaked into the snapshot: ' + blob.slice(0, 200));
  });

  await check('a right answer hands the asker the choice of who is next', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    const me = r.turnUserId!;
    const res = await answer(leagueRoomId, me, r.correctIndex!);
    assert.equal(res.correct, true);
    assert.equal(res.picking, true);
    assert.equal(_room(leagueRoomId)!.phase, 'picking');
    assert.equal(_room(leagueRoomId)!.turnUserId, me, 'the choice is still theirs');

    const target = seats.find((s) => s !== me)!;
    await pick(leagueRoomId, me, target);
    assert.equal(_room(leagueRoomId)!.turnUserId, target, 'and the turn goes where they said');
    assert.equal(_room(leagueRoomId)!.phase, 'turn');
  });

  await check('you cannot ask yourself, and keep the turn for ever', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    const me = r.turnUserId!;
    await answer(leagueRoomId, me, r.correctIndex!);
    await assert.rejects(() => pick(leagueRoomId, me, me),
      (e: any) => e instanceof WtaError && e.code === 'TARGET_IS_SELF');
  });

  await check('and somebody else cannot make the choice for you', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    const me = r.turnUserId!;
    const other = seats.find((s) => s !== me)!;
    await answer(leagueRoomId, me, r.correctIndex!);
    await assert.rejects(() => pick(leagueRoomId, other, me),
      (e: any) => e instanceof WtaError && e.code === 'NOT_YOUR_PICK');
  });

  await check('an eliminated player cannot be asked', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    /* Knock one player out. */
    const victim = _room(leagueRoomId)!.turnUserId!;
    for (let i = 0; i < WTA_LIVES; i++) {
      const r = _room(leagueRoomId)!;
      if (r.turnUserId !== victim) { await correctThenPass(leagueRoomId, victim); }
      await wrong(leagueRoomId);
    }
    assert.ok(_room(leagueRoomId)!.players.find((p) => p.userId === victim)!.out, 'the victim is out');
    const r2 = _room(leagueRoomId)!;
    if (r2.phase === 'turn') {
      const me = r2.turnUserId!;
      await answer(leagueRoomId, me, r2.correctIndex!);
      await assert.rejects(() => pick(leagueRoomId, me, victim),
        (e: any) => e instanceof WtaError && e.code === 'TARGET_NOT_PLAYING');
    }
  });

  /* ── losing ───────────────────────────────────────────────────────── */

  await check('a wrong answer costs one life and passes the turn on', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const before = _room(leagueRoomId)!.turnUserId!;
    await wrong(leagueRoomId);
    const p = _room(leagueRoomId)!.players.find((x) => x.userId === before)!;
    assert.equal(p.lives, WTA_LIVES - 1);
    assert.equal(p.out, false, 'one mistake is not an elimination');
    assert.notEqual(_room(leagueRoomId)!.turnUserId, before, 'and the turn moved');
  });

  await check('three wrong answers put you out', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const victim = _room(leagueRoomId)!.turnUserId!;
    for (let i = 0; i < WTA_LIVES; i++) {
      if (_room(leagueRoomId)!.turnUserId !== victim) await correctThenPass(leagueRoomId, victim);
      await wrong(leagueRoomId);
    }
    const p = _room(leagueRoomId)!.players.find((x) => x.userId === victim)!;
    assert.equal(p.lives, 0);
    assert.equal(p.out, true);
  });

  await check('running out of time costs the same as a wrong answer', async () => {
    /* Otherwise going quiet is safer than guessing, and the room stalls. */
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    const waiting = r.turnUserId!;
    await tick(r.endsAt + 1);
    const p = _room(leagueRoomId)!.players.find((x) => x.userId === waiting)!;
    assert.equal(p.lives, WTA_LIVES - 1, 'a life is gone');
    assert.notEqual(_room(leagueRoomId)!.turnUserId, waiting, 'and the room did not stall');
  });

  await check('an answer after the deadline is refused', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    await assert.rejects(() => answer(leagueRoomId, r.turnUserId!, r.correctIndex!, r.endsAt + 5000),
      (e: any) => e instanceof WtaError && e.code === 'TOO_LATE');
  });

  await check('nobody choosing in time does not freeze the studio', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const r = _room(leagueRoomId)!;
    const me = r.turnUserId!;
    await answer(leagueRoomId, me, r.correctIndex!);
    assert.equal(_room(leagueRoomId)!.phase, 'picking');
    await tick(_room(leagueRoomId)!.endsAt + 1);
    const after = _room(leagueRoomId)!;
    assert.equal(after.phase, 'turn', 'the studio picked for them');
    assert.notEqual(after.turnUserId, me, 'and it was not the same player again');
  });

  /* ── winning, and the money ───────────────────────────────────────── */

  await check('the last one standing wins, and the room pays', async () => {
    const { leagueRoomId, seats } = await room(3, { participation: 1000, winner: 9000 });
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);

    /* Knock two of the three out. */
    let guard = 0;
    while (_room(leagueRoomId)!.phase !== 'finished' && guard++ < 60) {
      const r = _room(leagueRoomId)!;
      if (r.phase === 'picking') { await tick(r.endsAt + 1); continue; }
      await wrong(leagueRoomId);
    }
    const r = _room(leagueRoomId)!;
    assert.equal(r.phase, 'finished', 'the room ended');
    assert.ok(r.winnerUserId, 'and somebody won');

    const bal = async (u: string) => { try { return (await getAccount(u)).available; } catch { return 0; } };
    for (const s of seats) {
      const got = await bal(s);
      assert.ok(got >= 1000, s + ' played and was paid ' + got);
    }
    assert.equal(await bal(r.winnerUserId!), 10000, 'the winner gets both prizes');
  });

  await check('an absentee is paid nothing even though the room played', async () => {
    const { leagueRoomId, seats } = await room(3, { participation: 1000, winner: 9000 });
    join(leagueRoomId, seats[0]!); join(leagueRoomId, seats[1]!);
    await start(leagueRoomId);
    let guard = 0;
    while (_room(leagueRoomId)!.phase !== 'finished' && guard++ < 60) {
      const r = _room(leagueRoomId)!;
      if (r.phase === 'picking') { await tick(r.endsAt + 1); continue; }
      await wrong(leagueRoomId);
    }
    const bal = async (u: string) => { try { return (await getAccount(u)).available; } catch { return 0; } };
    assert.equal(await bal(seats[2]!), 0, 'the absentee was paid ' + await bal(seats[2]!));
    assert.ok(await bal(seats[0]!) >= 1000, 'and the two who played were');
  });

  await check('a finished room cannot be paid again, by any route', async () => {
    /* THREE independent things stop a prize being paid twice: the room files
       its result once, the league refuses a seat it has already paid, and the
       wallet ledger rejects a repeated idempotency key. Removing any ONE of
       them leaves the money safe — which is the point of having three — so this
       asserts the outcome rather than naming a guard, and it does catch the
       case where two of them are gone. */
    const { leagueRoomId, seats } = await room(2, { participation: 1000, winner: 9000 });
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    let guard = 0;
    while (_room(leagueRoomId)!.phase !== 'finished' && guard++ < 40) {
      const r = _room(leagueRoomId)!;
      if (r.phase === 'picking') { await tick(r.endsAt + 1); continue; }
      await wrong(leagueRoomId);
    }
    const bal = async (u: string) => { try { return (await getAccount(u)).available; } catch { return 0; } };
    const winner = _room(leagueRoomId)!.winnerUserId!;
    const before = await bal(winner);
    for (let i = 0; i < 5; i++) await tick(Date.now() + 60_000);
    assert.equal(await bal(winner), before, 'a later tick paid the prize again');
    /* And the settle path itself, called straight, must refuse the second time —
       ticking alone never reaches it, so it would have been an untested guard. */
    for (let i = 0; i < 3; i++) await _settle(_room(leagueRoomId)!);
    assert.equal(await bal(winner), before, 'settling again paid the prize again');
    assert.equal(_room(leagueRoomId)!.reported, true, 'and the room still knows it has been filed');
    /* Now force the room to forget it filed, so the league's own guard is the
       only thing left standing. With both guards in place they mask each other
       and neither is really under test. */
    _room(leagueRoomId)!.reported = false;
    await _settle(_room(leagueRoomId)!);
    assert.equal(await bal(winner), before, 'a re-filed room paid the prize twice');
  });

  await check('the room reports the league seat list, not its own idea of it', async () => {
    const { leagueRoomId, seats } = await room(3, { participation: 500, winner: 500 });
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    let guard = 0;
    while (_room(leagueRoomId)!.phase !== 'finished' && guard++ < 60) {
      const r = _room(leagueRoomId)!;
      if (r.phase === 'picking') { await tick(r.endsAt + 1); continue; }
      await wrong(leagueRoomId);
    }
    const league = (await listRooms('wta-' + band)).find((r) => r.id === leagueRoomId)!;
    assert.equal(league.status, 'finished', 'the league room is closed too');
    assert.equal(league.winnerUserId, _room(leagueRoomId)!.winnerUserId, 'with the same winner');
  });

  /* ── what the players see ─────────────────────────────────────────── */

  await check('each player is told whether it is their turn', async () => {
    const { leagueRoomId, seats } = await room(4);
    joinAll(leagueRoomId, seats);
    await start(leagueRoomId);
    const turn = _room(leagueRoomId)!.turnUserId!;
    const mine = await snapshot(leagueRoomId, turn);
    const theirs = await snapshot(leagueRoomId, seats.find((s) => s !== turn)!);
    assert.equal(mine.me.myTurn, true);
    assert.equal(theirs.me.myTurn, false);
    assert.equal(mine.aliveCount, 4);
    assert.equal(mine.players.length, 4, 'and everybody in the studio is listed');
    assert.ok(mine.endsAt > Date.now(), 'with a live deadline');
    assert.ok(WTA_ANSWER_SECONDS > 0);
  });

  console.log(`[wta] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
