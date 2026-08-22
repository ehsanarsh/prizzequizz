/* WHICH TICKET TIERS ARE WORTH OFFERING.
 *
 *   «الان یکی با بلیط سبز دنبال حریفه یکی با بلیط قرمز و هیچ وقت همدیگرو پیدا
 *    نمیکنن… بلیط سبز همیشه فعال، بلیط آبی زمانی فعال که یک نفر از بلیط سبز
 *    دکمه ادامه میدهم را میزند و منتظر حریف با بلیط آبی است، و بلیط قرمز هم
 *    زمانی که یک نفر دنبال حریف با بلیط قرمز هست.»
 *
 * Two players must stake the same amount, so a green player can only ever meet
 * another green player — that part was never wrong, and this does not touch it.
 * What was missing is that nobody could SEE where the others were, so three
 * players picked three tiers and all three waited alone. The queue now says how
 * many are waiting in each, which is what lets the game stop offering an empty
 * one.
 *
 * Run: REPOSITORY_DRIVER=memory npx tsx src/tests/tierWaiting.test.ts
 */
import assert from 'node:assert';
import { matchmakingQueue } from '../services/matchmakingQueue.js';
import { repositories } from '../repositories/index.js';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); }
};

/* Real users, because two compatible tickets really do create a match and a
   match needs players. */
const q = async (userId: string, economyType: string, ticketTier?: string, pairKey?: string) => {
  await repositories.users.save({
    id: userId, username: userId, displayName: userId, wallet: 0, coins: 0, xp: 0, level: 1,
    createdAt: new Date().toISOString()
  } as any);
  return matchmakingQueue.enqueue({ userId, modeId: 'duel', economyType: economyType as any, ticketTier, skill: 800, pairKey });
};

/* ── 1. NOBODY WAITING ────────────────────────────────────────────────── */
{
  console.log('an empty queue:');
  const s = await matchmakingQueue.stats();
  ok('reports a tier breakdown at all', !!s.waitingByTier, JSON.stringify(s.waitingByTier));
  ok('and nobody in any of them', Object.keys(s.waitingByTier).length === 0, JSON.stringify(s.waitingByTier));
}

/* ── 2. SOMEBODY WAITING ON GREEN ─────────────────────────────────────── */
{
  console.log('\none player waiting on green:');
  await q('u-green-1', 'v12500', 'green');
  const s = await matchmakingQueue.stats();
  ok('green shows one waiting', s.waitingByTier.green === 1, JSON.stringify(s.waitingByTier));
  ok('and the other tiers show nobody', !s.waitingByTier.blue && !s.waitingByTier.red, JSON.stringify(s.waitingByTier));
}

/* ── 3. TWO TIERS OCCUPIED AT ONCE — THE SITUATION TO AVOID ───────────── */
{
  console.log('\nplayers waiting in different tiers:');
  await q('u-red-1', 'v50000', 'red');
  const s = await matchmakingQueue.stats();
  ok('red shows its one', s.waitingByTier.red === 1, JSON.stringify(s.waitingByTier));
  ok('green still shows its one', s.waitingByTier.green === 1, JSON.stringify(s.waitingByTier));
  /* The whole complaint, stated as data: a green player and a red player are
     both waiting and can never meet. With this visible, the game can stop
     offering the tier nobody is in. */
  ok('two tiers are occupied at once', s.waitingByTier.green > 0 && s.waitingByTier.red > 0, JSON.stringify(s.waitingByTier));
}

/* ── 4. A MATCHED PLAYER IS NO LONGER WAITING ─────────────────────────── */
/* The count has to mean «a seat you can take», so it must empty the moment the
 * seat is taken — otherwise the game keeps advertising a tier whose only
 * occupant has already gone into a match. */
{
  console.log('\nwhen a second one arrives in that tier:');
  const t = await q('u-red-2', 'v50000', 'red');
  const s = await matchmakingQueue.stats();
  ok('the two of them meet at once', t.status === 'matched', t.status);
  ok('and red is back to nobody waiting', !s.waitingByTier.red, JSON.stringify(s.waitingByTier));
  ok('while green, untouched, still shows its one', s.waitingByTier.green === 1, JSON.stringify(s.waitingByTier));
}

/* ── 5. A PRIVATE PAIRING IS NOT AN OPEN SEAT ─────────────────────────── */
/* Two people who arranged a game are not queueing, they are meeting. Counting
 * them would tell everyone else that a tier is busy when its queue is empty —
 * and send them in to wait alone, which is the bug this is meant to end. */
{
  console.log('\ntwo friends meeting privately:');
  await q('u-priv-1', 'v25000', 'blue', 'invite-xyz');
  const s = await matchmakingQueue.stats();
  ok('blue is not advertised as busy', !s.waitingByTier.blue, JSON.stringify(s.waitingByTier));
  ok('though the player really is queued', s.queued > 0, String(s.queued));
}

/* ── 6. A PLAYER WITH NO TICKET AT ALL ────────────────────────────────── */
/* Free play has no tier, and must not land in a tier's count. */
{
  console.log('\na free-play player:');
  const before = JSON.stringify((await matchmakingQueue.stats()).waitingByTier);
  await q('u-free-1', 'free');
  const after = (await matchmakingQueue.stats()).waitingByTier;
  ok('no tier gained anybody', JSON.stringify(after) === before, before + ' → ' + JSON.stringify(after));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
