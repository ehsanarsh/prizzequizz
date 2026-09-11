/* THE FORWARDER DEVICES.
 *
 * A device is anything that can HMAC-sign a request — deliberately not «the
 * Android app». The operator's phone is the first client; a script on a Mac
 * reading forwarded messages could be the second; neither needs a line of
 * server code changed. That matters because iOS has NO SMS-reading API at
 * all, so an iPhone can never be a forwarder directly and any iPhone story
 * has to arrive as a different KIND of client.
 *
 * THE SECRET IS SHOWN ONCE AND STORED ENCRYPTED. It cannot be hashed: the
 * device signs each request with HMAC and the server must recompute that
 * signature, which needs the same secret in the clear. So it is sealed with a
 * key from the environment instead — an attacker then needs the database AND
 * the deploy's environment. A device that loses its secret is re-paired, not
 * recovered.
 *
 * PAIRING IS A SHORT-LIVED, ONE-SHOT CODE. Six digits is guessable given
 * enough tries, so the code dies after ten minutes, after five wrong
 * attempts, or the moment it is used — whichever comes first.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { openSecret, sealSecret } from './secretBox.js';
import { getPgPool } from '../../database/postgres.js';
import { id } from '../../utils/id.js';
import { logger } from '../logger.js';

export const DEVICE_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** How long a pairing code is worth typing. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** Wrong guesses before the code dies. Six digits is 10⁶; five tries is not. */
export const PAIRING_MAX_ATTEMPTS = 5;
/** No heartbeat for this long and the panel calls the device offline. */
export const OFFLINE_AFTER_MS = 15 * 60_000;

export interface ForwarderDevice {
  id: string;
  label: string;
  status: DeviceStatus;
  appVersion: string;
  /** Sealed, never plain. Read back only to verify a signature. */
  secretSealed: string;
  lastSeenAt: string | null;
  lastSmsAt: string | null;
  queueDepth: number;
  /** The phone says whether Android is allowed to sleep it. On a daily-use
   *  phone this is the single best predictor of messages arriving late. */
  batteryOptimized: boolean;
  messagesReceived: number;
  pairedAt: string;
  revokedAt: string | null;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
  attempts: number;
  usedAt: string | null;
  createdBy: string;
}

export class DeviceError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DeviceError'; }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

let _schemaReady = false;
export async function ensureDeviceSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_sms_devices (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      app_version TEXT NOT NULL DEFAULT '',
      secret_enc TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ,
      last_sms_at TIMESTAMPTZ,
      queue_depth INT NOT NULL DEFAULT 0,
      battery_optimized BOOLEAN NOT NULL DEFAULT false,
      messages_received INT NOT NULL DEFAULT 0,
      paired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS bank_sms_devices_seen ON bank_sms_devices(status, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS bank_sms_pairings (
      code TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      used_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  _schemaReady = true;
}

const memDevices = new Map<string, ForwarderDevice>();
const memPairings = new Map<string, PairingCode>();

function rowToDevice(r: any): ForwarderDevice {
  return {
    id: r.id,
    label: r.label ?? '',
    status: r.status === 'REVOKED' ? 'REVOKED' : 'ACTIVE',
    appVersion: r.app_version ?? '',
    secretSealed: r.secret_enc,
    lastSeenAt: r.last_seen_at ? (r.last_seen_at.toISOString?.() ?? String(r.last_seen_at)) : null,
    lastSmsAt: r.last_sms_at ? (r.last_sms_at.toISOString?.() ?? String(r.last_sms_at)) : null,
    queueDepth: Number(r.queue_depth ?? 0),
    batteryOptimized: r.battery_optimized === true,
    messagesReceived: Number(r.messages_received ?? 0),
    pairedAt: r.paired_at?.toISOString?.() ?? String(r.paired_at),
    revokedAt: r.revoked_at ? (r.revoked_at.toISOString?.() ?? String(r.revoked_at)) : null
  };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/** Six digits, from a real random source — not Math.random. */
export async function createPairingCode(createdBy = ''): Promise<PairingCode> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const p: PairingCode = {
    code,
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
    attempts: 0, usedAt: null, createdBy
  };
  const pool = pg();
  if (pool) {
    await ensureDeviceSchema(pool);
    await pool.query(
      `INSERT INTO bank_sms_pairings(code,expires_at,created_by) VALUES($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET expires_at=$2, attempts=0, used_at=NULL, created_by=$3`,
      [p.code, p.expiresAt, createdBy]);
  } else {
    memPairings.set(code, p);
  }
  logger.info('bank_sms_pairing_created', { createdBy });
  return p;
}

export interface PairResult { device: ForwarderDevice; secret: string }

/**
 * Redeem a pairing code for a device identity.
 *
 * Every failure path burns an attempt, including an expired or already-used
 * code: otherwise a guesser learns which codes EXIST by how the server
 * answers, and «this one is expired» narrows the space for free.
 */
export async function pairDevice(input: { code: string; label?: string; appVersion?: string }): Promise<PairResult> {
  const code = String(input.code ?? '').trim();
  const pool = pg();
  const now = Date.now();

  const record = await readPairing(code);
  const usable = !!record
    && !record.usedAt
    && record.attempts < PAIRING_MAX_ATTEMPTS
    && Date.parse(record.expiresAt) > now;

  if (!usable) {
    /* A WRONG GUESS BURNS EVERY LIVE CODE, not the row it aimed at.
     *
     * Counting attempts against the code that was TYPED is no defence at all:
     * a guesser's wrong codes do not exist, so their counters are free and
     * six digits is a million cheap tries. The budget therefore belongs to
     * the window, not to the code — five failures anywhere and every
     * outstanding code dies, whoever they were aimed at.
     *
     * The cost is that five of the operator's own typos also kill the code.
     * That is the right trade: generating another is one click, and the
     * error message already says to. */
    await burnLivePairings();
    logger.warn('bank_sms_pairing_rejected', {
      why: !record ? 'unknown' : record.usedAt ? 'already_used'
        : record.attempts >= PAIRING_MAX_ATTEMPTS ? 'too_many_attempts' : 'expired'
    });
    /* One message for every failure. «Wrong code» told apart from «expired
     * code» is a free bit of information for whoever is guessing. */
    throw new DeviceError('PAIRING_INVALID', 'کد جفت‌سازی نامعتبر یا منقضی است. از پنل یک کد تازه بگیر.');
  }

  /* 32 bytes: this signs every deposit the device ever reports. */
  const secret = randomBytes(32).toString('base64url');
  const nowIso = new Date(now).toISOString();
  const device: ForwarderDevice = {
    id: id(),
    label: String(input.label ?? '').slice(0, 120),
    status: 'ACTIVE',
    appVersion: String(input.appVersion ?? '').slice(0, 40),
    secretSealed: sealSecret(secret),
    lastSeenAt: nowIso, lastSmsAt: null, queueDepth: 0,
    batteryOptimized: false, messagesReceived: 0,
    pairedAt: nowIso, revokedAt: null
  };

  if (pool) {
    /* Claim the code conditionally: two phones racing the same code produce
     * exactly one device, not two that both think they are paired. */
    const { rowCount } = await pool.query(
      `UPDATE bank_sms_pairings SET used_at=$2 WHERE code=$1 AND used_at IS NULL`, [code, nowIso]);
    if (!rowCount) throw new DeviceError('PAIRING_INVALID', 'کد جفت‌سازی نامعتبر یا منقضی است. از پنل یک کد تازه بگیر.');
    await pool.query(
      `INSERT INTO bank_sms_devices(id,label,status,app_version,secret_enc,last_seen_at,paired_at)
       VALUES($1,$2,$3,$4,$5,$6,$6)`,
      [device.id, device.label, device.status, device.appVersion, device.secretSealed, nowIso]);
  } else {
    const p = memPairings.get(code)!;
    if (p.usedAt) throw new DeviceError('PAIRING_INVALID', 'کد جفت‌سازی نامعتبر یا منقضی است. از پنل یک کد تازه بگیر.');
    p.usedAt = nowIso;
    memDevices.set(device.id, device);
  }
  logger.info('bank_sms_device_paired', { deviceId: device.id, label: device.label });
  /* The ONLY time the secret exists outside the device. */
  return { device, secret };
}

async function readPairing(code: string): Promise<PairingCode | null> {
  const pool = pg();
  if (pool) {
    await ensureDeviceSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM bank_sms_pairings WHERE code=$1`, [code]);
    if (!rows[0]) return null;
    return {
      code: rows[0].code,
      expiresAt: rows[0].expires_at.toISOString(),
      attempts: Number(rows[0].attempts),
      usedAt: rows[0].used_at?.toISOString() ?? null,
      createdBy: rows[0].created_by ?? ''
    };
  }
  const p = memPairings.get(code);
  return p ? { ...p } : null;
}

/** Spend one attempt from every code that is still live. */
async function burnLivePairings(): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureDeviceSchema(pool);
    await pool.query(
      `UPDATE bank_sms_pairings SET attempts = attempts + 1 WHERE used_at IS NULL AND expires_at > now()`);
    return;
  }
  const now = Date.now();
  for (const p of memPairings.values()) {
    if (!p.usedAt && Date.parse(p.expiresAt) > now) p.attempts += 1;
  }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function getDevice(deviceId: string): Promise<ForwarderDevice | null> {
  const pool = pg();
  if (pool) {
    await ensureDeviceSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM bank_sms_devices WHERE id=$1`, [deviceId]);
    return rows[0] ? rowToDevice(rows[0]) : null;
  }
  const d = memDevices.get(deviceId);
  return d ? { ...d } : null;
}

export async function listDevices(): Promise<ForwarderDevice[]> {
  const pool = pg();
  if (pool) {
    await ensureDeviceSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM bank_sms_devices ORDER BY paired_at DESC`);
    return rows.map(rowToDevice);
  }
  return [...memDevices.values()].sort((a, b) => (a.pairedAt > b.pairedAt ? -1 : 1));
}

/**
 * The device and its secret, ready to verify a signature — or nothing.
 *
 * A REVOKED device is refused here rather than merely hidden from the panel:
 * revoking is what the operator does when a phone is lost, and it has to take
 * effect on the device's next request, not on the next deploy.
 */
export async function openDevice(deviceId: string): Promise<{ device: ForwarderDevice; secret: string } | null> {
  const device = await getDevice(deviceId);
  if (!device || device.status !== 'ACTIVE') return null;
  const secret = openSecret(device.secretSealed);
  if (!secret) {
    /* The row exists but its secret cannot be opened — a rotated key, or a
     * tampered ciphertext. Either way this device cannot be trusted to speak,
     * and the operator needs to know rather than watch it silently stop. */
    logger.error('bank_sms_device_secret_unreadable', { deviceId });
    return null;
  }
  return { device, secret };
}

export async function touchDevice(deviceId: string, patch: {
  appVersion?: string; queueDepth?: number; batteryOptimized?: boolean; lastSmsAt?: string; received?: number;
} = {}): Promise<ForwarderDevice | null> {
  const now = new Date().toISOString();
  const pool = pg();
  if (pool) {
    await ensureDeviceSchema(pool);
    const { rows } = await pool.query(
      `UPDATE bank_sms_devices SET
         last_seen_at = $2,
         app_version = COALESCE($3, app_version),
         queue_depth = COALESCE($4, queue_depth),
         battery_optimized = COALESCE($5, battery_optimized),
         last_sms_at = GREATEST(last_sms_at, $6),
         messages_received = messages_received + $7
       WHERE id=$1 RETURNING *`,
      [deviceId, now, patch.appVersion ?? null, patch.queueDepth ?? null,
       patch.batteryOptimized ?? null, patch.lastSmsAt ?? null, Math.max(0, patch.received ?? 0)]);
    return rows[0] ? rowToDevice(rows[0]) : null;
  }
  const d = memDevices.get(deviceId);
  if (!d) return null;
  d.lastSeenAt = now;
  if (patch.appVersion != null) d.appVersion = patch.appVersion;
  if (patch.queueDepth != null) d.queueDepth = patch.queueDepth;
  if (patch.batteryOptimized != null) d.batteryOptimized = patch.batteryOptimized;
  if (patch.lastSmsAt && (!d.lastSmsAt || patch.lastSmsAt > d.lastSmsAt)) d.lastSmsAt = patch.lastSmsAt;
  d.messagesReceived += Math.max(0, patch.received ?? 0);
  return { ...d };
}

/** Immediate and irreversible. A re-paired phone is a NEW device row. */
export async function revokeDevice(deviceId: string): Promise<ForwarderDevice | null> {
  const now = new Date().toISOString();
  const pool = pg();
  if (pool) {
    await ensureDeviceSchema(pool);
    const { rows } = await pool.query(
      `UPDATE bank_sms_devices SET status='REVOKED', revoked_at=$2 WHERE id=$1 RETURNING *`, [deviceId, now]);
    if (rows[0]) logger.warn('bank_sms_device_revoked', { deviceId });
    return rows[0] ? rowToDevice(rows[0]) : null;
  }
  const d = memDevices.get(deviceId);
  if (!d) return null;
  d.status = 'REVOKED'; d.revokedAt = now;
  logger.warn('bank_sms_device_revoked', { deviceId });
  return { ...d };
}

/** «Has it gone quiet?» — the question a daily-use phone makes urgent. */
export function isOffline(device: ForwarderDevice, now = Date.now()): boolean {
  if (device.status !== 'ACTIVE') return false;
  if (!device.lastSeenAt) return true;
  return now - Date.parse(device.lastSeenAt) > OFFLINE_AFTER_MS;
}

/** Test seams. */
export function _pairingsForTest(): Map<string, PairingCode> { return memPairings; }
export function _resetDevices(): void { memDevices.clear(); memPairings.clear(); _schemaReady = false; }

