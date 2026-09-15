/**
 * Searching region-localized recognition results.
 *
 * AI recognition locates a word to a coloured band rather than a box, so
 * searching it means turning matched words into band geometry. Two consumers
 * need that, and they must not agree too closely: the canvas *draws* one span
 * per contiguous region, while the navigator *counts* one entry per occurrence.
 * Collapsing them the same way was a real bug — four visible matches reported as
 * two — so the difference between them is the point, and each is expressed here
 * as its own function.
 *
 * These are pure and take geometry as arguments so they can be tested directly.
 * The logic previously lived inline in NoteCanvas methods, which meant tests
 * reimplemented it and therefore could not catch a regression in it.
 */

import { mergeAdjacentBands } from "./regions.js";

/**
 * Fraction of a band's height within which two hits on the same word are
 * treated as one occurrence seen twice.
 *
 * Derived from band height rather than fixed, since bands scale with note
 * geometry. A duplicate from a word straddling a page break lands within a band
 * of its twin, whereas two bands of the same image are a full band apart — so
 * two-thirds of a band separates them reliably.
 */
const OVERLAP_TOLERANCE_RATIO = 0.67;

/**
 * A word's content-space band bounds, as stored.
 *
 * Recognition resolves the band a model named into a Y range at write time
 * (regions.regionToContentRange), so there is nothing to decode here — which is
 * the point: no stored value depends on the band scheme that is current when it
 * is read.
 *
 * @param {{yRange: {top: number, bottom: number}}} word
 * @returns {{top: number, bottom: number}|null} null when the word carries no
 *   range — it is still searchable, it simply cannot be placed.
 */
export function wordBandBounds(word) {
  const range = word?.yRange;
  if (!range) return null;
  if (typeof range.top !== "number" || typeof range.bottom !== "number") return null;
  if (!(range.bottom > range.top)) return null;
  return { top: range.top, bottom: range.bottom };
}

/**
 * Bands to highlight for a search, as content-space spans.
 *
 * A band highlights once however many matching words it holds, and neighbouring
 * bands merge into one span: two abutting rectangles leave a hairline seam that
 * reads as a rendering fault.
 *
 * @param {Array} words - recognition words
 * @param {RegExp} regex - global, case-insensitive; lastIndex is reset per word
 * @returns {Array<{y: number, h: number, region: number}>} sorted, merged
 */
export function collectHighlightBands(words, regex) {
  if (!Array.isArray(words)) return [];

  // Keyed by the band's own extent so a band contributes one span no matter how
  // many of its words match. The range replaces the old region id as the
  // identity of a band — two words sharing a range were on the same band.
  const matched = new Map();

  for (const word of words) {
    if (!word?.text) continue;
    const bounds = wordBandBounds(word);
    if (!bounds) continue;
    regex.lastIndex = 0;
    if (!regex.test(word.text)) continue;

    const key = `${bounds.top}:${bounds.bottom}`;
    if (!matched.has(key)) matched.set(key, bounds);
  }

  const bands = [];
  for (const bounds of matched.values()) {
    bands.push({ y: bounds.top, h: bounds.bottom - bounds.top });
  }

  return mergeAdjacentBands(bands);
}

/**
 * Y positions of individual search occurrences, for the match navigator.
 *
 * Deliberately does *not* collapse the way highlighting does: several matching
 * words in one band are several occurrences, and reporting them as one made the
 * navigator disagree with what the user could see on the page.
 *
 * The one thing that does collapse is the same word appearing twice at nearly
 * the same place — one occurrence read on both sides of a page break, not two.
 *
 * @param {Array} words - recognition words
 * @param {RegExp} regex - global, case-insensitive; lastIndex is reset per word
 * @returns {Array<{y: number}>} one entry per occurrence, in word order
 */
export function collectMatchPositions(words, regex) {
  if (!Array.isArray(words)) return [];

  const positions = [];
  // Keyed by text so the scan stays linear. A flat list scanned per match is
  // quadratic, and a page of repeated words is exactly when search is slowest.
  const acceptedByText = new Map();

  for (const word of words) {
    if (!word?.text) continue;
    regex.lastIndex = 0;
    if (!regex.test(word.text)) continue;

    const bounds = wordBandBounds(word);
    if (bounds) {
      const centre = (bounds.top + bounds.bottom) / 2;
      const tolerance = (bounds.bottom - bounds.top) * OVERLAP_TOLERANCE_RATIO;

      const seen = acceptedByText.get(word.text);
      if (seen?.some((y) => Math.abs(y - centre) <= tolerance)) continue;

      if (seen) seen.push(centre);
      else acceptedByText.set(word.text, [centre]);

      positions.push({ y: centre });
      continue;
    }

    // Exact geometry from the Windows sidecar. Several shapes exist in stored
    // data, so the y is read from whichever the word carries.
    const box = word.boundingRect || word.boundingBox || word.rect;
    if (!box) continue;

    const y = box.y !== undefined ? box.y : box.top;
    if (y !== undefined) positions.push({ y });
  }

  return positions;
}
