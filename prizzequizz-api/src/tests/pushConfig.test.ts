/* PUSH KEYS AS CONFIGURATION.
 *
 * They were environment variables only, and that turned out to be the reason
 * push could not be switched on: Docker cannot add an environment variable to a
 * running container, and recreating the container from a compose file that no
 * longer matched it would have taken the live site down. Keys now live in the
 * database and are set from the panel.
 *
 * What matters here: an existing deployment that already sets the environment
 * must not change behaviour, a half-filled form must not silently produce a
 * server that claims to be configured, and the private key must never be handed
 * back out. */
import assert from 'node:assert/strict';
import {
  PushConfigError, effectivePushConfig, generateKeys, invalidatePushConfigCache,
  loadStoredConfig, maskPushConfig, savePushConfig, _resetPushConfigMemory
} from '../services/pushConfigService.js';
import { NotificationService } from '../services/notificationService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** Environment has to be restored between cases or one test configures the next. */
function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
    invalidatePushConfigCache();
    try { await fn(); }
    finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!;
      }
      invalidatePushConfigCache();
    }
  };
}

const KEYS = generateKeys();

async function run() {
  _resetPushConfigMemory();

  await check('a fresh install is honestly reported as not configured', withEnv(
    { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }, async () => {
      const eff = await effectivePushConfig();
      assert.equal(eff.configured, false);
      assert.equal(eff.source, 'none');
      assert.equal(eff.provider, 'log', 'nothing may be claimed as sendable');
    }));

  await check('generated keys are a real, distinct VAPID pair', async () => {
    const a = generateKeys(), b = generateKeys();
    assert.ok(a.publicKey.length > 80 && a.privateKey.length > 40);
    assert.notEqual(a.publicKey, b.publicKey, 'every generation must be new');
    assert.ok(/^[A-Za-z0-9_-]+$/.test(a.publicKey), 'base64url, no padding');
  });

  await check('saving keys from the panel switches push on with no restart', withEnv(
    { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }, async () => {
      await savePushConfig({ provider: 'webpush', publicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
      const eff = await effectivePushConfig();
      assert.equal(eff.configured, true);
      assert.equal(eff.source, 'db');
      assert.equal(eff.publicKey, KEYS.publicKey);
    }));

  await check('the notification service picks the change up without being rebuilt', withEnv(
    { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }, async () => {
      /* This service object was created before the keys were saved — the old
         code decided its provider once at module load, so it would have stayed
         on 'log' forever. */
      const svc = new NotificationService();
      const d = await svc.diagnostics();
      assert.equal(d.provider, 'webpush');
      assert.equal(d.vapidConfigured, true);
      assert.equal(d.source, 'db');
    }));

  await check('an environment already set on the container still wins', withEnv(
    { VAPID_PUBLIC_KEY: 'ENVPUB', VAPID_PRIVATE_KEY: 'ENVPRIV', VAPID_SUBJECT: 'mailto:env@x.ir' }, async () => {
      const eff = await effectivePushConfig();
      assert.equal(eff.source, 'env', 'an existing deployment must not change behaviour');
      assert.equal(eff.publicKey, 'ENVPUB');
      assert.equal(eff.subject, 'mailto:env@x.ir');
      assert.equal((await loadStoredConfig()).publicKey, KEYS.publicKey, 'and what the panel saved is still there underneath');
    }));

  await check('the private key is never sent to the panel', async () => {
    const masked: any = maskPushConfig(await loadStoredConfig());
    assert.equal(masked.privateKey, undefined, 'not even as a field');
    assert.equal(masked.privateKeySet, true);
    assert.ok(masked.privateKeyHint.startsWith('••••'));
    assert.ok(!masked.privateKeyHint.includes(KEYS.privateKey.slice(0, 8)));
  });

  await check('re-saving without re-typing the private key keeps it', async () => {
    await savePushConfig({ subject: 'mailto:new@prizequiz.ir', privateKey: '' });
    const stored = await loadStoredConfig();
    assert.equal(stored.privateKey, KEYS.privateKey, 'a masked field must not wipe the key');
    assert.equal(stored.subject, 'mailto:new@prizequiz.ir');
  });

  await check('a truncated key is refused at save time, not at send time', async () => {
    await assert.rejects(() => savePushConfig({ publicKey: 'too-short' }),
      (e: any) => e instanceof PushConfigError && e.code === 'BAD_PUBLIC_KEY');
    await assert.rejects(() => savePushConfig({ privateKey: 'nope' }),
      (e: any) => e instanceof PushConfigError && e.code === 'BAD_PRIVATE_KEY');
  });

  await check('a key pasted with spaces or a newline is refused rather than half-working', async () => {
    await assert.rejects(() => savePushConfig({ publicKey: KEYS.publicKey.slice(0, 40) + ' ' + KEYS.publicKey.slice(41) }),
      (e: any) => e instanceof PushConfigError);
  });

  await check('a bad contact address is refused', async () => {
    await assert.rejects(() => savePushConfig({ subject: 'info@prizequiz.ir' }),
      (e: any) => e instanceof PushConfigError && e.code === 'BAD_SUBJECT');
  });

  await check('turning push on with no keys is refused', async () => {
    _resetPushConfigMemory();
    await assert.rejects(() => savePushConfig({ provider: 'webpush' }),
      (e: any) => e instanceof PushConfigError && e.code === 'KEYS_REQUIRED');
  });

  await check('a saved but disabled provider does not count as configured', withEnv(
    { VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined }, async () => {
      _resetPushConfigMemory();
      await savePushConfig({ provider: 'webpush', publicKey: KEYS.publicKey, privateKey: KEYS.privateKey });
      await savePushConfig({ provider: 'log' });
      const eff = await effectivePushConfig();
      assert.equal(eff.configured, false, 'switched off means switched off');
      assert.equal((await loadStoredConfig()).publicKey, KEYS.publicKey, 'without losing the keys');
    }));

  console.log(`[pushConfig] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
