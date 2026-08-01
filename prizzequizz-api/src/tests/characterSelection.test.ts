/* Character selection + random box engine, on the memory driver.
 *
 * The two things worth proving are the ones a player would notice going wrong:
 * that a locked character genuinely cannot be equipped no matter what the
 * client sends, and that the lottery's odds and duplicate handling behave the
 * way the panel says they do. */
import {
  saveCharacter, listCharacters, getCharacter, deleteCharacter, buildRoster,
  equipCharacter, grantCharacter, characterStats, _resetMemory as resetChars,
  CharacterError
} from '../services/characterSelectionService.js';
import {
  saveBox, listBoxes, getBox, deleteBox, drawFromBox, oddsFor,
  _resetMemory as resetBoxes, BoxError
} from '../services/characterBoxService.js';

(async () => {
  let pass = 0, fail = 0;
  const ok = (n: boolean, m: string) => { n ? pass++ : (fail++, console.log('  x', m)); };
  resetChars(); resetBoxes();

  const U = 'user-a', V = 'user-b';

  // ---------------------------------------------------------------- catalog
  const free = await saveCharacter({ name: 'مانستر زرد', kind: 'normal', unlockLevel: 0, viaLevel: true, sortOrder: 1 });
  const lvl9 = await saveCharacter({ name: 'مانستر آبی', kind: 'normal', unlockLevel: 9, viaLevel: true, sortOrder: 2 });
  const vip = await saveCharacter({ name: 'بابانوئل', kind: 'vip', viaLevel: false, viaRandom: true, sortOrder: 3 });

  ok((await listCharacters()).length === 3, 'three characters in the catalog');
  ok(free.id !== lvl9.id && lvl9.id !== vip.id, 'each character gets its own id');

  // Partial update must not wipe unspecified fields.
  const renamed = await saveCharacter({ id: lvl9.id, name: 'مانستر آبی ۲' });
  ok(renamed.unlockLevel === 9 && renamed.viaLevel === true, 'partial update preserves unlock settings');

  // ------------------------------------------------------------ unlock state
  // A brand-new player is level 1 (0 xp).
  const roster = await buildRoster(U);
  const byId = (id: string) => roster.characters.find((c) => c.id === id)!;
  ok(roster.level === 1, 'new player is level 1');
  ok(byId(free.id).unlocked === true, 'level-0 character is open at level 1');
  ok(byId(lvl9.id).unlocked === false, 'level-9 character is locked at level 1');
  ok(byId(lvl9.id).lockReason.includes('9'), 'lock reason names the required level');
  ok(byId(vip.id).unlocked === false, 'random-only VIP starts locked');
  ok(byId(vip.id).lockReason.includes('قرعه'), 'non-level lock names the real unlock route');

  // ------------------------------------------------------------------ equip
  const eq = await equipCharacter(U, free.id);
  ok(eq.equipped === true, 'unlocked character equips');
  ok((await buildRoster(U)).equippedId === free.id, 'equipped id is persisted');

  let refused = false;
  try { await equipCharacter(U, lvl9.id); } catch (e) { refused = e instanceof CharacterError && (e as CharacterError).code === 'LOCKED'; }
  ok(refused, 'a locked character is refused server-side, whatever the client sends');

  // A grant opens it without touching the level.
  ok(await grantCharacter(U, lvl9.id, 'admin') === true, 'grant records ownership');
  ok(await grantCharacter(U, lvl9.id, 'admin') === false, 're-granting the same character is a no-op');
  const after = await buildRoster(U);
  ok(after.characters.find((c) => c.id === lvl9.id)!.unlocked === true, 'granted character is unlocked');
  await equipCharacter(U, lvl9.id);
  ok((await buildRoster(U)).equippedId === lvl9.id, 'granted character can now be equipped');

  // ---------------------------------------------------------------- the box
  const box = await saveBox({
    name: 'باکس افتتاحیه',
    entries: [
      { characterId: free.id, weight: 0 },   // present but never drawn
      { characterId: vip.id, weight: 10 }
    ],
    duplicatePolicy: 'none', duplicateAmount: 0
  });
  ok((await listBoxes()).length === 1, 'box saved');
  ok(oddsFor(box).find((o) => o.characterId === vip.id)!.percent === 100, 'odds derive from weights');
  ok(oddsFor(box).find((o) => o.characterId === free.id)!.percent === 0, 'zero weight is 0%');

  // Weight 0 must be unreachable — run it enough times that chance can't hide a bug.
  let drewZeroWeight = false;
  for (let i = 0; i < 60; i++) {
    const r = await drawFromBox(box.id, V);
    if (r.character.id === free.id) drewZeroWeight = true;
  }
  ok(!drewZeroWeight, 'a zero-weight entry is never drawn');
  ok((await buildRoster(V)).characters.find((c) => c.id === vip.id)!.unlocked === true, 'the drawn character is unlocked for the winner');

  // First draw was the grant; the other 59 were duplicates.
  const dup = await drawFromBox(box.id, V);
  ok(dup.duplicate === true, 'a repeat draw is reported as a duplicate');
  ok(dup.compensation.amount === 0, "policy 'none' pays nothing for a duplicate");

  // ------------------------------------------------------- per-user cap
  const capped = await saveBox({ name: 'باکس محدود', maxPerUser: 2, entries: [{ characterId: vip.id, weight: 1 }] });
  await drawFromBox(capped.id, 'user-c');
  await drawFromBox(capped.id, 'user-c');
  let capHit = false;
  try { await drawFromBox(capped.id, 'user-c'); } catch (e) { capHit = e instanceof BoxError && (e as BoxError).code === 'LIMIT_REACHED'; }
  ok(capHit, 'the per-user cap is enforced against real draw history');

  // ------------------------------------------------------- window + disabled
  const ended = await saveBox({ name: 'تمام‌شده', endsAt: '2020-01-01T00:00:00Z', entries: [{ characterId: vip.id, weight: 1 }] });
  let windowHit = false;
  try { await drawFromBox(ended.id, U); } catch (e) { windowHit = e instanceof BoxError && (e as BoxError).code === 'ENDED'; }
  ok(windowHit, 'an expired box refuses to draw');

  const off = await saveBox({ name: 'خاموش', enabled: false, entries: [{ characterId: vip.id, weight: 1 }] });
  let offHit = false;
  try { await drawFromBox(off.id, U); } catch (e) { offHit = e instanceof BoxError && (e as BoxError).code === 'BOX_DISABLED'; }
  ok(offHit, 'a disabled box refuses to draw');

  // A box whose only character is disabled must fail loudly, not hand out junk.
  await saveCharacter({ id: vip.id, enabled: false });
  const emptyBox = await saveBox({ name: 'خالی', entries: [{ characterId: vip.id, weight: 5 }] });
  let emptyHit = false;
  try { await drawFromBox(emptyBox.id, U); } catch (e) { emptyHit = e instanceof BoxError && (e as BoxError).code === 'BOX_EMPTY'; }
  ok(emptyHit, 'a box of disabled characters draws nothing rather than a broken reward');
  await saveCharacter({ id: vip.id, enabled: true });

  // ------------------------------------------------------------ statistics
  const stats = await characterStats();
  const vipStat = stats.rows.find((r) => r.id === vip.id)!;
  ok(vipStat.fromRandom >= 1, 'random grants are counted as random');
  ok(vipStat.owners >= 1, 'owner count reflects real grant rows');
  const lvlStat = stats.rows.find((r) => r.id === lvl9.id)!;
  ok(lvlStat.fromReward >= 1, 'an admin grant counts toward reward-sourced ownership');
  ok(lvlStat.equipped === 1 && lvlStat.picks >= 1, 'equipped + pick counts are real');
  ok(stats.rows.reduce((s, r) => s + r.popularity, 0) <= 100.5, 'popularity shares stay within 100%');

  // ------------------------------------------------------------------ delete
  await deleteBox(off.id);
  ok(!(await getBox(off.id)), 'box deleted');
  await deleteCharacter(lvl9.id);
  ok(!(await getCharacter(lvl9.id)), 'character deleted');
  ok((await buildRoster(U)).equippedId !== lvl9.id, 'deleting a character clears it from anyone using it');

  console.log(`[characterSelection] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
