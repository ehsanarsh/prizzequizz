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
import { postEntry, getAccount } from '../services/walletLedgerService.js';
import { signAccessToken } from '../services/tokenService.js';
import { id } from '../utils/id.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let base = '';
async function api(method: string, path: string, token?: string, body?: any): Promise<{ status: number; body: any; code: string }> {
  const res = await fetch(base + path, {
    method,
    headers: token ? { authorization: 'Bearer ' + token, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
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
    /* ── the level gate ─────────────────────────────────────────────── */

    /* «سکه داشته باشم ولی لول نداشته باشم نتونم خرید کنم». */
    await check('coins alone do not buy a character with a level on it', async () => {
      const gated = await saveCharacter({ name: 'استاد', price: 100, viaPurchase: true, viaLevel: false, unlockLevel: 10, enabled: true });
      const p = await player(9_000_000);                       // rich, and level 1
      const r = await api('POST', `/characters/${gated.id}/purchase`, p.token);
      assert.notEqual(r.status, 200, 'the purchase must be refused: ' + JSON.stringify(r.body));
      assert.equal(r.code, 'LEVEL_TOO_LOW', r.code);
      const u: any = await repositories.users.findById(p.id);
      assert.equal(Number(u.coins), 9_000_000, 'and not a single coin was taken');
      const roster = await buildRoster(p.id);
      assert.equal(roster.characters.find((c) => c.id === gated.id)!.unlocked, false, 'nor was it granted');
    });

    await check('and the reason given is the level, not the money', async () => {
      const gated = await saveCharacter({ name: 'استاد دوم', price: 100, viaPurchase: true, viaLevel: false, unlockLevel: 12, enabled: true });
      const p = await player(0);                               // poor AND low level
      const r = await api('POST', `/characters/${gated.id}/purchase`, p.token);
      assert.equal(r.code, 'LEVEL_TOO_LOW', 'sending them to buy coins they may not spend is the wrong answer: ' + r.code);
    });

    await check('reaching the level lets the coins do their work', async () => {
      const gated = await saveCharacter({ name: 'استاد سوم', price: 400, viaPurchase: true, viaLevel: false, unlockLevel: 5, enabled: true });
      const p = await player(600);
      const u: any = await repositories.users.findById(p.id);
      u.xp = 100 * 5 * 5;                                      // levelForXp → 6
      await repositories.users.save(u);
      const r = await api('POST', `/characters/${gated.id}/purchase`, p.token);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.charged, 400);
    });

    await check('the card says the level before the player presses buy', async () => {
      const gated = await saveCharacter({ name: 'استاد چهارم', price: 250, viaPurchase: true, viaLevel: false, unlockLevel: 20, enabled: true });
      const p = await player(9999);
      const roster = await buildRoster(p.id);
      const card = roster.characters.find((c) => c.id === gated.id)!;
      assert.equal(card.unlocked, false);
      assert.match(card.lockReason, /لول ۲۰/, card.lockReason);
    });

    /* ── priced in toman ─────────────────────────────────────────────── */

    /* «کاراکترها را فقط با سکه می‌توانم به فروش بگذارم نه تومان» — so a
     * character can carry a toman price, and then it is the WALLET that pays,
     * not the coin counter. */
    await check('a toman-priced character is paid for from the wallet', async () => {
      const paid = await saveCharacter({ name: 'گران‌قیمت', price: 30_000, currency: 'cash', viaPurchase: true, viaLevel: false, enabled: true });
      const p = await player(0);                               // no coins at all
      await postEntry({ userId: p.id, entryType: 'bonus', kind: 'credit', amount: 50_000, idempotencyKey: 'seed:' + p.id, description: 'شارژ آزمایشی' });
      const before = (await getAccount(p.id)).available;

      const r = await api('POST', `/characters/${paid.id}/purchase`, p.token, { idempotencyKey: 'buy:' + p.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.charged, 30_000, JSON.stringify(r.body));
      assert.equal(r.body.currency, 'cash');
      assert.equal((await getAccount(p.id)).available, before - 30_000, 'the wallet was not debited');
      const roster = await buildRoster(p.id);
      assert.equal(roster.characters.find((c) => c.id === paid.id)!.unlocked, true, 'paid for and not granted');
      /* And the coin counter is untouched — the two purses are separate. */
      const u: any = await repositories.users.findById(p.id);
      assert.equal(Number(u.coins), 0);
    });

    await check('and a retry with the same key does not charge twice', async () => {
      const paid = await saveCharacter({ name: 'گران‌قیمت ۲', price: 20_000, currency: 'cash', viaPurchase: true, viaLevel: false, enabled: true });
      const p = await player(0);
      await postEntry({ userId: p.id, entryType: 'bonus', kind: 'credit', amount: 50_000, idempotencyKey: 'seed2:' + p.id, description: 'شارژ آزمایشی' });
      const key = 'buy-once:' + p.id;
      await api('POST', `/characters/${paid.id}/purchase`, p.token, { idempotencyKey: key });
      const after = (await getAccount(p.id)).available;
      const again = await api('POST', `/characters/${paid.id}/purchase`, p.token, { idempotencyKey: key });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.charged, 0, 'the second press charged ' + again.body.charged);
      assert.equal((await getAccount(p.id)).available, after, 'the wallet moved on the retry');
    });

    await check('an empty wallet buys nothing, and says so in toman', async () => {
      const paid = await saveCharacter({ name: 'گران‌قیمت ۳', price: 90_000, currency: 'cash', viaPurchase: true, viaLevel: false, enabled: true });
      const p = await player(9_000_000);                       // rich in COINS only
      const r = await api('POST', `/characters/${paid.id}/purchase`, p.token, { idempotencyKey: 'poor:' + p.id });
      assert.notEqual(r.status, 200, JSON.stringify(r.body));
      /* The CODE matters, not just the failure: the game opens «شارژ صندوق» on
         INSUFFICIENT_FUNDS and «خرید سکه» on INSUFFICIENT_COINS, so a raw
         wallet error here would send the player to buy the wrong thing. */
      assert.equal(r.code, 'INSUFFICIENT_FUNDS', 'got ' + r.code + ': ' + JSON.stringify(r.body));
      assert.equal(r.status, 409, String(r.status));
      assert.equal((await getAccount(p.id)).available, 0, 'the wallet moved anyway');
      const roster = await buildRoster(p.id);
      assert.equal(roster.characters.find((c) => c.id === paid.id)!.unlocked, false, 'it was granted for free');
    });

    /* ── the shelf it is sold on ─────────────────────────────────────── */

    await check('a character carries the group the panel put it in', async () => {
      const c = await saveCharacter({ name: 'پهلوان', price: 100, viaPurchase: true, viaLevel: false, group: 'قهرمانان', enabled: true });
      assert.equal(c.group, 'قهرمانان');
      const p = await player(500);
      const roster = await buildRoster(p.id);
      assert.equal(roster.characters.find((x) => x.id === c.id)!.group, 'قهرمانان', 'and the player sees it too');
      /* An ungrouped character is not broken, just ungrouped. */
      const plain = await saveCharacter({ name: 'ساده', price: 10, viaPurchase: true, viaLevel: false, enabled: true });
      assert.equal(plain.group, '');
    });
  } finally {
    server.close();
  }

  console.log(`[characterPurchase] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
