/* LISTS OF NUMBERS THAT ARE NOT PLAYERS.
 *
 * The panel could message registered players and send one test SMS. It could
 * not keep a list of leads and message it. Numbers go in one at a time —
 * number, Enter, number, Enter — so that is the primitive, and the pasted
 * block is built on it.
 *
 * The two things worth testing are the ones an operator cannot see going
 * wrong: that four spellings of one phone are one person, and that somebody
 * who asked to stop is not messaged because their number sat in a group.
 *
 * Run: npx tsx src/tests/smsGroups.test.ts
 */
import assert from 'node:assert/strict';
import {
  normalizePhone, createGroup, listGroups, renameGroup, deleteGroup,
  addNumber, addNumbers, removeNumber, listNumbers, sendToGroup, composeMessage,
  GroupError, _resetGroups
} from '../services/smsGroupService.js';
import { updateSmsConfig, addBlacklist, removeBlacklist, listLog } from '../services/smsService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function run(): Promise<void> {
  _resetGroups();
  await updateSmsConfig({ enabled: true, sandbox: true, provider: 'sandbox' as any, sender: '3000' });

  /* ── one person, one number ───────────────────────────────────────── */

  await check('four spellings of one phone are one person', async () => {
    /* Without this a list of two hundred "numbers" quietly contains the same
       forty people, and each of them gets four messages. */
    const forms = ['09121112233', '+989121112233', '00989121112233', '9121112233', '0912 111 2233', '0912-111-2233'];
    for (const f of forms) assert.equal(normalizePhone(f), '09121112233', f);
  });

  await check('Persian and Arabic digits are numbers too', async () => {
    /* They arrive from a copy-paste far more often than anyone expects. */
    assert.equal(normalizePhone('۰۹۱۲۱۱۱۲۲۳۳'), '09121112233');
    assert.equal(normalizePhone('٠٩١٢١١١٢٢٣٣'), '09121112233');
  });

  await check('something that is not a mobile number is refused', async () => {
    for (const bad of ['', '123', '0212223344', '0912111223', '091211122334', 'سلام']) {
      assert.equal(normalizePhone(bad), '', bad);
    }
  });

  /* ── the Enter key ────────────────────────────────────────────────── */

  await check('a number is added one at a time', async () => {
    _resetGroups();
    const g = await createGroup('لیست اول');
    const r = await addNumber(g.id, '09121112233');
    assert.deepEqual([r.added, r.duplicate, r.phone], [true, false, '09121112233']);
    assert.equal((await listNumbers(g.id)).length, 1);
  });

  await check('typing the same number twice is a slip, not an error', async () => {
    _resetGroups();
    const g = await createGroup('لیست');
    await addNumber(g.id, '09121112233');
    const again = await addNumber(g.id, '+989121112233');   // same person, different spelling
    assert.deepEqual([again.added, again.duplicate], [false, true]);
    assert.equal((await listNumbers(g.id)).length, 1, 'still one person');
  });

  await check('a bad number is rejected with a reason, and nothing is stored', async () => {
    _resetGroups();
    const g = await createGroup('لیست');
    await assert.rejects(
      () => addNumber(g.id, '12345'),
      (e: unknown) => e instanceof GroupError && e.code === 'PHONE_INVALID'
    );
    assert.equal((await listNumbers(g.id)).length, 0);
  });

  await check('adding to a group that does not exist is refused', async () => {
    await assert.rejects(
      () => addNumber('no-such-group', '09121112233'),
      (e: unknown) => e instanceof GroupError && e.code === 'GROUP_NOT_FOUND'
    );
  });

  await check('a pasted block goes through the same rules', async () => {
    _resetGroups();
    const g = await createGroup('لیست');
    const r = await addNumbers(g.id, '09121112233\n۰۹۱۲۱۱۱۲۲۳۳\n09351112233, 12345\n\n+989121112233');
    assert.equal(r.added, 2, 'two distinct people');
    assert.equal(r.duplicates, 2, 'two repeats of the first');
    assert.deepEqual(r.invalid, ['12345']);
  });

  /* ── groups ───────────────────────────────────────────────────────── */

  await check('groups are created, renamed, counted and deleted', async () => {
    _resetGroups();
    const a = await createGroup('گروه الف');
    await createGroup('گروه ب');
    await addNumber(a.id, '09121112233');
    let all = await listGroups();
    assert.equal(all.length, 2);
    assert.equal(all.find((g) => g.id === a.id)!.count, 1, 'the count is real');
    assert.equal(await renameGroup(a.id, 'گروه تازه'), true);
    all = await listGroups();
    assert.equal(all.find((g) => g.id === a.id)!.name, 'گروه تازه');
    assert.equal(await deleteGroup(a.id), true);
    assert.equal((await listGroups()).length, 1);
    assert.equal((await listNumbers(a.id)).length, 0, 'its numbers went with it');
  });

  await check('a group must have a name', async () => {
    await assert.rejects(() => createGroup('   '), (e: unknown) => e instanceof GroupError && e.code === 'NAME_REQUIRED');
  });

  await check('a number can be taken out again', async () => {
    _resetGroups();
    const g = await createGroup('لیست');
    await addNumber(g.id, '09121112233');
    assert.equal(await removeNumber(g.id, '+989121112233'), true, 'found by any spelling');
    assert.equal((await listNumbers(g.id)).length, 0);
  });

  /* ── the message ──────────────────────────────────────────────────── */

  await check('the site link is appended once, and not twice', async () => {
    assert.equal(composeMessage('سلام', 'https://prizequiz.ir'), 'سلام\nhttps://prizequiz.ir');
    /* An operator who already pasted the link into the text should not pay for
       it twice in a 70-character message. */
    assert.equal(composeMessage('سلام https://prizequiz.ir', 'https://prizequiz.ir'), 'سلام https://prizequiz.ir');
    assert.equal(composeMessage('سلام', ''), 'سلام');
  });

  await check('sending to a group reaches everybody in it', async () => {
    _resetGroups();
    const g = await createGroup('لیست');
    await addNumbers(g.id, '09121112233 09351112233 09901112233');
    const r = await sendToGroup({ groupId: g.id, text: 'به پرایز کوییز سر بزن', link: 'https://prizequiz.ir' });
    assert.equal(r.total, 3);
    assert.equal(r.sent, 3);
    assert.equal(r.failed, 0);
    assert.match(r.sample, /prizequiz\.ir/, 'the link is in what was sent');
  });

  await check('somebody who asked to stop is NOT messaged', async () => {
    /* Two layers hold this: sendSms refuses a blacklisted number outright, and
       sendToGroup also filters before the send so the count it reports is the
       count of people who will really receive it. The assertion below is on
       the LOG, not on the counter — a counter can say "skipped" while a
       message goes out, and it is the message that matters. */
    _resetGroups();
    const g = await createGroup('لیست');
    await addNumbers(g.id, '09121112233 09351112233');
    await addBlacklist('09121112233', 'تست');
    try {
      const r = await sendToGroup({ groupId: g.id, text: 'یک پیام یکتا ' + Date.now() });
      assert.equal(r.total, 2);
      assert.equal(r.sent, 1, 'only the one who did not opt out');
      const theirs = await listLog({ recipient: '09121112233', limit: 20 });
      assert.equal(theirs.filter((l) => l.status === 'sent' && l.body === r.sample).length, 0,
        'nothing was actually delivered to the number that opted out');
      const others = await listLog({ recipient: '09351112233', limit: 20 });
      assert.ok(others.some((l) => l.status === 'sent' && l.body === r.sample), 'and the other person did get it');
    } finally { await removeBlacklist('09121112233'); }
  });

  await check('an empty group and an empty message are both refused', async () => {
    _resetGroups();
    const g = await createGroup('خالی');
    await assert.rejects(() => sendToGroup({ groupId: g.id, text: 'سلام' }), (e: unknown) => e instanceof GroupError && e.code === 'GROUP_EMPTY');
    await addNumber(g.id, '09121112233');
    await assert.rejects(() => sendToGroup({ groupId: g.id, text: '   ' }), (e: unknown) => e instanceof GroupError && e.code === 'TEXT_REQUIRED');
  });

  await check('every message lands in the panel’s log', async () => {
    _resetGroups();
    const g = await createGroup('لیست');
    await addNumber(g.id, '09121112233');
    await sendToGroup({ groupId: g.id, text: 'یک پیام' });
    const log = await listLog({ recipient: '09121112233', limit: 5 });
    assert.equal(log[0]!.templateKey, 'group_broadcast');
  });

  console.log(`[smsGroups] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
