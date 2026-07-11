import { closePgPool } from '../database/postgres.js';
import { getMigrationStatus } from '../database/migrationService.js';

async function main(): Promise<void> {
  const rows = await getMigrationStatus();
  if (!rows.length) {
    console.log('[db-status] DATABASE_URL not configured or no migrations found.');
    return;
  }
  for (const row of rows) {
    console.log(`${row.applied ? '✓' : '…'} ${row.version}${row.appliedAt ? ` @ ${row.appliedAt}` : ''}`);
  }
  const pending = rows.filter((row) => !row.applied).length;
  console.log(`[db-status] ${rows.length - pending}/${rows.length} applied, ${pending} pending`);
  if (pending) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePgPool());
