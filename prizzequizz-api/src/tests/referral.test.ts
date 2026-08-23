/* «کد معرف.»
 *
 *   «هر کاربر یه کد داشته باشه، و اگه هر کسی در قسمت کد معرف اون کد رو وارد
 *    کنه، به دارندهٔ کد یک بلیط سبز داده بشه به عنوان جایزه. و اون کد رو باید
 *    در اولین ثبت نام وارد کنن، وگرنه بعد از ثبت نام دیگه جایی نباشه که بتونی
 *    وارد کنی و جایزه ببری.»
 *
 * The reward is a real ticket paid to a real person, which is what makes the
 * second half load-bearing: every way of typing a code twice, of typing your
 * own, or of typing one after the window has closed, is a way of minting
 * tickets. Most of this file is those ways.
 *
 * Run: npx tsx src/tests/referral.test.ts
 */
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { repositories } from '../repositories/index.js';
import { createSession } from '../services/sessionService.js';
import { id } from '../utils/id.js';
import { getTickets } from '../services/ticketService.js';
import {
  _resetReferrals, codeFor, ownerOf, redeem, hasRedeemed, inviteCount,
  normalizeCode, ReferralError, REFERRAL_REWARD_TIER, REFERRAL_REWARD_COUNT
} from '../services/referralService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

async function player(name: string, withUsername = true): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7),
    username: withUsername ? 'n_' + userId.slice(0, 6) : '',
    displayName: withUsername ? name : '', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
    wallet: 0, coins: 0, hearts: 5, tickets: { green: 0, blue: 0, red: 0, bronze: 0, silver: 0, gold: 0 }
  } as any);
  return userId;
}
const green = async (uid: string) => Number((await getTickets(uid))?.[REFERRAL_REWARD_TIER] ?? 0);

async function main(): Promise<void> {
  process.env.REPOSITORY_DRIVER = 'memory';
  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}/v1`;

  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const parsed = await res.json().catch(() => null) as any;
    return { status: res.status, ok: parsed?.ok === true, data: parsed?.data, code: parsed?.error?.code ?? '' };
  };

  try {
    _resetReferrals();

    console.log('the code every player has:');

    const owner = await player('صاحب کد');
    let ownerCode = '';
    await check('a player is given a code the first time they ask', async () => {
      ownerCode = await codeFor(owner);
      assert.ok(ownerCode.length >= 6, 'too short to be worth typing: ' + ownerCode);
    });

    await check('and it is the same code every time after', async () => {
      assert.equal(await codeFor(owner), ownerCode);
      assert.equal(await codeFor(owner), ownerCode);
    });

    /* Read off one screen and typed into another, usually from a photo. */
    await check('the alphabet leaves out every character that is misread', () => {
      assert.ok(!/[OIL01]/.test(ownerCode), 'contains a look-alike: ' + ownerCode);
    });

    await check('two players never share a code', async () => {
      const codes = new Set<string>();
      for (let i = 0; i < 40; i++) codes.add(await codeFor(await player('p' + i)));
      assert.equal(codes.size, 40, 'a code was handed out twice');
    });

    await check('a code is read the way a person types it', () => {
      assert.equal(normalizeCode(' ' + ownerCode.toLowerCase() + ' '), ownerCode);
      assert.equal(normalizeCode(ownerCode.split('').join('-')), ownerCode);
    });

    /* NOTHING IS GUESSED. O/I/L/0/1 are not in the alphabet, so a code that
       contains one matches nothing — folding them onto look-alikes would hand
       somebody a reward for a code they did not type. */
    await check('a look-alike is refused, not guessed at', async () => {
      assert.equal(await ownerOf('OOOOOOO'), '');
      assert.equal(await ownerOf('1111111'), '');
    });

    console.log('\nusing one:');

    await check('the code’s owner gets a green ticket', async () => {
      const friend = await player('دوست');
      const before = await green(owner);
      const r = await redeem(friend, ownerCode);
      assert.equal(r.ownerUserId, owner);
      assert.equal(await green(owner), before + REFERRAL_REWARD_COUNT);
    });

    await check('and the person who typed it gets nothing', async () => {
      const friend = await player('دوست۲');
      const before = await green(friend);
      await redeem(friend, ownerCode);
      assert.equal(await green(friend), before, 'the reward went to the wrong person');
    });

    await check('typed in any case, with spaces, it still works', async () => {
      const friend = await player('دوست۳');
      const before = await green(owner);
      await redeem(friend, '  ' + ownerCode.toLowerCase() + ' ');
      assert.equal(await green(owner), before + 1);
    });

    await check('the owner can see how many came in on it', async () => {
      assert.equal(await inviteCount(owner), 3, 'three friends have used it by now');
    });

    console.log('\nevery way of using one twice:');

    await check('a second code is refused', async () => {
      const friend = await player('دوباره');
      const other = await player('دیگری');
      const otherCode = await codeFor(other);
      await redeem(friend, ownerCode);
      const before = await green(other);
      await assert.rejects(() => redeem(friend, otherCode), (e: any) => e.code === 'ALREADY_REDEEMED');
      assert.equal(await green(other), before, 'a second code still paid out');
    });

    await check('the SAME code twice is refused too', async () => {
      const friend = await player('همان');
      await redeem(friend, ownerCode);
      const before = await green(owner);
      await assert.rejects(() => redeem(friend, ownerCode), (e: any) => e.code === 'ALREADY_REDEEMED');
      assert.equal(await green(owner), before, 'the same code paid twice');
    });

    await check('and `hasRedeemed` says so', async () => {
      const fresh = await player('تازه');
      assert.equal(await hasRedeemed(fresh), false);
      await redeem(fresh, ownerCode);
      assert.equal(await hasRedeemed(fresh), true);
    });

    /* MINTING TICKETS OUT OF NOTHING. Without this a player reads their own
       code off their own screen and types it back in. */
    await check('your own code is refused', async () => {
      const before = await green(owner);
      await assert.rejects(() => redeem(owner, ownerCode), (e: any) => e.code === 'OWN_CODE');
      assert.equal(await green(owner), before, 'a player paid themselves');
    });

    await check('a code nobody owns is refused', async () => {
      const friend = await player('گمشده');
      await assert.rejects(() => redeem(friend, 'ZZZZZZZ'), (e: any) => e.code === 'CODE_NOT_FOUND');
      assert.equal(await hasRedeemed(friend), false, 'a failed attempt used up their one try');
    });

    await check('an empty code is refused', async () => {
      const friend = await player('خالی');
      await assert.rejects(() => redeem(friend, '   '), (e: any) => e.code === 'BAD_CODE');
      assert.equal(await hasRedeemed(friend), false);
    });

    console.log('\nthe window: first registration, and nowhere else:');

    await check('a code typed while completing the account is taken', async () => {
      _resetReferrals();
      const host = await player('میزبان');
      const code = await codeFor(host);
      const newbie = await player('نوآمده', false);          // no username yet
      const s = createSession(newbie);
      const before = await green(host);
      const r = await call('PATCH', '/users/me', s.accessToken, { displayName: 'تازه‌وارد', username: 'newbie1', referralCode: code });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.deepEqual(r.data.referral, { applied: true }, JSON.stringify(r.data.referral));
      assert.equal(await green(host), before + 1);
    });

    /* THE RULE THE WHOLE REQUEST TURNS ON. «بعد از ثبت نام دیگه جایی نباشه که
       بتونی وارد کنی» — and the screen not showing a box is a UI decision, not
       a rule. Somebody who found the endpoint gets the same answer. */
    await check('the same player cannot type one afterwards', async () => {
      const host2 = await player('میزبان۲');
      const code2 = await codeFor(host2);
      const settled = await player('جاافتاده');                // already has a username
      const s = createSession(settled);
      const before = await green(host2);
      const r = await call('PATCH', '/users/me', s.accessToken, { displayName: 'همان', referralCode: code2 });
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.equal(r.data.referral.applied, false, JSON.stringify(r.data.referral));
      assert.equal(r.data.referral.reason, 'TOO_LATE', JSON.stringify(r.data.referral));
      assert.equal(await green(host2), before, 'a settled account still paid out');
      assert.equal(await hasRedeemed(settled), false);
    });

    await check('a code that does not exist does not fail the registration', async () => {
      const newbie = await player('نوآمده۲', false);
      const s = createSession(newbie);
      const r = await call('PATCH', '/users/me', s.accessToken, { displayName: 'تازه۲', username: 'newbie2', referralCode: 'ZZZZZZZ' });
      assert.equal(r.status, 200, 'the account must still be created');
      assert.equal(r.data.username, 'newbie2');
      assert.equal(r.data.referral.applied, false);
      assert.equal(r.data.referral.reason, 'CODE_NOT_FOUND', JSON.stringify(r.data.referral));
    });

    await check('registering without a code says nothing about referrals', async () => {
      const newbie = await player('نوآمده۳', false);
      const s = createSession(newbie);
      const r = await call('PATCH', '/users/me', s.accessToken, { displayName: 'تازه۳', username: 'newbie3' });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.referral, { applied: false });
    });

    console.log('\nreading your own code:');

    await check('a player can read their code and their count', async () => {
      _resetReferrals();
      const me = await player('من');
      const s = createSession(me);
      const r = await call('GET', '/users/me/referral', s.accessToken);
      assert.equal(r.status, 200, JSON.stringify(r));
      assert.ok(r.data.code && r.data.code.length >= 6, JSON.stringify(r.data));
      assert.equal(r.data.invites, 0);
      assert.equal(r.data.rewardTier, REFERRAL_REWARD_TIER);
      assert.equal(r.data.rewardCount, REFERRAL_REWARD_COUNT);
    });

    await check('and the count goes up as people use it', async () => {
      const me = await player('من۲');
      const s = createSession(me);
      const code = (await call('GET', '/users/me/referral', s.accessToken)).data.code;
      await redeem(await player('یک'), code);
      await redeem(await player('دو'), code);
      const r = await call('GET', '/users/me/referral', s.accessToken);
      assert.equal(r.data.invites, 2, JSON.stringify(r.data));
    });

    await check('a signed-out caller has no code', async () => {
      const res = await fetch(base + '/users/me/referral');
      assert.equal(res.status, 401);
    });

    /* THERE IS NO SECOND DOOR. The only way in is the registration call. */
    await check('there is no route that takes a code on its own', async () => {
      const me = await player('من۳');
      const s = createSession(me);
      for (const m of ['POST', 'PUT', 'PATCH']) {
        const r = await call(m, '/users/me/referral', s.accessToken, { code: 'ABCDEFG' });
        assert.ok(r.status === 404 || r.status === 405, m + ' was accepted: ' + r.status);
      }
    });

    await check('and ReferralError carries a code worth showing', () => {
      const e = new ReferralError('OWN_CODE', 'x');
      assert.equal(e.code, 'OWN_CODE');
    });
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
