/* AN SMS ARRIVES AND THE PURCHASE ACTIVATES.
 *
 * The only place in the system that hands over goods with nobody watching, so
 * these tests are mostly about what it REFUSES to do. Each refusal is a way
 * this would otherwise give tickets away:
 *
 *   a pattern still on trial          the template itself is unproven
 *   a destination we do not own       the money went somewhere else
 *   a figure above the ceiling        the operator signs for the large ones
 *   a payment the player cancelled    they walked away; a person decides
 *   a released reservation            that amount may be someone else's now
 *   a replayed message                the forwarder retrying its queue
 *
 * And two that must work: the exact match settles, and a transfer made after
 * the deadline but inside the reservation window settles too — that window is
 * the whole reason it exists.
 *
 * Run: npx tsx src/tests/c2cAutoMatch.test.ts
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
import { signAccessToken } from '../services/tokenService.js';
import { repositories } from '../repositories/index.js';
import { isValidPan, saveCard } from '../services/c2c/cardService.js';
import { getSession, listSessions, setSessionStatus, _setExpiresAt } from '../services/c2c/sessionStore.js';
import { getTransaction, listTransactions } from '../services/c2c/transactionStore.js';
import { listMessages, _resetMessages } from '../services/c2c/messageStore.js';
import { listPatterns, setPatternStatus, savePattern, _resetPatterns } from '../services/c2c/patternStore.js';
import { ingestSms } from '../services/c2c/matchService.js';
import { sweepSessions } from '../services/c2c/c2cWorker.js';
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
const ORDER = { kind: 'ticket' as const, tier: 'red', qty: 2 };   // 100,000 تومان

/** Sepah's real message shape, with the figure this test needs. */
function sepahSms(amountRial: number): string {
  const grouped = amountRial.toLocaleString('en-US');
  return `بانک سپه\nواريز:${grouped}ريال\nحساب:${ACCOUNT}\nمانده:59,719,997\n2/23-20:43`;
}

async function run(): Promise<void> {
  if (process.env.DATABASE_URL) {
    const { getPgPool } = await import('../database/postgres.js');
    await getPgPool().query('DELETE FROM bank_sms_messages').catch(() => undefined);
    await getPgPool().query('DELETE FROM bank_sms_patterns').catch(() => undefined);
  }
  await resetC2c();
  _resetMessages(); _resetPatterns();
  for (const g of await listGateways()) await removeGateway(g.id);
  await updatePaymentSettings({ c2c: { autoApproveMaxRial: 20_000_000 } as never });

  const gw = await saveGateway({ name: 'کارت به کارت', type: 'card_to_card', availability: 'live', priority: 1 });
  const card = await saveCard({
    pan: makePan(), accountNo: ACCOUNT, bankKey: 'sepah', bankName: 'بانک سپه',
    holderName: 'مهدی', status: 'ACTIVE', priority: 1, minAmountToman: 50_000
  });

  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;

  async function openPayment() {
    const uid = id();
    await repositories.users.save({
      id: uid, username: 'am' + uid.slice(0, 8), displayName: 'ام',
      phone: '09' + String(400000000 + Math.floor(Math.random() * 99999999)),
      wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, plan: 'free', weeklyScore: 0,
      tickets: { green: 0, blue: 0, red: 0 }
    } as any);
    const res = await fetch(`http://127.0.0.1:${port}/v1/orders/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signAccessToken(uid)}` },
      body: JSON.stringify({ order: ORDER, method: 'gateway', gatewayId: gw.id, idempotencyKey: id() })
    });
    const d = (await res.json() as any).data;
    assert.ok(d?.sessionId, 'the payment page must open for these tests to mean anything');
    return { uid, sessionId: d.sessionId as string, intentId: d.intentId as string, amountRial: d.amounts.payableRial as number };
  }

  const redTickets = async (uid: string) =>
    Number(((await repositories.users.findById(uid)) as any)?.tickets?.red ?? 0);

  try {
    await check('the three real banks ship as patterns, and only Sepah is live', async () => {
      const pats = await listPatterns();
      assert.deepEqual(pats.map((p) => p.bankKey).sort(), ['refah', 'sepah', 'tejarat']);
      const sepah = pats.find((p) => p.bankKey === 'sepah')!;
      assert.equal(sepah.status, 'live', 'we have its real deposit AND its real withdrawal');
      for (const k of ['refah', 'tejarat']) {
        const p = pats.find((x) => x.bankKey === k)!;
        assert.equal(p.status, 'trial', `${k} has no real withdrawal sample yet`);
        assert.equal(p.sampleWithdrawal, '', 'and none was invented to make it look proven');
      }
    });

    let paid: Awaited<ReturnType<typeof openPayment>>;
    await check('an exact deposit settles the order with nobody watching', async () => {
      paid = await openPayment();
      const r = await ingestSms({ messageId: 'm1', sender: 'sepah bank', body: sepahSms(paid.amountRial) });
      assert.equal(r.outcome, 'settled', r.reason ?? '');
      assert.equal(r.sessionId, paid.sessionId);
      assert.equal(await redTickets(paid.uid), 2, 'the player has the tickets');
      assert.equal((await getSession(paid.sessionId))!.status, 'PAID');
      assert.equal((await getTransaction(r.transaction!.id))!.status, 'SETTLED');
    });

    await check('the same message replayed changes nothing', async () => {
      /* A forwarder re-sending its offline queue is doing the right thing. The
       * answer it needs is «already have it», not a second delivery. */
      const r = await ingestSms({ messageId: 'm1', sender: 'sepah bank', body: sepahSms(paid.amountRial) });
      assert.equal(r.outcome, 'duplicate');
      assert.equal(await redTickets(paid.uid), 2);
    });

    await check('a late transfer still settles, inside the reservation window', async () => {
      /* Matrix row ۱: the page gave up, the money arrived anyway, and the
       * amount is still reserved. This is what «مهلت تمام شد» must not mean. */
      const late = await openPayment();
      await _setExpiresAt(late.sessionId, new Date(Date.now() - 60_000).toISOString());
      await setSessionStatus(late.sessionId, 'EXPIRED');
      const r = await ingestSms({ messageId: 'm-late', sender: 'sepah bank', body: sepahSms(late.amountRial) });
      assert.equal(r.outcome, 'settled', r.reason ?? '');
      assert.equal(await redTickets(late.uid), 2);
    });

    await check('a trial pattern never settles by itself, however exact', async () => {
      const trial = await openPayment();
      const pats = await listPatterns();
      const sepah = pats.find((p) => p.bankKey === 'sepah')!;
      await setPatternStatus(sepah.id, 'trial');
      try {
        const r = await ingestSms({ messageId: 'm-trial', sender: 'sepah bank', body: sepahSms(trial.amountRial) });
        assert.equal(r.outcome, 'queued');
        assert.match(r.reason!, /آزمایشی/);
        assert.equal(await redTickets(trial.uid), 0, 'an unproven template must not hand anything over');
        assert.equal((await getTransaction(r.transaction!.id))!.status, 'NEW', 'and it waits in the queue');
      } finally { await setPatternStatus(sepah.id, 'live'); }
    });

    await check('a figure above the auto-approve ceiling waits for a person', async () => {
      await updatePaymentSettings({ c2c: { autoApproveMaxRial: 500_000 } as never });
      try {
        const big = await openPayment();
        const r = await ingestSms({ messageId: 'm-big', sender: 'sepah bank', body: sepahSms(big.amountRial) });
        assert.equal(r.outcome, 'queued');
        assert.match(r.reason!, /سقف/);
        assert.equal(await redTickets(big.uid), 0);
      } finally { await updatePaymentSettings({ c2c: { autoApproveMaxRial: 20_000_000 } as never }); }
    });

    await check('a deposit to an account we do not own is never ours to spend', async () => {
      const other = await openPayment();
      const body = sepahSms(other.amountRial).replace(ACCOUNT, '99999999999');
      const r = await ingestSms({ messageId: 'm-other', sender: 'sepah bank', body });
      assert.equal(r.outcome, 'queued');
      assert.match(r.reason!, /جور در نیامد/);
      assert.equal(await redTickets(other.uid), 0);
    });

    await check('a payment the player cancelled is a conversation, not a delivery', async () => {
      /* Matrix row ۱۴. The amount is still reserved — which is why the money
       * is found at all — but who gets it is a person's call. */
      const cancelled = await openPayment();
      await setSessionStatus(cancelled.sessionId, 'CANCELLED');
      const r = await ingestSms({ messageId: 'm-cancel', sender: 'sepah bank', body: sepahSms(cancelled.amountRial) });
      assert.equal(r.outcome, 'queued');
      assert.match(r.reason!, /لغو/);
      assert.equal(await redTickets(cancelled.uid), 0);
    });

    await check('a released reservation is never settled automatically', async () => {
      /* Nothing is holding that figure any more, so as far as automatic
       * matching is concerned there is no payment claiming it. It still has
       * to reach a person WITH the history attached — which is what the
       * candidate list is for. */
      const released = await openPayment();
      await setSessionStatus(released.sessionId, 'RELEASED');
      const r = await ingestSms({ messageId: 'm-rel', sender: 'sepah bank', body: sepahSms(released.amountRial) });
      assert.equal(r.outcome, 'queued');
      assert.equal(await redTickets(released.uid), 0);
      const { candidatesFor } = await import('../services/c2c/settlementService.js');
      const cands = await candidatesFor((await getTransaction(r.transaction!.id))!);
      const hit = cands.find((c) => c.session.id === released.sessionId);
      assert.ok(hit, 'the operator must still be shown which payment this figure belonged to');
      assert.match(hit!.warnings.join(' '), /آزاد شده/, 'and warned that it may be somebody else’s now');
    });

    await check('a second deposit for an order already delivered says so', async () => {
      /* Once a payment settles its figure is reusable, so the search for a
       * live one finds nothing. «هیچ پرداختی پیدا نشد» would send the operator
       * hunting for a bug that is not there. */
      const dup = await openPayment();
      await ingestSms({ messageId: 'm-dup-1', sender: 'sepah bank', body: sepahSms(dup.amountRial) });
      assert.equal(await redTickets(dup.uid), 2);
      const again = await ingestSms({ messageId: 'm-dup-2', sender: 'sepah bank', body: sepahSms(dup.amountRial) });
      assert.equal(again.outcome, 'queued');
      assert.match(again.reason!, /تکراری/);
      assert.equal(await redTickets(dup.uid), 2, 'and nothing was handed over twice');
    });

    await check('history does not drown the matcher as it piles up', async () => {
      /* A settled payment's figure can be handed out again, so every order
       * ever paid stays in the table sharing amounts with live ones. If the
       * lookup counted those, «more than one candidate» would become the
       * normal answer within a week and automatic matching would quietly
       * stop working. */
      const fresh = await openPayment();
      const sharing = (await listSessions({ amountRial: fresh.amountRial, limit: 50 }))
        .filter((x) => x.amountRial === fresh.amountRial);
      const reserving = sharing.filter((x) => ['AWAITING', 'EXPIRED', 'CANCELLED'].includes(x.status));
      assert.equal(reserving.length, 1, 'exactly one session may HOLD a figure at a time');
      const r = await ingestSms({ messageId: 'm-hist', sender: 'sepah bank', body: sepahSms(fresh.amountRial) });
      assert.equal(r.outcome, 'settled', `settled despite ${sharing.length} rows sharing the figure`);
    });

    await check('a deposit to a DIFFERENT card of ours is not this order’s money', async () => {
      /* Two cards can legitimately be handed the same figure — the uniqueness
       * index is per card. So the amount alone is not enough: the money has to
       * have landed where this payment said to send it. */
      const other = await saveCard({
        pan: makePan(), accountNo: '77001122334', bankKey: 'sepah', bankName: 'بانک سپه',
        holderName: 'مهدی', status: 'ACTIVE', priority: 9, minAmountToman: 50_000
      });
      try {
        const p = await openPayment();
        assert.equal((await getSession(p.sessionId))!.cardId, card.id, 'the payment is on the first card');
        const body = sepahSms(p.amountRial).replace(ACCOUNT, '77001122334');
        const r = await ingestSms({ messageId: 'm-cardmix', sender: 'sepah bank', body });
        assert.equal(r.outcome, 'queued');
        assert.match(r.reason!, /کارت دیگری/);
        assert.equal(await redTickets(p.uid), 0);
      } finally {
        const { removeCard } = await import('../services/c2c/cardService.js');
        await removeCard(other.id).catch(() => undefined);
      }
    });

    await check('a transfer made after the reservation ended is not settled', async () => {
      /* The window is what makes a late transfer safe to recognise. Past it,
       * the same figure may have been handed to somebody else, so settling
       * would pay the wrong person's order. */
      const p = await openPayment();
      const s0 = (await getSession(p.sessionId))!;
      const afterWindow = new Date(Date.parse(s0.reservedUntil) + 60_000).toISOString();
      const r = await ingestSms({
        messageId: 'm-toolate', sender: 'sepah bank',
        body: sepahSms(p.amountRial), receivedAt: afterWindow
      });
      assert.equal(r.outcome, 'queued');
      assert.match(r.reason!, /دورهٔ رزرو/);
      assert.equal(await redTickets(p.uid), 0);
    });

    await check('a bank’s own reject keyword vetoes a message the template would take', async () => {
      /* The template is one guard and the operator's keyword is another, on
       * purpose: at a bank whose deposit and withdrawal differ by a single
       * character, a template that is very slightly too generous is exactly
       * what the keyword is there to stop. */
      const pats = await listPatterns();
      const sepah = pats.find((p) => p.bankKey === 'sepah')!;
      assert.ok(sepah.rejectKeywords.includes('برداشت'), 'the built-in has no veto keyword');
      const p = await openPayment();
      /* A message the template DOES match, carrying the keyword. */
      const body = sepahSms(p.amountRial) + '\nبابت برداشت قبلی';
      const r = await ingestSms({ messageId: 'm-veto', sender: 'sepah bank', body });
      assert.notEqual(r.outcome, 'settled', 'the veto keyword did not stop it');
      assert.equal(await redTickets(p.uid), 0);
    });

    await check('a withdrawal notification delivers nothing', async () => {
      /* The one that would be a free ticket. Sepah's real withdrawal says
       * «برداشت» where the template says «واريز». */
      const wd = 'بانک سپه\nبرداشت:6,009,000\nحساب :‪49302749612‬\nمانده:61,528,853';
      const r = await ingestSms({ messageId: 'm-wd', sender: 'sepah bank', body: wd });
      assert.equal(r.outcome, 'parse_failed', 'a withdrawal was read as a deposit');
      assert.equal(r.transaction, undefined, 'and no deposit row was created for it');
    });

    await check('a one-time password is dropped whole — no row, no body, nothing', async () => {
      const before = (await listMessages({ limit: 500 })).length;
      const r = await ingestSms({ messageId: 'm-otp', sender: 'bank', body: 'رمز پویا: 483920 برای مبلغ 250,000 ریال' });
      assert.equal(r.outcome, 'sensitive');
      assert.equal(r.message, undefined, 'a credential must not become a row');
      assert.equal((await listMessages({ limit: 500 })).length, before, 'nothing at all was stored');
    });

    await check('a message nothing recognises is kept, because it is the sample we need', async () => {
      const r = await ingestSms({ messageId: 'm-unknown', sender: 'bank melli', body: 'بانک ملی\nواریز مبلغ 500,000 ریال به حساب شما' });
      assert.equal(r.outcome, 'parse_failed');
      assert.equal(r.message!.status, 'PARSE_FAILED');
      assert.equal(r.message!.body.includes('بانک ملی'), true, 'the text is what a new pattern gets written from');
      assert.match(r.reason!, /الگوی بانک را بساز/);
    });

    await check('the operator can add their own bank, and must prove it both ways', async () => {
      const tpl = 'بانک ملی\nواریز مبلغ {amount} ریال به حساب {account}\nمانده {balance}';
      const dep = 'بانک ملی\nواریز مبلغ 500,000 ریال به حساب 49302749612\nمانده 1,000,000';
      await assert.rejects(
        () => savePattern({ bankKey: 'melli', template: tpl, amountUnit: 'rial', sampleDeposit: dep, sampleWithdrawal: '' }),
        (e: any) => e.code === 'SAMPLE_WITHDRAWAL_REQUIRED');
      await assert.rejects(
        () => savePattern({ bankKey: 'melli', template: tpl, amountUnit: 'rial', sampleDeposit: dep, sampleWithdrawal: dep }),
        (e: any) => e.code === 'SAMPLE_WITHDRAWAL_MATCHED',
        'a pattern that reads a withdrawal as a deposit must not be saveable');
      const wd = 'بانک ملی\nبرداشت مبلغ 500,000 ریال از حساب 49302749612\nمانده 500,000';
      const r = await savePattern({ bankKey: 'melli', template: tpl, amountUnit: 'rial', sampleDeposit: dep, sampleWithdrawal: wd });
      assert.equal(r.pattern.status, 'trial', 'a new bank starts on trial, whatever it proved');
      assert.equal(r.proof.amountRial, 500_000);
      assert.match(r.proof.amountTomanText, /۵۰٬۰۰۰ تومان/, 'both units are shown so the unit cannot be set backwards');
    });

    await check('the sweeper expires dead pages and gives their amounts back', async () => {
      const a = await openPayment();
      await _setExpiresAt(a.sessionId, new Date(Date.now() - 1000).toISOString());
      const first = await sweepSessions();
      assert.ok(first.expiredIds.includes(a.sessionId), 'the deadline passed and nothing noticed');
      assert.equal((await getSession(a.sessionId))!.status, 'EXPIRED');
      /* Still reserved: an amount freed the moment the page dies would be
       * handed to the next player, and a late transfer would pay their order. */
      assert.equal(first.releasedIds.includes(a.sessionId), false);

      /* Now past the reservation too. */
      const later = Date.parse((await getSession(a.sessionId))!.reservedUntil) + 1000;
      const second = await sweepSessions(later);
      assert.ok(second.releasedIds.includes(a.sessionId), 'the slot is never given back');
      assert.equal((await getSession(a.sessionId))!.status, 'RELEASED');
    });

    await check('and a cancelled payment gets its own, shorter cooling-off', async () => {
      await updatePaymentSettings({ c2c: { cancelCooldownMinutes: 15 } as never });
      const c = await openPayment();
      await setSessionStatus(c.sessionId, 'CANCELLED');
      assert.equal((await sweepSessions()).releasedIds.includes(c.sessionId), false,
        'somebody who cancels and transfers seconds later must still be found');
      const after = Date.now() + 16 * 60_000;
      assert.ok((await sweepSessions(after)).releasedIds.includes(c.sessionId));
    });

    await check('an automatic delivery is findable in the audit afterwards', async () => {
      /* Nobody watched it happen, so the record IS the audit row. Without it
       * the operator has no way to answer «why does this player have tickets
       * they did not pay you for» — or to prove they do. */
      const { listAdminAudit } = await import('../services/adminAuditService.js');
      const rows = await listAdminAudit({ action: 'c2c_transaction_settled', limit: 50 });
      const auto = rows.filter((r: any) => r.adminId === 'auto');
      assert.ok(auto.length >= 1, 'an automatic settlement left no trace');
      const meta = auto[0]!.meta as any;
      assert.ok(meta.txId && meta.sessionId && meta.userId, 'the row does not say what was settled for whom');
      assert.equal(meta.delivered, true);
      assert.equal(meta.amountMismatch, false, 'an automatic match is exact by definition');
    });

    await check('every deposit that was not settled is sitting in the queue', async () => {
      const queued = await listTransactions({ status: 'NEW', limit: 100 });
      assert.ok(queued.length >= 5, 'refused matches must be findable, not dropped: ' + queued.length);
      assert.ok(queued.every((t) => t.amountRial > 0 && t.rawText), 'each carries its figure and its text');
    });
  } finally {
    server.close();
  }

  console.log(`[c2cAutoMatch] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
