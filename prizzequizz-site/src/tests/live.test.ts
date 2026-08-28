/* THE LIVE PANELS: REAL NUMBERS OR NOTHING.
 *
 * These blocks put the game's own database on a public marketing page, so the
 * things that can go wrong are not «is the layout right» but:
 *
 *   • an invented row reaching a public page and staying there for a year;
 *   • a phone number or a wallet balance leaking into HTML;
 *   • the site's board disagreeing with the game's own board;
 *   • a slow query on the shared database turning into a slow game.
 *
 * The SQL half needs a real Postgres (the shapes it gets wrong — a LIKE on a
 * uuid, a week that never matches — are all valid-looking SQL). The rendering
 * half does not, and runs everywhere.
 *
 * Run: PGTEST_URL=postgres://... npx tsx src/tests/live.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agoFa, faNum, isoWeekId, _resetLiveCache } from '../live.js';
import { renderPage, type LiveData } from '../render.js';
import { SETTINGS_DEFAULTS, _seedPages } from '../content.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const here = dirname(fileURLToPath(import.meta.url));
/* The CODE of live.ts, with its comments removed. The comments talk ABOUT the
 * private columns in order to say they are never selected, so scanning the raw
 * file would fail on its own documentation — and the fix for that would be to
 * delete the explanation, which is the wrong way round. */
const liveSrc = readFileSync(resolve(here, '../live.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

function homePage() {
  const pages = _seedPages();
  const home = pages.find((p) => p.slug === 'home')!;
  return { home, pages };
}
const defaultSettings = () => ({ ...SETTINGS_DEFAULTS });
function renderHome(live: LiveData): string {
  const { home, pages } = homePage();
  return renderPage(home, pages, defaultSettings(), [], live);
}

const ROWS = [
  { rank: 1, name: 'سارا', score: 1240 },
  { rank: 2, name: 'نیما', score: 980 },
  { rank: 3, name: 'رها', score: 640 }
];
const STATS = { playersTotal: 812, matchesTotal: 5400, matchesToday: 96, playersThisWeek: 141 };
const WINNERS = [
  { name: 'سارا', mode: 'دوئل', when: 'همین الان' },
  { name: 'نیما', mode: 'آخرین بازمانده', when: '۳ دقیقه پیش' },
  { name: 'رها', mode: 'دوئل', when: '۸ دقیقه پیش' }
];
const EMPTY: LiveData = { leaderboard: null, winners: null, stats: null };

async function run(): Promise<void> {
  // ── NOTHING INVENTED ──────────────────────────────────────────────────
  await check('with no data at all, not one live block is drawn', () => {
    const html = renderHome(EMPTY);
    for (const cls of ['class="lb"', 'class="ticker"', 'class="stat-row"', 'class="dark"']) {
      assert.ok(!html.includes(cls), `${cls} was rendered with nothing to put in it`);
    }
  });

  await check('and the page is still a whole page without them', () => {
    const html = renderHome(EMPTY);
    assert.ok(html.includes('<h1'), 'the hero is gone');
    assert.ok(html.includes('char-hero.png'), 'the hero character should take the panels’ place');
    assert.ok(html.length > 4000, 'the page collapsed');
  });

  await check('a board with too few names is not a board', () => {
    const html = renderHome({ ...EMPTY, leaderboard: ROWS.slice(0, 2) });
    assert.ok(!html.includes('class="lb"'), 'two names were shown as a leaderboard');
  });

  await check('a ticker with too few winners does not run', () => {
    const html = renderHome({ ...EMPTY, winners: WINNERS.slice(0, 2) });
    assert.ok(!html.includes('class="ticker"'));
  });

  await check('a brand-new install shows no stat tiles rather than four zeroes', () => {
    const html = renderHome({ ...EMPTY, stats: { playersTotal: 0, matchesTotal: 0, matchesToday: 0, playersThisWeek: 0 } });
    assert.ok(!html.includes('class="stat-row"'), 'zeroes were dressed up as statistics');
  });

  await check('a day with no matches does not claim there were some', () => {
    const html = renderHome({ ...EMPTY, stats: { ...STATS, matchesToday: 0 } });
    assert.ok(!html.includes('class="dark"'), 'the pulse card showed zero matches today');
  });

  // ── REAL NUMBERS DO GET THROUGH ───────────────────────────────────────
  await check('the leaderboard shows the real names and scores', () => {
    const html = renderHome({ ...EMPTY, leaderboard: ROWS });
    assert.ok(html.includes('class="lb"'), 'no board');
    for (const r of ROWS) assert.ok(html.includes(r.name), 'missing ' + r.name);
    assert.ok(html.includes('۱٬۲۴۰'), 'the score is not in grouped Persian digits');
    assert.ok(/class="row first"/.test(html), 'the leader is not marked first');
  });

  await check('the hero becomes the design’s two-column split once there is data', () => {
    const html = renderHome({ ...EMPTY, leaderboard: ROWS });
    assert.ok(html.includes('class="hero-split"'), 'the split layout was not used');
  });

  await check('the winners ticker names the winner and the mode', () => {
    const html = renderHome({ ...EMPTY, winners: WINNERS });
    assert.ok(html.includes('class="ticker"'));
    assert.ok(html.includes('سارا برندهٔ دوئل شد'), 'the sentence template did not fill in');
  });

  await check('the ticker repeats itself, because the animation needs two copies', () => {
    const html = renderHome({ ...EMPTY, winners: WINNERS });
    const n = html.split('نیما برندهٔ آخرین بازمانده شد').length - 1;
    assert.equal(n, 2, 'the marquee would show a gap');
  });

  await check('the stat row narrows to the tiles that are actually true', () => {
    const html = renderHome({ ...EMPTY, stats: { ...STATS, matchesToday: 0, playersThisWeek: 0 } });
    assert.ok(html.includes('class="stat-row"'), 'two real numbers should still be a row');
    assert.ok(html.includes('repeat(2,1fr)'), 'the grid was left at four columns with two tiles');
  });

  await check('every panel’s wording comes from settings, not the template', () => {
    const s = { ...defaultSettings(), liveLeaderTitle: 'بهترین‌های هفته', liveWinnerVerb: '{name} در {mode} اول شد' };
    const { home, pages } = homePage();
    const html = renderPage(home, pages, s, [], { leaderboard: ROWS, winners: WINNERS, stats: STATS });
    assert.ok(html.includes('بهترین‌های هفته'), 'the leaderboard title is hardcoded');
    assert.ok(html.includes('سارا در دوئل اول شد'), 'the winner sentence is hardcoded');
  });

  await check('clearing a title switches its panel off', () => {
    const s = { ...defaultSettings(), liveStatPlayers: '', liveStatMatches: '' };
    const { home, pages } = homePage();
    const html = renderPage(home, pages, s, [], { ...EMPTY, stats: STATS });
    assert.ok(!html.includes('بازیکن<'), 'a cleared label still rendered');
  });

  // ── NOTHING PRIVATE IS EVEN SELECTED ──────────────────────────────────
  await check('no private column appears anywhere in the queries', () => {
    for (const col of ['phone', 'wallet_balance', 'coins', 'password', 'email', 'otp']) {
      assert.ok(!new RegExp(`\\b${col}\\b`).test(liveSrc), `live.ts mentions ${col}`);
    }
  });

  await check('every statement is a read, and the transaction says so', () => {
    for (const w of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE']) {
      assert.ok(!new RegExp(`\\b${w}\\b`).test(liveSrc), `live.ts contains ${w}`);
    }
    assert.ok(liveSrc.includes('BEGIN READ ONLY'), 'the transaction is not declared read-only');
    assert.ok(liveSrc.includes('statement_timeout'), 'a slow query could hang the page');
  });

  await check('bots are excluded exactly the way the game excludes them', () => {
    assert.ok(liveSrc.includes(`id::text NOT LIKE 'bot`), 'bots would appear on the public board');
  });

  // ── the small helpers ─────────────────────────────────────────────────
  await check('Persian numbers are grouped the way the game groups them', () => {
    assert.equal(faNum(1240), '۱٬۲۴۰');
    assert.equal(faNum(96), '۹۶');
    assert.equal(faNum(0), '۰');
  });

  await check('«چند وقت پیش» is coarse enough not to be caught out by the cache', () => {
    const now = new Date('2026-08-28T12:00:00Z');
    assert.equal(agoFa(new Date('2026-08-28T11:59:30Z'), now), 'همین الان');
    assert.equal(agoFa(new Date('2026-08-28T11:50:00Z'), now), '۱۰ دقیقه پیش');
    assert.equal(agoFa(new Date('2026-08-28T09:00:00Z'), now), '۳ ساعت پیش');
    assert.equal(agoFa(new Date('2026-08-26T12:00:00Z'), now), '۲ روز پیش');
  });

  await check('a clock skew never produces «منفی ۵ دقیقه پیش»', () => {
    const now = new Date('2026-08-28T12:00:00Z');
    assert.equal(agoFa(new Date('2026-08-28T12:05:00Z'), now), 'همین الان');
  });

  /* If this drifts from the game's own isoWeekId the board reads empty every
     single time, and it fails silently — an empty board looks exactly like a
     quiet week. */
  await check('the week id matches the game’s, including the year boundary', () => {
    assert.equal(isoWeekId(new Date('2026-08-28T00:00:00Z')), '2026-W35');
    assert.equal(isoWeekId(new Date('2026-01-01T00:00:00Z')), '2026-W01');
    assert.equal(isoWeekId(new Date('2027-01-01T00:00:00Z')), '2026-W53');
  });

  // ── THE SQL, ON A REAL DATABASE ───────────────────────────────────────
  const url = process.env.PGTEST_URL || process.env.DATABASE_URL;
  if (!url) {
    console.log('  … the SQL half needs PGTEST_URL/DATABASE_URL; skipped.');
  } else {
    process.env.DATABASE_URL = url;
    const { Pool } = (await import('pg')).default;
    const p = new Pool({ connectionString: url });
    const db = await p.connect();
    const schema = 'live_' + Math.random().toString(36).slice(2, 8);
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      await db.query(`CREATE TABLE users (id uuid PRIMARY KEY, phone varchar(32), username varchar(64),
        display_name varchar(120), weekly_score bigint DEFAULT 0, weekly_week varchar(8) DEFAULT '',
        created_at timestamp DEFAULT now())`);
      await db.query(`CREATE TABLE matches (id uuid PRIMARY KEY, mode_id varchar(64), winner_user_id uuid,
        created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now())`);
      const wk = isoWeekId();
      await db.query(`INSERT INTO users (id, phone, username, display_name, weekly_score, weekly_week) VALUES
        (gen_random_uuid(),'0912','sara','سارا',1240,$1),
        (gen_random_uuid(),'0913','nima','نیما',980,$1),
        (gen_random_uuid(),'0914','raha','رها',640,$1),
        (gen_random_uuid(),'0915','zero','صفری',0,$1),
        (gen_random_uuid(),'0916','oldie','هفتهٔ پیش',9999,'2001-W01')`, [wk]);

      /* The site's pool reads DATABASE_URL and has no search_path, so the test
         schema has to be the default for the role during this section. */
      await db.query(`ALTER ROLE CURRENT_USER SET search_path TO ${schema}`);
      _resetLiveCache();
      const live = await import('../live.js');

      await check('the board is this week’s scorers, best first, zeroes excluded', async () => {
        const rows = await live.leaderboard(10);
        assert.ok(rows, 'the query failed');
        assert.deepEqual(rows!.map((r) => r.name), ['سارا', 'نیما', 'رها']);
        assert.equal(rows![0]!.score, 1240);
      });

      await check('last week’s big score is not on this week’s board', async () => {
        _resetLiveCache();
        const rows = await live.leaderboard(10);
        assert.ok(!rows!.some((r) => r.name === 'هفتهٔ پیش'), 'a stale week leaked onto the board');
      });

      await check('a player with no display name is shown by username, never by phone', async () => {
        await db.query(`UPDATE users SET display_name = NULL WHERE username = 'sara'`);
        _resetLiveCache();
        const rows = await live.leaderboard(10);
        assert.equal(rows![0]!.name, 'sara');
        assert.ok(!JSON.stringify(rows).includes('0912'), 'a phone number reached the site');
        await db.query(`UPDATE users SET display_name = 'سارا' WHERE username = 'sara'`);
      });

      await check('the counts are the real counts', async () => {
        _resetLiveCache();
        const st = await live.stats();
        assert.equal(st!.playersTotal, 5);
        assert.equal(st!.playersThisWeek, 3, 'only the three with cup this week are active');
      });

      await check('winners come back newest first, and unknown modes are dropped', async () => {
        const { rows } = await db.query(`SELECT id FROM users WHERE username='sara'`);
        const sara = rows[0].id;
        await db.query(`INSERT INTO matches (id, mode_id, winner_user_id, updated_at) VALUES
          (gen_random_uuid(),'duel',$1, now() - interval '2 minutes'),
          (gen_random_uuid(),'lastSurvivor',$1, now() - interval '1 minute'),
          (gen_random_uuid(),'someModeWeNeverShipped',$1, now())`, [sara]);
        _resetLiveCache();
        const w = await live.recentWinners(10);
        assert.deepEqual(w!.map((x) => x.mode), ['آخرین بازمانده', 'دوئل'],
          'either the order is wrong or a raw mode id reached the page');
      });

      await check('a match with no winner yet is not announced as won', async () => {
        await db.query(`INSERT INTO matches (id, mode_id, winner_user_id) VALUES (gen_random_uuid(),'duel',NULL)`);
        _resetLiveCache();
        const w = await live.recentWinners(10);
        assert.ok(w!.every((x) => x.name), 'a nameless winner was announced');
      });

      await check('the cache means a burst of visitors is not a burst of queries', async () => {
        _resetLiveCache();
        const first = await live.leaderboard(5);
        await db.query(`UPDATE users SET weekly_score = 1 WHERE username='sara'`);
        const second = await live.leaderboard(5);
        assert.deepEqual(second, first, 'the second call went back to the database');
        await db.query(`UPDATE users SET weekly_score = 1240 WHERE username='sara'`);
      });
    } finally {
      await db.query(`ALTER ROLE CURRENT_USER RESET search_path`).catch(() => undefined);
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      db.release();
      await p.end();
      const { closePgPool } = await import('../db.js');
      await closePgPool().catch(() => undefined);
    }
  }

  console.log(`[live] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
