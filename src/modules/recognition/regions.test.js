/**
 * Covers colour-band localization.
 *
 * The premise: models report which coloured band a word sits on far more
 * reliably than they report coordinates. These tests pin the parts that make
 * that usable — tolerant parsing of how a model phrases a band, and bounds that
 * match what the rasterizer actually painted.
 */

import { describe, expect, it } from "vitest";
import {
  mergeAdjacentBands,
  parseRegionId,
  REGION_COLORS,
  REGION_COUNT,
  regionBounds,
  regionForY,
  regionToContentRange,
} from "./regions.js";

describe("region palette", () => {
  it("defines exactly one colour per band", () => {
    expect(REGION_COLORS).toHaveLength(REGION_COUNT);
  });

  it("gives every band a distinct colour name, so the model can name them", () => {
    const names = REGION_COLORS.map((c) => c.name);
    expect(new Set(names).size).toBe(REGION_COUNT);
  });

  it("keeps every pair far enough apart in RGB to be told apart", () => {
    // The regression this guards. The first palette picked hues far apart on
    // the wheel and then made them so pale that the separation did not survive
    // into RGB: pink and purple ended up 14 units apart out of 441, and a real
    // note had two lines placed a whole band below where they were written.
    //
    // Hue distance is not the measure — these are near-white, where hue barely
    // registers. Channel distance is.
    const rgb = (hex) => [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
    const distance = (a, b) =>
      Math.sqrt(rgb(a).reduce((sum, v, i) => sum + (v - rgb(b)[i]) ** 2, 0));

    for (let i = 0; i < REGION_COLORS.length; i++) {
      for (let j = i + 1; j < REGION_COLORS.length; j++) {
        const d = distance(REGION_COLORS[i].fill, REGION_COLORS[j].fill);
        expect(
          d,
          `${REGION_COLORS[i].name} and ${REGION_COLORS[j].name} are only ${d.toFixed(1)} apart`,
        ).toBeGreaterThan(12);
      }
    }
  });

  it("stays far lighter than ink, so handwriting is still what reads", () => {
    // The bands are a label under the writing, not a highlight over it. Ink is
    // near zero, so every channel staying high keeps the contrast that makes
    // the image legible to the model in the first place.
    for (const colour of REGION_COLORS) {
      const channels = [
        Number.parseInt(colour.fill.slice(1, 3), 16),
        Number.parseInt(colour.fill.slice(3, 5), 16),
        Number.parseInt(colour.fill.slice(5, 7), 16),
      ];
      expect(Math.min(...channels), `${colour.name} is too dark`).toBeGreaterThan(190);
    }
  });
});

describe("parseRegionId", () => {
  it("accepts a colour name", () => {
    expect(parseRegionId("green")).toBe(1);
    expect(parseRegionId("purple")).toBe(5);
  });

  it("accepts a colour name inside a phrase, as models tend to answer", () => {
    // Losing a usable answer over phrasing would be needless.
    expect(parseRegionId("the green band")).toBe(1);
    expect(parseRegionId("Yellow")).toBe(2);
  });

  it("accepts another reasonable name for the same colour", () => {
    // A model describing what it sees rather than picking from the offered list
    // is answering correctly. #fbd9d9 really is a pale pink, and dropping that
    // answer would lose the word's placement over vocabulary alone.
    expect(parseRegionId("pink")).toBe(4);
    expect(parseRegionId("salmon")).toBe(4);
    expect(parseRegionId("peach")).toBe(3);
    expect(parseRegionId("violet")).toBe(5);
  });

  it("prefers a canonical name over an alias when both could match", () => {
    // "light blue" contains "blue"; an alias must never shadow a real name.
    expect(parseRegionId("light blue")).toBe(0);
    expect(parseRegionId("mint green")).toBe(1);
  });

  it("accepts a zero-based index", () => {
    expect(parseRegionId(0)).toBe(0);
    expect(parseRegionId(5)).toBe(5);
  });

  it("accepts a one-based number, as a person would write it", () => {
    // 1..6 is ambiguous with 0..5, so it is resolved toward the human reading
    // only for values outside the zero-based range.
    expect(parseRegionId("6")).toBe(5);
  });

  it("rejects anything it cannot interpret rather than guessing a band", () => {
    expect(parseRegionId("chartreuse")).toBe(-1);
    expect(parseRegionId("")).toBe(-1);
    expect(parseRegionId(null)).toBe(-1);
    expect(parseRegionId(99)).toBe(-1);
  });
});

describe("regionBounds", () => {
  const page = { contentY: 0, contentHeight: 600 };

  it("divides the page into equal bands", () => {
    expect(regionBounds(0, page)).toEqual({ top: 0, bottom: 100 });
    expect(regionBounds(5, page)).toEqual({ top: 500, bottom: 600 });
  });

  it("covers the page with no gaps between bands", () => {
    for (let i = 1; i < REGION_COUNT; i++) {
      expect(regionBounds(i, page).top).toBe(regionBounds(i - 1, page).bottom);
    }
  });

  it("respects an image that does not start at zero", () => {
    // The second rendered image of a long note starts partway down.
    expect(regionBounds(0, { contentY: 200, contentHeight: 600 }).top).toBe(200);
  });

  it("returns null for an out-of-range band or a degenerate page", () => {
    expect(regionBounds(-1, page)).toBeNull();
    expect(regionBounds(REGION_COUNT, page)).toBeNull();
    expect(regionBounds(0, { contentY: 10, contentHeight: 0 })).toBeNull();
  });
});

describe("regionForY", () => {
  const page = { contentY: 0, contentHeight: 600 };

  it("maps a coordinate to the band containing it", () => {
    expect(regionForY(50, page)).toBe(0);
    expect(regionForY(550, page)).toBe(5);
  });

  it("puts the last coordinate in the last band, not past the end", () => {
    expect(regionForY(600, page)).toBe(REGION_COUNT - 1);
  });

  it("clamps a coordinate slightly outside the page to the nearest band", () => {
    // A stroke a pixel outside the computed bounds belongs to the nearest band,
    // not to nothing.
    expect(regionForY(-5, page)).toBe(0);
    expect(regionForY(605, page)).toBe(REGION_COUNT - 1);
  });

  it("agrees with regionBounds, so a highlight lands on the colour the model saw", () => {
    for (let i = 0; i < REGION_COUNT; i++) {
      const bounds = regionBounds(i, page);
      const middle = (bounds.top + bounds.bottom) / 2;
      expect(regionForY(middle, page)).toBe(i);
    }
  });
});

describe("regionToContentRange", () => {
  const image = { contentY: 1000, contentHeight: 600 };

  it("resolves a band to the slice of content it covers", () => {
    // Resolved once at recognition time, so nothing stored later depends on
    // whatever REGION_COUNT happens to be current when it is read.
    expect(regionToContentRange(0, image)).toEqual({ top: 1000, bottom: 1100 });
    expect(regionToContentRange(5, image)).toEqual({ top: 1500, bottom: 1600 });
  });

  it("covers the image exactly, with no gap between bands", () => {
    // A gap would leave words that fall in it unplaceable for no reason.
    let previous = null;
    for (let i = 0; i < REGION_COUNT; i++) {
      const range = regionToContentRange(i, image);
      if (previous) expect(range.top).toBe(previous.bottom);
      previous = range;
    }
    expect(previous.bottom).toBe(image.contentY + image.contentHeight);
  });

  it("refuses a band outside the scheme rather than inventing a range", () => {
    expect(regionToContentRange(-1, image)).toBeNull();
    expect(regionToContentRange(REGION_COUNT, image)).toBeNull();
  });

  it("refuses an image with no height", () => {
    expect(regionToContentRange(0, { contentY: 0, contentHeight: 0 })).toBeNull();
    expect(regionToContentRange(0, null)).toBeNull();
  });

  it("distinguishes the same band on two different images", () => {
    // Bands divide one image, so band 2 of a later page is further down the
    // note — the reason a bare band index was never enough on its own.
    const first = regionToContentRange(2, { contentY: 0, contentHeight: 600 });
    const second = regionToContentRange(2, { contentY: 600, contentHeight: 600 });

    expect(second.top).toBeGreaterThan(first.top);
  });
});

describe("mergeAdjacentBands", () => {
  // Images overlap so no text line is cut in half, which means a word in the
  // overlap lands in the last band of one image and the first of the next.
  // Highlighting both painted stacked stripes over one occurrence.
  it("merges two bands that overlap", () => {
    const merged = mergeAdjacentBands([
      { y: 1333, h: 267, region: 5 },
      { y: 1480, h: 267, region: 0 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].y).toBe(1333);
    expect(merged[0].y + merged[0].h).toBe(1747);
  });

  it("merges bands that exactly touch, leaving no seam", () => {
    const merged = mergeAdjacentBands([
      { y: 0, h: 100, region: 0 },
      { y: 100, h: 100, region: 1 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].h).toBe(200);
  });

  it("keeps bands that are genuinely apart", () => {
    const merged = mergeAdjacentBands([
      { y: 0, h: 100, region: 0 },
      { y: 500, h: 100, region: 3 },
    ]);

    expect(merged).toHaveLength(2);
  });

  it("sorts before merging, so input order does not matter", () => {
    const merged = mergeAdjacentBands([
      { y: 500, h: 100, region: 3 },
      { y: 0, h: 100, region: 0 },
    ]);

    expect(merged[0].y).toBe(0);
    expect(merged[1].y).toBe(500);
  });

  it("collapses a run of several overlapping bands into one", () => {
    const merged = mergeAdjacentBands([
      { y: 0, h: 200, region: 4 },
      { y: 150, h: 200, region: 5 },
      { y: 300, h: 200, region: 0 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].h).toBe(500);
  });

  it("does not mutate its input", () => {
    const input = [
      { y: 0, h: 200, region: 0 },
      { y: 100, h: 200, region: 1 },
    ];
    mergeAdjacentBands(input);
    expect(input[0].h).toBe(200);
  });

  it("handles an empty list", () => {
    expect(mergeAdjacentBands([])).toEqual([]);
    expect(mergeAdjacentBands(null)).toEqual([]);
  });
});
