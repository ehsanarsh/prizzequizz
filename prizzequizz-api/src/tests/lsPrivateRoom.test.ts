/* A ROOM OF YOUR OWN, AND THE PEOPLE YOU ASK INTO IT.
 *
 * «اگه آخرین بازمانده رو انتخاب کردی بتونی روم اختصاصی داشته باشی و بتونی
 *  دوستانت رو به بازی دعوت کنی.»
 *
 * Two things have to be true at once, and they pull in opposite directions:
 *   • nobody who was not asked can get in — not by matchmaking, not by knowing
 *     the room's id;
 *   • the friends who WERE asked land in that exact room and not in whatever
 *     public room happens to be open for the same topic, which is the entire
 *     point of an invite.
 *
 * And a third that is quieter but costs real money: being turned away at the
 * door must not spend a ticket.
 *
 * Run: npx tsx src/tests/lsPrivateRoom.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { createSession } from '../services/sessionService.js';
import { id } from '../utils/id.js';
import { _resetInvites } from '../services/gameInviteService.js';
import { _resetCurrentMatches } from '../services/matchEngine.js';
import { getRoom, listPlayers, getPlayer, saveRoom, removePlayer } from '../services/lastSurvivorService.js';
import { updateConfig } from '../services/lastSurvivorConfig.js';
import { tick } from '../services/lastSurvivorWorker.js';
import { getTickets, grantTickets } from '../services/ticketService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

async function player(name: string): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'n_' + userId.slice(0, 6),
    displayName: name, plan: 'premium', level: 3, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: {}
  } as any);
  /* Through the real ticket service, not by writing the field: on Postgres the
     tickets do not live on the user row, so seeding them there gives a player
     who looks stocked and cannot buy anything. */
  for (const tier of ['green', 'blue', 'red']) await grantTickets(userId, tier, 5);
  return userId;
}

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}/v1`;

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const parsed = await res.json().catch(() => null) as any;
    return { status: res.status, ok: parsed?.ok === true, data: parsed?.data, code: parsed?.error?.code ?? '' };
  };

  try {
    _resetInvites(); _resetCurrentMatches();

    /* A topic the game can really play: enabled, with approved questions
       behind it. A room for a topic with nothing in it is not a room. */
    const TOPIC = 'اطلاعات عمومی';
    /* A second real topic, so «the wrong topic» can be tested with one the game
       would happily play — otherwise the request is turned away for being an
       unknown topic and the room's own check is never reached. */
    const OTHER = 'ورزشی';
    await updateConfig({ room: { capacity: 3, minUsers: 2, waitSeconds: 60, manualStartEnabled: true, startPct: 70 },
                         topics: { [TOPIC]: { enabled: true }, [OTHER]: { enabled: true } } } as any);
    for (const cat of [TOPIC, OTHER]) {
      for (let i = 0; i < 6; i++) {
        await repositories.questions.save({ id: id(), category: cat, difficulty: 'easy', text: 'سوال ' + i,
          options: ['درست', 'غلط', 'گزینه۳', 'گزینه۴'], correctIndex: 0, tags: [], status: 'approved', version: 1 } as any);
      }
    }

    const owner = await player('Owner');
    const so = createSession(owner);
    const friend = await player('Friend');
    const stranger = await player('Stranger');
    const sf = createSession(friend), ss = createSession(stranger);

    console.log('opening a room of your own:');
    let roomId = '';

    await check('a player can open a private room for a topic', async () => {
      const r = await call('POST', '/last-survivor/rooms', so.accessToken, { topic: TOPIC });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.ok(r.data.roomId, 'no room id came back');
      assert.equal(r.data.isPrivate, true);
      assert.equal(r.data.topic, TOPIC);
      roomId = r.data.roomId;
    });

    await check('nothing is charged for opening it', async () => {
      const t = await getTickets(owner);
      assert.equal(t.green, 5, 'a ticket went missing just for making a room');
    });

    /* THE ROOM HAS TO SURVIVE THE SECOND AFTER IT IS MADE.
     *
     * The worker sweeps every active room once a second and closes any waiting
     * room with nobody in it. A private room is created empty on purpose — the
     * owner is still choosing a ticket — so without an exception for it the
     * room was gone before its owner could reach the door, and they were told
     * «مسابقهٔ این اتاق شروع شده» at their own room. Ticking the worker here is
     * what makes this test see the world the server actually runs in. */
    await check('the worker does not sweep it away before the owner arrives', async () => {
      for (let i = 0; i < 3; i++) await tick(Date.now());
      const room = await getRoom(roomId);
      assert.ok(room, 'the room was deleted outright');
      assert.equal(room!.status, 'waiting', 'the room was closed while its owner was picking a ticket');
    });

    await check('and the owner can still walk in after it', async () => {
      const r = await call('POST', '/last-survivor/join', so.accessToken, { topic: TOPIC, color: 'blue', roomId });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.room.id, roomId);
      /* Put it back the way the rest of this file expects: the owner pays with
         a green ticket a few checks below. */
      await call('POST', `/last-survivor/rooms/${roomId}/leave`, so.accessToken, {});
    });

    await check('but an empty one does not linger for ever', async () => {
      /* A room of its OWN, never joined and never left: leaving a room closes
         it on the way out, so testing this on a room somebody walked out of
         would pass whether the worker did its job or not. */
      const drifter = await player('Drifter');
      const sd = createSession(drifter);
      const made = await call('POST', '/last-survivor/rooms', sd.accessToken, { topic: TOPIC });
      assert.equal(made.status, 201, JSON.stringify(made));
      const lone = await getRoom(made.data.roomId);
      assert.equal(lone!.status, 'waiting', 'it was not open to begin with');
      await tick(lone!.startsAt + 1000);
      const after = await getRoom(made.data.roomId);
      assert.equal(after!.status, 'finished', 'a room nobody ever came to stayed open for ever');
    });

    await check('while an ordinary empty room is still closed on the spot', async () => {
      /* The grace is for private rooms only. An ordinary room that empties has
         to go at once, whatever its deadline says: the reason the rule exists
         is that matchmaking would otherwise hand the next player a room with
         somebody else's countdown already running. */
      const passer = await player('Passer');
      const sp = createSession(passer);
      const j = await call('POST', '/last-survivor/join', sp.accessToken, { topic: OTHER, color: 'green' });
      assert.equal(j.status, 201, JSON.stringify(j));
      const rid = j.data.room.id;
      assert.equal((await getRoom(rid))!.isPrivate, false, 'that was not a public room');
      /* Emptied WITHOUT going out through leaveRoom, which closes a room behind
         the last person out — otherwise this would pass without the worker. */
      await removePlayer(rid, passer);
      await tick(Date.now());
      assert.equal((await getRoom(rid))!.status, 'finished',
        'a public room with nobody in it was kept until its deadline');
    });

    await check('and the owner’s own room is back to being empty and open', async () => {
      /* The owner joined and left a moment ago, which closes a room behind the
         last person out — so the rest of this file needs a fresh one. */
      const again = await call('POST', '/last-survivor/rooms', so.accessToken, { topic: TOPIC });
      assert.equal(again.status, 201, JSON.stringify(again));
      roomId = again.data.roomId;
      const room = await getRoom(roomId);
      assert.equal(room!.status, 'waiting');
      assert.equal(room!.isPrivate, true);
    });

    await check('tapping twice does not leave two rooms open', async () => {
      const r = await call('POST', '/last-survivor/rooms', so.accessToken, { topic: TOPIC });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.roomId, roomId, 'a second room was opened behind the first');
    });

    console.log('who can get in:');

    await check('a stranger looking for this topic is NOT put in it', async () => {
      const r = await call('POST', '/last-survivor/join', ss.accessToken, { topic: TOPIC, color: 'green' });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.notEqual(r.data.room.id, roomId, 'matchmaking walked a stranger into a private room');
    });

    await check('nor even when they know the room’s id', async () => {
      const other = await player('Nosey');
      const sn = createSession(other);
      const r = await call('POST', '/last-survivor/join', sn.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(r.status, 403, JSON.stringify(r));
      assert.equal(r.code, 'ROOM_PRIVATE');
      const t = await getTickets(other);
      assert.equal(t.green, 5, 'being turned away at the door cost them a ticket');
    });

    await check('the owner can walk into their own room', async () => {
      const r = await call('POST', '/last-survivor/join', so.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.room.id, roomId, 'the owner was sent somewhere else');
      const t = await getTickets(owner);
      assert.equal(t.green, 4, 'the owner played for free');
    });

    console.log('asking a friend in:');
    let inviteId = '';

    await check('the invite carries the room and its topic', async () => {
      const r = await call('POST', '/invites', so.accessToken,
        { toUserId: friend, mode: 'ls', roomId, fromRoomId: roomId });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.roomId, roomId);
      assert.equal(r.data.roomTopic, TOPIC, 'the invitee would have to guess the topic');
      inviteId = r.data.id;
    });

    await check('until they accept, they still cannot get in', async () => {
      const r = await call('POST', '/last-survivor/join', sf.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(r.status, 403, JSON.stringify(r));
      const t = await getTickets(friend);
      assert.equal(t.green, 5, 'the refusal cost them a ticket');
    });

    await check('once they say yes, they land in that exact room', async () => {
      const a = await call('POST', `/invites/${inviteId}/respond`, sf.accessToken, { accept: true });
      assert.equal(a.status, 200, JSON.stringify(a));
      const r = await call('POST', '/last-survivor/join', sf.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.room.id, roomId, 'they paid and were put in a different room');
    });

    await check('and the two of them are in it together', async () => {
      const ps = await listPlayers(roomId);
      const ids = ps.map((p) => p.userId).sort();
      assert.deepEqual(ids, [owner, friend].sort(), 'the room does not hold exactly the two of them');
    });

    await check('both tickets are in the same pot', async () => {
      const room = await getRoom(roomId);
      assert.ok((room?.grossPool ?? 0) > 0, 'the pot is empty');
      const one = await call('POST', '/last-survivor/rooms', so.accessToken, { topic: TOPIC });
      assert.equal(one.data.roomId, roomId, 'the owner’s room changed under them');
    });

    console.log('the ordinary rules still apply:');

    await check('an invite that was answered is not a key to a second room', async () => {
      const room2 = await call('POST', '/last-survivor/rooms', createSession(stranger).accessToken, { topic: TOPIC });
      assert.equal(room2.status, 201, JSON.stringify(room2));
      const r = await call('POST', '/last-survivor/join', sf.accessToken,
        { topic: TOPIC, color: 'blue', roomId: room2.data.roomId });
      assert.equal(r.status, 403, 'one invite opened somebody else’s room too: ' + JSON.stringify(r));
    });

    await check('a room asked for by the wrong topic is refused, not silently swapped', async () => {
      /* A topic the game really plays, so this is the ROOM's check being made
         and not the topic list turning away a name it does not know. */
      const r = await call('POST', '/last-survivor/join', sf.accessToken,
        { topic: OTHER, color: 'green', roomId });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'ROOM_TOPIC');
      const t = await getTickets(friend);
      assert.equal(t.green, 4, 'the refusal cost another ticket');
    });

    await check('somebody else’s invitation is not my key to that room', async () => {
      /* The friend was asked into this room and is inside it. That must not let
         a bystander in on the strength of an invite that was never theirs. */
      const bystander = await player('Bystander');
      const sb2 = createSession(bystander);
      const r = await call('POST', '/last-survivor/join', sb2.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(r.status, 403, JSON.stringify(r));
      assert.equal((await getTickets(bystander)).green, 5, 'and it cost them a ticket too');
    });

    await check('a room with no space left turns the next one away', async () => {
      /* Capacity is three. The owner and the friend are in; one more fills it,
         and the fourth must be told so rather than charged. */
      const third = await player('Third'), fourth = await player('Fourth');
      const s3 = createSession(third), s4 = createSession(fourth);
      for (const [uid, sess] of [[third, s3], [fourth, s4]] as const) {
        const iv = await call('POST', '/invites', so.accessToken, { toUserId: uid, mode: 'ls', roomId });
        assert.equal(iv.status, 201, 'could not invite: ' + JSON.stringify(iv));
        await call('POST', `/invites/${iv.data.id}/respond`, sess.accessToken, { accept: true });
      }
      const fills = await call('POST', '/last-survivor/join', s3.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(fills.status, 201, 'the third player could not fill the room: ' + JSON.stringify(fills));
      const over = await call('POST', '/last-survivor/join', s4.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(over.status, 409, JSON.stringify(over));
      assert.equal(over.code, 'ROOM_FULL');
      assert.equal((await getTickets(fourth)).green, 5, 'a full room still took their ticket');
    });

    await check('once the match starts, nobody else walks in', async () => {
      const room = await getRoom(roomId);
      assert.ok(room, 'the room vanished');
      room!.status = 'running'; room!.phase = 'dashboard'; room!.startedAt = Date.now();
      await saveRoom(room!);
      const late = await player('Late');
      const sl = createSession(late);
      const inv = await call('POST', '/invites', so.accessToken, { toUserId: late, mode: 'ls', roomId });
      await call('POST', `/invites/${inv.data.id}/respond`, sl.accessToken, { accept: true });
      const r = await call('POST', '/last-survivor/join', sl.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'ROOM_STARTED');
      const t = await getTickets(late);
      assert.equal(t.green, 5, 'a locked door still took their ticket');
    });

    /* THE PHRASES SENT FROM INSIDE A MATCH.
     *
     * Chat was refused the moment a room stopped waiting — «چت فقط در اتاق
     * انتظار باز است» — so every ready-made phrase sent during a match was
     * thrown away by the server. The sender saw their own bubble, drawn on
     * their own phone, and nobody else ever saw anything. */
    console.log('talking during the match:');

    await check('a phrase sent while the match is running is kept', async () => {
      const room = await getRoom(roomId);
      room!.status = 'running'; room!.phase = 'dashboard'; room!.startedAt = Date.now();
      await saveRoom(room!);
      const r = await call('POST', `/last-survivor/rooms/${roomId}/chat`, so.accessToken, { body: 'موفق باشی' });
      assert.equal(r.status, 201, JSON.stringify(r));
    });

    await check('and everybody in the room can read it', async () => {
      const r = await call('GET', `/last-survivor/rooms/${roomId}/chat`, sf.accessToken);
      assert.equal(r.status, 200, JSON.stringify(r));
      const bodies = (r.data.messages || []).map((m: any) => m.body);
      assert.ok(bodies.includes('موفق باشی'), 'the message never reached the room: ' + JSON.stringify(bodies));
    });

    await check('a finished room is closed for good', async () => {
      const room = await getRoom(roomId);
      room!.status = 'finished'; room!.phase = 'finished'; room!.endedAt = Date.now();
      await saveRoom(room!);
      const r = await call('POST', `/last-survivor/rooms/${roomId}/chat`, so.accessToken, { body: 'کسی هست؟' });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'CHAT_CLOSED');
    });

    await check('a player already in the room is not charged twice', async () => {
      const room = await getRoom(roomId);
      room!.status = 'waiting'; room!.phase = 'waiting'; room!.startedAt = null;
      await saveRoom(room!);
      const before = (await getTickets(friend)).green;
      const r = await call('POST', '/last-survivor/join', sf.accessToken, { topic: TOPIC, color: 'green', roomId });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal((await getTickets(friend)).green, before, 'walking back in cost another ticket');
      assert.ok(await getPlayer(roomId, friend), 'they fell out of the room');
    });

  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
