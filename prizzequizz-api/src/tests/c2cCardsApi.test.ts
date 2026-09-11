/* THE DESTINATION CARDS, OVER HTTP.
 *
 * These rows decide where players' money is sent. Three things about that are
 * worth a test of their own:
 *
 *   - the endpoint is behind its own permission, not merely "some admin"
 *   - a mistyped card number is refused by the API, not only by the service
 *     that happens to be called today
 *   - a card that already has payments against it cannot be deleted, because
 *     deleting it orphans them. Turning it off is the way to stop using one.
 *
 * Run: npx tsx src/tests/c2cCardsApi.test.ts
 */
/* The API's background workers (matchmaking, Last Survivor, leagues, the
 * monitor collector) are started by createApiServer and keep their timers
 * running after server.close() — so a test that boots the server can finish
 * its assertions and then simply never exit. Turned off here, before the
 * server is created, because this file is about routes and not about them. */
process.env.MATCHMAKING_WORKER = 'false';
process.env.LAST_SURVIVOR_WORKER = 'false';
process.env.LEAGUE_WORKER = 'false';
process.env.SERVER_MONITOR = 'false';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../app.js';
import { isValidPan, listCards, removeCard } from '../services/c2c/cardService.js';
import { tryInsertSession, listSessions } from '../services/c2c/sessionStore.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';
import { resetC2c } from './c2cTestReset.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

function makePan(): string {
  const body = ('627412' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0')).slice(0, 15);
  for (let d = 0; d <= 9; d++) if (isValidPan(body + d)) return body + d;
  throw new Error('no check digit');
}

async function run(): Promise<void> {
  await resetC2c();

  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  const call = (method: string, path: string, body?: unknown, admin = true) =>
    fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(admin ? { 'x-admin-key': process.env.ADMIN_KEY || 'dev-admin' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  try {
    await check('no admin key at all gets nowhere', async () => {
      const res = await call('GET', '/admin/c2c/cards', undefined, false);
      assert.equal(res.status, 403);
    });

    await check('and neither does an admin without THIS tab', async () => {
      /* The real question is not "is this an admin" — it is whether this admin
       * may edit where players' money is sent. An account with every other
       * permission must still be turned away. */
      const { createAccount, deleteAccount } = await import('../services/adminAccountService.js');
      const acc = await createAccount({
        username: 'c2cnope' + Math.floor(Math.random() * 1e6),
        password: 'x'.repeat(12),
        perms: ['users', 'matches', 'payments']
      });
      const res = await fetch(`http://127.0.0.1:${port}/v1/admin/c2c/cards`, {
        headers: { 'x-admin-key': acc.token }
      });
      assert.equal(res.status, 403, 'a payments admin is not automatically a destination-cards admin');
      const body = await res.json() as any;
      assert.equal(body?.error?.code, 'TAB_FORBIDDEN');
      await deleteAccount(acc.id);
    });

    await check('a mistyped card number is refused by the API too', async () => {
      const good = makePan();
      const bad = good.slice(0, 5) + String((Number(good[5]) + 1) % 10) + good.slice(6);
      const res = await call('POST', '/admin/c2c/cards', { pan: bad, accountNo: '49302749612' });
      assert.equal(res.status, 422);
      const body = await res.json() as any;
      assert.equal(body?.error?.code, 'CARD_PAN_INVALID');
    });

    await check('and a card with no account number is refused', async () => {
      const res = await call('POST', '/admin/c2c/cards', { pan: makePan(), accountNo: '' });
      const body = await res.json() as any;
      assert.equal(body?.error?.code, 'CARD_ACCOUNT_REQUIRED',
        'every bank sample prints the account, so a card without one can never match its own SMS');
    });

    let cardId = '';
    await check('a good card is stored, masked in the list and whole in the row', async () => {
      const pan = makePan();
      const res = await call('POST', '/admin/c2c/cards', {
        pan, accountNo: '49302749612', bankName: 'بانک سپه', bankKey: 'sepah',
        holderName: 'مهدی', status: 'ACTIVE', priority: 5, minAmountToman: 50_000
      });
      assert.equal(res.status, 201);
      const body = (await res.json() as any).data;
      cardId = body.id;
      assert.equal(body.pan, pan, 'the edit form needs the real number');
      assert.equal(body.panMasked, '**** **** **** ' + pan.slice(-4), 'the list does not');
      assert.equal(body.openSessions, 0);
      assert.equal(body.capLeftRial, null, 'no cap set means no cap left to report');
    });

    await check('it comes back in the list', async () => {
      const rows = ((await (await call('GET', '/admin/c2c/cards')).json()) as any).data.rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].bankKey, 'sepah');
    });

    await check('a card that has taken payments cannot be deleted', async () => {
      const uid = id();
      await repositories.users.save({
        id: uid, username: 'cd' + uid.slice(0, 6), displayName: 'cd',
        phone: '09' + String(700000000 + Math.floor(Math.random() * 99999999)),
        wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
        tickets: { green: 0, blue: 0, red: 0 }
      } as any);
      const now = Date.now();
      const s = await tryInsertSession({
        userId: uid, cardId, baseAmountToman: 60_000, amountRial: 600_042, suffixRial: 42,
        expiresAt: new Date(now + 60_000).toISOString(), reservedUntil: new Date(now + 3_600_000).toISOString()
      });
      assert.ok(s, 'the session must exist for this to mean anything');
      const res = await call('DELETE', `/admin/c2c/cards/${cardId}`);
      assert.equal(res.status, 409);
      const body = await res.json() as any;
      assert.equal(body?.error?.code, 'CARD_IN_USE');
      assert.match(body?.error?.message, /غیرفعال/, 'and it says what to do instead');
      assert.equal((await listCards()).length, 1, 'the card is still there');
    });

    await check('an unused card can be deleted', async () => {
      const res = await call('POST', '/admin/c2c/cards', { pan: makePan(), accountNo: '999', status: 'INACTIVE' });
      const fresh = (await res.json() as any).data;
      const del = await call('DELETE', `/admin/c2c/cards/${fresh.id}`);
      assert.equal(del.status, 200);
      assert.equal((await listSessions({ cardId: fresh.id, limit: 1 })).length, 0);
    });

    await check('the open-session count is real, not a placeholder', async () => {
      const rows = ((await (await call('GET', '/admin/c2c/cards')).json()) as any).data.rows;
      const row = rows.find((r: any) => r.id === cardId);
      assert.equal(row.openSessions, 1, 'the operator needs to watch this climb, not find it at 100%');
    });
  } finally {
    server.close();
  }

  console.log(`[c2cCardsApi] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
