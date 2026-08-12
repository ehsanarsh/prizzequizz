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

  check('every file the panel uploads is turned into WebP first', () => {
    /* All four upload paths already shrink and re-encode before sending, which
     * is why the game's artwork is small. Nothing enforced it, though — a fifth
     * upload added later would happily post a 4 MB phone photo, and nobody
     * would notice until a player's first load. This is that enforcement.
     *
     * The check follows one level of calls, because the handler on the input is
     * usually a thin wrapper around the function that does the encoding. */
    const bodyOf = (name: string): string => {
      const i = script.indexOf('function ' + name + '(');
      if (i < 0) return '';
      // Walk braces from the first { after the signature to its match.
      const start = script.indexOf('{', i);
      let depth = 0;
      for (let j = start; j < script.length; j++) {
        if (script[j] === '{') depth++;
        else if (script[j] === '}') { depth--; if (!depth) return script.slice(start, j + 1); }
      }
      return script.slice(start);
    };
    const encodesWebp = (name: string, seen = new Set<string>()): boolean => {
      if (seen.has(name)) return false;
      seen.add(name);
      const body = bodyOf(name);
      if (!body) return false;
      if (/toDataURL\(\s*['"]image\/webp['"]/.test(body) || /['"]image\/webp['"]/.test(body)) return true;
      // …otherwise follow the functions this one calls.
      for (const m of body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
        if (encodesWebp(m[1]!, seen)) return true;
      }
      return false;
    };

    /* Every <input type=file> in the markup, plus the one catPickImage builds
     * at runtime — a dynamically created input is still an upload. */
    const handlers = new Set<string>();
    for (const m of html.matchAll(/<input[^>]*type=["']file["'][^>]*>/g)) {
      const on = /onchange=["']([a-zA-Z_$][\w$]*)\(/.exec(m[0]);
      assert.ok(on, 'a file input with no onchange handler: ' + m[0]);
      handlers.add(on![1]!);
    }
    for (const m of script.matchAll(/inp\.type\s*=\s*'file'/g)) {
      void m;   // the only runtime-built input belongs to catPickImage
      handlers.add('catPickImage');
    }
    assert.ok(handlers.size >= 4, 'expected the panel’s upload handlers, found: ' + [...handlers].join(', '));
    for (const h of handlers) {
      assert.ok(encodesWebp(h), h + ' uploads without producing WebP — every upload must be converted');
    }
  });

  check('an SVG is passed through instead of being rasterised', () => {
    /* Converting an SVG would make it BIGGER and blurry: it is already a few
     * hundred bytes and it scales for free. "Smallest format" means smallest,
     * not "WebP whatever the cost". */
    const i = script.indexOf('function catShrink(');
    assert.ok(i > 0, 'catShrink should exist');
    assert.match(script.slice(i, i + 400), /image\/svg\+xml/, 'catShrink must recognise SVG and leave it alone');
  });

  /* ── the صندوق جایزه reached the panel too ───────────────────────── */

  check('the panel has a partners screen, wired to its endpoints', () => {
    assert.match(html, /payoutpartners/, 'the tab exists');
    assert.match(html, /renderPayoutPartners/, 'and it renders');
    for (const ep of ['/admin/payout-partners', "/admin/payout-partners/'+pid+'/codes"]) {
      assert.ok(html.includes(ep), 'calls ' + ep);
    }
  });

  check('the panel no longer calls the wallet a wallet', () => {
    /* The nav is the part a person reads first. */
    assert.ok(html.includes("['wallet','🏆','صندوق جایزه']"), 'nav says صندوق جایزه');
    assert.ok(!html.includes("['wallet','👛','کیف پول']"), 'and not کیف پول');
  });

  check('no figure in the panel is labelled as a top-up any more', () => {
    /* Deposits are structurally zero now, so a tile named «شارژ» would be a
       tile that always reads nothing. */
    assert.ok(!html.includes('کل واریزها (شارژ)'), 'the deposits tile is renamed');
    assert.ok(!/tbl\(\['دوره','شارژ'/.test(html), 'and so is the report column');
  });

  console.log(`[adminPanelHtml] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
