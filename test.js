import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkCapturedPages } from './wikilinks.js';
import { buildNote } from './capture.js';
import { isSuggested, scopeFromUrl } from './discover.js';
import { normalizeUrl, resolveInside, sanitizeSegment, siteFolder, uniquePath, urlToRelPath, yamlValue } from './paths.js';

test('every note lands under its own site folder', () => {
  assert.equal(urlToRelPath('https://x.com/docs/intro', 'Getting Started'), 'x.com/docs/Getting Started.md');
  assert.equal(urlToRelPath('https://x.com/docs/intro/', ''), 'x.com/docs/intro.md');
  assert.equal(urlToRelPath('https://x.com/a/b/c.html', ''), 'x.com/a/b/c.md');
  assert.equal(urlToRelPath('https://x.com/', ''), 'x.com/x.com.md');
  assert.equal(urlToRelPath('https://x.com/guide/%E4%B8%AD%E6%96%87', ''), 'x.com/guide/中文.md');
});

test('site folder drops www and cannot escape the destination', () => {
  assert.equal(siteFolder('https://www.edx.org/learn/x'), 'edx.org');
  assert.equal(siteFolder('https://docs.example.co.uk/a'), 'docs.example.co.uk');
  assert.equal(siteFolder('http://127.0.0.1:4599/index.html'), '127.0.0.1');
  assert.equal(urlToRelPath('https://www.edx.org/learn/ai', 'AI'), 'edx.org/learn/AI.md');
  // Two sites never collide, even with identical paths and titles.
  assert.notEqual(urlToRelPath('https://a.com/p', 'Same'), urlToRelPath('https://b.com/p', 'Same'));
});

test('query strings get a stable disambiguating suffix', () => {
  const a = urlToRelPath('https://x.com/s?q=1', 'Search');
  const b = urlToRelPath('https://x.com/s?q=2', 'Search');
  assert.notEqual(a, b);
  assert.equal(a, urlToRelPath('https://x.com/s?q=1', 'Search'));
});

test('titles cannot escape the destination or break Obsidian links', () => {
  assert.equal(sanitizeSegment('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeSegment('a/b:c*d?e|f'), 'a-b-c-d-e-f');
  assert.equal(sanitizeSegment('[[wikilink]] #tag ^block'), 'wikilink- -tag -block');
  assert.equal(sanitizeSegment('  .hidden  '), 'hidden');
  assert.equal(sanitizeSegment('trailing.'), 'trailing');
  assert.equal(sanitizeSegment(''), '');
  assert.equal(urlToRelPath('https://x.com/p', '../../../secret'), 'x.com/secret.md');
});

test('resolveInside refuses to write outside the destination', () => {
  assert.equal(resolveInside('/vault/clips', 'a/b.md'), '/vault/clips/a/b.md');
  assert.throws(() => resolveInside('/vault/clips', '../../etc/passwd'), /outside destination/);
  assert.throws(() => resolveInside('/vault/clips', '/etc/passwd'), /outside destination/);
});

test('uniquePath resolves collisions case-insensitively', () => {
  const taken = new Set();
  assert.equal(uniquePath('a/Note.md', taken), 'a/Note.md');
  assert.equal(uniquePath('a/note.md', taken), 'a/note 2.md');
  assert.equal(uniquePath('a/NOTE.md', taken), 'a/NOTE 3.md');
});

test('a site-wide og:title does not collapse every page into "Name 2..45"', () => {
  // help.ui.com returns og:title "Ubiquiti Help Center" on every section page.
  const taken = new Set();
  const title = 'x.com/Ubiquiti Help Center.md';
  const first = uniquePath(title, taken, 'x.com/7896425142679-Features-Configuration.md');
  const second = uniquePath(title, taken, 'x.com/7895096582039-Consoles.md');
  const third = uniquePath(title, taken, 'x.com/1234567890-Adoption.md');
  assert.equal(first, 'x.com/Ubiquiti Help Center.md');
  assert.equal(second, 'x.com/7895096582039-Consoles.md', 'falls back to the URL slug, not a counter');
  assert.equal(third, 'x.com/1234567890-Adoption.md');
  // Only if the slug itself repeats do we resort to numbering — and we number the slug.
  assert.equal(uniquePath(title, taken, 'x.com/1234567890-Adoption.md'), 'x.com/1234567890-Adoption 2.md');
});

test('normalizeUrl collapses the variants that mean the same page', () => {
  assert.equal(normalizeUrl('https://X.com/a/#top'), 'https://x.com/a');
  assert.equal(normalizeUrl('https://x.com/a'), normalizeUrl('https://x.com/a/'));
  assert.equal(normalizeUrl('/b', 'https://x.com/a/c'), 'https://x.com/b');
  assert.equal(normalizeUrl('https://x.com/'), 'https://x.com/');
});

test('yamlValue survives titles containing YAML syntax', () => {
  assert.equal(yamlValue('Plain'), '"Plain"');
  assert.equal(yamlValue('A: "B" — c'), '"A: \\"B\\" — c"');
  assert.equal(yamlValue('multi\nline'), '"multi line"');
  assert.equal(yamlValue(''), '');
  assert.equal(yamlValue(undefined), '');
});

test('buildNote emits Web Clipper frontmatter that parses as one block', () => {
  const note = buildNote(
    { title: 'Why: it "works"', author: 'A. Person', published: '2024-01-02', description: '', content: '# Body\n\ntext' },
    'https://x.com/p?a=1',
  );
  const [, frontmatter, body] = note.split(/^---$/m);
  assert.match(frontmatter, /title: "Why: it \\"works\\""/);
  assert.match(frontmatter, /source: "https:\/\/x\.com\/p\?a=1"/);
  assert.match(frontmatter, /created: \d{4}-\d{2}-\d{2}/);
  assert.match(frontmatter, /description: \n/);
  assert.match(frontmatter, /tags:\n {2}- clippings/);
  assert.equal(body.trim(), '# Body\n\ntext');
});

test('scopeFromUrl narrows to the section the start URL sits in', () => {
  assert.equal(scopeFromUrl('https://openrouter.ai/docs/quickstart'), '/docs/');
  assert.equal(scopeFromUrl('https://openrouter.ai/docs/guides/overview/principles'), '/docs/guides/overview/');
  assert.equal(scopeFromUrl('https://x.com/'), '/');
  assert.equal(scopeFromUrl('https://x.com/docs'), '/', 'single segment has no parent section');
});

test('links between captured pages become wikilinks, everything else is left alone', async () => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'oac-'));
  const dest = path.join(vault, 'raw');
  await fs.mkdir(path.join(dest, 'site.com'), { recursive: true });

  const body = [
    '---',
    'title: "A"',
    'source: "https://site.com/a"',
    '---',
    'See [Page B](https://site.com/b) and [B again](https://site.com/b/) and [Plain](https://site.com/c).',
    'External [Google](https://google.com/x) stays put.',
    '',
    '```markdown',
    'Example: [Page B](https://site.com/b) must survive verbatim.',
    '```',
  ].join('\n');
  await fs.writeFile(path.join(dest, 'site.com', 'A.md'), body);
  await fs.writeFile(path.join(dest, 'site.com', 'Page B.md'), '# B\n');

  const index = new Map([
    ['https://site.com/a', { file: 'site.com/A.md', hash: 'x' }],
    ['https://site.com/b', { file: 'site.com/Page B.md', hash: 'y' }],
  ]);

  const stats = await linkCapturedPages({ destRoot: dest, vaultRoot: vault, index });
  const out = await fs.readFile(path.join(dest, 'site.com', 'A.md'), 'utf8');

  assert.equal(stats.linksRewritten, 2, 'both /b and /b/ resolve to the same note');
  assert.match(out, /See \[\[raw\/site\.com\/Page B\]\] and/, 'no redundant alias when the label is the note name');
  assert.match(out, /\[\[raw\/site\.com\/Page B\|B again\]\]/, 'keeps each link its own label');
  assert.match(out, /\[Plain\]\(https:\/\/site\.com\/c\)/, 'uncaptured page keeps its plain link');
  assert.match(out, /\[Google\]\(https:\/\/google\.com\/x\)/, 'external links untouched');
  assert.match(out, /Example: \[Page B\]\(https:\/\/site\.com\/b\) must survive/, 'code fences untouched');
  assert.match(out, /source: "https:\/\/site\.com\/a"/, 'frontmatter untouched');

  // Running twice must not double-rewrite.
  const second = await linkCapturedPages({ destRoot: dest, vaultRoot: vault, index });
  assert.equal(second.linksRewritten, 0, 'idempotent');

  await fs.rm(vault, { recursive: true, force: true });
});

test('isSuggested unchecks the pages nobody wants clipped', () => {
  assert.equal(isSuggested('https://x.com/blog/real-post'), true);
  assert.equal(isSuggested('https://x.com/docs/a/b/c'), true);
  assert.equal(isSuggested('https://x.com/tag/ai'), false);
  assert.equal(isSuggested('https://x.com/blog/page/3'), false);
  assert.equal(isSuggested('https://x.com/author/kepano/'), false);
  assert.equal(isSuggested('https://x.com/search?q=a'), false);
  assert.equal(isSuggested('https://x.com/files/report.pdf'), false);
  assert.equal(isSuggested('https://x.com/homepage-redesign'), true, 'must not match /page/ inside a word');
});
