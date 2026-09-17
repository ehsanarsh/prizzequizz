/* TEXTING THE PLAYERS, WHERE EVERY MESSAGE IS A BILL.
 *
 * «از پنل ادمین باید بتونم به تمامی و یا بعضی از کاربران پیامک بدم.»
 *
 * A push that reaches nobody wastes nothing. An SMS run that goes out twice is
 * money, and one that goes to half the list and says it finished is worse than
 * one that refuses. So most of what is checked here is the refusing.
 *
 * Run: npx tsx src/tests/smsBroadcast.test.ts */
import assert from 'node:assert/strict';
import { previewSmsBroadcast, sendSmsBroadcast, smsParts, SmsBroadcastError, SMS_BROADCAST_MAX } from '../services/smsBroadcastService.js';
import { updateSmsConfig, listLog, addBlacklist, removeBlacklist } from '../services/smsService.js';
import { _resetFulfilmentGuard } from '../services/fulfilmentGuard.js';
import { repositories } from '../repositories/index.js';
import { id } from '../utils/id.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let seq = 700000000;
async function player(over: any = {}): Promise<{ id: string; phone: string }> {
  const uid = id();
  const phone = '09' + String(seq++);
  await repositories.users.save({
    id: uid, username: 's' + uid.slice(0, 8), displayName: 's', phone,
    wallet: 0, coins: 0, hearts: 5, xp: 0, level: 3, plan: 'free', weeklyScore: 0,
    status: 'active', tickets: {}, ...over
  } as any);
  return { id: uid, phone };
}
const uniq = () => 'b_' + id();

(async () => {
  /* Sandbox provider: dispatch succeeds without a real gateway, so «sent» is a
     real outcome here rather than a network accident. */
  await updateSmsConfig({ enabled: true, sandbox: true, provider: 'sandbox', sender: '3000' } as any);
  await _resetFulfilmentGuard();

  /* ── what one text costs ──────────────────────────────────────────── */

  await check('a short Persian text is one message', () => {
    assert.equal(smsParts('سلام'), 1);
  });

  await check('and a long one is several, because Persian is not GSM-7', () => {
    /* «۵۰۰ نفر» and «۵۰۰ پیامک» are different numbers, and the bill is the
       second one. Seventy characters fit in one Persian message, not 160. */
    assert.equal(smsParts('ا'.repeat(70)), 1);
    assert.equal(smsParts('ا'.repeat(71)), 2);
    assert.equal(smsParts('ا'.repeat(140)), 3, '67 characters per part once it splits');
  });

  await check('an English text gets the longer allowance', () => {
    assert.equal(smsParts('a'.repeat(160)), 1);
    assert.equal(smsParts('a'.repeat(161)), 2);
  });

  await check('empty text costs nothing', () => { assert.equal(smsParts(''), 0); });

  /* ── pricing it before spending it ────────────────────────────────── */

  await check('the preview prices the run in MESSAGES, not people', async () => {
    const a = await player(), b = await player();
    const plan = await previewSmsBroadcast({ userIds: [a.id, b.id] } as any, 'ا'.repeat(71));
    assert.equal(plan.reachable, 2);
    assert.equal(plan.parts, 2);
    assert.equal(plan.messages, 4, 'two people × two parts — this is what is billed');
  });

  await check('and it sends nothing at all', async () => {
    const a = await player();
    const before = (await listLog({ limit: 500 })).length;
    await previewSmsBroadcast({ userIds: [a.id] } as any, 'سلام');
    assert.equal((await listLog({ limit: 500 })).length, before, 'a preview that sends is not a preview');
  });

  await check('somebody with no phone number is counted, not silently dropped', async () => {
    const a = await player();
    const noPhone = await player({ phone: '' });
    const plan = await previewSmsBroadcast({ userIds: [a.id, noPhone.id] } as any, 'سلام');
    assert.equal(plan.noPhone, 1);
    assert.equal(plan.reachable, 1);
  });

  await check('and so is somebody on the blacklist', async () => {
    const a = await player();
    await addBlacklist(a.phone, 'test');
    try {
      const plan = await previewSmsBroadcast({ userIds: [a.id] } as any, 'سلام');
      assert.equal(plan.blacklisted, 1);
      assert.equal(plan.reachable, 0, 'they will not be texted, so they must not be priced');
    } finally { await removeBlacklist(a.phone); }
  });

  /* ── sending ──────────────────────────────────────────────────────── */

  await check('a run texts everybody in the segment', async () => {
    const a = await player(), b = await player();
    const r = await sendSmsBroadcast({ spec: { userIds: [a.id, b.id] } as any, text: 'سلام بازیکن', idempotencyKey: uniq() });
    assert.equal(r.sent, 2);
    assert.equal(r.failed, 0);
    const log = await listLog({ limit: 500 });
    assert.ok(log.some((l) => l.to.endsWith(a.phone.slice(-9))), 'no log line for the first recipient');
  });

  await check('THE SAME RUN TWICE DOES NOT BILL TWICE', async () => {
    /* A double-tapped button, or a retry after a timeout. This is the one that
       costs money if it is wrong. */
    const a = await player();
    const key = uniq();
    const first = await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'یکبار', idempotencyKey: key });
    const before = (await listLog({ limit: 500 })).length;
    const second = await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'یکبار', idempotencyKey: key });
    assert.equal(first.sent, 1);
    assert.equal(second.duplicate, true);
    assert.equal((await listLog({ limit: 500 })).length, before, 'it sent a second time');
  });

  await check('and the repeat is told what the first run did', async () => {
    const a = await player();
    const key = uniq();
    const first = await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'گزارش', idempotencyKey: key });
    const second = await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'گزارش', idempotencyKey: key });
    assert.equal(second.sent, first.sent, 'a duplicate reporting zero looks like a failure');
  });

  await check('a different run with a different key does send', async () => {
    const a = await player();
    await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'اول', idempotencyKey: uniq() });
    const r = await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'دوم', idempotencyKey: uniq() });
    assert.equal(r.sent, 1);
  });

  /* ── the refusals ─────────────────────────────────────────────────── */

  await check('an empty audience is refused, not reported as sent', async () => {
    await assert.rejects(
      () => sendSmsBroadcast({ spec: { userIds: [] } as any, text: 'سلام', idempotencyKey: uniq() }),
      (e: unknown) => e instanceof SmsBroadcastError && e.code === 'AUDIENCE_EMPTY'
    );
  });

  await check('an empty message is refused before anything is resolved', async () => {
    const a = await player();
    await assert.rejects(
      () => sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: '   ', idempotencyKey: uniq() }),
      (e: unknown) => e instanceof SmsBroadcastError && e.code === 'TEXT_REQUIRED'
    );
  });

  await check('a run with no idempotency key is refused', async () => {
    /* Without one there is nothing to stop the second click. */
    const a = await player();
    await assert.rejects(
      () => sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'سلام', idempotencyKey: '' }),
      (e: unknown) => e instanceof SmsBroadcastError && e.code === 'IDEMPOTENCY_REQUIRED'
    );
  });

  await check('a blacklisted number is blocked, and counted as blocked', async () => {
    const a = await player();
    await addBlacklist(a.phone, 'test');
    try {
      const r = await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'سلام', idempotencyKey: uniq() });
      assert.equal(r.sent, 0);
      assert.equal(r.blocked, 1, 'blocked and failed are different things and mean different fixes');
    } finally { await removeBlacklist(a.phone); }
  });

  await check('with SMS switched off nothing is sent, and it says so', async () => {
    const a = await player();
    await updateSmsConfig({ enabled: false } as any);
    try {
      const r = await sendSmsBroadcast({ spec: { userIds: [a.id] } as any, text: 'سلام', idempotencyKey: uniq() });
      assert.equal(r.sent, 0);
      assert.equal(r.blocked, 1);
    } finally { await updateSmsConfig({ enabled: true, sandbox: true, provider: 'sandbox' } as any); }
  });

  await check('the preview says whether it would be a real send or the sandbox', async () => {
    const a = await player();
    const plan = await previewSmsBroadcast({ userIds: [a.id] } as any, 'سلام');
    assert.equal(plan.live, false, 'a sandbox run must never read as the real thing');
    assert.equal(plan.smsEnabled, true);
  });

  await check('the cap is a real number and the preview flags crossing it', async () => {
    assert.ok(SMS_BROADCAST_MAX > 0 && SMS_BROADCAST_MAX <= 100000);
    const plan = await previewSmsBroadcast({ userIds: [(await player()).id] } as any, 'سلام');
    assert.equal(plan.overCap, false);
  });

  await check('AN EMPTY RECIPIENT BOX MEANS NOBODY, NOT EVERYBODY', async () => {
    /* `{userIds: []}` used to fall through to the unfiltered query and aim at
       the whole user base. Clearing the box and pressing send would have texted
       every player on the system — the single most expensive mistake this
       screen could make. */
    await player(); await player();
    const plan = await previewSmsBroadcast({ userIds: [] } as any, 'سلام');
    assert.equal(plan.audience, 0, 'an empty list resolved to the entire user base');
  });

  /* ── A RUN THAT IS NOT GOING TO WORK STOPS ────────────────────────────
     نیازپرداز, on why this server was blocked after twenty messages:
     «برخی از ریکوئست‌ها بدون پسورد سمت شرکت ارسال شده‌اند… در صورت ارسال
      ریکوئست اشتباه، آی‌پی مسدود می‌گردد.»
     It was never a rate limit. The run kept sending the SAME malformed request
     once per recipient until the provider stopped accepting anything from this
     address — «به ۲۰ تاش میفرسته، بقیه رو نمیفرسته». Every attempt after the
     first refusal was not a message that might work; it was another reason to
     stay banned. */

  await check('a settings failure stops the run instead of repeating it', async () => {
    /* A live provider with no credentials at all: every send is refused
       locally, which is exactly the shape of a bad setting. */
    await updateSmsConfig({ enabled: true, sandbox: false, provider: 'melipayamak', apiKey: '', secret: '', sender: '' } as any);
    const people = [];
    for (let i = 0; i < 12; i++) people.push(await player());
    const r = await sendSmsBroadcast({ spec: { userIds: people.map((p) => p.id) } as any, text: 'سلام', idempotencyKey: uniq() });

    assert.equal(r.sent, 0, 'nothing should have gone out');
    /* THE POINT: it did not try all twelve. */
    assert.ok(r.failed <= 5, 'it kept going after the settings were clearly wrong: ' + r.failed + ' attempts');
    assert.ok(r.notAttempted > 0, 'the rest should be reported as never attempted');
    assert.equal(r.failed + r.notAttempted, 12, `${r.failed} + ${r.notAttempted} should account for everyone`);
    /* And it says WHY, in the provider's own words — «۱۲ ناموفق» with no reason
       is the same message whether the key is wrong or the account is empty. */
    assert.ok(r.stopped && r.stopped.length > 0, 'no reason given for stopping');
    assert.match(String(r.stopped), /ناقص|رمز/, String(r.stopped));
  });

  await check('and a healthy run is not cut short by the same rule', async () => {
    /* The guard must not turn into a reason that ordinary sends stop early. */
    await updateSmsConfig({ enabled: true, sandbox: true, provider: 'sandbox', sender: '3000' } as any);
    const people = [];
    for (let i = 0; i < 12; i++) people.push(await player());
    const r = await sendSmsBroadcast({ spec: { userIds: people.map((p) => p.id) } as any, text: 'سلام', idempotencyKey: uniq() });
    assert.equal(r.sent, 12, 'everyone should have been texted');
    assert.equal(r.notAttempted, 0);
    assert.equal(r.stopped, undefined, 'a healthy run must not claim it stopped');
  });

  await check('one blacklisted number does not stop the run for everybody else', async () => {
    /* A blocked recipient is about THAT person, not about the settings — the
       run must carry on. Confusing the two would make one opt-out cancel a
       campaign. */
    await updateSmsConfig({ enabled: true, sandbox: true, provider: 'sandbox', sender: '3000' } as any);
    const people = [];
    for (let i = 0; i < 8; i++) people.push(await player());
    await addBlacklist(people[0]!.phone, 'test');
    await addBlacklist(people[3]!.phone, 'test');
    try {
      const r = await sendSmsBroadcast({ spec: { userIds: people.map((p) => p.id) } as any, text: 'سلام', idempotencyKey: uniq() });
      assert.equal(r.blocked, 2, JSON.stringify(r));
      assert.equal(r.sent, 6, 'the other six should still have been texted');
      assert.equal(r.notAttempted, 0, 'nothing should have been skipped');
    } finally {
      await removeBlacklist(people[0]!.phone); await removeBlacklist(people[3]!.phone);
    }
  });

  console.log(`[smsBroadcast] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
