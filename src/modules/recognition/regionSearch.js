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

import { decodeRegion, mergeAdjacentBands, regionBounds } from "./regions.js";

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
 * Resolve a word's stored region to its content-space band bounds.
 *
 * @param {{region: unknown, imageBounds: Object}} word
 * @returns {{top: number, bottom: number, regionIndex: number}|null} null when
 *   the region cannot be decoded or the word carries no image bounds — such a
 *   word is still searchable, it simply cannot be placed.
 */
export function wordBandBounds(word) {
  if (!word || word.region == null || !word.imageBounds) return null;

  const decoded = decodeRegion(word.region);
  if (!decoded) return null;

  const bounds = regionBounds(decoded.regionIndex, word.imageBounds);
  if (!bounds) return null;

  return { ...bounds, regionIndex: decoded.regionIndex };
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

  // Keyed by region so a band contributes one span no matter how many of its
  // words match.
  const matched = new Map();

  for (const word of words) {
    if (!word?.text || word.region == null) continue;
    regex.lastIndex = 0;
    if (!regex.test(word.text)) continue;
    if (!matched.has(word.region)) matched.set(word.region, word);
  }

  const bands = [];
  for (const word of matched.values()) {
    const bounds = wordBandBounds(word);
    if (!bounds) continue;
    bands.push({
      y: bounds.top,
      h: bounds.bottom - bounds.top,
      region: bounds.regionIndex,
    });
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

    if (word.region != null) {
      const bounds = wordBandBounds(word);
      if (!bounds) continue;

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
