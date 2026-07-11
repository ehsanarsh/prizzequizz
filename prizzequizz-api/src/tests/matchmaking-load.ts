import { strict as assert } from 'node:assert';
import { matchmakingQueue } from '../services/matchmakingQueue.js';
import { seedMemory } from '../repositories/memory.js';
import { repositories } from '../repositories/index.js';

async function main(): Promise<void> {
  seedMemory();
  const total = Number(process.env.MATCHMAKING_LOAD_USERS ?? 50);
  for (let i = 0; i < total; i++) {
    await repositories.users.save({
      id: `load_user_${i}`,
      phone: `load-${i}`,
      username: `LoadUser${i}`,
      displayName: `Load ${i}`,
      plan: 'free',
      level: 1,
      xp: 0,
      weeklyScore: 800 + (i % 12) * 20,
      wallet: 0,
      coins: 1000,
      hearts: 10,
      tickets: { bronze: 0, silver: 0, gold: 0 }
    });
  }
  for (let i = 0; i < total; i++) {
    await matchmakingQueue.enqueue({ userId: `load_user_${i}`, modeId: 'duel', economyType: 'free', coinStake: 10, skill: 800 + (i % 12) * 20 });
  }
  const stats = await matchmakingQueue.stats();
  assert.ok(stats.matched >= Math.floor(total / 2) - 2, `expected most users matched, got ${stats.matched}`);
  console.log('[matchmaking-load]', { total, stats });
}

main().catch((error) => { console.error(error); process.exit(1); });
