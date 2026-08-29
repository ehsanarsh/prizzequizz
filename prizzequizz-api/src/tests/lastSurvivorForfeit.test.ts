/* LAST SURVIVOR — the pot nobody won.
 *
 * The reported bug: "when the last two or three players all answer wrongly,
 * nobody wins a prize and it is not clear what happens to the prize money."
 *
 * Both halves of that are real. Nobody winning is the rules working — everyone
 * missed the question, so there is no survivor to pay. But the money then went
 * unmentioned: no payout, no record, nothing any screen could show. It stayed
 * with the company by accident of arithmetic rather than by decision.
 *
 * These tests drive a real room to that ending through the orchestrator and
 * assert the two things that matter: not a single toman is paid out, and the
 * whole remaining pot is booked to the house against the room it came from.
 *
 * Run: npx tsx src/tests/lastSurvivorForfeit.test.ts */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { grantTickets } from '../services/ticketService.js';
import { getAccount } from '../services/walletLedgerService.js';
import { LS_DEFAULT_CONFIG, updateConfig } from '../services/lastSurvivorConfig.js';
import { joinTopic, getRoom, saveRoom, listPlayers, snapshot } from '../services/lastSurvivorService.js';
import { advanceRoom, submitAnswer, eliminationOrder } from '../services/lastSurvivorWorker.js';
import { houseRevenueSummary, _resetHouseRevenue } from '../services/houseRevenueService.js';
import { buildPool } from '../services/lastSurvivorPrize.js';
import { gameConfig } from '../core/config.js';
import { realtimeRooms } from '../realtime/roomRegistry.js';

/* WHAT THE ROOM SHOUTS AT THE MOMENT IT ENDS.
 * The snapshot is one way the screen learns about a wipe-out; the `ls:ended`
 * event is the other, and it is the one that arrives first — a client that has
 * already stopped polling has nothing else. They are built separately, so a
 * test that only reads the snapshot leaves the live path unwatched. */
const ended = new Map<string, any>();
const realBroadcast = realtimeRooms.broadcastTopic.bind(realtimeRooms);
realtimeRooms.broadcastTopic = ((topic: string, msg: any) => {
  if (msg && msg.type === 'ls:ended') ended.set(String(topic).replace(/^ls:/, ''), msg.payload);
  return realBroadcast(topic, msg);
}) as typeof realtimeRooms.broadcastTopic;

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const TOPIC = 'فراموش‌شده';
function setCommission(pct: number): void {
  (gameConfig as any).economy = (gameConfig as any).economy ?? {};
  (gameConfig as any).economy.paid = { ...((gameConfig as any).economy.paid ?? {}), rakePercent: pct };
}

async function expire(roomId: string): Promise<void> {
  const r = (await getRoom(roomId))!;
  r.phaseEndsAt = 0;
  await saveRoom(r);
}
/** Push the room forward until it leaves the phase it is in. */
async function step(roomId: string): Promise<void> {
  await expire(roomId);
  await advanceRoom((await getRoom(roomId))!);
}

let seq = 0;
/** A fresh room of `n` players, already running and on round 1. */
async function openRoom(n: number): Promise<{ roomId: string; ids: string[] }> {
  const tag = 'f' + (++seq) + '_';
  const ids: string[] = [];
  let roomId = '';
  for (let i = 0; i < n; i++) {
    const uid = tag + i;
    ids.push(uid);
    await repositories.users.save({
      id: uid, username: uid, displayName: uid, phone: '0913' + Math.floor(Math.random() * 1e7),
      plan: 'paid', wallet: 0, coins: 0, xp: 0, level: 1, weeklyScore: 0, hearts: 5,
      tickets: { bronze: 0, silver: 0, gold: 0 }
    } as any);
    await grantTickets(uid, 'green', 1);
    const s = await joinTopic({ id: uid, username: uid }, TOPIC, 'green');
    roomId = s.room.id;
  }
  /* Capacity is set to n, so the room starts the moment it fills. */
  await advanceRoom((await getRoom(roomId))!);
  const r = (await getRoom(roomId))!;
  assert.equal(r.status, 'running', 'the room should have started');
  return { roomId, ids };
}

/** Answer for everyone this round, then let the round grade and settle. */
async function playRound(roomId: string, answers: Record<string, number>): Promise<void> {
  let r = (await getRoom(roomId))!;
  if (r.phase === 'ready') { await step(roomId); r = (await getRoom(roomId))!; }
  assert.equal(r.phase, 'question', 'expected an open question');
  for (const [uid, idx] of Object.entries(answers)) await submitAnswer(roomId, uid, r.round, idx);
  await step(roomId);                       // question → elimination (grades)
  r = (await getRoom(roomId))!;
  if (r.status === 'finished') return;
  await step(roomId);                       // elimination → dashboard
  r = (await getRoom(roomId))!;
  if (r.status === 'finished') return;
  await step(roomId);                       // dashboard → cashout (or finish)
  r = (await getRoom(roomId))!;
  if (r.status === 'finished') return;
  if (r.phase === 'cashout') await step(roomId);   // cashout → next round (or finish)
}

async function run(): Promise<void> {
  _resetHouseRevenue();
  setCommission(0);
  await updateConfig({
    room: { capacity: 3, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 },
    match: { totalRounds: 6, questionsPerRound: 1, minSurvivors: 1 },
    topics: { [TOPIC]: { enabled: true } }
  });
  /* Every question's correct answer is index 0, so a test controls exactly who
   * survives by choosing what each player picks. */
  for (let i = 0; i < 10; i++) {
    await repositories.questions.save({
      id: 'fq' + i, category: TOPIC, difficulty: 'easy', text: 'سوال ' + i,
      options: ['درست', 'غلط', 'سه', 'چهار'], correctIndex: 0, tags: [], status: 'approved', version: 1
    } as any);
  }

  /* THE RULE CHANGED, ON PURPOSE.
   *
   * This used to assert that nobody at all was paid when the room was wiped
   * out and that the WHOLE pot went to the house. The operator's rule now is
   * kinder by exactly one share: the pot is divided among the players who were
   * still standing when that last round began, and the LAST one out — the last
   * name in the server's own elimination order — is paid their share. The rest
   * is still booked to the house, and still to the rial.
   *
   * The old expectation is not "broken", it is superseded; what has to stay
   * true is that ONE player is paid, that it is the right one, and that nothing
   * goes missing. */
  await check('all three miss on round one → ALL of them are paid, the rest is booked to the house', async () => {
    const { roomId, ids } = await openRoom(3);
    const room = (await getRoom(roomId))!;
    const pool = buildPool(room.config, ids.map(() => 'green'));
    assert.ok(pool.net > 0, 'the pot should not be empty');

    /* Everybody answers 1 — the wrong option. This is the exact situation the
     * report described, with three players instead of two. */
    await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));

    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'finished', 'a room with nobody left must end');
    const players = await listPlayers(roomId);
    assert.equal(players.filter((p) => p.status === 'alive').length, 0, 'nobody survived');

    /* THE RULE CHANGED AGAIN, ON PURPOSE — see the case below about two
       players. Paying only the last one out meant that of several people who
       made exactly the same mistake, one was rewarded and the rest were not.
       Now the operator's percentage is split among all of them. */
    const pct = LS_DEFAULT_CONFIG.economy.wipeoutPlayerPercent;
    const toPlayers = Math.floor((pool.net * pct) / 100);
    for (const u of ids) {
      const row = players.find((p) => p.userId === u)!;
      const acct = await getAccount(u);
      assert.ok(row.payoutCash > 0, u + ' answered as badly as the others and was paid nothing');
      assert.equal(acct.available, row.payoutCash, u + '’s wallet must hold what they were paid');
      /* One share of three, since all three hold the same ticket. */
      assert.ok(Math.abs(row.payoutCash - Math.floor(toPlayers / 3)) <= 3,
        'the share is ' + row.payoutCash + ', not a third of ' + toPlayers);
    }

    const paid = players.reduce((sum, p) => sum + p.payoutCash, 0);
    assert.ok(Math.abs(paid - toPlayers) <= 3, 'players took ' + paid + ', not the configured ' + toPlayers);
    const house = await houseRevenueSummary();
    const booked = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.ok(booked, 'the forfeited pot must be recorded, not merely lost track of');
    assert.equal(booked!.amount, pool.net - paid, 'the house keeps exactly what the players did not take');
    /* Conservation, which is the point of the whole file. */
    assert.equal(paid + booked!.amount, pool.net, 'the pot did not add up');
    assert.equal((booked!.metadata as any).players, 3);
    assert.equal((booked!.metadata as any).topic, TOPIC);
  });

  /* THE OTHER ENDING OF THE SAME STORY.
   *
   * «این منطق از قبل بود ولی نمی‌دونم چرا الان یه بار کار نکرد» — the case
   * above proves the payment happens; nothing proved what happens when it
   * cannot. finalSplit only counts players whose units are above zero, so a
   * tier configured with no units hands the last player out nothing: the whole
   * pot is forfeited and the room reports that nobody survived, with no way to
   * tell that ending from any other. The outcome here is not being changed —
   * a zero share really is zero — but it must not be silent. */
  await check('a wipe-out that pays nobody says WHY, instead of forfeiting in silence', async () => {
    /* Set BEFORE the room is opened: a room snapshots the config it was created
       with, so changing it afterwards would change nothing. */
    const base = LS_DEFAULT_CONFIG.economy.tickets;
    await updateConfig({ economy: { ...LS_DEFAULT_CONFIG.economy, rakePercent: 0,
      tickets: { ...base, green: { ...base.green, units: 0 } } } } as any);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    let roomId = '', ids: string[] = [], net = 0;
    try {
      const room = await openRoom(3); roomId = room.roomId; ids = room.ids;
      const r = (await getRoom(roomId))!;
      assert.equal(r.config.economy.tickets.green?.units, 0, 'the tier should be carrying no units');
      net = buildPool(r.config, ids.map(() => 'green')).net;
      await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));
    } finally { console.warn = realWarn; }

    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'finished');
    const players = await listPlayers(roomId);
    assert.equal(players.reduce((n, p) => n + p.payoutCash, 0), 0, 'nobody can be paid out of a zero share');

    const line = warnings.find((w) => w.includes('ls_wipeout_not_paid'));
    assert.ok(line, 'the pot was forfeited and nothing said why: ' + warnings.length + ' warnings seen');
    assert.match(line!, /zero share/, line!);
    /* The numbers that decided it are the point of the line — a reason with no
       figures is another thing to guess at. */
    assert.match(line!, /"units":0/, line!);
    assert.match(line!, /"roomId":"/, line!);
    assert.match(line!, new RegExp('"remaining":' + net), line!);

    /* And the money is still accounted for, exactly as before. */
    const house = await houseRevenueSummary();
    const booked = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.ok(booked, 'the pot must still be booked to the house');
    assert.equal(booked!.amount, net, 'the whole pot, since nothing was paid');

    await updateConfig({ economy: { ...LS_DEFAULT_CONFIG.economy, rakePercent: 0, tickets: { ...base } } } as any);
  });

  /* TWO PLAYERS, BOTH WRONG, BOTH PAID.
   *
   * «اگه دو نفر کنار هم بازی کنن و دوتاشونم اشتباه جواب بدن، به یکی می‌ده جایزه
   *  به یکی نمی‌ده و این بده. می‌خوام درصدی از پات رو واقعاً تقسیم کنیم بین
   *  کاربرا و درصدی هم خودمون برداریم و این درصدها در پنل قابل تغییر باشه.»
   *
   * This is the case that was reported from four real matches, and it is the
   * one the old rule got wrong: it paid the single last player out and left the
   * other with nothing for the same mistake. */
  await check('two players both wrong: BOTH are paid, by the operator’s percentage', async () => {
    await updateConfig({ economy: { ...LS_DEFAULT_CONFIG.economy, rakePercent: 0,
      wipeoutPlayerPercent: 60 } } as any);
    await updateConfig({ room: { capacity: 2, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 } });

    const { roomId, ids } = await openRoom(2);
    const r0 = (await getRoom(roomId))!;
    const net = buildPool(r0.config, ids.map(() => 'green')).net;
    assert.ok(net > 0);
    await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));

    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'finished');
    const players = await listPlayers(roomId);
    assert.equal(players.filter((p) => p.status === 'alive').length, 0, 'nobody survived');

    /* Nobody is left out. That is the whole point of the change. */
    for (const u of ids) {
      const row = players.find((p) => p.userId === u)!;
      const acct = await getAccount(u);
      assert.ok(row.payoutCash > 0, u + ' was paid nothing while the other was paid');
      assert.equal(acct.available, row.payoutCash, u + '’s wallet does not hold what they were paid');
    }
    /* Same ticket, same units → the same figure for both. */
    const [pa, pb] = ids.map((u) => players.find((p) => p.userId === u)!.payoutCash);
    assert.ok(Math.abs(pa! - pb!) <= 1, 'equal stakes should get equal shares: ' + pa + ' vs ' + pb);

    const paid = players.reduce((sum, p) => sum + p.payoutCash, 0);
    const want = Math.floor((net * 60) / 100);
    assert.ok(Math.abs(paid - want) <= 2, 'players got ' + paid + ', not the configured ' + want + ' of ' + net);

    const house = await houseRevenueSummary();
    const booked = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.ok(booked, 'the rest must be booked to the house');
    assert.equal(booked!.amount, net - paid, 'the house should keep exactly the remainder');
    assert.equal(paid + booked!.amount, net, 'the pot did not add up');

    /* AND THE SCREEN IS TOLD. Paying correctly is half of it: the first match
       that was reported said «باختی» to both players, because nothing reaching
       the client said this ending had happened at all. The snapshot has to
       carry it, and carry enough of it to write the sentence with. */
    const snap = await snapshot(roomId, ids[0]!);
    const w = (snap as any).room.wipeout;
    assert.ok(w, 'the snapshot does not report the wipe-out, so the screen cannot explain it');
    assert.equal(w.paidCount, 2, 'it should say both were paid');
    assert.equal(w.splitAmong, 2);
    assert.equal(w.percent, 60, 'the percentage the sentence quotes must be the one that was used');
    assert.equal(w.paid, paid, 'the total it reports is not what was actually paid');

    /* And the same thing on the live wire, for the client that is still watching
       when the room ends rather than polling afterwards. */
    const ev = ended.get(roomId);
    assert.ok(ev, 'the room ended without announcing it');
    assert.ok(ev.wipeout, 'the ending event does not carry the wipe-out, so a watching client is told nothing');
    assert.equal(ev.wipeout.paidCount, 2);
    assert.equal(ev.wipeout.percent, 60);
    assert.equal(ev.wipeout.paid, paid);
  });

  await check('the percentage is the operator’s, not a constant', async () => {
    /* The same room twice, at two settings: if the figure does not move with
       the number in the panel, the number in the panel is decoration. */
    const takes: number[] = [];
    for (const pct of [20, 90]) {
      await updateConfig({ economy: { ...LS_DEFAULT_CONFIG.economy, rakePercent: 0, wipeoutPlayerPercent: pct } } as any);
      const { roomId, ids } = await openRoom(2);
      const net = buildPool((await getRoom(roomId))!.config, ids.map(() => 'green')).net;
      await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));
      const players = await listPlayers(roomId);
      const paid = players.reduce((s, p) => s + p.payoutCash, 0);
      assert.ok(Math.abs(paid - Math.floor((net * pct) / 100)) <= 2,
        'at ' + pct + '% the players got ' + paid + ' of ' + net);
      takes.push(paid);
    }
    assert.ok(takes[1]! > takes[0]!, 'a bigger percentage must pay more: ' + takes.join(' vs '));
  });

  await check('zero percent keeps the whole pot, and says so', async () => {
    await updateConfig({ economy: { ...LS_DEFAULT_CONFIG.economy, rakePercent: 0, wipeoutPlayerPercent: 0 } } as any);
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    let roomId = '', net = 0;
    try {
      const room = await openRoom(2); roomId = room.roomId;
      net = buildPool((await getRoom(roomId))!.config, room.ids.map(() => 'green')).net;
      await playRound(roomId, Object.fromEntries(room.ids.map((u) => [u, 1])));
    } finally { console.warn = realWarn; }
    const players = await listPlayers(roomId);
    assert.equal(players.reduce((s, p) => s + p.payoutCash, 0), 0, 'nobody should be paid at 0%');
    const house = await houseRevenueSummary();
    const booked = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.equal(booked!.amount, net, 'the house keeps all of it');
    const line = warnings.find((w) => w.includes('ls_wipeout_not_paid'));
    assert.ok(line, 'paying nobody must not be silent');
    assert.match(line!, /"percent":0/, line!);
    /* Put the shipped setting back for the cases after this one. */
    await updateConfig({ economy: { ...LS_DEFAULT_CONFIG.economy, rakePercent: 0 } } as any);
    await updateConfig({ room: { capacity: 3, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 } });
  });

  await check('a room with a survivor books nothing as forfeited', async () => {
    const { roomId, ids } = await openRoom(3);
    const [a, b, c] = ids as [string, string, string];
    /* `a` keeps answering correctly; the other two go out on round one. With
     * minSurvivors 1 the room ends there and `a` takes the pot. */
    await playRound(roomId, { [a]: 0, [b]: 1, [c]: 1 });
    const after = (await getRoom(roomId))!;
    assert.equal(after.status, 'finished');
    assert.ok((await getAccount(a)).available > 0, 'the survivor must be paid');
    const house = await houseRevenueSummary();
    assert.ok(!house.recent.some((h) => h.refId === roomId && h.source === 'ls_forfeited_pot'),
      'nothing is forfeited when somebody won');
  });

  await check('what a player already cashed out is not forfeited twice', async () => {
    /* The forfeited amount is what is LEFT, so a cash-out earlier in the match
     * must come off it. Set up: four players, one cashes out, the rest all miss. */
    await updateConfig({ room: { capacity: 4, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 } });
    const { roomId, ids } = await openRoom(4);
    const [a, b, c, d] = ids as [string, string, string, string];
    const room = (await getRoom(roomId))!;
    const pool = buildPool(room.config, ids.map(() => 'green'));

    /* Round one: everyone survives, then `a` takes the money and leaves. */
    let r = (await getRoom(roomId))!;
    if (r.phase === 'ready') await step(roomId);
    r = (await getRoom(roomId))!;
    for (const u of ids) await submitAnswer(roomId, u, r.round, 0);
    await step(roomId);                                  // grade
    await step(roomId);                                  // elimination → dashboard
    await step(roomId);                                  // dashboard → cashout
    r = (await getRoom(roomId))!;
    assert.equal(r.phase, 'cashout', 'four survivors should be offered a cash-out');
    const { submitDecision } = await import('../services/lastSurvivorWorker.js');
    await submitDecision(roomId, a, r.round, 'cashout');
    await step(roomId);                                  // process cash-outs → round 2

    const cashed = (await getAccount(a)).available;
    assert.ok(cashed > 0, 'the cash-out must actually pay');

    /* Round two: the three who stayed all miss. */
    await playRound(roomId, { [b]: 1, [c]: 1, [d]: 1 });
    assert.equal((await getRoom(roomId))!.status, 'finished');

    const players = await listPlayers(roomId);
    const paid = players.reduce((sum, p) => sum + p.payoutCash, 0);
    /* The cash-out plus the last player's share — the wipe-out rule applies here
       too, on whatever was left after `a` took their money out. */
    const endRound = (await getRoom(roomId))!.round;
    const lastRound = players.filter((p) => p.status === 'eliminated' && p.eliminatedRound === endRound);
    const order = eliminationOrder(roomId, endRound, lastRound.map((p) => p.userId));
    const lastOut = order[order.length - 1]!;
    assert.ok(players.find((p) => p.userId === lastOut)!.payoutCash > 0, 'the last one out was not paid');

    const house = await houseRevenueSummary();
    const booked = house.recent.find((h) => h.refId === roomId && h.source === 'ls_forfeited_pot');
    assert.ok(booked, 'the rest of the pot must still be booked');
    assert.equal(booked!.amount, pool.net - paid,
      'only what was left after the cash-out AND the last share is forfeited');
    /* Conservation: paid out + kept by the house === the whole net pot. */
    assert.equal(paid + booked!.amount, pool.net);
    assert.ok(paid > cashed, 'the wipe-out share was not paid on top of the cash-out');
    await updateConfig({ room: { capacity: 3, minUsers: 2, waitSeconds: 0, manualStartEnabled: true, startPct: 70 } });
  });

  await check('the commission on a Last Survivor pot is booked too', async () => {
    setCommission(10);
    const { roomId, ids } = await openRoom(3);
    const room = (await getRoom(roomId))!;
    const pool = buildPool(room.config, ids.map(() => 'green'));
    assert.ok(pool.gross > pool.net, 'a 10% commission should shrink the net pot');
    await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));

    const house = await houseRevenueSummary();
    const rake = house.recent.find((h) => h.refId === roomId && h.source === 'ls_rake');
    assert.ok(rake, 'the rake was previously invisible in every report');
    assert.equal(rake!.amount, pool.gross - pool.net);
    setCommission(0);
  });

  await check('booking the same room twice does not double-count', async () => {
    const before = (await houseRevenueSummary()).total;
    const { roomId, ids } = await openRoom(3);
    await playRound(roomId, Object.fromEntries(ids.map((u) => [u, 1])));
    const once = (await houseRevenueSummary()).total;
    /* A worker retry, or a replayed tick after a restart, must not book again. */
    await advanceRoom((await getRoom(roomId))!);
    const twice = (await houseRevenueSummary()).total;
    assert.ok(once > before, 'the first ending should book something');
    assert.equal(twice, once, 'a repeat must add nothing');
  });

  await check('the summary groups by source and totals correctly', async () => {
    const h = await houseRevenueSummary();
    const sum = h.bySource.reduce((s, b) => s + b.amount, 0);
    assert.equal(h.total, sum);
    assert.ok(h.bySource.some((b) => b.source === 'ls_forfeited_pot'));
  });

  console.log(`[lastSurvivorForfeit] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
