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
import { getPgPool } from '../database/postgres.js';
import { logger } from './logger.js';

// ------------------------------------------------------------------ types ----

export type BlockKind = 'hero' | 'text' | 'cards' | 'steps' | 'faq' | 'cta' | 'stats';

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
  items?: Array<{ icon?: string; title?: string; text?: string; q?: string; a?: string; value?: string }>;
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

let _schemaReady = false;
async function ensureSchema(pool: ReturnType<typeof getPgPool>): Promise<void> {
  if (_schemaReady) return;
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
  _schemaReady = true;
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
      seoTitle: 'پرایز کوئیز | بازی آنلاین اطلاعات عمومی با جایزه',
      seoDescription: 'با بازیکن‌های واقعی دوئل کن، در «آخرین بازمانده» تا آخر بمان و رکورد بزن. بازی مسابقه‌ای فارسی، رایگان و جایزه‌دار.',
      seoKeywords: 'بازی اطلاعات عمومی, مسابقه آنلاین, کوییز فارسی, بازی جایزه دار',
      blocks: [
        { kind: 'hero', title: 'بدان، جواب بده، ببر', subtitle: 'مسابقهٔ آنلاین اطلاعات عمومی با بازیکن‌های واقعی. دوئل زنده، آخرین بازمانده، ثبت رکورد — همه به فارسی.', ctaText: '🎮 شروع بازی', ctaHref: '{play}', ctaText2: '📥 دانلود بازی', ctaHref2: '/download' },
        { kind: 'cards', title: 'چه حالت‌هایی داری؟', items: [
          { icon: '⚔️', title: 'دوئل', text: 'رودررو با یک بازیکن واقعی. هر دو یک سؤال می‌بینید و سرعت و دقت تعیین می‌کند چه کسی می‌برد.' },
          { icon: '🏝️', title: 'آخرین بازمانده', text: 'همه با هم شروع می‌کنند و هر جواب غلط یک نفر را حذف می‌کند. هر که بیشتر بماند، سهم بیشتری می‌برد.' },
          { icon: '🏅', title: 'ثبت رکورد', text: 'تا آخرین قلب جواب بده و رکورد بزن. هر موضوع جدول رکورد جداگانهٔ خودش را دارد.' },
          { icon: '🎯', title: 'مأموریت‌ها', text: 'روزانه، هفتگی و دستاوردهای بلندمدت. هر مأموریت جایزهٔ خودش را دارد.' }
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
        { kind: 'cta', title: 'همین حالا شروع کن', body: 'ثبت‌نام رایگان است و اولین بازی‌ات چند ثانیه با تو فاصله دارد.', ctaText: 'بزن بریم', ctaHref: '{play}' }
      ]
    }),
    P({
      slug: 'download', title: 'دانلود بازی', navOrder: 2,
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

function rowToPage(r: any): SitePage {
  return {
    slug: String(r.slug), title: String(r.title ?? ''), navLabel: String(r.nav_label ?? r.title ?? ''),
    showInNav: r.show_in_nav !== false, navOrder: Number(r.nav_order ?? 50),
    seoTitle: String(r.seo_title ?? ''), seoDescription: String(r.seo_description ?? ''),
    seoKeywords: String(r.seo_keywords ?? ''), ogImage: String(r.og_image ?? ''),
    noindex: !!r.noindex,
    blocks: Array.isArray(r.blocks) ? r.blocks : [],
    published: r.published !== false,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : now()
  };
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

let _seeded = false;
async function seedIfEmpty(): Promise<void> {
  if (_seeded) return;
  _seeded = true;
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM site_pages`);
    if (Number(rows[0]?.n ?? 0) > 0) return;
  } else if (_memPages && _memPages.length) return;
  else { _memPages = []; _memPosts = []; }
  for (const p of seedPages()) await savePage(p);
  for (const p of seedPosts()) await savePost(p);
  logger.info('site_content_seeded', { pages: seedPages().length, posts: seedPosts().length });
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

const cleanBlocks = (raw: any): SiteBlock[] => {
  if (!Array.isArray(raw)) return [];
  const KINDS: BlockKind[] = ['hero', 'text', 'cards', 'steps', 'faq', 'cta', 'stats'];
  return raw
    .filter((b) => b && KINDS.includes(b.kind))
    .map((b) => ({
      kind: b.kind as BlockKind,
      title: String(b.title ?? ''), subtitle: String(b.subtitle ?? ''), body: String(b.body ?? ''),
      ctaText: String(b.ctaText ?? ''), ctaHref: String(b.ctaHref ?? ''),
      ctaText2: String(b.ctaText2 ?? ''), ctaHref2: String(b.ctaHref2 ?? ''),
      image: String(b.image ?? ''),
      items: Array.isArray(b.items) ? b.items.slice(0, 40).map((it: any) => ({
        icon: String(it?.icon ?? ''), title: String(it?.title ?? ''), text: String(it?.text ?? ''),
        q: String(it?.q ?? ''), a: String(it?.a ?? ''), value: String(it?.value ?? '')
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
    blocks: cleanBlocks(input.blocks),
    published: input.published !== false,
    updatedAt: now()
  };
  const pool = pg();
  if (pool) {
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO site_pages(slug,title,nav_label,show_in_nav,nav_order,seo_title,seo_description,seo_keywords,og_image,noindex,blocks,published,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (slug) DO UPDATE SET title=$2,nav_label=$3,show_in_nav=$4,nav_order=$5,seo_title=$6,
         seo_description=$7,seo_keywords=$8,og_image=$9,noindex=$10,blocks=$11,published=$12,updated_at=now()`,
      [page.slug, page.title, page.navLabel, page.showInNav, page.navOrder, page.seoTitle,
       page.seoDescription, page.seoKeywords, page.ogImage, page.noindex, JSON.stringify(page.blocks), page.published]);
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
  _memPages = null; _memPosts = null; _memSettings = null; _seeded = false;
}
export { seedPages as _seedPages, seedPosts as _seedPosts };
