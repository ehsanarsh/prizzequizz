/* A SECRET THE SERVER MUST BE ABLE TO READ BACK.
 *
 * A device signs each request with HMAC, so the server has to recompute the
 * same signature — which means it needs the same secret, in the clear, at
 * verification time. A password hash is the wrong tool here: it is one-way on
 * purpose, and one-way is exactly what HMAC cannot use.
 *
 * So the secret is ENCRYPTED rather than hashed, with a key that lives in the
 * environment and not in the database. That moves the threat from «one leaked
 * table hands over credentials that can sign deposits» to «an attacker needs
 * the database AND the deploy's environment». It does not make the row
 * harmless, and nothing here pretends otherwise — which is why a lost device
 * is re-paired rather than recovered, and why revoking works on the next
 * request rather than the next deploy.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
 * instead of yielding a different secret.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { logger } from '../logger.js';

const VERSION = 'v1';

/* Same shape as the webhook secret already in this codebase: required in
 * production, a loud fallback elsewhere, so a dev machine works and a real
 * deploy cannot quietly ship with a known key. */
function keyMaterial(): Buffer {
  const raw = process.env.DEVICE_SECRET_KEY;
  if (!raw && process.env.NODE_ENV === 'production') {
    logger.error('device_secret_key_missing', { hint: 'set DEVICE_SECRET_KEY' });
  }
  /* Hashed to 32 bytes so any length of passphrase works — the key is the
   * secret, not its formatting. */
  return createHash('sha256').update(raw || 'dev-device-secret-key').digest();
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

/**
 * Open a sealed secret, or return null.
 *
 * Null rather than throwing: the caller is always «is this device allowed to
 * speak», and a secret that cannot be opened — a rotated key, a corrupted
 * row, a tampered ciphertext — is the same answer as a wrong one. Throwing
 * would turn a bad row into a 500 for every request the device makes.
 */
export function openSecret(sealed: string): string | null {
  try {
    const [version, ivB64, tagB64, encB64] = String(sealed).split('.');
    if (version !== VERSION || !ivB64 || !tagB64 || !encB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
