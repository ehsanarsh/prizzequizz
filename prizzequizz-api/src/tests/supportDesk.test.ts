/* THE SUPPORT DESK, AND THE THINGS AROUND IT.
 *
 *   • «قسمت نظرات و پیشنهادات کامل بشه و به پشتیبانی متصل بشه» — feedback was
 *     pushed onto an array in the page and answered with «ارسال شد». Nothing
 *     left the phone, so nobody ever read one and there was no way to reply.
 *   • «جملات آماده و قابل اضافه و تغییر و حذف کردن از همان پنل».
 *   • «کنار دکمهٔ مدیریت یک دکمهٔ حذف کاربر باید باشه» — and in an app holding
 *     people's money, deleting an account has to refuse before it destroys.
 *
 * Run: npx tsx src/tests/supportDesk.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import fs from 'node:fs';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { createSession } from '../services/sessionService.js';
import { id } from '../utils/id.js';
import { _resetMacros } from '../services/supportMacroService.js';
import { postEntry, requestWithdraw, getAccount } from '../services/walletLedgerService.js';
import { setOtpSettings } from '../services/withdrawOtpService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

async function player(name: string, phone?: string): Promise<string> {
  const uid = id();
  await repositories.users.save({
    id: uid, phone: phone ?? ('0912' + Math.floor(Math.random() * 1e7)), username: 'n_' + uid.slice(0, 6),
    displayName: name, plan: 'premium', level: 3, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: {}
  } as any);
  return uid;
}

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}/v1`;
  const ADMIN = process.env.ADMIN_KEY || 'dev-admin';

  const call = async (method: string, path: string, opts: { token?: string; admin?: boolean; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.admin) headers['x-admin-key'] = ADMIN;
    const res = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const parsed = await res.json().catch(() => null) as any;
    return { status: res.status, ok: parsed?.ok === true, data: parsed?.data, code: parsed?.error?.code ?? '' };
  };

  try {
    _resetMacros();

    /* ── FEEDBACK IS A SUPPORT TICKET ─────────────────────────────────── */
    console.log('a player sends feedback:');
    const fan = await player('Fan');
    const sf = createSession(fan);
    let ticketId = '';

    await check('it goes to the server, not into the page', async () => {
      const r = await call('POST', '/support/tickets', { token: sf.accessToken,
        body: { title: 'گردونه جذاب‌تر شود', category: 'پیشنهاد', body: 'جایزه‌ها کمی بیشتر شود.' } });
      assert.equal(r.status, 201, JSON.stringify(r));
      ticketId = r.data.id || r.data.ticket?.id;
      assert.ok(ticketId, 'no ticket came back');
    });

    await check('and the player can see it in their own list', async () => {
      const r = await call('GET', '/support/tickets', { token: sf.accessToken });
      const rows = r.data?.rows ?? r.data ?? [];
      assert.ok(rows.some((t: any) => t.id === ticketId), 'their own feedback is not in their list');
      assert.ok(rows.some((t: any) => t.category === 'پیشنهاد'), 'the kind of feedback is not kept');
    });

    await check('support sees it in the queue', async () => {
      const r = await call('GET', '/admin/support/tickets?status=open&limit=100', { admin: true });
      const rows = r.data?.rows ?? r.data ?? [];
      assert.ok(rows.some((t: any) => t.id === ticketId), 'feedback never reached the desk');
    });

    await check('and an answer comes back to the player', async () => {
      const a = await call('POST', `/admin/support/tickets/${ticketId}/reply`, { admin: true, body: { body: 'ممنون! به تیم محصول گفتیم.' } });
      assert.equal(a.status, 200, JSON.stringify(a));
      const mine = await call('GET', `/support/tickets/${ticketId}`, { token: sf.accessToken });
      assert.equal(mine.status, 200, JSON.stringify(mine));
      const msgs = mine.data.messages ?? mine.data.replies ?? [];
      assert.ok(msgs.some((m: any) => /تیم محصول/.test(String(m.body ?? m.text ?? ''))),
        'the reply is not in the conversation the player can read');
    });

    await check('one player cannot read another’s ticket', async () => {
      const nosey = createSession(await player('Nosey'));
      const r = await call('GET', `/support/tickets/${ticketId}`, { token: nosey.accessToken });
      assert.equal(r.status, 404, JSON.stringify(r));
    });

    /* ── CANNED REPLIES ───────────────────────────────────────────────── */
    console.log('the things support says twenty times a day:');
    let macroId = '';

    await check('an operator can add one', async () => {
      const r = await call('POST', '/admin/support/macros', { admin: true,
        body: { title: 'تأخیر برداشت', body: 'سلام {نام}، برداشت شما در صف بررسی است.', category: '', sortOrder: 1 } });
      assert.equal(r.status, 201, JSON.stringify(r));
      macroId = r.data.id;
      assert.ok(macroId);
    });

    await check('every operator sees the same set', async () => {
      const r = await call('GET', '/admin/support/macros', { admin: true });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal((r.data.rows || []).length, 1);
      assert.equal(r.data.rows[0].title, 'تأخیر برداشت');
    });

    await check('and it can be changed', async () => {
      const r = await call('PATCH', `/admin/support/macros/${macroId}`, { admin: true,
        body: { title: 'تأخیر برداشت', body: 'سلام {نام}، برداشتت تا ۲۴ ساعت آینده بررسی می‌شود.', category: 'برداشت', sortOrder: 2 } });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.match(r.data.body, /۲۴ ساعت/);
      assert.equal(r.data.category, 'برداشت');
      /* Read it BACK. What the save returns is what the save was told; only a
         fresh read says whether it was actually kept. */
      const again = await call('GET', '/admin/support/macros', { admin: true });
      const saved = (again.data.rows || []).find((m: any) => m.id === macroId);
      assert.ok(saved, 'the macro vanished on save');
      assert.match(saved.body, /۲۴ ساعت/, 'the edit was reported but never stored');
      assert.equal(saved.category, 'برداشت', 'the category was reported but never stored');
    });

    await check('an empty one is refused rather than saved blank', async () => {
      const noTitle = await call('POST', '/admin/support/macros', { admin: true, body: { title: '  ', body: 'x' } });
      assert.equal(noTitle.status, 422, JSON.stringify(noTitle));
      const noBody = await call('POST', '/admin/support/macros', { admin: true, body: { title: 'x', body: '' } });
      assert.equal(noBody.status, 422, JSON.stringify(noBody));
    });

    await check('and it can be deleted', async () => {
      const r = await call('DELETE', `/admin/support/macros/${macroId}`, { admin: true });
      assert.equal(r.status, 200, JSON.stringify(r));
      const left = await call('GET', '/admin/support/macros', { admin: true });
      assert.equal((left.data.rows || []).length, 0);
      const again = await call('DELETE', `/admin/support/macros/${macroId}`, { admin: true });
      assert.equal(again.status, 404, 'deleting the same one twice reported success');
    });

    await check('none of it is open to a player', async () => {
      const r = await call('GET', '/admin/support/macros', { token: sf.accessToken });
      assert.notEqual(r.status, 200, 'a player could read the operator’s macros: ' + JSON.stringify(r));
      const w = await call('POST', '/admin/support/macros', { token: sf.accessToken, body: { title: 'x', body: 'y' } });
      assert.notEqual(w.status, 201, 'a player could write one');
    });

    /* ── DELETING A PLAYER ────────────────────────────────────────────── */
    console.log('removing an account:');

    await check('an ordinary account can be deleted', async () => {
      const doomed = await player('Doomed');
      const r = await call('DELETE', `/admin/users/${doomed}`, { admin: true });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal(await repositories.users.findById(doomed), null, 'the row is still there');
    });

    await check('but not one that still holds money', async () => {
      const rich = await player('Rich');
      await postEntry({ userId: rich, entryType: 'match_reward', kind: 'credit', amount: 250_000,
                        idempotencyKey: 'p:' + id(), description: 'جایزه' });
      const r = await call('DELETE', `/admin/users/${rich}`, { admin: true });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'USER_HAS_FUNDS');
      assert.ok(await repositories.users.findById(rich), 'the account was destroyed anyway');
    });

    await check('nor one with a withdrawal waiting to be paid', async () => {
      const paid = await player('Paid');
      await postEntry({ userId: paid, entryType: 'match_reward', kind: 'credit', amount: 300_000,
                        idempotencyKey: 'p:' + id(), description: 'جایزه' });
      await setOtpSettings({ required: false });
      await requestWithdraw({ userId: paid, amount: 300_000, destination: 'IR' + '1'.repeat(24) });
      const acct = await getAccount(paid);
      assert.equal(acct.available, 0, 'the money should be locked, not spendable');
      assert.ok(acct.locked > 0, 'nothing is locked, so this is not testing what it says');
      const r = await call('DELETE', `/admin/users/${paid}`, { admin: true });
      assert.equal(r.status, 409, JSON.stringify(r));
      assert.equal(r.code, 'USER_HAS_FUNDS', 'an account owed money was deleted');
      await setOtpSettings({ required: true });
    });

    await check('a player cannot delete anybody', async () => {
      const victim = await player('Victim');
      const r = await call('DELETE', `/admin/users/${victim}`, { token: sf.accessToken });
      assert.notEqual(r.status, 200, JSON.stringify(r));
      assert.ok(await repositories.users.findById(victim), 'a player deleted another account');
    });

    await check('and deleting somebody who is not there says so', async () => {
      const r = await call('DELETE', `/admin/users/${id()}`, { admin: true });
      assert.equal(r.status, 404, JSON.stringify(r));
    });

    /* ── THE PANEL ────────────────────────────────────────────────────── */
    console.log('the panel’s side of it:');
    const panel = fs.readFileSync(new URL('../../../pzadmin.html', import.meta.url), 'utf8');

    await check('the users table has a delete button beside «مدیریت»', async () => {
      assert.match(panel, /userDetail\(\\'[^)]*\)">مدیریت<\/button>[\s\S]{0,120}askDeleteUser/,
        'the delete button is not next to the manage button');
    });

    await check('and it asks for the username before destroying anything', async () => {
      const i = panel.indexOf('function askDeleteUser(');
      const body = panel.slice(i, panel.indexOf('function uSelOne('));
      assert.ok(body.includes('delu_confirm'), 'there is no confirmation field');
      assert.ok(body.includes("typed!==String(username||'')"), 'the typed name is not checked');
      assert.ok(body.includes("api('DELETE','/admin/users/'"), 'it does not call the delete endpoint');
    });

    await check('the manage dialog shows the phone number', async () => {
      const i = panel.indexOf('async function userDetail(');
      const body = panel.slice(i, panel.indexOf('async function saveUser('));
      assert.ok(body.includes('شماره موبایل'), 'the phone is not labelled');
      assert.ok(/esc\(u\.phone\|\|'—'\)/.test(body), 'it does not read the phone off the user');
    });

    await check('the support screen is a two-pane console, not a modal per ticket', async () => {
      assert.ok(panel.includes('sup-console'), 'no console layout');
      assert.ok(panel.includes('function supOpen('), 'no way to open a conversation in place');
      assert.ok(panel.includes('SUP_DRAFT'), 'a half-written reply is not kept while switching');
      assert.ok(panel.includes("api('GET','/admin/support/macros')"), 'the canned replies are not loaded');
    });

    await check('a canned reply is inserted for a human to read, never sent by itself', async () => {
      const i = panel.indexOf('function supUseMacro(');
      const body = panel.slice(i, panel.indexOf('function supMacroManager('));
      assert.ok(body.includes("ta.value="), 'it does not put the text in the box');
      assert.ok(!/api\('POST'/.test(body), 'clicking a macro sends it straight to the player');
    });

  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
