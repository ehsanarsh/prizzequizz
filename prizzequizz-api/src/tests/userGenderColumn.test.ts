/* A NEW COLUMN MUST NOT BE ABLE TO BREAK EVERY SAVE.
 *
 * `users.save` started writing a `gender` column. Migrations are applied by
 * `npm run migrate`, which reads .sql files out of the working directory — and
 * what gets deployed is compiled JavaScript with no database/migrations folder
 * in it. So on a server whose migration was not run by hand, every single
 * users.save would raise «column "gender" does not exist»: XP awards, coin
 * spends, ticket grants, profile edits. The whole game, for a field nobody had
 * filled in yet.
 *
 * This checks the two things that keep that from happening: the column adds
 * itself, and if it cannot be added the save still goes through without it.
 *
 * Run: npx tsx src/tests/userGenderColumn.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

function find(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const p = resolve(dir, rel);
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(rel + ' not found above ' + process.cwd());
}

const repo = readFileSync(find('prizzequizz-api/src/repositories/postgresRepositories.ts'), 'utf8');

function run(): void {
  check('the column adds itself rather than waiting for a migration', () => {
    assert.match(repo, /ALTER TABLE users ADD COLUMN IF NOT EXISTS gender/,
      'nothing in the running code creates the column');
    assert.match(repo, /async save\(user: User\)[\s\S]{0,400}ensureGenderColumn\(\)/,
      'and save() must consult it before writing that column');
  });

  check('a save still works when the column cannot be created', () => {
    /* A database user without ALTER rights must cost a blank profile field,
       never a failed save. */
    const i = repo.indexOf('async save(user: User)');
    const body = repo.slice(i, i + 2000);
    const withGender = body.indexOf('banned_at,gender,updated_at');
    const without = body.indexOf('banned_at,updated_at');
    assert.ok(withGender > 0, 'the statement that writes gender exists');
    assert.ok(without > 0, 'and so does a fallback that does not');
    assert.ok(without > withGender, 'the fallback comes after the guarded path');
  });

  check('the attempt is made once, not on every save', () => {
    assert.match(repo, /_genderColumn !== 'unknown'/, 'the outcome must be remembered');
  });

  check('a failure to add it is logged, not swallowed', () => {
    assert.match(repo, /ensureGenderColumn[\s\S]{0,600}logger\.warn\('users_gender_column_unavailable'/,
      'silence here means nobody ever finds out the field is dead');
  });

  check('the migration file still exists for a fresh database', () => {
    /* Self-healing is the safety net, not the plan: a new install should get
       the column from the ordinary migration path. */
    const sql = readFileSync(find('prizzequizz-api/database/migrations/025_user_gender.sql'), 'utf8');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS gender/);
  });

  console.log(`[userGenderColumn] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
