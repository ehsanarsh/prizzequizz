/* «نه» HAS TO MEAN SOMETHING FOR A WHILE.
 *
 * «وقتی کسی دعوت تو را رد کرد دیگه نتونی بهش دعوت بفرستی — کاربر نتونه تند تند
 *  دعوت بفرسته و کلافه کنه کاربر دیگه رو.»
 *
 * A pending invite already claimed the person it was sent to, so nobody could
 * send a second one WHILE one was waiting. The gap was the moment after:
 * refused at second five, invited again at second six, for as long as the
 * sender felt like it. From the other side that is the same person asking over
 * and over, and «رد کردن» achieving nothing.
 *
 * It escalates rather than being one flat wall, because the same word means
 * different things depending on how often it has been said. One «no» is usually
 * «not this minute» — coming back in ten is not harassment. A third «no» in one
 * day is somebody who has already answered and is still being asked.
 *
 * Run: npx tsx src/tests/inviteCooldown.test.ts
 *      DATABASE_URL=… npx tsx src/tests/inviteCooldown.test.ts   (+ the table)
 */
import assert from 'node:assert/strict';
import {
  createInvite, respond, rejectionHold, rejectStep, cooledAmong,
  REJECT_STEPS_MS, REJECT_MEMORY_MS, _resetInvites, INVITE_TTL_MS
} from '../services/gameInviteService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* The in-memory store, so the clock can be moved by hand: waiting ten real
   minutes to find out what happens after ten minutes is not a test. */
delete process.env.DATABASE_URL;

const MIN = 60_000;
let seq = 0;
async function refuse(from: string, to: string, at: number): Promise<void> {
  const inv = await createInvite({ fromUserId: from, fromName: 'A', toUserId: to, mode: 'duel', ticketTier: 'green', coinStake: 0, roomId: '', roomTopic: '', fromRoomId: '' }, at);
  await respond(inv.id, to, false, at + 1000);
  seq++;
}

(async () => {
  await check('one refusal buys ten minutes of quiet', async () => {
    _resetInvites();
    const t0 = 1_000_000_000;
    await refuse('a', 'b', t0);
    const just = await rejectionHold('a', 'b', t0 + 2000);
    assert.equal(just.held, true, 'the sender could invite again straight away');
    assert.equal(just.count, 1);
    /* Nine minutes in: still no. Eleven: the door is open again — one «no» is
       «not this minute», not a ban. */
    assert.equal((await rejectionHold('a', 'b', t0 + 9 * MIN)).held, true);
    assert.equal((await rejectionHold('a', 'b', t0 + 11 * MIN)).held, false);
  });

  await check('and it says when, not just no', async () => {
    /* The sender is shown this. «بعداً» is not an answer anybody can act on. */
    _resetInvites();
    const t0 = 1_000_000_000;
    await refuse('a', 'b', t0);
    const h = await rejectionHold('a', 'b', t0 + 2000);
    assert.ok(h.untilMs > t0, 'no time was given at all');
    assert.ok(h.untilMs - t0 <= 11 * MIN, 'the first wait is longer than the first step');
  });

  await check('a second refusal is a longer quiet than the first', async () => {
    _resetInvites();
    const t0 = 1_000_000_000;
    await refuse('a', 'b', t0);
    await refuse('a', 'b', t0 + 20 * MIN);           // after the first hold lapsed
    const h = await rejectionHold('a', 'b', t0 + 21 * MIN);
    assert.equal(h.count, 2);
    /* Eleven minutes was enough last time and is not enough now. */
    assert.equal((await rejectionHold('a', 'b', t0 + 31 * MIN)).held, true);
    assert.equal((await rejectionHold('a', 'b', t0 + 82 * MIN)).held, false);
  });

  await check('a third is a day', async () => {
    _resetInvites();
    const t0 = 1_000_000_000;
    await refuse('a', 'b', t0);
    await refuse('a', 'b', t0 + 20 * MIN);
    await refuse('a', 'b', t0 + 130 * MIN);
    const h = await rejectionHold('a', 'b', t0 + 131 * MIN);
    assert.equal(h.count, 3);
    assert.equal((await rejectionHold('a', 'b', t0 + 10 * 60 * MIN)).held, true, 'ten hours later, still being asked');
    assert.equal((await rejectionHold('a', 'b', t0 + 130 * MIN + 25 * 60 * MIN)).held, false, 'a day is a day, not for ever');
  });

  await check('the steps only ever get longer, never shorter', async () => {
    /* Stated on its own because it is the property the whole shape rests on,
       and it is one mis-ordered array away from being false. */
    for (let i = 1; i < REJECT_STEPS_MS.length; i++) {
      assert.ok(rejectStep(i + 1) > rejectStep(i), 'step ' + (i + 1) + ' is not longer than ' + i);
    }
    assert.equal(rejectStep(0), 0, 'somebody who has never refused is not on a hold');
    /* Beyond the last step it stays at the last step rather than growing for
       ever — a permanent ban is what blocking is for, and that is the player's
       decision to make, not a side effect of saying no four times. */
    assert.equal(rejectStep(9), rejectStep(REJECT_STEPS_MS.length));
  });

  await check('old refusals are forgiven', async () => {
    _resetInvites();
    const t0 = 1_000_000_000;
    await refuse('a', 'b', t0);
    await refuse('a', 'b', t0 + 20 * MIN);
    /* Two «no»s last month must not make today's first invitation the third
       strike. Somebody who was busy in March is not somebody to be shut out in
       April. */
    /* Measured from the LAST of them — the window is «in the past day», so the
       second refusal is still inside it until a day after IT happened, not a
       day after the first. */
    const later = t0 + 20 * MIN + REJECT_MEMORY_MS + MIN;
    const h = await rejectionHold('a', 'b', later);
    assert.equal(h.count, 0, 'refusals from more than a day ago still counted');
    assert.equal(h.held, false);
    /* And halfway there, the older one has already dropped out while the newer
       one has not: forgiveness is per refusal, not all at once. */
    const half = t0 + REJECT_MEMORY_MS + 10 * MIN;
    assert.equal((await rejectionHold('a', 'b', half)).count, 1, 'they expired together');
  });

  await check('accepting is not refusing', async () => {
    _resetInvites();
    const t0 = 1_000_000_000;
    const inv = await createInvite({ fromUserId: 'a', fromName: 'A', toUserId: 'b', mode: 'duel', ticketTier: 'green', coinStake: 0, roomId: '', roomTopic: '', fromRoomId: '' }, t0);
    await respond(inv.id, 'b', true, t0 + 1000);
    assert.equal((await rejectionHold('a', 'b', t0 + 2000)).held, false, 'a yes started a cooldown');
  });

  await check('and an invitation nobody answered is not a refusal either', async () => {
    /* Letting it lapse is «I did not see it» far more often than «no» — a
       phone in a pocket for sixty seconds would otherwise lock the sender out.
       The claim already stopped a second invite while it was live. */
    _resetInvites();
    const t0 = 1_000_000_000;
    await createInvite({ fromUserId: 'a', fromName: 'A', toUserId: 'b', mode: 'duel', ticketTier: 'green', coinStake: 0, roomId: '', roomTopic: '', fromRoomId: '' }, t0);
    const after = t0 + INVITE_TTL_MS + 1000;
    assert.equal((await rejectionHold('a', 'b', after)).held, false);
  });

  await check('a refusal is about these two people and nobody else', async () => {
    _resetInvites();
    const t0 = 1_000_000_000;
    await refuse('a', 'b', t0);
    /* Somebody else may still invite b — being asked by one person is not a
       reason to be cut off from everyone. */
    assert.equal((await rejectionHold('c', 'b', t0 + 2000)).held, false, 'b was closed to everyone');
    /* And a's refusal by b says nothing about a inviting d. */
    assert.equal((await rejectionHold('a', 'd', t0 + 2000)).held, false, 'a was stopped from inviting anybody');
    /* Nor does it work backwards: b may still invite a. Refusing a game is not
       the same as not wanting one. */
    assert.equal((await rejectionHold('b', 'a', t0 + 2000)).held, false, 'the refusal locked the refuser out too');
  });

  await check('the online list is asked about everybody at once', async () => {
    _resetInvites();
    const t0 = 1_000_000_000;
    await refuse('a', 'b', t0);
    await refuse('a', 'c', t0);
    const cooled = await cooledAmong('a', ['b', 'c', 'd'], t0 + 2000);
    assert.deepEqual([...cooled].sort(), ['b', 'c']);
    assert.equal(cooled.has('d'), false, 'somebody who never refused was hidden');
    const later = await cooledAmong('a', ['b', 'c', 'd'], t0 + 11 * MIN);
    assert.equal(later.size, 0, 'the list never opens back up');
  });

  console.log(`[inviteCooldown] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
