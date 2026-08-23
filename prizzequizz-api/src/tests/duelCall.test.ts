/* «حریفت ادامه داد.»
 *
 *   «اگه در دوئل بازیکنی باخت و برنده دکمه ادامه میدهم رو زد و ادامه داد، به
 *    بازنده اطلاع بده — البته نه پیام به صندوق اعلان، یه مودال بیاد و بنویسه
 *    حریفت ادامه داد میتونی با بلیط آبی حقتو ازش بگیری، و دو دکمه بیخیال و
 *    پیداش کن.»
 *
 * The chain used to happen entirely on the winner's device: they pressed
 * «ادامه میدهم», walked into the next stage at double the stake, and the person
 * they had just beaten was told nothing at all.
 *
 * What is guarded here is mostly the shape of the lie somebody could tell with
 * it — a call names a person and a tier, so it is exactly the sort of thing a
 * client would love to be able to send about a match it lost, to somebody it
 * never played. Every one of those is refused by reading the match instead of
 * the request.
 *
 * Run: npx tsx src/tests/duelCall.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { createSession } from '../services/sessionService.js';
import { id } from '../utils/id.js';
import {
  _resetDuelCalls, _ageCall, CALL_TTL_MS, isTier, pendingFor, callAfterWin, markSeen, pruneCalls
} from '../services/duelCallService.js';
import { createMatchForPlayers, forfeitMatch, _resetCurrentMatches } from '../services/matchEngine.js';

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
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
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

  /* A real duel that a real person really won: the loser walks out, which is
     the one ending that settles a match with a winner in a single call. */
  const finishedDuel = async (winner: string, loser: string) => {
    const m = await createMatchForPlayers(winner, loser, 'duel', 'paid');
    const done = await forfeitMatch(m.id, loser);
    assert.equal(String(done.winnerUserId), winner, 'the wrong player was recorded as the winner');
    return done.id;
  };

  try {
    _resetDuelCalls(); _resetCurrentMatches();

    const win = await player('برنده');
    const lose = await player('بازنده');
    const bystander = await player('رهگذر');
    const sw = createSession(win), sl = createSession(lose), sb = createSession(bystander);

    console.log('the winner presses «ادامه میدهم»:');

    let firstMatch = '';
    await check('the person they beat is told, and told which tier', async () => {
      firstMatch = await finishedDuel(win, lose);
      const r = await call('POST', '/duel-calls', sw.accessToken, { matchId: firstMatch, tier: 'blue', stage: 2 });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.called, true);
      assert.equal(r.data.call.tier, 'blue');
      assert.equal(r.data.call.stage, 2);
    });

    await check('and it is the winner who is named on it', async () => {
      const r = await call('GET', '/duel-calls', sl.accessToken);
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal(r.data.calls.length, 1, JSON.stringify(r.data.calls));
      assert.equal(r.data.calls[0].fromUserId, win);
      assert.equal(r.data.calls[0].fromName, 'برنده');
      assert.equal(r.data.calls[0].matchId, firstMatch);
    });

    await check('the call is short-lived, and says how long it has left', async () => {
      const r = await call('GET', '/duel-calls', sl.accessToken);
      const left = r.data.calls[0].secondsLeft;
      assert.ok(left > 0, 'a call with no time left is not news');
      assert.ok(left <= CALL_TTL_MS / 1000, 'lived longer than the window: ' + left);
    });

    /* THE WINNER IS NOT TOLD ANYTHING. They are the one who walked on. */
    await check('the winner has nothing waiting for them', async () => {
      const r = await call('GET', '/duel-calls', sw.accessToken);
      assert.deepEqual(r.data.calls, []);
    });

    await check('nor does anybody who was not in the match', async () => {
      const r = await call('GET', '/duel-calls', sb.accessToken);
      assert.deepEqual(r.data.calls, []);
    });

    console.log('\nshown once, and only once:');

    await check('after it has been shown it stops coming back', async () => {
      const before = await call('GET', '/duel-calls', sl.accessToken);
      const cid = before.data.calls[0].id;
      const seen = await call('POST', '/duel-calls/' + cid + '/seen', sl.accessToken, {});
      assert.equal(seen.data.seen, true);
      const after = await call('GET', '/duel-calls', sl.accessToken);
      assert.deepEqual(after.data.calls, [], 'the same modal would open again on the next poll');
    });

    await check('marking it seen a second time changes nothing', async () => {
      const c = await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'برنده', tier: 'blue', matchId: 'm-twice', stage: 2 });
      assert.equal(await markSeen(c.id, lose), true);
      assert.equal(await markSeen(c.id, lose), false);
    });

    await check('and somebody else cannot mark my call read', async () => {
      const c = await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'برنده', tier: 'blue', matchId: 'm-other', stage: 2 });
      assert.equal(await markSeen(c.id, bystander), false, 'a stranger silenced a call meant for somebody else');
      assert.equal((await pendingFor(lose)).some((x) => x.id === c.id), true);
    });

    await check('pressing «ادامه میدهم» twice is one knock, not two', async () => {
      const a = await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'برنده', tier: 'red', matchId: 'm-dbl', stage: 3 });
      const b = await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'برنده', tier: 'red', matchId: 'm-dbl', stage: 3 });
      assert.equal(a.id, b.id, 'a second press opened a second modal');
    });

    console.log('\nwhat a client is not allowed to say:');

    await check('the loser cannot send the call about their own defeat', async () => {
      const mid = await finishedDuel(win, lose);
      const r = await call('POST', '/duel-calls', sl.accessToken, { matchId: mid, tier: 'blue', stage: 2 });
      assert.equal(r.status, 403, JSON.stringify(r));
      assert.equal(r.code, 'NOT_THE_WINNER');
    });

    await check('a bystander cannot send it about a match they were not in', async () => {
      const mid = await finishedDuel(win, lose);
      const r = await call('POST', '/duel-calls', sb.accessToken, { matchId: mid, tier: 'blue', stage: 2 });
      assert.equal(r.status, 403, JSON.stringify(r));
    });

    await check('a match still being played is not something to be told about', async () => {
      const m = await createMatchForPlayers(win, lose, 'duel', 'paid');
      const r = await call('POST', '/duel-calls', sw.accessToken, { matchId: m.id, tier: 'blue', stage: 2 });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'MATCH_NOT_FINISHED');
    });

    await check('a match that does not exist is refused', async () => {
      const r = await call('POST', '/duel-calls', sw.accessToken, { matchId: 'no-such-match', tier: 'blue', stage: 2 });
      assert.equal(r.status, 404, JSON.stringify(r));
    });

    await check('no match id at all is refused', async () => {
      const r = await call('POST', '/duel-calls', sw.accessToken, { tier: 'blue', stage: 2 });
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.equal(r.code, 'BAD_MATCH');
    });

    /* «میتونی با بلیط آبی حقتو ازش بگیری» is the whole message. A call that
       cannot name a real ticket has nothing to offer, so it is not sent —
       which is also what happens above red, where the ladder reaches 100,000
       and no ticket is sold at 100,000. */
    await check('a tier that is not a ticket is refused', async () => {
      const mid = await finishedDuel(win, lose);
      const r = await call('POST', '/duel-calls', sw.accessToken, { matchId: mid, tier: 'purple', stage: 2 });
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.equal(r.code, 'BAD_TIER');
    });

    await check('and so is a call with no tier on it', async () => {
      const mid = await finishedDuel(win, lose);
      const r = await call('POST', '/duel-calls', sw.accessToken, { matchId: mid, stage: 2 });
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.equal(r.code, 'BAD_TIER');
    });

    await check('the three real tiers are the three that pass', () => {
      assert.equal(isTier('green'), true);
      assert.equal(isTier('blue'), true);
      assert.equal(isTier('red'), true);
      assert.equal(isTier('gold'), false, 'a league ticket is not a duel tier');
      assert.equal(isTier(''), false);
    });

    await check('a signed-out caller is told nothing at all', async () => {
      const res = await fetch(base + '/duel-calls');
      assert.equal(res.status, 401);
    });

    console.log('\nwhen it stops being true:');

    await check('a call whose time is up is not delivered', async () => {
      _resetDuelCalls();
      const c = await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'برنده', tier: 'blue', matchId: 'm-old', stage: 2 });
      assert.equal((await pendingFor(lose)).length, 1);
      /* Wound back past its window, as a call left lying while somebody was
         mid-match would be by the time they looked. */
      assert.equal(_ageCall(c.id, CALL_TTL_MS + 1000), true);
      assert.deepEqual(await pendingFor(lose), [], 'an expired call sends the player to an empty queue');
    });

    await check('and is eventually swept up', async () => {
      const n = await pruneCalls();
      assert.equal(n, 1, 'the expired call was left in the table: ' + n);
      assert.deepEqual(await pendingFor(lose), []);
    });

    await check('but a call still inside its window is not swept up', async () => {
      _resetDuelCalls();
      await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'برنده', tier: 'blue', matchId: 'm-live', stage: 2 });
      assert.equal(await pruneCalls(), 0, 'a live call was thrown away');
      assert.equal((await pendingFor(lose)).length, 1);
    });

    /* THE STAGE IS CLAMPED. The chain runs 2..10 and the number is shown to a
       person, so a client cannot write anything it likes into it. */
    await check('the stage cannot be talked out of its range', async () => {
      _resetDuelCalls();
      const hi = await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'x', tier: 'blue', matchId: 'm-hi', stage: 9999 });
      const lo = await callAfterWin({ toUserId: lose, fromUserId: win, fromName: 'x', tier: 'blue', matchId: 'm-lo', stage: -4 });
      assert.equal(hi.stage, 10);
      assert.equal(lo.stage, 2);
    });
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
