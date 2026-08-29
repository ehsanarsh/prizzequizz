/* THE LEVEL A PLAYER IS SHOWN IS THE LEVEL THEY ARE GATED BY.
 *
 * Reported: «در فروشگاه وقتی کاراکتری که در سطح ۵ آزاد می‌شه رو می‌زنی می‌گه
 *  این کاراکتر در لول ۵ آزاد می‌شود، با اینکه لول من ۱۵ هست.»
 *
 * Both numbers were real; they came from different places. Every screen the
 * player reads prints the stored `users.level` column, while the character
 * shelf and the purchase check recomputed the level from XP through the panel's
 * curve. They agree only while the curve stays where it was — and `xpPerLevelBase`
 * and `curve` are panel settings. Re-tune either and the recomputed answer
 * drops while the column stays put, which is a player at level ۱۵ being refused
 * a character that opens at ۵.
 *
 * These tests pin the rule that fixes it: a level is a rank that has been
 * REACHED, so it is the high-water mark of the two, and the shelf, the purchase
 * gate and the header can never disagree again.
 *
 * Run: npx tsx src/tests/characterLevelGate.test.ts */
import assert from 'node:assert/strict';
import { repositories } from '../repositories/index.js';
import { levelForXp, playerLevel } from '../services/scoringConfig.js';
import {
  saveCharacter, buildRoster, purchaseCharacter, _resetMemory as resetChars,
  CharacterPurchaseError
} from '../services/characterSelectionService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** A user row exactly as the app stores one: a level column AND an xp column. */
async function mkUser(id: string, level: number, xp: number, coins = 100000): Promise<void> {
  await repositories.users.save({
    id, username: id, displayName: id, phone: '0913' + Math.floor(Math.random() * 1e7),
    passwordHash: 'x', plan: 'free', level, xp, coins, wallet: 0, hearts: 5,
    weeklyScore: 0, tickets: {}, lifelines: {}, createdAt: new Date().toISOString()
  } as any);
}

(async () => {
  resetChars();

  /* An XP total that the curve reads as a LOW level, on a player the app has
     been calling level ۱۵ all along. This is the reported state. */
  const XP_OF_LEVEL_4 = 1000;
  await check('the fixture really is the reported mismatch', () => {
    assert.ok(levelForXp(XP_OF_LEVEL_4) < 15,
      'the curve must read this XP as well under 15, or the test proves nothing');
  });

  const gift = await saveCharacter({ name: 'مانستر بنفش', kind: 'normal', unlockLevel: 5, viaLevel: true, sortOrder: 1 });
  const paid = await saveCharacter({ name: 'شوالیه', kind: 'normal', unlockLevel: 5, viaLevel: false,
    viaPurchase: true, price: 500, currency: 'coins', sortOrder: 2 });
  const high = await saveCharacter({ name: 'اژدها', kind: 'vip', unlockLevel: 40, viaLevel: true, sortOrder: 3 });
  /* Level 40 AND for sale — the gate has to stop money, not only the level
     grant, so the refusal has to be reachable through the till. */
  const highPaid = await saveCharacter({ name: 'اژدهای طلایی', kind: 'vip', unlockLevel: 40, viaLevel: false,
    viaPurchase: true, price: 700, currency: 'coins', sortOrder: 4 });

  const AHEAD = 'lvl-ahead';
  await mkUser(AHEAD, 15, XP_OF_LEVEL_4);

  await check('the shelf reports the level the player is shown, not a second opinion', async () => {
    const roster = await buildRoster(AHEAD);
    assert.equal(roster.level, 15, 'the shelf says level ' + roster.level + ' for a player the app calls 15');
  });

  await check('a character that opens at 5 is open to a player at 15', async () => {
    const roster = await buildRoster(AHEAD);
    const c = roster.characters.find((x) => x.id === gift.id)!;
    assert.equal(c.unlocked, true, 'still locked: «' + c.lockReason + '»');
    assert.equal(c.lockReason, '', 'an open character must carry no lock reason');
  });

  await check('and the sentence that caused the report is not printed at all', async () => {
    const roster = await buildRoster(AHEAD);
    const c = roster.characters.find((x) => x.id === gift.id)!;
    assert.ok(!/در لول .* آزاد می‌شود/.test(c.lockReason), 'the shelf still says: ' + c.lockReason);
  });

  await check('the purchase gate lets them buy the paid one too', async () => {
    const out = await purchaseCharacter(AHEAD, paid.id, 'k1');
    assert.equal(out.characterId, paid.id);
    assert.equal(out.charged, 500, 'they should be charged the ordinary price');
  });

  /* THE GATE STILL GATES. A rule that lets everyone through is not a fix. */
  await check('a character far above them is still locked', async () => {
    const roster = await buildRoster(AHEAD);
    const c = roster.characters.find((x) => x.id === high.id)!;
    assert.equal(c.unlocked, false, 'level 40 must still be out of reach at 15');
    assert.ok(c.lockReason.includes('۴۰'), 'and it must say which level: «' + c.lockReason + '»');
  });

  await check('and buying it is refused with the real reason', async () => {
    await assert.rejects(() => purchaseCharacter(AHEAD, highPaid.id, 'k2'),
      (e: unknown) => e instanceof CharacterPurchaseError && e.code === 'LEVEL_TOO_LOW');
  });

  await check('the refusal quotes the level the player is shown', async () => {
    try { await purchaseCharacter(AHEAD, highPaid.id, 'k3'); assert.fail('it went through'); }
    catch (e) {
      const m = (e as Error).message;
      assert.ok(m.includes('۱۵'), 'it told them they are at some other level: ' + m);
    }
  });

  /* THE OTHER DIRECTION. A player whose XP has run ahead of the column — the
     ordinary case between an award and the next write — must not be held back
     by a stale column either. */
  const BEHIND = 'lvl-behind';
  const XP_WELL_PAST_5 = 100000;
  await mkUser(BEHIND, 1, XP_WELL_PAST_5);
  await check('XP that has run past the stored column still counts', async () => {
    assert.ok(levelForXp(XP_WELL_PAST_5) > 5, 'fixture: this XP must be well past level 5');
    const roster = await buildRoster(BEHIND);
    assert.equal(roster.level, levelForXp(XP_WELL_PAST_5), 'the curve should win when it is the higher of the two');
    assert.equal(roster.characters.find((x) => x.id === gift.id)!.unlocked, true);
  });

  /* AND A NEW PLAYER IS STILL A NEW PLAYER. */
  const FRESH = 'lvl-fresh';
  await mkUser(FRESH, 0, 0);
  await check('a brand-new player is level 1 and locked out of a level-5 character', async () => {
    const roster = await buildRoster(FRESH);
    assert.equal(roster.level, 1, 'a zeroed row must not read as level 0');
    assert.equal(roster.characters.find((x) => x.id === gift.id)!.unlocked, false);
  });

  /* The floor is the curve's, not a second guard's — so these cases are really
     asking whether a broken row can ever produce a level below 1 by any route. */
  await check('playerLevel never goes below 1, whatever the row holds', () => {
    assert.equal(playerLevel(null), 1);
    assert.equal(playerLevel(undefined), 1);
    assert.equal(playerLevel({ level: 0, xp: 0 }), 1);
    assert.equal(playerLevel({ level: -3, xp: 0 }), 1);
    assert.equal(playerLevel({ level: -3, xp: -900 }), 1, 'negative XP must not drag it under either');
    assert.equal(playerLevel({ level: null, xp: null }), 1);
    assert.equal(playerLevel({} as any), 1);
  });

  console.log(`[characterLevelGate] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
