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

  console.log(`[adminPanelHtml] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
