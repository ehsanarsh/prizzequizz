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

/* The same walk buildFields does — used by the balance checks below. */
function scalarsOf(o: any, path: string): string[] {
  const out: string[] = [];
  const walk = (n: any, p: string) => {
    for (const k of Object.keys(n)) {
      const v = n[k], q = p + '.' + k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) walk(v, q);
      else if (!Array.isArray(v)) out.push(q);
    }
  };
  walk(o, path);
  return out;
}

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

  /* The body of a named function in the panel's script, and whether that
     function — or anything it calls — re-encodes a file as an image. Shared by
     the two upload rules below: one requires it, the other forbids it. */
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

  check('every file the panel uploads is turned into WebP first', () => {
    /* All four upload paths already shrink and re-encode before sending, which
     * is why the game's artwork is small. Nothing enforced it, though — a fifth
     * upload added later would happily post a 4 MB phone photo, and nobody
     * would notice until a player's first load. This is that enforcement.
     *
     * The check follows one level of calls, because the handler on the input is
     * usually a thin wrapper around the function that does the encoding. */
    /* Every IMAGE <input type=file> in the markup, plus the one catPickImage
     * builds at runtime — a dynamically created input is still an upload.
     *
     * An input that takes something else is not covered by this rule and must
     * not be: re-encoding an audio file as WebP would destroy it. Those are
     * checked by the next test instead. */
    const handlers = new Set<string>();
    for (const m of html.matchAll(/<input[^>]*type=["']file["'][^>]*>/g)) {
      const accept = /accept=["']([^"']*)["']/.exec(m[0]);
      const isImage = !accept || /image/i.test(accept[1]!);
      if (!isImage) continue;
      const on = /onchange=["']([a-zA-Z_$][\w$]*)\(/.exec(m[0]);
      assert.ok(on, 'an image file input with no onchange handler: ' + m[0]);
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

  /* THE ONE UPLOAD THAT IS NOT A PICTURE. Waiting-room music is sent as it is —
     there is nothing to shrink and re-encoding would ruin it — so what has to be
     true instead is that its size is checked BEFORE the wait, and that it is not
     run through the image pipeline. */
  check('the music upload is sent as audio and sized before it is sent', () => {
    const inputs = [...html.matchAll(/<input[^>]*type=["']file["'][^>]*>/g)].map((m) => m[0]);
    const audio = inputs.filter((t) => /accept=["'][^"']*audio/i.test(t));
    assert.equal(audio.length, 1, 'expected exactly one audio upload, found ' + audio.length);
    const i = script.indexOf('function lsMusicUpload(');
    assert.ok(i > 0, 'the music upload handler is missing');
    /* The primary handler only. The base64 route still exists below it as a
       fallback for an API that predates the raw door — that one is allowed to
       build a string, and is checked separately. */
    const body = script.slice(i, script.indexOf('async function lsMusicUploadLegacy('));
    assert.ok(/file\.size\s*>\s*_LSM_MAX/.test(body), 'the size is not checked before uploading');
    /* THE FILE GOES AS ITSELF. Reading it into a base64 string first is what
       made a ten-megabyte upload die in the browser: the string, the JSON copy
       and the request body are three copies of the file before a byte leaves.
       So the body must be the File, and readAsDataURL must be nowhere near it. */
    assert.ok(/xhr\.send\(file\)/.test(body), 'the file itself is not what gets sent');
    assert.ok(!/readAsDataURL|JSON\.stringify/.test(body), 'the file is still being turned into a string first');
    /* Followed one level down, the same way the WebP rule follows its handlers:
       an encoder reached through a helper is still an encoder. */
    assert.ok(!encodesWebp('lsMusicUpload'), 'music must not go through the image pipeline');
    assert.ok(/'\/admin\/waiting-music\/raw/.test(body), 'it does not post to the music endpoint');
    /* And the operator sees it moving, rather than a button that sits there. */
    assert.ok(/xhr\.upload\.onprogress/.test(body), 'a long upload gives no sign of progress');
    assert.ok(/xhr\.onerror/.test(body), 'a network failure would be reported as nothing at all');
    /* And the old way is a FALLBACK, not a second road: only a 404 may take it. */
    assert.match(body, /xhr\.status===404\s*\)\s*\{\s*lsMusicUploadLegacy/,
      'the base64 upload must only be reached when the raw route is missing');
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

  check('a missing badges endpoint is reported, not swallowed', () => {
    /* The panel was updated and the API was not; /admin/badges 404'd, the
       failure was caught in complete silence, and "the badges do not work"
       was indistinguishable from "the backend is still the old one". */
    const i = script.indexOf('async function badgeLoad(');
    assert.ok(i > 0, 'badgeLoad exists');
    const body = script.slice(i, i + 800);
    assert.match(body, /catch\s*\([\s\S]{0,500}PZB_ERR\s*=/, 'the failure must be recorded, not dropped');
    assert.ok(script.includes('function badgeStatus('), 'and shown somewhere');
    assert.ok(script.includes('const PANEL_BUILD='), 'the sidebar states which panel file is loaded');
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

  /* ── کوییزساز ─────────────────────────────────────────────────────── */

  check('the quiz-maker list is reachable from the questions tab', () => {
    assert.ok(script.includes('async function renderQuizMaker('), 'the screen exists');
    assert.match(script, /async function renderQuestions\(\)\{[\s\S]{0,120}Q_VIEW==='maker'[\s\S]{0,40}renderQuizMaker\(\)/,
      'and the questions tab actually switches to it');
    assert.ok(script.includes("qViewBar(badgeFor('questions'))"),
      'the bank view shows how many player questions are waiting');
  });

  check('approving a player question is one button, not a bulk sweep', () => {
    /* Approving one pays real money. It must never ride along with the bank
       screen’s «تأیید همه». */
    const i = script.indexOf('async function renderQuizMaker(');
    const body = script.slice(i, script.indexOf('async function qmkReview('));
    assert.ok(body.includes("qmkReview(\\'"), 'each row reviews itself');
    assert.ok(!/qBulk\(/.test(body), 'and the bulk approver is not on this screen');
  });

  check('the review call sends an action the API accepts', () => {
    const i = script.indexOf('async function qmkReview(');
    const body = script.slice(i, i + 900);
    assert.match(body, /'\/admin\/user-questions\/'\+id\+'\/review',\{action\}/, 'right endpoint and body');
    assert.ok(body.includes("if(action==='reject'&&!confirm("), 'rejecting asks first — it cannot be undone');
    assert.ok(body.includes('r.rewarded'), 'and the operator is told whether it paid');
  });

  check('the reward table shows the real chance, not raw weights', () => {
    /* «وزن ۸» tells nobody whether that is 8٪ or 40٪, and this table decides
       how often a 50,000-toman prize goes out. */
    assert.ok(script.includes('function qmkChance('), 'the chance line exists');
    assert.match(script, /function qmkChance\(\)\{[\s\S]{0,400}p\.weight\/tot\*1000/, 'computed from the weights actually on screen');
    assert.match(script, /function qmkChance\(\)\{[\s\S]{0,400}tot<=0\?'⚠️/, 'and all-zero weights are called out');
  });

  check('saving the reward settings sends every field', () => {
    const i = script.indexOf('async function qmkSaveConfig(');
    const body = script.slice(i, i + 500);
    for (const f of ['enabled:', 'mode:', 'n:', 'prizes:']) assert.ok(body.includes(f), 'missing ' + f);
    assert.ok(body.includes("'PUT','/admin/user-questions/config'"), 'to the config endpoint');
  });

  /* ── لیگ هفتگی ────────────────────────────────────────────────────── */

  check('the leagues row has a real screen, not the raw JSON editor', () => {
    assert.ok(script.includes('async function renderLeagues('), 'the screen exists');
    assert.ok(!/leagues:\['leagues'/.test(script), 'it must not also be a CONFIG_PAGES key — that shadows the renderer');
  });

  check('overlapping or gapped rank bands are refused before saving', () => {
    /* Two leagues claiming rank 15 would hand that player two tickets; a gap
       would silently drop everybody between them. */
    const i = script.indexOf('async function lgSave(');
    const body = script.slice(i, i + 1400);
    assert.match(body, /روی هم افتاده/, 'overlap must be caught');
    assert.match(body, /بی‌لیگ جا مانده/, 'and so must a gap');
    assert.ok(body.indexOf('api(\'PUT\'') > body.indexOf('روی هم افتاده'), 'the checks come before the save');
  });

  check('filing a room result asks who actually played', () => {
    /* The participation prize is real money and the seat is booked whether the
       player turns up or not. */
    const i = script.indexOf('async function lgSendResult(');
    const body = script.slice(i, i + 700);
    assert.match(body, /lgr_p:checked/, 'only the ticked players are sent');
    assert.match(body, /played\.length/, 'and an empty room is refused');
  });

  /* ── استخر «تصادفی» ───────────────────────────────────────────────── */

  check('the operator can choose which topics feed «تصادفی»', () => {
    assert.ok(script.includes('function lsRandomPoolCard('), 'the card exists');
    assert.ok(script.includes('lsRandomPoolCard(topics)'), 'and it is actually placed on the screen');
    assert.ok(script.includes("api('PUT','/admin/last-survivor/random-categories'"), 'and it saves to the endpoint');
  });

  check('ticking every topic is stored as "no restriction", not as a fixed list', () => {
    /* Otherwise a category added next month would silently be left out of a
       pool the operator believes is "everything". */
    const i = script.indexOf('async function lsSaveRandomPool(');
    const body = script.slice(i, i + 800);
    assert.match(body, /picked\.length===all/, 'the all-ticked case is detected');
    assert.match(body, /\?\[\]:picked/, 'and sent as an empty list');
  });

  /* ── پک‌های چت ────────────────────────────────────────────────────── */

  check('the chat-pack row has a screen and a nav entry', () => {
    assert.ok(script.includes('async function renderChatPacks('), 'the screen exists');
    assert.ok(/chatpacks:renderChatPacks/.test(script), 'and the router reaches it');
    assert.ok(/\['chatpacks','💬'/.test(script), 'and there is a way in from the sidebar');
    assert.ok(!/chatpacks:\['chatpacks'/.test(script), 'it must not also be a CONFIG_PAGES key — that shadows the renderer');
  });

  check('every field an operator was promised is on the form', () => {
    const i = script.indexOf('function cpDraw(');
    const body = script.slice(i, i + 3500);
    /* Name, emoji, price, coins-or-cash, and the sentences themselves. */
    for (const f of ['cp_n', 'cp_e', 'cp_p', 'cp_c', 'cp_t', 'cp_f', 'cp_en']) {
      assert.ok(body.includes('id="' + f), 'missing field ' + f);
    }
    assert.match(body, /نقدی/, 'cash must be an option');
    assert.match(body, /سکه/, 'and so must coins');
  });

  check('saving sends the sentences as a list, one per line', () => {
    const i = script.indexOf('function cpCollect(');
    const body = script.slice(i, i + 900);
    assert.match(body, /split\('\\n'\)/, 'the textarea is split into lines');
    assert.match(body, /filter\(Boolean\)/, 'and blank lines are dropped');
    assert.ok(script.includes("api('PUT','/admin/chat-packs'"), 'and it goes to the chat-pack endpoint');
  });

  check('a free pack cannot be given a price in the form', () => {
    /* The server stores a free pack at zero regardless; the form must not
       invite an operator to type a number that will be thrown away. */
    const i = script.indexOf('function cpCollect(');
    const body = script.slice(i, i + 900);
    assert.match(body, /free\?0:/, 'the collected price is zeroed for a free pack');
  });

  check('deleting a pack warns that it takes the buyers with it', () => {
    const i = script.indexOf('function cpRemove(');
    const body = script.slice(i, i + 400);
    assert.match(body, /confirm\(/, 'it must ask first');
    assert.match(body, /خرید/, 'and say what else goes');
  });

  /* ── THE PROFIT FIGURE ──────────────────────────────────────────────── */
  /* «سود ما از درصد کمسیون بازی‌ها و تبلیغات و فروش آیتم‌ها در فروشگاه — به غیر
     از بلیط مسابقات — هست… و همه این سودها باید به صورت مجزا نوشته بشه.» */
  check('the finance tab has a profit card with every source on its own line', () => {
    /* Anchored on the card, not on the function: renderAccounting builds the
       filters, the mode table and the house-revenue card first, so a fixed
       window from the top of it misses this entirely. */
    const i = script.indexOf('💰 سود شرکت');
    assert.ok(i > 0, 'there is no profit card at all');
    const body = script.slice(i, i + 3000);
    for (const line of ['E.commission', 'E.lsRake', 'E.forfeitedPot', 'E.ads', 'E.shopItems', 'E.coins', 'E.lifelines']) {
      assert.ok(body.includes(line), 'the profit card is missing ' + line);
    }
    assert.ok(body.includes('E.total') && body.includes('E.net'), 'it must total them up');
  });

  check('ticket money is shown as passing through, never as profit', () => {
    const start = script.indexOf('💰 سود شرکت');
    const passing = script.indexOf('🎫 پولی که فقط از وسط رد می‌شود');
    assert.ok(start > 0 && passing > start, 'the two cards are not both there, in order');
    const card = script.slice(start, passing);
    /* The one thing that must not happen: ticket money inside the profit sum. */
    assert.ok(!card.includes('ticketsExcluded'), 'ticket money is inside the profit card');
    assert.ok(!/income\.tickets/.test(card), 'ticket money is inside the profit card');
    /* But it must still be reported, just not as profit. */
    const after = script.slice(passing, passing + 1200);
    assert.ok(after.includes('E.ticketsExcluded'), 'ticket sales stopped being shown at all');
    assert.ok(after.includes('E.prizesExcluded'), 'the prizes paid from that money must show too');
  });

  check('a panel on an older API still draws the profit card', () => {
    const i = script.indexOf('async function renderAccounting(');
    const body = script.slice(i, i + 1200);
    /* Without this every tile reads «undefined ت» against a server that has
       not been updated yet. */
    assert.match(body, /const E=Object\.assign\(\{/, 'the earnings block needs a default');
    assert.match(body, /r\.earnings\|\|\{\}/, 'and it must fall back when the field is absent');
  });

  check('advertising income can be entered and taken back out', () => {
    assert.ok(script.includes('async function adRevenueSave('), 'no way to record it');
    assert.ok(script.includes('async function adRevenueDel('), 'a typed figure must be removable');
    const i = script.indexOf('async function adRevenueSave(');
    const body = script.slice(i, i + 700);
    assert.match(body, /amount>0/, 'zero is not an advertising payment');
    assert.match(body, /'\/admin\/ad-revenue'/, 'it must post to the ad-revenue route');
  });

  /* ── THE DUEL TAB ───────────────────────────────────────────────────── */
  /* «باید دوئل هم مثل آخرین بازمانده تب داشته باشه و گیم‌پلی‌اش توش باشه و
     بتونم از اونجا تنظیم کنم.» */
  check('duel has a tab of its own', () => {
    assert.match(html, /\['duel','⚔️','دوئل'\]/, 'no duel entry in the sidebar');
    assert.ok(script.includes('duel:renderDuel'), 'the duel tab has no renderer wired');
    assert.ok(script.includes('async function renderDuel('), 'the renderer is missing');
  });

  check('and its commission is editable there', () => {
    const i = script.indexOf('async function renderDuel(');
    const body = script.slice(i, i + 4000);
    assert.ok(body.includes("num('du_rake'"), 'no commission field');
    assert.ok(body.includes('rakePercent'), 'the field must be tied to the real setting');
    const save = script.slice(script.indexOf('async function duelSave('), script.indexOf('async function duelSave(') + 1400);
    assert.match(save, /rakePercent:rake/, 'saving must send the commission');
    /* The service clamps to 0..90; the form should not let a number through
       that it knows will be refused. */
    assert.match(save, /rake>=0&&rake<=90/, 'the range is not checked before sending');
  });

  check('the duel tab says the commission is shared with «همه یا هیچ»', () => {
    const i = script.indexOf('async function renderDuel(');
    const body = script.slice(i, i + 4000);
    /* economy.paid.rakePercent is one setting read by both modes. An operator
       changing it for duel is changing it for the other one too, and finding
       that out afterwards is the kind of surprise money is made of. */
    assert.ok(body.includes('همه یا هیچ'), 'the shared effect is not mentioned');
  });

  check('and its gameplay settings are there too', () => {
    const i = script.indexOf('async function renderDuel(');
    const body = script.slice(i, i + 4000);
    for (const f of ['du_qc', 'du_time', 'du_ep_cash', 'du_rp_mult']) {
      assert.ok(body.includes(f), 'missing gameplay field ' + f);
    }
  });

  /* «در پنل مدیریت در تب دوئل ورودی رو نوشته قلب سکه و مبلغ. باید در دوستانه
     با قلب و سکه باشه، در رقابت اصلی با بلیط. الان همه چی درسته ها — فقط در
     پنل اونجوری نوشته شده، یعنی منطق بازی رو دست نزن.»

     The game was right and the labels were wrong: «بازی نقدی — مبلغ» sat beside
     the hearts and coins as if the paid duel were entered by typing a number,
     when it is entered with a ticket. An operator reading this page would set
     the wrong thing and wonder why nothing changed. */
  check('the duel tab names the two entries the way the game does', () => {
    const i = script.indexOf('async function renderDuel(');
    const body = script.slice(i, i + 4000);
    assert.ok(body.includes('دوستانه — قلب'), 'the friendly entry is not named as friendly');
    assert.ok(body.includes('دوستانه — سکه'), 'the friendly coin entry is not named as friendly');
    assert.ok(!/بازی رایگان — قلب/.test(body), 'the old «بازی رایگان» label is still there');
    assert.ok(!/بازی نقدی — مبلغ/.test(body), 'the paid duel is still described as an amount to type');
    /* The paid duel is entered with a TICKET, and this page must say where a
       ticket is actually configured rather than implying it is here. */
    assert.ok(/بلیط/.test(body), 'the ticket is never mentioned on the duel tab');
    assert.ok(/بلیط‌ها/.test(body), 'the tab does not say where tickets are set');
  });

  check('and the field that remains explains what it really is', () => {
    const i = script.indexOf('async function renderDuel(');
    const body = script.slice(i, i + 4000);
    /* The number is still real — it is the base value used when somebody
       enters the paid duel WITHOUT a ticket — so it stays, with the sentence
       that stops it being read as «the price of a paid duel». */
    assert.ok(body.includes("num('du_ep_cash'"), 'the base value field was removed, not relabelled');
    assert.ok(/ارزش پایهٔ رقابت اصلی/.test(body), 'the base value is not named as a base value');
    assert.ok(/ارزش از خود بلیط می‌آید/.test(body), 'nothing says where the value normally comes from');
  });

  check('the prize rows are named by half, not by price', () => {
    const i = script.indexOf('async function renderDuel(');
    const body = script.slice(i, i + 4000);
    assert.ok(body.includes('دوستانه — پایه (سکه)'), 'the friendly prize base is not named');
    assert.ok(body.includes('رقابت اصلی — ضریب'), 'the paid multiplier is not named');
    assert.ok(!/رایگان — پایه/.test(body), 'the old «رایگان» prize label is still there');
    assert.ok(!/نقدی — ضریب ورودی/.test(body), 'the old «نقدی» multiplier label is still there');
    /* The formula line said «مبلغ ورودی × ضریب», which is the same wrong idea
       one line further down. */
    assert.ok(/ارزش بلیط × ضریب/.test(body), 'the formula still talks about a typed amount');
  });

  /* THE LOGIC IS NOT TOUCHED. «یعنی منطق بازی رو دست نزن» — the field names
     that carry the values are the same ones as before, so this is a change of
     wording and nothing else. */
  check('and none of the settings behind the labels moved', () => {
    const save = script.slice(script.indexOf('async function duelSave('), script.indexOf('async function duelSave(') + 2000);
    for (const f of ['du_ef_h', 'du_ef_c', 'du_ep_cash', 'du_rf_base', 'du_rf_stage', 'du_rp_mult']) {
      assert.ok(save.includes(f), 'saving no longer reads ' + f);
    }
  });

  /* ── THE MATCHES TAB ────────────────────────────────────────────────── */
  /* «باید در تب مسابقات دوئل رو جدا بنویسه، آخرین بازمانده رو جدا بنویسه، همه
     یا هیچ رو جدا بنویسه، و همه در تب مسابقات باشن.» */
  check('the matches tab has a shelf for each mode', () => {
    assert.ok(script.includes('const M_MODES='), 'no mode list');
    const i = script.indexOf('const M_MODES=');
    const modes = script.slice(i, i + 200);
    for (const m of ['duel', 'lastSurvivor', 'allOrNothing']) {
      assert.ok(modes.includes(m), 'the matches tab is missing ' + m);
    }
  });

  check('duel and «همه یا هیچ» are filtered apart rather than shown together', () => {
    const i = script.indexOf('async function renderMatches(');
    const body = script.slice(i, i + 5000);
    /* Both are rows in the same table; without a filter the tab shows one
       mode's matches under the other's heading. */
    assert.match(body, /filter\(m=>String\(m\.modeId\|\|''\)===M_MODE\)/, 'the mode filter is missing');
  });

  check('and Last Survivor is read from its own rooms, not the matches table', () => {
    const i = script.indexOf('async function renderMatches(');
    const body = script.slice(i, i + 5000);
    /* This is why it was missing entirely rather than merely mislabelled: it
       is not in `matches` at all. */
    assert.ok(body.includes("/admin/last-survivor/rooms"), 'LS must come from its own endpoint');
    assert.ok(body.includes("M_MODE==='lastSurvivor'"), 'LS needs its own branch');
  });

    /* ── EDITING A SUBMITTED QUESTION WHERE IT IS REVIEWED ─────────────── */
  /* «باید بتونم سوال طرح شدهٔ کاربر رو ویرایش و ثبت کنم — الان نمیتونم ویرایش
     کنم، باید تایید کنم و برم سرچ کنم پیدا کنم بعد ویرایش کنم.» */
  check('the review queue can edit a question', () => {
    const i = script.indexOf('async function renderQuizMaker(');
    const body = script.slice(i, i + 4000);
    assert.ok(/qmkEdit\(/.test(body), 'no edit button in the review queue');
    assert.ok(script.includes('function qmkEdit('), 'the editor is missing');
    assert.ok(script.includes('async function qmkSaveEdit('), 'nothing saves the edit');
    /* The rows on screen are what it edits, so they have to be reachable. */
    assert.ok(/window\._QMKROWS\s*=\s*rows/.test(body), 'the rows are not kept for the editor');
  });

  check('and editing does not decide the question', () => {
    const i = script.indexOf('async function qmkSaveEdit(');
    const body = script.slice(i, i + 1500);
    const calls = body.split('\n').filter((l) => /await api\(/.test(l)).join('\n');
    /* A PATCH changes what is on the form. A POST would replace the whole
       record — every field left off resets to a default, and `status` would
       reset with it, which is how «ویرایش» used to publish a pending
       question by accident. */
    assert.ok(/api\('PATCH','\/admin\/questions\/'/.test(calls), 'the save is not a PATCH');
    assert.ok(!/status:/.test(calls), 'the save still sets a status');
    /* Approving is still a decision of its own, offered beside it. */
    assert.ok(/qmkReview\(id,'approve'\)/.test(body), 'there is no way to save and approve');
  });

  check('the form refuses what the server would refuse', () => {
    const i = script.indexOf('async function qmkSaveEdit(');
    const body = script.slice(i, i + 1500);
    assert.ok(/new Set\(opts\)\.size!==4/.test(body), 'duplicate options are not caught');
    assert.ok(/opts\.some\(v=>!v\)/.test(body), 'empty options are not caught');
    assert.ok(/text\.length<8/.test(body), 'a too-short question is not caught');
  });

  /* THE OLD EDITOR HAD THE SAME FAULT. Correcting a typo on a question that
     was waiting for review published it. */
  check('the question-bank editor stopped force-approving too', () => {
    const i = script.indexOf('async function qSaveEdit(');
    /* The CALL, not the whole function — the comment above it quotes the old
       line it is there to explain, and a naive search finds that instead. */
    const body = script.slice(i, i + 1200).split('\n').filter((l) => /await api\(/.test(l)).join('\n');
    assert.ok(body, 'no request found in qSaveEdit at all');
    assert.ok(!/status:/.test(body), 'editing still sends a status: ' + body.trim().slice(0, 120));
    assert.ok(/api\('PATCH','\/admin\/questions\/'/.test(body), 'the save is not a PATCH');
  });

  /* ── SEARCH-AS-YOU-TYPE WAS TRIED AND TAKEN BACK OUT ────────────────
     «قسمت سرچ پنل رو به حالت قبل برگردون، الان نمیشه تایپ کرد، با هر حرف یه
      بار صفحه رفرش میشه.»

     It was built on `render()`, which re-fetches the section and rebuilds the
     whole page — including the toolbar the box lives in. Debounced and with
     the caret put back it survived on paper and was unusable in the hand.
     What is checked now is that the boxes work the way they did before: a
     button, or Enter. */
  check('every search box is wired to the live filter', () => {
    for (const [id, state] of [['uq', 'U_Q'], ['qsearch', 'Q_SEARCH'], ['acq', 'AC_Q']] as const) {
      const box = new RegExp('id="' + id + '"');
      assert.ok(box.test(script), 'the search box is gone: ' + id);
      const wired = new RegExp("liveSearch\\(\\{[\\s\\S]{0,200}?input:'#" + id + "'[\\s\\S]{0,400}?set:\\(v\\)=>\\{" + state + "=v;\\}");
      assert.ok(wired.test(script), 'this box is not wired to liveSearch: ' + id);
    }
  });

  /* THE RULE THE FIRST ATTEMPT BROKE. «با هر حرف یه بار صفحه رفرش میشه» — a
     box that calls render() on input destroys the very element being typed
     into, along with the caret and any half-composed Persian word. So no
     search input may reach render(), and every one of them must repaint a
     container of its own instead. */
  check('and no search box rebuilds the page as it is typed into', () => {
    for (const id of ['uq', 'qsearch', 'acq']) {
      const inputTag = new RegExp('id="' + id + '"[^>]*>');
      const tag = (inputTag.exec(script) || [''])[0];
      assert.ok(!/oninput=/.test(tag), 'the handler is inline again, where render() creeps back in: ' + id);
      assert.ok(!/onkeydown=[^>]*render\(\)/.test(tag), 'Enter rebuilds the page in ' + id);
    }
    /* liveSearch itself must never call render(): that is the whole defect. */
    const fn = /function liveSearch\(opts\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(fn, 'liveSearch is gone');
    assert.ok(!/\brender\(\)/.test(fn![0]), 'liveSearch calls render(), which is what made typing impossible');
  });

  check('each list has a container of its own to repaint', () => {
    for (const [rows, painter] of [['urows', 'uPaintRows'], ['qrows', 'qPaintRows'], ['acrows', 'acPaintRows']] as const) {
      assert.ok(script.includes('id="' + rows + '"'), 'no rows container: ' + rows);
      assert.ok(script.includes('function ' + painter + '('), 'no painter: ' + painter);
      const body = new RegExp('function ' + painter + "\\([\\s\\S]*?\\$\\('#" + rows + "'\\)");
      assert.ok(body.test(script), painter + ' does not paint ' + rows);
    }
  });

  /* «در قسمت سرچ کاربران و هر جایی که میخوای کاربر رو سرچ کنی باید بتونیم با
     شماره موبایل هم سرچ کنیم» — and a phone number is the same number however
     it was typed. */
  check('a user can be found by phone number, in any spelling', () => {
    assert.ok(script.includes('function uMatches('), 'the user matcher is gone');
    assert.ok(script.includes('function uDigits('), 'nothing normalises the digits');
    const fn = /function uDigits\(v\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(fn && /۰۱۲۳۴۵۶۷۸۹/.test(fn[0]), 'Persian digits are not folded to Latin ones');
    const m = /function uMatches\(u,q\)\{[\s\S]*?\n\}/.exec(script);
    assert.ok(m && /u\.phone/.test(m[0]), 'the phone is not searched at all');
    assert.ok(m && /slice\(-10\)/.test(m[0]), 'the country code is not allowed to differ');
    /* The wallet screen searches people too, and had the same gap. */
    assert.ok(/acPaintRows[\s\S]{0,400}uMatches\(/.test(script), 'the wallet search does not use the same rule');
  });

  /* The support queue's filter is the one that WORKS this way, and it works
     because it repaints only its own list — no fetch, no page rebuild. It is
     the shape a real live filter would have to take, and it stays. */
  check('the support queue keeps its own in-place filter', () => {
    assert.ok(/id="supq"[\s\S]{0,200}oninput="SUP_Q/.test(script), 'the support search lost its filter');
    assert.ok(/supPaintQueue\(\)/.test(script), 'it no longer repaints just its list');
  });

  /* ══ گیم‌پلی و بالانس ══════════════════════════════════════════════════
     «فارسی بکن و کامل بکن، طوری که هر تغییراتی واقعی باشه و کار کنه.»

     The balance pages were a raw JSON form: the English config key, a box, and
     nothing else. The part that mattered was invisible — most of those keys
     are not read by the server at all, so an operator could change one, be
     told «ذخیره و اعمال شد ✅», and nothing in the game would move.

     These checks hold the panel to what the SERVER actually does. The «wired»
     flags are read out of the panel and compared against the code that reads
     the config, so wiring a field up later without unmarking it here — or
     marking something live that nothing reads — fails right here. */
  const cfgFa = /const CFG_FA=\{([\s\S]*?)\n\};/.exec(script);

  /* Checked against the CONFIG ITSELF rather than a number typed here: every
     scalar the panel will draw a box for has to resolve to a Persian name. A
     key added to game-config.json next month and left unnamed fails here
     instead of appearing in the panel in English. */
  check('every balance field the panel draws has a Persian name', () => {
    assert.ok(cfgFa, 'the Persian dictionary is gone');
    const named = new Map([...cfgFa![1]!.matchAll(/'([a-zA-Z.]+)':\s*\['([^']*)'/g)].map((m) => [m[1]!, m[2]!]));
    for (const [path, label] of named) {
      assert.ok(label.trim().length > 0, 'no name for ' + path);
      assert.ok(/[آ-ی]/.test(label), 'the name for ' + path + ' is not Persian: ' + label);
    }

    let dir = process.cwd(), raw = '';
    for (let i = 0; i < 5; i++) {
      for (const rel of ['prizzequizz-api/config/game-config.json', 'config/game-config.json']) {
        const f = resolve(dir, rel);
        if (existsSync(f)) { raw = readFileSync(f, 'utf8'); break; }
      }
      if (raw) break;
      const up = dirname(dir); if (up === dir) break; dir = up;
    }
    assert.ok(raw, 'game-config.json not found');
    const cfg = JSON.parse(raw) as Record<string, any>;

    const missing = ['xp', 'level', 'cup']
      .flatMap((block) => scalarsOf(cfg[block], block))
      .filter((p) => !named.has(p));
    assert.deepEqual(missing, [], 'these are still shown in English: ' + missing.join(', '));

    /* gameplay is different: two fields are named outright and every other one
       is caught by the shadow rule, which has to actually match them. */
    const shadow = /^gameplay\.[A-Za-z]+\./;
    const unexplained = scalarsOf(cfg.gameplay, 'gameplay').filter((p) => !named.has(p) && !shadow.test(p));
    assert.deepEqual(unexplained, [], 'gameplay fields with no name and no shadow note: ' + unexplained.join(', '));
  });

  check('and the ones the server ignores say so', () => {
    const paths = [...cfgFa![1]!.matchAll(/'([a-zA-Z.]+)':\s*\['[^']*','[^']*',([01])/g)]
      .map((m) => [m[1]!, m[2] === '1'] as const);
    /* Read out of the server's own code. Every entry here names the function
       that actually reads it — if one is deleted, this list is what says the
       panel is now lying about it.

         scoringConfig.getResultBonus  → xp.perWin/perLoss/perDraw/multiplier,
                                         cup.win/loss/draw
         scoringConfig.questionPoints  → xp.perCorrect
         scoringConfig.streakBonus     → xp.combo
         scoringConfig.goldenBonusXp   → xp.golden
         scoringConfig.continueBonus   → xp.continue, cup.continue
         scoringConfig.levelForXp
           + levelSqlExpr              → level.xpPerLevelBase, level.curve
         matchEngine.payLevelUp        → level.rewardCoinsPerLevel,
                                         level.rewardTicketPerLevel
         scoringConfig.cupResetsWeekly → cup.weeklyReset
         scoringConfig.minCupToPlay    → cup.minEntry
         scoringConfig.paidMultiplier  → scoring.paidMultiplier
         matchEngine.duelRounds        → gameplay.duel.baseRounds/maxRounds

       NOT here, on purpose: xp.perMission, xp.dailyLogin, xp.perLevel and
       cup.perLeague. Their real value is edited in another tab, and a second
       editable copy of one number is how the two drift apart. */
    const WIRED = new Set(['xp.perWin', 'xp.perLoss', 'xp.perDraw', 'xp.multiplier',
                           'xp.perCorrect', 'xp.combo', 'xp.golden', 'xp.continue',
                           'cup.win', 'cup.loss', 'cup.draw',
                           'cup.continue', 'cup.weeklyReset', 'cup.minEntry',
                           'level.xpPerLevelBase', 'level.curve',
                           'level.rewardCoinsPerLevel', 'level.rewardTicketPerLevel',
                           'scoring.paidMultiplier',
                           'gameplay.duel.baseRounds', 'gameplay.duel.maxRounds']);
    for (const [path, wired] of paths) {
      assert.equal(wired, WIRED.has(path),
        wired ? path + ' is marked live but nothing reads it'
              : path + ' is marked dead but the server does read it');
    }
    for (const w of WIRED) {
      assert.ok(paths.some(([p]) => p === w), 'the one field that works is not listed: ' + w);
    }
  });

  check('a dead field is marked on its own row', () => {
    assert.ok(script.includes('هنوز وصل نیست'), 'nothing says a field is not wired');
    assert.ok(/cfgMeta\(p\)/.test(script), 'buildFields never looks the field up');
    assert.ok(script.includes("'<div class=\"cfg-row'+(m&&!m.wired?' dead':'')"), 'the row itself is not marked');
  });

  check('and the page counts how many of its settings are real', () => {
    assert.ok(/const dead=_CFG_FIELDS\.filter/.test(script), 'the header does not count the dead fields');
    assert.ok(script.includes('مورد را سرور می‌خواند'), 'the header does not say how many are live');
  });

  /* A shadow copy is worse than a missing setting: it looks like the real one.
     gameplay.duel.questionCount exists and is never read — the live value is
     modes.duel.questionCount, edited from the duel tab. */
  check('shadow gameplay fields point at where the real setting lives', () => {
    assert.ok(script.includes('CFG_FA_SHADOW={'), 'the shadow map is gone');
    for (const mode of ['duel', 'lastSurvivor']) {
      assert.ok(new RegExp(mode + ":\\['[^']*[آ-ی]").test(script), 'no Persian pointer for ' + mode);
    }
    assert.ok(script.includes('^gameplay'), 'nothing recognises a gameplay field as a shadow');
  });

  check('group headings are Persian too', () => {
    assert.ok(script.includes('CFG_FA_GROUP={'), 'the group names are gone');
    assert.ok(script.includes('CFG_FA_GROUP[k]||k'), 'buildFields does not use them');
    for (const k of ['duel', 'lastSurvivor', 'entry', 'reward']) {
      assert.ok(new RegExp(k + ":'[^']*[آ-ی]").test(script), 'no Persian name for the ' + k + ' group');
    }
  });

  /* ── «سود رو معلوم نیست چجوری حساب می‌کنه» ─────────────────────────────
     The number was right; what was missing was where it came from. A lone
     figure cannot be checked or argued with — the lines behind it can. */
  check('the dashboard shows what today’s revenue is made of', () => {
    assert.ok(script.includes('function dashRevenueCard('), 'the breakdown card is gone');
    assert.ok(/stat\('درآمدِ امروز'[\s\S]{0,120}dashRevenueCard\(d\)/.test(script),
      'the breakdown is not drawn beside the number it explains');
    for (const part of ['fees', 'lifelines', 'shop', 'penalties', 'house']) {
      assert.ok(new RegExp('p\\.' + part + '\\b').test(script), 'the ' + part + ' line is missing');
    }
    assert.ok(script.includes('p.total'), 'the card never shows the total it adds up to');
  });

  check('and says out loud that ticket money is not in it', () => {
    assert.ok(script.includes('پولِ بلیط در این عدد نیست'), 'nothing says ticket money is excluded');
    assert.ok(script.includes('p.ticketsExcluded'),
      'the excluded amount is not shown, so an operator cannot tell it was left out on purpose');
  });

console.log(`[adminPanelHtml] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
