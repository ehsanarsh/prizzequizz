/* ROUTES THAT COULD NOT SUCCEED.
 *
 * Two payment routes outlived the model they were written for:
 *
 *   POST /v1/payments/intents        answered 400 to every caller. It sent only
 *                                    an `amount`, and an intent with no `order`
 *                                    is refused — there is no topping up any
 *                                    more, so a payment must be FOR something.
 *   POST /v1/payments/intents/:id/verify   became a plain read once the hole
 *                                    that let a client flip its own intent to
 *                                    paid was closed, duplicating the GET.
 *
 * A dead route is worse than a missing one: the next person finds it in the
 * router and assumes it works. This checks they are really gone — and, just as
 * importantly, that the live routes beside them were not taken along with them.
 *
 * Run: npx tsx src/tests/deadRoutes.test.ts
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
import { signAccessToken } from '../services/tokenService.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function run(): Promise<void> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'dr' + uid.slice(0, 8), displayName: 'dr',
    phone: '09' + String(500000000 + Math.floor(Math.random() * 99999999)),
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
    tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  const token = signAccessToken(uid);

  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  try {
    await check('creating an intent without an order is no longer a route at all', async () => {
      const res = await call('POST', '/payments/intents', { amount: 50000 });
      assert.equal(res.status, 404, 'it used to answer 400 to everyone; now it does not exist');
      const body = await res.json() as any;
      assert.equal(body?.error?.code, 'NOT_FOUND');
    });

    await check('and neither is the verify endpoint', async () => {
      const res = await call('POST', '/payments/intents/anything/verify', {});
      assert.equal(res.status, 404);
    });

    await check('but reading an intent still works — the client polls it', async () => {
      /* An unknown id must answer 404 with the route's OWN code, not the
       * router's. That is what tells the two kinds of 404 apart, and what would
       * catch this route being deleted along with its dead neighbours. */
      const res = await call('GET', '/payments/intents/' + id());
      assert.equal(res.status, 404);
      const body = await res.json() as any;
      assert.equal(body?.error?.code, 'PAYMENT_INTENT_NOT_FOUND', 'the route answered, the router did not');
    });

    await check('the gateway callback is untouched — card-to-card does not replace it', async () => {
      /* An unknown intent makes this route answer 404 too, so the status alone
       * cannot tell "the route is gone" from "the route ran and found nothing".
       * The error CODE can. */
      const res = await call('POST', '/payments/callback', { intentId: id(), status: 'paid', signature: 'bad' });
      const body = await res.json() as any;
      assert.notEqual(body?.error?.code, 'NOT_FOUND', 'redirect gateways still settle through here');
      assert.equal(body?.error?.code, 'PAYMENT_INTENT_NOT_FOUND', 'the route ran; it just had nothing to settle');
    });

    await check('paying for an order is still the way in', async () => {
      const res = await call('POST', '/orders/quote', { order: { kind: 'ticket', tier: 'green', qty: 1 } });
      assert.equal(res.status, 200, 'the live path must survive the cleanup');
      const body = await res.json() as any;
      assert.ok(Number(body?.data?.amount) > 0, 'and still price the order server-side');
    });
  } finally {
    server.close();
  }

  console.log(`[deadRoutes] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
