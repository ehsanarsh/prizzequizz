import { closePgPool } from '../database/postgres.js';
import { verifyDatabase } from '../database/migrationService.js';

async function main(): Promise<void> {
  const result = await verifyDatabase();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePgPool());
