import path from 'node:path';

// Filesystem-hostile characters plus Obsidian's own link syntax (# ^ [ ] |), and control chars.
const BAD_CHARS = new RegExp('[<>:"/\\\\|?*#^\\[\\]\\u0000-\\u001f]', 'g');
const STRIP_EXT = /\.(html?|php|aspx?|jsp)$/i;

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Turn one URL path segment into something safe to use as a file or folder name. May return ''. */
export function sanitizeSegment(raw) {
  return safeDecode(String(raw ?? ''))
    .replace(BAD_CHARS, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
    .slice(0, 120)
    .replace(/[.\-\s]+$/, '');
}

// ponytail: 32-bit string hash, only used to disambiguate query strings in filenames.
function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Strip the hash and normalize so the same page isn't crawled twice. */
export function normalizeUrl(raw, base) {
  const u = new URL(raw, base);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/** Each site gets its own folder, so a capture never spills across the destination. */
export function siteFolder(rawUrl) {
  return sanitizeSegment(new URL(rawUrl).hostname.replace(/^www\./, '')) || 'site';
}

/** URL -> vault-relative note path: <site>/<url folders>/<title>.md */
export function urlToRelPath(rawUrl, title = '') {
  const u = new URL(rawUrl);
  const segs = u.pathname.split('/').filter(Boolean);
  const slug = segs.length ? segs[segs.length - 1].replace(STRIP_EXT, '') : '';
  const folders = segs.slice(0, -1).map(sanitizeSegment).filter(Boolean);
  let name =
    sanitizeSegment(title) || sanitizeSegment(slug) || sanitizeSegment(u.hostname) || 'untitled';
  if (u.search) name += ` (${shortHash(u.search)})`;
  return [siteFolder(rawUrl), ...folders, `${name}.md`].join('/');
}

/**
 * Reserve a path. On collision prefer `fallback` (the URL-slug name) over a counter —
 * sites that put their brand in og:title give every page the same title, and
 * "Help Center 2…45" tells you nothing about which page you're looking at.
 */
export function uniquePath(rel, taken, fallback) {
  const key = (p) => p.toLowerCase();
  if (!taken.has(key(rel))) {
    taken.add(key(rel));
    return rel;
  }
  if (fallback && !taken.has(key(fallback))) {
    taken.add(key(fallback));
    return fallback;
  }
  const source = fallback || rel;
  const dot = source.lastIndexOf('.');
  const base = source.slice(0, dot);
  const ext = source.slice(dot);
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}${ext}`;
    if (!taken.has(key(candidate))) {
      taken.add(key(candidate));
      return candidate;
    }
  }
}

/** Refuse to write anywhere outside the destination folder. */
export function resolveInside(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`refusing to write outside destination: ${rel}`);
  }
  return abs;
}

/** Always emit a double-quoted YAML scalar; JSON string escaping is valid YAML 1.2. */
export function yamlValue(v) {
  if (v === undefined || v === null || v === '') return '';
  return JSON.stringify(String(v).replace(/\s+/g, ' ').trim());
}
