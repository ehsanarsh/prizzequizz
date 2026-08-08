/* BUYING A CHARACTER.
 *
 * The roster has advertised a price and a «خرید (N سکه)» unlock line since it
 * was written, and nothing behind it could take the money — so a character
 * whose only unlock route was purchase could never be obtained at all. This
 * covers the half that was missing.
 *
 * Run: npx tsx src/tests/characterPurchase.test.ts
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { saveCharacter, buildRoster, _resetMemory } from '../services/characterSelectionService.js';
import { signAccessToken } from '../services/tokenService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let base = '';
async function api(method: string, path: string, token?: string): Promise<{ status: number; body: any; code: string }> {
  const res = await fetch(base + path, { method, headers: token ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' } : {} });
  const text = await res.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  return { status: res.status, body: j?.data ?? j, code: j?.error?.code ?? '' };
}

async function player(coins: number): Promise<{ id: string; token: string }> {
  const uid = id();
  await repositories.users.save({
    id: uid, username: 'cp' + uid.slice(0, 8), displayName: 'cp', phone: '09' + String(100000000 + Math.floor(Math.random() * 899999999)),
    wallet: 0, coins, hearts: 5, xp: 0, level: 1, plan: 'premium', weeklyScore: 0, tickets: { green: 0, blue: 0, red: 0 }
  } as any);
  return { id: uid, token: signAccessToken(uid) };
}

async function run(): Promise<void> {
  _resetMemory();
  const forSale = await saveCharacter({ name: 'قهرمان طلایی', price: 500, viaPurchase: true, viaLevel: false, enabled: true });
  const notForSale = await saveCharacter({ name: 'جایزهٔ رویداد', price: 300, viaPurchase: false, viaLevel: false, enabled: true });
  const free = await saveCharacter({ name: 'رایگان', price: 0, viaPurchase: true, viaLevel: false, enabled: true });

  const server = createApiServer();
  server.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as any).port}/v1`;

  try {
    await check('a character on sale can be bought, and the coins are taken', async () => {
      const p = await player(800);
      const r = await api('POST', `/characters/${forSale.id}/purchase`, p.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.charged, 500, 'the advertised price is what is charged');
      assert.equal(r.body.coins, 300, 'and the balance comes back reduced');
      const u: any = await repositories.users.findById(p.id);
      assert.equal(Number(u.coins), 300, 'the user row really was charged');
      const roster = await buildRoster(p.id);
      const mine = roster.characters.find((c) => c.id === forSale.id)!;
      assert.equal(mine.unlocked, true, 'and the character is unlocked');
      assert.equal(mine.source, 'purchase', 'recorded as a purchase, not a gift');
    });

    await check('buying it twice does not charge twice', async () => {
      const p = await player(1200);
      await api('POST', `/characters/${forSale.id}/purchase`, p.token);
      const again = await api('POST', `/characters/${forSale.id}/purchase`, p.token);
      assert.equal(again.status, 200);
      assert.equal(again.body.alreadyOwned, true);
      assert.equal(again.body.charged, 0, 'the second tap is free');
      const u: any = await repositories.users.findById(p.id);
      assert.equal(Number(u.coins), 700, 'charged exactly once');
    });

    await check('not enough coins buys nothing and takes nothing', async () => {
      const p = await player(499);
      const r = await api('POST', `/characters/${forSale.id}/purchase`, p.token);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.code, 'INSUFFICIENT_COINS');
      const u: any = await repositories.users.findById(p.id);
      assert.equal(Number(u.coins), 499, 'the balance is untouched');
      const roster = await buildRoster(p.id);
      assert.equal(roster.characters.find((c) => c.id === forSale.id)!.unlocked, false, 'and nothing was unlocked');
    });

    await check('a character that is not for sale cannot be bought at any price', async () => {
      const p = await player(100000);
      const r = await api('POST', `/characters/${notForSale.id}/purchase`, p.token);
      assert.equal(r.status, 422);
      assert.equal(r.code, 'NOT_FOR_SALE');
      const u: any = await repositories.users.findById(p.id);
      assert.equal(Number(u.coins), 100000, 'and no coins moved');
    });

    await check('a free character still has to be claimed, not assumed', async () => {
      const p = await player(0);
      const r = await api('POST', `/characters/${free.id}/purchase`, p.token);
      assert.equal(r.status, 200);
      assert.equal(r.body.charged, 0);
      const roster = await buildRoster(p.id);
      assert.equal(roster.characters.find((c) => c.id === free.id)!.unlocked, true);
    });

    await check('a character that does not exist is a 404, not a charge', async () => {
      const p = await player(5000);
      const r = await api('POST', `/characters/${id()}/purchase`, p.token);
      assert.equal(r.status, 404);
      const u: any = await repositories.users.findById(p.id);
      assert.equal(Number(u.coins), 5000);
    });

    await check('and none of it is open to an anonymous request', async () => {
      const r = await api('POST', `/characters/${forSale.id}/purchase`);
      assert.equal(r.status, 401);
    });

    await check('the response carries the whole roster back', async () => {
      /* So the client repaints from the server instead of guessing what
         changed — the same rule the rest of the app follows. */
      const p = await player(900);
      const r = await api('POST', `/characters/${forSale.id}/purchase`, p.token);
      assert.ok(Array.isArray(r.body.roster?.characters), 'roster included');
      assert.equal(r.body.roster.characters.find((c: any) => c.id === forSale.id).unlocked, true);
    });
  } finally {
    server.close();
  }

  console.log(`[characterPurchase] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
