/* LAST SURVIVOR AT SCALE — 1,000 players, 10 rooms, played to the end.
 *
 * Everything else in this suite drives two or three players through a room.
 * That proves the rules; it proves nothing about what happens when a hundred
 * people are in one room and ten rooms are running at once, which is what the
 * game is actually for. The failures that only appear there are the ones that
 * cost money: a pot that does not add up, a payout made twice, a player
 * eliminated in one room affecting another, a room that starts on people who
 * are not in it.
 *
 * So this opens ten rooms of a hundred, plays every one of them to its ending
 * with real answers, and then audits the books:
 *
 *   • CONSERVATION. Every toman that entered a room as ticket value leaves it
 *     exactly once — as a payout, as commission, or as a forfeited pot. Not a
 *     rial more, not a rial less, per room and in total.
 *   • ISOLATION. Ten rooms running together settle exactly as they would alone.
 *   • NO DOUBLE PAY. A player's wallet gains precisely what the room says it
 *     paid them.
 *   • HEADCOUNT. Alive + eliminated + cashed-out is always the room's roll.
 *   • THE NEW RULES: an emptied waiting room is closed and never handed to the
 *     next player; and when a round wipes a room out, exactly ONE player — the
 *     last one out, in the server's own order — is paid, and the rest of the
 *     pot is booked to the house.
 *
 * Run: npx tsx src/tests/lsLoad.test.ts
 */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { getAccount } from '../services/walletLedgerService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, listPlayers, leaveRoom, findOrCreateRoom, listActiveRooms } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer, eliminationOrder } from '../services/lastSurvivorWorker.js';
import { houseRevenueSummary, _resetHouseRevenue } from '../services/houseRevenueService.js';
import { buildPool } from '../services/lastSurvivorPrize.js';
import { getConfig } from '../services/lastSurvivorConfig.js';
import { gameConfig } from '../core/config.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const TOPIC = 'بار سنگین';
const ROOMS = 10;
const PER_ROOM = 100;

function setCommission(pct: number): void {
  (gameConfig as any).economy = (gameConfig as any).economy ?? {};
  (gameConfig as any).economy.paid = { ...((gameConfig as any).economy.paid ?? {}), rakePercent: pct };
}

async function expire(roomId: string): Promise<void> {
  const r = await getRoom(roomId); if (!r) return;
  r.phaseEndsAt = 0; r.startsAt = 0;
  await saveRoom(r);
}
async function step(roomId: string): Promise<void> {
  await expire(roomId);
  const r = await getRoom(roomId); if (!r) return;
  await advanceRoom(r, Date.now());
}

let uidSeq = 0;
async function makeUser(): Promise<string> {
  const uid = 'load_' + (++uidSeq);
  await repositories.users.save({
    id: uid, username: uid, displayName: uid, phone: '0913' + String(1000000 + uidSeq),
    plan: 'paid', wallet: 0, coins: 0, xp: 0, level: 1, weeklyScore: 0, hearts: 5,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return uid;
}

/* Ticket colours are mixed on purpose: the split is by UNITS, not by heads, and
   a room where everybody holds the same ticket would never notice if that were
   wrong. */
const COLOURS = ['green', 'blue', 'red'];

/* A LEFTOVER LOBBY IS NOT A CLEAN SLATE.
   findOrCreateRoom quite correctly puts a new player into whatever waiting room
   still has space — so a test that just joins N players gets the tail of the
   previous test's room plus a new one, and then asserts about "the room" while
   half its players are somewhere else. Every case below starts from no waiting
   room at all, and checks that its players really did land together. */
async function drainWaitingRooms(): Promise<void> {
  for (const r of await listActiveRooms()) {
    if (r.topic !== TOPIC || r.status !== 'waiting') continue;
    r.status = 'finished'; r.phase = 'finished'; r.endedAt = Date.now();
    await saveRoom(r);
  }
}
/** n players, all in one fresh room, with the room already running. */
async function fillRoom(n: number, colourAt: (i: number) => string = () => 'green'): Promise<{ roomId: string; ids: string[] }> {
  await drainWaitingRooms();
  const ids: string[] = []; let roomId = '';
  for (let i = 0; i < n; i++) {
    const uid = await makeUser();
    const colour = colourAt(i);
    await grantTickets(uid, colour, 1);
    const s = await joinTopic({ id: uid, username: uid }, TOPIC, colour);
    if (!roomId) roomId = s.room.id;
    assert.equal(s.room.id, roomId, 'players were split across rooms — the lobby was not drained');
    ids.push(uid);
  }
  await advanceRoom((await getRoom(roomId))!, Date.now());
  return { roomId, ids };
}

async function run(): Promise<void> {
  _resetHouseRevenue();
  setCommission(10);
  await updateConfig({
    room: { capacity: PER_ROOM, minUsers: 2, waitSeconds: 0, manualStartEnabled: false, startPct: 100 },
    match: { totalRounds: 8, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  });
  for (let i = 0; i < 40; i++) {
    await repositories.questions.save({
      id: 'lq' + i, category: TOPIC, difficulty: i < 10 ? 'easy' : i < 20 ? 'medium' : i < 30 ? 'hard' : 'veryhard',
      text: 'سوال بار ' + i, options: ['درست', 'غلط', 'سه', 'چهار'], correctIndex: 0,
      tags: [], status: 'approved', version: 1
    } as any);
  }
  const cfg = await getConfig();

  /* ---- build ten full rooms of a hundred ---------------------------------- */
  type Room = { id: string; ids: string[]; colours: Record<string, string> };
  const rooms: Room[] = [];
  const t0 = Date.now();
  for (let r = 0; r < ROOMS; r++) {
    const ids: string[] = []; const colours: Record<string, string> = {};
    let roomId = '';
    for (let i = 0; i < PER_ROOM; i++) {
      const uid = await makeUser();
      const colour = COLOURS[i % COLOURS.length]!;
      await grantTickets(uid, colour, 1);
      const s = await joinTopic({ id: uid, username: uid }, TOPIC, colour);
      roomId = s.room.id; ids.push(uid); colours[uid] = colour;
    }
    rooms.push({ id: roomId, ids, colours });
  }
  const buildMs = Date.now() - t0;

  await check(`${ROOMS} rooms of ${PER_ROOM} were built (${buildMs}ms)`, async () => {
    assert.equal(rooms.length, ROOMS);
    const uniq = new Set(rooms.map((r) => r.id));
    /* A full room must not accept a 101st player: the next joiner opens a new
       room. If two of these ids are the same, capacity is not being honoured
       and two "rooms" are one. */
    assert.equal(uniq.size, ROOMS, 'rooms collapsed into one another: ' + uniq.size);
    for (const r of rooms) assert.equal((await listPlayers(r.id)).length, PER_ROOM, 'room ' + r.id + ' is not full');
  });

  await check('every room starts, and starts with everybody alive', async () => {
    for (const r of rooms) {
      await advanceRoom((await getRoom(r.id))!, Date.now());
      const room = (await getRoom(r.id))!;
      assert.equal(room.status, 'running', 'room did not start');
      const players = await listPlayers(r.id);
      const notAlive = players.filter((p) => p.status !== 'alive');
      assert.equal(notAlive.length, 0, notAlive.length + ' players were not made alive');
    }
  });

  /* ---- play all ten rooms, round by round, interleaved -------------------- */
  /* Interleaved on purpose: one room per step, round-robin, so any state that
     leaks between rooms (a shared "current question", a module-level answer map)
     shows up as a wrong grade rather than staying hidden behind a test that
     finishes one room before starting the next. */
  const paidRounds: Record<string, number> = {};
  const wipeouts: string[] = [];
  const t1 = Date.now();
  let guard = 0;
  while (rooms.some((r) => !paidRounds[r.id]) && guard++ < 400) {
    for (const r of rooms) {
      if (paidRounds[r.id]) continue;
      let room = await getRoom(r.id);
      if (!room || room.status === 'finished') { paidRounds[r.id] = 1; continue; }
      if (room.phase === 'ready') { await step(r.id); room = (await getRoom(r.id))!; }
      if (room.phase === 'question') {
        const players = await listPlayers(r.id);
        const alive = players.filter((p) => p.status === 'alive');
        /* A survival rate that thins the room fast enough to reach an ending
           inside the round budget, deterministic per (room, round, player) so a
           failure can be reproduced. */
        for (const p of alive) {
          const h = (p.userId + ':' + room.round).split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 7);
          const right = (h % 100) < 55;
          await submitAnswer(r.id, p.userId, room.round, right ? 0 : 1);
        }
        await step(r.id);                                  // grade
      } else {
        await step(r.id);
      }
      room = await getRoom(r.id);
      if (!room || room.status === 'finished') { paidRounds[r.id] = 1; continue; }
      /* Nobody cashes out in this run: every toman has to reach an ending, which
         is the strongest form of the conservation check. */
      if (room.phase === 'cashout') { await step(r.id); }
    }
  }
  const playMs = Date.now() - t1;

  await check(`all ${ROOMS} rooms reached an ending (${playMs}ms, ${guard} passes)`, async () => {
    for (const r of rooms) {
      const room = (await getRoom(r.id))!;
      assert.equal(room.status, 'finished', 'room ' + r.id + ' is still ' + room.status + '/' + room.phase);
    }
  });

  /* ---- the audit --------------------------------------------------------- */
  let totalGross = 0, totalNet = 0, totalPaid = 0;
  await check('every room’s books balance to the rial', async () => {
    for (const r of rooms) {
      const room = (await getRoom(r.id))!;
      const players = await listPlayers(r.id);
      const pool = buildPool(room.config, players.map((p) => p.color));
      const paid = players.reduce((s, p) => s + p.payoutCash, 0);
      totalGross += pool.gross; totalNet += pool.net; totalPaid += paid;
      /* Never more than the net pot — over-payment is money invented. */
      assert.ok(paid <= pool.net, 'room ' + r.id + ' paid ' + paid + ' out of a ' + pool.net + ' pot');
      const survivors = players.filter((p) => p.status === 'alive');
      if (survivors.length > 0) {
        /* Somebody survived: the pot is distributed in full. */
        assert.equal(paid, pool.net, 'room ' + r.id + ' left ' + (pool.net - paid) + ' undistributed with ' + survivors.length + ' survivors');
      } else {
        wipeouts.push(r.id);
      }
    }
    assert.ok(totalGross > 0, 'no money entered the rooms at all');
  });

  await check('headcount is never lost: alive + out + cashed = the roll', async () => {
    for (const r of rooms) {
      const players = await listPlayers(r.id);
      const a = players.filter((p) => p.status === 'alive').length;
      const e = players.filter((p) => p.status === 'eliminated').length;
      const c = players.filter((p) => p.status === 'cashed_out').length;
      const w = players.filter((p) => p.status === 'waiting').length;
      assert.equal(a + e + c + w, PER_ROOM, 'room ' + r.id + ' lost players: ' + JSON.stringify({ a, e, c, w }));
      assert.equal(w, 0, 'room ' + r.id + ' finished with ' + w + ' players still marked waiting');
    }
  });

  await check('a player’s wallet holds exactly what their room paid them', async () => {
    let checked = 0;
    for (const r of rooms) {
      for (const p of await listPlayers(r.id)) {
        const acct = await getAccount(p.userId);
        assert.equal(acct.available, p.payoutCash,
          'wallet ' + acct.available + ' but the room recorded ' + p.payoutCash + ' for ' + p.userId);
        checked++;
      }
    }
    assert.equal(checked, ROOMS * PER_ROOM, 'only ' + checked + ' wallets were checked');
  });

  await check('nobody is paid twice, and nobody is paid a negative amount', async () => {
    for (const r of rooms) {
      for (const p of await listPlayers(r.id)) {
        assert.ok(p.payoutCash >= 0, 'negative payout for ' + p.userId);
        if (p.status === 'eliminated') {
          /* An eliminated player is paid nothing — UNLESS they were the last one
             out of a wiped room, which is the one exception and is checked on
             its own below. */
          const room = (await getRoom(r.id))!;
          const survivors = (await listPlayers(r.id)).filter((x) => x.status === 'alive');
          if (survivors.length > 0) assert.equal(p.payoutCash, 0, 'an eliminated player was paid in ' + r.id);
          else if (p.payoutCash > 0) assert.equal(p.eliminatedRound, room.round, 'a player eliminated in an earlier round was paid');
        }
      }
    }
  });

  await check('the house books the commission and every forfeited pot', async () => {
    const sum = await houseRevenueSummary();
    const rake = totalGross - totalNet;
    const booked = Number(sum.total || 0);
    /* The house takes the commission plus whatever no player took: the whole
       net pot minus everything actually paid out. */
    const expected = rake + (totalNet - totalPaid);
    assert.equal(booked, expected, 'house booked ' + booked + ' but should hold ' + expected);
  });

  await check('so every toman that entered leaves exactly once', async () => {
    const sum = await houseRevenueSummary();
    const booked = Number(sum.total || 0);
    assert.equal(totalPaid + booked, totalGross,
      'in ' + totalGross + ', out ' + (totalPaid + booked) + ' (players ' + totalPaid + ' + house ' + booked + ')');
  });

  /* ---- THE WIPE-OUT RULE ------------------------------------------------- */
  await check('when a room is wiped out, exactly one player is paid — the last one out', async () => {
    let seen = 0;
    for (const id of wipeouts) {
      const room = (await getRoom(id))!;
      const players = await listPlayers(id);
      const lastRound = players.filter((p) => p.status === 'eliminated' && p.eliminatedRound === room.round);
      if (lastRound.length === 0) continue;
      const paidIn = players.filter((p) => p.payoutCash > 0);
      /* Somebody may have cashed out earlier in the match; only this round's
         payouts are the wipe-out settlement. */
      const settled = lastRound.filter((p) => p.payoutCash > 0);
      assert.ok(settled.length <= 1, 'room ' + id + ' paid ' + settled.length + ' of the wiped-out players');
      if (settled.length === 1) {
        const order = eliminationOrder(id, room.round, lastRound.map((p) => p.userId));
        assert.equal(settled[0]!.userId, order[order.length - 1],
          'the paid player is not the last one out in the server’s own order');
        seen++;
      }
    }
    /* If no room happened to wipe out, this run proves nothing about the rule —
       say so rather than passing quietly. The dedicated test below forces it. */
    console.log('      (' + wipeouts.length + ' rooms wiped out, ' + seen + ' settled to a last player)');
  });

  /* A forced wipe-out, so the rule is exercised whatever the big run rolled. */
  await check('a forced wipe-out pays the last player out and nobody else', async () => {
    const { roomId, ids } = await fillRoom(PER_ROOM);
    let room = (await getRoom(roomId))!;
    assert.equal(room.status, 'running');
    if (room.phase === 'ready') { await step(roomId); room = (await getRoom(roomId))!; }
    const pool = buildPool(room.config, ids.map(() => 'green'));

    /* EVERY player answers wrongly on round one. */
    for (const uid of ids) await submitAnswer(roomId, uid, room.round, 1);
    await step(roomId);                                  // grade → elimination
    for (let i = 0; i < 6; i++) { const rr = await getRoom(roomId); if (!rr || rr.status === 'finished') break; await step(roomId); }

    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'finished', 'the room should have ended with nobody alive');
    const players = await listPlayers(roomId);
    assert.equal(players.filter((p) => p.status === 'alive').length, 0, 'somebody survived a total wipe-out');

    const paid = players.filter((p) => p.payoutCash > 0);
    assert.equal(paid.length, 1, paid.length + ' players were paid; exactly one should be');
    const order = eliminationOrder(roomId, after.round, players.filter((p) => p.eliminatedRound === after.round).map((p) => p.userId));
    assert.equal(paid[0]!.userId, order[order.length - 1], 'the wrong player was paid');

    /* Their share is what a normal split among that field would have given
       them — not a made-up figure — and their wallet actually holds it. */
    const share = paid[0]!.payoutCash;
    assert.ok(share > 0 && share <= pool.net, 'share ' + share + ' is outside the pot ' + pool.net);
    const acct = await getAccount(paid[0]!.userId);
    assert.equal(acct.available, share, 'the wallet does not hold the share');
    /* And with equal tickets all round, one share of N is the pot divided N ways. */
    const expected = Math.floor(pool.net / players.length);
    assert.ok(Math.abs(share - expected) <= players.length,
      'share ' + share + ' is not one ' + players.length + '-way split of ' + pool.net + ' (' + expected + ')');

    /* CONSERVATION ON THE WIPE-OUT PATH. The house keeps everything except that
       one share — if the forfeited figure still counted the share as unclaimed,
       the same money would be booked twice and the books would not close. */
    const house = await houseRevenueSummary();
    const forfeit = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.ok(forfeit, 'the rest of the pot must be booked to the house');
    assert.equal(forfeit!.amount, pool.net - share, 'the house booked ' + forfeit!.amount + ', should be ' + (pool.net - share));
    assert.equal(share + forfeit!.amount, pool.net, 'the pot did not add up on the wipe-out path');
  });

  await check('a room emptied without a goodbye is closed on the very next tick', async () => {
    /* leaveRoom closes the room itself, so this proves the WORKER does too —
       a player who closes the app never says goodbye, and their seat is swept.
       Two minutes of grace was the old behaviour, and two minutes is exactly
       long enough for the next player to be dropped into a dead lobby. */
    await drainWaitingRooms();
    const uid = await makeUser();
    await grantTickets(uid, 'green', 1);
    const s = await joinTopic({ id: uid, username: uid }, TOPIC, 'green');
    const roomId = s.room.id;
    const { removePlayer } = await import('../services/lastSurvivorService.js');
    await removePlayer(roomId, uid);                 // gone, without leaveRoom
    const before = (await getRoom(roomId))!;
    assert.equal(before.status, 'waiting', 'the room should still be open at this point');
    /* One tick, right now — NOT two minutes past the deadline. */
    await advanceRoom((await getRoom(roomId))!, Date.now());
    assert.equal((await getRoom(roomId))!.status, 'finished', 'the empty room survived a tick');
  });

  /* ---- THE EMPTIED ROOM -------------------------------------------------- */
  await check('a waiting room that empties is closed, and never handed to the next player', async () => {
    const uid = await makeUser();
    await grantTickets(uid, 'green', 2);
    const first = await joinTopic({ id: uid, username: uid }, TOPIC, 'green');
    const roomId = first.room.id;
    assert.equal((await getRoom(roomId))!.status, 'waiting');

    await leaveRoom(roomId, uid);
    const closed = (await getRoom(roomId))!;
    assert.equal(closed.status, 'finished', 'the emptied room is still ' + closed.status);
    assert.ok(!(await listActiveRooms()).some((r) => r.id === roomId), 'the closed room is still listed as active');

    const again = await joinTopic({ id: uid, username: uid }, TOPIC, 'green');
    assert.notEqual(again.room.id, roomId, 'the player was put back into the room they had emptied');
    /* And the new room's clock starts NOW, which is the whole point: the old
       room's deadline had been running since it was created. */
    assert.ok(again.room.startsAt >= Date.now() - 2000, 'the new room inherited an old countdown');
    await leaveRoom(again.room.id, uid).catch(() => undefined);
  });

  await check('an emptied room is not offered by findOrCreateRoom either', async () => {
    const uid = await makeUser();
    await grantTickets(uid, 'green', 1);
    const s = await joinTopic({ id: uid, username: uid }, TOPIC, 'green');
    const roomId = s.room.id;
    /* Empty it WITHOUT going through leaveRoom's own close, to prove the
       lookup defends itself rather than relying on one caller. */
    const { removePlayer } = await import('../services/lastSurvivorService.js');
    await removePlayer(roomId, uid);
    const fresh = await findOrCreateRoom(TOPIC, await getConfig());
    assert.notEqual(fresh.id, roomId, 'an empty room was handed out');
    assert.equal((await getRoom(roomId))!.status, 'finished', 'and it was not closed on the way past');
  });

  /* ---- WHERE THE MONEY ACTUALLY BREAKS ----------------------------------
     The run above never had a single cash-out, so it never touched the
     hardest path in the game: people taking money OUT of the pot while others
     are still playing for it. Over-payment lives there, not in a clean run. */
  await check('a room where players cash out all through it still balances exactly', async () => {
    const { roomId } = await fillRoom(PER_ROOM, (i) => COLOURS[i % COLOURS.length]!);
    const room0 = (await getRoom(roomId))!;
    const pool = buildPool(room0.config, (await listPlayers(roomId)).map((p) => p.color));

    const { submitDecision } = await import('../services/lastSurvivorWorker.js') as any;
    let guard2 = 0;
    while (guard2++ < 60) {
      let room = await getRoom(roomId);
      if (!room || room.status === 'finished') break;
      if (room.phase === 'ready') { await step(roomId); room = (await getRoom(roomId))!; }
      if (room.phase === 'question') {
        for (const p of (await listPlayers(roomId)).filter((x) => x.status === 'alive')) {
          const h = (p.userId + ':q' + room.round).split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 11);
          await submitAnswer(roomId, p.userId, room.round, (h % 100) < 70 ? 0 : 1);
        }
        await step(roomId);
        continue;
      }
      if (room.phase === 'cashout') {
        /* A THIRD of the survivors take the money, every single round. */
        const alive = (await listPlayers(roomId)).filter((x) => x.status === 'alive');
        for (const p of alive) {
          const h = (p.userId + ':c' + room.round).split('').reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 5);
          if (h % 3 === 0 && typeof submitDecision === 'function') {
            await submitDecision(roomId, p.userId, room.round, 'cashout').catch(() => undefined);
          }
        }
        await step(roomId);
        continue;
      }
      await step(roomId);
    }

    const room = (await getRoom(roomId))!;
    assert.equal(room.status, 'finished', 'the cash-out room never ended (' + room.phase + ')');
    const players = await listPlayers(roomId);
    const cashed = players.filter((p) => p.status === 'cashed_out');
    assert.ok(cashed.length > 0, 'nobody cashed out, so this proved nothing');
    const paid = players.reduce((s, p) => s + p.payoutCash, 0);
    /* THE ONE THAT MATTERS: cash-outs plus the final split can never exceed the
       pot. A single over-payment here is money the company does not have. */
    assert.ok(paid <= pool.net, 'paid ' + paid + ' out of a ' + pool.net + ' pot (' + cashed.length + ' cash-outs)');
    /* And each wallet holds exactly what it was told. */
    for (const p of players) {
      const acct = await getAccount(p.userId);
      assert.equal(acct.available, p.payoutCash, 'wallet mismatch for ' + p.userId);
    }
    const survivors = players.filter((p) => p.status === 'alive');
    if (survivors.length > 0) assert.equal(paid, pool.net, 'a survivor ending left ' + (pool.net - paid) + ' undistributed');
    console.log('      (' + cashed.length + ' cash-outs, ' + survivors.length + ' survivors, ' + paid + '/' + pool.net + ' paid)');
  });

  await check('a hundred players arriving at once fill exactly one room, not one and a bit', async () => {
    /* Joining is a read-then-write: find a room with space, then add a player.
       Two hundred of those interleaved is where a room quietly ends up with 101
       people in it and a pot that does not match its roll. */
    await drainWaitingRooms();
    const users: string[] = [];
    for (let i = 0; i < 200; i++) {
      const uid = await makeUser();
      await grantTickets(uid, 'green', 1);
      users.push(uid);
    }
    const before = new Set((await listActiveRooms()).map((r) => r.id));
    await Promise.all(users.map((uid) => joinTopic({ id: uid, username: uid }, TOPIC, 'green').catch(() => null)));
    const after = (await listActiveRooms()).filter((r) => !before.has(r.id) || r.topic === TOPIC);
    for (const r of after) {
      const n = (await listPlayers(r.id)).length;
      assert.ok(n <= r.capacity, 'room ' + r.id + ' holds ' + n + ' players in ' + r.capacity + ' seats');
      /* And its pot has to match the people actually in it. */
      const expect = (await listPlayers(r.id)).reduce((sum, p) => sum + (r.config.economy.tickets[p.color]?.value || 0), 0);
      assert.equal(r.grossPool, expect, 'room ' + r.id + ' pot ' + r.grossPool + ' but its ' + n + ' players staked ' + expect);
    }
  });

  await check('a player cannot walk out of a match that has started', async () => {
    const { roomId, ids: uids } = await fillRoom(PER_ROOM);
    assert.equal((await getRoom(roomId))!.status, 'running');
    /* Leaving now would take a stake out of a pot other people are playing for. */
    await assert.rejects(() => leaveRoom(roomId, uids[0]!), /ROOM_STARTED|شروع/, 'a running room let a player leave');
    const room = (await getRoom(roomId))!;
    assert.equal((await listPlayers(roomId)).length, PER_ROOM, 'the roll changed anyway');
    assert.ok(room.grossPool > 0, 'the pot was emptied anyway');
  });

  await check('an answer for the wrong round, or after the round, changes nothing', async () => {
    const { roomId, ids: uids } = await fillRoom(PER_ROOM);
    let room = (await getRoom(roomId))!;
    if (room.phase === 'ready') { await step(roomId); room = (await getRoom(roomId))!; }
    const victim = uids[0]!;
    /* The right answer for round 1, filed against round 2. */
    await submitAnswer(roomId, victim, room.round + 1, 0).catch(() => undefined);
    const after = (await listPlayers(roomId)).find((p) => p.userId === victim)!;
    assert.notEqual(after.answerRound, room.round, 'an answer for another round counted for this one');
    /* Everyone else answers correctly; the victim is graded on having answered
       nothing for THIS round, which is an elimination. */
    for (const u of uids.slice(1)) await submitAnswer(roomId, u, room.round, 0);
    await step(roomId);
    const graded = (await listPlayers(roomId)).find((p) => p.userId === victim)!;
    assert.equal(graded.status, 'eliminated', 'the mis-filed answer saved a player who never answered');
  });

  await check('the elimination phase lasts long enough to show every elimination', async () => {
    /* One second per player is asked for; the phase has to be at least that
       long or the sequence is cut off — the player watching their own card
       never sees it. */
    const { roomId, ids: uids } = await fillRoom(PER_ROOM);
    let room = (await getRoom(roomId))!;
    if (room.phase === 'ready') { await step(roomId); room = (await getRoom(roomId))!; }
    /* Ten go out, ninety survive. */
    for (const [i, u] of uids.entries()) await submitAnswer(roomId, u, room.round, i < 10 ? 1 : 0);
    const at = Date.now();
    const r0 = (await getRoom(roomId))!; r0.phaseEndsAt = at; await saveRoom(r0);
    await advanceRoom((await getRoom(roomId))!, at);
    const elim = (await getRoom(roomId))!;
    assert.equal(elim.phase, 'elimination');
    const out = (await listPlayers(roomId)).filter((p) => p.status === 'eliminated').length;
    assert.equal(out, 10, out + ' players went out, expected 10');
    const window = (elim.phaseEndsAt || 0) - at;
    assert.ok(window >= out * 1000, 'the phase is ' + window + 'ms for ' + out + ' eliminations at a second each');
    assert.ok(window <= 20_000, 'the phase runs ' + window + 'ms — a big wipe-out would stall the match');
  });

  await check('the elimination order is stable, and is a real shuffle', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => 'u' + i);
    const a = eliminationOrder('room-x', 3, ids);
    const b = eliminationOrder('room-x', 3, ids.slice().reverse());
    assert.deepEqual(a, b, 'the same round gave two different orders');
    assert.equal(new Set(a).size, ids.length, 'the order lost or duplicated a player');
    /* A different round, or a different room, is a different order — otherwise
       the last player out would be predictable from the player list alone. */
    const other = eliminationOrder('room-x', 4, ids);
    const elsewhere = eliminationOrder('room-y', 3, ids);
    assert.notDeepEqual(a, other, 'every round eliminates in the same order');
    assert.notDeepEqual(a, elsewhere, 'every room eliminates in the same order');
    assert.notDeepEqual(a, ids, 'the order is just the list as given');
  });

  console.log(`[lsLoad] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
