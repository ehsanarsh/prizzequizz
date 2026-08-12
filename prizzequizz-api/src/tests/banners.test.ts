/* BANNERS ON ANY SCREEN, INCLUDING MOVING ONES.
 *
 * Three promo slots were hard-coded to three ticket screens. A banner now
 * names its screen, so any screen can have one, and it can be a picture, a GIF
 * or a video.
 *
 * The thing that has to be right is the kind. An operator does not declare it
 * — a .mp4 is a video whether or not anybody ticked a box — so it is worked
 * out from the source. Getting it wrong means a black rectangle where a
 * picture should be.
 *
 * Run: npx tsx src/tests/banners.test.ts
 */
import assert from 'node:assert/strict';
import {
  mediaKind, saveBanner, listBanners, activeBanners, removeBanner,
  BannerError, BANNER_SLOTS, BANNER_VIDEO_MAX_BYTES, BANNER_IMAGE_MAX_BYTES, _resetBanners
} from '../services/bannerService.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const dataUri = (mime: string, kb: number) => 'data:' + mime + ';base64,' + 'A'.repeat(Math.floor(kb * 1024 * 4 / 3));

async function run(): Promise<void> {
  _resetBanners();

  /* ── what kind of thing is this ───────────────────────────────────── */

  await check('a video is recognised from its extension and its mime', async () => {
    assert.equal(mediaKind('https://cdn.example/ad.mp4'), 'video');
    assert.equal(mediaKind('https://cdn.example/ad.webm'), 'video');
    assert.equal(mediaKind('data:video/mp4;base64,AAAA'), 'video');
  });

  await check('a GIF is its own kind, not just an image', async () => {
    /* It matters: a GIF must not be handed to a <video>, which cannot play it. */
    assert.equal(mediaKind('https://cdn.example/promo.gif'), 'gif');
    assert.equal(mediaKind('data:image/gif;base64,AAAA'), 'gif');
  });

  await check('still pictures are images', async () => {
    for (const u of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.svg']) {
      assert.equal(mediaKind('https://cdn.example/' + u), 'image', u);
    }
    assert.equal(mediaKind('data:image/webp;base64,AAAA'), 'image');
  });

  await check('a query string does not hide the extension', async () => {
    /* A CDN link almost always has one, and ?v=123 must not turn a video into
       an image. */
    assert.equal(mediaKind('https://cdn.example/ad.mp4?v=12&t=3'), 'video');
    assert.equal(mediaKind('https://cdn.example/p.gif#top'), 'gif');
  });

  await check('an extensionless URL is treated as a picture, and nothing at all is none', async () => {
    assert.equal(mediaKind('https://cdn.example/asset/9f2c'), 'image', 'a failing <img> hides itself; a failing player is a black box');
    assert.equal(mediaKind(''), 'none');
    assert.equal(mediaKind('data:application/pdf;base64,AAAA'), 'none');
  });

  /* ── any screen ───────────────────────────────────────────────────── */

  await check('a banner can be put on a screen that never had one', async () => {
    _resetBanners();
    const b = await saveBanner({ slot: 'home', title: 'سلام', text: 'خوش آمدی' });
    assert.equal(b.slot, 'home');
    const shown = await activeBanners();
    assert.equal(shown.home!.length, 1);
  });

  await check('every listed screen is accepted', async () => {
    _resetBanners();
    for (const slot of BANNER_SLOTS) await saveBanner({ slot, title: slot });
    const shown = await activeBanners();
    assert.equal(Object.keys(shown).length, BANNER_SLOTS.length);
  });

  await check('a screen nobody defined is refused', async () => {
    await assert.rejects(
      () => saveBanner({ slot: 'nowhere', title: 'x' }),
      (e: unknown) => e instanceof BannerError && e.code === 'SLOT_UNKNOWN'
    );
  });

  await check('two banners on one screen come back in their set order', async () => {
    _resetBanners();
    await saveBanner({ slot: 'shop', title: 'دوم', order: 2 });
    await saveBanner({ slot: 'shop', title: 'اول', order: 1 });
    const shown = await activeBanners();
    assert.deepEqual(shown.shop!.map((b) => b.title), ['اول', 'دوم']);
  });

  /* ── what the game is told ────────────────────────────────────────── */

  await check('the game is told the kind, so it never has to guess', async () => {
    _resetBanners();
    await saveBanner({ slot: 'home', media: 'https://cdn.example/a.mp4' });
    await saveBanner({ slot: 'shop', media: 'https://cdn.example/b.gif' });
    await saveBanner({ slot: 'duel', media: 'https://cdn.example/c.png' });
    const shown = await activeBanners();
    assert.equal(shown.home![0]!.kind, 'video');
    assert.equal(shown.shop![0]!.kind, 'gif');
    assert.equal(shown.duel![0]!.kind, 'image');
  });

  await check('a switched-off banner is not sent to the game at all', async () => {
    _resetBanners();
    const b = await saveBanner({ slot: 'home', title: 'مخفی' });
    await saveBanner({ id: b.id, slot: 'home', enabled: false });
    assert.deepEqual(await activeBanners(), {}, 'nothing to render');
    assert.equal((await listBanners()).length, 1, 'but the operator still sees it');
  });

  await check('an empty banner is not sent either', async () => {
    _resetBanners();
    await saveBanner({ slot: 'home', title: '', text: '', media: '' });
    assert.deepEqual(await activeBanners(), {}, 'a banner with nothing in it is not a banner');
  });

  /* ── size ─────────────────────────────────────────────────────────── */

  await check('a video gets more room than a picture, and both are bounded', async () => {
    _resetBanners();
    assert.ok(BANNER_VIDEO_MAX_BYTES > BANNER_IMAGE_MAX_BYTES);
    /* A clip that would fit a video is still far too big for an image slot. */
    await assert.rejects(
      () => saveBanner({ slot: 'home', media: dataUri('image/png', 600) }),
      (e: unknown) => e instanceof BannerError && e.code === 'MEDIA_TOO_LARGE'
    );
    const ok = await saveBanner({ slot: 'home', media: dataUri('video/mp4', 600) });
    assert.equal(mediaKind(ok.media), 'video');
  });

  await check('a film is refused rather than silently making every screen slow', async () => {
    await assert.rejects(
      () => saveBanner({ slot: 'home', media: dataUri('video/mp4', 4096) }),
      (e: unknown) => e instanceof BannerError && e.code === 'MEDIA_TOO_LARGE'
    );
  });

  await check('a format nothing can play is refused', async () => {
    await assert.rejects(
      () => saveBanner({ slot: 'home', media: 'data:application/zip;base64,AAAA' }),
      (e: unknown) => e instanceof BannerError && e.code === 'MEDIA_UNSUPPORTED'
    );
  });

  /* ── editing ──────────────────────────────────────────────────────── */

  await check('editing keeps what was not sent', async () => {
    _resetBanners();
    const b = await saveBanner({ slot: 'home', title: 'عنوان', text: 'متن', media: 'https://cdn.example/a.png', link: 'shop' });
    const after = await saveBanner({ id: b.id, slot: 'home', title: 'عنوان تازه' });
    assert.equal(after.title, 'عنوان تازه');
    assert.equal(after.text, 'متن', 'text survived');
    assert.equal(after.media, 'https://cdn.example/a.png', 'and so did the picture');
    assert.equal(after.link, 'shop');
  });

  await check('clearing the media is different from not mentioning it', async () => {
    _resetBanners();
    const b = await saveBanner({ slot: 'home', media: 'https://cdn.example/a.png' });
    const cleared = await saveBanner({ id: b.id, slot: 'home', media: '' });
    assert.equal(cleared.media, '', 'an explicit empty really clears it');
  });

  await check('a banner can be deleted', async () => {
    _resetBanners();
    const b = await saveBanner({ slot: 'home', title: 'x' });
    await listBanners();                              // migration settles here
    assert.equal(await removeBanner(b.id), true);
    assert.equal(await removeBanner(b.id), false, 'deleting it twice is not an error');
  });

  await check('deleting every banner does not resurrect the old promos', async () => {
    /* The first version migrated whenever the list was empty, so an operator
       who cleared the screen would find the three old promo slots back on the
       next load, with no way to be rid of them. */
    _resetBanners();
    await saveBanner({ slot: 'home', title: 'تنها بنر' });
    const all = await listBanners();                  // migration decides now
    for (const b of all) await removeBanner(b.id);
    assert.equal((await listBanners()).length, 0, 'gone stays gone');
    assert.deepEqual(await activeBanners(), {});
  });

  console.log(`[banners] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
