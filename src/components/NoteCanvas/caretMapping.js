/**
 * Where the caret goes when the text around it is replaced by a version with
 * someone else's changes merged in (TextLayer.replaceContent).
 *
 * Kept as a raw character offset, text arriving above the caret moved it back
 * by that much, into whatever the other writer had added. Instead the caret
 * follows the text it was in: a change wholly before it shifts it, one wholly
 * after it leaves it alone, and when the change surrounds it, the text right
 * around the caret is looked for in the new version.
 */

/** How many characters on each side of the caret identify its place. */
const CONTEXT = 16;

/**
 * @param {string} before - the editor's text before the replacement
 * @param {string} after - its text after
 * @param {number} offset - the caret's character offset into `before`
 * @returns {number} the caret's offset into `after`
 */
export function mapCaretOffset(before, after, offset) {
  if (before === after) return offset;
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  // The change lies after the caret: nothing before it moved
  if (offset <= prefix) return offset;
  // The change lies before the caret: it moves by what was added or removed
  if (offset >= before.length - suffix) return offset + (after.length - before.length);

  // The change surrounds the caret: find the text it stood in
  const left = before.slice(Math.max(0, offset - CONTEXT), offset);
  const right = before.slice(offset, offset + CONTEXT);
  const both = after.indexOf(left + right);
  if (left && right && both >= 0) return both + left.length;
  const nearest = (needle) => {
    let best = -1;
    for (let at = after.indexOf(needle); at >= 0; at = after.indexOf(needle, at + 1)) {
      if (best < 0 || Math.abs(at - offset) < Math.abs(best - offset)) best = at;
    }
    return best;
  };
  if (left) {
    const at = nearest(left);
    if (at >= 0) return at + left.length;
  }
  if (right) {
    const at = nearest(right);
    if (at >= 0) return at;
  }
  return Math.min(offset, after.length);
}
