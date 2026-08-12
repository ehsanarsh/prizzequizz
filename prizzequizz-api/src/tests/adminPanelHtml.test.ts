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

  check('the SMS group screen exists and adds a number on Enter', () => {
    /* The whole interaction is the Enter key, so that binding IS the feature. */
    assert.ok(html.includes('renderSmsGroups'), 'the screen exists');
    assert.ok(html.includes("id=\"sgPhone\""), 'the number input exists');
    const i = html.indexOf('id=\"sgPhone\"');
    assert.match(html.slice(i, i + 260), /onkeydown=.*Enter.*sgAdd\(\)/, 'Enter adds the number');
    for (const ep of ['/admin/sms/groups', "/admin/sms/groups/'+id+'/send"]) {
      assert.ok(html.includes(ep), 'calls ' + ep);
    }
  });

  check('adding a number does NOT re-render the screen', () => {
    /* A full render would move focus off the input, and the next number is
       about to be typed into it — which makes a list of a hundred impossible. */
    const i = html.indexOf('async function sgAdd(');
    assert.ok(i > 0, 'sgAdd exists');
    const body = html.slice(i, i + 700);
    assert.doesNotMatch(body, /\brender\(\)/, 'sgAdd must not call render()');
    assert.match(body, /el\.focus\(\)/, 'and it keeps focus for the next one');
  });

  check('the withdraw-code screen exists', () => {
    assert.ok(html.includes('renderWithdrawOtp'), 'the screen exists');
    assert.ok(html.includes('/admin/withdraw-otp'), 'and is wired to its endpoint');
  });

  /* ── merged tabs ──────────────────────────────────────────────────── */

  check('the shop no longer carries a second banner editor', () => {
    /* «بنرها» owns every banner on every screen, with video and GIF. Two
       editors for one thing means one of them is always the stale one. */
    for (const gone of ['PROMO_SLOTS', 'function promoCard(', 'function promoSave(', 'promoPickImage', "'/admin/ticket-promos'"]) {
      assert.ok(!script.includes(gone), 'left behind: ' + gone);
    }
    assert.ok(!html.includes('تبلیغ صفحه‌های بلیط'), 'the shop still shows the old promo editor');
    assert.ok(script.includes('async function renderShopAdmin('), 'and the shop screen itself is still there');
  });

  check('every screen the sidebar used to list is still reachable', () => {
    /* Merging rows must not lose a section — that is the very report this
       whole round started from. Each screen is either its own nav row or a
       member of a group. */
    const nav = (/const NAV=\[[\s\S]*?\n\];/.exec(script) || [])[0] || '';
    const groups = (/const TAB_GROUPS=\{[\s\S]*?\n\};/.exec(script) || [])[0] || '';
    assert.ok(nav && groups, 'NAV and TAB_GROUPS must both be present');
    const reachable = new Set<string>();
    for (const m of nav.matchAll(/\['([a-zA-Z_0-9]+)','[^']*','[^']*'\]/g)) reachable.add(m[1]!);
    for (const m of groups.matchAll(/\['([a-zA-Z_0-9]+)','[^']*'\]/g)) reachable.add(m[1]!);
    for (const key of ['dashboard', 'finance', 'accounting', 'expenses', 'users', 'matches', 'lastsurvivor', 'support',
      'questions', 'qreports', 'aistudio', 'pipeline', 'categories', 'characters', 'charboxes', 'lifelines', 'rewards',
      'recordmode', 'onboarding', 'wallet', 'withdrawals', 'payoutpartners', 'withdrawotp', 'smsgroups', 'rewardholds',
      'tickets', 'shop', 'giftcodes', 'payments', 'cfg_xp', 'cfg_level', 'cfg_cup', 'cfg_gameplay', 'leagues', 'missions2',
      'leaderboard', 'campaign', 'events', 'banners', 'notifications', 'sms', 'monitoring', 'anticheat', 'suspicious',
      'reports', 'logs', 'reset', 'accounts', 'backup', 'general', 'rawcfg']) {
      assert.ok(reachable.has(key), 'no longer reachable from the sidebar: ' + key);
    }
  });

  check('no nav row is listed twice', () => {
    const nav = (/const NAV=\[[\s\S]*?\n\];/.exec(script) || [])[0] || '';
    const rows: Array<[string, string]> = [...nav.matchAll(/\['([a-zA-Z_0-9]+)','[^']*','([^']*)'\]/g)].map((m) => [m[1]!, m[2]!]);
    const seen = new Map<string, number>(), labels = new Map<string, number>();
    for (const [k, l] of rows) { seen.set(k, (seen.get(k) || 0) + 1); labels.set(l, (labels.get(l) || 0) + 1); }
    const dupKeys = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    const dupLabels = [...labels].filter(([, n]) => n > 1).map(([k]) => k);
    assert.deepEqual(dupKeys, [], 'duplicate nav keys');
    assert.deepEqual(dupLabels, [], 'duplicate nav labels');
  });

  check('a screen with a purpose-built renderer is not shadowed by a config page', () => {
    /* render() consults CONFIG_PAGES BEFORE the renderer map, so a key in both
       can never reach its screen. That is exactly how «بنرها» went blank, and
       «ضدتقلب» was sitting in the same trap. */
    const cfg = (/const CONFIG_PAGES=\{[^}]*\};/.exec(script) || [])[0] || '';
    const fnMap = (/const fn=\{[\s\S]*?\}\[CUR\];/.exec(script) || [])[0] || '';
    assert.ok(cfg && fnMap, 'both maps must be present');
    const cfgKeys = [...cfg.matchAll(/([a-zA-Z_0-9]+):\[/g)].map((m) => m[1]!);
    const shadowed = cfgKeys.filter((k) => new RegExp('[,{]' + k + ':render').test(fnMap));
    assert.deepEqual(shadowed, [], 'these tabs can never reach their own screen');
  });

  check('the panel chases what is new all the way to the row', () => {
    /* Three places, or it is not a chase: the sidebar row, the subtab inside
       it, and the row in the table. */
    assert.match(script, /function badgeHTML\(/, 'the sidebar badge');
    assert.match(script, /data-p="'\+p\[0\]\+'"[\s\S]{0,120}badgeHTML\(p\[0\]\)/, 'the sidebar row carries it');
    assert.match(script, /data-sub="'\+t\[0\]\+'"[\s\S]{0,140}badgeHTML\(t\[0\]\)/, 'and so does the subtab');
    assert.match(script, /function newTag\(/, 'the row tag');
    for (const screen of ['withdrawals', 'support', 'rewardholds', 'qreports']) {
      assert.ok(script.includes("newTag('" + screen + "'"), 'no row tag on ' + screen);
    }
    /* A merged row must total what is hidden behind it, or a payout stays
       invisible until somebody opens the row it is under. */
    assert.match(script, /if\(TAB_GROUPS\[key\]\)\s*return groupMembers\(key\)\.reduce/, 'a group row must sum its screens');
  });

  check('the screen is marked seen BEFORE it draws', () => {
    /* Marking afterwards moves the mark past the very rows that were about to
       be tagged, and «جدید» would never appear on anything. */
    const i = script.indexOf('async function render(');
    assert.ok(i > 0, 'render() exists');
    /* Wide enough to clear the renderer map, which is one very long line. */
    const body = script.slice(i, i + 4000);
    const seen = body.indexOf('await badgeSeen(CUR)');
    const draw = body.indexOf('if(fn){');
    assert.ok(seen > 0 && draw > 0 && seen < draw, 'badgeSeen must run before the renderer');
  });

  check('access is still granted one screen at a time', () => {
    /* A merged row must not become a single permission covering four screens —
       that would hand an account whatever it was not granted. */
    assert.match(script, /function permChecklist[\s\S]{0,400}navLeaves\(\)/,
      'the access checklist must be built from the opened-out screen list');
    assert.match(script, /function canTab[\s\S]{0,400}TAB_GROUPS\[k\]/,
      'a merged row opens only when one of its own screens is permitted');
  });

  console.log(`[adminPanelHtml] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
