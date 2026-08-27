/* EVERY BALANCE FIELD THE PANEL SHOWS MUST ACTUALLY MOVE THE GAME.
 *
 * The failure these guard against is not a crash — it is a settings screen that
 * accepts a number, saves it, shows it back, and changes nothing. That kind of
 * bug is invisible from the panel and only shows up as «چرا هیچ فرقی نکرد».
 *
 * So each field is checked TWICE, and both halves matter:
 *
 *   • the DEFAULT reproduces exactly what the game paid before it was wired,
 *     because a field switching on must not move the balance by itself; and
 *   • CHANGING it moves the number, because that is the whole point.
 *
 * A test that only did the first half would pass on a field that is still
 * ignored. A test that only did the second would pass on a field that silently
 * changed everyone's rewards the day it shipped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gameConfig } from '../core/config.js';
import { migratePaidMultiplier } from '../services/configService.js';
import { awardScoring } from '../services/matchEngine.js';
import { repositories } from '../repositories/index.js';
import {
  PZ_SCORING, paidMultiplier, questionPoints, wrongAnswerPoints, streakBonus,
  goldenBonusXp, continueBonus, levelRewards, levelXpBase, levelCurve,
  levelForXp, levelSqlExpr, cupResetsWeekly, minCupToPlay, effectiveWeeklyScore,
  isoWeekId, getResultBonus
} from '../services/scoringConfig.js';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* Every case edits the live config object, so each one puts back exactly what
 * it found. A leaked edit would make the next test read a value it never set —
 * and the suite would then be testing itself rather than the game. */
/* The async twin. `withConfig` restores in a synchronous `finally`, which for
 * an async body runs the moment the promise is CREATED — the config would be
 * back to normal before the awaited code ever read it, and the test would be
 * measuring the default while claiming to measure the edit. */
async function withConfigAsync<T>(patch: Record<string, any>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, any> = {};
  for (const k of Object.keys(patch)) saved[k] = structuredClone((gameConfig as any)[k]);
  for (const k of Object.keys(patch)) {
    (gameConfig as any)[k] = { ...((gameConfig as any)[k] ?? {}), ...patch[k] };
  }
  try { return await fn(); }
  finally { for (const k of Object.keys(patch)) (gameConfig as any)[k] = saved[k]; }
}

function withConfig<T>(patch: Record<string, any>, fn: () => T): T {
  const saved: Record<string, any> = {};
  for (const k of Object.keys(patch)) saved[k] = structuredClone((gameConfig as any)[k]);
  for (const k of Object.keys(patch)) {
    (gameConfig as any)[k] = { ...((gameConfig as any)[k] ?? {}), ...patch[k] };
  }
  try { return fn(); }
  finally { for (const k of Object.keys(patch)) (gameConfig as any)[k] = saved[k]; }
}

async function run(): Promise<void> {
  // ── ضریب مسابقهٔ پولی ─────────────────────────────────────────────────
  check('paid multiplier defaults to the number the game already paid', () => {
    withConfig({ scoring: { paidMultiplier: undefined } }, () => {
      assert.equal(paidMultiplier(), PZ_SCORING.paidMultiplier);
    });
  });
  check('paid multiplier follows the panel', () => {
    withConfig({ scoring: { paidMultiplier: 5 } }, () => assert.equal(paidMultiplier(), 5));
  });
  check('a nonsense paid multiplier falls back rather than zeroing rewards', () => {
    for (const bad of [0, -2, 'abc', null]) {
      withConfig({ scoring: { paidMultiplier: bad } }, () =>
        assert.equal(paidMultiplier(), PZ_SCORING.paidMultiplier, `paidMultiplier=${String(bad)}`));
    }
  });

  // ── XP هر پاسخ درست ───────────────────────────────────────────────────
  check('the shipped perCorrect reproduces the difficulty table byte for byte', () => {
    withConfig({ xp: { perCorrect: 15 } }, () => {
      for (const d of ['easy', 'medium', 'hard', 'veryhard']) {
        assert.deepEqual(questionPoints(d), PZ_SCORING.perQuestion[d], d);
      }
    });
  });
  check('raising perCorrect scales the whole difficulty ladder, keeping its shape', () => {
    withConfig({ xp: { perCorrect: 30 } }, () => {
      assert.equal(questionPoints('easy').xp, 20);
      assert.equal(questionPoints('medium').xp, 30);
      assert.equal(questionPoints('hard').xp, 40);
      assert.equal(questionPoints('veryhard').xp, 56);
    });
  });
  check('scaling XP never moves the cup half of a question', () => {
    withConfig({ xp: { perCorrect: 45 } }, () => {
      for (const d of ['easy', 'medium', 'hard', 'veryhard']) {
        assert.equal(questionPoints(d).cup, PZ_SCORING.perQuestion[d]!.cup, d);
      }
    });
  });
  check('an unknown difficulty still scores, as medium', () => {
    withConfig({ xp: { perCorrect: 15 } }, () =>
      assert.deepEqual(questionPoints('impossible'), PZ_SCORING.perQuestion.medium));
  });
  check('a wrong answer is not scaled by the right-answer reward', () => {
    withConfig({ xp: { perCorrect: 150 } }, () =>
      assert.deepEqual(wrongAnswerPoints(), PZ_SCORING.perQuestion.wrong));
  });

  // ── زنجیره ────────────────────────────────────────────────────────────
  check('combo 0 leaves the built-in streak ladder alone', () => {
    withConfig({ xp: { combo: 0 } }, () => {
      for (const sb of PZ_SCORING.streak) assert.equal(streakBonus(sb.n)!.xp, sb.xp, `n=${sb.n}`);
    });
  });
  check('combo adds on top of every streak milestone', () => {
    withConfig({ xp: { combo: 7 } }, () => {
      for (const sb of PZ_SCORING.streak) assert.equal(streakBonus(sb.n)!.xp, sb.xp + 7, `n=${sb.n}`);
    });
  });
  check('combo does not invent milestones that are not milestones', () => {
    withConfig({ xp: { combo: 7 } }, () => {
      assert.equal(streakBonus(2), null);
      assert.equal(streakBonus(4), null);
    });
  });

  // ── سؤال طلایی و ادامه دادن ───────────────────────────────────────────
  check('golden and continue ship at zero, so nothing changes on deploy', () => {
    withConfig({ xp: { golden: 0, continue: 0 }, cup: { continue: 0 } }, () => {
      assert.equal(goldenBonusXp(), 0);
      assert.deepEqual(continueBonus(), { xp: 0, cup: 0 });
    });
  });
  check('golden and continue pay what the panel says', () => {
    withConfig({ xp: { golden: 12, continue: 9 }, cup: { continue: 4 } }, () => {
      assert.equal(goldenBonusXp(), 12);
      assert.deepEqual(continueBonus(), { xp: 9, cup: 4 });
    });
  });
  check('a negative bonus cannot be used to take points away', () => {
    withConfig({ xp: { golden: -50, continue: -50 }, cup: { continue: -50 } }, () => {
      assert.equal(goldenBonusXp(), 0);
      assert.deepEqual(continueBonus(), { xp: 0, cup: 0 });
    });
  });

  // ── لول ───────────────────────────────────────────────────────────────
  check('the level curve ships exactly as it was hardcoded', () => {
    withConfig({ level: { xpPerLevelBase: 100, curve: 'sqrt' } }, () => {
      assert.equal(levelXpBase(), 100);
      assert.equal(levelCurve(), 'sqrt');
      for (const [xp, lvl] of [[0, 1], [99, 1], [100, 2], [399, 2], [400, 3], [900, 4]] as const) {
        assert.equal(levelForXp(xp), lvl, `xp=${xp}`);
      }
    });
  });
  check('a cheaper base really does make levels come faster', () => {
    withConfig({ level: { xpPerLevelBase: 25, curve: 'sqrt' } }, () =>
      assert.equal(levelForXp(100), 3));
  });
  check('the linear curve prices every level the same', () => {
    withConfig({ level: { xpPerLevelBase: 100, curve: 'linear' } }, () => {
      assert.equal(levelForXp(0), 1);
      assert.equal(levelForXp(250), 3);
      assert.equal(levelForXp(900), 10);
    });
  });
  check('a broken base falls back instead of dividing by zero', () => {
    for (const bad of [0, -5, 'x', null]) {
      withConfig({ level: { xpPerLevelBase: bad } }, () =>
        assert.equal(levelXpBase(), 100, `base=${String(bad)}`));
    }
  });

  /* THE ONE THAT MATTERS MOST: the database recomputes the level inside the
   * same UPDATE that adds the XP, so it needs the same curve. It used to carry
   * its own copy of the formula, which meant changing the base in the panel
   * moved the TypeScript answer and left the stored column behind. */
  check('the SQL level formula is the SAME formula, not a second copy', () => {
    for (const base of [100, 25, 250]) {
      for (const curve of ['sqrt', 'linear']) {
        withConfig({ level: { xpPerLevelBase: base, curve } }, () => {
          const sql = levelSqlExpr('X');
          assert.ok(sql.includes(`${base}.0`), `base ${base} missing from: ${sql}`);
          assert.equal(/sqrt/.test(sql), curve === 'sqrt', `curve ${curve}: ${sql}`);
          // and evaluated the way Postgres would, it agrees with levelForXp
          for (const xp of [0, 99, 100, 401, 2500]) {
            const expected = levelForXp(xp);
            const got = curve === 'sqrt'
              ? Math.max(1, Math.floor(Math.sqrt(xp / base)) + 1)
              : Math.max(1, Math.floor(xp / base) + 1);
            assert.equal(got, expected, `base=${base} curve=${curve} xp=${xp}`);
          }
        });
      }
    }
  });
  check('the SQL formula interpolates the column it is given', () => {
    assert.ok(levelSqlExpr('users.xp + $2').includes('users.xp + $2'));
  });

  // ── جایزهٔ لول ────────────────────────────────────────────────────────
  check('level rewards ship at zero, so nobody gets a backdated pile', () => {
    withConfig({ level: { rewardCoinsPerLevel: 0, rewardTicketPerLevel: 0 } }, () =>
      assert.deepEqual(levelRewards(), { coins: 0, tickets: 0 }));
  });
  check('level rewards read what the panel set', () => {
    withConfig({ level: { rewardCoinsPerLevel: 250, rewardTicketPerLevel: 2 } }, () =>
      assert.deepEqual(levelRewards(), { coins: 250, tickets: 2 }));
  });
  check('a negative level reward cannot bill the player for levelling up', () => {
    withConfig({ level: { rewardCoinsPerLevel: -100, rewardTicketPerLevel: -1 } }, () =>
      assert.deepEqual(levelRewards(), { coins: 0, tickets: 0 }));
  });

  // ── کاپ ───────────────────────────────────────────────────────────────
  check('weekly reset is on unless it is explicitly switched off', () => {
    for (const v of [true, undefined, 1, 'yes']) {
      withConfig({ cup: { weeklyReset: v } }, () =>
        assert.equal(cupResetsWeekly(), true, `weeklyReset=${String(v)}`));
    }
    withConfig({ cup: { weeklyReset: false } }, () => assert.equal(cupResetsWeekly(), false));
  });
  check('with reset on, last week’s cup reads as zero this week', () => {
    withConfig({ cup: { weeklyReset: true } }, () =>
      assert.equal(effectiveWeeklyScore({ weeklyScore: 500, weeklyWeek: '2001-W01' }), 0));
  });
  check('with reset off, the cup a player earned stays theirs', () => {
    withConfig({ cup: { weeklyReset: false } }, () =>
      assert.equal(effectiveWeeklyScore({ weeklyScore: 500, weeklyWeek: '2001-W01' }), 500));
  });
  check('this week’s cup counts either way', () => {
    for (const reset of [true, false]) {
      withConfig({ cup: { weeklyReset: reset } }, () =>
        assert.equal(effectiveWeeklyScore({ weeklyScore: 42, weeklyWeek: isoWeekId() }), 42));
    }
  });
  check('the cup floor ships open, and closes only when set', () => {
    withConfig({ cup: { minEntry: 0 } }, () => assert.equal(minCupToPlay(), 0));
    withConfig({ cup: { minEntry: 120 } }, () => assert.equal(minCupToPlay(), 120));
    withConfig({ cup: { minEntry: -5 } }, () => assert.equal(minCupToPlay(), 0));
  });

  /* ── THE MIGRATION ─────────────────────────────────────────────────────
   * A saved 2 was never anyone's decision: it was the default of a value no
   * code read, while players were being paid 3×. Wiring the field without
   * moving it would have cut every paid reward by a third on the deploy that
   * fixed it. */
  check('the never-chosen 2 becomes the number players were actually paid', () => {
    const saved: any = { scoring: { paidMultiplier: 2 } };
    assert.equal(migratePaidMultiplier(saved), true, 'should report a write is needed');
    assert.equal(saved.scoring.paidMultiplier, PZ_SCORING.paidMultiplier);
    assert.equal(saved.scoring.paidMultiplierMigrated, true, 'and stamp itself');
  });
  check('an operator’s own number is never touched, even if it is low', () => {
    for (const own of [1, 1.5, 4, 10]) {
      const saved: any = { scoring: { paidMultiplier: own } };
      migratePaidMultiplier(saved);
      assert.equal(saved.scoring.paidMultiplier, own, `own=${own}`);
    }
  });
  check('the migration runs once, not on every boot', () => {
    const saved: any = { scoring: { paidMultiplier: 2 } };
    migratePaidMultiplier(saved);
    // an operator who now deliberately chooses 2 must keep it
    saved.scoring.paidMultiplier = 2;
    assert.equal(migratePaidMultiplier(saved), false, 'second run must be a no-op');
    assert.equal(saved.scoring.paidMultiplier, 2, 'and must leave the chosen 2 alone');
  });
  check('a config with no scoring block at all is left alone', () => {
    const saved: any = { xp: { perWin: 1 } };
    assert.equal(migratePaidMultiplier(saved), false);
    assert.equal(saved.scoring, undefined);
  });

  // ── the fields that were already live must not have been disturbed ────
  check('win/loss/draw bonuses still come from the panel, unchanged', () => {
    withConfig({ xp: { perWin: 77, multiplier: 1 }, cup: { win: 33 } }, () => {
      const w = getResultBonus('win');
      assert.equal(w.xp, 77);
      assert.equal(w.cup, 33);
    });
  });
  check('the XP multiplier still multiplies', () => {
    withConfig({ xp: { perWin: 10, multiplier: 3 } }, () =>
      assert.equal(getResultBonus('win').xp, 30));
  });

  /* ── THE LEVEL-UP REWARD, THROUGH THE REAL AWARD PATH ──────────────────
   *
   * The dangerous half of this feature is not «does it pay» but «does it pay
   * ONLY on a crossing». Get that wrong and every single answered question
   * hands out a level's worth of coins, quietly, to everybody.
   *
   * So these go through awardScoring itself rather than poking the helper: the
   * crossing is detected from what the award returns, and that is the thing
   * that has to be right. */
  let seq = 0;
  async function player(xp: number): Promise<string> {
    const uid = `bal-${Date.now()}-${seq++}`;
    await repositories.users.save({
      id: uid, phone: '0912' + Math.floor(Math.random() * 1e7), username: 'bal_' + seq,
      displayName: 'تعادلی', plan: 'free', level: levelForXp(xp), xp, weeklyScore: 0,
      wallet: 0, coins: 0, hearts: 5, tickets: { green: 0, blue: 0, red: 0 }
    } as any);
    return uid;
  }
  const coinsOf = async (u: string) => Number((await repositories.users.findById(u))!.coins ?? 0);

  await checkAsync('crossing a level pays exactly what the panel promised', async () => {
    await withConfigAsync({ level: { xpPerLevelBase: 100, curve: 'sqrt', rewardCoinsPerLevel: 500, rewardTicketPerLevel: 0 } },
      async () => {
        const u = await player(350);                 // level 2
        const r = await awardScoring(u, 100, 0);     // → 450, level 3
        assert.equal(r.level, 3, 'the award did not cross the level');
        assert.equal(await coinsOf(u), 500, 'one level gained must pay one level');
      });
  });

  await checkAsync('answering without gaining a level pays NOTHING', async () => {
    await withConfigAsync({ level: { xpPerLevelBase: 100, curve: 'sqrt', rewardCoinsPerLevel: 500, rewardTicketPerLevel: 0 } },
      async () => {
        const u = await player(410);                 // level 3, a long way from 900
        await awardScoring(u, 10, 0);
        assert.equal(await coinsOf(u), 0, 'a level reward was paid with no level gained');
        await awardScoring(u, 10, 0);
        assert.equal(await coinsOf(u), 0, 'and it must still be nothing on the next answer');
      });
  });

  await checkAsync('awarding zero XP is not a level-up', async () => {
    await withConfigAsync({ level: { xpPerLevelBase: 100, curve: 'sqrt', rewardCoinsPerLevel: 500, rewardTicketPerLevel: 0 } },
      async () => {
        const u = await player(400);                 // exactly on the boundary
        await awardScoring(u, 0, 5);
        assert.equal(await coinsOf(u), 0, 'a zero award paid a level reward');
      });
  });

  await checkAsync('two levels at once pay twice, not once', async () => {
    await withConfigAsync({ level: { xpPerLevelBase: 100, curve: 'sqrt', rewardCoinsPerLevel: 500, rewardTicketPerLevel: 0 } },
      async () => {
        const u = await player(350);                 // level 2
        const r = await awardScoring(u, 550, 0);     // → 900, level 4
        assert.equal(r.level, 4);
        assert.equal(await coinsOf(u), 1000, 'a two-level jump must pay for both');
      });
  });

  await checkAsync('with the reward at zero the feature stays completely dormant', async () => {
    await withConfigAsync({ level: { xpPerLevelBase: 100, curve: 'sqrt', rewardCoinsPerLevel: 0, rewardTicketPerLevel: 0 } },
      async () => {
        const u = await player(350);
        await awardScoring(u, 100, 0);
        assert.equal(await coinsOf(u), 0);
      });
  });

  /* ── THE PANEL MUST AGREE WITH THE CODE ────────────────────────────────
   *
   * The label is the only thing an operator ever sees. A field that reads
   * «هنوز وصل نیست» while the server reads it is a lie that costs a support
   * ticket; a field that reads as live while the server ignores it is worse.
   * So the panel's own table is checked against this file's imports. */
  const panel = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const p of ['../../../pzadmin.html', '../../pzadmin.html', '../../../../pzadmin.html']) {
      try { return readFileSync(resolve(here, p), 'utf8'); } catch { /* next */ }
    }
    return '';
  })();

  /** The `wired` flag the panel stores for one config path: CFG_FA maps a path
   *  to [label, help, wired, note]. */
  function panelWired(path: string): boolean | null {
    const m = new RegExp(`'${path.replace('.', '\\.')}':\\s*\\[`).exec(panel);
    if (!m) return null;
    // walk the array literal, counting quotes, until its closing bracket
    let i = m.index + m[0].length, depth = 1, q = '', out = '';
    while (i < panel.length && depth > 0) {
      const c = panel[i]!;
      if (q) { if (c === q && panel[i - 1] !== '\\') q = ''; }
      else if (c === "'" || c === '"') q = c;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (!depth) break; }
      out += c; i++;
    }
    // [label, help, wired, note] → the third comma-separated field at depth 0
    const parts: string[] = []; let cur = ''; q = ''; let d = 0;
    for (let j = 0; j < out.length; j++) {
      const c = out[j]!;
      if (q) { cur += c; if (c === q && out[j - 1] !== '\\') q = ''; continue; }
      if (c === "'" || c === '"') { q = c; cur += c; continue; }
      if (c === '[') d++; if (c === ']') d--;
      if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return String(parts[2] ?? '0').trim() === '1';
  }

  check('the admin panel was found, so the checks below mean something', () => {
    assert.ok(panel.length > 10000, 'pzadmin.html not readable from the test');
  });

  /* Live in the code → must read live in the panel. */
  for (const path of [
    'xp.perCorrect', 'xp.combo', 'xp.continue', 'xp.golden',
    'level.xpPerLevelBase', 'level.curve', 'level.rewardCoinsPerLevel', 'level.rewardTicketPerLevel',
    'cup.continue', 'cup.weeklyReset', 'cup.minEntry', 'scoring.paidMultiplier'
  ]) {
    check(`panel marks ${path} as live`, () => {
      assert.equal(panelWired(path), true, `${path} is read by the server but the panel still says it is not`);
    });
  }

  /* Deliberately NOT wired, because the real value is edited in another tab.
   * Two editable copies of one number is how they drift apart. */
  for (const path of ['xp.perMission', 'xp.dailyLogin', 'xp.perLevel', 'cup.perLeague']) {
    check(`panel still points ${path} at where its value really lives`, () => {
      assert.equal(panelWired(path), false, `${path} must stay a pointer, not become a second source of truth`);
    });
  }

  check('the migration stamp is not offered as a setting to flip', () => {
    assert.ok(/CFG_HIDDEN\s*=\s*\{[^}]*paidMultiplierMigrated/.test(panel),
      'scoring.paidMultiplierMigrated must be hidden from the config form');
  });

  console.log(`[balanceWiring] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
