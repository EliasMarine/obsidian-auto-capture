import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { Defuddle } from 'defuddle/node';
import { fetchText } from './fetcher.js';
import { resolveInside, uniquePath, urlToRelPath, yamlValue } from './paths.js';
import { renderHtml } from './render.js';
import { headingAnchors } from './anchors.js';
import { diffAgainstDisk } from './changelog.js';

const INDEX_FILE = '.crawl-index.json';

const MARKDOWN_LINK = /\]\((https?:\/\/[^)\s]+)/g;
// A page with lots of links and almost no prose is a table of contents, not an article.
const INDEX_MAX_WORDS = 200;
const INDEX_MIN_LINKS = 5;

/** How many same-origin links a page has, and which folder they mostly point into. */
function linkProfile(markdown, pageUrl) {
  const { origin } = new URL(pageUrl);
  const folders = new Map();
  let links = 0;

  for (const [, href] of markdown.matchAll(MARKDOWN_LINK)) {
    let target;
    try {
      target = new URL(href);
    } catch {
      continue;
    }
    if (target.origin !== origin) continue;
    links++;
    const segments = target.pathname.split('/').filter(Boolean);
    segments.pop();
    const folder = segments.length ? `/${segments.join('/')}/` : '/';
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }

  let topFolder = null;
  let best = 0;
  for (const [folder, count] of folders) {
    if (count > best) [best, topFolder] = [count, folder];
  }
  return { links, topFolder };
}

/**
 * If most of a run came back as link lists, say so and point at where those
 * links actually go — otherwise the vault quietly fills with navigation pages.
 */
function indexPageAdvice(results) {
  const saved = results.filter((r) => r.status === 'saved' || r.status === 'updated');
  if (saved.length < 3) return null;

  const thin = saved.filter((r) => r.words < INDEX_MAX_WORDS && r.links >= INDEX_MIN_LINKS);
  if (thin.length * 2 < saved.length) return null;

  const folders = new Map();
  for (const r of thin) {
    if (r.topFolder) folders.set(r.topFolder, (folders.get(r.topFolder) ?? 0) + 1);
  }
  let suggestion = null;
  let best = 0;
  for (const [folder, count] of folders) {
    if (count > best) [best, suggestion] = [count, folder];
  }

  const words = thin.map((r) => r.words).sort((a, b) => a - b);
  return { thin: thin.length, total: saved.length, medianWords: words[Math.floor(words.length / 2)], suggestion };
}

const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Obsidian Web Clipper's default note template. */
export function buildNote(result, sourceUrl) {
  const frontmatter = [
    '---',
    `title: ${yamlValue(result.title)}`,
    `source: ${yamlValue(sourceUrl)}`,
    `author: ${yamlValue(result.author)}`,
    `published: ${yamlValue(result.published)}`,
    `created: ${today()}`,
    `description: ${yamlValue(result.description)}`,
    'tags:',
    '  - clippings',
    '---',
    '',
  ].join('\n');
  return `${frontmatter}${String(result.content ?? '').trim()}\n`;
}

/** url -> relative note path, so re-runs know what's already been captured. */
export async function loadIndex(destRoot) {
  try {
    const raw = await fs.readFile(path.join(destRoot, INDEX_FILE), 'utf8');
    // v1 stored a bare path string; v2 stores { file, hash } so re-runs can tell
    // "already have it" from "have it but the page changed".
    return new Map(
      Object.entries(JSON.parse(raw)).map(([url, value]) => [
        url,
        typeof value === 'string' ? { file: value, hash: null } : value,
      ]),
    );
  } catch {
    return new Map();
  }
}

export async function saveIndex(destRoot, index) {
  await fs.mkdir(destRoot, { recursive: true });
  const sorted = Object.fromEntries([...index.entries()].sort(([a], [b]) => a.localeCompare(b)));
  await fs.writeFile(path.join(destRoot, INDEX_FILE), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const contentHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * useAsync:false keeps extraction local. Defuddle would otherwise POST the page to
 * third-party APIs when it finds nothing — we render it ourselves instead.
 */
async function extract(html, url, includeImages) {
  const { document } = parseHTML(html);
  // Heading ids have to be harvested here: Defuddle returns Markdown, and the
  // ids a URL fragment points at only exist in the DOM.
  const anchors = headingAnchors(document);
  // Images are never downloaded either way — this drops the remote ![](…) markup,
  // which otherwise renders in Obsidian and clutters a text archive.
  // Defuddle resolves a promise even with useAsync:false — awaiting here is what
  // lets the anchors be merged in without clobbering the result.
  const result = await Defuddle(document, url, {
    markdown: true,
    url,
    removeImages: !includeImages,
    useAsync: false,
  });
  return result ? { ...result, anchors } : result;
}

/**
 * Fetch one page, extract it with Defuddle, write it as Markdown.
 * mode: 'skip' leaves existing notes alone, 'update' rewrites only when the page
 * changed, 'overwrite' always rewrites. Returns { status, file, ... }; throws on failure.
 */
export async function capturePage(url, { destRoot, taken, index, includeImages = false, mode = 'skip' }) {
  const known = index.get(url);
  const knownFile = known?.file;
  const havePrevious = Boolean(knownFile) && (await exists(resolveInside(destRoot, knownFile)));

  if (havePrevious && mode === 'skip') {
    return { status: 'skipped', file: knownFile, title: '' };
  }

  const { body, contentType } = await fetchText(url);
  if (!/html/i.test(contentType)) throw new Error(`not HTML (${contentType || 'unknown type'})`);

  let result = await extract(body, url, includeImages);
  let rendered = false;

  // Empty extraction means the server sent a JS shell. Re-fetch through a real
  // browser and try once more — this is the only signal that reliably tells the
  // two cases apart, so there's no mode for the user to get wrong.
  if (!result?.content?.trim()) {
    const page = await renderHtml(url).catch(() => null);
    if (page) {
      result = await extract(page.body, url, includeImages);
      rendered = true;
    }
  }
  if (!result?.content?.trim()) throw new Error('no readable content found');

  const hash = contentHash(result.content);
  const { links, topFolder } = linkProfile(result.content, url);
  const stats = { title: result.title || '', words: result.wordCount ?? 0, links, topFolder };

  if (havePrevious && mode === 'update' && known.hash === hash) {
    return { status: 'skipped', file: knownFile, ...stats };
  }

  // Updates land back in the existing note; only new URLs claim a fresh path.
  const rel = knownFile || uniquePath(urlToRelPath(url, result.title), taken, urlToRelPath(url));
  const abs = resolveInside(destRoot, rel);
  const note = buildNote(result, url);

  // What the *site* changed, read off disk before we overwrite it. Only worth
  // computing when a previous capture exists and its content actually moved.
  const changed = havePrevious && known?.hash && known.hash !== hash ? await diffAgainstDisk(abs, note) : null;

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, note, 'utf8');

  index.set(url, {
    file: rel,
    hash,
    anchors: result.anchors ?? {},
    firstSeen: known?.firstSeen ?? today(),
    ...(changed ? { lastChanged: today() } : {}),
  });
  return { status: havePrevious ? 'updated' : 'saved', file: rel, rendered, changed, ...stats };
}

/** Run `worker` over items with a bounded number in flight. */
async function runPool(items, limit, worker) {
  const queue = [...items];
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  });
  await Promise.all(lanes);
}

/**
 * Capture a list of URLs. Never aborts on a single failure — every URL gets a result.
 * onResult receives { url, status, file, title, error } as each one finishes.
 */
export async function captureAll(
  urls,
  { destRoot, onResult, shouldStop, includeImages = false, mode = 'skip', concurrency = 3 } = {},
) {
  const index = await loadIndex(destRoot);
  const taken = new Set([...index.values()].map((entry) => entry.file.toLowerCase()));
  const results = [];

  // Checkpoints are chained so concurrent lanes can't write the index file at once.
  let checkpoint = Promise.resolve();
  const saveSoon = () => {
    checkpoint = checkpoint.then(() => saveIndex(destRoot, index)).catch(() => {});
    return checkpoint;
  };

  await runPool(urls, concurrency, async (url) => {
    if (shouldStop?.()) return;
    let outcome;
    try {
      outcome = { url, ...(await capturePage(url, { destRoot, taken, index, includeImages, mode })) };
    } catch (err) {
      outcome = { url, status: 'failed', error: err.message };
    }
    results.push(outcome);
    onResult?.(outcome);
    if (results.length % 20 === 0) await saveSoon();
  });

  await saveSoon();
  return { results, advice: indexPageAdvice(results), changes: changeList(results) };
}

/**
 * The subset of a run worth a changelog entry: pages the site changed, plus
 * pages captured for the first time. A skip means nothing moved, so it says nothing.
 */
function changeList(results) {
  return results
    .filter((r) => r.status === 'saved' || (r.status === 'updated' && r.changed))
    .map((r) => ({
      url: r.url,
      file: r.file,
      title: r.title || '',
      firstSeen: r.status === 'saved',
      added: r.changed?.added ?? [],
      removed: r.changed?.removed ?? [],
    }));
}
