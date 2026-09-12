/* CHOOSING WHICH MODEL DOES THE WORK.
 *
 * «من نمی‌تونم مدل هوش مصنوعی رو عوض کنم.»
 *
 * Three separate things have to hold for that sentence to be false, and each
 * one of them looks identical from the panel when it breaks: the value has to
 * SAVE, it has to be the value the next run actually USES, and each stage has
 * to be able to differ from the others.
 *
 * Run: npx tsx src/tests/aiModelPick.test.ts */
import assert from 'node:assert/strict';
import { patchGameConfig } from '../services/configService.js';
import { aiModel } from '../services/aiClient.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const setPipeline = (p: any) => patchGameConfig({ questionPipeline: p });

(async () => {
  await check('a model saved in the panel is the one the next run uses', async () => {
    setPipeline({ generatorModel: 'claude-opus-5' });
    assert.equal(aiModel('generator'), 'claude-opus-5',
      'saved but not used — the panel would look like it had done nothing');
  });

  await check('and changing it again takes effect without a restart', async () => {
    setPipeline({ generatorModel: 'claude-opus-5' });
    setPipeline({ generatorModel: 'claude-sonnet-5' });
    assert.equal(aiModel('generator'), 'claude-sonnet-5');
  });

  await check('each stage can use a different model', async () => {
    setPipeline({ generatorModel: 'gen-1', reviewerModel: 'rev-2', factCheckerModel: 'fact-3' });
    assert.equal(aiModel('generator'), 'gen-1');
    assert.equal(aiModel('reviewer'), 'rev-2');
    assert.equal(aiModel('factChecker'), 'fact-3');
  });

  await check('a stage left blank falls back to the shared model, not to nothing', async () => {
    setPipeline({ generatorModel: '', reviewerModel: '', factCheckerModel: '', model: 'shared-9' });
    assert.equal(aiModel('generator'), 'shared-9');
    assert.equal(aiModel('reviewer'), 'shared-9');
  });

  await check('with nothing set at all there is still a working default', async () => {
    setPipeline({ generatorModel: '', reviewerModel: '', factCheckerModel: '', model: '' });
    assert.ok(aiModel('generator').length > 0, 'a blank model id would fail every request');
  });

  await check('a proxy’s own prefix survives exactly as typed', async () => {
    /* A token-based key needs «t-» in front of every id. If this were
       normalised, «هر مدلی را انتخاب کن» would be false for those accounts. */
    setPipeline({ generatorModel: 't-claude-sonnet-5' });
    assert.equal(aiModel('generator'), 't-claude-sonnet-5');
  });

  await check('and surrounding spaces do not become part of the id', async () => {
    setPipeline({ generatorModel: '  claude-opus-5  ' });
    assert.equal(aiModel('generator'), 'claude-opus-5',
      'a pasted id with a stray space would 404 at the provider and look like a bad key');
  });

  console.log(`[aiModelPick] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
