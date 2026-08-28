/* THE PUBLIC WEBSITE — content, and the SEO that goes with it.
 *
 * This is the marketing site that sits BESIDE the game: a home page, the legal
 * pages Iranian payment gateways and eNamad ask to see, and a blog to be found
 * by. The game itself is untouched by anything in here.
 *
 * Everything is a row, for the same reason the missions are: a site whose copy
 * lives in the code needs a deploy to fix a typo, and the person who spots the
 * typo is not the person who can deploy. Pages, posts and the SEO settings are
 * all editable from the admin panel.
 *
 * A page is a list of BLOCKS rather than a slab of HTML. That is a deliberate
 * trade: it costs some flexibility, but an admin editing a block cannot break
 * the layout, cannot inject a script into the site's own origin, and never has
 * to write a tag. Adding a new KIND of block is a code change; adding a page,
 * a section or an article is not.
 */
import { getPgPool } from './db.js';
import { logger } from './log.js';

// ------------------------------------------------------------------ types ----

/* The redesign asks for four shapes the old site had no name for: a section
 * HEADING the sidebar can link to, a bullet LIST, a CALLOUT with a character
 * beside it, and a grid of TILES for internal linking. They are kinds rather
 * than free HTML for the same reason the first seven were: an operator editing
 * a block cannot break the layout and cannot introduce a tag. */
export type BlockKind = 'hero' | 'text' | 'cards' | 'steps' | 'faq' | 'cta' | 'stats'
  | 'heading' | 'list' | 'callout' | 'tiles';
export const BLOCK_KINDS: BlockKind[] = ['hero', 'text', 'cards', 'steps', 'faq', 'cta', 'stats',
  'heading', 'list', 'callout', 'tiles'];
/* What each one is called in the panel, so the operator never meets the English
 * key. Adding a kind without naming it here is caught by the site's tests. */
export const BLOCK_LABELS: Record<BlockKind, string> = {
  hero: 'سربرگ صفحه',
  heading: 'عنوان بخش',
  text: 'متن',
  list: 'فهرست نقطه‌ای',
  cards: 'کارت‌ها',
  tiles: 'کاشی‌های لینک',
  steps: 'مراحل شماره‌دار',
  faq: 'سؤال و جواب',
  callout: 'کادر نکته',
  stats: 'نوار آمار',
  cta: 'دعوت به بازی'
};

export interface SiteBlockItem {
  icon?: string;
  title?: string;
  text?: string;
  q?: string;
  a?: string;
  value?: string;
  /** Tiles and cards can be links; a tile without one is still a tile. */
  href?: string;
  /** The small grey line under a tile — «۲۴۰ سؤال», «۱۲ دقیقه». */
  meta?: string;
  /** One card in a row can be picked out. */
  highlight?: boolean;
  /** A FAQ answer that starts open. */
  open?: boolean;
  /** Chips along the bottom of a card. */
  tags?: string[];
  /** A character drawn on the card, by asset name or an uploaded /media/ URL. */
  character?: string;
}

export interface SiteBlock {
  kind: BlockKind;
  title?: string;
  subtitle?: string;
  /** Paragraphs, one per line. Rendered escaped — never as markup. */
  body?: string;
  ctaText?: string;
  ctaHref?: string;
  ctaText2?: string;
  ctaHref2?: string;
  image?: string;
  /** The id a heading gets, so the page's own contents list can link to it.
   *  Derived from the title when the operator leaves it blank. */
  anchor?: string;
  /** A character beside a callout, or on a CTA band. */
  character?: string;
  items?: SiteBlockItem[];
}

export interface SitePage {
  slug: string;
  title: string;
  navLabel: string;
  showInNav: boolean;
  navOrder: number;
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string;
  ogImage: string;
  /** Excluded from sitemap.xml and marked noindex. For thin or duplicate pages. */
  noindex: boolean;
  /* ── the hero, which the redesign gives every page ──────────────────────
     All optional: a page that fills none of them gets a plain title, which is
     what every page had before. */
  /** The small line above the H1 — «راهنما», «قانون». */
  kicker?: string;
  /** The paragraph under the H1. */
  intro?: string;
  /** A character beside the hero, by asset name or an uploaded /media/ URL. */
  heroCharacter?: string;
  /** Buttons in the hero. The first is the primary one. */
  heroButtons?: Array<{ label: string; href: string }>;
  /** Small facts on one line under the intro — «۵ دقیقه خواندن», «آخرین
   *  بروزرسانی: …». */
  metaLine?: string[];
  /** The sticky sidebar list of this page's own headings. Off by default: a
   *  page with two headings does not need a table of contents. */
  showToc?: boolean;
  /** The little card under the contents list. */
  asideCta?: { text: string; label: string; href: string; character?: string };
  /** Hand-picked internal links at the foot of the body. */
  related?: Array<{ title: string; meta?: string; href: string }>;
  /** The dark band at the very bottom. */
  cta?: { title: string; subtitle?: string; label: string; href: string; character?: string };
  blocks: SiteBlock[];
  published: boolean;
  updatedAt: string;
}

export interface SitePost {
  slug: string;
  title: string;
  excerpt: string;
  cover: string;
  /** Plain text. A line starting with '## ' is a heading, '- ' a bullet,
   *  anything else a paragraph. No HTML is ever accepted or rendered. */
  body: string;
  author: string;
  tags: string[];
  seoTitle: string;
  seoDescription: string;
  seoKeywords: string;
  noindex: boolean;
  published: boolean;
  publishedAt: string;
  updatedAt: string;
}

export interface SiteSettings {
  siteName: string;
  tagline: string;
  /** Absolute origin, e.g. https://www.prizequiz.ir — canonical URLs, OG URLs
   *  and sitemap entries are all built from it, so it must be right. */
  baseUrl: string;
  description: string;
  keywords: string;
  ogImage: string;
  logoEmoji: string;
  /** Where the «بازی کن» buttons point. */
  playUrl: string;
  /** Where the site's own home page lives. The game owns '/' by default, so the
   *  site's home sits at '/home'; set this to '/' if the site ever takes the
   *  root. Canonical URLs, the sitemap and every «خانه» link read it, so the
   *  two can never disagree. */
  homePath: string;
  androidUrl: string;
  iosUrl: string;
  bazaarUrl: string;
  myketUrl: string;
  email: string;
  phone: string;
  address: string;
  telegram: string;
  instagram: string;
  twitter: string;
  /** Verification meta tags and the eNamad badge, pasted from those panels.
   *  Rendered into <head>/footer verbatim — see the note on the admin route. */
  googleVerification: string;
  enamadHtml: string;
  footerNote: string;
  /* ── the shell the redesign draws around every page ─────────────────────
     Every one of these is a string an operator can edit; none of them is
     written into the template. A blank one removes what it labels rather than
     printing an empty box. */
  /** The line under the logo in the footer. */
  footerAbout: string;
  /** The bottom line — «© ۱۴۰۳ پرایز کوئیز». */
  copyright: string;
  /** The footer's link columns. The grid divides whatever it is given. */
  footerColumns: Array<{ title: string; links: Array<{ label: string; href: string }> }>;
  /** The two buttons in the header. */
  ctaPlay: string;
  ctaLogin: string;
  loginUrl: string;
  /** Where «همهٔ موضوع‌ها» and «راهنمای بازی» point from the home page. */
  topicsUrl: string;
  howToPlayUrl: string;
  /* ── THE WORDS THE TEMPLATE ITSELF SAYS ──────────────────────────────
     «تمام متن‌هاشو من از site-admin بتونم تنظیم کنم.» Every one of these was
     written into the template: the breadcrumb's «خانه», the sidebar's «در این
     صفحه», the band at the foot of an article. They read as part of the
     furniture until somebody wants to change one, and then they are a deploy.
     A blank value removes what it labels — the article band disappears rather
     than printing an empty heading. */
  labelHome: string;
  labelToc: string;
  labelRelated: string;
  labelBlog: string;
  labelNoPosts: string;
  labelMoreArticles: string;
  postCtaTitle: string;
  postCtaSubtitle: string;
  postCtaLabel: string;
  notFoundTitle: string;
  notFoundText: string;
  notFoundLabel: string;
  /* ── THE LIVE PANELS ─────────────────────────────────────────────────
     The words around the game's real numbers. The numbers themselves come
     from the database and are not editable — that is the point of them —
     but everything wrapped around them is, including switching a panel off
     by clearing its title.
     `liveWinnerVerb` is a sentence with two slots: {name} and {mode}. */
  liveLeaderTitle: string;
  liveLeaderPeriod: string;
  livePulseLabel: string;
  livePulseUnit: string;
  livePulsePlayers: string;
  liveWinnerVerb: string;
  liveStatPlayers: string;
  liveStatMatches: string;
  liveStatToday: string;
  liveStatWeek: string;
  /* Bookkeeping, not a setting: the stamp that says the one-time design
     backfill has run. It is not offered in the panel — a switch that re-runs a
     migration is a switch somebody eventually presses. */
  designBackfilled?: boolean;
  /** Turns the whole public site off (503) without touching the game. */
  enabled: boolean;
  updatedAt: string;
}

export class SiteError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function pg(): ReturnType<typeof getPgPool> | null {
  try { return process.env.DATABASE_URL ? getPgPool() : null; } catch { return null; }
}

/* Latched as a promise, not a boolean: a boolean set after the work lets every
 * request that arrives during a cold start run the DDL at once, and CREATE
 * TABLE IF NOT EXISTS is not concurrency-safe — two of them racing collide on
 * pg_type and one raises a duplicate-key error. That is exactly what made the
 * very first page load after an install answer 500 while the rest were fine. */
let _schema: Promise<void> | null = null;
function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  _schema ??= createSchema(pool).catch((e) => { _schema = null; throw e; });
  return _schema;
}

/* Duplicate-object errors are the benign half of that race — another process
 * (a second site instance, or a deploy overlapping the old one) created the
 * table first, which is the outcome we wanted anyway. */
function alreadyExists(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '23505' || code === '42P07' || code === '42710';
}

async function createSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  try { await createSchemaOnce(pool); }
  catch (e) {
    if (!alreadyExists(e)) throw e;
  }
}

async function createSchemaOnce(pool: ReturnType<typeof getPgPool>): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS site_pages (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    nav_label TEXT NOT NULL DEFAULT '',
    show_in_nav BOOLEAN NOT NULL DEFAULT true,
    nav_order INT NOT NULL DEFAULT 50,
    seo_title TEXT NOT NULL DEFAULT '',
    seo_description TEXT NOT NULL DEFAULT '',
    seo_keywords TEXT NOT NULL DEFAULT '',
    og_image TEXT NOT NULL DEFAULT '',
    noindex BOOLEAN NOT NULL DEFAULT false,
    blocks JSONB NOT NULL DEFAULT '[]',
    design JSONB NOT NULL DEFAULT '{}',
    published BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS site_posts (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    tags JSONB NOT NULL DEFAULT '[]',
    seo_title TEXT NOT NULL DEFAULT '',
    seo_description TEXT NOT NULL DEFAULT '',
    seo_keywords TEXT NOT NULL DEFAULT '',
    noindex BOOLEAN NOT NULL DEFAULT false,
    published BOOLEAN NOT NULL DEFAULT true,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS site_settings (
    id TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

  /* SAID TWICE ON PURPOSE.
     `CREATE TABLE IF NOT EXISTS` does exactly nothing to a table that already
     exists — it does not look at the columns. So a column added after the
     first release reaches a brand-new database and no other, and the live site
     goes on running against a table without it: every read of that column
     errors, and the page it belongs to breaks in a way no test on a fresh
     database can reproduce.
     Every column here that COULD have been added later is repeated as an
     ALTER. Postgres only allows that for a column with a DEFAULT or a nullable
     one, which is the same set — a NOT NULL column with no default was there
     on day one and needs no migration. */
  for (const [table, col] of [
    ['site_pages', `design JSONB NOT NULL DEFAULT '{}'`],
    ['site_pages', `nav_label TEXT NOT NULL DEFAULT ''`],
    ['site_pages', `show_in_nav BOOLEAN NOT NULL DEFAULT true`],
    ['site_pages', `nav_order INT NOT NULL DEFAULT 50`],
    ['site_pages', `seo_title TEXT NOT NULL DEFAULT ''`],
    ['site_pages', `seo_description TEXT NOT NULL DEFAULT ''`],
    ['site_pages', `seo_keywords TEXT NOT NULL DEFAULT ''`],
    ['site_pages', `og_image TEXT NOT NULL DEFAULT ''`],
    ['site_pages', `noindex BOOLEAN NOT NULL DEFAULT false`],
    ['site_pages', `blocks JSONB NOT NULL DEFAULT '[]'`],
    ['site_pages', `published BOOLEAN NOT NULL DEFAULT true`],
    ['site_posts', `excerpt TEXT NOT NULL DEFAULT ''`],
    ['site_posts', `cover TEXT NOT NULL DEFAULT ''`],
    ['site_posts', `body TEXT NOT NULL DEFAULT ''`],
    ['site_posts', `author TEXT NOT NULL DEFAULT ''`],
    ['site_posts', `tags JSONB NOT NULL DEFAULT '[]'`],
    ['site_posts', `seo_title TEXT NOT NULL DEFAULT ''`],
    ['site_posts', `seo_description TEXT NOT NULL DEFAULT ''`],
    ['site_posts', `seo_keywords TEXT NOT NULL DEFAULT ''`],
    ['site_posts', `noindex BOOLEAN NOT NULL DEFAULT false`],
    ['site_posts', `published BOOLEAN NOT NULL DEFAULT true`]
  ] as const) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col}`);
  }
}

// ----------------------------------------------------------------- memory ----

let _memPages: SitePage[] | null = null;
let _memPosts: SitePost[] | null = null;
let _memSettings: SiteSettings | null = null;

// --------------------------------------------------------------- defaults ----

export const SETTINGS_DEFAULTS: SiteSettings = {
  siteName: 'پرایز کوئیز',
  tagline: 'مسابقهٔ آنلاین اطلاعات عمومی با جایزهٔ نقدی',
  baseUrl: 'https://www.prizequiz.ir',
  description: 'پرایز کوئیز یک بازی مسابقه‌ای آنلاین فارسی است: دوئل زنده با بازیکن‌های واقعی، آخرین بازمانده، ثبت رکورد و جدول امتیازات هفتگی. رایگان بازی کن یا در مسابقه‌های جایزه‌دار شرکت کن.',
  keywords: 'بازی اطلاعات عمومی, مسابقه آنلاین, کوییز فارسی, بازی جایزه دار, دوئل آنلاین, سوالات اطلاعات عمومی, بازی ایرانی',
  ogImage: '/og-cover.png',
  logoEmoji: '🎯',
  playUrl: '/play',
  homePath: '/home',
  androidUrl: '',
  iosUrl: '',
  bazaarUrl: '',
  myketUrl: '',
  email: 'support@prizequiz.ir',
  phone: '',
  address: '',
  telegram: '',
  instagram: '',
  twitter: '',
  googleVerification: '',
  enamadHtml: '',
  footerNote: 'تمامی حقوق برای پرایز کوئیز محفوظ است.',
  footerAbout: 'مسابقهٔ آنلاین اطلاعات عمومی، با بازیکن‌های واقعی و جایزهٔ واقعی.',
  copyright: '© پرایز کوئیز',
  /* A starting point, not a fixture: every row is editable and the whole list
     can be emptied, which removes the columns rather than printing headings
     with nothing under them. */
  footerColumns: [
    { title: 'بازی', links: [{ label: 'راهنمای بازی', href: '/how-to-play' }, { label: 'دانلود بازی', href: '/download' }] },
    { title: 'پرایز کوئیز', links: [{ label: 'دربارهٔ ما', href: '/about' }, { label: 'وبلاگ', href: '/blog' }, { label: 'تماس با ما', href: '/contact' }] },
    { title: 'قوانین', links: [{ label: 'حریم خصوصی', href: '/privacy' }, { label: 'قوانین و مقررات', href: '/terms' }, { label: 'سؤالات متداول', href: '/faq' }] }
  ],
  ctaPlay: 'بازی کن',
  ctaLogin: 'ورود',
  loginUrl: '/play',
  topicsUrl: '/topics',
  howToPlayUrl: '/how-to-play',
  labelHome: 'خانه',
  labelToc: 'در این صفحه',
  labelRelated: 'بیشتر بخوان',
  labelBlog: 'وبلاگ',
  labelNoPosts: 'هنوز مقاله‌ای منتشر نشده.',
  labelMoreArticles: 'مقاله‌های دیگر',
  postCtaTitle: 'امتحانش کن',
  postCtaSubtitle: 'همین سؤال‌ها را در دوئل با یک بازیکن واقعی بازی کن.',
  postCtaLabel: 'شروع بازی',
  liveLeaderTitle: 'صدرنشین‌های این هفته',
  liveLeaderPeriod: 'هفتگی',
  livePulseLabel: 'مسابقه‌های امروز',
  livePulseUnit: 'از نیمه‌شب تا الان',
  livePulsePlayers: 'بازیکن روی جدول این هفته',
  liveWinnerVerb: '{name} برندهٔ {mode} شد',
  liveStatPlayers: 'بازیکن',
  liveStatMatches: 'مسابقهٔ انجام‌شده',
  liveStatToday: 'مسابقهٔ امروز',
  liveStatWeek: 'بازیکن فعال این هفته',
  notFoundTitle: 'این صفحه پیدا نشد',
  notFoundText: 'شاید نشانی را اشتباه وارد کرده‌ای، یا این صفحه برداشته شده.',
  notFoundLabel: 'برگرد به خانه',
  enabled: true,
  updatedAt: new Date().toISOString()
};

const P = (o: Partial<SitePage> & { slug: string; title: string }): SitePage => ({
  navLabel: o.title, showInNav: true, navOrder: 50,
  seoTitle: '', seoDescription: '', seoKeywords: '', ogImage: '', noindex: false,
  blocks: [], published: true, updatedAt: new Date().toISOString(), ...o
});

/* The site as it ships. Every word here is meant to be replaced by whoever
 * knows the business best — these are a real starting point, not lorem. */
function seedPages(): SitePage[] {
  return [
    P({
      slug: 'home', title: 'پرایز کوئیز', navLabel: 'خانه', navOrder: 1,
      /* The artwork the design is built around. Every one of these is a plain
         editable field — an operator can swap the character, or clear it and
         get the plain card back — but they SHIP filled, because a design whose
         illustrations only appear once somebody fills in eighteen empty boxes
         is a design nobody ever sees. */
      kicker: 'بازی آنلاین اطلاعات عمومی',
      heroCharacter: 'char-hero.png',
      heroButtons: [
        { label: '🎮 شروع بازی', href: '{play}' },
        { label: '📥 دانلود بازی', href: '/download' }
      ],
      intro: 'با بازیکن‌های واقعی دوئل کن، در «آخرین بازمانده» تا آخر بمان و رکورد بزن — همه به فارسی.',
      seoTitle: 'پرایز کوئیز | بازی آنلاین اطلاعات عمومی با جایزه',
      seoDescription: 'با بازیکن‌های واقعی دوئل کن، در «آخرین بازمانده» تا آخر بمان و رکورد بزن. بازی مسابقه‌ای فارسی، رایگان و جایزه‌دار.',
      seoKeywords: 'بازی اطلاعات عمومی, مسابقه آنلاین, کوییز فارسی, بازی جایزه دار',
      blocks: [
        { kind: 'hero', title: 'بدان، جواب بده، ببر', subtitle: 'مسابقهٔ آنلاین اطلاعات عمومی با بازیکن‌های واقعی. دوئل زنده، آخرین بازمانده، ثبت رکورد — همه به فارسی.', ctaText: '🎮 شروع بازی', ctaHref: '{play}', ctaText2: '📥 دانلود بازی', ctaHref2: '/download' },
        { kind: 'cards', title: 'چه حالت‌هایی داری؟', items: [
          { icon: '⚔️', title: 'دوئل', character: 'char-cyclops.png', text: 'رودررو با یک بازیکن واقعی. هر دو یک سؤال می‌بینید و سرعت و دقت تعیین می‌کند چه کسی می‌برد.' },
          { icon: '🏝️', title: 'آخرین بازمانده', character: 'char-crown.png', text: 'همه با هم شروع می‌کنند و هر جواب غلط یک نفر را حذف می‌کند. هر که بیشتر بماند، سهم بیشتری می‌برد.' },
          { icon: '🏅', title: 'ثبت رکورد', character: 'char-winner.png', text: 'تا آخرین قلب جواب بده و رکورد بزن. هر موضوع جدول رکورد جداگانهٔ خودش را دارد.' },
          { icon: '🎯', title: 'مأموریت‌ها', character: 'char-scholar.png', text: 'روزانه، هفتگی و دستاوردهای بلندمدت. هر مأموریت جایزهٔ خودش را دارد.' }
        ] },
        { kind: 'steps', title: 'در سه قدم شروع کن', items: [
          { title: 'ثبت‌نام با شمارهٔ موبایل', text: 'یک کد پیامکی، بدون رمز و بدون فرم طولانی.' },
          { title: 'حالت بازی را انتخاب کن', text: 'دوستانه برای تمرین و رکوردزدن، یا رقابت اصلی برای جایزه.' },
          { title: 'بازی کن و بالا برو', text: 'امتیاز جمع کن، در جدول هفتگی بالا بیا و جایزه‌ات را بگیر.' }
        ] },
        { kind: 'cards', title: 'چرا پرایز کوئیز؟', items: [
          { icon: '👥', title: 'حریف واقعی', text: 'مقابل آدم‌های واقعی بازی می‌کنی، نه ربات. هر مسابقه زنده است.' },
          { icon: '🧠', title: 'بانک سؤال بزرگ', text: 'ده‌ها موضوع از ورزش و تاریخ تا علم و سینما، با چند سطح سختی.' },
          { icon: '⚖️', title: 'امتیازدهی روی سرور', text: 'امتیاز و رکورد را سرور می‌شمارد، نه گوشی — جدول‌ها واقعی‌اند.' },
          { icon: '💳', title: 'برداشت شفاف', text: 'موجودی و گردش حساب همیشه در دسترس است و برداشت به حساب خودت واریز می‌شود.' }
        ] },
        { kind: 'callout', title: 'رایگان هم می‌شود بازی کرد', character: 'char-free.png', body: 'حالت دوستانه ورودی ندارد: با قلب بازی می‌کنی، رکورد می‌زنی و تمرین می‌کنی. رقابت اصلی هر وقت خواستی، همان‌جاست.' },
        { kind: 'cta', title: 'همین حالا شروع کن', body: 'ثبت‌نام رایگان است و اولین بازی‌ات چند ثانیه با تو فاصله دارد.', ctaText: 'بزن بریم', ctaHref: '{play}', character: 'char-cheer.png' }
      ]
    }),
    P({
      slug: 'download', title: 'دانلود بازی', navOrder: 2,
      heroCharacter: 'char-free.png',
      seoTitle: 'دانلود پرایز کوئیز | نسخهٔ اندروید و وب',
      seoDescription: 'پرایز کوئیز را روی اندروید نصب کن یا بدون نصب در مرورگر بازی کن. نصب سریع، حجم کم، بدون نیاز به رمز.',
      seoKeywords: 'دانلود بازی اطلاعات عمومی, دانلود کوییز فارسی, نصب پرایز کوئیز',
      blocks: [
        { kind: 'hero', title: 'پرایز کوئیز را نصب کن', subtitle: 'روی گوشی نصبش کن یا همین‌جا در مرورگر بازی کن — هر دو یک حساب و یک پیشرفت.', ctaText: '🎮 بازی در مرورگر', ctaHref: '{play}' },
        { kind: 'cards', title: 'راه‌های نصب', items: [
          { icon: '🤖', title: 'اندروید (APK)', text: 'فایل نصبی مستقیم. اگر گوشی هشدار «منبع ناشناس» داد، از تنظیمات اجازهٔ نصب بده.' },
          { icon: '🛍️', title: 'کافه بازار', text: 'نسخهٔ بازار، با به‌روزرسانی خودکار.' },
          { icon: '🟣', title: 'مایکت', text: 'برای کسانی که مایکت را ترجیح می‌دهند.' },
          { icon: '🌐', title: 'بدون نصب', text: 'در مرورگر باز کن و «افزودن به صفحهٔ اصلی» را بزن — مثل یک اپ کار می‌کند.' }
        ] },
        { kind: 'text', title: 'حداقل نیازها', body: 'اندروید ۷ به بالا یا هر مرورگر به‌روز (کروم، فایرفاکس، سافاری).\nاینترنت پایدار — بازی زنده است و با حریف واقعی هماهنگ می‌شود.\nحدود ۳۰ مگابایت فضای خالی برای نسخهٔ نصبی.' },
        { kind: 'faq', title: 'سؤال‌های نصب', items: [
          { q: 'نسخهٔ iOS دارید؟', a: 'نسخهٔ نصبی iOS فعلاً منتشر نشده، اما بازی در سافاری کامل کار می‌کند. از منوی اشتراک‌گذاری «افزودن به صفحهٔ اصلی» را بزن تا مثل اپ باز شود.' },
          { q: 'با یک حساب روی دو دستگاه می‌شود بازی کرد؟', a: 'بله. با همان شمارهٔ موبایل وارد شو؛ پیشرفت، موجودی و رکوردها روی حساب تو هستند نه روی دستگاه.' },
          { q: 'نصب هزینه دارد؟', a: 'خیر. نصب و ثبت‌نام رایگان است. فقط شرکت در مسابقه‌های جایزه‌دار بلیت لازم دارد.' }
        ] }
      ]
    }),
    P({
      slug: 'about', title: 'دربارهٔ ما', navOrder: 3,
      heroCharacter: 'char-king.png',
      seoTitle: 'دربارهٔ پرایز کوئیز | ما که هستیم',
      seoDescription: 'پرایز کوئیز را یک تیم ایرانی می‌سازد؛ یک بازی مسابقه‌ای منصفانه و فارسی که در آن دانستن، برنده شدن است.',
      seoKeywords: 'درباره پرایز کوئیز, تیم پرایز کوئیز, بازی ایرانی',
      blocks: [
        { kind: 'hero', title: 'ما یک بازی منصفانه می‌خواستیم', subtitle: 'بازی‌ای که در آن چیزی که می‌دانی تعیین‌کننده باشد، نه چیزی که خریده‌ای.' },
        { kind: 'text', title: 'داستان', body: 'پرایز کوئیز از یک ایراد ساده شروع شد: بیشتر بازی‌های مسابقه‌ای فارسی یا حریف واقعی نداشتند، یا برنده‌شدن در آن‌ها بیشتر به خرید بستگی داشت تا به دانستن.\nما بازی‌ای ساختیم که مقابل آدم‌های واقعی است، امتیازش را سرور می‌شمارد، و جدول‌هایش قابل اعتمادند.\nهمهٔ سؤال‌ها پیش از انتشار بازبینی می‌شوند و هر بازیکن می‌تواند سؤال اشتباه را گزارش کند.' },
        { kind: 'cards', title: 'چیزی که برایمان مهم است', items: [
          { icon: '⚖️', title: 'انصاف', text: 'امتیاز و رکورد سمت سرور شمرده می‌شود و هیچ خریدی جواب درست را به تو نمی‌گوید.' },
          { icon: '🔍', title: 'شفافیت', text: 'گردش حساب، جایزه و کارمزد همیشه قابل دیدن است.' },
          { icon: '🇮🇷', title: 'فارسی، درست', text: 'راست‌به‌چپ، اعداد فارسی و سؤال‌هایی که برای مخاطب فارسی نوشته شده‌اند.' },
          { icon: '🛡️', title: 'بازی سالم', text: 'محدودیت سنی، سقف بازی و ابزار گزارش تخلف.' }
        ] },
        { kind: 'cta', title: 'حرفی داری؟', body: 'انتقاد، پیشنهاد یا گزارش اشکال — همه را می‌خوانیم.', ctaText: 'تماس با ما', ctaHref: '/contact' }
      ]
    }),
    P({
      slug: 'how-to-play', title: 'راهنمای بازی', navOrder: 4,
      heroCharacter: 'char-scholar.png',
      seoTitle: 'آموزش بازی پرایز کوئیز | قوانین و راهنمای کامل',
      seoDescription: 'راهنمای کامل پرایز کوئیز: دوئل، آخرین بازمانده، ثبت رکورد، قلب‌ها، بلیت‌ها، کمک‌ها و نحوهٔ امتیازدهی.',
      seoKeywords: 'آموزش بازی اطلاعات عمومی, قوانین کوییز, راهنمای پرایز کوئیز',
      blocks: [
        { kind: 'hero', title: 'همه‌چیز دربارهٔ نحوهٔ بازی', subtitle: 'از اولین سؤال تا جدول رکوردها.' },
        { kind: 'steps', title: 'دوئل چطور کار می‌کند؟', items: [
          { title: 'پیدا کردن حریف', text: 'سیستم بر اساس سطح تو یک بازیکن واقعی پیدا می‌کند.' },
          { title: 'انتخاب موضوع', text: 'یک سؤال سریع تعیین می‌کند چه کسی موضوع را انتخاب کند.' },
          { title: 'سؤال‌ها', text: 'هر دو نفر هم‌زمان یک سؤال را می‌بینید. سرعت پاسخ در امتیاز اثر دارد.' },
          { title: 'نتیجه', text: 'برنده جایزه و XP می‌گیرد؛ هر دو در جدول هفتگی امتیاز می‌گیرید.' }
        ] },
        { kind: 'cards', title: 'قلب، بلیت و سکه', items: [
          { icon: '❤️', title: 'قلب', text: 'برای ورود به «ثبت رکورد» لازم است و هر ساعت خودش شارژ می‌شود.' },
          { icon: '🎫', title: 'بلیت', text: 'ورودی مسابقه‌های جایزه‌دار. رنگ بلیت، سهم تو از جایزه را تعیین می‌کند.' },
          { icon: '🪙', title: 'سکه', text: 'واحد داخل بازی برای خرید کمک‌ها و آیتم‌ها.' },
          { icon: '🏆', title: 'کاپ هفتگی', text: 'امتیاز جدول هفتگی که هر هفته صفر می‌شود.' }
        ] },
        { kind: 'cards', title: 'چهار کمک', items: [
          { icon: '✂️', title: '۵۰:۵۰', text: 'دو گزینهٔ غلط حذف می‌شود.' },
          { icon: '🔁', title: 'انتخاب دوم', text: 'اگر جواب اول غلط بود، یک انتخاب دیگر داری.' },
          { icon: '📊', title: 'درصد بقیه', text: 'می‌بینی بقیه چه جوابی داده‌اند.' },
          { icon: '⏱️', title: 'وقت اضافه', text: 'به زمان همان سؤال اضافه می‌کند.' }
        ] },
        { kind: 'faq', title: 'سؤال‌های رایج بازی', items: [
          { q: 'اگر اینترنتم قطع شود چه می‌شود؟', a: 'اگر وسط دوئل قطع شوی و برنگردی، بازی به نفع حریف تمام می‌شود. اگر هنوز مسابقه شروع نشده باشد، بلیت‌ات برمی‌گردد.' },
          { q: 'سؤال اشتباه دیدم، چه کار کنم؟', a: 'روی همان سؤال دکمهٔ گزارش هست. گزارش‌ها بازبینی می‌شوند و سؤال غلط اصلاح یا حذف می‌شود.' },
          { q: 'رکوردزنی روی رقابت اصلی اثر دارد؟', a: 'خیر. «ثبت رکورد» جدول خودش را دارد و روی جایزه‌ها اثر نمی‌گذارد؛ فقط مأموریت‌ها آن را می‌بینند.' }
        ] }
      ]
    }),
    P({
      slug: 'faq', title: 'سؤالات متداول', navOrder: 5,
      heroCharacter: 'char-thinking.png',
      seoTitle: 'سؤالات متداول پرایز کوئیز',
      seoDescription: 'پاسخ پرسش‌های پرتکرار دربارهٔ ثبت‌نام، جایزه، برداشت وجه، بلیت و امنیت حساب در پرایز کوئیز.',
      seoKeywords: 'سوالات متداول پرایز کوئیز, برداشت جایزه, ثبت نام کوییز',
      blocks: [
        { kind: 'hero', title: 'سؤالات متداول', subtitle: 'اگر جوابت اینجا نبود، از صفحهٔ تماس بپرس.' },
        { kind: 'faq', title: 'حساب کاربری', items: [
          { q: 'چطور ثبت‌نام کنم؟', a: 'شمارهٔ موبایلت را وارد کن و کد پیامکی را بزن. رمز عبوری در کار نیست.' },
          { q: 'شماره‌ام را عوض کرده‌ام.', a: 'از بخش تنظیمات حساب می‌توانی شماره را تغییر بدهی؛ برای تأیید یک کد به شمارهٔ جدید فرستاده می‌شود.' },
          { q: 'می‌توانم حسابم را حذف کنم؟', a: 'بله. از صفحهٔ تماس درخواست بده؛ حساب و اطلاعات شخصی‌ات حذف می‌شود. سوابق مالی طبق قانون برای مدت لازم نگهداری می‌شود.' }
        ] },
        { kind: 'faq', title: 'جایزه و پرداخت', items: [
          { q: 'جایزه چطور محاسبه می‌شود؟', a: 'جایزه از مجموع ورودی‌های همان مسابقه ساخته می‌شود و پس از کسر کارمزد پلتفرم بین برنده‌ها تقسیم می‌شود. عددی که در بازی می‌بینی مبلغ نهایی و خالص است.' },
          { q: 'چطور برداشت کنم؟', a: 'از کیف پول، شمارهٔ شبا به نام خودت را ثبت کن و درخواست برداشت بده. پس از بررسی، مبلغ به همان حساب واریز می‌شود.' },
          { q: 'چقدر طول می‌کشد؟', a: 'بررسی معمولاً در ساعات کاری انجام می‌شود و واریز بسته به بانک ممکن است تا چند روز کاری زمان ببرد.' },
          { q: 'حساب باید به نام خودم باشد؟', a: 'بله. برداشت فقط به حسابی که به نام صاحب همان شمارهٔ موبایل است انجام می‌شود.' }
        ] },
        { kind: 'faq', title: 'بازی و امنیت', items: [
          { q: 'تقلب را چطور جلوی می‌گیرید؟', a: 'امتیاز و زمان پاسخ روی سرور محاسبه می‌شود و الگوهای غیرعادی بررسی می‌شوند. حساب متخلف محدود می‌شود.' },
          { q: 'بازی برای چه سنی است؟', a: 'شرکت در بخش‌های جایزه‌دار مخصوص افراد بالای ۱۸ سال است.' },
          { q: 'قلب‌ها چه زمانی پر می‌شوند؟', a: 'به‌صورت خودکار و ساعتی. زمان باقی‌مانده تا قلب بعدی در خود بازی نمایش داده می‌شود.' }
        ] }
      ]
    }),
    P({
      slug: 'contact', title: 'تماس با ما', navOrder: 6,
      heroCharacter: 'char-cheer.png',
      seoTitle: 'تماس با پرایز کوئیز | پشتیبانی',
      seoDescription: 'راه‌های ارتباط با پشتیبانی پرایز کوئیز: ایمیل، پیام در بازی و شبکه‌های اجتماعی.',
      seoKeywords: 'تماس با پرایز کوئیز, پشتیبانی کوییز',
      blocks: [
        { kind: 'hero', title: 'با ما حرف بزن', subtitle: 'سریع‌ترین راه، بخش پشتیبانی داخل خود بازی است — چون حسابت آنجا شناخته می‌شود.' },
        { kind: 'cards', title: 'راه‌های ارتباط', items: [
          { icon: '💬', title: 'پشتیبانی در بازی', text: 'از منوی بازی → پشتیبانی. تیکت تو به حسابت وصل است و پیگیری‌اش ساده‌تر است.' },
          { icon: '✉️', title: 'ایمیل', text: 'برای موضوع‌های مالی و حقوقی.' },
          { icon: '📣', title: 'شبکه‌های اجتماعی', text: 'خبر مسابقه‌ها و به‌روزرسانی‌ها را آنجا اعلام می‌کنیم.' }
        ] },
        { kind: 'text', title: 'قبل از تماس', body: 'اگر مشکل مالی است، شمارهٔ پیگیری تراکنش را آماده داشته باش.\nاگر اشکال فنی است، مدل گوشی و نسخهٔ بازی را بنویس — در تنظیمات بازی دیده می‌شود.\nپاسخ‌گویی در ساعات کاری انجام می‌شود.' }
      ]
    }),
    P({
      slug: 'privacy', title: 'حریم خصوصی', navOrder: 7,
      heroCharacter: 'char-wizard-blue.png',
      seoTitle: 'سیاست حریم خصوصی | پرایز کوئیز',
      seoDescription: 'چه اطلاعاتی از شما جمع‌آوری می‌کنیم، چرا، چقدر نگه می‌داریم و شما چه حقی نسبت به آن دارید.',
      seoKeywords: 'حریم خصوصی, سیاست حفظ اطلاعات',
      blocks: [
        { kind: 'hero', title: 'سیاست حریم خصوصی', subtitle: 'کوتاه و بدون پیچیدگی: چه چیزی جمع می‌کنیم، چرا، و چطور می‌توانی حذفش کنی.' },
        { kind: 'text', title: '۱) چه اطلاعاتی جمع‌آوری می‌شود', body: 'شمارهٔ موبایل: برای ورود و تأیید هویت. بدون آن حساب ساخته نمی‌شود.\nنام نمایشی و عکس پروفایل: اختیاری و توسط خودت وارد می‌شود.\nاطلاعات بازی: امتیاز، رکورد، تاریخچهٔ مسابقه‌ها و موجودی.\nاطلاعات پرداخت: برای برداشت، نام و شمارهٔ شبا. اطلاعات کارت بانکی هرگز نزد ما ذخیره نمی‌شود و پرداخت در درگاه بانکی انجام می‌گیرد.\nاطلاعات فنی: مدل دستگاه، نسخهٔ اپ و نشانی IP، برای تشخیص خطا و جلوگیری از تقلب.' },
        { kind: 'text', title: '۲) چرا', body: 'برای اینکه بازی کار کند: ورود، هماهنگی مسابقهٔ زنده، ثبت امتیاز و پرداخت جایزه.\nبرای امنیت: تشخیص تقلب، حساب‌های تکراری و سوءاستفادهٔ مالی.\nبرای بهتر شدن بازی: دیدن اینکه کدام بخش‌ها اشکال دارند.\nاطلاعات شخصی برای فروش یا تبلیغات به شخص ثالث داده نمی‌شود.' },
        { kind: 'text', title: '۳) اشتراک‌گذاری با دیگران', body: 'درگاه پرداخت: فقط اطلاعات لازم برای انجام تراکنش.\nسرویس پیامک: شمارهٔ موبایل، فقط برای ارسال کد ورود.\nمراجع قانونی: در صورت درخواست رسمی و در چارچوب قانون.' },
        { kind: 'text', title: '۴) نگهداری و حذف', body: 'اطلاعات حساب تا زمانی که حساب فعال است نگهداری می‌شود.\nبا درخواست حذف حساب، اطلاعات شخصی حذف می‌شود؛ سوابق مالی طبق الزام قانونی برای مدت مقرر نگهداری می‌شود.\nبرای حذف حساب از صفحهٔ تماس درخواست بده.' },
        { kind: 'text', title: '۵) حقوق تو', body: 'دیدن اطلاعاتی که از تو داریم.\nاصلاح اطلاعات نادرست.\nدرخواست حذف حساب.\nانصراف از دریافت اعلان‌های تبلیغاتی، بدون اثر بر اعلان‌های ضروری حساب.' },
        { kind: 'text', title: '۶) امنیت', body: 'ارتباط با سرور رمزگذاری‌شده است.\nدسترسی کارکنان به اطلاعات کاربران محدود و ثبت‌شده است.\nهیچ سامانه‌ای صددرصد مصون نیست؛ در صورت رخداد امنیتی مؤثر، به کاربران اطلاع داده می‌شود.' },
        { kind: 'text', title: '۷) تغییرات این سیاست', body: 'در صورت تغییر، نسخهٔ به‌روز در همین صفحه منتشر و تاریخ آن درج می‌شود. ادامهٔ استفاده از بازی به معنای پذیرش نسخهٔ جدید است.' }
      ]
    }),
    P({
      slug: 'terms', title: 'قوانین و مقررات', navOrder: 8,
      heroCharacter: 'char-wizard-purple.png',
      seoTitle: 'قوانین و مقررات استفاده | پرایز کوئیز',
      seoDescription: 'شرایط استفاده از پرایز کوئیز: حساب کاربری، مسابقه‌ها، جوایز، پرداخت، برداشت و موارد تخلف.',
      seoKeywords: 'قوانین پرایز کوئیز, شرایط استفاده',
      blocks: [
        { kind: 'hero', title: 'قوانین و مقررات', subtitle: 'با ساختن حساب، این شرایط را می‌پذیری.' },
        { kind: 'text', title: '۱) حساب کاربری', body: 'هر شخص فقط یک حساب می‌تواند داشته باشد. حساب‌های تکراری مسدود می‌شوند.\nاطلاعاتی که وارد می‌کنی باید درست و متعلق به خودت باشد.\nمسئولیت حفظ دسترسی به شمارهٔ موبایل و حساب با خودت است.\nحساب قابل خرید، فروش یا انتقال نیست.' },
        { kind: 'text', title: '۲) شرکت در مسابقه‌ها', body: 'شرکت در بخش‌های جایزه‌دار مخصوص افراد بالای ۱۸ سال است.\nورودی مسابقه با بلیت پرداخت می‌شود و پس از شروع مسابقه بازگشتی نیست.\nاگر مسابقه به دلیل فنی از سمت ما شروع نشود، ورودی برمی‌گردد.\nترک عمدی مسابقه به معنای باخت است.' },
        { kind: 'text', title: '۳) جایزه و کارمزد', body: 'جایزه از مجموع ورودی‌های همان مسابقه تشکیل می‌شود.\nپلتفرم کارمزد مشخصی برمی‌دارد و باقی‌مانده بین برنده‌ها تقسیم می‌شود. مبلغی که در بازی نمایش داده می‌شود مبلغ نهایی و خالص است.\nاگر در «آخرین بازمانده» همهٔ بازیکنان باقی‌مانده حذف شوند، آن دور برنده‌ای ندارد.' },
        { kind: 'text', title: '۴) برداشت وجه', body: 'برداشت فقط به حساب بانکی به نام صاحب همان حساب کاربری انجام می‌شود.\nدرخواست‌ها پس از بررسی پرداخت می‌شوند.\nدرخواست مشکوک به تقلب تا پایان بررسی متوقف می‌شود.' },
        { kind: 'text', title: '۵) رفتار قابل قبول', body: 'استفاده از ربات، اسکریپت، چند حسابی یا هر ابزار کمکی ممنوع است.\nتوهین، مزاحمت و انتشار محتوای نامناسب در چت و نام کاربری ممنوع است.\nتلاش برای اختلال در سرویس ممنوع است.' },
        { kind: 'text', title: '۶) تخلف و پیامد', body: 'بسته به شدت تخلف: هشدار، حذف امتیاز، مسدودسازی برداشت یا مسدودسازی دائم حساب.\nدر تخلف مالی، مبالغ به‌دست‌آمده از تقلب برگردانده می‌شود.' },
        { kind: 'text', title: '۷) تغییر سرویس', body: 'ممکن است بخش‌هایی از بازی تغییر کند، اضافه یا حذف شود. تغییرات مؤثر بر جوایز از قبل اطلاع‌رسانی می‌شود.' },
        { kind: 'text', title: '۸) تماس', body: 'برای هر پرسش دربارهٔ این قوانین از صفحهٔ تماس اقدام کن.' }
      ]
    }),
    P({
      slug: 'blog', title: 'وبلاگ', navOrder: 9,
      heroCharacter: 'char-sunglasses.png',
      seoTitle: 'وبلاگ پرایز کوئیز | سؤال، ترفند و معرفی بازی',
      seoDescription: 'مقاله‌های پرایز کوئیز: مجموعه سؤالات اطلاعات عمومی، معرفی بهترین بازی‌های آنلاین و ترفندهای برد.',
      seoKeywords: 'وبلاگ اطلاعات عمومی, مقاله بازی آنلاین, سوالات اطلاعات عمومی',
      blocks: [
        { kind: 'hero', title: 'وبلاگ', subtitle: 'سؤال‌های تازه، ترفندهای بازی و هر چیزی که به بردنت کمک می‌کند.' }
      ]
    })
  ];
}

const now = () => new Date().toISOString();

function seedPosts(): SitePost[] {
  return [
    {
      slug: '100-general-knowledge-questions',
      title: '۱۰۰ سؤال اطلاعات عمومی با جواب (از آسان تا سخت)',
      excerpt: 'یک مجموعهٔ دسته‌بندی‌شده از سؤال‌های اطلاعات عمومی با پاسخ — برای تمرین، مسابقهٔ خانوادگی یا آمادگی قبل از دوئل.',
      cover: '', author: 'تیم پرایز کوئیز',
      tags: ['اطلاعات عمومی', 'سؤال و جواب', 'تمرین'],
      seoTitle: '۱۰۰ سؤال اطلاعات عمومی با جواب | از آسان تا سخت',
      seoDescription: 'مجموعه‌ای از ۱۰۰ سؤال اطلاعات عمومی با پاسخ، دسته‌بندی‌شده در ایران، جهان، علم، تاریخ، ورزش و سینما. مناسب مسابقه و تمرین.',
      seoKeywords: 'سوالات اطلاعات عمومی, سوال با جواب, مسابقه اطلاعات عمومی, تست اطلاعات عمومی',
      noindex: false, published: true, publishedAt: now(), updatedAt: now(),
      body: [
        'سؤال اطلاعات عمومی خوب آن است که جوابش را یا می‌دانی یا با کمی فکر می‌رسی — نه آن‌که فقط حافظه بخواهد. این فهرست را برای همین جمع کرده‌ایم: برای تمرین قبل از دوئل، برای یک مسابقهٔ خانوادگی، یا فقط برای اینکه ببینی کجا ایستاده‌ای.',
        'سؤال‌ها دسته‌بندی شده‌اند و هر بخش از آسان به سخت می‌رود. جواب هر سؤال بلافاصله بعدش آمده است.',
        '## ایران',
        '- بلندترین قلهٔ ایران کدام است؟ — دماوند',
        '- پایتخت استان فارس کجاست؟ — شیراز',
        '- بزرگ‌ترین دریاچهٔ داخلی ایران؟ — دریاچهٔ ارومیه',
        '- شاعر «شاهنامه» که بود؟ — فردوسی',
        '- خلیج فارس به کدام دریا راه دارد؟ — دریای عمان',
        '- کدام شهر به «شهر بادگیرها» معروف است؟ — یزد',
        '- تخت جمشید در کدام دوره ساخته شد؟ — هخامنشیان',
        '- طولانی‌ترین رودخانهٔ ایران؟ — کارون',
        '## جهان',
        '- پایتخت استرالیا کجاست؟ — کانبرا (نه سیدنی)',
        '- کوچک‌ترین کشور جهان؟ — واتیکان',
        '- رود نیل در کدام قاره است؟ — آفریقا',
        '- کدام کشور بیشترین جمعیت را دارد؟ — هند',
        '- زبان رسمی برزیل چیست؟ — پرتغالی',
        '- دیوار بزرگ در کدام کشور است؟ — چین',
        '## علم و طبیعت',
        '- فرمول شیمیایی آب؟ — H2O',
        '- بزرگ‌ترین سیارهٔ منظومهٔ شمسی؟ — مشتری',
        '- انسان چند دنده دارد؟ — ۲۴ عدد (۱۲ جفت)',
        '- سریع‌ترین جانور خشکی؟ — یوزپلنگ',
        '- نور از خورشید تا زمین چقدر طول می‌کشد؟ — حدود ۸ دقیقه',
        '- کدام گاز بیشترین سهم را در هوای زمین دارد؟ — نیتروژن',
        '## تاریخ',
        '- جنگ جهانی دوم در چه سالی پایان یافت؟ — ۱۹۴۵',
        '- اولین انسانی که به فضا رفت؟ — یوری گاگارین',
        '- چاپ با حروف متحرک را چه کسی رایج کرد؟ — گوتنبرگ',
        '- دیوار برلین در چه سالی فرو ریخت؟ — ۱۹۸۹',
        '## ورزش',
        '- جام جهانی فوتبال هر چند سال یک‌بار است؟ — چهار سال',
        '- در بسکتبال هر تیم چند بازیکن در زمین دارد؟ — پنج',
        '- کشور میزبان جام جهانی ۲۰۲۲؟ — قطر',
        '- طول یک استخر استاندارد المپیک؟ — ۵۰ متر',
        '## سینما و هنر',
        '- کارگردان فیلم «جدایی نادر از سیمین»؟ — اصغر فرهادی',
        '- «مونالیزا» اثر کیست؟ — لئوناردو داوینچی',
        '- اسکار در چه کشوری اهدا می‌شود؟ — آمریکا',
        '## چطور از این فهرست بهتر استفاده کنی',
        'خواندن پشت سر هم کم‌اثر است. این‌طور امتحان کن: هر بار ده سؤال، اول بدون نگاه به جواب. هر کدام را نتوانستی، علامت بزن و فردا دوباره همان‌ها را مرور کن. مغز چیزی را که یک‌بار در بازیابی‌اش شکست خورده، بهتر نگه می‌دارد.',
        'و بعد امتحانش کن: در پرایز کوئیز همین موضوع‌ها را در دوئل با یک بازیکن واقعی بازی کن. فشار زمان چیزی را نشان می‌دهد که مرور آرام نشان نمی‌دهد — اینکه کدام جواب‌ها واقعاً در دسترس‌اند و کدام‌ها فقط آشنا به نظر می‌رسند.'
      ].join('\n')
    },
    {
      slug: 'best-online-quiz-games',
      title: 'بهترین بازی‌های آنلاین اطلاعات عمومی برای فارسی‌زبان‌ها',
      excerpt: 'یک بازی مسابقه‌ای خوب را چه چیزی می‌سازد؟ معیارها را می‌گوییم و بعد سراغ گزینه‌ها می‌رویم.',
      cover: '', author: 'تیم پرایز کوئیز',
      tags: ['معرفی بازی', 'بازی آنلاین', 'اطلاعات عمومی'],
      seoTitle: 'بهترین بازی‌های آنلاین اطلاعات عمومی | راهنمای انتخاب',
      seoDescription: 'راهنمای انتخاب بازی مسابقه‌ای آنلاین: حریف واقعی، کیفیت بانک سؤال، انصاف در امتیازدهی و شفافیت جایزه.',
      seoKeywords: 'بهترین بازی اطلاعات عمومی, بازی آنلاین ایرانی, بازی کوییز, بازی مسابقه ای',
      noindex: false, published: true, publishedAt: now(), updatedAt: now(),
      body: [
        'اگر دنبال یک بازی مسابقه‌ای فارسی می‌گردی، فهرست‌های «بهترین‌ها» معمولاً کمکی نمی‌کنند — چون نمی‌گویند بر چه اساسی. پس اول معیارها، بعد گزینه‌ها.',
        '## چهار چیزی که واقعاً فرق می‌گذارد',
        '### ۱) حریف واقعی یا ربات؟',
        'خیلی از بازی‌های به‌ظاهر آنلاین در واقع تو را مقابل یک ربات می‌گذارند و اسمش را می‌گذارند حریف. راه تشخیص ساده است: چند بار پشت سر هم بازی کن و به الگوی حریف نگاه کن. اگر همیشه دقیقاً یک ثانیه بعد از تو جواب می‌دهد، یا هیچ‌وقت وسط بازی قطع نمی‌شود، احتمالاً آدم نیست.',
        '### ۲) بانک سؤال',
        'یک بازی خوب سؤال تکراری نمی‌دهد و سؤال غلط را سریع اصلاح می‌کند. اگر بعد از یک هفته سؤال‌ها را از بر شدی، بانک کوچک است. وجود دکمهٔ «گزارش سؤال» نشانهٔ خوبی است: یعنی سازنده می‌داند سؤال ممکن است غلط باشد.',
        '### ۳) امتیاز کجا شمرده می‌شود',
        'این مهم‌ترین و کم‌دیده‌ترین معیار است. اگر امتیاز را خود گوشی حساب کند، جدول رتبه‌بندی بی‌معنی است — چون هر کسی که بتواند اپ را دستکاری کند، می‌تواند هر عددی بسازد. در بازی‌های جدی، سرور می‌شمارد.',
        '### ۴) شفافیت جایزه',
        'اگر بازی جایزهٔ نقدی دارد، باید بتوانی ببینی جایزه از کجا می‌آید، چقدر کارمزد برداشته می‌شود و مبلغی که می‌بینی خالص است یا ناخالص. نبودن این اطلاعات، خودش یک جواب است.',
        '## پرایز کوئیز',
        'ما همین چهار معیار را نقطهٔ شروع ساخت گذاشتیم:',
        '- دوئل مقابل بازیکن واقعی، با هماهنگی زندهٔ سؤال بین دو گوشی.',
        '- ده‌ها موضوع و چند سطح سختی، با گزارش سؤال برای هر سؤال.',
        '- امتیاز، رکورد و زمان پاسخ همه روی سرور محاسبه می‌شوند.',
        '- مبلغی که به‌عنوان جایزه می‌بینی، مبلغ نهایی بعد از کارمزد است.',
        'به‌جز دوئل، دو حالت دیگر هم هست: «آخرین بازمانده» که همه با هم شروع می‌کنند و هر جواب غلط یک نفر را حذف می‌کند، و «ثبت رکورد» که تا آخرین قلب ادامه می‌دهی و برای هر موضوع جدول جداگانه دارد.',
        '## چطور انتخاب کنی',
        'دو یا سه بازی را یک هفته امتحان کن و به یک چیز نگاه کن: بعد از باخت، حس می‌کنی حریف بهتر بود یا بازی ناعادلانه بود؟ بازی خوب آن است که باختش هم منطقی باشد.',
        'اگر خواستی همین حالا امتحان کنی، ثبت‌نام رایگان است و اولین دوئلت چند ثانیه بعد شروع می‌شود.'
      ].join('\n')
    }
  ];
}

// ------------------------------------------------------------------- read ----

/* The redesign's page-level extras — hero, sidebar, related links, the closing
 * band. One JSON column rather than nine, because they arrive and leave
 * together and several of them are lists: nine columns would be nine
 * migrations for one feature. A row written before the column existed reads
 * back as {} and the page renders exactly as it used to. */
function rowToPage(r: any): SitePage {
  const d = (r.design && typeof r.design === 'object' && !Array.isArray(r.design)) ? r.design : {};
  return {
    slug: String(r.slug), title: String(r.title ?? ''), navLabel: String(r.nav_label ?? r.title ?? ''),
    showInNav: r.show_in_nav !== false, navOrder: Number(r.nav_order ?? 50),
    seoTitle: String(r.seo_title ?? ''), seoDescription: String(r.seo_description ?? ''),
    seoKeywords: String(r.seo_keywords ?? ''), ogImage: String(r.og_image ?? ''),
    noindex: !!r.noindex,
    ...cleanDesign(d),
    blocks: Array.isArray(r.blocks) ? r.blocks : [],
    published: r.published !== false,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : now()
  };
}

/** The page-level design fields, taken apart safely. Anything malformed is
 *  dropped rather than rendered — this is admin-authored JSON. */
export function cleanDesign(d: any): Pick<SitePage, 'kicker' | 'intro' | 'heroCharacter' | 'heroButtons' | 'metaLine' | 'showToc' | 'asideCta' | 'related' | 'cta'> {
  const str = (v: unknown, max = 400) => String(v ?? '').trim().slice(0, max);
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const out: any = {};
  if (str(d.kicker, 80)) out.kicker = str(d.kicker, 80);
  if (str(d.intro, 600)) out.intro = str(d.intro, 600);
  if (str(d.heroCharacter, 200)) out.heroCharacter = str(d.heroCharacter, 200);
  const buttons = arr(d.heroButtons).map((b: any) => ({ label: str(b?.label, 60), href: str(b?.href, 300) }))
    .filter((b: any) => b.label && b.href).slice(0, 3);
  if (buttons.length) out.heroButtons = buttons;
  const meta = arr(d.metaLine).map((x: any) => str(x, 80)).filter(Boolean).slice(0, 4);
  if (meta.length) out.metaLine = meta;
  if (d.showToc === true) out.showToc = true;
  const ac = d.asideCta;
  if (ac && str(ac.text, 200) && str(ac.label, 60) && str(ac.href, 300)) {
    out.asideCta = { text: str(ac.text, 200), label: str(ac.label, 60), href: str(ac.href, 300),
      ...(str(ac.character, 200) ? { character: str(ac.character, 200) } : {}) };
  }
  const rel = arr(d.related).map((x: any) => ({ title: str(x?.title, 120), meta: str(x?.meta, 120), href: str(x?.href, 300) }))
    .filter((x: any) => x.title && x.href).slice(0, 6);
  if (rel.length) out.related = rel;
  const c = d.cta;
  if (c && str(c.title, 160) && str(c.label, 60) && str(c.href, 300)) {
    out.cta = { title: str(c.title, 160), subtitle: str(c.subtitle, 300), label: str(c.label, 60), href: str(c.href, 300),
      ...(str(c.character, 200) ? { character: str(c.character, 200) } : {}) };
  }
  return out;
}
function rowToPost(r: any): SitePost {
  return {
    slug: String(r.slug), title: String(r.title ?? ''), excerpt: String(r.excerpt ?? ''),
    cover: String(r.cover ?? ''), body: String(r.body ?? ''), author: String(r.author ?? ''),
    tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
    seoTitle: String(r.seo_title ?? ''), seoDescription: String(r.seo_description ?? ''),
    seoKeywords: String(r.seo_keywords ?? ''), noindex: !!r.noindex,
    published: r.published !== false,
    publishedAt: r.published_at ? new Date(r.published_at).toISOString() : now(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : now()
  };
}

/* A PROMISE, not a boolean. Latching a boolean at the top of the function
 * marked seeding "done" the instant it STARTED, so a caller arriving a
 * microtask later — which is exactly what Promise.all([listPages, listPosts])
 * does — sailed past and read an empty store. The blog shipped with no
 * articles on the very first request after a cold start, and looked fine on
 * the second. Everyone now awaits the same run. */
let _seeding: Promise<void> | null = null;
function seedIfEmpty(): Promise<void> {
  _seeding ??= seedOnce().catch((e) => { _seeding = null; throw e; });
  return _seeding;
}
async function seedOnce(): Promise<void> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM site_pages`);
    if (Number(rows[0]?.n ?? 0) > 0) { await backfillShippedDesign(); return; }
  } else if (_memPages && _memPages.length) { await backfillShippedDesign(); return; }
  else { _memPages = []; _memPosts = []; }
  for (const p of seedPages()) await savePage(p);
  for (const p of seedPosts()) await savePost(p);
  /* A store seeded from this version already IS the current design, so the
     backfill has nothing to do and must never run over it later. */
  await saveSettings({ designBackfilled: true });
  logger.info('site_content_seeded', { pages: seedPages().length, posts: seedPosts().length });
}

/* Every stored page, WITHOUT going through listPages — which calls the seeder,
 * which calls this, which would never return. */
async function rawPages(): Promise<SitePage[]> {
  const pool = pg();
  if (!pool) return (_memPages ?? []).slice();
  const { rows } = await pool.query(`SELECT * FROM site_pages`);
  return rows.map(rowToPage);
}

/* WHAT A SITE THAT IS ALREADY LIVE GETS FROM A NEW DESIGN.
 *
 * The seed above only ever runs into an EMPTY store, which is right — nobody
 * wants a deploy to overwrite the words they wrote. But it also means a design
 * that ships new slots reaches exactly nobody who already installed the site:
 * the character artwork was added to every shipped page and, on the live
 * server, not one of those pages had a character, because the rows were written
 * before the fields existed.
 *
 * So the new SLOTS are filled in, and nothing else is touched:
 *
 *   • only pages whose slug is one this project ships;
 *   • only fields that are currently EMPTY — a character an operator chose, or
 *     cleared on purpose, is left exactly as it is;
 *   • blocks are matched by their title, so a card somebody renamed or wrote
 *     themselves is never assumed to be the shipped one;
 *   • a page that needs no change is not written at all, so this costs nothing
 *     on every boot after the first.
 *
 * It is deliberately additive and dull. The alternative — re-seeding, or a
 * «restore defaults» button somebody eventually presses by accident — throws
 * away the operator's work to fix a picture. */
export async function backfillShippedDesign(): Promise<void> {
  /* ONCE, EVER. Not «once per boot», and not «whenever a slot looks empty».
   *
   * An operator who clears a character is indistinguishable afterwards from a
   * page that never had one — cleanDesign drops empty strings, so both come
   * back with the key absent. Running this repeatedly would therefore undo that
   * operator's choice on every deploy, quietly, forever. Stamping it means the
   * design arrives once on an install that predates it, and from that moment
   * every slot belongs to whoever is editing the site. */
  const s = await getSettings();
  if (s.designBackfilled) return;
  const shipped = seedPages();
  const stored = await rawPages();
  let touched = 0;
  for (const src of shipped) {
    const cur = stored.find((p) => p.slug === src.slug);
    if (!cur) continue;
    let changed = false;
    const fill = <K extends keyof SitePage>(k: K) => {
      const has = cur[k];
      const empty = has === undefined || has === null || has === ''
        || (Array.isArray(has) && has.length === 0);
      if (empty && src[k] !== undefined) { (cur as any)[k] = src[k]; changed = true; }
    };
    fill('heroCharacter'); fill('kicker'); fill('intro'); fill('heroButtons');

    /* Characters inside blocks. Matched on the title the operator can see, so a
     * renamed card keeps whatever it has and a new card is never guessed at. */
    for (const sb of src.blocks ?? []) {
      const cb = (cur.blocks ?? []).find((b) => b.kind === sb.kind && b.title === sb.title);
      if (!cb) continue;
      if (sb.character && !cb.character) { cb.character = sb.character; changed = true; }
      for (const si of sb.items ?? []) {
        const ci = (cb.items ?? []).find((i) => i.title === si.title);
        if (ci && si.character && !ci.character) { ci.character = si.character; changed = true; }
      }
    }
    if (changed) { await savePage(cur); touched++; }
  }
  await saveSettings({ designBackfilled: true });
  logger.info('site_design_backfilled', { pages: touched });
}

export async function listPages(includeUnpublished = false): Promise<SitePage[]> {
  await seedIfEmpty();
  const pool = pg();
  let all: SitePage[];
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM site_pages ORDER BY nav_order, slug`);
    all = rows.map(rowToPage);
  } else all = (_memPages ?? []).slice().sort((a, b) => a.navOrder - b.navOrder);
  return includeUnpublished ? all : all.filter((p) => p.published);
}

export async function getPage(slug: string, includeUnpublished = false): Promise<SitePage | null> {
  const s = String(slug ?? '').trim();
  if (!s) return null;
  return (await listPages(includeUnpublished)).find((p) => p.slug === s) ?? null;
}

export async function listPosts(includeUnpublished = false): Promise<SitePost[]> {
  await seedIfEmpty();
  const pool = pg();
  let all: SitePost[];
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT * FROM site_posts ORDER BY published_at DESC`);
    all = rows.map(rowToPost);
  } else all = (_memPosts ?? []).slice().sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return includeUnpublished ? all : all.filter((p) => p.published);
}

export async function getPost(slug: string, includeUnpublished = false): Promise<SitePost | null> {
  const s = String(slug ?? '').trim();
  if (!s) return null;
  return (await listPosts(includeUnpublished)).find((p) => p.slug === s) ?? null;
}

export async function getSettings(): Promise<SiteSettings> {
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT data FROM site_settings WHERE id='default'`);
    return { ...SETTINGS_DEFAULTS, ...(rows[0]?.data ?? {}) };
  }
  return { ...SETTINGS_DEFAULTS, ...(_memSettings ?? {}) };
}

// ------------------------------------------------------------------ write ----

/** Slugs are part of public URLs, so they are restricted rather than trusted:
 *  lowercase latin, digits and hyphens. A Persian slug would be percent-encoded
 *  into something unreadable and unshareable. */
export function normaliseSlug(raw: string): string {
  const s = String(raw ?? '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s;
}

/* An id for a heading, so the contents list can link to it. Latin slug when
 * the title is Latin; Persian headings get a stable numbered id instead,
 * because a percent-encoded Persian fragment in a URL is unreadable and some
 * clients mangle it. */
function anchorFor(title: string, i: number): string {
  const latin = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return latin || ('bx-' + (i + 1));
}

const cleanBlocks = (raw: any): SiteBlock[] => {
  if (!Array.isArray(raw)) return [];
  /* BLOCK_KINDS, not a second list written out here. The two had already
     drifted once: a kind added to the type was accepted by the editor, saved,
     and then dropped on the way to the database with nothing said. */
  return raw
    .filter((b) => b && BLOCK_KINDS.includes(b.kind))
    .map((b, i) => ({
      kind: b.kind as BlockKind,
      title: String(b.title ?? ''), subtitle: String(b.subtitle ?? ''), body: String(b.body ?? ''),
      ctaText: String(b.ctaText ?? ''), ctaHref: String(b.ctaHref ?? ''),
      ctaText2: String(b.ctaText2 ?? ''), ctaHref2: String(b.ctaHref2 ?? ''),
      image: String(b.image ?? ''),
      anchor: String(b.anchor ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || anchorFor(b.title ?? '', i),
      character: String(b.character ?? ''),
      items: Array.isArray(b.items) ? b.items.slice(0, 40).map((it: any) => ({
        icon: String(it?.icon ?? ''), title: String(it?.title ?? ''), text: String(it?.text ?? ''),
        q: String(it?.q ?? ''), a: String(it?.a ?? ''), value: String(it?.value ?? ''),
        href: String(it?.href ?? ''), meta: String(it?.meta ?? ''),
        character: String(it?.character ?? ''),
        highlight: it?.highlight === true, open: it?.open === true,
        tags: Array.isArray(it?.tags) ? it.tags.slice(0, 6).map((t: any) => String(t ?? '')).filter(Boolean) : []
      })) : []
    }));
};

export async function savePage(input: Partial<SitePage> & { slug: string }): Promise<SitePage> {
  const slug = normaliseSlug(input.slug);
  if (!slug) throw new SiteError('SLUG_REQUIRED', 'نشانی صفحه (slug) لازم است و باید انگلیسی باشد.');
  const title = String(input.title ?? '').trim();
  if (!title) throw new SiteError('TITLE_REQUIRED', 'عنوان صفحه لازم است.');
  const page: SitePage = {
    slug, title,
    navLabel: String(input.navLabel ?? title).trim() || title,
    showInNav: input.showInNav !== false,
    navOrder: Number(input.navOrder ?? 50) || 50,
    seoTitle: String(input.seoTitle ?? ''), seoDescription: String(input.seoDescription ?? ''),
    seoKeywords: String(input.seoKeywords ?? ''), ogImage: String(input.ogImage ?? ''),
    noindex: !!input.noindex,
    ...cleanDesign(input),
    blocks: cleanBlocks(input.blocks),
    published: input.published !== false,
    updatedAt: now()
  };
  /* The same fields the row carries, so what is written is what comes back. */
  const design = cleanDesign(page);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO site_pages(slug,title,nav_label,show_in_nav,nav_order,seo_title,seo_description,seo_keywords,og_image,noindex,blocks,design,published,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT (slug) DO UPDATE SET title=$2,nav_label=$3,show_in_nav=$4,nav_order=$5,seo_title=$6,
         seo_description=$7,seo_keywords=$8,og_image=$9,noindex=$10,blocks=$11,design=$12,published=$13,updated_at=now()`,
      [page.slug, page.title, page.navLabel, page.showInNav, page.navOrder, page.seoTitle,
       page.seoDescription, page.seoKeywords, page.ogImage, page.noindex, JSON.stringify(page.blocks),
       JSON.stringify(design), page.published]);
  } else {
    if (!_memPages) _memPages = [];
    const i = _memPages.findIndex((p) => p.slug === slug);
    if (i >= 0) _memPages[i] = page; else _memPages.push(page);
  }
  return page;
}

export async function deletePage(slug: string): Promise<boolean> {
  const s = normaliseSlug(slug);
  /* The blog index is a route, not just a row: deleting it would 404 every
   * article's breadcrumb. Home is the site. */
  if (s === 'home' || s === 'blog') throw new SiteError('PAGE_PROTECTED', 'این صفحه حذف نمی‌شود؛ می‌توانی غیرفعالش کنی.');
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM site_pages WHERE slug=$1`, [s]);
    return (rowCount ?? 0) > 0;
  }
  if (!_memPages) return false;
  const i = _memPages.findIndex((p) => p.slug === s);
  if (i < 0) return false;
  _memPages.splice(i, 1);
  return true;
}

export async function savePost(input: Partial<SitePost> & { slug: string }): Promise<SitePost> {
  const slug = normaliseSlug(input.slug);
  if (!slug) throw new SiteError('SLUG_REQUIRED', 'نشانی مقاله (slug) لازم است و باید انگلیسی باشد.');
  const title = String(input.title ?? '').trim();
  if (!title) throw new SiteError('TITLE_REQUIRED', 'عنوان مقاله لازم است.');
  const post: SitePost = {
    slug, title,
    excerpt: String(input.excerpt ?? ''), cover: String(input.cover ?? ''),
    body: String(input.body ?? ''), author: String(input.author ?? ''),
    tags: Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean).slice(0, 12) : [],
    seoTitle: String(input.seoTitle ?? ''), seoDescription: String(input.seoDescription ?? ''),
    seoKeywords: String(input.seoKeywords ?? ''), noindex: !!input.noindex,
    published: input.published !== false,
    publishedAt: String(input.publishedAt ?? now()),
    updatedAt: now()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO site_posts(slug,title,excerpt,cover,body,author,tags,seo_title,seo_description,seo_keywords,noindex,published,published_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       ON CONFLICT (slug) DO UPDATE SET title=$2,excerpt=$3,cover=$4,body=$5,author=$6,tags=$7,seo_title=$8,
         seo_description=$9,seo_keywords=$10,noindex=$11,published=$12,published_at=$13,updated_at=now()`,
      [post.slug, post.title, post.excerpt, post.cover, post.body, post.author, JSON.stringify(post.tags),
       post.seoTitle, post.seoDescription, post.seoKeywords, post.noindex, post.published, post.publishedAt]);
  } else {
    if (!_memPosts) _memPosts = [];
    const i = _memPosts.findIndex((p) => p.slug === slug);
    if (i >= 0) _memPosts[i] = post; else _memPosts.push(post);
  }
  return post;
}

export async function deletePost(slug: string): Promise<boolean> {
  const s = normaliseSlug(slug);
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rowCount } = await pool.query(`DELETE FROM site_posts WHERE slug=$1`, [s]);
    return (rowCount ?? 0) > 0;
  }
  if (!_memPosts) return false;
  const i = _memPosts.findIndex((p) => p.slug === s);
  if (i < 0) return false;
  _memPosts.splice(i, 1);
  return true;
}

export async function saveSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
  const next: SiteSettings = { ...(await getSettings()), ...(patch ?? {}), updatedAt: now() };
  /* A trailing slash here would produce canonical URLs with a double slash,
   * which search engines treat as a different page. */
  next.baseUrl = String(next.baseUrl ?? '').trim().replace(/\/+$/, '');
  /* Must stay a site-relative path: it is pasted straight into href and into
   * canonical URLs, so an absolute or scheme-bearing value would point the
   * site's own home somewhere else entirely. */
  const home = String(next.homePath ?? '').trim();
  next.homePath = home.startsWith('/') && !home.startsWith('//') ? home.replace(/\/+$/, '') || '/' : '/home';
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO site_settings(id,data,updated_at) VALUES('default',$1,now())
       ON CONFLICT (id) DO UPDATE SET data=$1, updated_at=now()`, [JSON.stringify(next)]);
  } else _memSettings = next;
  logger.info('site_settings_saved', { baseUrl: next.baseUrl, enabled: next.enabled });
  return next;
}

/** Test seam. */
export function _resetSiteMemory(): void {
  _memPages = null; _memPosts = null; _memSettings = null; _seeding = null;
}
export { seedPages as _seedPages, seedPosts as _seedPosts };
