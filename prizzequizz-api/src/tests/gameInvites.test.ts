/* INVITING SOMEBODY TO PLAY.
 *
 * The rule that shapes the whole thing: «وقتی یک نفر هم در لیست من و هم در
 * لیست یه کاربر دیگه‌ای آنلاین هست، وقتی اولین درخواست از اون روم بهش رفت،
 * افراد دیگر روم نتونن بهش درخواست بدن — چون چند درخواست پشت سر هم به یک نفر
 * میره». So a pending invite is a CLAIM: while it stands, everyone else is
 * turned away, and the moment it is answered — or sixty seconds pass — the next
 * person may ask.
 *
 * And «فقط میتونی به افرادی که داخل هیچ مسابقه‌ای نشده‌اند بره»: somebody
 * already playing is not on offer at all.
 *
 * Run: npx tsx src/tests/gameInvites.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { createSession } from '../services/sessionService.js';
import { id } from '../utils/id.js';
import { _resetInvites, INVITE_TTL_MS, pendingFor, claimedAmong } from '../services/gameInviteService.js';
import { createMatchForPlayers, startMatch, _resetCurrentMatches } from '../services/matchEngine.js';

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

  try {
    _resetInvites(); _resetCurrentMatches();

    const alice = await player('Alice');
    const bob = await player('Bob');
    const carol = await player('Carol');
    const sa = createSession(alice), sb = createSession(bob), sc = createSession(carol);

    console.log('one invite, and what it does to everyone else:');

    await check('a duel invite carries the ticket the sender picked', async () => {
      const r = await call('POST', '/invites', sa.accessToken, { toUserId: bob, mode: 'duel', ticketTier: 'blue' });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.mode, 'duel');
      assert.equal(r.data.ticketTier, 'blue');
      assert.equal(r.data.status, 'pending');
      assert.ok(r.data.secondsLeft > 50 && r.data.secondsLeft <= 60, 'ttl ' + r.data.secondsLeft);
    });

    await check('and the person it was sent to can see it', async () => {
      const r = await call('GET', '/invites/incoming', sb.accessToken);
      assert.equal(r.data.invites.length, 1);
      assert.equal(r.data.invites[0].fromName, 'Alice');
      assert.equal(r.data.invites[0].ticketTier, 'blue');
    });

    /* THE POINT OF THE WHOLE FILE. */
    await check('nobody else may pile a second invite on top of it', async () => {
      const r = await call('POST', '/invites', sc.accessToken, { toUserId: bob, mode: 'duel', ticketTier: 'green' });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'ALREADY_INVITED');
      const inbox = await call('GET', '/invites/incoming', sb.accessToken);
      assert.equal(inbox.data.invites.length, 1, 'a second invite got through');
    });

    await check('but the sender re-sending gets their own invite back, not a refusal', async () => {
      const again = await call('POST', '/invites', sa.accessToken, { toUserId: bob, mode: 'duel', ticketTier: 'blue' });
      assert.equal(again.status, 201, JSON.stringify(again));
      const inbox = await call('GET', '/invites/incoming', sb.accessToken);
      assert.equal(inbox.data.invites.length, 1, 'a duplicate was created');
    });

    await check('a list of players says who is spoken for', async () => {
      const claimed = await claimedAmong([bob, carol]);
      assert.ok(claimed.has(bob), 'bob is not marked as claimed');
      assert.ok(!claimed.has(carol), 'carol is wrongly marked');
    });

    let inviteId = '';
    await check('answering it frees them for the next person at once', async () => {
      const inbox = await call('GET', '/invites/incoming', sb.accessToken);
      inviteId = inbox.data.invites[0].id;
      const r = await call('POST', `/invites/${inviteId}/respond`, sb.accessToken, { accept: false });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal(r.data.status, 'rejected');
      assert.equal(await pendingFor(bob), null, 'the claim outlived the answer');

      const now = await call('POST', '/invites', sc.accessToken, { toUserId: bob, mode: 'duel', ticketTier: 'green' });
      assert.equal(now.status, 201, 'carol still cannot invite: ' + JSON.stringify(now));
    });

    await check('and it cannot be answered twice', async () => {
      const r = await call('POST', `/invites/${inviteId}/respond`, sb.accessToken, { accept: true });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'ALREADY_ANSWERED');
    });

    await check('nor answered by somebody it was not sent to', async () => {
      const inbox = await call('GET', '/invites/incoming', sb.accessToken);
      const live = inbox.data.invites[0].id;
      const r = await call('POST', `/invites/${live}/respond`, sc.accessToken, { accept: true });
      assert.equal(r.status, 403, JSON.stringify(r));
    });

    console.log('\na claim that nobody answers:');
    await check('lapses on its own, so one silent phone cannot lock a player away', async () => {
      const held = await pendingFor(bob);
      assert.ok(held, 'no live invite to age');
      const afterTtl = Date.now() + INVITE_TTL_MS + 1000;
      assert.equal(await pendingFor(bob, afterTtl), null, 'the claim never lapses');
      const claimed = await claimedAmong([bob], afterTtl);
      assert.ok(!claimed.has(bob), 'still counted as spoken for');
    });

    console.log('\nsomebody who is already playing:');
    const dan = await player('Dan');
    const eve = await player('Eve');
    await check('cannot be invited at all', async () => {
      const m = await createMatchForPlayers(dan, eve, 'duel', 'free', 0);
      await startMatch(m.id);
      const r = await call('POST', '/invites', sa.accessToken, { toUserId: dan, mode: 'duel', ticketTier: 'green' });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'PLAYER_BUSY');
    });

    console.log('\nthe other two modes:');
    await check('a Last Survivor invite carries the room instead of a ticket', async () => {
      const fresh = await player('Fred');
      const r = await call('POST', '/invites', sa.accessToken, { toUserId: fresh, mode: 'ls', roomId: 'room-42', fromRoomId: 'room-42' });
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.equal(r.data.mode, 'ls');
      assert.equal(r.data.roomId, 'room-42');
    });

    await check('and an unknown mode is refused rather than guessed at', async () => {
      const fresh = await player('Gina');
      const r = await call('POST', '/invites', sa.accessToken, { toUserId: fresh, mode: 'chess' });
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.equal(r.code, 'BAD_MODE');
    });

    await check('and you cannot invite yourself', async () => {
      const r = await call('POST', '/invites', sa.accessToken, { toUserId: alice, mode: 'duel', ticketTier: 'green' });
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.equal(r.code, 'SELF_INVITE');
    });
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
}

await main();
