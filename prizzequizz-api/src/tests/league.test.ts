/* THE WEEKLY LEAGUE — WHO GETS IN, AND WHAT IT PAYS.
 *
 * Everything here moves real money or a ticket that cannot be bought, so the
 * cases are the ones where a mistake is expensive:
 *
 *   — closing the week twice handing out two tickets each.
 *   — a league ticket being purchasable after all, which turns a ladder into a
 *     price list.
 *   — paying the participation prize to somebody who never turned up, or twice
 *     to somebody who did.
 *   — a bracket that leaves one player alone in a room and calls them a winner.
 *
 * Run: npx tsx src/tests/league.test.ts
 */
import assert from 'node:assert/strict';
import {
  getLeagueConfig, setLeagueConfig, closeSeason, drawRound, listQualifiers,
  listRooms, listSeats, reportRoomResult, splitRooms, kickoffFor, cutLines,
  myLeague, isLeagueTicketTier, _resetLeague, LEAGUE_DEFAULTS, weekResetAt,
  enterLeague, LEAGUE_FULL_START_MS,
  voidTicketsAfterKickoff, lastKickoffAt, LEAGUE_TICKET_GRACE_MS
} from '../services/leagueService.js';
import { closeTick, leagueTick } from '../services/leagueWorker.js';
import { openForLeagueRoom, join as wtaJoin, snapshot as wtaSnapshot } from '../services/wtaService.js';
import { getTickets, grantTickets } from '../services/ticketService.js';
import { repositories } from '../repositories/index.js';
import { isoWeekId } from '../services/scoringConfig.js';
import { getAccount } from '../services/walletLedgerService.js';
import { quote } from '../services/purchaseOrderService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

let seq = 0;
/* Every board in this file shares one user table, so a second board built with
 * the same cup values lands interleaved with the first and every rank assertion
 * becomes a lie. Each board is therefore given a band of cup values strictly
 * above every band before it: the newest board always holds ranks 1..n and the
 * older players sit underneath, exactly as a real week rolling over would. */
let bandNo = 0;
async function player(cup: number): Promise<string> {
  const uid = 'lg' + (++seq).toString().padStart(3, '0');
  await repositories.users.save({
    id: uid, username: uid, displayName: uid, phone: '0917' + String(seq).padStart(7, '0'),
    plan: 'free', level: 1, xp: 0, weeklyScore: cup, weeklyWeek: isoWeekId(),
    wallet: 0, coins: 0, hearts: 5, tickets: { bronze: 0, silver: 0, gold: 0 }
  } as any);
  return uid;
}
/** A board of `n` players, best first. */
async function board(n: number): Promise<string[]> {
  const base = ++bandNo * 1_000_000;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await player(base - i * 10));
  return out;
}

async function fresh(): Promise<void> {
  _resetLeague();
  await setLeagueConfig({ ...LEAGUE_DEFAULTS });
}

async function run(): Promise<void> {
  /* ── who gets in ──────────────────────────────────────────────────── */

  await check('the top of the board qualifies, in the configured bands', async () => {
    await fresh();
    const ids = await board(50);
    const r = await closeSeason('s-bands');
    const tierOf = (uid: string) => r.qualifiers.find((q) => q.userId === uid)?.tier ?? null;
    assert.equal(tierOf(ids[0]!), 'gold', 'rank 1');
    assert.equal(tierOf(ids[14]!), 'gold', 'rank 15 is the last gold place');
    assert.equal(tierOf(ids[15]!), 'silver', 'rank 16 starts silver');
    assert.equal(tierOf(ids[29]!), 'silver', 'rank 30');
    assert.equal(tierOf(ids[30]!), 'bronze', 'rank 31');
    assert.equal(tierOf(ids[44]!), 'bronze', 'rank 45');
    assert.equal(tierOf(ids[45]!), null, 'rank 46 is outside every band');
    assert.equal(r.qualifiers.length, 45);
  });

  await check('the bands are the operator’s to change', async () => {
    await fresh();
    await setLeagueConfig({ tiers: [
      { ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: 10 },
      { ...LEAGUE_DEFAULTS.tiers[1]!, fromRank: 11, toRank: 20 },
      { ...LEAGUE_DEFAULTS.tiers[2]!, fromRank: 21, toRank: 30 }
    ] });
    const ids = await board(35);
    const r = await closeSeason('s-custom');
    assert.equal(r.qualifiers.length, 30);
    assert.equal(r.qualifiers.find((q) => q.userId === ids[9]!)?.tier, 'gold', 'rank 10 is now the last gold');
    assert.equal(r.qualifiers.find((q) => q.userId === ids[10]!)?.tier, 'silver');
  });

  await check('qualifying hands out exactly one ticket each', async () => {
    await fresh();
    const ids = await board(20);
    await closeSeason('s-tickets');
    const gold = await getTickets(ids[0]!);
    assert.equal(gold.gold, 1, 'the top player has one gold ticket: ' + JSON.stringify(gold));
    const silver = await getTickets(ids[15]!);
    assert.equal(silver.silver, 1, JSON.stringify(silver));
    assert.equal((await getTickets(ids[0]!)).silver ?? 0, 0, 'and only the one tier');
  });

  await check('closing the same week twice does NOT hand out a second ticket', async () => {
    /* An operator presses the button again; a cron fires twice. */
    await fresh();
    const ids = await board(5);
    const first = await closeSeason('s-twice');
    const again = await closeSeason('s-twice');
    assert.equal(again.ticketsGranted, 0, 'the second close granted ' + again.ticketsGranted);
    assert.equal((await getTickets(ids[0]!)).gold, 1, 'still exactly one ticket');
    assert.equal((await listQualifiers('s-twice')).length, first.qualifiers.length, 'and the list is not doubled');
  });

  /* ── the ticket cannot be bought ──────────────────────────────────── */

  await check('a league ticket is not for sale', async () => {
    await fresh();
    await getLeagueConfig();
    for (const tier of ['gold', 'silver', 'bronze']) {
      assert.ok(isLeagueTicketTier(tier), tier + ' must be recognised as a league ticket');
      await assert.rejects(() => quote({ kind: 'ticket', tier, qty: 1 } as any),
        (e: any) => e?.code === 'LEAGUE_TICKET_NOT_FOR_SALE', 'buying ' + tier + ' was not refused');
    }
  });

  await check('but the ordinary match tickets still are', async () => {
    /* The guard must not take the shop down with it. */
    const q = await quote({ kind: 'ticket', tier: 'green', qty: 1 } as any);
    assert.ok(q.amount > 0, 'a green ticket still has a price: ' + JSON.stringify(q));
    assert.ok(!isLeagueTicketTier('green'));
  });

  /* ── the draw ─────────────────────────────────────────────────────── */

  await check('a tier that fits in one room plays one room', () => {
    assert.deepEqual(splitRooms(15, 15), [15]);
    assert.deepEqual(splitRooms(10, 15), [10]);
    assert.deepEqual(splitRooms(2, 15), [2]);
  });

  await check('a hundred players in rooms of ten is ten rooms of ten', () => {
    assert.deepEqual(splitRooms(100, 10), new Array(10).fill(10));
  });

  await check('and nobody is ever left alone in a room', () => {
    /* 16 into rooms of 15 is the trap: 15 and 1, and the lone player would
       "win" a room they never played. */
    const sizes = splitRooms(16, 15);
    assert.ok(!sizes.includes(1), 'a room of one was created: ' + JSON.stringify(sizes));
    assert.equal(sizes.reduce((a, b) => a + b, 0), 16, 'and everybody still has a seat');
    for (const n of [3, 7, 16, 31, 46, 101]) {
      const s = splitRooms(n, 15);
      assert.ok(!s.includes(1), n + ' → ' + JSON.stringify(s));
      assert.equal(s.reduce((a, b) => a + b, 0), n, n + ' → ' + JSON.stringify(s));
    }
  });

  await check('the draw seats every qualifier exactly once', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 10 });
    await board(45);
    await closeSeason('s-draw');
    const rooms = await drawRound('s-draw', 1);
    const gold = rooms.filter((r) => r.tier === 'gold');
    assert.equal(gold.length, 2, '15 gold players in rooms of 10 → 2 rooms, got ' + gold.length);

    const seen = new Set<string>();
    for (const room of rooms) {
      for (const s of await listSeats(room.id)) {
        assert.ok(!seen.has(s.userId), 'seated twice: ' + s.userId);
        seen.add(s.userId);
      }
    }
    assert.equal(seen.size, 45, 'everybody has a seat: ' + seen.size);
  });

  await check('drawing the same round twice does not double the rooms', async () => {
    const before = (await listRooms('s-draw', undefined, 1)).length;
    await drawRound('s-draw', 1);
    assert.equal((await listRooms('s-draw', undefined, 1)).length, before);
  });

  await check('the next round seats the winners of the round before', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 5, tiers: [{ ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: 20 }] });
    const ids = await board(20);
    await closeSeason('s-rounds');
    const r1 = await drawRound('s-rounds', 1);
    assert.equal(r1.length, 4, '20 players in rooms of 5: ' + r1.length);

    /* Each room reports a winner. */
    const winners: string[] = [];
    for (const room of r1) {
      const seats = await listSeats(room.id);
      const w = seats[0]!.userId;
      winners.push(w);
      await reportRoomResult({ roomId: room.id, played: seats.map((s) => s.userId), winnerUserId: w });
    }
    const r2 = await drawRound('s-rounds', 2);
    assert.equal(r2.length, 1, 'four winners meet in one final');
    const finalSeats = (await listSeats(r2[0]!.id)).map((s) => s.userId).sort();
    assert.deepEqual(finalSeats, winners.slice().sort(), 'and it is exactly the winners');
    assert.ok(r2[0]!.startsAt > r1[0]!.startsAt, 'the final is after the first round');
    void ids;
  });

  /* ── the money ────────────────────────────────────────────────────── */

  async function wallet(uid: string): Promise<number> {
    try { return (await getAccount(uid)).available; } catch { return 0; }
  }

  await check('everyone who played is paid, win or lose', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 5, tiers: [{ ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: 5, participationPrize: 1000, winnerPrize: 9000 }] });
    const ids = await board(5);
    await closeSeason('s-pay');
    const [room] = await drawRound('s-pay', 1);
    const seats = (await listSeats(room!.id)).map((s) => s.userId);
    const winner = seats[0]!;
    const loser = seats[1]!;

    const r = await reportRoomResult({ roomId: room!.id, played: seats, winnerUserId: winner });
    assert.equal(r.payouts.filter((p) => p.kind === 'participation').length, 5, 'five participation prizes');
    assert.equal(r.payouts.filter((p) => p.kind === 'winner').length, 1, 'one winner prize');
    assert.equal(await wallet(loser), 1000, 'the loser is still paid for turning up');
    assert.equal(await wallet(winner), 10000, 'the winner gets both: ' + await wallet(winner));
    void ids;
  });

  await check('somebody who never turned up is paid NOTHING', async () => {
    /* The seat is booked whether they come or not, so paying for the seat
       instead of for playing is an income for an idle account. */
    await fresh();
    await setLeagueConfig({ roomSize: 5, tiers: [{ ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: 5, participationPrize: 1000, winnerPrize: 9000 }] });
    await board(5);
    await closeSeason('s-absent');
    const [room] = await drawRound('s-absent', 1);
    const seats = (await listSeats(room!.id)).map((s) => s.userId);
    const absent = seats[4]!;
    await reportRoomResult({ roomId: room!.id, played: seats.slice(0, 4), winnerUserId: seats[0]! });
    assert.equal(await wallet(absent), 0, 'the absentee was paid something');
    const seat = (await listSeats(room!.id)).find((s) => s.userId === absent)!;
    assert.equal(seat.status, 'absent');
    assert.equal(seat.paid, false);
  });

  await check('filing the same result twice does not pay twice', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 5, tiers: [{ ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: 5, participationPrize: 1000, winnerPrize: 9000 }] });
    await board(5);
    await closeSeason('s-double');
    const [room] = await drawRound('s-double', 1);
    const seats = (await listSeats(room!.id)).map((s) => s.userId);
    await reportRoomResult({ roomId: room!.id, played: seats, winnerUserId: seats[0]! });
    const before = await wallet(seats[0]!);
    const again = await reportRoomResult({ roomId: room!.id, played: seats, winnerUserId: seats[0]! });
    assert.equal(again.payouts.length, 0, 'the second filing paid ' + JSON.stringify(again.payouts));
    assert.equal(await wallet(seats[0]!), before, 'and the balance did not move');
  });

  await check('a winner who was not in the room cannot be declared', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 5, tiers: [{ ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: 5, participationPrize: 100, winnerPrize: 9000 }] });
    await board(5);
    const stranger = await player(1);
    await closeSeason('s-fake');
    const [room] = await drawRound('s-fake', 1);
    const seats = (await listSeats(room!.id)).map((s) => s.userId);
    const r = await reportRoomResult({ roomId: room!.id, played: seats, winnerUserId: stranger });
    assert.equal(r.room.winnerUserId, null, 'an outsider was made champion');
    assert.equal(await wallet(stranger), 0);
    assert.equal(r.payouts.filter((p) => p.kind === 'winner').length, 0, 'and no winner prize was paid');
  });

  /* ── the badges on the cup rail ───────────────────────────────────── */

  await check('each badge shows the cup of the last player inside that tier', async () => {
    await fresh();
    const ids = await board(50);
    const lines = await cutLines();
    const gold = lines.find((l) => l.key === 'gold')!;
    const me15 = (await repositories.users.findById(ids[14]!))!;
    assert.equal(gold.cup, me15.weeklyScore, 'the gold badge must read rank 15’s cup');
    assert.equal(gold.rank, 15);
    assert.ok(gold.exact, 'and say it is the real cut line');
    const bronze = lines.find((l) => l.key === 'bronze')!;
    const me45 = (await repositories.users.findById(ids[44]!))!;
    assert.equal(bronze.cup, me45.weeklyScore, 'and bronze rank 45’s');
  });

  await check('a short board falls back to the last player, and says so', async () => {
    /* A cut line further down than the board is long. Asked for with a rank
       nobody can reach rather than by shrinking the board, because these tests
       share one user table and it only ever grows. */
    await fresh();
    await board(20);
    await setLeagueConfig({ tiers: [
      { ...LEAGUE_DEFAULTS.tiers[0]!, fromRank: 1, toRank: 5 },
      { ...LEAGUE_DEFAULTS.tiers[2]!, fromRank: 6, toRank: 99999 }
    ] });
    const lines = await cutLines();
    const deep = lines.find((l) => l.key === 'bronze')!;
    assert.equal(deep.exact, false, 'a rank the board cannot reach is not an exact cut line');
    assert.ok(deep.cup > 0, 'and it still shows the last player’s cup rather than nothing: ' + deep.cup);
    const gold = lines.find((l) => l.key === 'gold')!;
    assert.ok(gold.exact, 'while a tier the board DOES reach is exact');
    assert.ok(gold.cup >= deep.cup, 'the higher tier’s cut line is never below the lower one');
  });

  /* ── what a player is told ────────────────────────────────────────── */

  await check('a player is told their rank, their tier and when it starts', async () => {
    await fresh();
    const ids = await board(40);
    const mine = await myLeague(ids[3]!);
    assert.equal(mine.rank, 4);
    assert.equal(mine.tier?.key, 'gold');
    assert.ok(mine.kickoffAt > Date.now(), 'kickoff is in the future');
    assert.equal(mine.cutLines.length, 3);
  });

  await check('and which room they are in once it is drawn', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 5 });
    const ids = await board(20);
    await closeSeason(isoWeekId());
    await drawRound(isoWeekId(), 1);
    const mine = await myLeague(ids[0]!);
    assert.ok(mine.room, 'no room was reported');
    assert.equal(mine.room!.round, 1);
    assert.ok(mine.room!.seats >= 2, 'a room with real company: ' + mine.room!.seats);
    assert.equal(mine.qualifiedTier, 'gold');
  });

  await check('somebody outside the bands is told plainly that they are out', async () => {
    await fresh();
    const ids = await board(50);
    const mine = await myLeague(ids[49]!);
    assert.equal(mine.rank, 50);
    assert.equal(mine.tier, null, 'rank 50 is in no tier');
    assert.equal(mine.qualifiedTier, null);
    assert.equal(mine.room, null);
  });

  /* ── kickoff ──────────────────────────────────────────────────────── */

  await check('kickoff lands on the configured day and time, and never in the past', async () => {
    const cfg = await getLeagueConfig();
    for (let i = 0; i < 14; i++) {
      const from = new Date(Date.UTC(2026, 0, 1 + i, 5, 17));
      const at = kickoffFor(cfg, from);
      assert.ok(at > from.getTime(), 'kickoff must be ahead of now');
      const local = new Date(at + cfg.kickoff.tzOffsetMinutes * 60_000);
      assert.equal(local.getUTCHours(), cfg.kickoff.hour, 'hour');
      assert.equal(local.getUTCMinutes(), cfg.kickoff.minute, 'minute');
      assert.equal((local.getUTCDay() + 1) % 7, cfg.kickoff.dayOfWeek, 'weekday');
      assert.ok(at - from.getTime() <= 7 * 86400_000, 'and within the week');
    }
  });

  /* ── the week closing itself ──────────────────────────────────────── */

  /* The board is scoped to the ISO week, so a close that happens after the
   * boundary rewards nobody: every weekly score reads as zero. The worker
   * therefore has to fire in the last minutes of the week, and not before. */
  await check('the week is frozen in its final minutes, and not a day early', async () => {
    const reset = weekResetAt(Date.UTC(2026, 2, 4, 11, 0));   // a Wednesday
    const at = new Date(reset);
    assert.equal(at.getUTCDay(), 1, 'the board resets on a Monday');
    assert.equal(at.getUTCHours(), 0, 'at midnight');
    assert.ok(reset > Date.UTC(2026, 2, 4, 11, 0), 'and it is ahead of the Wednesday');
    /* isoWeekId is what everything else is keyed by — a second before the
     * boundary must still be this week, a second after must not. */
    assert.equal(isoWeekId(new Date(reset - 1000)), isoWeekId(new Date(Date.UTC(2026, 2, 4, 11, 0))));
    assert.notEqual(isoWeekId(new Date(reset + 1000)), isoWeekId(new Date(Date.UTC(2026, 2, 4, 11, 0))));
  });

  await check('the worker does nothing mid-week and closes once at the end', async () => {
    await fresh();
    const ids = await board(20);
    const reset = weekResetAt();

    assert.equal(await closeTick(reset - 6 * 60_000), false, 'six minutes out is not the last moment');
    assert.equal((await listQualifiers(isoWeekId())).length, 0, 'and nothing was frozen');

    assert.equal(await closeTick(reset - 60_000), true, 'a minute out is');
    const quals = await listQualifiers(isoWeekId());
    assert.ok(quals.length >= 20, 'the board was frozen');
    assert.equal((await getTickets(ids[0]!)).gold, 1, 'and the top player has their ticket');

    /* Every tick until the boundary must not hand out a second one. */
    assert.equal(await closeTick(reset - 30_000), false);
    assert.equal(await closeTick(reset - 1000), false);
    assert.equal((await getTickets(ids[0]!)).gold, 1, 'still exactly one ticket');
  });

  /* The worker's own tick is what actually runs in production — closing the
   * week has to be wired INTO it, not merely available beside it. */
  await check('the worker’s tick is what closes the week', async () => {
    await fresh();
    const ids = await board(20);
    await leagueTick(weekResetAt() - 60_000);
    assert.ok((await listQualifiers(isoWeekId())).length >= 20, 'the tick froze the board');
    assert.equal((await getTickets(ids[0]!)).gold, 1, 'and handed out the ticket');
  });

  /* «بلیطم همون‌جوری مونده و باطل نشده» — a league ticket is a seat at ONE
   * kickoff. Carrying it into the next week would mean one good week bought a
   * place in the league for good. */
  await check('an unused league ticket is voided when the next week closes', async () => {
    await fresh();
    const lastWeek = await board(20);
    await closeSeason('2020-W01');                       // a season id of its own
    assert.equal((await getTickets(lastWeek[0]!)).gold, 1, 'last week they qualified');

    /* This week somebody else is on top and the old ticket is gone. */
    const thisWeek = await board(20);
    const r = await closeSeason(isoWeekId());
    assert.ok(r.ticketsVoided >= 1, 'the stale tickets were voided: ' + r.ticketsVoided);
    assert.equal((await getTickets(lastWeek[0]!)).gold, 0, 'the absentee no longer holds one');
    assert.equal((await getTickets(thisWeek[0]!)).gold, 1, 'and this week’s leader does');
  });

  await check('a player who qualifies two weeks running keeps exactly one', async () => {
    await fresh();
    const ids = await board(20);
    await closeSeason('2020-W02');
    assert.equal((await getTickets(ids[0]!)).gold, 1);
    /* Same board, next season: the old one is voided and a new one granted, and
     * the order of those two operations is what decides whether they end the
     * week holding one ticket or none. */
    await closeSeason(isoWeekId());
    assert.equal((await getTickets(ids[0]!)).gold, 1, 'one ticket, not zero and not two');
  });

  await check('voiding never touches a ticket the player bought', async () => {
    await fresh();
    const ids = await board(20);
    await grantTickets(ids[0]!, 'red', 3);
    await closeSeason('2020-W03');
    await closeSeason(isoWeekId());
    assert.equal((await getTickets(ids[0]!)).red, 3, 'the bought tickets are untouched');
  });

  /* ── the ticket expires with the match ────────────────────────────── */

  /* «سر مسابقه لیگ نرفتم و باز هم بلیطم موجوده» — the ticket is a seat at ONE
   * kickoff, so it goes a few hours after that kickoff, not at the far end of
   * the following week. */
  await check('a ticket left unused dies a few hours after the kickoff', async () => {
    await fresh();
    const ids = await board(20);
    await closeSeason('2019-W40');                    // closed in an earlier week
    assert.equal((await getTickets(ids[0]!)).gold, 1);

    const cfg = await getLeagueConfig();
    const justAfter = lastKickoffAt(cfg) + 60_000;    // the match has just ended
    assert.equal(await voidTicketsAfterKickoff(justAfter), 0, 'not while the room might still be running');

    const later = lastKickoffAt(cfg) + LEAGUE_TICKET_GRACE_MS + 60_000;
    const gone = await voidTicketsAfterKickoff(later);
    assert.ok(gone >= 1, 'nothing was voided: ' + gone);
    assert.equal((await getTickets(ids[0]!)).gold, 0, 'the absentee still holds a ticket');
  });

  await check('and it is not taken twice, nor from somebody who bought one', async () => {
    await fresh();
    const ids = await board(20);
    await grantTickets(ids[0]!, 'red', 2);
    await closeSeason('2019-W41');
    const cfg = await getLeagueConfig();
    const later = lastKickoffAt(cfg) + LEAGUE_TICKET_GRACE_MS + 60_000;
    await voidTicketsAfterKickoff(later);
    assert.equal(await voidTicketsAfterKickoff(later + 60_000), 0, 'it ran a second time');
    assert.equal((await getTickets(ids[0]!)).red, 2, 'a bought ticket was taken');
  });

  /* The close and the expiry both run on the same tick. The tickets handed out
   * at the close are for NEXT week's kickoff — taking them back because LAST
   * week's kickoff is over would leave the league permanently empty. */
  await check('the tickets just handed out are not voided by the same tick', async () => {
    await fresh();
    const ids = await board(20);
    await leagueTick(weekResetAt() - 60_000);
    assert.equal((await getTickets(ids[0]!)).gold, 1, 'the fresh ticket was voided on the spot');
  });

  /* ── «شروع مسابقه لیگ» ────────────────────────────────────────────── */

  /* The button is the whole entry now: no seat is drawn in advance, the player
   * presses it at kickoff and the server decides where they sit. */
  await check('the door is shut until kickoff is close', async () => {
    await fresh();
    const ids = await board(20);
    await closeSeason(isoWeekId());
    const cfg = await getLeagueConfig();
    const kick = kickoffFor(cfg);
    await assert.rejects(() => enterLeague(ids[0]!, kick - 60 * 60_000),
      (e: any) => e?.code === 'DOORS_CLOSED', 'an hour early must be refused');
    const r = await enterLeague(ids[0]!, kick);
    assert.ok(r.joined, 'and at kickoff it opens');
  });

  await check('somebody outside the league cannot walk in', async () => {
    await fresh();
    const ids = await board(50);
    await closeSeason(isoWeekId());
    const cfg = await getLeagueConfig();
    await assert.rejects(() => enterLeague(ids[49]!, kickoffFor(cfg)),
      (e: any) => e?.code === 'NOT_QUALIFIED');
  });

  await check('and neither can a qualifier whose ticket is gone', async () => {
    await fresh();
    const ids = await board(20);
    await closeSeason(isoWeekId());
    const cfg = await getLeagueConfig();
    await grantTickets(ids[0]!, 'gold', -1);
    await assert.rejects(() => enterLeague(ids[0]!, kickoffFor(cfg)),
      (e: any) => e?.code === 'NO_LEAGUE_TICKET');
  });

  await check('entering spends exactly one ticket, and a second tap spends none', async () => {
    await fresh();
    const ids = await board(20);
    await closeSeason(isoWeekId());
    const cfg = await getLeagueConfig();
    const kick = kickoffFor(cfg);
    assert.equal((await getTickets(ids[0]!)).gold, 1);
    const first = await enterLeague(ids[0]!, kick);
    assert.equal((await getTickets(ids[0]!)).gold, 0, 'the ticket was taken');
    const again = await enterLeague(ids[0]!, kick + 1000);
    assert.equal(again.joined, false, 'the second tap is not a second entry');
    assert.equal(again.room.id, first.room.id, 'and it is the same room');
    assert.equal((await getTickets(ids[0]!)).gold, 0, 'no second ticket taken');
  });

  /* «روم‌ها یکی یکی بعد ورود تکمیل بشه» — room two must not open while room one
   * still has a free chair, or a tier of sixteen plays four rooms of four. */
  await check('rooms fill one at a time, in order', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 3 });
    const ids = await board(15);
    await closeSeason(isoWeekId());
    const cfg = await getLeagueConfig();
    const kick = kickoffFor(cfg);
    const golds = (await listQualifiers(isoWeekId(), 'gold')).map((q) => q.userId);
    assert.ok(golds.length >= 7, 'enough gold qualifiers to fill two rooms');

    const where: Array<{ no: number; seats: number }> = [];
    for (const uid of golds.slice(0, 7)) {
      const r = await enterLeague(uid, kick);
      where.push({ no: r.room.roomNo, seats: r.seats });
    }
    assert.deepEqual(where.map((w) => w.no), [1, 1, 1, 2, 2, 2, 3], JSON.stringify(where));
    assert.deepEqual(where.map((w) => w.seats), [1, 2, 3, 1, 2, 3, 1], JSON.stringify(where));
    void ids;
  });

  /* When a free chair exists in more than one room — the operator widened the
   * rooms mid-week — the next player takes the EARLIEST free one. Rooms stay
   * full from the front, which is the whole point of filling them one by one. */
  await check('and the earliest free chair is the one taken', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 3 });
    await board(15);
    await closeSeason(isoWeekId());
    const kick = kickoffFor(await getLeagueConfig());
    const golds = (await listQualifiers(isoWeekId(), 'gold')).map((q) => q.userId);
    for (const uid of golds.slice(0, 4)) await enterLeague(uid, kick);   // room 1 full, room 2 has one

    await setLeagueConfig({ roomSize: 4 });                              // both now have room
    const next = await enterLeague(golds[4]!, kick);
    assert.equal(next.room.roomNo, 1, 'the older room is filled first, not the newest');
    assert.equal(next.seats, 4);
  });

  await check('a room that fills starts without waiting for the clock', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 3 });
    await board(15);
    await closeSeason(isoWeekId());
    const cfg = await getLeagueConfig();
    const kick = kickoffFor(cfg);
    const golds = (await listQualifiers(isoWeekId(), 'gold')).map((q) => q.userId);
    let last = null as any;
    for (const uid of golds.slice(0, 3)) last = await enterLeague(uid, kick);
    assert.equal(last.full, true, 'the third player filled it');
    assert.ok(last.room.startsAt <= kick + LEAGUE_FULL_START_MS,
      'and it starts within seconds, not in three minutes: ' + (last.room.startsAt - kick) + 'ms');
    /* A part-full room still gets its fill window rather than starting alone. */
    const fourth = await enterLeague(golds[3]!, kick);
    assert.equal(fourth.full, false);
    assert.ok(fourth.room.startsAt > kick + LEAGUE_FULL_START_MS, 'room two waits for company');
  });

  /* THE WHOLE POINT IS THAT THEY END UP IN THE ROOM.
   * The room is opened by the FIRST player through the door, and everyone after
   * them takes a seat in a room that is already open — so the room itself has
   * to keep up with the seats, or the second player is told «تو در این اتاق
   * نیستی» and the feature only ever works for one person. */
  await check('everyone who walks in is really in the room', async () => {
    await fresh();
    await setLeagueConfig({ roomSize: 4 });
    await board(15);
    await closeSeason(isoWeekId());
    const kick = kickoffFor(await getLeagueConfig());
    const golds = (await listQualifiers(isoWeekId(), 'gold')).map((q) => q.userId);

    let room = null as any;
    for (const uid of golds.slice(0, 3)) {
      const r = await enterLeague(uid, kick);
      room = r.room;
      await openForLeagueRoom(r.room);
      /* The seat is only real if the room accepts them. */
      wtaJoin(r.room.id, uid);
    }
    const snap = await wtaSnapshot(room.id, golds[2]!);
    assert.ok(snap, 'the room has no snapshot');
    assert.equal(snap!.players.length, 3, 'the room holds ' + snap!.players.length + ' of the 3 who walked in');
    for (const uid of golds.slice(0, 3)) {
      const p = snap!.players.find((x: any) => x.userId === uid);
      assert.ok(p, uid + ' took a seat but is not in the room');
      assert.equal(p!.absent, false, uid + ' is in the room but marked absent — they would be out at kickoff');
    }
  });

  await check('the screen is told whether the button may be pressed, and why not', async () => {
    await fresh();
    /* THE CLOCK HAS TO BE PINNED, NOT HOPED FOR. With the shipped Friday
       kickoff «the doors are still shut» is true six days a week and false for
       the ten minutes before the whistle — so this case passed all week and
       failed on Friday night, which is the one night the league runs. Kickoff
       is moved to tomorrow, which is never inside the door window whatever day
       the suite is run on. The Persian week counts Saturday as 0. */
    const cfg0 = await getLeagueConfig();
    const tehranNow = new Date(Date.now() + cfg0.kickoff.tzOffsetMinutes * 60_000);
    const tomorrow = (tehranNow.getUTCDay() + 2) % 7;
    await setLeagueConfig({ kickoff: { ...cfg0.kickoff, dayOfWeek: tomorrow } });
    assert.ok(kickoffFor(await getLeagueConfig()) - Date.now() > 12 * 3600_000,
      'kickoff was not moved out of the door window, so this case proves nothing');

    const ids = await board(50);
    await closeSeason(isoWeekId());
    const out = await myLeague(ids[49]!);
    assert.equal(out.canEnter, false);
    assert.match(out.enterBlockedReason, /جدول لیگ نیستی/);
    /* A qualifier is only stopped by the clock. */
    const inside = await myLeague(ids[0]!);
    assert.equal(inside.canEnter, false, 'kickoff is a day away and the doors are shut');
    assert.match(inside.enterBlockedReason, /زمان ورود/);
    await setLeagueConfig({ kickoff: cfg0.kickoff });
  });

  console.log(`[league] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
