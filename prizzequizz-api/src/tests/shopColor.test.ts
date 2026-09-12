/* A COLOUR FOR EACH SHOP CARD — AND NOTHING ELSE GETTING IN WITH IT.
 *
 * «بتونم در قسمت ادمین برای هر آیتم فروش که در کارت میاد رنگ کارت رو عوض کنم.»
 *
 * The value is typed by an operator and then used as a CSS colour on a card in
 * every player's browser, so the only interesting question is what happens when
 * it is NOT a colour. Anything that is not a plain hex is dropped rather than
 * passed through: a card is not a place to let somebody else's stylesheet in.
 *
 * Run: npx tsx src/tests/shopColor.test.ts */
import assert from 'node:assert/strict';
import { normalizeColor, saveItem, getItem, listItems, shopCard } from '../services/shopService.js';
import { getPgPool } from '../database/postgres.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

(async () => {
  await check('a six-digit hex is kept', () => {
    assert.equal(normalizeColor('#1E7A45'), '#1e7a45');
    assert.equal(normalizeColor('1E7A45'), '#1e7a45', 'typed without the hash, which people do');
  });

  await check('a three-digit one is expanded, because that is also what people type', () => {
    assert.equal(normalizeColor('#0af'), '#00aaff');
  });

  await check('empty means no colour, not black', () => {
    /* The difference matters: «no colour» is the shelf default, and a shop
       nobody has recoloured has to look exactly as it did. */
    assert.equal(normalizeColor(''), undefined);
    assert.equal(normalizeColor('   '), undefined);
    assert.equal(normalizeColor(null), undefined);
    assert.equal(normalizeColor(undefined), undefined);
  });

  await check('a colour NAME is refused', () => {
    /* Not because it would not work, but because accepting names means
       accepting a string the browser parses — and that list does not end. */
    assert.equal(normalizeColor('red'), undefined);
  });

  await check('and anything carrying more than a colour is refused', () => {
    assert.equal(normalizeColor('red;background:url(http://x/y)'), undefined);
    assert.equal(normalizeColor('#fff;position:fixed;inset:0'), undefined);
    assert.equal(normalizeColor('url(javascript:alert(1))'), undefined);
    assert.equal(normalizeColor('rgb(255,0,0)'), undefined);
    assert.equal(normalizeColor('var(--bad)'), undefined);
    assert.equal(normalizeColor('#12345'), undefined, 'five digits is not a colour');
    assert.equal(normalizeColor('#gggggg'), undefined);
  });

  await check('an item keeps the colour it was saved with', async () => {
    const it = await saveItem({ name: 'کارت رنگی', category: 'util', price: 10, currency: 'coins', color: '#8A2BE2' } as any);
    assert.equal(it.color, '#8a2be2');
    assert.equal((await getItem(it.id))!.color, '#8a2be2', 'and it survives being read back');
  });

  await check('saving without mentioning colour leaves it alone', async () => {
    const it = await saveItem({ name: 'کارت رنگی ۲', category: 'util', price: 10, currency: 'coins', color: '#123456' } as any);
    const again = await saveItem({ id: it.id, name: 'کارت رنگی ۲', category: 'util', price: 20, currency: 'coins' } as any);
    assert.equal(again.color, '#123456', 'editing the price must not wipe the colour');
  });

  await check('and clearing it really clears it', async () => {
    const it = await saveItem({ name: 'کارت رنگی ۳', category: 'util', price: 10, currency: 'coins', color: '#abcdef' } as any);
    const again = await saveItem({ id: it.id, name: 'کارت رنگی ۳', category: 'util', price: 10, currency: 'coins', color: '' } as any);
    assert.equal(again.color, undefined, 'an operator who empties the box wants the default back');
  });

  await check('a rubbish colour is dropped, not stored for the browser to puzzle over', async () => {
    const it = await saveItem({ name: 'کارت رنگی ۴', category: 'util', price: 10, currency: 'coins', color: 'red;content:x' } as any);
    assert.equal(it.color, undefined);
  });

  /* ── AND IT HAS TO SURVIVE THE TRIP TO THE PLAYER ──────────────────
   * «هر رنگی می‌ذارم همون خاکستری می‌مونه.» The colour saved, the database kept
   * it, and the public endpoint — which hand-wrote its own object, twice —
   * listed every other field and not this one. Storing a value nobody is served
   * is the same as not storing it, so the shape the SHOP is actually sent is
   * what is checked here, not just the row. */

  /* THE REAL MAPPER, not a copy of it. A test that re-types what the endpoint
     builds can only ever prove that the two copies agree with each other — and
     it was two copies disagreeing that dropped `color` in the first place. */
  const asCard = (it: any) => shopCard(it) as any;

  await check('the colour reaches the shop, not just the database', async () => {
    const saved = await saveItem({ name: 'کارت آبی', category: 'util', price: 10, currency: 'coins', enabled: true, color: '#1155ff' } as any);
    const served = (await listItems({ enabledOnly: true })).find((x) => x.id === saved.id);
    assert.ok(served, 'the item is not even listed');
    assert.equal(asCard(served).color, '#1155ff',
      'the card the player is sent has no colour on it — every card stays grey');
  });

  await check('and every field the card draws with is served', async () => {
    /* The endpoint used to list these by hand in two places, so a field added to
       the item reached the player only if somebody remembered both. */
    const saved = await saveItem({ name: 'کارت کامل', category: 'util', price: 10, currency: 'coins', enabled: true,
      color: '#223344', badge: 'محبوب', icon: '🎁', description: 'توضیح' } as any);
    const card = asCard((await listItems({ enabledOnly: true })).find((x) => x.id === saved.id));
    for (const k of ['id', 'category', 'icon', 'name', 'description', 'price', 'currency', 'badge', 'color', 'shine', 'rewards']) {
      assert.ok((card as any)[k] !== undefined, 'the card is missing ' + k);
    }
  });

  /* ── SHINY OR PLAIN, PER CARD ──────────────────────────────────────
   * «باید بتونم هر کدوم از کارت‌هارو خواستم براق کنم، هر کدوم نخواستم ساده
   *  بمونه.» The answer that matters most is the one nobody gives: an item
   * saved before this existed has to keep the look it already has, so silence
   * means yes and only an explicit `false` turns the light off. */

  await check('an item nobody has an opinion about shines', async () => {
    const it = await saveItem({ name: 'کارت پیش‌فرض', category: 'util', price: 10, currency: 'coins', color: '#1155ff' } as any);
    assert.equal(it.shine, true);
    assert.equal(asCard(it).shine, true, 'and the player is told so');
  });

  await check('turning the shine off is remembered', async () => {
    const it = await saveItem({ name: 'کارت مات', category: 'util', price: 10, currency: 'coins', color: '#1155ff', shine: false } as any);
    assert.equal(it.shine, false);
    assert.equal((await getItem(it.id))!.shine, false, 'and it survives being read back');
    assert.equal(asCard(it).shine, false, 'and reaches the shop, which is the only place it means anything');
  });

  await check('false is a decision, not a missing field', async () => {
    /* `!= null` rather than `!== undefined` in saveItem: an unticked box sends
       `false`, and a check that treats false as «not mentioned» would turn the
       shine straight back on every time the item was saved. */
    const it = await saveItem({ name: 'کارت مات ۲', category: 'util', price: 10, currency: 'coins', color: '#1155ff', shine: false } as any);
    const again = await saveItem({ id: it.id, name: 'کارت مات ۲', category: 'util', price: 25, currency: 'coins' } as any);
    assert.equal(again.shine, false, 'editing the price must not relight the card');
  });

  await check('and it can be turned back on', async () => {
    const it = await saveItem({ name: 'کارت مات ۳', category: 'util', price: 10, currency: 'coins', color: '#1155ff', shine: false } as any);
    const again = await saveItem({ id: it.id, name: 'کارت مات ۳', category: 'util', price: 10, currency: 'coins', shine: true } as any);
    assert.equal(again.shine, true);
  });

  await check('a card with no colour still answers the question', async () => {
    /* There is nothing to shine on a shelf-default card, but the field must not
       come back undefined — the client reads `shine !== false`, and a shop that
       answered «I do not know» for half its cards would be two shops. */
    const it = await saveItem({ name: 'کارت بی‌رنگ', category: 'util', price: 10, currency: 'coins' } as any);
    assert.equal(typeof asCard(it).shine, 'boolean');
  });

  /* THE ROW THAT EXISTED BEFORE THE TICK-BOX DID.
     `ALTER TABLE … ADD COLUMN` leaves every existing row NULL, and NULL is the
     only value no operator can ever have chosen. If it read as «off», every
     coloured card already on the shelf would go plain the moment this shipped —
     which is the one thing this change must not do. Only Postgres has a NULL to
     offer, so this is the case the memory driver cannot pose. */
  if (process.env.DATABASE_URL) {
    await check('a card saved before the tick-box existed still shines', async () => {
      const it = await saveItem({ name: 'کارت قدیمی', category: 'util', price: 10, currency: 'coins', color: '#1155ff' } as any);
      await getPgPool().query('UPDATE shop_items SET shine = NULL WHERE id = $1', [it.id]);
      const back = await getItem(it.id);
      assert.equal(back!.shine, true, 'an unanswered column must not read as «turn it off»');
      assert.equal((shopCard(back!) as any).shine, true, 'and the player must be told so too');
    });
  } else {
    console.log('  — skipped (no DATABASE_URL): the NULL-column case only exists on Postgres');
  }

  /* ── THE WHOLE JOURNEY, NOT JUST THE MIDDLE OF IT ──────────────────
   * Everything above calls `saveItem` directly, and `color` proved that a field
   * can be stored perfectly and still never arrive: it was dropped by the
   * handler in between. There are four places a shop field has to be named —
   * the panel's form, the admin handler, the item, and the card the client
   * draws — and a test that only exercises the item cannot see three of them.
   * These are read as source because that is where the omission lives: nothing
   * throws when a field is simply not mentioned. */

  /** A file at the repo root, one level above this package. */
  function atRoot(name: string): string {
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const p = resolve(dir, name);
      if (existsSync(p)) return readFileSync(p, 'utf8');
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    throw new Error(name + ' not found above ' + process.cwd());
  }
  /** The `{ … }` that follows `needle` in `src`, brace-matched.
   *  Anchored on the brace rather than on the needle: `function f(` would
   *  otherwise close on its own parameter list and return an empty body that
   *  every check below would then fail against for the wrong reason. */
  function callBody(src: string, needle: string): string {
    const i = src.indexOf(needle);
    if (i < 0) return '';
    const open = src.indexOf('{', i);
    if (open < 0) return '';
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
    }
    return '';
  }

  /* Everything an operator can set that is not part of the item's identity.
     Add a field to the shop and this list is where it goes — which is the
     point: the next `color` fails here rather than in a screenshot. */
  const CARRIED = ['rewards', 'image', 'color', 'shine'];

  await check('the admin handler forwards every field the panel can set', () => {
    const body = callBody(readFileSync(resolve(process.cwd(), 'src/modules/admin/routes.ts'), 'utf8'), 'shopSave({');
    assert.ok(body, 'the shop save handler was not found at all');
    for (const k of CARRIED) {
      /* Both halves: it has to READ the field off the request and PASS it on.
         Naming it in only one of the two is how a field ends up looking wired
         while nothing an operator types ever moves. */
      assert.match(body, new RegExp('b\\.' + k + '\\b'), 'the handler never reads ' + k + ' off the request');
      assert.match(body, new RegExp('\\b' + k + '\\s*:'), 'the handler never passes ' + k + ' on');
    }
  });

  await check('and the panel actually sends them', () => {
    const body = callBody(atRoot('pzadmin.html'), 'async function shopSaveItem(');
    assert.ok(body, 'shopSaveItem was not found in the panel');
    for (const k of CARRIED) assert.match(body, new RegExp('\\b' + k + '\\s*:'), 'the panel never sends ' + k);
  });

  await check('and the card in the game reads them', () => {
    const client = atRoot('prizze-v643.html');
    const body = callBody(client, 'function pzShopCard(');
    assert.ok(body, 'pzShopCard was not found in the client');
    assert.match(body, /it\.color/, 'the card never looks at its colour');
    assert.match(body, /it\.shine/, 'the card never looks at whether it should shine');
    assert.match(body, /it\.img/, 'the card never looks at its artwork');
  });

  console.log(`[shopColor] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
