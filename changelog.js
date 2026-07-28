/**
 * The changelog: what the *source site* changed since you last captured it.
 *
 * The index already stored a content hash per URL to decide skip-vs-update.
 * This turns that same signal into a dated note, so a re-crawl answers
 * "what moved?" instead of silently rewriting files under you.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { yamlValue } from './paths.js';
import { lineDiff } from './diff.js';

export const CHANGELOG_DIR = '_changelog';
// A changelog is a summary. Anyone who wants the full text opens the note.
const MAX_LINES_SHOWN = 6;
const MAX_LINE_LENGTH = 220;

// Page titles routinely contain the characters that delimit a wikilink —
// "Installation | uv" is a real title from a real docs site.
const cleanLabel = (label) =>
  String(label ?? '')
    .replace(/[|[\]#^]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const wikilink = (prefix, file, label) => {
  const target = `${prefix ? `${prefix}/` : ''}${file}`.replace(/\.md$/, '');
  const name = target.split('/').pop();
  const alias = cleanLabel(label);
  return alias && alias !== name ? `[[${target}|${alias}]]` : `[[${target}]]`;
};

const excerpt = (lines, marker) =>
  lines.slice(0, MAX_LINES_SHOWN).map((line) => {
    const trimmed = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line;
    return `> ${marker} ${trimmed}`;
  });

/**
 * Build the note body. Pure — takes the change list, returns Markdown, so the
 * shape of a changelog can be tested without touching a vault.
 */
export function renderChangelog({ date, prefix, changes }) {
  const fresh = changes.filter((c) => c.firstSeen);
  const edited = changes.filter((c) => !c.firstSeen);

  const lines = [
    '---',
    `title: ${yamlValue(`Site changes ${date}`)}`,
    `created: ${date}`,
    'type: changelog',
    'tags:',
    '  - clippings',
    '  - changelog',
    '---',
    '',
    `# Site changes — ${date}`,
    '',
    `${edited.length} page${edited.length === 1 ? '' : 's'} changed` +
      (fresh.length ? `, ${fresh.length} new` : '') +
      '.',
    '',
  ];

  if (edited.length) {
    lines.push('## Changed', '');
    for (const change of edited) {
      const added = change.added ?? [];
      const removed = change.removed ?? [];
      lines.push(
        `### ${wikilink(prefix, change.file, change.title)}`,
        '',
        `+${added.length} −${removed.length} · [source](${change.url})`,
        '',
      );
      if (added.length || removed.length) {
        lines.push(...excerpt(added, '+'), ...excerpt(removed, '−'), '');
      }
    }
  }

  if (fresh.length) {
    lines.push('## New pages', '');
    for (const change of fresh) lines.push(`- ${wikilink(prefix, change.file, change.title)}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Reduce both link syntaxes to their visible text.
 *
 * The note on disk has already been through the wikilink pass; what we just
 * extracted has not. Without this, every rewritten link reads as one line
 * removed and one added — the page would look edited when only we touched it.
 * The trade: a link whose target changed but whose text didn't goes unreported.
 */
const linkText = (text) =>
  text
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, '$2')
    .replace(/\[\[([^\]\n]+)\]\]/g, (_, target) => target.split(/[#|]/)[0].split('/').pop())
    .replace(/\[([^\]\n]*)\]\((?:https?:\/\/)[^)\s]*\)/g, '$1');

/** Compare a note already on disk with what we just extracted. */
export async function diffAgainstDisk(absPath, nextBody) {
  try {
    const previous = await fs.readFile(absPath, 'utf8');
    // Frontmatter always differs (`created:`), and that isn't a site change.
    const strip = (text) => linkText(text.replace(/^---\n[\s\S]*?\n---\n/, ''));
    return lineDiff(strip(previous), strip(nextBody));
  } catch {
    return { added: [], removed: [] };
  }
}

/**
 * Write the dated changelog note. Returns null when nothing changed, so a
 * no-op re-crawl doesn't litter the vault with empty notes.
 */
export async function writeChangelog({ destRoot, vaultRoot, changes, date = today(), now = clock() }) {
  if (!changes?.length) return null;

  const prefix = path.relative(vaultRoot, destRoot).split(path.sep).filter(Boolean).join('/');
  const file = path.join(CHANGELOG_DIR, `${date}.md`);
  const abs = path.join(destRoot, file);
  const note = renderChangelog({ date, prefix, changes });

  await fs.mkdir(path.dirname(abs), { recursive: true });

  // A second crawl on the same day must not erase the first one's record, so
  // the day's note grows a section per run instead of being replaced.
  const existing = await fs.readFile(abs, 'utf8').catch(() => null);
  if (existing) {
    const body = note.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^#[^\n]*\n/m, '');
    await fs.writeFile(abs, `${existing.trimEnd()}\n\n---\n\n## Later run — ${now}\n${body}`, 'utf8');
  } else {
    await fs.writeFile(abs, note, 'utf8');
  }

  return { file, changed: changes.filter((c) => !c.firstSeen).length, added: changes.filter((c) => c.firstSeen).length };
}

function clock() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
