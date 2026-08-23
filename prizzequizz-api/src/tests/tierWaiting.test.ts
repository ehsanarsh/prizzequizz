/* WHICH TICKET TIERS ARE WORTH OFFERING.
 *
 *   «الان یکی با بلیط سبز دنبال حریفه یکی با بلیط قرمز و هیچ وقت همدیگرو پیدا
 *    نمیکنن… بلیط سبز همیشه فعال، بلیط آبی زمانی فعال که یک نفر از بلیط سبز
 *    دکمه ادامه میدهم را میزند و منتظر حریف با بلیط آبی است، و بلیط قرمز هم
 *    زمانی که یک نفر دنبال حریف با بلیط قرمز هست.»
 *
 * Two players must stake the same amount, so a green player can only ever meet
 * another green player — that part was never wrong, and this does not touch it.
 * What was missing is that nobody could SEE where the others were, so three
 * players picked three tiers and all three waited alone. The queue now says how
 * many are waiting in each, which is what lets the game stop offering an empty
 * one.
 *
 * Run: REPOSITORY_DRIVER=memory npx tsx src/tests/tierWaiting.test.ts
 */
import assert from 'node:assert';
import { once } from 'node:events';
import { createApiServer } from '../app.js';
import { matchmakingQueue } from '../services/matchmakingQueue.js';
import { repositories } from '../repositories/index.js';
import { createSession } from '../services/sessionService.js';

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, extra = '') => {
  if (c) { pass++; console.log('  ok   ' + n + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  [' + extra + ']' : '')); }
};

/* Real users, because two compatible tickets really do create a match and a
   match needs players. */
const q = async (userId: string, economyType: string, ticketTier?: string, pairKey?: string, waitTier?: string,
                 hold?: { holdFor: string; holdMs: number }) => {
  await repositories.users.save({
    id: userId, username: userId, displayName: userId, wallet: 0, coins: 0, xp: 0, level: 1,
    createdAt: new Date().toISOString()
  } as any);
  return matchmakingQueue.enqueue({ userId, modeId: 'duel', economyType: economyType as any, ticketTier, waitTier, skill: 800, pairKey, ...(hold ?? {}) });
};

/* ── 1. NOBODY WAITING ────────────────────────────────────────────────── */
{
  console.log('an empty queue:');
  const s = await matchmakingQueue.stats();
  ok('reports a tier breakdown at all', !!s.waitingByTier, JSON.stringify(s.waitingByTier));
  ok('and nobody in any of them', Object.keys(s.waitingByTier).length === 0, JSON.stringify(s.waitingByTier));
}

/* ── 2. SOMEBODY WAITING ON GREEN ─────────────────────────────────────── */
{
  console.log('\none player waiting on green:');
  await q('u-green-1', 'v12500', 'green');
  const s = await matchmakingQueue.stats();
  ok('green shows one waiting', s.waitingByTier.green === 1, JSON.stringify(s.waitingByTier));
  ok('and the other tiers show nobody', !s.waitingByTier.blue && !s.waitingByTier.red, JSON.stringify(s.waitingByTier));
}

/* ── 3. TWO TIERS OCCUPIED AT ONCE — THE SITUATION TO AVOID ───────────── */
{
  console.log('\nplayers waiting in different tiers:');
  await q('u-red-1', 'v50000', 'red');
  const s = await matchmakingQueue.stats();
  ok('red shows its one', s.waitingByTier.red === 1, JSON.stringify(s.waitingByTier));
  ok('green still shows its one', s.waitingByTier.green === 1, JSON.stringify(s.waitingByTier));
  /* The whole complaint, stated as data: a green player and a red player are
     both waiting and can never meet. With this visible, the game can stop
     offering the tier nobody is in. */
  ok('two tiers are occupied at once', (s.waitingByTier.green ?? 0) > 0 && (s.waitingByTier.red ?? 0) > 0, JSON.stringify(s.waitingByTier));
}

/* ── 4. A MATCHED PLAYER IS NO LONGER WAITING ─────────────────────────── */
/* The count has to mean «a seat you can take», so it must empty the moment the
 * seat is taken — otherwise the game keeps advertising a tier whose only
 * occupant has already gone into a match. */
{
  console.log('\nwhen a second one arrives in that tier:');
  const t = await q('u-red-2', 'v50000', 'red');
  const s = await matchmakingQueue.stats();
  ok('the two of them meet at once', t.status === 'matched', t.status);
  ok('and red is back to nobody waiting', !s.waitingByTier.red, JSON.stringify(s.waitingByTier));
  ok('while green, untouched, still shows its one', s.waitingByTier.green === 1, JSON.stringify(s.waitingByTier));
}

/* ── 5. A PRIVATE PAIRING IS NOT AN OPEN SEAT ─────────────────────────── */
/* Two people who arranged a game are not queueing, they are meeting. Counting
 * them would tell everyone else that a tier is busy when its queue is empty —
 * and send them in to wait alone, which is the bug this is meant to end. */
{
  console.log('\ntwo friends meeting privately:');
  await q('u-priv-1', 'v25000', 'blue', 'invite-xyz');
  const s = await matchmakingQueue.stats();
  ok('blue is not advertised as busy', !s.waitingByTier.blue, JSON.stringify(s.waitingByTier));
  ok('though the player really is queued', s.queued > 0, String(s.queued));
}

/* ── 6. A PLAYER WITH NO TICKET AT ALL ────────────────────────────────── */
/* Free play has no tier, and must not land in a tier's count. */
{
  console.log('\na free-play player:');
  const before = JSON.stringify((await matchmakingQueue.stats()).waitingByTier);
  await q('u-free-1', 'free');
  const after = (await matchmakingQueue.stats()).waitingByTier;
  ok('no tier gained anybody', JSON.stringify(after) === before, before + ' → ' + JSON.stringify(after));
}

/* ── 7. THE CHAINED WINNER — THE CASE THE RULE WAS WRITTEN FOR ────────── */
/* «بلیط آبی زمانی فعال که یک نفر از بلیط سبز دکمه ادامه میدهم را میزند و منتظر
 * حریف با بلیط آبی است.» That player spends NO new ticket — their doubled
 * winnings are the stake — so `ticketTier` is empty and, until `waitTier`
 * existed, the queue counted them in no tier at all: blue stayed shut over a
 * queue with somebody standing in it, and the person they had just beaten
 * could never come and find them. */
{
  console.log('\na green winner who pressed «ادامه میدهم»:');
  const before = (await matchmakingQueue.stats()).waitingByTier.blue ?? 0;
  const t = await q('u-chain-1', 'v25000', undefined, undefined, 'blue');
  const s = await matchmakingQueue.stats();
  ok('is still just queued, waiting', t.status === 'queued', t.status);
  ok('and holds no ticket for it', !t.ticketTier, String(t.ticketTier));
  ok('yet blue now shows them waiting', (s.waitingByTier.blue ?? 0) === before + 1, JSON.stringify(s.waitingByTier));
}

/* ── 8. THE PERSON WHO COMES TO FIND THEM ─────────────────────────────── */
/* A fresh blue ticket is worth 25,000, which is exactly what the chained
 * winner is now playing for — so «پیداش کن» really does put the two of them in
 * the same match. If these two ever stopped meeting, the modal would be
 * sending people to an empty room. */
{
  console.log('\nthe player they beat, entering on a blue ticket:');
  const t = await q('u-chain-2', 'v25000', 'blue');
  ok('meets the chained winner', t.status === 'matched', t.status);
  ok('and it is that same person', t.opponentUserId === 'u-chain-1', String(t.opponentUserId));
  const s = await matchmakingQueue.stats();
  ok('blue is empty again afterwards', !s.waitingByTier.blue, JSON.stringify(s.waitingByTier));
}

/* ── 9. A LABEL, NOT A TICKET ─────────────────────────────────────────── */
/* waitTier must never become a way to be counted in a tier you are not really
 * in. The one thing it may do is say where a chained player stands; a real
 * ticket always outranks it. */
{
  console.log('\nwhen both a real ticket and a label are given:');
  const green0 = (await matchmakingQueue.stats()).waitingByTier.green ?? 0;
  const t = await q('u-both-1', 'v50000', 'red', undefined, 'green');
  const s = await matchmakingQueue.stats();
  ok('the real ticket is what is counted', (s.waitingByTier.red ?? 0) === 1, JSON.stringify(s.waitingByTier));
  ok('the label adds nobody to its own tier', (s.waitingByTier.green ?? 0) === green0, green0 + ' → ' + JSON.stringify(s.waitingByTier));
  ok('and the ticket tier is the one recorded', t.ticketTier === 'red', String(t.ticketTier));
}

/* ── 10. A PRIVATE PAIRING IS STILL NOT AN OPEN SEAT ──────────────────── */
{
  console.log('\na chained player meeting somebody privately:');
  const before = JSON.stringify((await matchmakingQueue.stats()).waitingByTier);
  await q('u-chainpriv-1', 'v25000', undefined, 'invite-abc', 'blue');
  const after = (await matchmakingQueue.stats()).waitingByTier;
  ok('no tier is advertised for them', JSON.stringify(after) === before, before + ' → ' + JSON.stringify(after));
}

/* ── 11. WHAT THE DOOR ACCEPTS ────────────────────────────────────────── */
/* Everything above talks to the queue directly. The label arrives over HTTP,
 * from a client, and the one thing it must never become is a second way to
 * name a ticket — so what the door lets through is worth its own check. */
{
  console.log('\nwhat the enqueue endpoint does with a label:');
  process.env.REPOSITORY_DRIVER = 'memory';
  const server = createApiServer({ attachRealtime: false });
  server.listen(0);
  await once(server, 'listening');
  const port = (server.address() as any).port as number;
  const base = `http://127.0.0.1:${port}/v1`;

  const user = async (id: string) => {
    await repositories.users.save({
      id, username: id, displayName: id, phone: '0913' + Math.floor(Math.random() * 1e7),
      plan: 'premium', wallet: 0, coins: 0, hearts: 5, xp: 0, level: 1, weeklyScore: 0,
      tickets: { green: 2, blue: 2, red: 2, bronze: 0, silver: 0, gold: 0 }
    } as any);
    return createSession(id).accessToken;
  };
  const enqueue = async (token: string, body: Record<string, unknown>) => {
    const res = await fetch(base + '/matchmaking/enqueue', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ modeId: 'duel', skill: 800, ...body })
    });
    const parsed = await res.json().catch(() => null) as any;
    return { status: res.status, data: parsed?.data, code: parsed?.error?.code ?? '' };
  };
  const tierCount = async (t: string) => (await matchmakingQueue.stats()).waitingByTier[t] ?? 0;

  /* Every case gets a value bucket of its own. Sharing one with the cases
     above would pair these players off with those, and a paired player is no
     longer waiting — the count under test would empty for a reason that has
     nothing to do with the label. */
  try {
    /* THE CHAINED WINNER, over the wire. */
    const before = await tierCount('blue');
    const chained = await enqueue(await user('http-chain'), { economyType: 'v90001', waitTier: 'blue' });
    ok('a label with no ticket is accepted', chained.status < 300, JSON.stringify(chained).slice(0, 120));
    ok('and the tier it names fills up', (await tierCount('blue')) === before + 1, String(await tierCount('blue')));

    /* A LABEL IS NOT A TICKET. Sending both must not get somebody counted
       twice, or counted anywhere they have not paid to be. */
    const green0 = await tierCount('green');
    const red0 = await tierCount('red');
    const both = await enqueue(await user('http-both'), { economyType: 'v90002', ticketTier: 'red', waitTier: 'green' });
    ok('a real ticket is taken as given', both.status < 300, JSON.stringify(both).slice(0, 120));
    ok('and its tier is the one counted', (await tierCount('red')) === red0 + 1, red0 + ' → ' + (await tierCount('red')));
    ok('while the label beside it is ignored', (await tierCount('green')) === green0, green0 + ' → ' + (await tierCount('green')));
    /* AND THE RECORD ITSELF SAYS ONE THING. A queued player carrying a red
       ticket AND a green label is a row that answers «which tier is this
       person in?» two different ways — today the count reads the ticket first,
       but the next thing to read the row would have to know that, and the row
       should not have needed the knowing. The door drops the label. */
    const stored = await matchmakingQueue.get(String(both.data?.id ?? ''));
    ok('the ticket is what the row records', stored?.ticketTier === 'red', String(stored?.ticketTier));
    ok('and the row carries no second answer', !stored?.waitTier, String(stored?.waitTier));

    /* ANYTHING THAT IS NOT ONE OF THE THREE. A label is a word the client
       chooses, so a word nobody sells a ticket for must count for nothing —
       otherwise «بلیط بنفش» opens a door that does not exist. */
    const junkBefore = JSON.stringify((await matchmakingQueue.stats()).waitingByTier);
    await enqueue(await user('http-junk'), { economyType: 'v90003', waitTier: 'purple' });
    const junkAfter = JSON.stringify((await matchmakingQueue.stats()).waitingByTier);
    ok('an invented tier counts for nothing', junkAfter === junkBefore, junkBefore + ' → ' + junkAfter);

    /* A LEAGUE TICKET IS NOT A DUEL TIER. It is a real ticket with a real
       name, which is exactly why a whitelist and not a truthiness check. */
    const gold = JSON.stringify((await matchmakingQueue.stats()).waitingByTier);
    await enqueue(await user('http-gold'), { economyType: 'v90004', waitTier: 'gold' });
    ok('a league ticket is not a duel tier either', JSON.stringify((await matchmakingQueue.stats()).waitingByTier) === gold, gold);
  } finally {
    server.close();
  }
}

/* ── 12. TEN SECONDS KEPT FOR THE PLAYER WHO LOST ─────────────────────── */
/* «وقتی مودال حریفت ادامه میده میتونی حقتو بگیری، حریف باید تا ۱۰ ثانیه نتونه
 * با کسی مچ بشه و الویت با بازنده باید باشه، و حریف در قسمت رادار باشه ولی
 * بدون حریف. بعد از ۱۰ ثانیه اگه بازنده پیداش کن رو زد پیداش کنه، و اگه بیخیال
 * شد یا کلا نزد، بعد ۱۰ ثانیه حریف‌یابی برای کاربر شروع بشه.»
 *
 * The winner was in the open queue the instant they pressed «ادامه میدهم», so
 * the first stranger to search took the seat and the invitation the loser had
 * just been shown pointed at nobody. */
{
  console.log('\nthe winner’s seat, right after «ادامه میدهم»:');
  const held = await q('hold-winner', 'v70001', undefined, undefined, 'blue', { holdFor: 'hold-loser', holdMs: 10_000 });
  ok('they are queued and waiting, like anybody else', held.status === 'queued', held.status);
  ok('and the queue shows them in their tier', ((await matchmakingQueue.stats()).waitingByTier.blue ?? 0) >= 1, JSON.stringify((await matchmakingQueue.stats()).waitingByTier));

  /* «حریف در قسمت رادار باشه ولی بدون حریف» — a stranger searching at that
     moment finds nothing here, and waits rather than taking the seat. */
  const stranger = await q('hold-stranger', 'v70001');
  ok('a stranger cannot take the seat', stranger.status === 'queued', stranger.status);
  ok('and is left waiting instead', !stranger.matchId, String(stranger.matchId));

  /* «الویت با بازنده باید باشه» — and the seat is still there when they come. */
  const loser = await q('hold-loser', 'v70001');
  ok('the player it was kept for gets it', loser.status === 'matched', loser.status);
  ok('and it really is the winner they meet', loser.opponentUserId === 'hold-winner', String(loser.opponentUserId));
}

/* ── 13. PRIORITY, WITH SOMEBODY ELSE ALSO WAITING ────────────────────── */
/* The stranger above is still in the queue. If the loser were simply handed
 * the first compatible ticket, they would be given the stranger and the person
 * who called them would still be sitting there. */
{
  console.log('\nwhen a stranger is already waiting in that tier:');
  const other = await q('prio-stranger', 'v70002');
  ok('the stranger is waiting first', other.status === 'queued', other.status);
  const winner = await q('prio-winner', 'v70002', undefined, undefined, 'blue', { holdFor: 'prio-loser', holdMs: 10_000 });
  ok('the winner joins without taking them', winner.status === 'queued', winner.status);
  const loser = await q('prio-loser', 'v70002');
  ok('the loser is given the seat kept for them', loser.status === 'matched', loser.status);
  ok('not the stranger who was there first', loser.opponentUserId === 'prio-winner', String(loser.opponentUserId));
}

/* ── 14. AND AFTER THE TEN SECONDS ────────────────────────────────────── */
/* «اگه بیخیال شد یا کلا نزد، بعد ۱۰ ثانیه حریف‌یابی برای کاربر شروع بشه» — the
 * hold lapses on its own. Nothing is cancelled and nothing is re-queued: the
 * same ticket simply stops being reserved, which is why the person waiting
 * never sees a change. */
{
  console.log('\nonce the ten seconds are up:');
  const winner = await q('lapse-winner', 'v70003', undefined, undefined, 'blue', { holdFor: 'lapse-loser', holdMs: 1 });
  ok('the winner is waiting', winner.status === 'queued', winner.status);
  await new Promise((r) => setTimeout(r, 30));
  const stranger = await q('lapse-stranger', 'v70003');
  ok('anybody may take the seat now', stranger.status === 'matched', stranger.status);
  ok('and it is the winner they meet', stranger.opponentUserId === 'lapse-winner', String(stranger.opponentUserId));
}

/* ── 15. THE HOLD IS ONE-SIDED AND BOUNDED ────────────────────────────── */
{
  console.log('\nwhat the hold is not:');
  /* It restricts the ticket that CARRIES it, not the person it names: the
     loser is free to meet anybody else in the meantime. */
  const winner = await q('one-winner', 'v70004', undefined, undefined, 'blue', { holdFor: 'one-loser', holdMs: 10_000 });
  ok('the winner waits', winner.status === 'queued', winner.status);
  const elsewhere = await q('one-other', 'v70005');
  const loserElsewhere = await q('one-loser', 'v70005');
  ok('the player it names is not held anywhere else', loserElsewhere.status === 'matched', loserElsewhere.status);
  ok('meeting whoever was there', loserElsewhere.opponentUserId === 'one-other', String(loserElsewhere.opponentUserId));
  void elsewhere;

  /* AND IT CANNOT BE ASKED FOR FOREVER. A client names the person; the window
     is decided here, so «hold this seat for a day» is not a thing that can be
     said. */
  const long = await q('cap-winner', 'v70006', undefined, undefined, 'blue', { holdFor: 'cap-loser', holdMs: 999_999_999 });
  ok('a huge window is clamped', (long.holdUntil ?? 0) - Date.now() <= 30_000 + 50, String((long.holdUntil ?? 0) - Date.now()));
  ok('and it is still a real hold', (long.holdUntil ?? 0) > Date.now(), String(long.holdUntil));
}

/* ── 16. NO HOLD MEANS NO CHANGE ──────────────────────────────────────── */
/* The overwhelming majority of tickets carry none of this, and they must be
 * exactly what they were. */
{
  console.log('\nan ordinary ticket:');
  const a = await q('plain-a', 'v70007');
  const b = await q('plain-b', 'v70007');
  ok('two ordinary players still meet at once', b.status === 'matched', b.status);
  ok('and neither carries a hold', !a.holdUntil && !b.holdUntil, JSON.stringify([a.holdUntil, b.holdUntil]));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
