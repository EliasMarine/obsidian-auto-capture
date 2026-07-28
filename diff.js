/**
 * What changed between two versions of a note, for the changelog.
 *
 * ponytail: multiset line difference, not a real LCS diff — O(n) instead of
 * O(n·m), and a changelog only needs "these lines appeared, those left". The
 * ceiling: a line moved from one section to another shows up as neither added
 * nor removed, and a reordered document reads as unchanged. Swap in a proper
 * LCS if the changelog ever needs to show position.
 */

const meaningful = (text) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const countBy = (lines) => {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

/** @returns {{ added: string[], removed: string[] }} in document order. */
export function lineDiff(before, after) {
  const oldCounts = countBy(meaningful(before));
  const newCounts = countBy(meaningful(after));

  /** Lines in `order` that the other side has no unconsumed copy of. */
  const surplus = (theirs, order) => {
    const remaining = new Map(theirs);
    const out = [];
    for (const line of order) {
      const left = remaining.get(line) ?? 0;
      if (left > 0) remaining.set(line, left - 1);
      else out.push(line);
    }
    return out;
  };

  return {
    added: surplus(oldCounts, meaningful(after)),
    removed: surplus(newCounts, meaningful(before)),
  };
}
