/* THE WEEKLY LEAGUE, FROM THE WEEK CLOSING TO THE WHISTLE ON FRIDAY.
 *
 * «لیگ هفتگی رو کامل بازبینی کن و بازی امروز برگزار بشه چون امروز جمعه است.»
 *
 * The whole thing hangs on one awkward fact: the standings are frozen at the
 * end of an ISO week, but the match is played on the FRIDAY AFTER — which is a
 * different ISO week. Every id, every lookup and every «current season» in the
 * code has to survive that boundary, and two of them did not:
 *
 *   1. the worker asked for the rooms of `currentSeasonId()`, which on the day
 *      of the match is the week AFTER the one the rooms are filed under, so it
 *      found nothing and no match ever started;
 *   2. nothing drew the rooms at all unless an operator remembered to press a
 *      button in the panel some time during the week.
 *
 * Neither failed loudly. An empty room list and a quiet week look identical.
 * So this test plays the calendar: close the week, walk forward to Friday, and
 * check that a match is actually there to start.
 */
import assert from 'node:assert/strict';
import {
  LEAGUE_DEFAULTS, getLeagueConfig, closeSeason, currentSeasonId, kickoffFor, listOpenRooms, listQualifiers,
  drawRound, listRooms, listSeats, reportRoomResult, setLeagueConfig, weekResetAt,
  activeSeasonId, enterLeague, myLeague, previousSeasonId, LEAGUE_DOORS_MINUTES, _resetLeague
} from '../services/leagueService.js';
import { isoWeekId } from '../services/scoringConfig.js';
import { repositories } from '../repositories/index.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const fmt = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
/** The operator's clock: Tehran, +3:30, which is what the config ships with. */
const tehran = (t: number) => new Date(t + 210 * 60_000).toISOString().slice(0, 16).replace('T', ' ');

async function seedPlayers(n: number, week: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    await repositories.users.save({
      id: `lg-${i}`, phone: '0913' + String(1000000 + i), username: 'lg' + i, displayName: 'بازیکن ' + i,
      plan: 'free', level: 3, xp: 100, weeklyScore: 1000 - i * 10, weeklyWeek: week,
      wallet: 0, coins: 0, hearts: 5, tickets: {}
    } as any);
  }
}

async function run(): Promise<void> {
  _resetLeague();
  await setLeagueConfig({ enabled: true, roomSize: 5, kickoff: LEAGUE_DEFAULTS.kickoff });

  /* A real Friday, and the Sunday night before it. 2026-08-28 is a Friday. */
  const friday = new Date('2026-08-28T09:00:00Z');
  const closeMoment = weekResetAt(new Date('2026-08-24T12:00:00Z').getTime()) - 60_000;

  /* The season the ROOMS are filed under is deliberately not the week this test
   * happens to run in. The bug was «the worker asks for the current season», and
   * a fixture whose season is the current week cannot tell a fixed lookup from a
   * correct one — it passed either way. This label can never be today. */
  /* THE SEASON WHOSE MATCH IS THE ONE THIS TEST WALKS INTO.
     It used to be «the week before TODAY», which is only the right answer when
     the suite happens to run on a Friday: the entry below is made at the next
     kickoff, and on any other day that kickoff belongs to a later week than
     today does. The season played on a given Friday is the one that ended the
     Sunday before it — so it is derived from the kickoff, not from now. */
  const kickoffAt = kickoffFor(await getLeagueConfig());
  const kickoffWeek = isoWeekId(new Date(kickoffAt));
  const closingSeason = previousSeasonId(new Date(kickoffAt));

  /* Asserted on the boundary itself. Deriving everything from weekResetAt and
   * then checking the derived value hides an error in weekResetAt: a boundary a
   * day early still lands inside the same ISO week, so every downstream check
   * keeps passing while the standings freeze on the wrong night. */
  await check('the week boundary is Monday 00:00 UTC, which is what the ISO week counts in', async () => {
    for (const day of ['2026-08-24T12:00:00Z', '2026-08-28T09:00:00Z', '2026-08-30T23:00:00Z']) {
      const b = weekResetAt(new Date(day).getTime());
      const d = new Date(b);
      assert.equal(d.getUTCDay(), 1, day + ' → ' + fmt(b) + ' is not a Monday');
      assert.equal(d.getUTCHours(), 0, day + ' → ' + fmt(b) + ' is not midnight');
      assert.ok(b > new Date(day).getTime(), day + ' → the boundary is in the past');
    }
    assert.equal(fmt(weekResetAt(new Date('2026-08-24T12:00:00Z').getTime())), '2026-08-31 00:00');
  });

  await check('the week that closes is the week that is ending', async () => {
    assert.equal(isoWeekId(new Date(closeMoment)), '2026-W35', fmt(closeMoment));
    /* The trap this file exists for: the rooms are NOT filed under the week the
       match is played in. Comparing against today's week instead was the same
       statement only on a Friday. */
    assert.notEqual(closingSeason, kickoffWeek,
      'the fixture season must not be the kickoff’s own week, or this proves nothing');
  });

  await check('and it is played on the Friday of the NEXT week — the awkward part', async () => {
    const k = kickoffFor(LEAGUE_DEFAULTS, new Date(closeMoment));
    assert.equal(isoWeekId(new Date(k)), '2026-W36',
      'kickoff ' + fmt(k) + ' lands in ' + isoWeekId(new Date(k)));
    assert.equal(tehran(k).slice(11), '21:00', 'kickoff is not 21:00 Tehran: ' + tehran(k));
    assert.equal(new Date(k + 210 * 60_000).getUTCDay(), 5, 'kickoff is not on a Friday');
  });

  /* Qualification reads the LIVE weekly board, which is scoped to the real
   * current week — so the players are seeded there, while the season they close
   * into is the fixed label above. */
  await seedPlayers(12, currentSeasonId());
  let result: any;

  await check('closing the week produces qualifiers and hands out their seats', async () => {
    result = await closeSeason(closingSeason);
    assert.ok(result.qualifiers.length > 0, 'nobody qualified');
    assert.equal((await listQualifiers(closingSeason)).length, result.qualifiers.length);
    assert.ok(result.ticketsGranted > 0, 'no league tickets were granted');
  });

  /* Rooms are NOT drawn ahead: «روم‌ها یکی یکی بعد ورود تکمیل بشه» — the first
     qualifier through the door creates room one, and it fills before room two
     exists. So the thing to prove is that a qualifier can get through the door
     ON THE DAY, which is the whole of the bug. */
  await check('a qualifier can enter when the doors open — the thing that was broken', async () => {
    const cfg = await getLeagueConfig();
    const doors = kickoffFor(cfg) - LEAGUE_DOORS_MINUTES * 60_000 + 1000;
    const who = result.qualifiers[0]!.userId;
    const r = await enterLeague(who, doors);
    assert.ok(r.room, 'the qualifier was refused at the door');
    assert.equal(r.joined, true);
    assert.equal(r.room.seasonId, closingSeason, 'the room was filed under the wrong season');
  });

  await check('the room they walk into is the one the worker will open', async () => {
    const open = await listOpenRooms();
    assert.ok(open.length > 0, 'the worker would find nothing and no match would start');
    assert.ok(open.every((r) => r.seasonId === closingSeason));
  });

  /* THE FIRST BUG, WRITTEN DOWN. This is not a requirement — it is the trap:
     on match day the current season is NOT the season holding the rooms. */
  await check('on match day the current season id is not the rooms’ season', async () => {
    assert.notEqual(kickoffWeek, closingSeason,
      'if these were ever equal the old lookup would have worked and this test would be pointless');
    assert.equal((await listRooms(kickoffWeek)).length, 0,
      'the rooms are filed under the closing season, so the current season has none — which is'
      + ' exactly what the worker used to ask for, and why no match ever started');
  });

  await check('the season being played is resolved, not assumed to be this week', async () => {
    assert.equal(await activeSeasonId(), closingSeason,
      'the code would look in the current week, where there are no qualifiers at all');
    /* Asked AS OF THE KICKOFF, which is the moment that matters and the one
       where the two answers always differ. Asking «now» only differs on a
       Friday, so as an assertion it was a coin-toss on the day of the week. */
    assert.equal(await activeSeasonId(new Date(kickoffAt)), closingSeason);
    assert.notEqual(await activeSeasonId(new Date(kickoffAt)), kickoffWeek,
      'resolved to the kickoff’s own week, which never holds the qualifiers');
  });

  /* WHERE THE HEADER'S CHIP GETS ITS FACTS. The big ticket beside the wallet,
     and everything the tap explains — which tier, how many, and «شروع مسابقه»
     — all come out of myLeague. Reading the current ISO week here on match day
     finds no qualifier at all, so a player who spent a week earning a seat is
     told they have none and the chip never appears. */
  await check('the league screen reads the season being played, not this week', async () => {
    const who = result.qualifiers[0]!.userId;
    const mine = await myLeague(who);
    assert.equal(mine.seasonId, closingSeason, 'myLeague is looking at ' + mine.seasonId);
    /* The point is not which label it picked but that the label has players in
       it: falling back to an empty week is the failure, whatever it is called. */
    assert.ok((await listQualifiers(mine.seasonId)).length > 0,
      'it landed on a season with nobody in it: ' + mine.seasonId);
    assert.equal(mine.qualifiedTier, result.qualifiers[0]!.tier,
      'a qualifier holding a ticket is shown as holding no seat, so no chip is drawn');
  });

  await check('and it hands the chip a real ticket and a real kickoff to print', async () => {
    /* NOT qualifiers[0] — that one walked through the door above, and walking
       in spends the ticket. The chip is for the player still holding one. */
    const who = result.qualifiers[1]!.userId;
    const mine = await myLeague(who);
    assert.ok(Number(mine.tickets[mine.qualifiedTier!]) > 0,
      'the header would count zero tickets and draw nothing');
    assert.equal(tehran(mine.kickoffAt).slice(11), '21:00', tehran(mine.kickoffAt));
    assert.equal(new Date(mine.kickoffAt + 210 * 60_000).getUTCDay(), 5, 'kickoff is not on a Friday');
    assert.ok(mine.doorsOpenAt < mine.kickoffAt, 'the doors open after the whistle');
    assert.ok(mine.tiers.some((t) => t.key === mine.qualifiedTier),
      'the tier the ticket is for is not among the tiers the modal names');
  });

  /* Somebody who never qualified must not be handed a chip. */
  await check('a player with no seat is told so, on the same day', async () => {
    const mine = await myLeague('lg-nobody');
    assert.equal(mine.qualifiedTier, null);
    assert.equal(mine.canEnter, false);
    assert.ok(mine.enterBlockedReason.length > 0, 'refused with no reason given');
  });

  await check('previousSeasonId is exactly one ISO week back, new year included', async () => {
    for (const day of ['2026-08-28T09:00:00Z', '2026-01-05T09:00:00Z', '2026-01-01T09:00:00Z']) {
      const d = new Date(day);
      assert.equal(previousSeasonId(d), isoWeekId(new Date(d.getTime() - 7 * 86_400_000)), day);
      assert.notEqual(previousSeasonId(d), isoWeekId(d), day + ' returned the same week');
    }
  });

  /* The worker asks for what is unfinished. If a played room came back, its
   * players would be marched into the same match again every five seconds. */
  await check('a finished room is not offered to the worker again', async () => {
    const open = await listOpenRooms();
    const first = open[0]!;
    const seats = (await listSeats(first.id)).map((s2) => s2.userId);
    await reportRoomResult({ roomId: first.id, played: seats, winnerUserId: seats[0] ?? null });
    const after = await listOpenRooms();
    assert.ok(!after.some((r) => r.id === first.id), 'a finished room is still in the queue');
    assert.ok(after.length === open.length - 1, 'the other rooms went missing too');
  });

  /* The panel's «قرعه‌کشی» is the other way rooms come into being — a bracket
     drawn ahead for a tier rather than filled at the door. Whatever draws them,
     round one belongs to the kickoff and not to the moment somebody pressed
     the button. */
  await check('a drawn round one is set for Friday 21:00 Tehran, not for now', async () => {
    /* A season of its own: drawing is idempotent, so asking the season above
       would hand back the room a player already walked into at the door — and
       that one is deliberately scheduled a few minutes out, not at kickoff. */
    const other = '2026-W02';
    await closeSeason(other);
    const rooms = await drawRound(other, 1);
    assert.ok(rooms.length > 0, 'the draw produced nothing to check');
    for (const r of rooms) {
      assert.equal(tehran(r.startsAt).slice(11), '21:00', 'room ' + r.roomNo + ' starts at ' + tehran(r.startsAt));
      assert.equal(new Date(r.startsAt + 210 * 60_000).getUTCDay(), 5, 'room ' + r.roomNo + ' is not on a Friday');
      assert.ok(r.startsAt > Date.now(), 'a room was scheduled in the past');
    }
  });

  await check('closing twice does not double the seats or the rooms', async () => {
    const before = (await listRooms(closingSeason)).length;
    const again = await closeSeason(closingSeason);
    assert.equal(again.ticketsGranted, 0, 'a second close handed out tickets again');
    assert.equal((await listRooms(closingSeason)).length, before, 'a second close drew the rooms again');
  });

  /* THE OTHER HALF OF THE WEEK, and the reason this is «resolved» rather than
     «always a week back». Mid-week, before the Friday, the season being played
     IS the current one; a rule that simply looked backwards would send the
     screen — and the header's chip — to a week that is already over. This is
     last because closing the current week changes the answer for everything
     above it. */
  await check('mid-week, the season being played is this week, not the one before', async () => {
    await closeSeason(currentSeasonId());
    assert.equal(await activeSeasonId(), currentSeasonId(),
      'the current week has qualifiers of its own and is still being skipped');
    const who = (await listQualifiers(currentSeasonId()))[0]!.userId;
    assert.equal((await myLeague(who)).seasonId, currentSeasonId(),
      'the league screen is a week behind for everyone, all week');
  });

  await check('today really is a Friday, which is what all of this is for', async () => {
    assert.equal(friday.getUTCDay(), 5, fmt(friday.getTime()));
    assert.equal(isoWeekId(friday), '2026-W35');
  });

  await check('and the league is switched on', async () => {
    const { getLeagueConfig } = await import('../services/leagueService.js');
    assert.equal((await getLeagueConfig()).enabled, true, 'the weekly league is off');
  });

  console.log(`[leagueFriday] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
