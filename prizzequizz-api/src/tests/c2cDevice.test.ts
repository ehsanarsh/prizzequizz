/* THE PHONE, AND WHY THE SERVER BELIEVES IT.
 *
 * A forwarder posts deposits that hand over goods, so «who sent this» is the
 * entire security boundary. These tests are about the four ways that can be
 * faked and the one way it is revoked:
 *
 *   - A REPLAYED REQUEST. One captured post re-sent is a second delivery.
 *   - A TAMPERED BODY. The signature covers the bytes, so changing an amount
 *     after signing has to fail.
 *   - A STALE OR FUTURE TIMESTAMP. A captured request must expire, and a
 *     phone whose clock is hours ahead must not be able to mint requests
 *     that stay valid all day.
 *   - A GUESSED PAIRING CODE. Six digits is 10⁶, so the code has to die
 *     after a handful of tries — and the server's answer must not tell a
 *     guesser which codes exist.
 *   - REVOKING. When the operator's phone is lost, «revoked» has to mean the
 *     next request, not the next deploy.
 *
 * Run: npx tsx src/tests/c2cDevice.test.ts
 */
process.env.MATCHMAKING_WORKER = 'false';
process.env.LAST_SURVIVOR_WORKER = 'false';
process.env.LEAGUE_WORKER = 'false';
process.env.SERVER_MONITOR = 'false';
process.env.C2C_WORKER = 'false';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { signAccessToken } from '../services/tokenService.js';
import { isValidPan, saveCard } from '../services/c2c/cardService.js';
import { listPatterns } from '../services/c2c/patternStore.js';
import { listMessages, _resetMessages } from '../services/c2c/messageStore.js';
import {
  OFFLINE_AFTER_MS, PAIRING_MAX_ATTEMPTS, createPairingCode, getDevice, listDevices,
  revokeDevice, touchDevice, _resetDevices
} from '../services/c2c/deviceStore.js';
import { signPayload, SIGNATURE_WINDOW_MS, _resetNonces } from '../services/c2c/deviceAuth.js';
import { listGateways, removeGateway, saveGateway } from '../services/paymentGatewayService.js';
import { id } from '../utils/id.js';
import { resetC2c } from './c2cTestReset.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

function makePan(): string {
  const body = ('627412' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0')).slice(0, 15);
  for (let d = 0; d <= 9; d++) if (isValidPan(body + d)) return body + d;
  throw new Error('no check digit');
}

const ACCOUNT = '49302749612';
const ORDER = { kind: 'ticket' as const, tier: 'red', qty: 2 };

function sepahSms(amountRial: number): string {
  return `بانک سپه\nواريز:${amountRial.toLocaleString('en-US')}ريال\nحساب:${ACCOUNT}\nمانده:59,719,997\n2/23-20:43`;
}

async function run(): Promise<void> {
  if (process.env.DATABASE_URL) {
    const { getPgPool } = await import('../database/postgres.js');
    for (const t of ['bank_sms_messages', 'bank_sms_devices', 'bank_sms_pairings']) {
      await getPgPool().query(`DELETE FROM ${t}`).catch(() => undefined);
    }
  }
  await resetC2c();
  _resetMessages(); _resetDevices(); _resetNonces();
  for (const g of await listGateways()) await removeGateway(g.id);

  const gw = await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'live', priority: 1 });
  await saveCard({
    pan: makePan(), accountNo: ACCOUNT, bankKey: 'sepah', bankName: 'بانک سپه',
    holderName: 'مهدی', status: 'ACTIVE', priority: 1, minAmountToman: 50_000
  });

  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const url = (p: string) => `http://127.0.0.1:${port}/v1${p}`;

  /** A signed device request, exactly as the phone would build it. */
  function signed(path: string, deviceId: string, secret: string, body: unknown, opts: {
    timestamp?: string; nonce?: string; tamper?: string;
  } = {}) {
    const raw = JSON.stringify(body);
    const timestamp = opts.timestamp ?? String(Date.now());
    const nonce = opts.nonce ?? randomUUID();
    const signature = signPayload(secret, deviceId, timestamp, nonce, raw);
    return fetch(url(path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': deviceId, 'x-timestamp': timestamp,
        'x-nonce': nonce, 'x-signature': signature
      },
      /* `tamper` sends DIFFERENT bytes than were signed. */
      body: opts.tamper ?? raw
    });
  }

  const admin = (method: string, path: string, body?: unknown) =>
    fetch(url(path), {
      method,
      headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY || 'dev-admin' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  async function openPayment() {
    const uid = id();
    await repositories.users.save({
      id: uid, username: 'dv' + uid.slice(0, 8), displayName: 'دی',
      phone: '09' + String(600000000 + Math.floor(Math.random() * 99999999)),
      wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
      tickets: { green: 0, blue: 0, red: 0 }
    } as any);
    const res = await fetch(url('/orders/pay'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signAccessToken(uid)}` },
      body: JSON.stringify({ order: ORDER, method: 'gateway', gatewayId: gw.id, idempotencyKey: id() })
    });
    const d = (await res.json() as any).data;
    assert.ok(d?.sessionId, 'the payment page must open for these tests to mean anything');
    return { uid, amountRial: d.amounts.payableRial as number };
  }

  const redTickets = async (uid: string) =>
    Number(((await repositories.users.findById(uid)) as any)?.tickets?.red ?? 0);

  let deviceId = '', secret = '';

  try {
    await check('pairing needs a code the operator just made', async () => {
      const bad = await fetch(url('/bank-sms/pair'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: '000000', label: 'گوشی' })
      });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json() as any).error.code, 'PAIRING_INVALID');

      const made = (await (await admin('POST', '/admin/c2c/devices/pairing-code')).json() as any).data;
      assert.match(made.code, /^[0-9]{6}$/);
      const res = await fetch(url('/bank-sms/pair'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: made.code, label: 'گوشی روزمرهٔ اپراتور', appVersion: '1.0.0' })
      });
      assert.equal(res.status, 201);
      const d = (await res.json() as any).data;
      deviceId = d.deviceId; secret = d.secret;
      assert.ok(deviceId && secret && secret.length >= 32, 'the secret must be worth signing with');
    });

    await check('and that code cannot be used twice', async () => {
      const made = (await (await admin('POST', '/admin/c2c/devices/pairing-code')).json() as any).data;
      const first = await fetch(url('/bank-sms/pair'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: made.code })
      });
      assert.equal(first.status, 201);
      const second = await fetch(url('/bank-sms/pair'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: made.code })
      });
      assert.equal(second.status, 400, 'a one-shot code was reusable');
      await revokeDevice((await first.json() as any).data.deviceId);
    });

    await check('a guessed code dies after a handful of tries', async () => {
      /* Six digits is a million, which is guessable if the attempts are free.
       * The real defence is that they are not. */
      const made = await createPairingCode('test');
      for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
        await fetch(url('/bank-sms/pair'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pairingCode: made.code.slice(0, 5) + ((Number(made.code[5]) + 1) % 10) })
        });
      }
      /* The attempts were spent on WRONG codes. The budget belongs to the
       * WINDOW, not to the row that was typed — otherwise a guesser's codes
       * do not exist, their counters are free, and six digits is a million
       * cheap tries. So the real code is burnt too. */
      const res = await fetch(url('/bank-sms/pair'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: made.code })
      });
      assert.equal(res.status, 400, 'the code survived more than ' + PAIRING_MAX_ATTEMPTS + ' attempts');
    });

    await check('the server never says WHICH kind of wrong a code is', async () => {
      /* «Expired» told apart from «wrong» is a free bit of information: it
       * confirms a code EXISTS, which is exactly what a guesser wants. So the
       * four failures have to be indistinguishable — and that means testing
       * codes that are wrong in DIFFERENT ways, not three unknown ones. */
      const unknown = '000000';
      const expired = (await createPairingCode('test')).code;
      const used = (await createPairingCode('test')).code;
      const spent = (await createPairingCode('test')).code;

      /* Make each one wrong in its own way. */
      const past = new Date(Date.now() - 60_000).toISOString();
      if (process.env.DATABASE_URL) {
        const { getPgPool } = await import('../database/postgres.js');
        await getPgPool().query('UPDATE bank_sms_pairings SET expires_at=$2 WHERE code=$1', [expired, past]);
        await getPgPool().query('UPDATE bank_sms_pairings SET used_at=now() WHERE code=$1', [used]);
        await getPgPool().query('UPDATE bank_sms_pairings SET attempts=99 WHERE code=$1', [spent]);
      } else {
        const store = await import('../services/c2c/deviceStore.js');
        const seam = (store as any)._pairingsForTest?.() as Map<string, any> | undefined;
        assert.ok(seam, 'no way to age a pairing code on the memory driver');
        seam!.get(expired).expiresAt = past;
        seam!.get(used).usedAt = new Date().toISOString();
        seam!.get(spent).attempts = 99;
      }

      const bodies: string[] = [];
      for (const c of [unknown, expired, used, spent]) {
        const r = await fetch(url('/bank-sms/pair'), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pairingCode: c })
        });
        bodies.push(r.status + ':' + JSON.stringify((await r.json() as any).error));
      }
      assert.equal(new Set(bodies).size, 1,
        'a guesser can tell an existing code from a made-up one: ' + [...new Set(bodies)].join(' | '));
    });

    await check('a signed batch is accepted and settles a real payment', async () => {
      const p = await openPayment();
      const res = await signed('/bank-sms/transactions', deviceId, secret, {
        messages: [{ messageId: 'sms-1', sender: 'sepah bank', body: sepahSms(p.amountRial), receivedAt: new Date().toISOString() }]
      });
      assert.equal(res.status, 200);
      const r = (await res.json() as any).data.results[0];
      assert.equal(r.stored, true);
      assert.equal(r.matched, true, 'the whole chain did not run');
      assert.equal(await redTickets(p.uid), 2);
    });

    await check('the same request replayed delivers nothing a second time', async () => {
      /* The nonce is the defence. Without it, one captured post re-sent is a
       * second delivery — the message dedupe would catch THIS case, but not
       * a replay carrying a message id the server has not seen. */
      const p = await openPayment();
      const raw = JSON.stringify({ messages: [{ messageId: 'sms-replay', sender: 'sepah bank', body: sepahSms(p.amountRial) }] });
      const ts = String(Date.now()); const nonce = randomUUID();
      const sig = signPayload(secret, deviceId, ts, nonce, raw);
      const send = () => fetch(url('/bank-sms/transactions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-id': deviceId, 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig },
        body: raw
      });
      assert.equal((await send()).status, 200);
      const again = await send();
      assert.equal(again.status, 401);
      assert.equal((await again.json() as any).error.code, 'DEVICE_REPLAY');
    });

    await check('a body changed after signing is refused', async () => {
      const p = await openPayment();
      const honest = { messages: [{ messageId: 'sms-tamper', sender: 'sepah bank', body: sepahSms(p.amountRial) }] };
      const forged = JSON.stringify({ messages: [{ messageId: 'sms-tamper', sender: 'sepah bank', body: sepahSms(p.amountRial * 10) }] });
      const res = await signed('/bank-sms/transactions', deviceId, secret, honest, { tamper: forged });
      assert.equal(res.status, 401);
      assert.equal((await res.json() as any).error.code, 'DEVICE_SIGNATURE_INVALID');
      assert.equal(await redTickets(p.uid), 0);
    });

    await check('a stale request expires, and so does one from the future', async () => {
      const old = String(Date.now() - SIGNATURE_WINDOW_MS - 60_000);
      const ahead = String(Date.now() + SIGNATURE_WINDOW_MS + 60_000);
      for (const ts of [old, ahead]) {
        const res = await signed('/bank-sms/heartbeat', deviceId, secret, { queueDepth: 0 }, { timestamp: ts });
        assert.equal(res.status, 401, 'accepted a timestamp of ' + ts);
        assert.equal((await res.json() as any).error.code, 'DEVICE_AUTH_STALE');
      }
    });

    await check('someone else’s secret signs nothing', async () => {
      const res = await signed('/bank-sms/heartbeat', deviceId, 'not-the-secret', { queueDepth: 0 });
      assert.equal(res.status, 401);
      assert.equal((await res.json() as any).error.code, 'DEVICE_SIGNATURE_INVALID');
    });

    await check('the heartbeat is what makes a sleeping phone visible', async () => {
      const res = await signed('/bank-sms/heartbeat', deviceId, secret, {
        queueDepth: 4, appVersion: '1.0.1', batteryOptimized: true, lastSmsAt: new Date().toISOString()
      });
      assert.equal(res.status, 200);
      const body = (await (await admin('GET', '/admin/c2c/devices')).json() as any).data;
      const row = body.rows.find((d: any) => d.id === deviceId);
      assert.equal(row.queueDepth, 4, 'the panel cannot see the backlog');
      assert.equal(row.batteryOptimized, true);
      assert.equal(row.offline, false);
      /* The operator's phone is their DAILY phone, so Android WILL sleep the
       * forwarder. The panel has to say so rather than let a quiet device
       * look like a quiet day. */
      assert.equal(body.anyBatteryOptimized, true, 'nothing warns that the OS may sleep it');
    });

    await check('and a phone that stopped reporting is called offline', async () => {
      await touchDevice(deviceId);
      const stale = new Date(Date.now() - OFFLINE_AFTER_MS - 60_000).toISOString();
      if (process.env.DATABASE_URL) {
        const { getPgPool } = await import('../database/postgres.js');
        await getPgPool().query('UPDATE bank_sms_devices SET last_seen_at=$2 WHERE id=$1', [deviceId, stale]);
      } else {
        (await getDevice(deviceId))!;
        const store = await import('../services/c2c/deviceStore.js');
        /* No seam needed on memory: touch then rewrite through the same map. */
        const d = (await store.listDevices()).find((x) => x.id === deviceId)!;
        (d as any).lastSeenAt = stale;
      }
      const body = (await (await admin('GET', '/admin/c2c/devices')).json() as any).data;
      const row = body.rows.find((d: any) => d.id === deviceId);
      assert.equal(row.offline, true, 'a silent device looks healthy');
      assert.equal(body.anyOffline, true);
    });

    await check('revoking works on the NEXT request, not the next deploy', async () => {
      await admin('POST', `/admin/c2c/devices/${deviceId}/revoke`);
      const res = await signed('/bank-sms/heartbeat', deviceId, secret, { queueDepth: 0 });
      assert.equal(res.status, 401);
      assert.equal((await res.json() as any).error.code, 'DEVICE_UNKNOWN');
      assert.equal((await getDevice(deviceId))!.status, 'REVOKED');
    });

    await check('a credential from the phone is dropped, and the phone is told to forget it', async () => {
      /* The operator's DAILY phone receives their own رمز پویا. The app
       * filters, and the server does not trust it to have: the message is
       * dropped whole here too. `stored: true` so the device stops retrying —
       * «we refuse to keep this» is a final answer. */
      const fresh = await createPairingCode('test');
      const paired = (await (await fetch(url('/bank-sms/pair'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: fresh.code, label: 'گوشی دوم' })
      })).json() as any).data;
      const before = (await listMessages({ limit: 500 })).length;
      const res = await signed('/bank-sms/transactions', paired.deviceId, paired.secret, {
        messages: [{ messageId: 'sms-otp', sender: 'bank', body: 'رمز پویا: 483920 مبلغ 250,000 ریال' }]
      });
      const r = (await res.json() as any).data.results[0];
      assert.equal(r.dropped, true);
      assert.equal(r.stored, true, 'the device would retry a credential forever');
      assert.equal((await listMessages({ limit: 500 })).length, before, 'a credential reached the database');
    });

    await check('an oversized batch is refused rather than half-processed', async () => {
      const fresh = await createPairingCode('test');
      const paired = (await (await fetch(url('/bank-sms/pair'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: fresh.code })
      })).json() as any).data;
      const messages = Array.from({ length: 51 }, (_, i) => ({ messageId: 'big-' + i, body: 'x' }));
      const res = await signed('/bank-sms/transactions', paired.deviceId, paired.secret, { messages });
      assert.equal(res.status, 413);
      assert.equal((await listMessages({ limit: 500 })).some((m) => m.messageId.startsWith('big-')), false,
        'part of a refused batch was stored');
    });

    await check('the secret is not readable back out of the database', async () => {
      /* It is sealed, not hashed — HMAC needs it in the clear at verification
       * time — so what is checked here is that the stored form is not the
       * secret itself. A leaked table alone must not hand over signing keys. */
      const devices = await listDevices();
      const d = devices.find((x) => x.id === deviceId)!;
      assert.ok(!(d as any).secret, 'the device record carries a plain secret');
      assert.notEqual(d.secretSealed, secret, 'the secret is stored verbatim');
      assert.ok(d.secretSealed.startsWith('v1.'), 'the stored form is not sealed: ' + d.secretSealed.slice(0, 8));
      /* And the panel never sends it anywhere. */
      const body = (await (await admin('GET', '/admin/c2c/devices')).json() as any).data;
      assert.equal(JSON.stringify(body).includes(secret), false, 'the panel API leaks the device secret');
      assert.equal(/secret/i.test(JSON.stringify(body)), false, 'the panel API mentions a secret field at all');
    });

    await check('the device layer changed nothing about what happens after', async () => {
      /* It is a new way IN, not a new pipeline. The same patterns read the
       * same messages and the same settlement path delivers — and exactly
       * the messages that SHOULD be stored are, no more: a tampered batch, a
       * credential and an oversized batch all left nothing behind. */
      const pats = await listPatterns();
      assert.equal(pats.find((p) => p.bankKey === 'sepah')!.status, 'live');
      const stored = (await listMessages({ limit: 500 })).map((m) => m.messageId).sort();
      assert.deepEqual(stored, ['sms-1', 'sms-replay'],
        'the stored messages are not the ones that should be: ' + stored.join(', '));
    });
  } finally {
    server.close();
  }

  console.log(`[c2cDevice] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
