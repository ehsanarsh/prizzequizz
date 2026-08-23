/* THE ANDROID APP — the parts that fail silently.
 *
 * Nothing here compiles Android; the SDK is not on this machine and the build
 * runs on GitHub's. What is checked is the class of mistake that produces a
 * file which installs, launches, looks right, and is still wrong:
 *
 *   • A misspelled meta-data name. `androix.browser.trusted.category` sat in
 *     the manifest for a whole release: Android does not complain about
 *     meta-data it has never heard of, it just ignores it.
 *   • A display mode that lets the phone's bars back in, so the game opens
 *     with a black strip across the top where its own header should be.
 *   • The workflow and the README drifting apart on the four secret names —
 *     the README is what the person setting them up reads, and a secret set
 *     under a name the workflow does not read is simply not there. The
 *     workflow then quietly builds a DEBUG apk, which Bazaar refuses.
 *   • Key material committed by accident. Whoever holds the keystore is the
 *     only one who can ever publish an update to this app; a copy in git is a
 *     copy in every clone of it, forever.
 *
 * Run: npx tsx src/tests/androidApp.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* The app lives at the repo root, one level above this package — walk up
 * rather than hard-coding, so the test runs from either directory. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(resolve(dir, 'android', 'build.gradle'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('android/ not found above ' + process.cwd());
}
const ROOT = repoRoot();
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const manifest = read('android/app/src/main/AndroidManifest.xml');
const gradle   = read('android/app/build.gradle');
const workflow = read('.github/workflows/android.yml');
const readme   = read('android/README.md');
const links    = read('android/assetlinks.template.json');

const PACKAGE = 'ir.prizequiz.app';
const SECRETS = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];

function run(): void {
  /* ---- the manifest ---- */

  check('every framework name in the manifest is spelled android. or androidx.', () => {
    /* This is the check that would have caught `androix.`. Anything that
     * starts with the letters of "android" has to continue into one of the two
     * real namespaces — a near miss is a name Android silently ignores. */
    const names = [...manifest.matchAll(/android:name="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(names.length >= 5, 'the manifest should declare more than a handful of names');
    for (const n of names) {
      if (!/^androi/i.test(n)) continue;                       // com.google.… and the like
      assert.ok(/^android(x)?\./.test(n), 'misspelled namespace: ' + n);
    }
  });

  check('the launcher opens the game full screen and keeps it there', () => {
    /* "immersive" gives the bars back permanently on the first stray edge
     * swipe, and the black strip the player complained about comes with them.
     * "sticky-immersive" hides them again on its own. */
    const m = /android:name="android\.support\.customtabs\.trusted\.DISPLAY_MODE"\s+android:value="([^"]+)"/.exec(manifest);
    assert.ok(m, 'the launcher declares no display mode, so it opens with the phone bars showing');
    assert.equal(m![1], 'sticky-immersive');
  });

  check('the app is allowed to open prizequiz.ir without a browser bar', () => {
    assert.match(manifest, /android:name="asset_statements"/, 'no asset statements declared');
    const statements = read('android/app/src/main/res/values/strings.xml');
    assert.match(statements, /handle_all_urls/, 'the statement does not delegate URL handling');
    assert.match(statements, /https:\/\/prizequiz\.ir/, 'the statement names some other site');
  });

  check('web push still reaches the notification tray', () => {
    /* A TWA was chosen over a WebView wrapper precisely so notifications keep
     * working. Both of these are what makes that true. */
    assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/, 'Android 13+ shows nothing without this');
    assert.match(manifest, /trusted\.DelegationService/, 'nothing delivers the pushes to the tray');
  });

  /* ---- signing ---- */

  check('no key material is committed', () => {
    const bad: string[] = [];
    (function walk(dir: string): void {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (/\.(jks|keystore|p12|pfx|pem|key)$/i.test(e)) bad.push(p);
      }
    })(join(ROOT, 'android'));
    assert.deepEqual(bad, [], 'key material in the repository: ' + bad.join(', '));
    assert.ok(!/storePassword\s+['"]/.test(gradle), 'a literal store password is written into build.gradle');
  });

  check('the build takes its key from properties, never from the tree', () => {
    /* Every one of these is read at exactly one place that matters, so the
     * assertions name that place. Asking only whether the string appears
     * anywhere in the file lets the one line that counts be rewritten while
     * a second, harmless mention keeps the test green. */
    assert.match(gradle, /def ks = project\.findProperty\('pzKeystore'\)/,
      'the signing config no longer reads pzKeystore, so no key is ever loaded');
    assert.match(gradle, /storeFile file\(ks\)/, 'the loaded key is not the one signed with');
    for (const prop of ['pzStorePassword', 'pzKeyAlias', 'pzKeyPassword']) {
      assert.ok(gradle.includes("project.findProperty('" + prop + "')"), 'build.gradle never reads ' + prop);
    }
    assert.match(gradle, /if \(project\.findProperty\('pzKeystore'\)\) signingConfig signingConfigs\.release/,
      'a release build without a key must not silently pretend to be signed');
  });

  check('the workflow and the README agree on the four secret names', () => {
    /* Drift here is invisible until someone sets a secret that nothing reads,
     * gets a debug apk, and is told by Bazaar that it is a debug apk. */
    for (const s of SECRETS) {
      assert.ok(workflow.includes('secrets.' + s), 'the workflow never reads ' + s);
      assert.ok(readme.includes('`' + s + '`'), 'the README never mentions ' + s);
    }
  });

  check('each gradle property is fed from the secret of the same name', () => {
    /* The pairing is the whole point: a build handed an empty alias is a build
     * that fails, and a build handed the wrong secret is worse. */
    for (const [prop, secret] of [
      ['pzStorePassword', 'ANDROID_KEYSTORE_PASSWORD'],
      ['pzKeyAlias', 'ANDROID_KEY_ALIAS'],
      ['pzKeyPassword', 'ANDROID_KEY_PASSWORD'],
    ]) {
      const re = new RegExp('-P' + prop + '="\\$\\{\\{ secrets\\.' + secret + ' \\}\\}"');
      assert.match(workflow, re, prop + ' is not fed from ' + secret);
    }
    assert.match(workflow, /-PpzKeystore="\$\{\{ steps\.keystore\.outputs\.path \}\}"/,
      'the build is not handed the key the restore step wrote');
  });

  check('a key present means a signed release, and its fingerprint is printed', () => {
    assert.match(workflow, /bundleRelease assembleRelease/, 'the signed path does not build a release');
    assert.match(workflow, /assembleDebug/, 'there is no debug fallback to try on a phone');
    assert.match(workflow, /if: env\.KEYSTORE_B64 == ''/, 'the debug fallback is not gated on the key being absent');
    /* Three steps belong to the signed path — restore the key, build, print
     * the fingerprint — and all three must be gated on the key being there.
     * An ungated restore step writes an empty keystore over a real one. */
    const gates = (workflow.match(/if: env\.KEYSTORE_B64 != ''/g) || []).length;
    assert.equal(gates, 3, 'the signed path should have exactly three steps, each gated on the key');
    assert.match(workflow, /^\s*keytool -list -v[\s\S]{0,220}SHA256:/m,
      'without the fingerprint in the log there is no way to fill in assetlinks.json');
  });

  check('the release apk and aab are actually collected', () => {
    for (const p of ['bundle/release/*.aab', 'apk/release/*.apk', 'apk/debug/*.apk']) {
      assert.ok(workflow.includes(p), 'the artifact does not include ' + p);
    }
  });

  /* ---- the domain side ---- */

  check('the assetlinks template names this app and waits for a real fingerprint', () => {
    const j = JSON.parse(links) as Array<{ target: { package_name: string; sha256_cert_fingerprints: string[] } }>;
    assert.equal(j.length, 1);
    assert.equal(j[0].target.package_name, PACKAGE);
    assert.equal(j[0].target.sha256_cert_fingerprints.length, 1);
    assert.match(j[0].target.sha256_cert_fingerprints[0], /PUT_YOUR/,
      'the template carries a real fingerprint — it is a template, it should carry a placeholder');
  });

  check('the package name is the same everywhere', () => {
    assert.ok(gradle.includes("applicationId '" + PACKAGE + "'"), 'build.gradle applies a different package name');
    assert.ok(gradle.includes("namespace '" + PACKAGE + "'"), 'build.gradle declares a different namespace');
    assert.ok(readme.includes(PACKAGE), 'the README tells the reader a different package name');
  });

  check('nginx serves assetlinks.json as JSON at the exact well-known path', () => {
    /* The comment at the top of that file quotes the very lines being checked,
     * so read only the lines nginx would read. */
    const conf = read('android/nginx-assetlinks.conf')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.match(conf, /location = \/\.well-known\/assetlinks\.json/, 'a prefix match here would answer for the wrong paths');
    assert.match(conf, /default_type application\/json/, 'Android will not read it as anything else');
  });

  console.log(`[androidApp] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
