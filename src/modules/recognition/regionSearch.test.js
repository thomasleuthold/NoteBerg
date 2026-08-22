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

const word = (text, region, imageBounds = IMAGE) => ({ text, region, imageBounds });

describe("wordBandBounds", () => {
  it("resolves a stored region to the band the rasterizer painted", () => {
    const bounds = wordBandBounds(word("stroke", "blue-0"));
    expect(bounds.top).toBeCloseTo(0);
    expect(bounds.bottom).toBeCloseTo(BAND_H);
    expect(bounds.regionIndex).toBe(0);
  });

  it("places each colour further down the page than the last", () => {
    const tops = ["blue-0", "green-0", "yellow-0", "orange-0", "pink-0", "purple-0"].map(
      (r) => wordBandBounds(word("x", r)).top,
    );
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    expect(new Set(tops).size).toBe(REGION_COUNT);
  });

  it("separates the same colour seen on two different images", () => {
    // Every image repeats the same six colours, so a colour alone is ambiguous
    // once a note spans several pages.
    const first = wordBandBounds(word("stroke", "blue-0", { contentY: 0, contentHeight: 600 }));
    const second = wordBandBounds(word("stroke", "blue-1", { contentY: 600, contentHeight: 600 }));
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  });

  it("returns null for a word that cannot be placed, rather than the origin", () => {
    // A word with no bounds is still searchable; it just has no location.
    // Defaulting to 0 would silently pin it to the top of the note.
    expect(wordBandBounds({ text: "stroke", region: "blue-0" })).toBeNull();
    expect(wordBandBounds(word("stroke", "nonsense-0"))).toBeNull();
    expect(wordBandBounds({ text: "stroke", region: null })).toBeNull();
    expect(wordBandBounds(null)).toBeNull();
  });
});

describe("collectHighlightBands", () => {
  it("highlights every band that contains a match", () => {
    const words = [
      word("strokes.", "blue-0"),
      word("strokes", "yellow-0"),
      word("strokes.", "purple-0"),
    ];
    // Non-adjacent bands stay separate spans.
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(3);
  });

  it("highlights a band once however many of its words match", () => {
    const words = [word("stroke", "blue-0"), word("strokes", "blue-0"), word("stroked", "blue-0")];
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(1);
  });

  it("merges neighbouring bands into one span", () => {
    // Two abutting rectangles leave a hairline seam that reads as a rendering
    // fault, so a contiguous run paints as a single band.
    const bands = collectHighlightBands(
      [word("stroke", "blue-0"), word("stroke", "green-0")],
      searchRegex("stroke"),
    );
    expect(bands).toHaveLength(1);
    expect(bands[0].h).toBeCloseTo(BAND_H * 2);
  });

  it("keeps the same colour on two images as two separate spans", () => {
    const words = [
      word("stroke", "blue-0", { contentY: 0, contentHeight: 600 }),
      word("stroke", "blue-1", { contentY: 600, contentHeight: 600 }),
    ];
    const bands = collectHighlightBands(words, searchRegex("stroke"));
    expect(bands).toHaveLength(2);
    expect(bands[0].y).not.toBe(bands[1].y);
  });

  it("ignores words that do not match", () => {
    const words = [word("banana", "blue-0"), word("stroke", "purple-0")];
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
    const words = [word("Strokes.", "blue-0")];
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
      word("strokes.", "blue-0"),
      word("strokes", "green-0"),
      word("strokes.", "yellow-0"),
      word("strokes", "purple-0"),
    ];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(4);
  });

  it("counts several matching words in one band separately", () => {
    // Highlighting collapses these into one span; counting must not.
    const words = [word("stroke", "blue-0"), word("strokes", "blue-0")];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("does not collapse the way highlighting does", () => {
    // Stated directly: the two consumers deliberately disagree, and a future
    // refactor that unified them would reintroduce the undercount.
    const words = [word("stroke", "blue-0"), word("stroke", "green-0")];
    expect(collectHighlightBands(words, searchRegex("stroke"))).toHaveLength(1);
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("collapses one word read on both sides of a page break", () => {
    // The same occurrence transcribed on two images is one hit, not two: a word
    // on the break is read at the bottom of one image and the top of the next.
    // Here the last band of image 0 is centred at 550 and the first band of
    // image 1 at 590, so the copies are 40px apart — inside the tolerance of
    // 67px (0.67 of a 100px band), and collapsed to a single occurrence.
    const words = [
      word("strokes", "purple-0", { contentY: 0, contentHeight: 600 }),
      word("strokes", "blue-1", { contentY: 540, contentHeight: 600 }),
    ];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(1);
  });

  it("keeps two genuine occurrences a full band apart", () => {
    const words = [word("strokes", "blue-0"), word("strokes", "green-0")];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("counts different words in the same band separately", () => {
    // The duplicate guard is keyed on text, so two distinct words that both
    // match must not suppress each other.
    const words = [word("strokes", "blue-0"), word("stroke", "blue-0")];
    expect(collectMatchPositions(words, searchRegex("stroke"))).toHaveLength(2);
  });

  it("reports the middle of the band, so navigation lands on it", () => {
    const [pos] = collectMatchPositions([word("stroke", "blue-0")], searchRegex("stroke"));
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
