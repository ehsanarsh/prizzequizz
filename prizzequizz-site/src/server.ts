/* THE PUBLIC WEBSITE — its own process.
 *
 * This runs BESIDE the game, not inside it. That is the whole design: the game
 * API is not rebuilt, not redeployed and not linked against to put this site
 * up. If this process falls over, players do not notice. If the game is
 * restarted, the site keeps serving. They share nothing but a Postgres server,
 * and even there the site owns its own three tables.
 *
 * It serves plain server-rendered HTML — no build step for the browser, no
 * hydration — because the point of these pages is to be found by a crawler.
 *
 * The admin side is served from here too, at /site-admin, rather than being
 * added to the game's panel. Same reason: nothing about putting up a marketing
 * page should require touching a file the game depends on.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { deleteMedia, getMediaBytes, listMedia, saveMedia, updateMedia } from './media.js';
import { getAsset } from './assets.js';
import {
  SiteError, deletePage, deletePost, getPage, getPost, getSettings,
  listPages, listPosts, savePage, savePost, saveSettings
} from './content.js';
import { renderNotFound, renderPage, renderPost, renderRobots, renderSitemap } from './render.js';
import { homeLive } from './live.js';
import { adminHtml } from './adminUi.js';
import { logger } from './log.js';

const PORT = Number(process.env.SITE_PORT ?? 8090);

/* The same key the game panel uses, so there is one admin secret to rotate and
 * not two. In production an unset key means the admin API is CLOSED — an empty
 * string must never compare equal to an empty header. */
function adminKey(): string {
  return process.env.ADMIN_KEY || (process.env.NODE_ENV === 'production' ? '' : 'dev-admin');
}
function isAdmin(req: IncomingMessage): boolean {
  const want = adminKey();
  if (!want) return false;
  const got = String(req.headers['x-admin-key'] ?? '');
  const a = Buffer.from(got), b = Buffer.from(want);
  /* Constant-time, so the key cannot be recovered a character at a time. */
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  const buf = Buffer.from(body, 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('content-length', String(buf.length));
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(buf);
}
const html = (res: ServerResponse, status: number, body: string, cache = 'public, max-age=60') =>
  send(res, status, 'text/html; charset=utf-8', body, { 'cache-control': cache });
const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify({ ok: status < 400, data }), { 'cache-control': 'no-store' });
const fail = (res: ServerResponse, status: number, code: string, message: string) =>
  send(res, status, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: { code, message, status } }), { 'cache-control': 'no-store' });

/* base64 costs a third on top of the bytes, plus room for the JSON around it. */
const MEDIA_BODY_LIMIT = 4_200_000;

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    /* An article body is the biggest thing normally posted here; a megabyte is
     * far more than that. An upload passes its own, larger ceiling. */
    if (size > limit) throw new SiteError('BODY_TOO_LARGE', 'حجم درخواست زیاد است.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SiteError('BODY_INVALID', 'محتوای درخواست معتبر نیست.'); }
}

/* Pages, posts and settings change rarely and are read constantly, so they are
 * held briefly in memory. Any write drops the cache, so an edit in the panel is
 * live on the next request rather than up to a minute later. */
let cache: { at: number; pages: any[]; posts: any[]; settings: any } | null = null;
const CACHE_MS = 30_000;
async function load(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  const [pages, posts, settings] = await Promise.all([listPages(), listPosts(), getSettings()]);
  cache = { at: Date.now(), pages, posts, settings };
  return cache;
}
const dropCache = () => { cache = null; };

// ------------------------------------------------------------------ admin ----

async function adminRoutes(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith('/site-api/')) return false;
  if (!isAdmin(req)) { fail(res, 403, 'ADMIN_REQUIRED', 'دسترسی مدیر لازم است.'); return true; }
  const method = req.method ?? 'GET';
  const rest = path.slice('/site-api/'.length);
  try {
    if (rest === 'all' && method === 'GET') {
      json(res, 200, {
        pages: await listPages(true), posts: await listPosts(true), settings: await getSettings()
      });
      return true;
    }
    if (rest === 'settings' && method === 'PUT') {
      const saved = await saveSettings(await readBody(req));
      dropCache(); json(res, 200, saved); return true;
    }
    if (rest === 'pages' && method === 'PUT') {
      const saved = await savePage(await readBody(req));
      dropCache(); json(res, 200, saved); return true;
    }
    if (rest.startsWith('pages/') && method === 'DELETE') {
      const ok = await deletePage(decodeURIComponent(rest.slice('pages/'.length)));
      dropCache(); json(res, 200, { removed: ok }); return true;
    }
    if (rest === 'posts' && method === 'PUT') {
      const saved = await savePost(await readBody(req));
      dropCache(); json(res, 200, saved); return true;
    }
    if (rest.startsWith('posts/') && method === 'DELETE') {
      const ok = await deletePost(decodeURIComponent(rest.slice('posts/'.length)));
      dropCache(); json(res, 200, { removed: ok }); return true;
    }
    if (rest === 'media' && method === 'GET') { json(res, 200, { media: await listMedia() }); return true; }
    if (rest === 'media' && method === 'POST') {
      /* An image is far bigger than an article, so this one route reads with a
       * larger ceiling than the JSON body helper allows. */
      const body = await readBody(req, MEDIA_BODY_LIMIT);
      json(res, 200, await saveMedia({ data: String(body.data ?? ''), filename: String(body.filename ?? ''), alt: String(body.alt ?? '') }));
      return true;
    }
    if (rest.startsWith('media/') && method === 'PUT') {
      const ok = await updateMedia(decodeURIComponent(rest.slice('media/'.length)), String((await readBody(req)).alt ?? ''));
      json(res, 200, { updated: ok }); return true;
    }
    if (rest.startsWith('media/') && method === 'DELETE') {
      const ok = await deleteMedia(decodeURIComponent(rest.slice('media/'.length)));
      json(res, 200, { removed: ok }); return true;
    }
    fail(res, 404, 'NOT_FOUND', 'مسیر یافت نشد.');
  } catch (e) {
    if (e instanceof SiteError) fail(res, 422, e.code, e.message);
    else {
      logger.error('site_admin_failed', { path, detail: e instanceof Error ? e.message : 'unknown' });
      fail(res, 500, 'SERVER_ERROR', 'خطای سرور.');
    }
  }
  return true;
}

// ----------------------------------------------------------------- public ----

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  /* Liveness, for whatever supervises this process. Deliberately cheap and
   * without a database round-trip: "is the process up" and "is Postgres up" are
   * different questions and a restart loop should not be triggered by the second. */
  if (path === '/site-health') { json(res, 200, { status: 'ok', service: 'prizzequizz-site' }); return; }

  if (await adminRoutes(req, res, path)) return;

  /* THE DESIGN'S OWN FILES — the stylesheet and the characters it is drawn
   * around. Not content, never edited from the panel, and identical for every
   * visitor: served from disk with a strong ETag so a repeat visit is a 304
   * rather than a megabyte. Cached for an hour rather than a year, because
   * unlike /media/ these names are reused when the design changes. */
  if (path.startsWith('/site-assets/')) {
    const asset = getAsset(decodeURIComponent(path.slice('/site-assets/'.length)));
    if (!asset) { fail(res, 404, 'NOT_FOUND', 'فایل یافت نشد.'); return; }
    if (req.headers['if-none-match'] === asset.etag) { res.statusCode = 304; res.end(); return; }
    res.statusCode = 200;
    res.setHeader('content-type', asset.type);
    res.setHeader('content-length', String(asset.body.length));
    res.setHeader('etag', asset.etag);
    res.setHeader('cache-control', 'public, max-age=3600');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : asset.body);
    return;
  }

  /* Public, and immutable: an id is minted per upload and never reused, so the
   * bytes behind a URL can never change and a year of caching is safe. */
  if (path.startsWith('/media/')) {
    const found = await getMediaBytes(decodeURIComponent(path.slice('/media/'.length)));
    if (!found) { fail(res, 404, 'NOT_FOUND', 'تصویر یافت نشد.'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', found.mime);
    res.setHeader('content-length', String(found.bytes.length));
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : found.bytes);
    return;
  }

  if (path === '/site-admin') {
    /* The page itself is public; every byte of DATA behind it needs the key,
     * which the operator pastes once. Serving the shell without the key means
     * no secret ever sits in a URL or a bookmark. */
    html(res, 200, adminHtml(), 'no-store');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { fail(res, 405, 'METHOD_NOT_ALLOWED', 'روش پشتیبانی نمی‌شود.'); return; }

  const { pages, posts, settings } = await load();

  if (!settings.enabled) {
    html(res, 503, '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>به‌زودی</title>' +
      '<body style="background:#0E0C14;color:#F6F3EA;font-family:Tahoma,sans-serif;display:grid;place-items:center;height:100vh;margin:0">' +
      '<p>سایت موقتاً در دسترس نیست.</p></body></html>', 'no-store');
    return;
  }

  if (path === '/robots.txt') { send(res, 200, 'text/plain; charset=utf-8', renderRobots(settings), { 'cache-control': 'public, max-age=3600' }); return; }
  if (path === '/sitemap.xml') { send(res, 200, 'application/xml; charset=utf-8', renderSitemap(pages, posts, settings), { 'cache-control': 'public, max-age=3600' }); return; }

  if (path.startsWith('/blog/')) {
    const slug = decodeURIComponent(path.slice('/blog/'.length));
    const post = posts.find((p: any) => p.slug === slug);
    if (!post) { html(res, 404, renderNotFound(pages, settings), 'no-store'); return; }
    html(res, 200, renderPost(post, pages, settings, posts));
    return;
  }

  const slug = path === '/' ? 'home' : decodeURIComponent(path.slice(1));
  const page = pages.find((p: any) => p.slug === slug);
  if (!page) { html(res, 404, renderNotFound(pages, settings), 'no-store'); return; }
  /* Only the home page shows live panels, so only the home page pays for the
     lookup — and homeLive caches, so a busy minute is a handful of queries.
     It never throws: a failure returns nulls and the blocks are omitted. */
  const live = slug === 'home' ? await homeLive() : undefined;
  html(res, 200, renderPage(page, pages, settings, posts, live));
}

export function createSiteServer() {
  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      logger.error('site_request_failed', { url: req.url, detail: e instanceof Error ? e.message : 'unknown' });
      if (!res.headersSent) fail(res, 500, 'SERVER_ERROR', 'خطای سرور.');
      else res.end();
    });
  });
}

/* Only listen when run directly, so the tests can import the handler. */
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  createSiteServer().listen(PORT, () => {
    logger.info('site_listening', { port: PORT, admin: '/site-admin' });
  });
}
