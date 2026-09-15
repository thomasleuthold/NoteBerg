/**
 * Line breaks inside a recognition's word list.
 *
 * A leaf module with no imports, deliberately. Breaks are understood by the
 * backends, by the stitcher and by the text renderer, and those sit on opposite
 * sides of the pipeline: putting the vocabulary in recognitionService.js — the
 * obvious home — made the backends import it, and through it the Windows
 * sidecar and its Tauri HTTP plugin, in contexts that have neither.
 *
 * Breaks are stored as entries in `words` rather than as a parallel structure
 * because the recognition object travels as one unit: through storage,
 * encryption, sync and the MCP bridge. A second array would need every one of
 * those to keep the two in step, and would drift the first time one was written
 * without the other.
 *
 * The entries deliberately carry no `text`. Every existing consumer of `words`
 * already skips entries without one — highlight boxes, both region-search
 * matchers, the band shifter and the task labeller each guard on `word.text` or
 * on geometry — so a break passes through the whole pipeline without any of
 * them needing to learn what it is. Storing `text: "\n"` instead would make all
 * of them treat it as a searchable word.
 */

/** Ends a line. */
export const BREAK_LINE = 1;

/** Separates two paragraphs: one blank line. */
export const BREAK_PARAGRAPH = 2;

/**
 * Whether an entry in `words` is a break rather than a transcribed word.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isBreak(entry) {
  return Boolean(entry) && typeof entry.text !== "string" && entry.break > 0;
}

/**
 * Build a break entry, clamped to the counts that mean something.
 *
 * Anything larger than a paragraph gap is clamped rather than rejected: a model
 * reporting five blank lines is describing a paragraph break with extra
 * enthusiasm, and honouring it literally would put a hole in the page.
 *
 * @param {unknown} count
 * @returns {{break: number}}
 */
export function makeBreak(count) {
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < BREAK_LINE) return { break: BREAK_LINE };
  return { break: Math.min(n, BREAK_PARAGRAPH) };
}

/**
 * How many real words a list holds.
 *
 * Breaks share the array with words but are layout, not content: counting them
 * would report more words than the page has, wherever a count is shown to the
 * user.
 *
 * @param {Array} words
 * @returns {number}
 */
export function countWords(words) {
  if (!Array.isArray(words)) return 0;
  return words.reduce((n, w) => n + (isBreak(w) ? 0 : 1), 0);
}

/**
 * Render the flat text of a word list, honouring break entries.
 *
 * Words are joined with a space and breaks become newlines, so the stored text
 * keeps the shape the handwriting had. Search reads this string, which is why
 * breaks render as plain newlines rather than anything more elaborate:
 * whitespace is what every existing consumer already treats as a separator.
 *
 * Breaks are held rather than emitted as they are met, which is what makes the
 * output tolerant of how inconsistently models place them: a run of markers
 * collapses to the largest, and markers with no word after them never reach the
 * text at all. A model that ends every line with a break — including the last —
 * therefore produces no trailing blank line.
 *
 * @param {Array} words - normalized words, possibly containing break entries
 * @returns {string}
 */
export function renderFullText(words) {
  if (!Array.isArray(words)) return "";

  let text = "";
  let pendingBreak = 0;

  for (const entry of words) {
    if (isBreak(entry)) {
      // Nothing written yet: a leading break would open the text with a blank
      // line that is not on the page.
      if (text === "") continue;
      const size = Math.min(entry.break, BREAK_PARAGRAPH);
      pendingBreak = Math.max(pendingBreak, size);
      continue;
    }
    if (typeof entry?.text !== "string" || entry.text === "") continue;

    if (pendingBreak > 0) {
      text += "\n".repeat(pendingBreak);
      pendingBreak = 0;
    } else if (text !== "") {
      text += " ";
    }
    text += entry.text;
  }

  return text.trim();
}
