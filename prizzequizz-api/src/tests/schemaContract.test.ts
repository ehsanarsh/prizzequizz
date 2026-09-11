/* THE DEPLOY THAT LOOKED HEALTHY.
 *
 * `db:verify` is what stands between a half-applied deploy and a player
 * pressing «پرداخت» — but it can only check what it has been told to check.
 * Its list of required tables is hand-written, and a hand-written list is one
 * pull request away from being out of date: bank_sms_pairings was added by a
 * migration and simply never added to the list. Nothing failed. `db:verify`
 * reported a healthy database, because it was not looking.
 *
 * So the list is not trusted to stay complete by anybody remembering. The
 * card-to-card feature names every table it owns c2c_* or bank_*, and this
 * test reads the migrations for that convention: every such table a migration
 * creates must be verified at deploy time. Add a table to the money path and
 * forget the list, and this fails before the deploy does.
 *
 * The same is deliberately NOT demanded of the whole database. Plenty of older
 * tables are created only by a service's own ensure-schema at runtime, and
 * listing those would make `db:verify` fail on a database that is working
 * perfectly well. The rule is scoped to the money path, where a missing table
 * is a payment that cannot be taken rather than a feature that heals itself.
 *
 * Run: npx tsx src/tests/schemaContract.test.ts   (no database needed)
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const MIGRATIONS_DIR = join(process.cwd(), 'database', 'migrations');
const VERIFIER = join(process.cwd(), 'src', 'database', 'migrationService.ts');

const migrationSql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));

const verifierSrc = readFileSync(VERIFIER, 'utf8');

/** A literal array in the verifier, read as the verifier holds it — not re-typed here. */
function namesInArray(arrayName: string): Set<string> {
  const block = verifierSrc.match(new RegExp(`const ${arrayName} = \\[([\\s\\S]*?)\\n\\];`));
  const body = block?.[1];
  assert.ok(body, `${arrayName} is no longer a literal array — this test can no longer read it`);
  return new Set([...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
}

const requiredTablesFromSource = () => namesInArray('requiredTables');
const requiredIndexesFromSource = () => namesInArray('requiredIndexes');

/** Every money-path table (c2c_ or bank_ prefixed) any migration creates, with its file. */
function moneyPathTables(): Map<string, string> {
  const found = new Map<string, string>();
  for (const { file, sql } of migrationSql) {
    for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+((?:c2c_|bank_)[a-z0-9_]+)/gi)) {
      if (!found.has(m[1]!)) found.set(m[1]!, file);
    }
  }
  return found;
}

console.log('the deploy check covers the whole money path:');

check('the migrations do create money-path tables (the scan is not silently empty)', () => {
  const tables = moneyPathTables();
  /* Without this, every assertion below passes on an empty set — the scan
   * breaking would look exactly like the rule being satisfied. */
  assert.ok(tables.size >= 7, `expected the card-to-card tables, found ${tables.size}`);
  assert.ok(tables.has('c2c_sessions'), 'c2c_sessions should have been found by the scan');
});

check('every money-path table a migration creates is verified at deploy time', () => {
  const required = requiredTablesFromSource();
  const missing = [...moneyPathTables()].filter(([t]) => !required.has(t));
  assert.deepEqual(
    missing.map(([t, f]) => `${t} (${f})`), [],
    'these tables are created by a migration but db:verify never looks for them'
  );
});

check('the verifier reads the list this test reads', () => {
  /* The regex above could drift from the real array — e.g. by missing names
   * with digits, which is how c2c_cards once vanished from a hand-run check.
   * Pin the two names that carry a digit. */
  const required = requiredTablesFromSource();
  assert.ok(required.has('c2c_cards'), 'a table name containing a digit was not read');
  assert.ok(required.has('c2c_sessions'), 'a table name containing a digit was not read');
});

console.log('the indexes that are rules are verified too:');

check('the three uniqueness rules of the money path are required, not optional', () => {
  /* These are not speed-ups. Each one is the only thing standing between the
   * feature and a duplicate: two payers told to send the same figure, one
   * deposit settling two orders, one SMS booked twice. A deploy without them
   * behaves correctly until it does not. */
  const required = requiredIndexesFromSource();
  for (const idx of ['c2c_amount_unique', 'bank_tx_session_unique', 'bank_sms_dedupe']) {
    assert.ok(required.has(idx), `${idx} must be verified at deploy time`);
  }
});

check('every unique index a money-path migration creates is verified', () => {
  const required = requiredIndexesFromSource();
  const missing: string[] = [];
  const seen: string[] = [];
  for (const { file, sql } of migrationSql) {
    for (const m of sql.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS\s+([a-z0-9_]+)\s+ON\s+((?:c2c_|bank_)[a-z0-9_]+)/gi)) {
      seen.push(m[1]!);
      if (!required.has(m[1]!)) missing.push(`${m[1]} on ${m[2]} (${file})`);
    }
  }
  /* The same guard the table scan carries, and for the same reason: a scan
   * that matches nothing reports a perfectly clean result. This assertion is
   * what makes the emptiness loud instead of reassuring. */
  assert.ok(seen.length >= 5, `the unique-index scan found ${seen.length} — it has stopped matching`);
  assert.deepEqual(missing, [], 'a uniqueness rule exists in a migration that db:verify never checks');
});

console.log(`\n[schemaContract] ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
