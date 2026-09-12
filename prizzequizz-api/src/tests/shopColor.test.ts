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
import { normalizeColor, saveItem, getItem } from '../services/shopService.js';

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

  console.log(`[shopColor] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
