/**
 * Map of Content — the way *into* a few hundred imported notes.
 *
 * The wikilink pass already computes which note links to which; it used to
 * throw that away. Ranking by inbound links surfaces the pages the site itself
 * treats as important, and exposes the orphans nothing points at.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInside, yamlValue } from './paths.js';

const MAP_FILE = '_map.md';
const FALLBACK_MAP_FILE = '_map (generated).md';
// Below this, "hubs" is just the whole list again.
const MIN_HUB_LINKS = 2;
const MAX_HUBS = 15;

const wikilink = (prefix, file) => `[[${`${prefix ? `${prefix}/` : ''}${file}`.replace(/\.md$/, '')}]]`;

/** Group captured notes by their site folder — the first path segment. */
function bySite(index) {
  const sites = new Map();
  for (const entry of index.values()) {
    const site = entry.file.split('/')[0];
    if (!site) continue;
    if (!sites.has(site)) sites.set(site, []);
    sites.get(site).push(entry.file);
  }
  return sites;
}

/**
 * Pure: given the index and inbound counts, return the map notes to write.
 * @returns {{ file: string, body: string }[]}
 */
export function buildMaps({ index, inbound, prefix }) {
  const claimed = new Set([...index.values()].map((entry) => entry.file.toLowerCase()));
  const maps = [];

  for (const [site, files] of bySite(index)) {
    const ranked = files
      .map((file) => ({ file, links: inbound.get(file) ?? 0 }))
      .sort((a, b) => b.links - a.links || a.file.localeCompare(b.file));

    const hubs = ranked.filter((p) => p.links >= MIN_HUB_LINKS).slice(0, MAX_HUBS);
    const orphans = ranked.filter((p) => p.links === 0);

    const lines = [
      '---',
      `title: ${yamlValue(`${site} — map`)}`,
      'type: map',
      'tags:',
      '  - clippings',
      '  - moc',
      '---',
      '',
      `# ${site}`,
      '',
      `${files.length} page${files.length === 1 ? '' : 's'} captured.`,
      '',
    ];

    if (hubs.length) {
      lines.push('## Hubs', '', '_The pages this site links to most — usually where to start._', '');
      for (const { file, links } of hubs) lines.push(`- ${wikilink(prefix, file)} · ${links} links in`);
      lines.push('');
    }

    lines.push('## All pages', '');
    for (const { file } of [...ranked].sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`- ${wikilink(prefix, file)}`);
    }
    lines.push('');

    if (orphans.length) {
      lines.push(
        '## Orphans',
        '',
        '_Nothing else in the capture links here. Either a top-level entry point, or a page that only the site navigation reached._',
        '',
      );
      for (const { file } of orphans) lines.push(`- ${wikilink(prefix, file)}`);
      lines.push('');
    }

    // A captured page may legitimately be called _map. It was here first.
    const preferred = `${site}/${MAP_FILE}`;
    const file = claimed.has(preferred.toLowerCase()) ? `${site}/${FALLBACK_MAP_FILE}` : preferred;

    maps.push({ file, body: `${lines.join('\n').trimEnd()}\n` });
  }

  return maps;
}

/** Write one map note per site folder. */
export async function writeMaps({ destRoot, vaultRoot, index, inbound }) {
  const prefix = path.relative(vaultRoot, destRoot).split(path.sep).filter(Boolean).join('/');
  const maps = buildMaps({ index, inbound, prefix });

  for (const map of maps) {
    // The site folder comes from the index file on disk, which this process
    // doesn't own — same guard every other write in the codebase uses.
    const abs = resolveInside(destRoot, map.file);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, map.body, 'utf8');
  }

  return { maps: maps.length, files: maps.map((m) => m.file) };
}
