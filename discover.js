import { parseHTML } from 'linkedom';
import { fetchText, loadRobots } from './fetcher.js';
import { normalizeUrl } from './paths.js';
import { renderHtml } from './render.js';

const CONCURRENCY = 4;
// Safety valve only — big sites ship sitemaps with tens of thousands of URLs.
const MAX_SITEMAP_URLS = 50000;

/**
 * The section of the site a start URL implies: the folder containing it.
 * /docs/quickstart -> /docs/ , /docs -> / , / -> /
 */
export function scopeFromUrl(rawUrl) {
  const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
  segments.pop();
  return segments.length ? `/${segments.join('/')}/` : '/';
}

const inScope = (rawUrl, scope) => {
  const { pathname } = new URL(rawUrl);
  return scope === '/' || pathname === scope.slice(0, -1) || pathname.startsWith(scope);
};

// Sections that are almost never worth clipping, plus non-page file types.
const NOISE_PATH =
  /\/(tag|tags|category|categories|author|authors|page|search|feed|feeds|rss|amp|print|login|signup|cart|checkout)\//i;
const NON_PAGE = /\.(xml|json|rss|atom|pdf|zip|gz|csv|jpe?g|png|gif|svg|webp|ico|mp4|mp3|woff2?)$/i;

/** Should this URL be checked by default in the review step? */
export function isSuggested(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.search) return false;
    if (NON_PAGE.test(u.pathname)) return false;
    return !NOISE_PATH.test(`${u.pathname}/`);
  } catch {
    return false;
  }
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * Pull URLs out of sitemap.xml, following one level of <sitemapindex>.
 * ponytail: regex over <loc>, not an XML parser — sitemaps are a flat, fixed format.
 */
async function fromSitemaps(seedUrls, origin, onLog) {
  const queue = [...seedUrls];
  const visited = new Set();
  const found = [];

  while (queue.length > 0 && found.length < MAX_SITEMAP_URLS) {
    const sitemapUrl = queue.shift();
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    let body;
    try {
      ({ body } = await fetchText(sitemapUrl, { retries: 0, timeout: 15000 }));
    } catch {
      continue;
    }
    onLog?.(`sitemap: ${sitemapUrl}`);

    const isIndex = /<sitemapindex/i.test(body);
    for (const match of body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      let loc;
      try {
        loc = new URL(decodeEntities(match[1]));
      } catch {
        continue;
      }
      if (loc.origin !== origin) continue;
      if (isIndex) queue.push(loc.toString());
      else found.push(normalizeUrl(loc.toString()));
    }
  }
  return found;
}

/** Breadth-first same-origin link crawl. Used when there's no usable sitemap. */
async function crawlLinks(startUrl, { origin, scope, cap, isAllowed, onLog, shouldStop }) {
  const start = normalizeUrl(startUrl);
  const seen = new Set([start]);
  const queue = [start];
  const pages = [];
  let active = 0;

  const visit = async (pageUrl) => {
    let body, contentType, finalUrl;
    try {
      ({ body, contentType, url: finalUrl } = await fetchText(pageUrl, { retries: 1 }));
    } catch (err) {
      onLog?.(`skip ${pageUrl} — ${err.message}`);
      return;
    }
    if (!/html/i.test(contentType)) return;

    let { document } = parseHTML(body);
    let anchors = [...document.querySelectorAll('a[href]')];

    // No anchors at all means the nav is built by JavaScript. Render it, or the
    // crawl stops dead at the entry page with nothing to follow.
    if (anchors.length === 0) {
      const page = await renderHtml(pageUrl).catch(() => null);
      if (page) {
        ({ document } = parseHTML(page.body));
        anchors = [...document.querySelectorAll('a[href]')];
        if (anchors.length > 0) onLog?.(`rendered ${pageUrl} — ${anchors.length} links only exist after JS`);
      }
    }

    pages.push(pageUrl);
    onLog?.(`found ${pages.length}: ${pageUrl}`);

    for (const anchor of anchors) {
      let next;
      try {
        next = normalizeUrl(anchor.getAttribute('href'), finalUrl || pageUrl);
      } catch {
        continue;
      }
      const u = new URL(next);
      if (u.origin !== origin) continue;
      if (!inScope(next, scope)) continue;
      if (NON_PAGE.test(u.pathname)) continue;
      if (!isAllowed(u.pathname)) continue;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  };

  await new Promise((resolve) => {
    const pump = () => {
      if (shouldStop?.() || pages.length >= cap) queue.length = 0;
      if (queue.length === 0 && active === 0) return resolve();
      while (active < CONCURRENCY && queue.length > 0) {
        const next = queue.shift();
        active++;
        visit(next).finally(() => {
          active--;
          pump();
        });
      }
    };
    pump();
  });

  return pages;
}

/**
 * Find every capturable page on a site. Tries sitemaps first (fast, no page fetches),
 * falls back to a link crawl. Returns [{ url, suggested }] sorted by URL.
 */
export async function discover(startUrl, { cap = 500, scope, onLog, shouldStop } = {}) {
  const { origin } = new URL(startUrl);
  const section = scope || scopeFromUrl(startUrl);
  const robots = await loadRobots(origin);
  onLog?.(`scope: ${origin}${section}`);

  const seeds = [...new Set([...robots.sitemaps, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])];
  let urls = await fromSitemaps(seeds, origin, onLog);
  if (urls.length > 0) onLog?.(`sitemap listed ${urls.length} URLs site-wide`);

  // Scope first, THEN cap — otherwise a big site fills the budget with whatever
  // sorts alphabetically first and the section you asked for never appears.
  let scoped = [...new Set(urls)].filter((u) => inScope(u, section));

  if (scoped.length === 0) {
    onLog?.(urls.length ? 'nothing in scope from the sitemap — crawling links instead' : 'no sitemap found — crawling links instead');
    scoped = await crawlLinks(startUrl, {
      origin,
      scope: section,
      cap,
      isAllowed: robots.isAllowed,
      onLog,
      shouldStop,
    });
  }

  const allowed = scoped.filter((u) => robots.isAllowed(new URL(u).pathname));
  allowed.sort();
  if (allowed.length > cap) {
    onLog?.(`${allowed.length} pages in scope — showing the first ${cap}. Raise the page limit to see the rest.`);
  }
  return allowed.slice(0, cap).map((url) => ({ url, suggested: isSuggested(url) }));
}
