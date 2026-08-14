/* Match-reward payout guarantees. A won cash prize MUST land immediately in the
 * wallet + the legacy transactions table + the leaderboard, and must never be
 * silently parked by the fraud-review hold under default config. Holding is
 * opt-in (rewards.hold.enabled) and, when on, only parks genuinely risky users.
 * Run: npm run build && node dist/tests/reward.test.js */
import assert from 'node:assert';

process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'development';

const { repositories } = await import('../repositories/index.js');
const { applyReward } = await import('../services/rewardEngine.js');
const { getAccount } = await import('../services/walletLedgerService.js');
const { gameConfig } = await import('../core/config.js');

async function mkUser(s: string): Promise<string> {
  const uid = `00000000-0000-4000-8000-b0000000000${s}`;
  await repositories.users.save({
    id: uid, phone: `+98912888000${s}`, username: `winner_${s}`, displayName: `برنده ${s}`,
    plan: 'free', level: 1, xp: 0, weeklyScore: 0, wallet: 0, coins: 0, hearts: 5, tickets: {}
  } as any);
  return uid;
}

async function main(): Promise<void> {
  // 1) DEFAULT config: a cash win pays out immediately, netting the rake.
  const u1 = await mkUser('1');
  await applyReward((await repositories.users.findById(u1))!, { type: 'cash', amount: 50_000, status: 'granted' } as any, 'rw-match-1');
  assert.equal((await getAccount(u1)).available, 47_500, 'wallet credited NET immediately (50000 − 5% = 47500)');
  const txns = await repositories.transactions.list({ userId: u1, limit: 20 });
  assert.ok(txns.some((t) => t.type === 'reward' && t.direction === 'in'), 'reward transaction row written');
  assert.ok(txns.some((t) => t.type === 'fee' && t.direction === 'out'), 'platform fee transaction row written');
  assert.equal((await repositories.rewardHolds.list({ userId: u1, limit: 10 }).catch(() => [])).length, 0, 'no hold under default config');
  const rw = await repositories.rewards.findByIdempotencyKey(`rw-match-1:${u1}:cash:match_result`);
  assert.equal(rw?.status, 'granted', 'reward saved as granted, not pending');
  console.log('✔ default: cash win credits wallet + transactions immediately, no hold');

  // 2) Idempotent: paying the same win twice never double-credits.
  await applyReward((await repositories.users.findById(u1))!, { type: 'cash', amount: 50_000, status: 'granted' } as any, 'rw-match-1');
  assert.equal((await getAccount(u1)).available, 47_500, 'second applyReward is idempotent');
  console.log('✔ reward payout is idempotent (no double credit)');

  // 3) Admin enables holding: a genuinely risky user is parked, a clean one is not.
  (gameConfig as any).rewards = (gameConfig as any).rewards || {};
  (gameConfig as any).rewards.hold = { enabled: true, riskThreshold: 40 };
  const u2 = await mkUser('2');
  for (let i = 0; i < 4; i++) await repositories.integrity.save({ id: `rw-sig-${i}-${u2}`, matchId: `m${i}`, userId: u2, questionId: `q${i}`, type: 'ANSWER_BURST', severity: 'critical', riskScore: 75, status: 'open', evidence: {}, createdAt: new Date().toISOString() } as any);
  await applyReward((await repositories.users.findById(u2))!, { type: 'cash', amount: 50_000, status: 'granted' } as any, 'rw-match-2');
  assert.equal((await getAccount(u2)).available, 0, 'risky user win parked (wallet 0)');
  assert.equal((await repositories.rewardHolds.list({ userId: u2, limit: 10 })).length, 1, 'one pending hold created for risky user');
  const u3 = await mkUser('3');
  await applyReward((await repositories.users.findById(u3))!, { type: 'cash', amount: 50_000, status: 'granted' } as any, 'rw-match-3');
  assert.equal((await getAccount(u3)).available, 47_500, 'clean user still paid immediately even with holding enabled');
  (gameConfig as any).rewards.hold = { enabled: false, riskThreshold: 90 };
  console.log('✔ hold is opt-in: only risky users parked when enabled; clean users always paid');

  /* «کاراکترها ... از طریق چرخونه یا استریک به دست بیاد» — the wheel and the
   * streak calendar pay through one granter, so a character segment has to
   * come out of that same door as coins and tickets do. */
  const { grantReward } = await import('../services/rewardsService.js');
  const { saveCharacter, buildRoster, _resetMemory } = await import('../services/characterSelectionService.js');
  _resetMemory();
  const hero = await saveCharacter({ name: 'قهرمان گردونه', viaPurchase: false, viaLevel: false, enabled: true });
  /* A second one on the roster, so «granted nothing» and «granted whichever
   * came first» are two different outcomes rather than the same one. */
  const other = await saveCharacter({ name: 'کاراکتر دیگر', viaPurchase: false, viaLevel: false, enabled: true });
  const u4 = await mkUser('4');
  await grantReward(u4, { type: 'character', amount: 1, target: hero.id, label: 'کاراکتر', icon: '🦸' }, 'rw-wheel-4');
  const roster = await buildRoster(u4);
  assert.equal(roster.characters.find((c) => c.id === hero.id)!.unlocked, true,
    'a character segment on the wheel granted nothing');
  /* Spinning onto it twice is not two characters, and must not throw. */
  await grantReward(u4, { type: 'character', amount: 1, target: hero.id, label: 'کاراکتر', icon: '🦸' }, 'rw-wheel-4b');
  assert.equal((await buildRoster(u4)).characters.filter((c) => c.unlocked && c.id === hero.id).length, 1);
  /* A segment with no character named must not quietly grant a random one. */
  /* A segment with no character named must grant NOTHING. Asked of somebody
   * who owns none, so «granted nothing» and «granted whichever was first» are
   * not the same answer. */
  const u5 = await mkUser('5');
  await grantReward(u5, { type: 'character', amount: 1, target: '', label: 'کاراکتر', icon: '🦸' }, 'rw-wheel-5');
  const afterEmpty = (await buildRoster(u5)).characters.filter((c) => c.unlocked).map((c) => c.id);
  assert.deepEqual(afterEmpty, [], 'an empty target handed over a character nobody named: ' + JSON.stringify(afterEmpty));
  void other;
  console.log('✔ the wheel and the streak can hand over a character, once');

  console.log('\nALL REWARD PAYOUT TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
