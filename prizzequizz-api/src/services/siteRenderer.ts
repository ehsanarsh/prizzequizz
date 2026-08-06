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
import type { SiteBlock, SitePage, SitePost, SiteSettings } from './siteContentService.js';

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
 *  URL can be changed in one place instead of on every button. */
function href(raw: string, s: SiteSettings): string {
  const v = String(raw ?? '').trim().replace('{play}', s.playUrl || '/play');
  return v || '#';
}

// ------------------------------------------------------------------ style ----

const CSS = `
:root{--bolt:#FFD21F;--bolt-2:#F5B90D;--ink:#0E0C14;--ink-2:#171523;--ink-3:#211E31;
  --paper:#F6F3EA;--muted:#9A93AE;--ok:#33D97C;--line:rgba(255,255,255,.10);--max:1080px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--ink);color:var(--paper);line-height:1.9;
  font-family:Vazirmatn,'IRANSans','Segoe UI',Tahoma,system-ui,sans-serif;font-size:16px}
img{max-width:100%;height:auto;display:block}
a{color:inherit}
.wrap{max-width:var(--max);margin:0 auto;padding:0 18px}
/* ---- header ---- */
header{position:sticky;top:0;z-index:20;background:rgba(14,12,20,.92);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav{display:flex;align-items:center;gap:14px;height:64px}
.brand{display:flex;align-items:center;gap:9px;font-weight:900;font-size:18px;text-decoration:none;flex:0 0 auto}
.brand i{font-style:normal;font-size:24px}
.nav ul{display:flex;gap:4px;list-style:none;margin:0;padding:0;flex:1;overflow-x:auto;scrollbar-width:none}
.nav ul::-webkit-scrollbar{display:none}
.nav a{text-decoration:none;font-size:13.5px;font-weight:800;color:var(--muted);
  padding:8px 11px;border-radius:11px;white-space:nowrap;transition:color .15s,background .15s}
.nav a:hover{color:var(--paper);background:rgba(255,255,255,.06)}
.nav a[aria-current=page]{color:var(--bolt);background:rgba(255,210,31,.10)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;text-decoration:none;
  font-weight:900;font-size:15px;padding:13px 22px;border-radius:16px;border:2.5px solid #000;
  background:linear-gradient(180deg,#FFE24A,var(--bolt-2));color:#141414;box-shadow:0 5px 0 #000;
  transition:transform .08s,box-shadow .08s;cursor:pointer}
.btn:active{transform:translateY(4px);box-shadow:0 1px 0 #000}
.btn.ghost{background:var(--ink-3);color:var(--paper);box-shadow:0 5px 0 #000}
.btn.sm{font-size:13.5px;padding:9px 15px;border-radius:13px;box-shadow:0 4px 0 #000}
.nav .btn{flex:0 0 auto}
/* ---- sections ---- */
main{display:block}
section{padding:52px 0}
section:first-of-type{padding-top:40px}
h1,h2,h3{line-height:1.5;margin:0 0 12px;font-weight:900}
h1{font-size:clamp(27px,5.4vw,44px)}
h2{font-size:clamp(21px,3.6vw,30px)}
h3{font-size:18px}
p{margin:0 0 14px;color:#D7D1E4}
.lead{font-size:clamp(15px,2.4vw,18.5px);color:#C4BDD6;max-width:62ch}
.eyebrow{display:inline-block;font-size:11.5px;font-weight:900;letter-spacing:.4px;color:var(--bolt);
  background:rgba(255,210,31,.11);border:1.5px solid rgba(255,210,31,.32);
  padding:5px 12px;border-radius:999px;margin-bottom:14px}
.hero{position:relative;overflow:hidden;border:2.5px solid #000;border-radius:28px;padding:clamp(24px,5vw,52px);
  background:radial-gradient(120% 130% at 82% -10%,#3A2E6B 0%,#1B1630 46%,#100E1A 100%);box-shadow:0 8px 0 #000}
.hero::after{content:"";position:absolute;inset-inline-end:-70px;top:-70px;width:260px;height:260px;
  border-radius:50%;background:radial-gradient(circle,rgba(255,210,31,.18),transparent 66%)}
.hero .in{position:relative;z-index:1;max-width:66ch}
.cta-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(232px,1fr))}
.card{border:2.5px solid #000;border-radius:20px;padding:20px;background:var(--ink-2);box-shadow:0 5px 0 #000}
.card .ico{font-size:30px;line-height:1;margin-bottom:10px}
.card h3{margin-bottom:6px}
.card p{margin:0;font-size:14px;color:#BDB6CE}
.steps{counter-reset:s;display:grid;gap:12px}
.step{position:relative;border:2.5px solid #000;border-radius:18px;padding:18px 66px 18px 20px;
  background:var(--ink-2);box-shadow:0 5px 0 #000}
.step::before{counter-increment:s;content:counter(s);position:absolute;inset-inline-start:18px;top:16px;
  width:34px;height:34px;border-radius:11px;border:2.5px solid #000;background:linear-gradient(180deg,#FFE24A,var(--bolt-2));
  color:#141414;font-weight:900;display:grid;place-items:center;font-size:16px}
.step h3{margin:0 0 4px}
.step p{margin:0;font-size:14px;color:#BDB6CE}
details.faq{border:2.5px solid #000;border-radius:16px;background:var(--ink-2);box-shadow:0 4px 0 #000;
  margin-bottom:10px;overflow:hidden}
details.faq summary{cursor:pointer;padding:15px 18px;font-weight:900;font-size:15px;list-style:none;
  display:flex;justify-content:space-between;gap:12px;align-items:center}
details.faq summary::-webkit-details-marker{display:none}
details.faq summary::after{content:"+";color:var(--bolt);font-size:21px;line-height:1;flex:0 0 auto}
details.faq[open] summary::after{content:"−"}
details.faq .a{padding:0 18px 16px;color:#C4BDD6;font-size:14.5px}
.prose h2{margin-top:30px}
.prose ul{padding-inline-start:20px;color:#D7D1E4}
.prose li{margin-bottom:7px}
.cta-band{border:2.5px solid #000;border-radius:24px;padding:clamp(22px,4vw,38px);text-align:center;
  background:linear-gradient(135deg,#3A2E6B,#171523);box-shadow:0 6px 0 #000}
.cta-band .cta-row{justify-content:center}
/* ---- blog ---- */
.posts{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.post{display:block;text-decoration:none;border:2.5px solid #000;border-radius:20px;overflow:hidden;
  background:var(--ink-2);box-shadow:0 5px 0 #000;transition:transform .1s}
.post:hover{transform:translateY(-3px)}
.post .body{padding:18px}
.post h3{margin:0 0 7px;font-size:17px}
.post p{margin:0 0 10px;font-size:13.5px;color:#BDB6CE}
.meta{font-size:12px;color:var(--muted);font-weight:800}
.tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.tag{font-size:11.5px;font-weight:900;padding:4px 10px;border-radius:999px;
  background:var(--ink-3);border:1.5px solid var(--line);color:#C4BDD6}
.crumbs{font-size:12.5px;color:var(--muted);font-weight:800;margin-bottom:14px}
.crumbs a{text-decoration:none}
.crumbs a:hover{color:var(--paper)}
article.post-body{max-width:70ch}
article.post-body h2{font-size:22px;margin-top:32px}
article.post-body h3{font-size:17.5px;margin-top:22px}
/* ---- footer ---- */
footer{border-top:1px solid var(--line);padding:38px 0 30px;margin-top:34px;background:#0B0910}
.fgrid{display:grid;gap:26px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
footer h4{font-size:14px;font-weight:900;margin:0 0 11px}
footer ul{list-style:none;margin:0;padding:0}
footer li{margin-bottom:8px}
footer a{text-decoration:none;color:var(--muted);font-size:13.5px;font-weight:700}
footer a:hover{color:var(--paper)}
.fbot{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);
  display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12.5px;font-weight:700}
.badges{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:12px}
.skip{position:absolute;inset-inline-start:-9999px}
.skip:focus{inset-inline-start:12px;top:12px;z-index:50;background:var(--bolt);color:#141414;
  padding:10px 15px;border-radius:10px;font-weight:900}
@media (max-width:720px){
  .nav{height:auto;padding:10px 0;flex-wrap:wrap}
  .nav ul{order:3;width:100%;padding-bottom:2px}
  section{padding:38px 0}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// ------------------------------------------------------------------ pieces ----

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
<style>${CSS}</style>
${o.ldJson.map((j) => `<script type="application/ld+json">${j}</script>`).join('\n')}`;
}

function nav(pages: SitePage[], current: string, s: SiteSettings): string {
  const items = pages
    .filter((p) => p.showInNav && p.published)
    .map((p) => {
      const url = p.slug === 'home' ? '/' : `/${p.slug}`;
      const cur = p.slug === current ? ' aria-current="page"' : '';
      return `<li><a href="${esc(url)}"${cur}>${esc(p.navLabel || p.title)}</a></li>`;
    }).join('');
  return `<header><div class="wrap"><nav class="nav" aria-label="منوی اصلی">
  <a class="brand" href="/"><i>${esc(s.logoEmoji || '🎯')}</i>${esc(s.siteName)}</a>
  <ul>${items}</ul>
  <a class="btn sm" href="${esc(s.playUrl || '/play')}">🎮 بازی کن</a>
</nav></div></header>`;
}

function footer(pages: SitePage[], s: SiteSettings): string {
  const link = (p: SitePage) => `<li><a href="${p.slug === 'home' ? '/' : '/' + esc(p.slug)}">${esc(p.navLabel || p.title)}</a></li>`;
  const legal = pages.filter((p) => ['privacy', 'terms'].includes(p.slug));
  const rest = pages.filter((p) => p.published && p.showInNav && !['privacy', 'terms', 'home'].includes(p.slug));
  const social = [
    s.telegram && `<a href="${esc(s.telegram)}" rel="noopener">تلگرام</a>`,
    s.instagram && `<a href="${esc(s.instagram)}" rel="noopener">اینستاگرام</a>`,
    s.twitter && `<a href="${esc(s.twitter)}" rel="noopener">ایکس</a>`
  ].filter(Boolean).join(' · ');
  return `<footer><div class="wrap">
  <div class="fgrid">
    <div>
      <h4>${esc(s.siteName)}</h4>
      <p style="font-size:13.5px;color:var(--muted);margin:0">${esc(s.tagline)}</p>
      ${social ? `<p style="font-size:13px;margin-top:10px">${social}</p>` : ''}
      ${s.enamadHtml ? `<div class="badges">${s.enamadHtml /* raw: the eNamad badge snippet */}</div>` : ''}
    </div>
    <div><h4>صفحه‌ها</h4><ul>${rest.map(link).join('')}</ul></div>
    <div><h4>قوانین</h4><ul>${legal.map(link).join('')}</ul></div>
    <div><h4>ارتباط</h4><ul>
      ${s.email ? `<li><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></li>` : ''}
      ${s.phone ? `<li><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></li>` : ''}
      ${s.address ? `<li style="color:var(--muted);font-size:13px">${esc(s.address)}</li>` : ''}
    </ul></div>
  </div>
  <div class="fbot"><span>${esc(s.footerNote)}</span><span>${esc(s.siteName)}</span></div>
</div></footer>`;
}

function paragraphs(body: string): string {
  return String(body ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => `<p>${esc(l)}</p>`).join('');
}

function block(b: SiteBlock, s: SiteSettings): string {
  const items = b.items ?? [];
  switch (b.kind) {
    case 'hero':
      return `<section><div class="wrap"><div class="hero"><div class="in">
        <h1>${esc(b.title)}</h1>
        ${b.subtitle ? `<p class="lead">${esc(b.subtitle)}</p>` : ''}
        ${(b.ctaText || b.ctaText2) ? `<div class="cta-row">
          ${b.ctaText ? `<a class="btn" href="${esc(href(b.ctaHref || '', s))}">${esc(b.ctaText)}</a>` : ''}
          ${b.ctaText2 ? `<a class="btn ghost" href="${esc(href(b.ctaHref2 || '', s))}">${esc(b.ctaText2)}</a>` : ''}
        </div>` : ''}
      </div></div></div></section>`;
    case 'text':
      return `<section><div class="wrap prose" style="max-width:72ch">
        ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}${paragraphs(b.body || '')}</div></section>`;
    case 'cards':
      return `<section><div class="wrap">
        ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}
        <div class="grid">${items.map((i) => `<div class="card">
          ${i.icon ? `<div class="ico">${esc(i.icon)}</div>` : ''}
          <h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></div>`).join('')}</div></div></section>`;
    case 'steps':
      return `<section><div class="wrap">
        ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}
        <div class="steps">${items.map((i) => `<div class="step">
          <h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></div>`).join('')}</div></div></section>`;
    case 'faq':
      return `<section><div class="wrap" style="max-width:74ch">
        ${b.title ? `<h2>${esc(b.title)}</h2>` : ''}
        ${items.map((i) => `<details class="faq"><summary>${esc(i.q)}</summary>
          <div class="a">${esc(i.a)}</div></details>`).join('')}</div></section>`;
    case 'stats':
      return `<section><div class="wrap"><div class="grid">${items.map((i) => `<div class="card" style="text-align:center">
        <div class="ico">${esc(i.icon)}</div>
        <h3 style="color:var(--bolt);font-size:26px">${esc(i.value)}</h3>
        <p>${esc(i.title)}</p></div>`).join('')}</div></div></section>`;
    case 'cta':
      return `<section><div class="wrap"><div class="cta-band">
        <h2>${esc(b.title)}</h2>${b.body ? `<p class="lead" style="margin-inline:auto">${esc(b.body)}</p>` : ''}
        ${b.ctaText ? `<div class="cta-row"><a class="btn" href="${esc(href(b.ctaHref || '', s))}">${esc(b.ctaText)}</a></div>` : ''}
      </div></div></section>`;
    default:
      return '';
  }
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

export function renderPage(page: SitePage, pages: SitePage[], s: SiteSettings, posts: SitePost[] = []): string {
  const url = page.slug === 'home' ? '/' : `/${page.slug}`;
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
    ld.push(jsonLd(crumbLd(s, [{ name: 'خانه', url: '/' }, { name: page.title, url }])));
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
    body: `${nav(pages, page.slug, s)}<main id="main">${page.blocks.map((b) => block(b, s)).join('')}${list}</main>${footer(pages, s)}`
  });
}

function renderPostList(posts: SitePost[], s: SiteSettings): string {
  if (!posts.length) {
    return `<section><div class="wrap"><div class="card" style="text-align:center">
      <p style="margin:0">هنوز مقاله‌ای منتشر نشده.</p></div></div></section>`;
  }
  return `<section><div class="wrap"><div class="posts">${posts.map((p) => `
    <a class="post" href="/blog/${esc(p.slug)}">
      <div class="body">
        <div class="meta">${esc(faDate(p.publishedAt))}</div>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.excerpt)}</p>
        ${p.tags.length ? `<div class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </a>`).join('')}</div></div></section>`;
}

/** Article body: a tiny, deliberately limited text format. '## ' is a heading,
 *  '- ' a bullet, everything else a paragraph. No HTML is accepted, so an
 *  article can never inject markup into the site's own origin. */
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
    jsonLd(crumbLd(s, [{ name: 'خانه', url: '/' }, { name: 'وبلاگ', url: '/blog' }, { name: post.title, url }]))
  ];
  const related = more.filter((p) => p.slug !== post.slug).slice(0, 3);
  return shell({
    headHtml: head({
      title: post.seoTitle || `${post.title} | ${s.siteName}`,
      description: post.seoDescription || post.excerpt || s.description,
      keywords: post.seoKeywords || post.tags.join(', ') || s.keywords,
      canonical, ogImage: post.cover, noindex: post.noindex, s, ldJson: ld, type: 'article'
    }),
    body: `${nav(pages, 'blog', s)}<main id="main"><section><div class="wrap">
      <div class="crumbs"><a href="/">خانه</a> › <a href="/blog">وبلاگ</a> › ${esc(post.title)}</div>
      <h1>${esc(post.title)}</h1>
      <div class="meta">${esc(faDate(post.publishedAt))}${post.author ? ' · ' + esc(post.author) : ''}</div>
      ${post.tags.length ? `<div class="tags">${post.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      <article class="post-body prose" style="margin-top:22px">${articleBody(post.body)}</article>
      <div class="cta-band" style="margin-top:34px">
        <h2>امتحانش کن</h2>
        <p class="lead" style="margin-inline:auto">همین سؤال‌ها را در دوئل با یک بازیکن واقعی بازی کن.</p>
        <div class="cta-row"><a class="btn" href="${esc(s.playUrl || '/play')}">🎮 شروع بازی</a></div>
      </div>
      ${related.length ? `<h2 style="margin-top:38px">مقاله‌های دیگر</h2>${renderPostList(related, s).replace(/^<section><div class="wrap">|<\/div><\/section>$/g, '')}` : ''}
    </div></section></main>${footer(pages, s)}`
  });
}

export function renderNotFound(pages: SitePage[], s: SiteSettings): string {
  return shell({
    headHtml: head({
      title: `صفحه پیدا نشد | ${s.siteName}`, description: 'این صفحه وجود ندارد.',
      keywords: '', canonical: s.baseUrl + '/404', ogImage: '', noindex: true, s, ldJson: []
    }),
    body: `${nav(pages, '', s)}<main id="main"><section><div class="wrap"><div class="hero"><div class="in">
      <div class="eyebrow">۴۰۴</div><h1>این صفحه پیدا نشد</h1>
      <p class="lead">شاید نشانی عوض شده باشد. از منوی بالا یا دکمهٔ زیر ادامه بده.</p>
      <div class="cta-row"><a class="btn" href="/">خانه</a><a class="btn ghost" href="/blog">وبلاگ</a></div>
    </div></div></div></section></main>${footer(pages, s)}`
  });
}

// -------------------------------------------------------------- SEO files ----

export function renderSitemap(pages: SitePage[], posts: SitePost[], s: SiteSettings): string {
  const url = (loc: string, lastmod: string, priority: string, freq: string) =>
    `  <url><loc>${esc(s.baseUrl + loc)}</loc><lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` +
    `<changefreq>${freq}</changefreq><priority>${priority}</priority></url>`;
  const rows = [
    ...pages.filter((p) => p.published && !p.noindex)
      .map((p) => url(p.slug === 'home' ? '/' : `/${p.slug}`, p.updatedAt, p.slug === 'home' ? '1.0' : '0.7',
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
