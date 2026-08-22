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
  decodeRegion,
  encodeRegion,
  mergeAdjacentBands,
  parseRegionId,
  REGION_COLORS,
  REGION_COUNT,
  regionBounds,
  regionForY,
} from "./regions.js";

describe("region palette", () => {
  it("defines exactly one colour per band", () => {
    expect(REGION_COLORS).toHaveLength(REGION_COUNT);
  });

  it("gives every band a distinct colour name, so the model can name them", () => {
    const names = REGION_COLORS.map((c) => c.name);
    expect(new Set(names).size).toBe(REGION_COUNT);
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

describe("encodeRegion / decodeRegion", () => {
  it("pairs a band with the image it was seen on", () => {
    // Every image repeats the same six colours, so a colour alone cannot locate
    // a word in a note long enough to need more than one image.
    expect(encodeRegion(1, 1)).toBe("green-1");
    expect(decodeRegion("green-1")).toEqual({ imageIndex: 1, regionIndex: 1 });
  });

  it("round-trips every band on every plausible image index", () => {
    for (let img = 0; img < 4; img++) {
      for (let r = 0; r < REGION_COUNT; r++) {
        expect(decodeRegion(encodeRegion(img, r))).toEqual({ imageIndex: img, regionIndex: r });
      }
    }
  });

  it("distinguishes the same colour on different images", () => {
    expect(encodeRegion(0, 2)).not.toBe(encodeRegion(1, 2));
  });

  it("reads a bare colour as image 0, so older data still resolves", () => {
    expect(decodeRegion("green")).toEqual({ imageIndex: 0, regionIndex: 1 });
  });

  it("reads a bare index as image 0", () => {
    expect(decodeRegion(3)).toEqual({ imageIndex: 0, regionIndex: 3 });
  });

  it("rejects values it cannot interpret rather than guessing a location", () => {
    expect(decodeRegion("chartreuse-1")).toBeNull();
    expect(decodeRegion(null)).toBeNull();
    expect(decodeRegion(99)).toBeNull();
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
