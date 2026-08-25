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
import { recordMatch } from '../services/missionService.js';
import { notifications } from '../services/notificationService.js';
import {
  _resetReferrals, codeFor, ownerOf, redeem, hasRedeemed, inviteCount,
  normalizeCode, ReferralError, REFERRAL_REWARD_TIER, REFERRAL_REWARD_COUNT,
  payReferralReward, wasRewarded
} from '../services/referralService.js';

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isUnregistered } from '../modules/users/routes.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ': ' + (e as Error).message); }
}

/* A PLAYER THE WAY SIGN-UP MAKES ONE.
   `withUsername: false` used to mean «username: \'\'», which sign-up never
   produces: auth gives a brand-new account `user_<timestamp>` and «بازیکن
   جدید» so it has something to be called. Testing against a shape the system
   cannot create is how the referral reward passed every test here and reached
   nobody in production — the server read «new» as «has no username» and every
   real account had one from its first second. */
async function player(name: string, withUsername = true): Promise<string> {
  const userId = id();
  await repositories.users.save({
    id: userId, phone: '0912' + Math.floor(Math.random() * 1e7),
    username: withUsername ? 'n_' + userId.slice(0, 6) : `user_${Date.now()}${Math.floor(Math.random() * 1000)}`,
    displayName: withUsername ? name : 'بازیکن جدید', plan: 'free', level: 1, xp: 0, weeklyScore: 0,
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

    /* «بعد از ثبت‌نام، بعد از اولین بازیِ دعوت‌شده، به فرستنده یه بلیط سبز
       می‌دیم.» Typing the code is a claim, not a payment: signing up is free
       and takes a minute, so paying for it pays for accounts rather than for
       players. The ticket is earned by the first match. */
    await check('typing a code pays nobody yet', async () => {
      const friend = await player('دوست');
      const before = await green(owner);
      const r = await redeem(friend, ownerCode);
      assert.equal(r.ownerUserId, owner);
      assert.equal(await green(owner), before, 'the ticket was paid before it was earned');
      assert.equal(await wasRewarded(friend), false);
    });

    await check('and the first match settles it', async () => {
      const friend = await player('دوست-الف');
      await redeem(friend, ownerCode);
      const before = await green(owner);
      const paid = await payReferralReward(friend);
      assert.deepEqual(paid, { ownerUserId: owner, tier: REFERRAL_REWARD_TIER, count: REFERRAL_REWARD_COUNT }, JSON.stringify(paid));
      assert.equal(await green(owner), before + REFERRAL_REWARD_COUNT);
      assert.equal(await wasRewarded(friend), true);
    });

    /* The hook runs on EVERY match. It has to be silent on all of them but the
       first, or one invitation buys a lifetime of tickets. */
    await check('and never settles twice, however many matches follow', async () => {
      const friend = await player('دوست-ب');
      await redeem(friend, ownerCode);
      assert.ok(await payReferralReward(friend));
      const after = await green(owner);
      for (let i = 0; i < 5; i++) assert.equal(await payReferralReward(friend), null);
      assert.equal(await green(owner), after, 'a second ticket was paid for one invitation');
    });

    await check('a player who typed no code earns nobody anything', async () => {
      const stranger = await player('غریبه');
      assert.equal(await payReferralReward(stranger), null);
    });

    await check('and the person who typed it gets nothing', async () => {
      const friend = await player('دوست۲');
      const before = await green(friend);
      await redeem(friend, ownerCode);
      await payReferralReward(friend);
      assert.equal(await green(friend), before, 'the reward went to the wrong person');
    });

    await check('typed in any case, with spaces, it still works', async () => {
      const friend = await player('دوست۳');
      const before = await green(owner);
      await redeem(friend, '  ' + ownerCode.toLowerCase() + ' ');
      await payReferralReward(friend);
      assert.equal(await green(owner), before + 1);
    });

    await check('the owner can see how many came in on it', async () => {
      assert.equal(await inviteCount(owner), 5, 'five friends have used it by now');
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

    /* Which refusal comes first matters: somebody who has already used a code
       and then mistypes another should be told they have used theirs, not sent
       looking for a code that does not exist. */
    await check('a used-up player is told so even for an unknown code', async () => {
      const friend = await player('پرمصرف');
      await redeem(friend, ownerCode);
      await assert.rejects(() => redeem(friend, 'ZZZZZZZ'), (e: any) => e.code === 'ALREADY_REDEEMED');
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

    /* ── FROM A FINISHED MATCH, AND SAID OUT LOUD ────────────────────────
       The two halves above are the rule and the payment. This is the wiring:
       nothing pays anybody unless a real match end reaches it, and «الان کاربر
       هیچ خبری نداره که بلیطش اضافه شده یا نه» — the ticket has to arrive with
       a sentence attached, naming who earned it. */
    console.log('\nwhen the invited player actually plays:');

    await check('finishing a match is what pays the inviter', async () => {
      const host = await player('میزبان-بازی');
      const code = await codeFor(host);
      const newbie = await player('نوآمدهٔ بازیکن', false);
      await redeem(newbie, code);
      const before = await green(host);
      await recordMatch({ userId: newbie, won: false });
      assert.equal(await green(host), before + REFERRAL_REWARD_COUNT, 'the match did not pay the inviter');
    });

    await check('and the inviter is told, by name', async () => {
      const host = await player('میزبان-خبر');
      const code = await codeFor(host);
      const newbie = await player('پویا', false);
      /* Give them the name they will be known by, the way registration does. */
      const u = await repositories.users.findById(newbie);
      await repositories.users.save({ ...(u as any), username: 'pouya_7', displayName: 'پویا' });
      await redeem(newbie, code);
      await recordMatch({ userId: newbie, won: false });
      const inbox = await notifications.list(host, 20);
      const note = inbox.find((n) => (n.data as any)?.kind === 'referral_reward');
      assert.ok(note, 'the ticket arrived with nothing said: ' + JSON.stringify(inbox.map((n) => n.title)));
      assert.match(note!.title, /بلیط سبز/, note!.title);
      assert.match(note!.body, /pouya_7/, note!.body);
      assert.match(note!.body, /اولین مسابقه/, note!.body);
      assert.equal((note!.data as any).tier, REFERRAL_REWARD_TIER);
      assert.equal((note!.data as any).count, REFERRAL_REWARD_COUNT);
    });

    await check('and told only once, not after every match', async () => {
      const host = await player('میزبان-یک‌بار');
      const code = await codeFor(host);
      const newbie = await player('بازیکن-مکرر', false);
      await redeem(newbie, code);
      for (let i = 0; i < 4; i++) await recordMatch({ userId: newbie, won: i % 2 === 0 });
      const notes = (await notifications.list(host, 50)).filter((n) => (n.data as any)?.kind === 'referral_reward');
      assert.equal(notes.length, 1, 'the inviter was told ' + notes.length + ' times for one invitation');
      assert.equal(await green(host), REFERRAL_REWARD_COUNT, 'more than one ticket for one invitation');
    });

    await check('a player who came in on nobody’s code pays nobody', async () => {
      const alone = await player('تنها', false);
      const before = (await notifications.list(alone, 20)).length;
      await recordMatch({ userId: alone, won: true });
      assert.equal((await notifications.list(alone, 20)).length, before);
    });

    console.log('\nthe window: first registration, and nowhere else:');

    /* WHO COUNTS AS NEW — AGAINST THE ACCOUNT SIGN-UP ACTUALLY MAKES.
       This is the bug the whole feature died of. The window was read as «the
       account has no username», and sign-up has never created one that way: it
       fills in `user_<timestamp>` and «بازیکن جدید» so the player has something
       to be called. So every real account failed the test on its first second
       and every code was refused as TOO_LATE — the invitation worked, the code
       auto-filled, the registration went through, and nobody was ever paid.

       The two checks below are the guard. The first is the rule against the
       shape; the second reads the placeholder out of the sign-up code itself,
       so moving it there without moving this fails here rather than in
       somebody's hands. */
    await check('a freshly signed-up account counts as new', () => {
      assert.equal(isUnregistered({ username: 'user_1712345678901', displayName: 'بازیکن جدید' }), true);
      assert.equal(isUnregistered({ username: '', displayName: '' }), true);
      assert.equal(isUnregistered({ username: 'user_1', displayName: 'اسم واقعی' }), true);
      assert.equal(isUnregistered({ username: 'sara_92', displayName: 'بازیکن جدید' }), true);
    });

    await check('and a finished one does not', () => {
      assert.equal(isUnregistered({ username: 'sara_92', displayName: 'سارا' }), false);
      /* Not a placeholder — a real name that merely starts the same way. */
      assert.equal(isUnregistered({ username: 'user_of_the_year', displayName: 'سارا' }), false);
    });

    await check('the placeholder sign-up writes is one this rule recognises', () => {
      let dir = process.cwd(), src = '';
      for (let i = 0; i < 5; i++) {
        const f = resolve(dir, 'prizzequizz-api/src/modules/auth/routes.ts');
        const g = resolve(dir, 'src/modules/auth/routes.ts');
        if (existsSync(f)) { src = readFileSync(f, 'utf8'); break; }
        if (existsSync(g)) { src = readFileSync(g, 'utf8'); break; }
        const up = dirname(dir); if (up === dir) break; dir = up;
      }
      assert.ok(src, 'auth/routes.ts not found');
      const un = /username: `([^`]+)`/.exec(src);
      const dn = /displayName: '([^']+)'/.exec(src);
      assert.ok(un && dn, 'the account sign-up creates no longer looks the way this test reads it');
      /* `user_${Date.now()}` as it would actually come out. */
      const username = String(un![1]).replace(/\$\{Date\.now\(\)\}/, String(Date.now()));
      assert.equal(isUnregistered({ username, displayName: String(dn![1]) }), true,
        'sign-up makes an account this rule would call already-registered: ' + username + ' / ' + dn![1]);
    });

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
      /* Registering is the CLAIM. The ticket is earned by the first match. */
      assert.equal(await green(host), before, 'the ticket was paid at sign-up');
      await payReferralReward(newbie);
      assert.equal(await green(host), before + 1, 'the first match did not settle it');
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

    /* ── LAST, BECAUSE IT WIPES THE TABLE ────────────────────────────────
       THE DRAW IS CHECKED, AND THE CHECK IS BOUNDED. Forty draws out of 31^7
       will not collide by chance, so the only way to see the collision path at
       all is to make every draw come out the same — which is also the only way
       to see whether it draws again or spins forever. */
    console.log('\nwhen the draw keeps coming out the same:');
    await check('a taken code is drawn again, and not forever', async () => {
      _resetReferrals();
      const first = await player('اول');
      const second = await player('دوم');
      const real = Math.random;
      try {
        Math.random = () => 0.5;                 // every draw is identical
        const a = await codeFor(first);
        assert.ok(a, 'the first player got no code');
        /* The second cannot have that one, and there is no other on offer — so
           it has to give up rather than hang. */
        await assert.rejects(() => codeFor(second), (e: any) => e.code === 'CODE_UNAVAILABLE');
      } finally { Math.random = real; }
    });
  } finally {
    server.close();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
