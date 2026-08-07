/* THE GAME ADMIN PANEL — does its own JavaScript actually run?
 *
 * The site panel once shipped completely dead: a mis-escaped quote inside an
 * inline onclick produced a SyntaxError, the whole script failed to parse, and
 * every button — including «ورود» — did nothing. Nothing caught it, because the
 * panel is JavaScript hand-written inside HTML strings and no test ever asked a
 * parser to look at it.
 *
 * This does that for pzadmin.html: the script must parse, and the handlers the
 * Last Survivor topic rows generate must parse too — with topic names that
 * contain the characters most likely to break the escaping, since topics are
 * now free text an operator types in.
 *
 * Run: npx tsx src/tests/adminPanelHtml.test.ts
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let passed = 0, failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/* The panel lives at the repo root, one level above this package — walk up
 * rather than hard-coding, so the test runs from either directory. */
function findPanel(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const p = resolve(dir, 'pzadmin.html');
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('pzadmin.html not found above ' + process.cwd());
}
const html = readFileSync(findPanel(), 'utf8');
const script = (/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html) || [])[1] || '';

function run(): void {
  check('the panel carries a script and it parses', () => {
    assert.ok(script.length > 1000, 'the panel should carry its script inline');
    new Function(script);                 // throws SyntaxError if it does not parse
  });

  check('the Last Survivor topic list is the admin one, not the picker', () => {
    /* The picker hides what has been taken off the list. If the panel read that
     * endpoint, a hidden topic would vanish from the panel too and could never
     * be restored. */
    assert.match(script, /api\('GET','\/admin\/last-survivor\/topics'\)/,
      'the panel must read the admin topic list, which includes hidden topics');
  });

  check('the panel can add, restore and remove topics', () => {
    for (const fn of ['lsAddTopic', 'lsRestoreTopic', 'lsDeleteTopic', 'lsToggleTopic']) {
      assert.ok(script.includes('function ' + fn + '('), 'missing ' + fn);
    }
    assert.match(script, /POST','\/admin\/last-survivor\/topics'/, 'adding a topic posts to the collection');
    assert.match(script, /id="ls_newTopic"/, 'and there is a field to type the name into');
  });

  check('every handler a topic row generates parses — including awkward names', () => {
    /* Run the panel's REAL row-building code. Anything else would test a copy. */
    const m = /\(topics\.topics\|\|\[\]\)\.map\((tp=>\{[\s\S]*?'<\/td><\/tr>';\})\)/.exec(script);
    assert.ok(m, 'the topic row builder should be findable in the panel source');
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const fa = (n: unknown) => String(n);
    const rowOf = new Function('esc', 'fa', 'return (' + m![1] + ')')(esc, fa) as (tp: any) => string;

    const names = [
      'اطلاعات عمومی',
      'تصادفی',
      'فیلم "کلاسیک"',            // double quotes — what killed the site panel
      "it's a topic",             // an apostrophe
      'a & b <c>',                // HTML metacharacters
      'خط\\بک‌اسلش'                // a backslash
    ];
    for (const name of names) {
      for (const tp of [
        { name, questionCount: 3, random: name === 'تصادفی', custom: false, hidden: false, playable: true, icon: '🧠' },
        { name, questionCount: 0, random: false, custom: true, hidden: false, playable: false, icon: '⚽' },
        { name, questionCount: 5, random: false, custom: false, hidden: true, playable: false, icon: '❓' }
      ]) {
        const row = rowOf(tp);
        const handlers = [...row.matchAll(/onclick="([^"]*)"/g)].map((h) => h[1]!);
        assert.ok(handlers.length > 0 || tp.random, 'a row should offer at least one action: ' + name);
        for (const h of handlers) {
          const js = h.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          try { new Function(js); }
          catch (e) { throw new Error('handler does not parse for «' + name + '»: ' + js + ' — ' + (e as Error).message); }
        }
      }
    }
  });

  check('a hidden topic offers restore, and never a bare delete', () => {
    const m = /\(topics\.topics\|\|\[\]\)\.map\((tp=>\{[\s\S]*?'<\/td><\/tr>';\})\)/.exec(script);
    const esc = (s: string) => String(s);
    const fa = (n: unknown) => String(n);
    const rowOf = new Function('esc', 'fa', 'return (' + m![1] + ')')(esc, fa) as (tp: any) => string;
    const hidden = rowOf({ name: 'ورزشی', questionCount: 4, random: false, custom: false, hidden: true, playable: false, icon: '⚽' });
    assert.match(hidden, /lsRestoreTopic/, 'a hidden topic must be restorable from the panel');
    assert.ok(!/lsDeleteTopic/.test(hidden), 'and it is already off the list, so there is nothing to remove');
    const random = rowOf({ name: 'تصادفی', questionCount: 40, random: true, custom: false, hidden: false, playable: true, icon: '🎲' });
    assert.ok(!/lsDeleteTopic/.test(random), '«تصادفی» must not offer a delete the server will refuse');
  });

  console.log(`[adminPanelHtml] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
