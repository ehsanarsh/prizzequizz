/* LAST SURVIVOR prize-engine tests — the money math must be exact and
 * conservation-safe. Run: npx tsx src/tests/lastSurvivorPrize.test.ts */
import assert from 'node:assert';
import { LS_DEFAULT_CONFIG, withDefaults } from '../services/lastSurvivorConfig.js';
import { buildPool, ticketUnits, ticketValue, activeUnits, cashoutShareFor, finalSplit, computeStats, type PrizePlayer } from '../services/lastSurvivorPrize.js';

const cfg = LS_DEFAULT_CONFIG;
let passed = 0;
function ok(name: string) { console.log('✔', name); passed++; }

// ---- ticket values & units ----
assert.equal(ticketValue(cfg, 'green'), 12500);
assert.equal(ticketValue(cfg, 'blue'), 25000);
assert.equal(ticketValue(cfg, 'red'), 50000);
assert.equal(ticketUnits(cfg, 'green'), 1);
assert.equal(ticketUnits(cfg, 'blue'), 2);
assert.equal(ticketUnits(cfg, 'red'), 4);
ok('ticket values & units match spec (green/blue/red = 1/2/4)');

// ---- the exact spec example: 1 green + 1 blue + 1 red ----
// 3 players, 7 units, pool = 12500+25000+50000 = 87500; no rake.
{
  const players: PrizePlayer[] = [
    { userId: 'g', color: 'green', units: 1, status: 'alive' },
    { userId: 'b', color: 'blue', units: 2, status: 'alive' },
    { userId: 'r', color: 'red', units: 4, status: 'alive' }
  ];
  const pool = buildPool(cfg, players.map((p) => p.color));
  assert.equal(pool.gross, 87500);
  assert.equal(pool.net, 87500);
  assert.equal(activeUnits(players), 7); // NOT headcount (3), units (7)
  // If the match ended now, split by units over 7:
  const split = finalSplit(players, pool.net);
  // green 1/7, blue 2/7, red 4/7 → floors 12500, 25000, 50000 exactly.
  assert.equal((split.g ?? 0), 12500);
  assert.equal((split.b ?? 0), 25000);
  assert.equal((split.r ?? 0), 50000);
  assert.equal((split.g ?? 0) + (split.b ?? 0) + (split.r ?? 0), 87500);
  ok('spec example: 3 players / 7 units, pot 87,500 splits 1:2:4 exactly');
}

// ---- headcount stays real (a red ticket is ONE person) ----
{
  const players: PrizePlayer[] = [
    { userId: 'r1', color: 'red', units: 4, status: 'alive' },
    { userId: 'r2', color: 'red', units: 4, status: 'alive' }
  ];
  const stats = computeStats(players, buildPool(cfg, players.map((p) => p.color)).net);
  assert.equal(stats.totalPlayers, 2); // two people, not eight
  assert.equal(stats.activeUnits, 8);
  ok('headcount = real people; units only affect the money split');
}

// ---- elimination raises survivors' shares; conservation holds ----
{
  const players: PrizePlayer[] = [
    { userId: 'g', color: 'green', units: 1, status: 'alive' },
    { userId: 'b', color: 'blue', units: 2, status: 'alive' },
    { userId: 'r', color: 'red', units: 4, status: 'alive' }
  ];
  const pool = buildPool(cfg, players.map((p) => p.color)); // 87500
  // green eliminated (wrong answer): gets nothing, units leave the pool.
  players[0]!.status = 'eliminated';
  assert.equal(activeUnits(players), 6);
  const split = finalSplit(players, pool.net);
  assert.equal(split.g ?? 0, 0);            // eliminated → nothing
  assert.equal((split.b ?? 0) + (split.r ?? 0), 87500);   // whole pot to survivors
  // blue 2/6, red 4/6 of 87500 → 29166 + 58333 = 87499, remainder 1 to top stake (red)
  assert.equal((split.b ?? 0), 29166);
  assert.equal((split.r ?? 0), 58333 + 1);
  assert.equal((split.b ?? 0) + (split.r ?? 0), 87500);
  ok('elimination pays nothing, survivors split the whole pot, no money lost');
}

// ---- cash-out pays current share and shrinks the remaining pot ----
{
  const players: PrizePlayer[] = [
    { userId: 'g', color: 'green', units: 1, status: 'alive' },
    { userId: 'b', color: 'blue', units: 2, status: 'alive' },
    { userId: 'r', color: 'red', units: 4, status: 'alive' }
  ];
  const pool = buildPool(cfg, players.map((p) => p.color)); // gross 87500
  let remaining = pool.net;
  // blue cashes out now: share = remaining * 2 / 7 = floor(25000) = 25000
  const blueShare = cashoutShareFor(players[1]!, players, remaining);
  assert.equal(blueShare, 25000);
  players[1]!.status = 'cashed_out'; players[1]!.payoutCash = blueShare; remaining -= blueShare; // 62500
  assert.equal(remaining, 62500);
  // now green+red alive, units 5. red cashes out: floor(62500*4/5)=50000
  const redShare = cashoutShareFor(players[2]!, players, remaining);
  assert.equal(redShare, 50000);
  players[2]!.status = 'cashed_out'; players[2]!.payoutCash = redShare; remaining -= redShare; // 12500
  // green is the last survivor → final split gets the rest (12500)
  const split = finalSplit(players, remaining);
  assert.equal((split.g ?? 0), 12500);
  // total paid == gross pot
  assert.equal(blueShare + redShare + (split.g ?? 0), 87500);
  const stats = computeStats(players, pool.gross);
  assert.equal(stats.cashedOut, 2);
  assert.equal(stats.paidOut, 75000);
  assert.equal(stats.remainingPot, 12500);
  ok('cash-out pays current share, shrinks remaining pot, conserves the pot');
}

// ---- rake is applied to the gross pool when the admin sets it ----
{
  const c = withDefaults({ economy: { rakePercent: 10 } });
  const pool = buildPool(c, ['green', 'blue', 'red']); // gross 87500
  assert.equal(pool.gross, 87500);
  assert.equal(pool.rake, 8750);
  assert.equal(pool.net, 78750);
  const split = finalSplit([
    { userId: 'g', color: 'green', units: 1, status: 'alive' },
    { userId: 'b', color: 'blue', units: 2, status: 'alive' },
    { userId: 'r', color: 'red', units: 4, status: 'alive' }
  ], pool.net);
  assert.equal((split.g ?? 0) + (split.b ?? 0) + (split.r ?? 0), 78750); // players split the NET pot exactly
  ok('admin rake reduces the pot; players split the net exactly');
}

// ---- large field: many units, conservation still exact with dust ----
{
  const players: PrizePlayer[] = [];
  const colors = ['green', 'blue', 'red'];
  for (let i = 0; i < 97; i++) players.push({ userId: 'u' + i, color: colors[i % 3]!, units: ticketUnits(cfg, colors[i % 3]!), status: 'alive' });
  const pool = buildPool(cfg, players.map((p) => p.color));
  const split = finalSplit(players, pool.net);
  const sum = Object.values(split).reduce((s, v) => s + v, 0);
  assert.equal(sum, pool.net); // no money created or lost across 97 players
  ok('97-player field: final split conserves the net pot to the toman');
}

console.log(`\nALL LAST SURVIVOR PRIZE TESTS PASSED (${passed})`);
