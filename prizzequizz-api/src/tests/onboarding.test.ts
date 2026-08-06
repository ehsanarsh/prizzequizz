/* ONBOARDING SLIDES — the welcome sequence, as data.
 * The point is that a campaign can change it without a release, and that a
 * half-configured slide never reaches a player as something broken. */
import assert from 'node:assert/strict';
import {
  OnboardingError, ONBOARDING_DEFAULTS, listSlides, activeSlides, saveSlide, deleteSlide, _resetOnboardingMemory
} from '../services/onboardingService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

async function run() {
  _resetOnboardingMemory();

  await check('a fresh install already has the four welcome slides', async () => {
    const rows = await listSlides();
    assert.equal(rows.length, ONBOARDING_DEFAULTS.length);
    assert.deepEqual(rows.map((r) => r.id), ['welcome', 'coins', 'wheel', 'duel']);
    assert.ok(rows.every((r) => r.title && r.body), 'each one has copy ready');
  });

  await check('they come back in the order the panel set', async () => {
    const rows = await activeSlides();
    const orders = rows.map((r) => r.sortOrder);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });

  await check('a slide with no artwork still carries an emoji to fall back on', async () => {
    const rows = await listSlides();
    assert.ok(rows.every((r) => r.emoji), 'otherwise the first screen would be an empty box');
  });

  await check('switching one off takes it out of what players see', async () => {
    const rows = await listSlides();
    await saveSlide({ ...rows[1]!, enabled: false });
    const active = await activeSlides();
    assert.ok(!active.some((r) => r.id === rows[1]!.id));
    assert.equal((await listSlides()).length, rows.length, 'but the panel still lists it');
    await saveSlide({ ...rows[1]!, enabled: true });
  });

  await check('a campaign slide appears only inside its window', async () => {
    const soon = new Date(Date.now() + 86400000).toISOString();
    const later = new Date(Date.now() + 2 * 86400000).toISOString();
    await saveSlide({ id: 'nowruz', title: 'عید مبارک', body: 'هدیهٔ نوروزی', emoji: '🌸', startsAt: soon, endsAt: later, sortOrder: 9 });
    assert.ok(!(await activeSlides()).some((r) => r.id === 'nowruz'), 'not before it opens');
    assert.ok((await activeSlides(new Date(Date.now() + 86400000 + 3600000))).some((r) => r.id === 'nowruz'), 'shown inside the window');
    assert.ok(!(await activeSlides(new Date(Date.now() + 5 * 86400000))).some((r) => r.id === 'nowruz'), 'retires on its own');
  });

  await check('a slide can be added and removed', async () => {
    const before = (await listSlides()).length;
    const s = await saveSlide({ title: 'تست', body: 'متن', emoji: '🧪', sortOrder: 20 });
    assert.equal((await listSlides()).length, before + 1);
    assert.equal(await deleteSlide(s.id), true);
    assert.equal((await listSlides()).length, before);
    assert.equal(await deleteSlide(s.id), false, 'deleting twice is not an error to invent');
  });

  await check('editing keeps the same slide rather than making a copy', async () => {
    const before = (await listSlides()).length;
    await saveSlide({ id: 'welcome', title: 'سلام دوباره', body: 'متن تازه', emoji: '🧙' });
    assert.equal((await listSlides()).length, before);
    assert.equal((await listSlides()).find((r) => r.id === 'welcome')!.title, 'سلام دوباره');
  });

  await check('a slide with no title is refused', async () => {
    await assert.rejects(() => saveSlide({ title: '   ', body: 'x' }),
      (e: any) => e instanceof OnboardingError && e.code === 'TITLE_REQUIRED');
  });

  await check('an oversized picture is refused with a reason', async () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(900 * 1024);
    await assert.rejects(() => saveSlide({ title: 'بزرگ', body: '', image: huge }),
      (e: any) => e instanceof OnboardingError && e.code === 'IMAGE_TOO_LARGE');
  });

  await check('artwork survives a save and comes back with the slide', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await saveSlide({ id: 'coins', title: 'سکه', body: 'متن', image: png, emoji: '🪙' });
    assert.equal((await listSlides()).find((r) => r.id === 'coins')!.image, png);
  });

  await check('every slide the client is handed is showable', async () => {
    for (const s of await activeSlides()) {
      assert.ok(s.title, 'a slide with no title would render as a blank card');
      assert.ok(s.image || s.emoji, 'and one with neither picture nor emoji as an empty box');
    }
  });

  console.log(`[onboarding] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
