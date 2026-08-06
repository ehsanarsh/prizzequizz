/* THE WEBSITE.
 *
 * Two things are being protected here, and they are not the same thing.
 *
 * The first is SEO. These pages exist to be found, so the tests assert what a
 * crawler actually needs — a title, a description, ONE canonical, real content
 * in the first response, valid JSON-LD, and a sitemap that never advertises a
 * page marked noindex. Getting any of those wrong is silent: the site looks
 * perfect and simply does not rank.
 *
 * The second is that admin-authored text can never become markup. Everything
 * an operator types goes through escaping, and the article format accepts no
 * HTML at all. A CMS whose content can inject a script into its own origin is
 * a vulnerability with a nice editor attached.
 *
 * Run: npx tsx src/tests/site.test.ts */
import assert from 'node:assert/strict';
import {
  SETTINGS_DEFAULTS, SiteError, deletePage, getSettings, listPages, listPosts,
  normaliseSlug, savePage, savePost, saveSettings, _resetSiteMemory
} from '../content.js';
import { esc, faDate, renderPage, renderPost, renderRobots, renderSitemap } from '../render.js';

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log('  ✔ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + ': ' + (e as Error).message); }
}

/** Every <script type="application/ld+json"> body, parsed. */
function ldBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(JSON.parse(m[1]!));
  return out;
}
const count = (h: string, re: RegExp) => (h.match(re) || []).length;

async function run(): Promise<void> {
  _resetSiteMemory();
  /* CONCURRENTLY on purpose. This is exactly what the server does on its first
     request, and a seed that latches "done" before it has finished serves an
     empty blog to whoever arrives first after a cold start. Awaiting these one
     at a time would hide that. */
  const [pages, posts, s] = await Promise.all([listPages(), listPosts(), getSettings()]);
  assert.ok(posts.length >= 2, 'seeding lost a race: the blog came back empty');

  // ------------------------------------------------------------ the pages ----

  await check('every page the brief asked for ships, and is published', async () => {
    const want = ['home', 'download', 'about', 'privacy', 'terms', 'contact', 'faq', 'blog'];
    for (const slug of want) {
      const p = pages.find((x) => x.slug === slug);
      assert.ok(p, 'missing page: ' + slug);
      assert.ok(p!.published, slug + ' should be published');
      assert.ok(p!.blocks.length > 0, slug + ' has no content');
    }
  });

  await check('both articles ship with a body long enough to rank', async () => {
    assert.ok(posts.length >= 2, 'expected at least two articles');
    for (const p of posts) {
      /* A three-line article does not rank for anything. */
      assert.ok(p.body.length > 900, p.slug + ' is too thin: ' + p.body.length + ' chars');
      assert.ok(p.excerpt.length > 40, p.slug + ' needs a real excerpt');
      assert.ok(p.seoTitle && p.seoDescription, p.slug + ' is missing its SEO fields');
    }
  });

  // -------------------------------------------------------------- the head ----

  await check('a page renders one canonical, one title and a description', async () => {
    const home = pages.find((p) => p.slug === 'home')!;
    const html = renderPage(home, pages, s, posts);
    assert.equal(count(html, /<link rel="canonical"/g), 1, 'exactly one canonical or none is right');
    assert.equal(count(html, /<title>/g), 1);
    assert.ok(/<meta name="description" content=".{40,}?">/.test(html), 'description missing or too short');
    assert.ok(html.includes(`<link rel="canonical" href="${s.baseUrl}/">`), 'home canonical should be the bare origin');
    assert.ok(html.includes('lang="fa"') && html.includes('dir="rtl"'), 'a Persian page must say so');
  });

  await check('social cards carry an absolute image URL, not a relative one', async () => {
    /* A relative og:image is simply dropped by every crawler that matters. */
    const home = pages.find((p) => p.slug === 'home')!;
    const html = renderPage(home, pages, s, posts);
    const m = /<meta property="og:image" content="([^"]+)">/.exec(html);
    assert.ok(m, 'og:image should be present when a default image is set');
    assert.ok(/^https?:\/\//.test(m![1]!), 'og:image must be absolute, got: ' + m![1]);
  });

  await check('an article is marked as an article, with real Article JSON-LD', async () => {
    const post = posts[0]!;
    const html = renderPost(post, pages, s, posts);
    assert.ok(html.includes('<meta property="og:type" content="article">'));
    const ld = ldBlocks(html);
    const article = ld.find((x) => x['@type'] === 'Article');
    assert.ok(article, 'no Article JSON-LD');
    assert.equal(article.headline, post.title);
    assert.ok(article.datePublished && article.dateModified);
    assert.ok(article.publisher && article.publisher.name, 'Article needs a publisher');
    assert.equal(article.mainEntityOfPage['@id'], `${s.baseUrl}/blog/${post.slug}`);
    const crumbs = ld.find((x) => x['@type'] === 'BreadcrumbList');
    assert.ok(crumbs && crumbs.itemListElement.length === 3, 'article needs home › blog › post');
  });

  await check('a page with an FAQ block emits FAQPage structured data', async () => {
    /* This is what earns the expandable answers in the results page — it is the
       single highest-value piece of markup on the whole site. */
    const faq = pages.find((p) => p.slug === 'faq')!;
    const ld = ldBlocks(renderPage(faq, pages, s, posts));
    const f = ld.find((x) => x['@type'] === 'FAQPage');
    assert.ok(f, 'no FAQPage on the FAQ page');
    assert.ok(f.mainEntity.length >= 6, 'expected a real set of questions');
    for (const q of f.mainEntity) {
      assert.equal(q['@type'], 'Question');
      assert.ok(q.name && q.acceptedAnswer.text, 'a question without an answer is invalid markup');
    }
  });

  await check('JSON-LD is valid JSON with no unescaped script terminator', async () => {
    for (const p of pages) {
      for (const raw of renderPage(p, pages, s, posts).match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || []) {
        const body = raw.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
        JSON.parse(body);                               // throws on malformed
        assert.ok(!body.includes('</'), 'a raw </ inside JSON-LD can close the script early');
      }
    }
  });

  await check('the home page names the site to search engines', async () => {
    const ld = ldBlocks(renderPage(pages.find((p) => p.slug === 'home')!, pages, s, posts));
    assert.ok(ld.find((x) => x['@type'] === 'Organization'), 'no Organization');
    assert.ok(ld.find((x) => x['@type'] === 'WebSite'), 'no WebSite');
  });

  // ------------------------------------------------------------- crawlable ----

  await check('the content is in the HTML, not fetched by a script', async () => {
    /* The entire reason this is server-rendered. If the copy is not in the
       first response, a crawler may never see it. */
    const about = pages.find((p) => p.slug === 'about')!;
    const html = renderPage(about, pages, s, posts);
    const firstBlockText = about.blocks.find((b) => b.kind === 'text')!.body!.split('\n')[0]!;
    assert.ok(html.includes(esc(firstBlockText)), 'body copy is missing from the HTML');
    assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(html), 'the page should ship no executable script');
  });

  await check('the blog index lists the articles as real links', async () => {
    const blog = pages.find((p) => p.slug === 'blog')!;
    const html = renderPage(blog, pages, s, posts);
    for (const p of posts) {
      assert.ok(html.includes(`href="/blog/${p.slug}"`), 'missing link to ' + p.slug);
      assert.ok(html.includes(esc(p.title)));
    }
  });

  await check('an article body turns ## into headings and - into a list', async () => {
    const html = renderPost(posts[0]!, pages, s, posts);
    assert.ok(/<h2>/.test(html), 'no headings rendered');
    assert.ok(/<ul>[\s\S]*<li>/.test(html), 'no list rendered');
  });

  // -------------------------------------------------------------- sitemap ----

  await check('the sitemap lists every published page and post, once', async () => {
    const xml = renderSitemap(pages, posts, s);
    for (const p of pages) {
      const loc = `${s.baseUrl}${p.slug === 'home' ? '/' : '/' + p.slug}`;
      assert.equal(count(xml, new RegExp('<loc>' + loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</loc>', 'g')), 1, 'bad entry for ' + p.slug);
    }
    for (const p of posts) assert.ok(xml.includes(`${s.baseUrl}/blog/${p.slug}`));
    assert.ok(xml.startsWith('<?xml'), 'a sitemap must be XML');
  });

  await check('a noindex page is kept OUT of the sitemap', async () => {
    /* Advertising a page you then tell robots to ignore is a contradiction
       search engines report as an error. */
    await savePage({ slug: 'hidden-test', title: 'مخفی', noindex: true, blocks: [] });
    const all = await listPages();
    const xml = renderSitemap(all, posts, s);
    assert.ok(!xml.includes('/hidden-test'), 'noindex page leaked into the sitemap');
    const html = renderPage(all.find((p) => p.slug === 'hidden-test')!, all, s, posts);
    assert.ok(html.includes('content="noindex,nofollow"'));
    await deletePage('hidden-test');
  });

  await check('an unpublished page is not served and not advertised', async () => {
    await savePage({ slug: 'draft-test', title: 'پیش‌نویس', published: false, blocks: [] });
    const live = await listPages();
    assert.ok(!live.some((p) => p.slug === 'draft-test'), 'a draft should not be public');
    assert.ok(!renderSitemap(live, posts, s).includes('/draft-test'));
    assert.ok((await listPages(true)).some((p) => p.slug === 'draft-test'), 'but the panel must still see it');
    await deletePage('draft-test');
  });

  await check('robots.txt points at the sitemap and keeps crawlers out of the app', async () => {
    const txt = renderRobots(s);
    assert.ok(txt.includes(`Sitemap: ${s.baseUrl}/sitemap.xml`));
    assert.ok(txt.includes('Disallow: /v1/'), 'the API is not content');
    assert.ok(txt.includes('Disallow: /pzadmin.html'));
    assert.ok(txt.includes(`Disallow: ${s.playUrl}`), 'the game is behind a login; crawling it earns nothing');
  });

  // ------------------------------------------------------------- injection ----

  await check('a page block cannot inject markup', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    await savePage({
      slug: 'xss-test', title: evil, blocks: [
        { kind: 'text', title: evil, body: evil },
        { kind: 'faq', items: [{ q: evil, a: evil }] },
        { kind: 'hero', title: evil, ctaText: evil, ctaHref: 'javascript:alert(1)' }
      ]
    });
    const all = await listPages();
    const html = renderPage(all.find((p) => p.slug === 'xss-test')!, all, s, posts);
    /* The payload still appears as VISIBLE TEXT — inside <title>, inside a
       <meta content="…">, in the body copy. That is exactly what escaping is
       for, and none of it executes. Searching for the string "onerror=" would
       therefore find it and prove nothing.
       There are only two ways admin text becomes markup, and both are tested:
       a raw '<' opening a new tag, and a raw '"' closing an attribute early. */
    assert.ok(!html.includes('<img src=x'), 'a raw < opened a real tag');
    assert.ok(html.includes('&lt;img src=x'), 'it should appear as visible text instead');
    /* A javascript: URL is the one thing escaping cannot defuse, because no
       character in it needs escaping. It has to be rejected by scheme. */
    assert.ok(!html.includes('href="javascript:'), 'a javascript: URL survived into an href');
    await deletePage('xss-test');
  });

  await check('a quote in admin text cannot break out of an attribute', async () => {
    /* The other half of injection: '" onerror=x' needs no '<' at all — it just
       closes the attribute it is sitting in. og:title and the nav label put
       admin text straight into attributes, so this is the case to prove. */
    const quoted = '" onmouseover="alert(1)';
    await savePage({ slug: 'quote-test', title: quoted, navLabel: quoted, seoTitle: quoted, blocks: [] });
    const all = await listPages();
    const html = renderPage(all.find((p) => p.slug === 'quote-test')!, all, s, posts);
    /* The payload appears escaped in attributes and JSON-escaped inside the
       JSON-LD, so searching for "onmouseover" finds it either way and proves
       nothing. What must not exist is the break-out sequence with a RAW quote,
       which is the only form that would end the attribute and start a handler. */
    assert.ok(!html.includes('" onmouseover="'), 'a raw quote escaped its attribute');
    assert.ok(html.includes('&quot;'), 'the quote should be escaped, not dropped');
    await deletePage('quote-test');
  });

  await check('only safe URL schemes reach an href', async () => {
    await savePage({ slug: 'href-test', title: 'x', blocks: [
      { kind: 'cta', title: 'a', ctaText: 'go', ctaHref: 'javascript:alert(1)' },
      { kind: 'hero', title: 'b', ctaText: 'ok', ctaHref: '/download', ctaText2: 'mail', ctaHref2: 'mailto:a@b.ir' }
    ] });
    const all = await listPages();
    const html = renderPage(all.find((p) => p.slug === 'href-test')!, all, s, posts);
    assert.ok(!/href="javascript:/i.test(html), 'javascript: must be rejected');
    assert.ok(!/href="data:/i.test(html), 'data: must be rejected');
    assert.ok(html.includes('href="/download"'), 'a relative path is fine');
    assert.ok(html.includes('href="mailto:a@b.ir"'), 'mailto is fine');
    await deletePage('href-test');
  });

  await check('an article body cannot inject markup either', async () => {
    await savePost({ slug: 'xss-post', title: 'x', body: '## <script>alert(1)</script>\n- <b>bold</b>' });
    const post = (await listPosts()).find((p) => p.slug === 'xss-post')!;
    const html = renderPost(post, pages, s, posts);
    assert.ok(!html.includes('<script>alert(1)'), 'a script tag survived the article body');
    assert.ok(!html.includes('<b>bold</b>'), 'raw HTML survived a list item');
    assert.ok(html.includes('&lt;script&gt;'), 'it should be shown as text');
  });

  await check('JSON-LD cannot be broken out of by the title', async () => {
    await savePost({ slug: 'ld-test', title: '</script><script>alert(1)</script>', body: 'x' });
    const post = (await listPosts()).find((p) => p.slug === 'ld-test')!;
    const html = renderPost(post, pages, s, posts);
    const blocks = ldBlocks(html);
    assert.ok(blocks.length >= 1, 'JSON-LD should still parse');
    assert.ok(!/<script>alert\(1\)<\/script>\s*<\/head>/.test(html), 'broke out of the JSON-LD block');
  });

  // ------------------------------------------------------------ the model ----

  await check('slugs are forced into a shape that survives a URL', async () => {
    assert.equal(normaliseSlug('  Hello World  '), 'hello-world');
    assert.equal(normaliseSlug('a//b??c'), 'abc');
    assert.equal(normaliseSlug('--x--'), 'x');
    /* A Persian slug percent-encodes into something nobody can read or share. */
    assert.equal(normaliseSlug('درباره ما'), '');
    await assert.rejects(() => savePage({ slug: 'سلام', title: 'x' }),
      (e: any) => e instanceof SiteError && e.code === 'SLUG_REQUIRED');
  });

  await check('the pages the site cannot work without are protected', async () => {
    for (const slug of ['home', 'blog']) {
      await assert.rejects(() => deletePage(slug),
        (e: any) => e instanceof SiteError && e.code === 'PAGE_PROTECTED');
    }
  });

  await check('an unknown block kind is dropped rather than rendered', async () => {
    await savePage({ slug: 'blk-test', title: 'x', blocks: [{ kind: 'evil' } as any, { kind: 'text', body: 'ok' }] });
    const p = (await listPages()).find((x) => x.slug === 'blk-test')!;
    assert.equal(p.blocks.length, 1);
    assert.equal(p.blocks[0]!.kind, 'text');
    await deletePage('blk-test');
  });

  await check('a trailing slash on the site URL cannot double up in canonicals', async () => {
    const saved = await saveSettings({ baseUrl: 'https://example.ir/' });
    assert.equal(saved.baseUrl, 'https://example.ir');
    const html = renderPage(pages.find((p) => p.slug === 'about')!, pages, saved, posts);
    assert.ok(html.includes('href="https://example.ir/about"'));
    assert.ok(!html.includes('example.ir//'), 'double slash makes it a different URL');
    await saveSettings({ baseUrl: SETTINGS_DEFAULTS.baseUrl });
  });

  await check('{play} resolves to wherever the game actually lives', async () => {
    const custom = await saveSettings({ playUrl: '/game-here' });
    const html = renderPage(pages.find((p) => p.slug === 'home')!, pages, custom, posts);
    assert.ok(html.includes('href="/game-here"'), 'the placeholder was not resolved');
    assert.ok(!html.includes('{play}'), 'the placeholder leaked to the page');
    await saveSettings({ playUrl: SETTINGS_DEFAULTS.playUrl });
  });

  await check('dates render as Jalali, in Tehran', async () => {
    /* Nowruz 1405 falls on 21 March 2026. 1404 is not a leap year, so its
       Esfand has 29 days — the last day of the year is 29 Esfand, not 30.
       21:00 UTC on the 20th is already past midnight in Tehran, so it must roll
       into the new YEAR: the case a UTC-based conversion gets wrong. */
    assert.equal(faDate('2026-03-21T09:00:00Z'), '۱ فروردین ۱۴۰۵');
    assert.equal(faDate('2026-03-20T21:00:00Z'), '۱ فروردین ۱۴۰۵');
    assert.equal(faDate('2026-03-20T09:00:00Z'), '۲۹ اسفند ۱۴۰۴');
    /* And a leap year really does reach 30 Esfand: 1403 is one. */
    assert.equal(faDate('2025-03-20T09:00:00Z'), '۳۰ اسفند ۱۴۰۳');
    assert.equal(faDate('not a date'), '');
  });

  console.log(`[site] ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
