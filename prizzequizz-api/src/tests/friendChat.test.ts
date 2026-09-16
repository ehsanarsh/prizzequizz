/* THE CHAT THAT STOPPED SHOWING NEW MESSAGES.
 *
 * «کلی چت کردیم، تو بازی دیگه پیاممون نمی‌ره به هم. این چه باگیه؟»
 *
 * It was `ORDER BY created_at ASC LIMIT 200` — the first two hundred messages
 * ever sent. Under two hundred, perfect. From the two hundred and first, the
 * screen shows the START of the conversation and every new message is
 * invisible. The messages were saved, delivered and pushed; they were simply
 * never drawn, which from the outside is the same as «not going through».
 *
 * So the test is about the SHAPE of a long conversation, and the number that
 * matters is «more than a page». A test with five messages in it would have
 * passed against the bug — which is why there wasn't one.
 *
 * Run: DATABASE_URL=postgres://postgres@localhost:55432/pztest npx tsx src/tests/friendChat.test.ts
 */
import assert from 'node:assert/strict';
import { listChat, sendChat, CHAT_PAGE } from '../services/friendChatService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

if (!process.env.DATABASE_URL) {
  console.log('  — skipped: this is a claim about a query, which needs the database that runs it');
  console.log('[friendChat] 0 passed, 0 failed');
  process.exit(0);
}

const A = 'dddddddd-0000-4000-8000-00000000000a';
const B = 'dddddddd-0000-4000-8000-00000000000b';

(async () => {
  const { getPgPool } = await import('../database/postgres.js');
  const pool = getPgPool();

  const wipe = async () => {
    await pool.query(`DELETE FROM friend_messages WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])`, [[A, B]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[A, B]]);
  };
  await wipe();
  await pool.query(`INSERT INTO users(id, phone, username, display_name) VALUES ($1,'09121110001','chat-a','آ'), ($2,'09121110002','chat-b','ب')`, [A, B]);

  /* A conversation longer than one page, with a known order: message N was sent
     N minutes ago, so «the newest» is a fact and not a guess. */
  const TOTAL = CHAT_PAGE + 50;
  const rows: string[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const from = i % 2 === 0 ? A : B, to = i % 2 === 0 ? B : A;
    rows.push(`('${from}','${to}','m${i}', now() - interval '${TOTAL - i} minutes')`);
  }
  await pool.query(`INSERT INTO friend_messages(sender_id, recipient_id, body, created_at) VALUES ${rows.join(',')}`);

  await check('a long conversation shows its END, not its beginning', async () => {
    const page = await listChat(A, B);
    const bodies = page.messages.map((m) => m.body);
    assert.equal(bodies.length, CHAT_PAGE, 'a different number of messages came back');
    /* THE BUG, stated exactly: with `ASC LIMIT 200` this is «m0». */
    assert.equal(bodies[bodies.length - 1], 'm' + (TOTAL - 1),
      'the newest message is not on the screen — it ends at ' + bodies[bodies.length - 1]);
    assert.equal(bodies[0], 'm' + (TOTAL - CHAT_PAGE), 'the page does not start where it should');
  });

  await check('and they are in reading order, oldest at the top', async () => {
    const page = await listChat(A, B);
    const at = page.messages.map((m) => String(m.at));
    const sorted = [...at].sort();
    assert.deepEqual(at, sorted, 'the messages came back newest-first');
  });

  await check('a message sent now appears straight away', async () => {
    await pool.query(`INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES ($1,$2,'تازه')`, [B, A]);
    const page = await listChat(A, B);
    assert.equal(page.messages[page.messages.length - 1]!.body, 'تازه',
      'the newest message is still not shown after two hundred');
  });

  await check('«mine» is decided per reader, not stored in the row', async () => {
    const forA = await listChat(A, B);
    const forB = await listChat(B, A);
    const lastA = forA.messages[forA.messages.length - 1]!;
    const lastB = forB.messages[forB.messages.length - 1]!;
    assert.equal(lastA.body, lastB.body, 'the two are not looking at the same message');
    assert.notEqual(lastA.mine, lastB.mine, 'the same message is «mine» to both of them');
  });

  /* ── POLLING ──────────────────────────────────────────────────────────── */

  await check('a poll does not keep handing back the message it just saw', async () => {
    /* Postgres keeps microseconds; a JavaScript Date keeps milliseconds. If
       `at` goes out through a Date, 20:15:30.123456 comes back as .123 — which
       is EARLIER than the message it came from, so `created_at > at` is true
       for that very message and every poll returns the last one again, for
       ever. The chat would fill with duplicates of whatever was said last. */
    const page = await listChat(A, B);
    const last = page.messages[page.messages.length - 1]!;
    assert.ok(/\.\d{6}Z$/.test(String(last.at)),
      'the timestamp is not precise enough to be handed back: ' + last.at);
    const again = await listChat(A, B, String(last.at));
    assert.equal(again.messages.length, 0, 'polling returned the same message again: ' +
      again.messages.map((m) => m.body).join(','));
  });

  await check('asking for what is new returns only what is new', async () => {
    const page = await listChat(A, B);
    const last = String(page.messages[page.messages.length - 1]!.at);
    const nothing = await listChat(A, B, last);
    assert.equal(nothing.messages.length, 0, 'a poll with nothing new returned ' + nothing.messages.length + ' messages');
    await pool.query(`INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES ($1,$2,'بعدی')`, [B, A]);
    const one = await listChat(A, B, last);
    assert.deepEqual(one.messages.map((m) => m.body), ['بعدی']);
  });

  /* ── «سین شد» ─────────────────────────────────────────────────────────── */

  await check('reading somebody\'s messages is what marks them seen', async () => {
    await pool.query(`DELETE FROM friend_messages WHERE sender_id=$1 AND recipient_id=$2`, [A, B]);
    await pool.query(`INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES ($1,$2,'سلام')`, [A, B]);
    const before = await listChat(A, B);
    assert.equal(before.readThrough, null, 'it was «seen» before anybody opened it');
    await listChat(B, A);                      /* B opens the chat */
    const after = await listChat(A, B);
    assert.ok(after.readThrough, 'B read it and A was never told');
  });

  await check('and «how far» covers messages sent long before it was read', async () => {
    /* The reason it is a timestamp and not a flag on each row: a poll asks only
       for what is NEW, so a flag on an hour-old message would never arrive. */
    const page = await listChat(A, B);
    const mine = page.messages.filter((m) => m.mine);
    const through = String(page.readThrough);
    assert.ok(mine.every((m) => String(m.at) <= through || !m.readAt),
      'a message of mine that was read sits after the mark');
  });

  await check('a reader does not mark their OWN messages seen', async () => {
    await pool.query(`DELETE FROM friend_messages WHERE sender_id = ANY($1::uuid[])`, [[A, B]]);
    await pool.query(`INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES ($1,$2,'تنها')`, [A, B]);
    await listChat(A, B);                      /* A re-reads their own chat */
    const { rows } = await pool.query(`SELECT read_at FROM friend_messages WHERE sender_id=$1 AND recipient_id=$2`, [A, B]);
    assert.equal(rows[0].read_at, null, 'opening your own chat marked your own message as seen by the other person');
    const page = await listChat(A, B);
    assert.equal(page.readThrough, null, 'and it was reported as seen');
  });

  /* ── REPLIES ──────────────────────────────────────────────────────────── */

  await check('a reply carries what it answers, with it', async () => {
    /* Carried WITH the reply rather than looked up when it is drawn: if the
       original scrolls off the page the screen holds, or is deleted, the quote
       must still read as it did. Looking it up later leaves an answer hanging
       under nothing. */
    await pool.query(`DELETE FROM friend_messages WHERE sender_id = ANY($1::uuid[])`, [[A, B]]);
    const first = await pool.query(
      `INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES ($1,$2,'سؤال اول') RETURNING id`, [B, A]);
    await pool.query(
      `INSERT INTO friend_messages(sender_id, recipient_id, body, reply_to) VALUES ($1,$2,'جواب',$3)`,
      [A, B, first.rows[0].id]);
    const page = await listChat(A, B);
    const answer = page.messages.find((m) => m.body === 'جواب')!;
    assert.ok(answer.replyTo, 'the reply came back with nothing attached');
    assert.equal(answer.replyTo!.body, 'سؤال اول');
    assert.equal(answer.replyTo!.mine, false, 'the quoted message was marked as mine');
  });

  await check('a quote survives the message it quotes being deleted', async () => {
    const page0 = await listChat(A, B);
    const quoted = page0.messages.find((m) => m.body === 'سؤال اول')!;
    await pool.query(`DELETE FROM friend_messages WHERE id=$1`, [quoted.id]);
    const page = await listChat(A, B);
    const answer = page.messages.find((m) => m.body === 'جواب');
    assert.ok(answer, 'the reply went with it');
  });

  await check('and an ordinary message carries nothing', async () => {
    await pool.query(`INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES ($1,$2,'ساده')`, [A, B]);
    const page = await listChat(A, B);
    const plain = page.messages.find((m) => m.body === 'ساده')!;
    assert.equal(plain.replyTo, null);
  });

  await check('a reply can only quote a message from THIS conversation', async () => {
    /* Without the check, an id from somebody else's chat would quote a
       stranger's words into this one — and the quote travels with the reply, so
       it would stay there. */
    const C = 'dddddddd-0000-4000-8000-00000000000c';
    await pool.query(`DELETE FROM users WHERE id=$1`, [C]).catch(() => {});
    await pool.query(`INSERT INTO users(id, phone, username, display_name) VALUES ($1,'09121110003','chat-c','ج')`, [C]);
    const elsewhere = await pool.query(
      `INSERT INTO friend_messages(sender_id, recipient_id, body) VALUES ($1,$2,'راز') RETURNING id`, [B, C]);

    const sent = await sendChat(A, B, 'تلاش', String(elsewhere.rows[0].id));
    assert.equal(sent.replyTo, null, 'a message from another chat was quoted into this one');

    const page = await listChat(A, B);
    const mine = page.messages.find((m) => m.body === 'تلاش')!;
    assert.ok(mine, 'the message was refused instead of being sent plain');
    assert.equal(mine.replyTo, null);
    await pool.query(`DELETE FROM friend_messages WHERE sender_id=$1 OR recipient_id=$1`, [C]);
    await pool.query(`DELETE FROM users WHERE id=$1`, [C]);
  });

  await check('and it CAN quote one from this conversation', async () => {
    const first = await sendChat(B, A, 'سؤال');
    const answer = await sendChat(A, B, 'پاسخ', first.id);
    assert.equal(answer.replyTo, first.id, 'a message from this very chat was refused');
  });

  await wipe();
  console.log(`[friendChat] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
