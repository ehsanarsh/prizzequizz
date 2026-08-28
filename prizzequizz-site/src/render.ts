/* THE PUBLIC WEBSITE — rendering.
 *
 * Plain server-rendered HTML, on purpose. The whole point of these pages is to
 * be found, and a crawler that has to run JavaScript to see your content is a
 * crawler that may not bother. Every page here is complete in its first
 * response: no hydration, no client router, no framework.
 *
 * The look follows the game — the same gold, the same heavy black strokes and
 * hard shadows — so someone arriving from a search result and then opening the
 * game does not feel handed off to a different company.
 *
 * ESCAPING. Everything an admin types is escaped and rendered as text; a page
 * block cannot introduce markup. The two deliberate exceptions are the eNamad
 * badge and the search-console verification tag, which only exist as snippets
 * to paste — those are documented at their admin route and are owner-only.
 */
import type { SiteBlock, SitePage, SitePost, SiteSettings } from './content.js';
import { faNum, type LeaderRow, type LiveStats, type WinnerRow } from './live.js';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
/** For text that goes inside a JSON-LD <script>. */
function jsonLd(o: unknown): string {
  return JSON.stringify(o).replace(/</g, '\\u003c');
}
const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
export function fa(n: number | string): string {
  return String(n).replace(/\d/g, (d) => FA_DIGITS[Number(d)]!);
}
/** Gregorian → Persian (Jalali). Dates on a Persian site should be Persian. */
export function faDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  /* Tehran, so an article published at 22:00 does not show yesterday's date. */
  const t = new Date(d.getTime() + 3.5 * 3600_000);
  const gy = t.getUTCFullYear(), gm = t.getUTCMonth() + 1, gd = t.getUTCDate();
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) + gd + g_d_m[gm - 1]!;
  let jy = -1595 + 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  const months = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
                  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  return `${fa(jd)} ${months[jm - 1]} ${fa(jy)}`;
}

/** `{play}` in an admin-entered link means "wherever the game lives", so the
 *  URL can be changed in one place instead of on every button.
 *
 *  The scheme is then checked against an allowlist. Escaping alone does not
 *  save you here: `href="javascript:…"` contains no character escaping touches,
 *  so a link is the one place admin-entered text can still execute. Only
 *  relative paths, anchors, http(s), mailto and tel survive; anything else
 *  becomes an inert '#'. */
/* The site's home is not necessarily '/': the game owns the root, so by default
 * the home page lives at '/home'. Every «خانه» link, breadcrumb, canonical and
 * sitemap entry goes through here, so the button and the canonical can never
 * point at different pages — which is what made the home link open the game
 * while the sitemap told Google the game WAS the home page. */
export function homeUrl(s: SiteSettings): string { return s.homePath || '/home'; }
function pageUrl(slug: string, s: SiteSettings): string { return slug === 'home' ? homeUrl(s) : '/' + slug; }

const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;
function href(raw: string, s: SiteSettings): string {
  const v = String(raw ?? '').trim().replace('{play}', s.playUrl || '/play');
  if (!v) return '#';
  if (v.startsWith('/') || v.startsWith('#')) return v;
  if (SAFE_SCHEME.test(v)) return v;
  return '#';
}

// ------------------------------------------------------------------ style ----

/* THE STYLESHEET IS A FILE NOW.
 * It used to be inlined into every page — no extra request, but the same 12KB
 * re-sent with each of the ten pages and again on every edit to any of them.
 * Linked, it is fetched once and served from cache for the rest of the visit,
 * and a change to the design no longer rewrites every page's HTML. The pages
 * are still complete in their first response: nothing here waits on script. */
const STYLE_HREF = '/site-assets/pq.css';

/* THE FONT.
 *
 * The design system asks for Vazirmatn and nothing was loading it, so every
 * page fell through the stack to Tahoma — which is why the site looked like a
 * different site from the one that was designed.
 *
 * Self-hosted, not Google Fonts: the audience is in Iran, where fonts.gstatic
 * is unreliable and often simply does not resolve. A stylesheet that half the
 * visitors cannot fetch is a worse dependency than 108KB served from the same
 * origin as the page.
 *
 * ONE variable file covers 100–900. The design leans on 600/700/800/900 for
 * headings, buttons and numbers, and three static cuts would have cost more
 * bytes than the variable one does.
 *
 * `font-display:swap` so the words are readable while it arrives, and a
 * preload so the swap happens almost immediately rather than after the
 * stylesheet has been parsed and the font discovered. */
const FONT_HREF = '/site-assets/vazirmatn.woff2';
const FONT_CSS = `@font-face{font-family:'Vazirmatn';src:url('${FONT_HREF}') format('woff2');`
  + `font-weight:100 900;font-style:normal;font-display:swap;}`;

/* Artwork the design ships with, by bare name; anything the operator uploaded
 * arrives as a /media/ URL and is passed through untouched. */
function assetUrl(name: string): string {
  const v = String(name ?? '').trim();
  if (!v) return '';
  if (v.startsWith('/') || /^https?:/i.test(v)) return v;
  if (!/^[a-zA-Z0-9._-]+$/.test(v)) return '';
  return '/site-assets/' + v;
}

/* THE LOGO, in one place.
 *
 * It used to be `assetUrl(s.ogImage.startsWith('/media/') ? '' : 'logo.png')`,
 * which tied the header's logo to whether the social-share image happened to be
 * an upload — two unrelated things. On any install where the operator had
 * uploaded an OG image the header simply had no logo, which is what «اصلا
 * لوگوی بازی وجود نداره» was.
 *
 * `onerror` is not decoration either: the real logo lives in the picture
 * library, and a URL into a library is a thing that can be deleted. The shipped
 * mark is always on disk, so a missing upload costs a nicer logo rather than
 * leaving a broken-image icon in the header of every page. */
const FALLBACK_LOGO = '/site-assets/logo.png';
function logoImg(s: SiteSettings, style: string, cls = ''): string {
  const src = assetUrl(s.logoUrl || 'logo.png') || FALLBACK_LOGO;
  const onerr = src === FALLBACK_LOGO ? ''
    : ` onerror="this.onerror=null;this.src='${FALLBACK_LOGO}'"`;
  return `<img${cls ? ` class="${esc(cls)}"` : ''} src="${esc(src)}" alt="${esc(s.siteName)}"`
    + `${style ? ` style="${style}"` : ''}${onerr}>`;
}

function head(o: {
  title: string; description: string; keywords: string; canonical: string;
  ogImage: string; noindex: boolean; s: SiteSettings; ldJson: string[]; type?: string;
}): string {
  const img = o.ogImage || o.s.ogImage || '';
  const abs = img && !/^https?:/i.test(img) ? o.s.baseUrl + img : img;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
${o.keywords ? `<meta name="keywords" content="${esc(o.keywords)}">` : ''}
<meta name="robots" content="${o.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large'}">
<link rel="canonical" href="${esc(o.canonical)}">
<meta property="og:site_name" content="${esc(o.s.siteName)}">
<meta property="og:type" content="${esc(o.type || 'website')}">
<meta property="og:locale" content="fa_IR">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(o.canonical)}">
${abs ? `<meta property="og:image" content="${esc(abs)}">` : ''}
<meta name="twitter:card" content="${abs ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
${abs ? `<meta name="twitter:image" content="${esc(abs)}">` : ''}
<meta name="theme-color" content="#0E0C14">
${o.s.googleVerification /* raw: a verification tag pasted from Search Console */ || ''}
<link rel="preload" href="${FONT_HREF}" as="font" type="font/woff2" crossorigin>
<style>${FONT_CSS}</style>
<link rel="stylesheet" href="${STYLE_HREF}">
${o.ldJson.map((j) => `<script type="application/ld+json">${j}</script>`).join('\n')}`;
}

/* ── THE HEADER ─────────────────────────────────────────────────────────
   Menu items are the pages that ask to be in the menu, in the order the panel
   gives them — the same list as before, in the redesign's shell. The logo is
   the shipped mark unless the operator uploaded one. */
function nav(pages: SitePage[], current: string, s: SiteSettings): string {
  const items = pages
    .filter((p) => p.showInNav && p.published)
    .map((p) => {
      const url = pageUrl(p.slug, s);
      const cur = p.slug === current ? ' aria-current="page"' : '';
      return `<li><a href="${esc(url)}" data-nav="${esc(p.slug)}"${cur}>${esc(p.navLabel || p.title)}</a></li>`;
    }).join('');
  return `<header class="site-header"><nav class="nav" aria-label="منوی اصلی">
  <a class="logo" href="${esc(homeUrl(s))}">${logoImg(s, '')}<span>${esc(s.siteName)}</span></a>
  <span class="rule"></span>
  <ul class="nav-links">${items}</ul>
  <div class="nav-cta">
    ${s.ctaLogin ? `<a class="btn-outline" href="${esc(href(s.loginUrl || s.playUrl, s))}">${esc(s.ctaLogin)}</a>` : ''}
    <a class="btn btn-primary btn-sm" href="${esc(href(s.playUrl, s))}">${esc(s.ctaPlay || 'بازی کن')}</a>
  </div>
</nav></header>`;
}

/* ── THE FOOTER ─────────────────────────────────────────────────────────
   The columns are the operator's, not the template's. The old footer decided
   for itself which pages were «قوانین» by matching two slugs — so a third
   legal page was invisible and a renamed one vanished. Whatever is in the
   panel is what is drawn; an empty list draws no columns at all. */
function footer(pages: SitePage[], s: SiteSettings): string {
  void pages;
  const columns = (s.footerColumns ?? []).filter((c) => c && c.title && (c.links ?? []).length)
    .map((c) => `<div><h4>${esc(c.title)}</h4><ul>${
      c.links.filter((l) => l && l.label && l.href)
        .map((l) => `<li><a href="${esc(href(l.href, s))}">${esc(l.label)}</a></li>`).join('')
    }</ul></div>`).join('');
  const social = [
    s.telegram && `<a href="${esc(s.telegram)}" rel="noopener">تلگرام</a>`,
    s.instagram && `<a href="${esc(s.instagram)}" rel="noopener">اینستاگرام</a>`,
    s.twitter && `<a href="${esc(s.twitter)}" rel="noopener">ایکس</a>`
  ].filter(Boolean).join(' · ');

  return `<footer class="site-footer"><div class="wrap">
  <div class="fgrid">
    <div>
      <div class="brand">${logoImg(s, '')}<span>${esc(s.siteName)}</span></div>
      <p>${esc(s.footerAbout || s.tagline)}</p>
      ${social ? `<p style="margin-top:10px">${social}</p>` : ''}
      ${s.email ? `<p style="margin-top:10px"><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></p>` : ''}
      ${s.enamadHtml ? `<div class="badges">${s.enamadHtml /* raw: the eNamad badge snippet */}</div>` : ''}
    </div>
    ${columns}
  </div>
  <div class="fbot"><span>${esc(s.copyright || s.siteName)}</span><span>${esc(s.footerNote)}</span></div>
</div></footer>`;
}

function paragraphs(body: string): string {
  return String(body ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => `<p>${esc(l)}</p>`).join('');
}

/* ── ONE BLOCK ──────────────────────────────────────────────────────────
   Eleven shapes, and not one of them takes markup from the operator: a title
   is a title, a list is a list. That is what makes the panel safe to hand to
   somebody who is not going to think about escaping — and it is why the body
   of a text block is split on newlines into paragraphs rather than accepting
   a <p>. */
function chips(tags?: string[]): string {
  const t = (tags ?? []).filter(Boolean);
  return t.length ? `<div class="chips">${t.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : '';
}
function charImg(name: string | undefined, width: number): string {
  const u = assetUrl(name || '');
  return u ? `<img src="${esc(u)}" alt="" style="width:${width}px;flex:0 0 auto">` : '';
}

function block(b: SiteBlock, s: SiteSettings): string {
  const items = b.items ?? [];
  switch (b.kind) {
    /* The page hero is drawn by the page, not by a block — but a hero block
       left over from the old site still has to render rather than vanish. */
    case 'hero':
      return `<section class="band tight"><div class="wrap">
        <h2>${esc(b.title)}</h2>
        ${b.subtitle ? `<p class="lead">${esc(b.subtitle)}</p>` : ''}
        ${(b.ctaText || b.ctaText2) ? `<div class="btn-row">
          ${b.ctaText ? `<a class="btn btn-primary" href="${esc(href(b.ctaHref || '', s))}">${esc(b.ctaText)}</a>` : ''}
          ${b.ctaText2 ? `<a class="btn btn-ghost" href="${esc(href(b.ctaHref2 || '', s))}">${esc(b.ctaText2)}</a>` : ''}
        </div>` : ''}
      </div></section>`;

    case 'heading':
      return `<h2 id="${esc(b.anchor || '')}">${esc(b.title)}</h2>`;

    case 'text':
      return `${b.title ? `<h2 id="${esc(b.anchor || '')}">${esc(b.title)}</h2>` : ''}${paragraphs(b.body || '')}`;

    case 'list':
      return `${b.title ? `<h2 id="${esc(b.anchor || '')}">${esc(b.title)}</h2>` : ''}
        <ul>${items.map((i2) => `<li>${esc(i2.text || i2.title || '')}</li>`).join('')}</ul>`;

    case 'cards': {
      /* The column count follows the card count. Four cards in a three-column
         grid leaves one on a row of its own with a hole beside it, which reads
         as a layout bug rather than a choice — and four mode cards is the
         shape the home page actually ships with. */
      const cols = items.length % 4 === 0 ? 'g4' : (items.length % 3 === 0 ? 'g3' : (items.length === 2 ? 'g2' : 'g3'));
      return `${b.title ? `<h2 id="${esc(b.anchor || '')}">${esc(b.title)}</h2>` : ''}
        <div class="grid ${cols}" style="margin:22px 0 34px">${items.map((i2) => {
          const hi = i2.highlight ? ';background:var(--yellow-tint);border-color:rgba(242,183,5,.3)' : '';
          return `<div class="card" style="padding:22px${hi}">
            ${i2.character ? `<div style="display:flex;align-items:flex-end;height:104px">${charImg(i2.character, 82)}</div>` : ''}
            ${i2.icon ? `<div class="ico">${esc(i2.icon)}</div>` : ''}
            <h3>${esc(i2.title)}</h3><p>${esc(i2.text)}</p>${chips(i2.tags)}</div>`;
        }).join('')}</div>`;
    }

    case 'tiles':
      return `${b.title ? `<h2 id="${esc(b.anchor || '')}">${esc(b.title)}</h2>` : ''}
        <div class="tiles">${items.map((i2) => {
          const inner = `<span style="font-size:19px">${esc(i2.icon || '')}</span><b>${esc(i2.title || i2.text || '')}</b>${i2.meta ? `<small>${esc(i2.meta)}</small>` : ''}`;
          /* A tile with nowhere to go is still a tile — it just is not a link,
             rather than being a link to '#'. */
          return i2.href ? `<a class="tile" href="${esc(href(i2.href, s))}">${inner}</a>` : `<span class="tile">${inner}</span>`;
        }).join('')}</div>`;

    case 'steps':
      return `${b.title ? `<h2 id="${esc(b.anchor || '')}">${esc(b.title)}</h2>` : ''}
        <div class="steps" style="margin:26px 0 34px">${items.map((i2, n) => `<div class="step">
          <span class="n">${esc(fa(n + 1))}</span><h3>${esc(i2.title)}</h3><p>${esc(i2.text)}</p></div>`).join('')}</div>`;

    case 'faq':
      return `${b.title ? `<h2 id="${esc(b.anchor || '')}">${esc(b.title)}</h2>` : ''}
        ${items.map((i2) => `<details class="faq"${i2.open ? ' open' : ''}><summary>${esc(i2.q)}</summary>
          <div class="a">${esc(i2.a)}</div></details>`).join('')}`;

    case 'callout':
      return `<div class="callout">${charImg(b.character, 74)}
        <div><b>${esc(b.title)}</b><p>${esc(b.body || b.subtitle || '')}</p></div></div>`;

    case 'stats':
      return `<div class="stat-row" style="margin:22px 0 30px">${items.map((i2) =>
        `<div><b>${esc(i2.value)}</b><span>${esc(i2.title || i2.text || '')}</span></div>`).join('')}</div>`;

    case 'cta':
      return ctaBand({ title: b.title || '', subtitle: b.body || b.subtitle || '',
        label: b.ctaText || '', hrefRaw: b.ctaHref || '', character: b.character,
        label2: b.ctaText2 || '', href2: b.ctaHref2 || '' }, s);

    default:
      return '';
  }
}

/* The dark band that closes a page. Used by a `cta` block and by the page's
   own closing band, so the two can never drift apart. */
function ctaBand(o: { title: string; subtitle?: string; label: string; hrefRaw: string;
                      character?: string; label2?: string; href2?: string }, s: SiteSettings): string {
  if (!o.title && !o.label) return '';
  const img = assetUrl(o.character || '');
  return `<section class="band tight"><div class="wrap"><div class="cta-band"><div class="in">
    <div>
      <h2>${esc(o.title)}</h2>
      ${o.subtitle ? `<p>${esc(o.subtitle)}</p>` : ''}
      ${(o.label || o.label2) ? `<div class="btn-row">
        ${o.label ? `<a class="btn btn-ink" href="${esc(href(o.hrefRaw, s))}">${esc(o.label)}</a>` : ''}
        ${o.label2 ? `<a class="btn btn-ghost" href="${esc(href(o.href2 || '', s))}">${esc(o.label2)}</a>` : ''}
      </div>` : ''}
    </div>
    ${img ? `<img src="${esc(img)}" alt="">` : ''}
  </div></div></div></section>`;
}

function shell(o: { headHtml: string; body: string }): string {
  return `<!doctype html><html lang="fa" dir="rtl"><head>${o.headHtml}</head><body>
<a class="skip" href="#main">رفتن به محتوا</a>${o.body}</body></html>`;
}

// ------------------------------------------------------------------ pages ----

function orgLd(s: SiteSettings): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'Organization',
    name: s.siteName, url: s.baseUrl,
    ...(s.ogImage ? { logo: s.baseUrl + s.ogImage } : {}),
    ...(s.email ? { email: s.email } : {}),
    sameAs: [s.telegram, s.instagram, s.twitter].filter(Boolean)
  };
}

/** FAQ blocks become a real FAQPage, which is what earns the expandable
 *  answers directly in the results page. */
function faqLd(blocks: SiteBlock[]): Record<string, unknown> | null {
  const qs = blocks.filter((b) => b.kind === 'faq').flatMap((b) => b.items ?? [])
    .filter((i) => i.q && i.a);
  if (!qs.length) return null;
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: qs.map((i) => ({
      '@type': 'Question', name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a }
    }))
  };
}

function crumbLd(s: SiteSettings, trail: Array<{ name: string; url: string }>): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem', position: i + 1, name: t.name, item: s.baseUrl + t.url
    }))
  };
}

export interface LiveData {
  leaderboard: LeaderRow[] | null; winners: WinnerRow[] | null; stats: LiveStats | null;
}
const NO_LIVE: LiveData = { leaderboard: null, winners: null, stats: null };

export function renderPage(page: SitePage, pages: SitePage[], s: SiteSettings, posts: SitePost[] = [], live: LiveData = NO_LIVE): string {
  const url = pageUrl(page.slug, s);
  const canonical = s.baseUrl + url;
  const ld: string[] = [];
  if (page.slug === 'home') {
    ld.push(jsonLd(orgLd(s)));
    ld.push(jsonLd({
      '@context': 'https://schema.org', '@type': 'WebSite',
      name: s.siteName, url: s.baseUrl,
      potentialAction: { '@type': 'SearchAction', target: `${s.baseUrl}/blog?q={search_term_string}`, 'query-input': 'required name=search_term_string' }
    }));
  } else {
    ld.push(jsonLd(crumbLd(s, [{ name: 'خانه', url: homeUrl(s) }, { name: page.title, url }])));
  }
  const f = faqLd(page.blocks);
  if (f) ld.push(jsonLd(f));

  /* The blog index is a page like any other, plus the list of articles. */
  const list = page.slug === 'blog' ? renderPostList(posts, s) : '';

  return shell({
    headHtml: head({
      title: page.seoTitle || `${page.title} | ${s.siteName}`,
      description: page.seoDescription || s.description,
      keywords: page.seoKeywords || s.keywords,
      canonical, ogImage: page.ogImage, noindex: page.noindex, s, ldJson: ld
    }),
    body: `${nav(pages, page.slug, s)}<main id="main">${pageHero(page, pages, s, live)}${
      page.slug === 'home' ? ticker(live, s) + statRow(live, s) : ''
    }${pageBody(page, s, list)}${
      ctaBand({ title: page.cta?.title ?? '', subtitle: page.cta?.subtitle, label: page.cta?.label ?? '',
                hrefRaw: page.cta?.href ?? '', character: page.cta?.character }, s)
    }</main>${footer(pages, s)}`
  });
}

/* ── THE GAME'S OWN NUMBERS, IN THE DESIGN'S PANELS ─────────────────────
 *
 * These are the blocks the design drew and the site could not fill: the
 * leaderboard, who just won, how busy the game is. They read the live
 * database (see live.ts) and they follow one rule without exception —
 *
 *   NO DATA MEANS NO BLOCK.
 *
 * Not a zero, not «به‌زودی», not a plausible-looking example row. A public page
 * that shows invented winners is lying about a real product to real people, and
 * the placeholder always outlives the intention to replace it. An empty
 * leaderboard renders nothing at all and the hero quietly falls back to the
 * character illustration, which is a design the page already has.
 */
function leaderPanel(rows: LeaderRow[] | null, s: SiteSettings): string {
  if (!rows || rows.length < 3) return '';   // one or two names is not a board
  return `<div class="panel">
    <div class="panel-h"><span>${esc(s.liveLeaderTitle)}</span><span style="font-size:11px;color:var(--muted)">${esc(s.liveLeaderPeriod)}</span></div>
    <div class="lb">${rows.map((r) => `<div class="row${r.rank === 1 ? ' first' : ''}">
        <span>${esc(fa(r.rank))}</span><span>${esc(r.name)}</span><span class="n">${esc(faNum(r.score))}</span>
      </div>`).join('')}</div>
  </div>`;
}

/* The dark tile beside the board. The design put a prize countdown here; the
 * honest version of it is the thing the site can actually know — how many
 * players are on this week's board and how many matches ran today. */
function pulsePanel(st: LiveStats | null, s: SiteSettings): string {
  if (!st || st.matchesToday <= 0) return '';
  return `<div class="dark"><div class="in">
    <div class="cap">${esc(s.livePulseLabel)}</div>
    <div class="big">${esc(faNum(st.matchesToday))}</div>
    <div class="sub">${esc(s.livePulseUnit)}</div>
    ${st.playersThisWeek > 0 ? `<div class="clock"><span style="font-family:inherit;font-weight:700">${
      esc(faNum(st.playersThisWeek))} ${esc(s.livePulsePlayers)}</span></div>` : ''}
  </div></div>`;
}

function livePanels(live: LiveData, s: SiteSettings): string {
  const lb = leaderPanel(live.leaderboard, s);
  const pulse = pulsePanel(live.stats, s);
  if (!lb && !pulse) return '';
  /* One panel alone gets the full width rather than sitting in half a grid
     looking like something failed to load. */
  const pair = lb && pulse
    ? `<div class="grid" style="grid-template-columns:1.35fr 1fr;gap:14px">${lb}${pulse}</div>`
    : lb + pulse;
  return `<div class="grid" style="gap:14px">${pair}</div>`;
}

/* The marquee of who just won. Two copies of the list, because the CSS
 * animation slides one width and relies on the second to cover the gap. */
function ticker(live: LiveData, s: SiteSettings): string {
  const w = live.winners ?? [];
  if (w.length < 3) return '';
  const one = w.map((x) => `<span>${esc(s.liveWinnerVerb.replace('{name}', x.name).replace('{mode}', x.mode))}</span><i>◆</i>`).join('');
  return `<div class="ticker"><div class="run">${one}${one}</div></div>`;
}

/* The stat band. Only the counts that are actually true get a tile, so a brand
 * new install shows two rather than four zeroes. */
function statRow(live: LiveData, s: SiteSettings): string {
  const st = live.stats;
  if (!st) return '';
  const tiles: Array<[number, string]> = [
    [st.playersTotal, s.liveStatPlayers],
    [st.matchesTotal, s.liveStatMatches],
    [st.matchesToday, s.liveStatToday],
    [st.playersThisWeek, s.liveStatWeek]
  ];
  const shown = tiles.filter(([v, label]) => v > 0 && label);
  if (shown.length < 2) return '';
  return `<section class="band tight"><div class="wrap"><div class="stat-row"${
    shown.length !== 4 ? ` style="grid-template-columns:repeat(${shown.length},1fr)"` : ''
  }>${shown.map(([v, label]) => `<div><b>${esc(faNum(v))}</b><span>${esc(label)}</span></div>`).join('')}</div></div></section>`;
}

/* ── THE HERO EVERY PAGE NOW HAS ────────────────────────────────────────
   Breadcrumb, kicker, H1, intro, a fact line, buttons and a character — all of
   them optional. A page that fills none of them gets its title and nothing
   else, which is exactly what every page looked like before. */
function pageHero(page: SitePage, pages: SitePage[], s: SiteSettings, live: LiveData = NO_LIVE): string {
  void pages;
  const isHome = page.slug === 'home';
  const crumbs = isHome ? '' : `<nav class="crumbs" aria-label="مسیر صفحه">
    <a href="${esc(homeUrl(s))}">${esc(s.labelHome)}</a><i>›</i><b>${esc(page.navLabel || page.title)}</b></nav>`;
  const meta = (page.metaLine ?? []).filter(Boolean);
  const buttons = (page.heroButtons ?? []).filter((b) => b.label && b.href);
  const char = assetUrl(page.heroCharacter || '');
  /* THE HOME HERO IS A SPLIT, and that is the design's whole first impression:
     the words on one side, the game's live numbers on the other. Every other
     page keeps the simple centred hero with its character. */
  const panels = isHome ? livePanels(live, s) : '';
  /* THE LOGO, BIG, ON THE HOME PAGE.
   *
   * «در بهترین جای صفحات باید به صورت بزرگ دیده بشه» — and the best place on a
   * marketing site is the first thing above the headline, not a 40px mark in
   * the corner. Only the home page: repeating it at this size on every inner
   * page would push the actual subject of the page below the fold.
   *
   * The height is a setting, and 0 turns it off — an operator whose logo is a
   * wide wordmark rather than a badge will want a different number, and that
   * should not be a deploy. */
  const bigH = Math.max(0, Math.round(Number(s.logoHeroHeight) || 0));
  const heroLogo = (isHome && bigH > 0)
    ? logoImg(s, `height:clamp(${Math.round(bigH * 0.62)}px,9vw,${bigH}px);width:auto;`
        + 'max-width:100%;display:block;margin-bottom:18px;'
        + 'filter:drop-shadow(0 18px 22px rgba(20,21,26,.18))')
    : '';
  const layout = panels
    ? 'class="hero-split"'
    : 'style="display:flex;align-items:center;justify-content:space-between;gap:40px;padding-bottom:40px"';
  return `<div class="hero"><div class="bg-fx"><i class="y1"></i><i class="g1"></i></div><div class="wrap">
    ${crumbs}
    <div ${layout}>
      <div>
        ${heroLogo}
        ${page.kicker ? `<span class="kicker">${esc(page.kicker)}</span>` : ''}
        <h1${(page.kicker || heroLogo) ? ' style="margin-top:14px"' : ''}>${esc(page.title)}</h1>
        ${page.intro ? `<p class="lead" style="margin-top:18px">${esc(page.intro)}</p>` : ''}
        ${meta.length ? `<div class="meta">${meta.map((m, i) =>
          `<span>${esc(m)}</span>${i < meta.length - 1 ? '<span class="sep"></span>' : ''}`).join('')}</div>` : ''}
        ${buttons.length ? `<div class="btn-row">${buttons.map((b, i) =>
          `<a class="btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}" href="${esc(href(b.href, s))}">${esc(b.label)}</a>`).join('')}</div>` : ''}
      </div>
      ${panels || (char ? `<img src="${esc(char)}" alt="" style="width:150px;flex:0 0 auto;filter:drop-shadow(0 26px 24px rgba(20,21,26,.26))">` : '')}
    </div>
  </div></div>`;
}

/* ── THE BODY, WITH ITS SIDEBAR ─────────────────────────────────────────
   The contents list is built from the page's own headings — never typed twice.
   It appears only when the operator asked for it AND there is more than one
   heading to list: a table of contents with a single entry is furniture. */
function pageBody(page: SitePage, s: SiteSettings, list: string): string {
  const headings = page.blocks
    .filter((b) => (b.kind === 'heading' || (b.title && ['text', 'list', 'cards', 'tiles', 'steps', 'faq'].includes(b.kind))))
    .map((b) => ({ anchor: b.anchor || '', label: b.title || '' }))
    .filter((h) => h.anchor && h.label);
  const wantsToc = page.showToc === true && headings.length > 1;
  const aside = wantsToc ? `<aside class="aside">
    <div class="cap">${esc(s.labelToc)}</div>
    <nav class="toc">${headings.map((h) => `<a href="#${esc(h.anchor)}">${esc(h.label)}</a>`).join('')}</nav>
    ${page.asideCta ? `<div class="aside-cta">
      ${assetUrl(page.asideCta.character || '') ? `<img src="${esc(assetUrl(page.asideCta.character || ''))}" alt="">` : ''}
      <b>${esc(page.asideCta.text)}</b>
      <a class="btn btn-primary" href="${esc(href(page.asideCta.href, s))}">${esc(page.asideCta.label)}</a>
    </div>` : ''}
  </aside>` : '';

  const related = (page.related ?? []).filter((r) => r.title && r.href);
  const relatedHtml = related.length ? `<div style="padding-top:28px;margin-top:30px;border-top:1px solid var(--line)">
    <div class="cap">${esc(s.labelRelated)}</div>
    <div class="related">${related.map((r) =>
      `<a href="${esc(href(r.href, s))}"><b>${esc(r.title)}</b>${r.meta ? `<small>${esc(r.meta)}</small>` : ''}</a>`).join('')}</div>
  </div>` : '';

  /* `cta` blocks are full-width bands and must not be boxed inside the prose
     column with the paragraphs. */
  const inProse = page.blocks.filter((b) => b.kind !== 'cta' && b.kind !== 'hero');
  const bands = page.blocks.filter((b) => b.kind === 'cta' || b.kind === 'hero');

  return `<section class="band tight"><div class="wrap${aside ? ' with-aside' : ''}">
    ${aside}
    <div class="prose">${inProse.map((b) => block(b, s)).join('')}${list}${relatedHtml}</div>
  </div></section>${bands.map((b) => block(b, s)).join('')}`;
}

/* The blog index: the newest article given room, the rest as a list. Drawn
   inside the page's own prose column, so an operator can still put words above
   and below it from the panel. */
function renderPostList(posts: SitePost[], s: SiteSettings): string {
  if (!posts.length) {
    return `<div class="card" style="text-align:center;padding:32px">
      <p style="margin:0">${esc(s.labelNoPosts)}</p></div>`;
  }
  /* The design's own vocabulary — .feature / .txt / .art — rather than names
     invented here. A class the stylesheet has never heard of renders as
     nothing and looks like a layout bug. */
  const [first, ...rest] = posts;
  const featured = first ? `<a class="feature" href="/blog/${esc(first.slug)}">
    <div class="txt">
      <h2>${esc(first.title)}</h2>
      ${first.excerpt ? `<p style="margin-top:14px">${esc(first.excerpt)}</p>` : ''}
      <div class="meta" style="display:flex;align-items:center;gap:12px;margin-top:20px"><span>${esc(faDate(first.publishedAt))}</span>${
        first.author ? `<span class="sep"></span><span>${esc(first.author)}</span>` : ''}</div>
      ${first.tags.length ? `<div class="chips">${first.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="art">${IMG_SRC.test(String(first.cover ?? ''))
      ? `<img src="${esc(first.cover)}" alt="" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover">`
      : (assetUrl('char-thinking.png') ? `<img src="${esc(assetUrl('char-thinking.png'))}" alt="">` : '')}</div>
  </a>` : '';
  const list = rest.length ? `<div class="list-rows">${rest.map((p) => `
    <a href="/blog/${esc(p.slug)}">
      <span class="thumb">${IMG_SRC.test(String(p.cover ?? '')) ? `<img src="${esc(p.cover)}" alt="" loading="lazy" decoding="async">` : ''}</span>
      <div><h3>${esc(p.title)}</h3><div class="meta">${esc(faDate(p.publishedAt))}</div></div>
    </a>`).join('')}</div>` : '';
  return featured + list;
}

/** Article body: a tiny, deliberately limited text format. '## ' is a heading,
 *  '- ' a bullet, everything else a paragraph. No HTML is accepted, so an
 *  article can never inject markup into the site's own origin. */
/* Same allowlist idea as href(): a relative path or http(s) only, so an image
 * line can never become a javascript: or data: source. */
const IMG_SRC = /^(\/[^\s"'<>]*|https?:\/\/[^\s"'<>]+)$/i;

function articleBody(body: string): string {
  const lines = String(body ?? '').split('\n');
  const out: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { closeList(); continue; }
    if (l.startsWith('### ')) { closeList(); out.push(`<h3>${esc(l.slice(4))}</h3>`); continue; }
    if (l.startsWith('## ')) { closeList(); out.push(`<h2>${esc(l.slice(3))}</h2>`); continue; }
    if (l.startsWith('- ')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${esc(l.slice(2))}</li>`);
      continue;
    }
    /* An image line: `!/media/abc توضیح تصویر`. The source is restricted to a
     * path or an http(s) URL and the caption is escaped like any other text, so
     * this stays a picture — it can no more inject markup than a paragraph can. */
    if (l.startsWith('!')) {
      const rest = l.slice(1).trim();
      const sp = rest.search(/\s/);
      const src = sp === -1 ? rest : rest.slice(0, sp);
      const cap = sp === -1 ? '' : rest.slice(sp + 1).trim();
      if (IMG_SRC.test(src)) {
        closeList();
        out.push(
          `<figure class="ph"><img src="${esc(src)}" alt="${esc(cap)}" loading="lazy" decoding="async">` +
          (cap ? `<figcaption>${esc(cap)}</figcaption>` : '') + '</figure>');
        continue;
      }
      // Not a usable source — fall through and print the line as written.
    }
    closeList();
    out.push(`<p>${esc(l)}</p>`);
  }
  closeList();
  return out.join('');
}

export function renderPost(post: SitePost, pages: SitePage[], s: SiteSettings, more: SitePost[] = []): string {
  const url = `/blog/${post.slug}`;
  const canonical = s.baseUrl + url;
  const img = post.cover && !/^https?:/i.test(post.cover) ? s.baseUrl + post.cover : post.cover;
  const ld = [
    jsonLd({
      '@context': 'https://schema.org', '@type': 'Article',
      headline: post.title,
      description: post.excerpt,
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      author: { '@type': 'Organization', name: post.author || s.siteName },
      publisher: orgLd(s),
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      ...(img ? { image: [img] } : {}),
      ...(post.tags.length ? { keywords: post.tags.join(', ') } : {}),
      inLanguage: 'fa-IR'
    }),
    jsonLd(crumbLd(s, [{ name: 'خانه', url: homeUrl(s) }, { name: 'وبلاگ', url: '/blog' }, { name: post.title, url }]))
  ];
  const related = more.filter((p) => p.slug !== post.slug).slice(0, 3);
  return shell({
    headHtml: head({
      title: post.seoTitle || `${post.title} | ${s.siteName}`,
      description: post.seoDescription || post.excerpt || s.description,
      keywords: post.seoKeywords || post.tags.join(', ') || s.keywords,
      canonical, ogImage: post.cover, noindex: post.noindex, s, ldJson: ld, type: 'article'
    }),
    body: `${nav(pages, 'blog', s)}<main id="main">
      <div class="hero"><div class="bg-fx"><i class="y1"></i><i class="g1"></i></div><div class="wrap">
        <nav class="crumbs" aria-label="مسیر صفحه">
          <a href="${esc(homeUrl(s))}">${esc(s.labelHome)}</a><i>›</i>
          <a href="/blog">${esc(s.labelBlog)}</a><i>›</i><b>${esc(post.title)}</b>
        </nav>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:40px;padding-bottom:40px"><div>
          <h1>${esc(post.title)}</h1>
          ${post.excerpt ? `<p class="lead" style="margin-top:18px">${esc(post.excerpt)}</p>` : ''}
          <div class="meta">
            <span>${esc(faDate(post.publishedAt))}</span>
            ${post.author ? `<span class="sep"></span><span>${esc(post.author)}</span>` : ''}
          </div>
          ${post.tags.length ? `<div class="chips">${post.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
        </div></div>
      </div></div>
      <section class="band tight"><div class="wrap">
        ${IMG_SRC.test(String(post.cover ?? '')) ? `<figure class="ph"><img src="${esc(post.cover)}" alt="${esc(post.title)}"></figure>` : ''}
        <article class="prose" style="margin-top:22px">${articleBody(post.body)}</article>
        ${related.length ? `<div style="padding-top:28px;margin-top:30px;border-top:1px solid var(--line)">
          <div class="cap">${esc(s.labelMoreArticles)}</div>
          <div class="related">${related.map((r) =>
            `<a href="/blog/${esc(r.slug)}"><b>${esc(r.title)}</b><small>${esc(faDate(r.publishedAt))}</small></a>`).join('')}</div>
        </div>` : ''}
      </div></section>
      ${ctaBand({ title: s.postCtaTitle, subtitle: s.postCtaSubtitle, label: s.postCtaLabel, hrefRaw: s.playUrl || '/play' }, s)}
    </main>${footer(pages, s)}`
  });
}

export function renderNotFound(pages: SitePage[], s: SiteSettings): string {
  return shell({
    headHtml: head({
      title: `${s.notFoundTitle} | ${s.siteName}`, description: s.notFoundText,
      keywords: '', canonical: s.baseUrl + '/404', ogImage: '', noindex: true, s, ldJson: []
    }),
    body: `${nav(pages, '', s)}<main id="main">
      <div class="hero"><div class="bg-fx"><i class="y1"></i><i class="g1"></i></div><div class="wrap">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:40px;padding-bottom:40px"><div>
          <span class="kicker">۴۰۴</span>
          <h1 style="margin-top:14px">${esc(s.notFoundTitle)}</h1>
          <p class="lead" style="margin-top:18px">${esc(s.notFoundText)}</p>
          <div class="btn-row">
            <a class="btn btn-primary" href="${esc(homeUrl(s))}">${esc(s.notFoundLabel)}</a>
            <a class="btn btn-ghost" href="/blog">${esc(s.labelBlog)}</a>
          </div>
        </div></div>
      </div></div>
    </main>${footer(pages, s)}`
  });
}

// -------------------------------------------------------------- SEO files ----

export function renderSitemap(pages: SitePage[], posts: SitePost[], s: SiteSettings): string {
  const url = (loc: string, lastmod: string, priority: string, freq: string) =>
    `  <url><loc>${esc(s.baseUrl + loc)}</loc><lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` +
    `<changefreq>${freq}</changefreq><priority>${priority}</priority></url>`;
  const rows = [
    ...pages.filter((p) => p.published && !p.noindex)
      .map((p) => url(pageUrl(p.slug, s), p.updatedAt, p.slug === 'home' ? '1.0' : '0.7',
        p.slug === 'blog' ? 'weekly' : 'monthly')),
    ...posts.filter((p) => p.published && !p.noindex)
      .map((p) => url(`/blog/${p.slug}`, p.updatedAt, '0.6', 'monthly'))
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join('\n')}
</urlset>`;
}

export function renderRobots(s: SiteSettings): string {
  /* The game itself is an app behind a login, not content — crawling it wastes
   * budget and indexes nothing useful. */
  return `User-agent: *
Allow: /
Disallow: /v1/
Disallow: /pzadmin.html
Disallow: ${s.playUrl || '/play'}

Sitemap: ${s.baseUrl}/sitemap.xml`;
}
