/* LAST SURVIVOR — leaving the lobby before the match starts.
 *
 * There was no way to leave at all. Closing the app left the row in place, so
 * the lobby still showed the player, they still counted towards minUsers, and
 * their ticket money stayed in the pot — a room could start on people who had
 * walked away. This covers the leave path and the idle sweep that stands in for
 * the goodbye a closed app never sends.
 *
 * Run: npx tsx src/tests/lsLeave.test.ts
 */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { grantTickets, getTickets } from '../services/ticketService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import {
  joinTopic, getRoom, saveRoom, listPlayers, leaveRoom, getPlayer,
  sweepIdlePlayers, touchPlayer, savePlayer, listActiveRooms, LastSurvivorError
} from '../services/lastSurvivorService.js';
import { advanceRoom } from '../services/lastSurvivorWorker.js';

const TOPIC = 'اطلاعات عمومی';
let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await freshRoom(); await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* joinTopic reuses any waiting room for the topic, so without this every case
 * would land in the one the previous case left behind and inherit its players
 * and its pot. Close them, so each scenario opens a room of its own. */
async function freshRoom(): Promise<void> {
  for (const r of await listActiveRooms()) {
    r.status = 'finished'; r.phase = 'finished'; r.endedAt = Date.now();
    await saveRoom(r);
  }
}

let n = 0;
async function player(color = 'green'): Promise<string> {
  const id = 'lv' + (++n) + '-' + Math.random().toString(36).slice(2, 8);
  await repositories.users.save({
    id, username: 'u' + n, displayName: 'u' + n, phone: '09' + String(100000000 + n),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  await grantTickets(id, color, 1);
  return id;
}

async function run(): Promise<void> {
  // A room that will not start on its own while we poke at it.
  await updateConfig({
    room: { capacity: 8, minUsers: 2, waitSeconds: 3600, manualStartEnabled: false, startPct: 70 },
    match: { totalRounds: 3, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  });

  await check('leaving gives the ticket back and takes its value out of the pot', async () => {
    const a = await player('green');
    const b = await player('green');
    const j1 = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    const j2 = await joinTopic({ id: b, username: 'b' }, TOPIC, 'green');
    assert.equal(j1.room.id, j2.room.id, 'both should land in the same waiting room');
    const roomId = j1.room.id;

    const potWithBoth = (await getRoom(roomId))!.grossPool;
    assert.ok(potWithBoth > 0, 'joining should build a pot');
    assert.equal((await getTickets(a)).green, 0, 'joining spends the ticket');

    const out = await leaveRoom(roomId, a);
    assert.equal(out.left, true);
    assert.equal(out.refunded, true, 'the ticket must come back');
    assert.equal((await getTickets(a)).green, 1, 'the ticket is back in hand');

    const potAfter = (await getRoom(roomId))!.grossPool;
    assert.ok(potAfter < potWithBoth, 'the pot must shrink by the stake that left');
    assert.equal(potAfter, potWithBoth / 2, 'two equal stakes, one left → half');

    const ids = (await listPlayers(roomId)).map((p) => p.userId);
    assert.deepEqual(ids, [b], 'the lobby lists only who is still there');
  });

  await check('the player is really gone, not just marked', async () => {
    const a = await player();
    const { room } = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    await leaveRoom(room.id, a);
    assert.equal(await getPlayer(room.id, a), null, 'no row should survive');
  });

  await check('coming back is an ordinary join', async () => {
    const a = await player();
    const first = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    await leaveRoom(first.room.id, a);
    const again = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    assert.equal((await getPlayer(again.room.id, a))?.userId, a, 'they are in the lobby again');
    assert.equal((await getTickets(a)).green, 0, 'and the ticket is spent again');
  });

  await check('leaving twice does not mint tickets', async () => {
    const a = await player();
    const { room } = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    const potBefore = (await getRoom(room.id))!.grossPool;
    await leaveRoom(room.id, a);
    const second = await leaveRoom(room.id, a);
    assert.equal(second.left, false, 'the second leave is a no-op');
    assert.equal((await getTickets(a)).green, 1, 'exactly one ticket back, not two');
    assert.equal((await getRoom(room.id))!.grossPool, 0, 'the only stake left once, so the pot is empty — not negative');
  });

  await check('a running match cannot be walked out of', async () => {
    const a = await player();
    const { room } = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    const r = (await getRoom(room.id))!;
    r.status = 'running';
    await saveRoom(r);
    await assert.rejects(() => leaveRoom(room.id, a),
      (e: any) => e instanceof LastSurvivorError && e.code === 'ROOM_STARTED');
    assert.ok(await getPlayer(room.id, a), 'and they stay in the match');
  });

  await check('a player who stopped answering the lobby is swept, with a refund', async () => {
    const a = await player();
    const b = await player();
    const j = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    await joinTopic({ id: b, username: 'b' }, TOPIC, 'green');
    const roomId = j.room.id;

    // a walked away ten minutes ago; b is looking at the screen right now.
    const stale = (await getPlayer(roomId, a))!;
    stale.lastSeenAt = Date.now() - 600_000;
    await savePlayer(stale);
    await touchPlayer(roomId, b);

    const gone = await sweepIdlePlayers(roomId, 45_000);
    assert.equal(gone, 1, 'only the one who left');
    assert.deepEqual((await listPlayers(roomId)).map((p) => p.userId), [b]);
    assert.equal((await getTickets(a)).green, 1, 'the swept player gets their ticket back too');
  });

  await check('a slow phone is not mistaken for someone who left', async () => {
    const a = await player();
    const { room } = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    const p = (await getPlayer(room.id, a))!;
    p.lastSeenAt = Date.now() - 20_000;          // inside the grace window
    await savePlayer(p);
    assert.equal(await sweepIdlePlayers(room.id, 45_000), 0);
    assert.ok(await getPlayer(room.id, a), 'still in the lobby');
  });

  await check('a room does not start on players who are no longer there', async () => {
    const a = await player();
    const b = await player();
    const j = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    await joinTopic({ id: b, username: 'b' }, TOPIC, 'green');
    const roomId = j.room.id;

    // Both stakes are in, the deadline has passed, and minUsers is 2 — but one
    // of the two walked away. Before the sweep this room would have started.
    const stale = (await getPlayer(roomId, a))!;
    stale.lastSeenAt = Date.now() - 600_000;
    await savePlayer(stale);
    await touchPlayer(roomId, b);
    const r = (await getRoom(roomId))!;
    r.startsAt = Date.now() - 1000;
    await saveRoom(r);

    await advanceRoom((await getRoom(roomId))!);
    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'waiting', 'one real player is below the floor — keep waiting');
    assert.deepEqual((await listPlayers(roomId)).map((p) => p.userId), [b]);
  });

  await check('the sweep leaves a running match alone', async () => {
    const a = await player();
    const { room } = await joinTopic({ id: a, username: 'a' }, TOPIC, 'green');
    const p = (await getPlayer(room.id, a))!;
    p.lastSeenAt = Date.now() - 600_000;
    await savePlayer(p);
    const r = (await getRoom(room.id))!;
    r.status = 'running';
    await saveRoom(r);
    /* Silence during a match means eliminated, not departed — the match rules
     * decide that, not this sweep. */
    assert.equal(await sweepIdlePlayers(room.id, 45_000), 0);
    assert.ok(await getPlayer(room.id, a));
  });

  console.log(`[lsLeave] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
