/* THE TEN FACES ON THE HOME SCREEN, AND WHAT LOOKING AGAIN COSTS.
 *
 * Two ways this hurts a real player:
 *
 *   — being charged for a refresh that failed, or charged twice for one press.
 *     Coins are bought with money.
 *   — "mostly the opposite gender" implemented as a filter: on a quiet evening
 *     the list would be two people, and for anyone who never answered the
 *     question it would be empty. It has to be an ordering.
 *
 * Run: npx tsx src/tests/onlinePlayers.test.ts
 */
import assert from 'node:assert/strict';
import {
  listOnlinePlayers, orderByPreference, getOnlineConfig, setOnlineConfig,
  OnlinePlayersError, _resetOnlinePlayers
} from '../services/onlinePlayersService.js';
import { _resetPresence, _seed } from '../services/presenceService.js';
import { repositories } from '../repositories/index.js';
import type { Gender, User } from '../types/domain.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let seq = 0;
async function player(opts: { gender?: Gender; coins?: number; status?: User['status']; online?: boolean } = {}): Promise<User> {
  const id = 'on-' + (++seq);
  const u = {
    id, phone: '0913' + String(seq).padStart(7, '0'), username: id, displayName: id, plan: 'free',
    gender: opts.gender, status: opts.status ?? 'active',
    level: 3, xp: 0, weeklyScore: 0, wallet: 0, coins: opts.coins ?? 0, hearts: 5,
    tickets: { bronze: 0, silver: 0, gold: 0 }
  } as unknown as User;
  await repositories.users.save(u);
  if (opts.online !== false) _seed(id);
  return u;
}

async function run(): Promise<void> {
  await check('the list is the people who are actually here, minus yourself', async () => {
    _resetPresence(); _resetOnlinePlayers();
    const me = await player({ gender: 'male' });
    const here = await player({ gender: 'female' });
    await player({ gender: 'female', online: false });      // left an hour ago
    const r = await listOnlinePlayers(me.id);
    const ids = r.players.map((p) => p.userId);
    assert.ok(ids.includes(here.id), 'the person who is here is listed');
    assert.ok(!ids.includes(me.id), 'and you are not in your own list');
    assert.equal(ids.length, 1, 'nobody offline is invented to fill the space: ' + JSON.stringify(ids));
  });

  await check('a banned account is not shown to anybody', async () => {
    _resetPresence(); _resetOnlinePlayers();
    const me = await player({ gender: 'female' });
    const banned = await player({ gender: 'male', status: 'banned' });
    const r = await listOnlinePlayers(me.id);
    assert.ok(!r.players.some((p) => p.userId === banned.id), 'banned account listed');
  });

  await check('the first look is free', async () => {
    _resetPresence(); _resetOnlinePlayers();
    await setOnlineConfig({ refreshCost: 5, freeRefreshesPerDay: 0, size: 10 });
    const me = await player({ gender: 'male', coins: 40 });
    await player({ gender: 'female' });
    const r = await listOnlinePlayers(me.id);            // no refresh flag
    assert.equal(r.charged, 0, 'opening the screen must never cost anything');
    assert.equal((await repositories.users.findById(me.id))!.coins, 40);
  });

  await check('a refresh costs coins — once per press', async () => {
    _resetPresence(); _resetOnlinePlayers();
    await setOnlineConfig({ refreshCost: 5, freeRefreshesPerDay: 0 });
    const me = await player({ gender: 'male', coins: 40 });
    await player({ gender: 'female' });
    const a = await listOnlinePlayers(me.id, true);
    assert.equal(a.charged, 5);
    assert.equal(a.coins, 35, 'and the balance it reports is the new one');
    const b = await listOnlinePlayers(me.id, true);
    assert.equal(b.charged, 5);
    assert.equal((await repositories.users.findById(me.id))!.coins, 30, 'two presses, two charges — not four');
  });

  await check('the free daily refreshes are used before the coins', async () => {
    _resetPresence(); _resetOnlinePlayers();
    await setOnlineConfig({ refreshCost: 5, freeRefreshesPerDay: 2 });
    const me = await player({ gender: 'male', coins: 40 });
    await player({ gender: 'female' });
    assert.equal((await listOnlinePlayers(me.id, true)).charged, 0, 'first free');
    assert.equal((await listOnlinePlayers(me.id, true)).charged, 0, 'second free');
    assert.equal((await listOnlinePlayers(me.id, true)).charged, 5, 'third costs');
    assert.equal((await repositories.users.findById(me.id))!.coins, 35);
  });

  await check('the button knows what the next press will cost', async () => {
    _resetPresence(); _resetOnlinePlayers();
    await setOnlineConfig({ refreshCost: 7, freeRefreshesPerDay: 1 });
    const me = await player({ gender: 'male', coins: 40 });
    await player({ gender: 'female' });
    const first = await listOnlinePlayers(me.id);
    assert.equal(first.nextCost, 0, 'a free refresh is still owed');
    await listOnlinePlayers(me.id, true);
    const after = await listOnlinePlayers(me.id);
    assert.equal(after.nextCost, 7, 'and after it is spent, the real price');
    assert.equal(after.charged, 0, 'asking what it costs does not buy it');
  });

  await check('being short of coins refuses the refresh and takes nothing', async () => {
    /* The bad version charges what it can and shows an error. */
    _resetPresence(); _resetOnlinePlayers();
    await setOnlineConfig({ refreshCost: 20, freeRefreshesPerDay: 0 });
    const me = await player({ gender: 'male', coins: 3 });
    await player({ gender: 'female' });
    await assert.rejects(() => listOnlinePlayers(me.id, true),
      (e: unknown) => e instanceof OnlinePlayersError && e.code === 'INSUFFICIENT_COINS');
    assert.equal((await repositories.users.findById(me.id))!.coins, 3, 'not a single coin moved');
  });

  await check('a free refresh is not consumed when the price cannot be paid', async () => {
    _resetPresence(); _resetOnlinePlayers();
    await setOnlineConfig({ refreshCost: 20, freeRefreshesPerDay: 1 });
    const me = await player({ gender: 'male', coins: 0 });
    await player({ gender: 'female' });
    await listOnlinePlayers(me.id, true);                 // uses the free one
    await assert.rejects(() => listOnlinePlayers(me.id, true),
      (e: unknown) => e instanceof OnlinePlayersError && e.code === 'INSUFFICIENT_COINS');
    assert.equal((await repositories.users.findById(me.id))!.coins, 0);
  });

  /* ── who is shown ─────────────────────────────────────────────────── */

  await check('the opposite gender comes first', async () => {
    const men = ['m1', 'm2', 'm3'].map((id) => ({ id, gender: 'male' } as User));
    const women = ['w1', 'w2', 'w3'].map((id) => ({ id, gender: 'female' } as User));
    const ordered = orderByPreference([...men, ...women], { id: 'me', gender: 'male' } as User);
    assert.deepEqual(ordered.slice(0, 3).map((u) => u.gender), ['female', 'female', 'female'],
      'a male viewer sees women first: ' + ordered.map((u) => u.id).join(','));
  });

  await check('but it is a preference, not a filter', async () => {
    /* Filtering would show one face on a quiet night. */
    const ordered = orderByPreference(
      [{ id: 'w1', gender: 'female' }, { id: 'm1', gender: 'male' }, { id: 'x1' }] as User[],
      { id: 'me', gender: 'male' } as User);
    assert.equal(ordered.length, 3, 'everybody online is still reachable: ' + ordered.map((u) => u.id).join(','));
    assert.equal(ordered[0]!.id, 'w1', 'the preferred one is simply first');
  });

  await check('someone who never said their gender still gets a full list', async () => {
    const pool = [{ id: 'w1', gender: 'female' }, { id: 'm1', gender: 'male' }, { id: 'x1' }] as User[];
    const ordered = orderByPreference(pool, { id: 'me' } as User);
    assert.equal(ordered.length, 3);
    assert.deepEqual(ordered.map((u) => u.id).sort(), ['m1', 'w1', 'x1']);
  });

  await check('the list is not the same ten every time', async () => {
    /* A fixed order makes the paid refresh worthless — the player pays and
       sees the same faces. */
    const pool = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, gender: 'female' } as User));
    const me = { id: 'me', gender: 'male' } as User;
    const a = orderByPreference(pool, me).slice(0, 10).map((u) => u.id).join(',');
    let differs = false;
    for (let i = 0; i < 10 && !differs; i++) {
      if (orderByPreference(pool, me).slice(0, 10).map((u) => u.id).join(',') !== a) differs = true;
    }
    assert.ok(differs, 'ten refreshes produced the identical list');
  });

  await check('the list is capped at the configured size', async () => {
    _resetPresence(); _resetOnlinePlayers();
    await setOnlineConfig({ size: 4, refreshCost: 0, freeRefreshesPerDay: 0 });
    const me = await player({ gender: 'male' });
    for (let i = 0; i < 9; i++) await player({ gender: 'female' });
    const r = await listOnlinePlayers(me.id);
    assert.equal(r.players.length, 4);
    assert.equal(r.onlineTotal, 9, 'while still reporting how many are really here');
    await setOnlineConfig({ size: 10 });
  });

  await check('the settings refuse nonsense', async () => {
    await setOnlineConfig({ size: 0, refreshCost: -5, freeRefreshesPerDay: -1 });
    const c = await getOnlineConfig();
    assert.ok(c.size >= 1, 'a list of zero people is not a list');
    assert.ok(c.refreshCost >= 0, 'a negative price would PAY people to refresh');
    assert.ok(c.freeRefreshesPerDay >= 0);
    await setOnlineConfig({ size: 10, refreshCost: 5, freeRefreshesPerDay: 1 });
  });

  console.log(`[onlinePlayers] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
