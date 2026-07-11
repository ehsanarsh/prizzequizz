import { appConfig } from '../core/config.js';
import { getPgPool, getPgPoolStats } from '../database/postgres.js';
import { verifyDatabase } from '../database/migrationService.js';
import { repositories } from '../repositories/index.js';

export async function getDeepHealth() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  checks.config = { ok: true, detail: `env=${appConfig.nodeEnv}` };

  try {
    await repositories.users.findById('u1');
    checks.repository = { ok: true };
  } catch (error) {
    checks.repository = { ok: false, detail: error instanceof Error ? error.message : 'repository failed' };
  }

  if (process.env.DATABASE_URL) {
    try {
      await getPgPool().query('select 1');
      const verification = await verifyDatabase();
      checks.postgres = { ok: true };
      checks.migrations = { ok: verification.migrations.pending === 0, detail: `${verification.migrations.applied}/${verification.migrations.total} applied` };
      checks.schema = { ok: verification.tables.every((table) => table.ok), detail: `${verification.tables.filter((table) => table.ok).length}/${verification.tables.length} tables` };
    } catch (error) {
      checks.postgres = { ok: false, detail: error instanceof Error ? error.message : 'postgres failed' };
    }
  } else {
    checks.postgres = { ok: true, detail: 'not configured' };
    checks.migrations = { ok: true, detail: 'not configured' };
    checks.schema = { ok: true, detail: 'not configured' };
  }

  checks.pgPool = { ok: true, detail: JSON.stringify(getPgPoolStats() ?? { configured: false }) };
  checks.redis = { ok: true, detail: process.env.REDIS_URL ? 'configured placeholder' : 'not configured' };

  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks, checkedAt: new Date().toISOString() };
}
