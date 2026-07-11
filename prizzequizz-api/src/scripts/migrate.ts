import { closePgPool } from '../database/postgres.js';
import { applyPendingMigrations } from '../database/migrationService.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('[migrate] DATABASE_URL not set. Skipping migrations.');
    return;
  }
  const rows = await applyPendingMigrations();
  const pending = rows.filter((row) => !row.applied).length;
  console.log(`[migrate] ${rows.length - pending}/${rows.length} migrations applied`);
}


main().finally(() => closePgPool()).catch((error) => {
  console.error(error);
  process.exit(1);
});
