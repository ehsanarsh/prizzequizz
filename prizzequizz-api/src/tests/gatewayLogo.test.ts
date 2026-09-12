/* THE GATEWAY'S MARK, WHICH IS SOMEBODY ELSE'S BRAND.
 *
 * «عکس بالاش لوگو بلوپال باشه و بنویسه پرداخت امن با بلو پال.»
 *
 * It is uploaded rather than shipped inside the game: the gateway can change
 * its own branding whenever it likes, and a logo baked into the client would
 * mean a new build every time it did.
 *
 * That makes it an image an operator supplies, which then renders on a PAYMENT
 * screen in every player's browser — so what is worth testing is not that a
 * picture arrives, but what happens when the thing supplied is not a picture.
 *
 * Run: npx tsx src/tests/gatewayLogo.test.ts */
import assert from 'node:assert/strict';
import { normalizeLogo, GATEWAY_LOGO_MAX, updatePaymentSettings, getPaymentSettings } from '../services/paymentGatewayService.js';

let pass = 0, fail = 0;
async function check(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

(async () => {
  await check('a real image is kept', () => {
    assert.equal(normalizeLogo(PNG), PNG);
    assert.ok(normalizeLogo('data:image/webp;base64,UklGRg=='));
    assert.ok(normalizeLogo('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='));
  });

  await check('nothing means nothing, and that is a valid answer', () => {
    /* Without a logo the sheet still says «پرداخت امن با بلو پال» — the
       sentence is the part that has to be true. */
    assert.equal(normalizeLogo(''), '');
    assert.equal(normalizeLogo(null), '');
  });

  await check('a REMOTE url is refused', () => {
    /* Not because it would not load, but because it would hand a third party
       the choice of what appears on a payment screen — and let them watch every
       player who opens one. */
    assert.equal(normalizeLogo('https://example.com/logo.png'), '');
    assert.equal(normalizeLogo('//example.com/logo.png'), '');
  });

  await check('and so is anything that is not an image at all', () => {
    assert.equal(normalizeLogo('data:text/html;base64,PHNjcmlwdD4='), '');
    assert.equal(normalizeLogo('javascript:alert(1)'), '');
    assert.equal(normalizeLogo('data:image/png,<svg onload=alert(1)>'), '', 'not base64, so not what it claims');
    assert.equal(normalizeLogo('<img src=x onerror=alert(1)>'), '');
  });

  await check('an image too big for a payment screen is refused', () => {
    /* This rides on the endpoint every shopper fetches before the sheet opens. */
    const huge = 'data:image/png;base64,' + 'A'.repeat(GATEWAY_LOGO_MAX + 10);
    assert.equal(normalizeLogo(huge), '');
  });

  await check('it survives being saved and read back', async () => {
    await updatePaymentSettings({ gatewayLogo: PNG } as any);
    assert.equal((await getPaymentSettings()).gatewayLogo, PNG);
  });

  await check('and can be taken away again', async () => {
    await updatePaymentSettings({ gatewayLogo: '' } as any);
    assert.equal((await getPaymentSettings()).gatewayLogo, '');
  });

  await check('saving other settings does not disturb it', async () => {
    await updatePaymentSettings({ gatewayLogo: PNG } as any);
    await updatePaymentSettings({ feePercent: 3 } as any);
    const st = await getPaymentSettings();
    assert.equal(st.gatewayLogo, PNG, 'editing a fee must not clear the logo');
    assert.equal(st.feePercent, 3);
  });

  await check('a rubbish upload clears it rather than being stored', async () => {
    await updatePaymentSettings({ gatewayLogo: PNG } as any);
    await updatePaymentSettings({ gatewayLogo: 'https://evil.example/x.png' } as any);
    assert.equal((await getPaymentSettings()).gatewayLogo, '',
      'storing it would put the refused value in front of every player');
  });

  console.log(`[gatewayLogo] ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
