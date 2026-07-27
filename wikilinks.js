import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl, resolveInside } from './paths.js';

const MARKDOWN_LINK = /\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g;
// Fenced code blocks contain example markdown; rewriting links inside them
// would corrupt the very syntax the page is documenting.
const FENCED_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
// Markdown converted from HTML never contains NUL, so a masked code block
// cannot collide with real page text.
const NUL = String.fromCharCode(0);
const MASKED = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');

/** Wikilink aliases can't contain the characters that delimit them. */
const cleanLabel = (label) => label.replace(/[|[\]]/g, '').trim();

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
  for (const [url, entry] of index) {
    const vaultPath = `${prefix ? `${prefix}/` : ''}${entry.file}`.replace(/\.md$/, '');
    noteForUrl.set(url, vaultPath);
  }

  const files = [...new Set([...index.values()].map((entry) => entry.file))];
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
      let target;
      try {
        target = noteForUrl.get(normalizeUrl(href));
      } catch {
        return whole;
      }
      if (!target) return whole;

      rewritten++;
      const alias = cleanLabel(label);
      const basename = target.split('/').pop();
      return alias && alias !== basename ? `[[${target}|${alias}]]` : `[[${target}]]`;
    });

    if (rewritten === 0) continue;
    const restored = linked.replace(MASKED, (_, i) => blocks[Number(i)]);
    await fs.writeFile(resolveInside(destRoot, file), restored, 'utf8');
    filesChanged++;
    linksRewritten += rewritten;
  }

  return { filesChanged, linksRewritten };
}
