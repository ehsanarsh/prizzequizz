/* THE MORNING QUESTION, AND THE THINGS THAT SHOULD NOT BE QUIET.
 *
 * Two halves, and both are about noticing:
 *
 *   THE DAILY REPORT exists for ONE number — the total that gets held against
 *   the bank's own statement. That comparison is the only thing that catches a
 *   deposit which was never real, so the figure has to be right and has to
 *   count the same rows the queue counts.
 *
 *   THE ALERTS exist because the failures here are silent. A forwarder that
 *   stopped, a deposit nobody assigned, a card with no capacity left — none of
 *   them throw, none of them log, and all of them mean a player is waiting.
 *   A system with nothing wrong must produce an EMPTY list, because warnings
 *   that are always on are warnings nobody reads.
 *
 *   AND THE RAW TEXT GOES. Every bank SMS prints the operator's account
 *   number and running balance. Once the figure is in a transaction, keeping
 *   the sentence is a liability that grows every day.
 *
 * Run: npx tsx src/tests/c2cReport.test.ts
 */
process.env.MATCHMAKING_WORKER = 'false';
process.env.LAST_SURVIVOR_WORKER = 'false';
process.env.LEAGUE_WORKER = 'false';
process.env.SERVER_MONITOR = 'false';
process.env.C2C_WORKER = 'false';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { signAccessToken } from '../services/tokenService.js';
import { isValidPan, saveCard } from '../services/c2c/cardService.js';
import { listSessions } from '../services/c2c/sessionStore.js';
import { getTransaction, insertTransaction, listTransactions } from '../services/c2c/transactionStore.js';
import { getMessage, insertMessage, listMessages, purgeOldBodies, PURGED_NOTE, _resetMessages } from '../services/c2c/messageStore.js';
import { listPatterns, setPatternStatus, _resetPatterns } from '../services/c2c/patternStore.js';
import { createPairingCode, pairDevice, touchDevice, _resetDevices } from '../services/c2c/deviceStore.js';
import { ingestSms } from '../services/c2c/matchService.js';
import { c2cAlerts, catalogueAlerts, dailyReport } from '../services/c2c/reportService.js';
import { purgeRawText } from '../services/c2c/c2cWorker.js';
import { listGateways, removeGateway, saveGateway, updatePaymentSettings } from '../services/paymentGatewayService.js';
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
const sepahSms = (rial: number) =>
  `بانک سپه\nواريز:${rial.toLocaleString('en-US')}ريال\nحساب:${ACCOUNT}\nمانده:59,719,997\n2/23-20:43`;

const alertIds = (a: Awaited<ReturnType<typeof c2cAlerts>>) => a.map((x) => x.id);

async function run(): Promise<void> {
  if (process.env.DATABASE_URL) {
    const { getPgPool } = await import('../database/postgres.js');
    for (const t of ['bank_sms_messages', 'bank_sms_devices', 'bank_sms_pairings', 'bank_sms_patterns']) {
      await getPgPool().query(`DELETE FROM ${t}`).catch(() => undefined);
    }
  }
  await resetC2c();
  _resetMessages(); _resetPatterns(); _resetDevices();
  for (const g of await listGateways()) await removeGateway(g.id);
  await updatePaymentSettings({ c2c: { rawTextRetentionDays: 30, unmatchedAlertMinutes: 30, autoApproveMaxRial: 20_000_000 } as never });

  const gw = await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'live', priority: 1 });

  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const url = (p: string) => `http://127.0.0.1:${port}/v1${p}`;
  const admin = (method: string, path: string, body?: unknown) =>
    fetch(url(path), {
      method,
      headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_KEY || 'dev-admin' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  async function openPayment() {
    const uid = id();
    await repositories.users.save({
      id: uid, username: 'rp' + uid.slice(0, 8), displayName: 'آر',
      phone: '09' + String(500000000 + Math.floor(Math.random() * 99999999)),
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
    return { uid, sessionId: d.sessionId as string, amountRial: d.amounts.payableRial as number };
  }

  try {
    await check('with no card at all, the loudest alert is that nobody can pay', async () => {
      const alerts = await c2cAlerts();
      assert.ok(alertIds(alerts).includes('c2c_no_card'), alertIds(alerts).join(', '));
      assert.equal(alerts[0]!.level, 'critical', 'a shut door is not a warning');
      assert.match(alerts[0]!.detail, /به هیچ بازیکنی پیشنهاد نمی‌شود/);
    });

    const card = await saveCard({
      pan: makePan(), accountNo: ACCOUNT, bankKey: 'sepah', bankName: 'بانک سپه',
      holderName: 'مهدی', status: 'ACTIVE', priority: 1, minAmountToman: 50_000
    });

    await check('with a card but no forwarder, it says so without crying wolf', async () => {
      const alerts = await c2cAlerts();
      assert.ok(!alertIds(alerts).includes('c2c_no_card'));
      const noDevice = alerts.find((a) => a.id === 'c2c_no_device');
      assert.ok(noDevice, alertIds(alerts).join(', '));
      /* Manual entry works, so this is information and not a fire. */
      assert.equal(noDevice!.level, 'info');
    });

    let paid: Awaited<ReturnType<typeof openPayment>>;
    await check('a settled deposit lands in the day’s figure', async () => {
      paid = await openPayment();
      const r = await ingestSms({ messageId: 'r-1', sender: 'sepah bank', body: sepahSms(paid.amountRial) });
      assert.equal(r.outcome, 'settled', r.reason ?? '');
      const rep = await dailyReport();
      assert.equal(rep.totals.settledCount, 1);
      assert.equal(rep.totals.settledRial, paid.amountRial);
      assert.match(rep.totals.settledRialText, /ریال/, 'the panel never formats money itself');
    });

    await check('and it is counted as MANUAL, because no device reported it', async () => {
      /* `ingestSms` with no deviceId is the panel's paste box. Calling that
       * automatic would flatter the forwarder's hit-rate with work a person
       * did — which is the one number this report exists to be honest about. */
      const rep = await dailyReport();
      assert.equal(rep.totals.manualCount, 1);
      assert.equal(rep.totals.autoCount, 0);
      assert.equal(rep.totals.autoRate, 0);
    });

    await check('a deposit from a paired device counts as automatic', async () => {
      const code = await createPairingCode('test');
      const paired = await pairDevice({ code: code.code, label: 'گوشی' });
      const p2 = await openPayment();
      const r = await ingestSms({
        deviceId: paired.device.id, messageId: 'r-2', sender: 'sepah bank', body: sepahSms(p2.amountRial)
      });
      assert.equal(r.outcome, 'settled', r.reason ?? '');
      const rep = await dailyReport();
      assert.equal(rep.totals.autoCount, 1);
      assert.equal(rep.totals.settledCount, 2);
      assert.equal(rep.totals.autoRate, 50, 'one of two settled without a person');
    });

    await check('a quiet day is zero percent, not a division by zero', async () => {
      /* «۰٪ خودکار» on a day with no deposits would read as a broken
       * forwarder. It has to be a real zero out of a real zero. */
      const rep = await dailyReport('2000-01-01', '2000-01-02');
      assert.equal(rep.totals.settledCount, 0);
      assert.equal(rep.totals.autoRate, 0);
      assert.equal(rep.totals.medianMinutesToSettle, null, 'no deposits means no median, not zero minutes');
      assert.deepEqual(rep.days, []);
    });

    await check('money nobody assigned becomes the loudest thing on the screen', async () => {
      /* A player has paid and is waiting. Nothing throws, nothing logs — this
       * alert is the only way anyone finds out. */
      const old = new Date(Date.now() - 90 * 60_000).toISOString();
      await insertTransaction({
        bankKey: 'sepah', amountRial: 9_999_999, destRef: ACCOUNT,
        cardId: card.id, occurredAt: old, enteredBy: 'manual'
      });
      const alerts = await c2cAlerts();
      const waiting = alerts.find((a) => a.id === 'c2c_deposit_waiting');
      assert.ok(waiting, alertIds(alerts).join(', '));
      assert.equal(waiting!.level, 'critical');
      assert.match(waiting!.detail, /یک بازیکن منتظر است/);
      assert.equal(alerts[0]!.id, 'c2c_deposit_waiting', 'it must outrank everything else');
    });

    await check('a phone that went quiet, and one the OS is allowed to sleep', async () => {
      const code = await createPairingCode('test');
      const paired = await pairDevice({ code: code.code, label: 'گوشی روزمره' });
      await touchDevice(paired.device.id, { batteryOptimized: true });
      let alerts = await c2cAlerts();
      assert.ok(alertIds(alerts).includes('c2c_battery_optimized'), alertIds(alerts).join(', '));
      assert.ok(!alertIds(alerts).includes('c2c_forwarder_offline'), 'it just reported in');

      /* Now age it past the offline threshold. */
      const stale = new Date(Date.now() - 60 * 60_000).toISOString();
      if (process.env.DATABASE_URL) {
        const { getPgPool } = await import('../database/postgres.js');
        await getPgPool().query('UPDATE bank_sms_devices SET last_seen_at=$2 WHERE id=$1', [paired.device.id, stale]);
      } else {
        const { listDevices } = await import('../services/c2c/deviceStore.js');
        const d = (await listDevices()).find((x) => x.id === paired.device.id)!;
        (d as any).lastSeenAt = stale;
      }
      alerts = await c2cAlerts();
      const off = alerts.find((a) => a.id === 'c2c_forwarder_offline');
      assert.ok(off, alertIds(alerts).join(', '));
      assert.match(off!.detail, /فقط با ثبت دستی/, 'nothing says what an offline forwarder costs');
    });

    await check('a trial pattern that has earned promotion is surfaced', async () => {
      /* Left on trial forever, every deposit from that bank needs a person —
       * which is exactly what the forwarder exists to avoid. */
      const sepah = (await listPatterns()).find((p) => p.bankKey === 'sepah')!;
      await setPatternStatus(sepah.id, 'trial');
      try {
        let alerts = await c2cAlerts();
        assert.ok(!alertIds(alerts).includes('c2c_pattern_ready'), 'it has not matched enough yet');
        const { bumpMatched } = await import('../services/c2c/patternStore.js');
        for (let i = 0; i < 5; i++) await bumpMatched(sepah.id);
        alerts = await c2cAlerts();
        const ready = alerts.find((a) => a.id === 'c2c_pattern_ready');
        assert.ok(ready, alertIds(alerts).join(', '));
        assert.equal(ready!.level, 'info');
      } finally { await setPatternStatus(sepah.id, 'live'); }
    });

    await check('a pattern with no negative sample is NEVER offered for promotion', async () => {
      /* Refah and Tejarat ship without a real withdrawal sample. However many
       * deposits they read correctly, that proves nothing about telling a
       * withdrawal apart — and promoting one would hand out goods for it. */
      const refah = (await listPatterns()).find((p) => p.bankKey === 'refah')!;
      assert.equal(refah.sampleWithdrawal, '');
      const { bumpMatched } = await import('../services/c2c/patternStore.js');
      for (let i = 0; i < 20; i++) await bumpMatched(refah.id);
      const ready = (await c2cAlerts()).find((a) => a.id === 'c2c_pattern_ready');
      assert.equal(ready?.detail?.includes('رفاه') ?? false, false,
        'a pattern unproven against a withdrawal was offered for promotion');
    });

    await check('a catalogue priced entirely under the floor is a critical alert', async () => {
      /* The floor is the BANK's rule: below it no SMS arrives, so the payment
       * could never be recognised. If nothing in the shop clears it, the whole
       * feature is built, deployed — and offered to nobody. Nothing throws;
       * players simply never see the option, and «nobody chose it» looks
       * exactly the same from the outside.
       *
       * Priced here rather than read from the live catalogue: this is a rule
       * about prices, and a test that edits the real shop to check it can only
       * fail in ways that have nothing to do with the rule. */
      const alerts = catalogueAlerts([
        { price: 40_000, currency: 'cash', category: 'tickets' },
        { price: 50_000, currency: 'cash', category: 'tickets' },
        { price: 12_000, currency: 'cash', category: 'hearts' }
      ], 50_000);
      const none = alerts.find((a) => a.id === 'c2c_nothing_payable');
      assert.ok(none, alertIds(alerts).join(', ') || 'no alert at all');
      assert.equal(none!.level, 'critical', 'a feature offered to nobody is not a warning');
      assert.match(none!.detail, /به هیچ بازیکنی پیشنهاد نمی‌شود/);
      assert.equal(alerts.length, 1, 'the ticket line only repeats what the critical line already said');
    });

    await check('an item priced EXACTLY at the floor does not count as payable', async () => {
      /* eligibleCards rejects at amountToman <= minAmountToman. A `>=` here
       * would call this shop healthy while every player saw no option. */
      const alerts = catalogueAlerts([{ price: 50_000, currency: 'cash', category: 'tickets' }], 50_000);
      assert.ok(alerts.some((a) => a.id === 'c2c_nothing_payable'),
        'a shop priced exactly at the floor was reported as payable');
    });

    await check('and a shop where only TICKETS are under the floor says so separately', async () => {
      /* A shop where a heart can be paid by transfer but a MATCH ENTRY cannot
       * is a strange shop — and that is today's real catalogue. */
      const alerts = catalogueAlerts([
        { price: 200_000, currency: 'cash', category: 'hearts' },
        { price: 50_000, currency: 'cash', category: 'tickets' },
        { price: 40_000, currency: 'cash', category: 'tickets' }
      ], 50_000);
      assert.ok(!alerts.some((a) => a.id === 'c2c_nothing_payable'), 'the shop does sell something payable');
      const noTicket = alerts.find((a) => a.id === 'c2c_no_payable_ticket');
      assert.ok(noTicket, alertIds(alerts).join(', ') || 'no alert at all');
      assert.equal(noTicket!.level, 'warn');
      assert.match(noTicket!.detail, /بستهٔ چندتایی/, 'nothing tells the operator what to do about it');
    });

    await check('a shop that sells a payable ticket is not warned about', async () => {
      const alerts = catalogueAlerts([
        { price: 200_000, currency: 'cash', category: 'hearts' },
        { price: 60_000, currency: 'cash', category: 'tickets' },
        { price: 40_000, currency: 'cash', category: 'tickets' }
      ], 50_000);
      assert.deepEqual(alerts.map((a) => a.id), [], 'a healthy catalogue was reported as broken');
    });

    await check('a shop that sells no tickets is not warned about its tickets', async () => {
      /* Without the length check the message reads «همهٔ ۰ محصول دستهٔ بلیط…» —
       * an alert about a category the shop does not have, which teaches the
       * operator to stop reading alerts. */
      assert.deepEqual(
        catalogueAlerts([{ price: 200_000, currency: 'cash', category: 'hearts' }], 50_000).map((a) => a.id),
        [], 'a shop with no ticket category was told its tickets are unpayable');
    });

    await check('coin-priced items are not mistaken for money', async () => {
      /* Only `cash` items can be paid by transfer at all. A shop selling
       * nothing for money has no card-to-card problem to report. */
      assert.deepEqual(
        catalogueAlerts([{ price: 900, currency: 'coins', category: 'tickets' }], 50_000).map((a) => a.id),
        [], 'a coin price was measured against a Toman floor');
    });

    await check('unparsed messages are surfaced with their deadline', async () => {
      await ingestSms({ messageId: 'r-unknown', sender: 'bank melli', body: 'بانک ملی\nمبلغی به حسابت نشست' });
      const alerts = await c2cAlerts();
      const un = alerts.find((a) => a.id === 'c2c_unparsed');
      assert.ok(un, alertIds(alerts).join(', '));
      assert.match(un!.detail, /۳۰ روز|30 روز/, 'nothing says how long the sample survives');
    });

    await check('raw SMS text is cleared once it has done its job', async () => {
      /* The message prints the operator's account number and running balance.
       * The ROW stays — which pattern read it, which transaction it became —
       * so nothing is untraceable; only the sentence goes. */
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const msg = await insertMessage({
        messageId: 'r-old', sender: 'sepah bank', body: sepahSms(1_234_567), receivedAt: old
      });
      assert.ok(msg && msg.body.includes('مانده'), 'the balance is in the text, which is the point');

      const purged = await purgeRawText();
      assert.ok(purged >= 1, 'nothing was purged');
      const after = await getMessage(msg!.id);
      assert.equal(after!.body, '', 'the text survived its retention window');
      assert.equal(after!.note, PURGED_NOTE, 'an empty body must not read as «arrived empty»');
      assert.equal(after!.status, msg!.status, 'the row itself is intact');
      assert.equal(after!.messageId, 'r-old');
    });

    await check('and a recent message is left alone', async () => {
      const recent = (await listMessages({ limit: 500 })).find((m) => m.messageId === 'r-unknown');
      assert.ok(recent!.body.length > 0, 'a message inside the window was purged');
    });

    await check('the report and the alerts arrive together, behind the c2c permission', async () => {
      const res = await admin('GET', '/admin/c2c/reports/daily');
      assert.equal(res.status, 200);
      const d = (await res.json() as any).data;
      assert.ok(Array.isArray(d.days) && Array.isArray(d.alerts));
      assert.equal(d.totals.settledCount, 2);
      assert.ok(d.alerts.some((a: any) => a.tab === 'c2c'), 'an alert does not say where to look');

      const { createAccount, deleteAccount } = await import('../services/adminAccountService.js');
      const acc = await createAccount({
        username: 'rep' + Math.floor(Math.random() * 1e6), password: 'x'.repeat(12), perms: ['users', 'payments']
      });
      const forbidden = await fetch(url('/admin/c2c/reports/daily'), { headers: { 'x-admin-key': acc.token } });
      assert.equal(forbidden.status, 403);
      await deleteAccount(acc.id);
    });

    await check('the day’s figure counts exactly the rows the queue calls settled', async () => {
      /* The whole value of this number is that it can be held against the
       * bank's statement. If it counted anything the queue does not, the
       * comparison would be noise and a forged deposit would hide in it. */
      const rep = await dailyReport();
      const settled = (await listTransactions({ status: 'SETTLED', limit: 500 }));
      assert.equal(rep.totals.settledCount, settled.length);
      assert.equal(rep.totals.settledRial, settled.reduce((s, t) => s + t.amountRial, 0));
    });
  } finally {
    server.close();
  }

  console.log(`[c2cReport] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
