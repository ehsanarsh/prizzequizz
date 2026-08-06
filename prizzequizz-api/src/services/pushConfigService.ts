/* WEB PUSH KEYS — stored in the database, editable from the admin panel.
 *
 * These used to come only from environment variables, which sounds fine until
 * you try to set them on a running deployment: Docker cannot add an environment
 * variable to an existing container, so the container has to be recreated from
 * its compose file — and if that file no longer describes the container that is
 * actually serving traffic, recreating it takes the site down. That is not a
 * risk worth taking to store two strings.
 *
 * So keys live in `push_config`, exactly like the SMS panel's credentials, and
 * are set from the panel with no restart and no container surgery. Environment
 * variables still win when present, so an existing deployment that already has
 * them keeps working untouched.
 */
import webPush from 'web-push';
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

export interface PushConfig {
  /** 'webpush' actually sends; 'log' only records (used when nothing is set up). */
  provider: 'webpush' | 'log';
  publicKey: string;
  privateKey: string;
  /** mailto: or https: — required by the push services as a contact. */
  subject: string;
}

export interface EffectivePushConfig extends PushConfig {
  /** Where the values came from, so the panel can say so plainly. */
  source: 'env' | 'db' | 'none';
  configured: boolean;
}

export const PUSH_DEFAULT_CONFIG: PushConfig = {
  provider: 'log', publicKey: '', privateKey: '', subject: 'mailto:info@prizequiz.ir'
};

export class PushConfigError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS push_config (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  _schemaReady = true;
}

let _mem: PushConfig | null = null;

function withDefaults(raw: any): PushConfig {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    provider: c.provider === 'webpush' ? 'webpush' : 'log',
    publicKey: String(c.publicKey ?? ''),
    privateKey: String(c.privateKey ?? ''),
    subject: String(c.subject ?? PUSH_DEFAULT_CONFIG.subject)
  };
}

/** What is stored (ignoring environment variables). */
export async function loadStoredConfig(): Promise<PushConfig> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT data FROM push_config WHERE id='default'`);
    if (!rows[0]) return { ...PUSH_DEFAULT_CONFIG };
    return withDefaults(rows[0].data);
  }
  return _mem ? { ..._mem } : { ...PUSH_DEFAULT_CONFIG };
}

/* Cached because dispatch() asks for this on every single notification, and a
 * campaign to thousands of people should not be thousands of queries. Any save
 * clears it, so a key changed in the panel takes effect on the next send. */
let _cache: { at: number; value: EffectivePushConfig } | null = null;
const CACHE_MS = 30_000;

export function invalidatePushConfigCache(): void { _cache = null; }

/** What the server will actually use right now: env first, then the database. */
export async function effectivePushConfig(): Promise<EffectivePushConfig> {
  if (_cache && Date.now() - _cache.at < CACHE_MS) return _cache.value;

  const envPub = process.env.VAPID_PUBLIC_KEY || '';
  const envPriv = process.env.VAPID_PRIVATE_KEY || '';
  let out: EffectivePushConfig;

  if (envPub && envPriv) {
    out = {
      provider: process.env.PUSH_PROVIDER === 'log' ? 'log' : 'webpush',
      publicKey: envPub, privateKey: envPriv,
      subject: process.env.VAPID_SUBJECT || PUSH_DEFAULT_CONFIG.subject,
      source: 'env', configured: true
    };
  } else {
    const stored = await loadStoredConfig();
    const usable = stored.provider === 'webpush' && !!stored.publicKey && !!stored.privateKey;
    out = { ...stored, source: usable ? 'db' : 'none', configured: usable };
  }
  _cache = { at: Date.now(), value: out };
  return out;
}

/** VAPID keys are a specific shape; a truncated paste should fail here, not at
 *  send time as an opaque error from the push service. */
function validateKeys(publicKey: string, privateKey: string): void {
  const b64url = /^[A-Za-z0-9_-]+$/;
  if (publicKey && (!b64url.test(publicKey) || publicKey.length < 80)) {
    throw new PushConfigError('BAD_PUBLIC_KEY', 'کلید عمومی معتبر نیست (باید حدود ۸۷ کاراکتر و base64url باشد).');
  }
  if (privateKey && (!b64url.test(privateKey) || privateKey.length < 40)) {
    throw new PushConfigError('BAD_PRIVATE_KEY', 'کلید خصوصی معتبر نیست (باید حدود ۴۳ کاراکتر و base64url باشد).');
  }
}

export async function savePushConfig(patch: Partial<PushConfig>): Promise<PushConfig> {
  const current = await loadStoredConfig();
  const next: PushConfig = withDefaults({
    provider: patch.provider ?? current.provider,
    /* An empty string means "unchanged" so the panel can show a masked private
       key without the save wiping it. Clearing is a separate explicit action. */
    publicKey: patch.publicKey !== undefined && patch.publicKey !== '' ? patch.publicKey : current.publicKey,
    privateKey: patch.privateKey !== undefined && patch.privateKey !== '' ? patch.privateKey : current.privateKey,
    subject: patch.subject ?? current.subject
  });

  validateKeys(next.publicKey, next.privateKey);
  if (next.subject && !/^(mailto:|https:)/.test(next.subject)) {
    throw new PushConfigError('BAD_SUBJECT', 'آدرس تماس باید با mailto: یا https: شروع شود.');
  }
  if (next.provider === 'webpush' && (!next.publicKey || !next.privateKey)) {
    throw new PushConfigError('KEYS_REQUIRED', 'برای فعال کردن، هر دو کلید عمومی و خصوصی لازم است.');
  }

  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO push_config(id,data,updated_at) VALUES('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`,
      [JSON.stringify(next)]);
  } else {
    _mem = { ...next };
  }
  invalidatePushConfigCache();
  logger.info('push_config_saved', { provider: next.provider, hasKeys: !!(next.publicKey && next.privateKey) });
  return next;
}

/** Make a fresh VAPID pair. Changing keys invalidates every device already
 *  registered, so the caller is expected to warn before doing this. */
export function generateKeys(): { publicKey: string; privateKey: string } {
  const k = webPush.generateVAPIDKeys();
  return { publicKey: k.publicKey, privateKey: k.privateKey };
}

/** Safe to send to the panel: the private key never leaves the server. */
export function maskPushConfig(c: PushConfig): Omit<PushConfig, 'privateKey'> & { privateKeySet: boolean; privateKeyHint: string } {
  return {
    provider: c.provider, publicKey: c.publicKey, subject: c.subject,
    privateKeySet: !!c.privateKey,
    privateKeyHint: c.privateKey ? '••••••••' + c.privateKey.slice(-4) : ''
  };
}

/** Test seam. */
export function _resetPushConfigMemory(): void { _mem = null; invalidatePushConfigCache(); }
