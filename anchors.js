/**
 * Heading anchors, so a link to https://site/page#_firewall_rules can become
 * [[page#Firewall Rules]] instead of dumping the reader at the top of a
 * 3,000-word note.
 *
 * The fragment in a URL is an HTML id; the wikilink needs the *heading text*.
 * Only this module knows how to get from one to the other, and it has to run
 * while we still have the DOM — the extracted Markdown no longer carries ids.
 */

const HEADINGS = 'h1, h2, h3, h4, h5, h6';
// The characters that delimit a wikilink or a heading link can't appear inside one.
const clean = (text) =>
  String(text ?? '')
    .replace(/[|[\]#^]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Map every id a heading can be reached by to that heading's text.
 *
 * Three shapes are common in the wild and all three are handled:
 *   <h2 id="rules">Rules</h2>                     — the id is on the heading
 *   <h2><a id="rules"></a>Rules</h2>              — asciidoc/docbook output
 *   <a id="rules"></a><h2>Rules</h2>              — the anchor precedes it
 */
export function headingAnchors(document) {
  // Prototype-less: ids come from the page, and on a plain object every
  // Object.prototype key ("constructor", "toString", …) reads back truthy —
  // which silently dropped real headings named that, and made lookups on the
  // other side return an inherited function.
  const anchors = Object.create(null);

  for (const heading of document.querySelectorAll(HEADINGS)) {
    const text = clean(heading.textContent);
    if (!text) continue;

    const ids = [heading.id];
    for (const inner of heading.querySelectorAll('[id]')) ids.push(inner.id);

    // An empty anchor sitting immediately before the heading names it too.
    const before = heading.previousElementSibling;
    if (before?.tagName === 'A' && before.id && !before.textContent.trim()) ids.push(before.id);

    for (const id of ids) {
      if (id && !anchors[id]) anchors[id] = text;
    }
  }

  return anchors;
}
