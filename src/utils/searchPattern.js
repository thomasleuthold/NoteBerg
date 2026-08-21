/**
 * Search query → regular expression.
 *
 * Search accepts two wildcards, `*` (any run of characters) and `?` (any single
 * character); everything else in a query is literal. That rule is user-facing,
 * so the four places that search — recognised handwriting, the note's text
 * layer, PDF text, and the overview list — must agree on it exactly. They each
 * built the same expression inline, which meant a change to what `*` means was
 * four edits, and any one of them being missed would give the same query
 * different results depending on where the text lived.
 */

/** Escape every character that carries meaning in a regular expression. */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a user's query into a regex source string.
 *
 * The query is escaped first and the wildcards reinstated afterwards, so a `*`
 * typed by the user becomes a wildcard while a `.` stays a literal dot.
 *
 * @param {string} query
 * @returns {string} regex source, not yet compiled
 */
export function searchPatternSource(query) {
  return escapeRegex(query).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
}

/**
 * Compile a user's query into a case-insensitive global regex.
 *
 * Callers that use `.test()` or `.exec()` repeatedly must reset `lastIndex`
 * between uses — that is inherent to the global flag, which is needed so a
 * single line can yield several matches.
 *
 * @param {string} query
 * @param {{capture?: boolean}} [options] - capture wraps the pattern in a group,
 *   for callers that split on the match to wrap it in markup
 * @returns {RegExp}
 */
export function searchRegex(query, options = {}) {
  const source = searchPatternSource(query);
  return new RegExp(options.capture ? `(${source})` : source, "gi");
}
