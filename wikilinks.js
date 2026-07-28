import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl, resolveInside } from './paths.js';

const MARKDOWN_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;
const WIKILINK = /\[\[([^\]\n]+)\]\]/g;
// Fenced code blocks contain example markdown; rewriting links inside them
// would corrupt the very syntax the page is documenting.
const FENCED_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
// Markdown converted from HTML never contains NUL, so a masked code block
// cannot collide with real page text.
const NUL = String.fromCharCode(0);
const MASKED = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');

/** Wikilink aliases can't contain the characters that delimit them. */
const cleanLabel = (label) => label.replace(/[|[\]]/g, '').trim();

const countInbound = (inbound, file) => {
  if (file) inbound.set(file, (inbound.get(file) ?? 0) + 1);
};

/** An own, string-valued property — never anything reached through the prototype. */
const ownString = (map, key) => {
  if (!map || !Object.hasOwn(map, key)) return null;
  const value = map[key];
  return typeof value === 'string' ? value : null;
};

/**
 * Rewrite links between captured pages into Obsidian [[wikilinks]].
 *
 * Runs after a whole capture, not per page, so a note that links forward to a
 * page captured later still resolves. Links to pages we never captured, and
 * anything inside a code fence, are left exactly as they were.
 */
export async function linkCapturedPages({ destRoot, vaultRoot, index }) {
  const prefix = path.relative(vaultRoot, destRoot).split(path.sep).filter(Boolean).join('/');

  const noteForUrl = new Map();
  const anchorsForUrl = new Map();
  const fileForUrl = new Map();
  for (const [url, entry] of index) {
    const vaultPath = `${prefix ? `${prefix}/` : ''}${entry.file}`.replace(/\.md$/, '');
    noteForUrl.set(url, vaultPath);
    fileForUrl.set(url, entry.file);
    if (entry.anchors) anchorsForUrl.set(url, entry.anchors);
  }

  // Reverse of noteForUrl, for reading wikilinks an earlier run already wrote.
  const fileForNote = new Map([...noteForUrl].map(([url, note]) => [note, fileForUrl.get(url)]));

  const files = [...new Set([...index.values()].map((entry) => entry.file))];
  // Who links to whom. Counted on every run — including runs that rewrite
  // nothing — so the map stays accurate after an idempotent re-link.
  const inbound = new Map();
  let filesChanged = 0;
  let linksRewritten = 0;

  for (const file of files) {
    let text;
    try {
      text = await fs.readFile(resolveInside(destRoot, file), 'utf8');
    } catch {
      continue;
    }

    const blocks = [];
    const masked = text.replace(FENCED_BLOCK, (block) => {
      blocks.push(block);
      return `${NUL}${blocks.length - 1}${NUL}`;
    });

    let rewritten = 0;
    const linked = masked.replace(MARKDOWN_LINK, (whole, label, href) => {
      let url;
      let fragment = '';
      try {
        // normalizeUrl drops the fragment (the index is keyed by page, not by
        // section) so keep it here before it's discarded.
        fragment = decodeURIComponent(new URL(href).hash.replace(/^#/, ''));
        url = normalizeUrl(href);
      } catch {
        return whole;
      }
      const target = noteForUrl.get(url);
      if (!target) return whole;

      rewritten++;
      countInbound(inbound, fileForUrl.get(url));

      // An unknown fragment means the anchor isn't a heading we can link to —
      // land on the note rather than inventing a heading that isn't there.
      // Own properties only: the map is rebuilt by JSON.parse on later runs, so
      // it has a prototype again, and `#toString` would otherwise resolve to an
      // inherited function and be interpolated into the note.
      const heading = fragment ? ownString(anchorsForUrl.get(url), fragment) : null;
      const destination = heading ? `${target}#${heading}` : target;
      const alias = cleanLabel(label);
      const basename = target.split('/').pop();
      return alias && alias !== basename ? `[[${destination}|${alias}]]` : `[[${destination}]]`;
    });

    // Links rewritten on an earlier run are already wikilinks, so the graph has
    // to read those too — otherwise a second run reports every page an orphan.
    for (const [, target] of masked.matchAll(WIKILINK)) {
      const note = target.split(/[#|]/)[0].trim();
      const known = fileForNote.get(note);
      if (known) countInbound(inbound, known);
    }

    if (rewritten === 0) continue;
    const restored = linked.replace(MASKED, (_, i) => blocks[Number(i)]);
    await fs.writeFile(resolveInside(destRoot, file), restored, 'utf8');
    filesChanged++;
    linksRewritten += rewritten;
  }

  return { filesChanged, linksRewritten, inbound };
}
