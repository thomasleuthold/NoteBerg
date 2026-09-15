/**
 * Covers searching region-localized recognition results.
 *
 * These call the real functions the canvas calls. An earlier version of these
 * tests reimplemented the logic inline, which meant they described the intended
 * behaviour without being able to detect the production code diverging from it —
 * and it had diverged: highlighting and counting shared a collapsing rule, so
 * four visible matches reported as two.
 */

import { describe, expect, it } from "vitest";
import { searchRegex } from "../../utils/searchPattern.js";
import { collectHighlightBands, collectMatchPositions, wordBandBounds } from "./regionSearch.js";
import { REGION_COUNT } from "./regions.js";

/** One image covering a 600px-tall page: six bands of 100px each. */
const IMAGE = { contentY: 0, contentHeight: 600 };
const BAND_H = IMAGE.contentHeight / REGION_COUNT;

/**
 * A word localized to band `index` of an image starting at `contentY`.
 *
 * Recognition resolves a band to a content-space Y range at write time, so this
 * builds what is actually stored — a range — rather than an index plus the
 * image geometry needed to interpret it.
 */
const word = (text, index, contentY = 0) => ({
  text,
  yRange: { top: contentY + index * BAND_H, bottom: contentY + (index + 1) * BAND_H },
});

/** A word the model transcribed but could not place. */
const unplaced = (text) => ({ text });

describe("wordBandBounds", () => {
  it("reads the stored range directly, with nothing to decode", () => {
    // The point of storing a range: no stored value depends on the band scheme
    // that happens to be current when it is read.
    const bounds = wordBandBounds(word("stroke", 0));
    expect(bounds.top).toBeCloseTo(0);
    expect(bounds.bottom).toBeCloseTo(BAND_H);
  });

  it("places a later band further down the page", () => {
    const tops = [0, 1, 2, 3, 4, 5].map((i) => wordBandBounds(word("x", i)).top);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(new Set(tops).size).toBe(REGION_COUNT);
  });

  it("separates the same band seen on two different images", () => {
    // Bands divide one image, so band 0 of a second page is further down.
    const first = wordBandBounds(word("stroke", 0, 0));
    const second = wordBandBounds(word("stroke", 0, 600));
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  });

  it("returns null for a word that cannot be placed, rather than the origin", () => {
    // A word with no range is still searchable; it just has no location.
    // Defaulting to 0 would silently pin it to the top of the note.
    expect(wordBandBounds(unplaced("stroke"))).toBeNull();
    expect(wordBandBounds({ text: "x", yRange: null })).toBeNull();
    expect(wordBandBounds(null)).toBeNull();
  });

  it("rejects a malformed range rather than drawing a degenerate band", () => {
    expect(wordBandBounds({ text: "x", yRange: { top: 10 } })).toBeNull();
    expect(wordBandBounds({ text: "x", yRange: { top: 10, bottom: 10 } })).toBeNull();
    expect(wordBandBounds({ text: "x", yRange: { top: 20, bottom: 10 } })).toBeNull();
  });
});

describe("collectHighlightBands", () => {
  it("highlights every band that contains a match", () => {
    const words = [word("strokes.", 0), word("strokes", 2), word("strokes.", 5)];
    // Non-adjacent bands stay separate spans.
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(3);
  });

  it("highlights a band once however many of its words match", () => {
    const words = [word("stroke", 0), word("strokes", 0), word("stroked", 0)];
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(1);
  });

  it("merges neighbouring bands into one span", () => {
    // Two abutting rectangles leave a hairline seam that reads as a rendering
    // fault, so a contiguous run paints as a single band.
    const bands = collectHighlightBands(
      [word("stroke", 0), word("stroke", 1)],
      searchRegex("stroke"),
    );
    expect(bands).toHaveLength(1);
    expect(bands[0].h).toBeCloseTo(BAND_H * 2);
  });

  it("keeps the same band on two images as two separate spans", () => {
    // Bands divide one image, so band 0 of a second page is a different place
    // in the note — the two must not merge into one highlight.
    const words = [word("stroke", 0, 0), word("stroke", 0, 600)];
    const bands = collectHighlightBands(words, searchRegex("stroke"));
    expect(bands).toHaveLength(2);
    expect(bands[0].y).not.toBe(bands[1].y);
  });

  it("ignores words that do not match", () => {
    const words = [word("banana", 0), word("stroke", 5)];
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(1);
  });

  it("skips a region with no image bounds rather than drawing at the origin", () => {
    expect(
      collectHighlightBands([{ text: "stroke", region: "blue-0" }], searchRegex("stroke")),
    ).toHaveLength(0);
  });

  it("ignores words carrying a box instead of a region", () => {
    // Those draw as exact boxes on their own path; picking them up here would
    // paint a full-width band over a word whose position is precisely known.
    const words = [{ text: "stroke", boundingRect: { x: 0, y: 10, width: 50, height: 20 } }];
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(0);
  });

  it("matches case-insensitively and inside longer words", () => {
    const words = [word("Strokes.", 0)];
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(1);
  });

  it("returns nothing for absent or empty input", () => {
    expect(collectHighlightBands(null, searchRegex("x"))).toEqual([]);
    expect(collectHighlightBands([], searchRegex("x"))).toEqual([]);
  });
});

describe("collectMatchPositions", () => {
  it("counts matches in different bands separately", () => {
    // Four stroke* hits across four bands are four occurrences, not one. This is
    // the regression that made the navigator disagree with the page.
    const words = [
      word("strokes.", 0),
      word("strokes", 1),
      word("strokes.", 2),
      word("strokes", 5),
    ];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(4);
  });

  it("counts several matching words in one band separately", () => {
    // Highlighting collapses these into one span; counting must not.
    const words = [word("stroke", 0), word("strokes", 0)];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("does not collapse the way highlighting does", () => {
    // Stated directly: the two consumers deliberately disagree, and a future
    // refactor that unified them would reintroduce the undercount.
    const words = [word("stroke", 0), word("stroke", 1)];
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(1);
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("collapses one word read on both sides of a page break", () => {
    // The same occurrence transcribed on two images is one hit, not two: a word
    // on the break is read at the bottom of one image and the top of the next.
    // Here the last band of image 0 is centred at 550 and the first band of an
    // image starting at 540 is centred at 590, so the copies are 40px apart —
    // inside the tolerance of 67px (0.67 of a 100px band), and collapsed to a
    // single occurrence.
    const words = [word("strokes", 5, 0), word("strokes", 0, 540)];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(1);
  });

  it("keeps two genuine occurrences a full band apart", () => {
    const words = [word("strokes", 0), word("strokes", 1)];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("counts different words in the same band separately", () => {
    // The duplicate guard is keyed on text, so two distinct words that both
    // match must not suppress each other.
    const words = [word("strokes", 0), word("stroke", 0)];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("reports the middle of the band, so navigation lands on it", () => {
    const [pos] = collectMatchPositions([word("stroke", 0)], searchRegex("stroke"));
    expect(pos.y).toBeCloseTo(BAND_H / 2);
  });

  it("uses exact geometry when a word has a box", () => {
    const words = [{ text: "stroke", boundingRect: { x: 5, y: 42, width: 50, height: 20 } }];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toEqual([{ y: 42 }]);
  });

  it("reads a box stored under an older field name", () => {
    const words = [{ text: "stroke", rect: { left: 5, top: 77, w: 50, h: 20 } }];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toEqual([{ y: 77 }]);
  });

  it("skips a word that can be neither placed nor boxed", () => {
    // It stays searchable elsewhere; it simply cannot be navigated to.
    const words = [{ text: "stroke", region: "blue-0" }, { text: "stroke" }];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toEqual([]);
  });

  it("returns nothing for absent or empty input", () => {
    expect(collectMatchPositions(null, searchRegex("x"))).toEqual([]);
    expect(collectMatchPositions([], searchRegex("x"))).toEqual([]);
  });
});
