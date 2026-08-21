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

describe("region word positions", () => {
  // Guards the bug where region words were silently dropped from search
  // results: the box lookup fell through to the word object, found no `y`, and
  // skipped the match — undercounting every region-mode hit.
  const image = { contentY: 0, contentHeight: 600 };

  it("gives each band a distinct position, so hits are counted separately", () => {
    const positions = ["blue-0", "green-0", "yellow-0", "purple-0"].map((r) => {
      const decoded = decodeRegion(r);
      const bounds = regionBounds(decoded.regionIndex, image);
      return (bounds.top + bounds.bottom) / 2;
    });

    expect(new Set(positions).size).toBe(4);
  });

  it("orders positions down the page, matching reading order", () => {
    const ys = ["blue-0", "green-0", "yellow-0", "purple-0"].map((r) => {
      const decoded = decodeRegion(r);
      const bounds = regionBounds(decoded.regionIndex, image);
      return bounds.top;
    });

    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it("separates the same colour on different images", () => {
    // Two images of a long note both contain a "blue" band; their positions
    // must not collide, or hits on the second would count as hits on the first.
    const first = regionBounds(0, { contentY: 0, contentHeight: 600 });
    const second = regionBounds(0, { contentY: 600, contentHeight: 600 });

    expect(second.top).toBeGreaterThan(first.bottom - 1);
  });
});

describe("highlight collection", () => {
  // Mirrors what NoteCanvas._highlightSearchTerms does, so the collapsing and
  // decoding logic is covered without standing up a canvas.
  function collectRegionHighlights(words, query) {
    const regex = new RegExp(query, "gi");
    const matched = new Map();

    for (const word of words) {
      regex.lastIndex = 0;
      if (!word.text || !regex.test(word.text)) continue;
      if (word.region == null) continue;
      matched.set(word.region, { region: word.region, imageBounds: word.imageBounds });
    }

    const rects = [];
    for (const entry of matched.values()) {
      const decoded = decodeRegion(entry.region);
      if (!decoded || !entry.imageBounds) continue;
      const bounds = regionBounds(decoded.regionIndex, entry.imageBounds);
      if (bounds) rects.push({ y: bounds.top, h: bounds.bottom - bounds.top });
    }
    return rects;
  }

  const image = { contentY: 0, contentHeight: 600 };
  const word = (text, region) => ({ text, region, imageBounds: image });

  it("highlights every band containing a match", () => {
    // The four stroke* hits on one page sat in four different bands; all four
    // bands must light up.
    const words = [
      word("strokes.", "blue-0"),
      word("strokes", "green-0"),
      word("strokes.", "yellow-0"),
      word("strokes", "purple-0"),
    ];

    expect(collectRegionHighlights(words, "stroke")).toHaveLength(4);
  });

  it("highlights a band once however many words in it match", () => {
    const words = [word("stroke", "blue-0"), word("strokes", "blue-0")];
    expect(collectRegionHighlights(words, "stroke")).toHaveLength(1);
  });

  it("highlights the same colour on two images as two separate bands", () => {
    const words = [
      { text: "stroke", region: "blue-0", imageBounds: { contentY: 0, contentHeight: 600 } },
      { text: "stroke", region: "blue-1", imageBounds: { contentY: 600, contentHeight: 600 } },
    ];

    const rects = collectRegionHighlights(words, "stroke");
    expect(rects).toHaveLength(2);
    expect(rects[0].y).not.toBe(rects[1].y);
  });

  it("ignores non-matching words", () => {
    const words = [word("banana", "blue-0"), word("stroke", "green-0")];
    expect(collectRegionHighlights(words, "stroke")).toHaveLength(1);
  });

  it("skips a region with no image bounds rather than placing it at the origin", () => {
    const words = [{ text: "stroke", region: "blue-0" }];
    expect(collectRegionHighlights(words, "stroke")).toHaveLength(0);
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

describe("occurrence counting", () => {
  // The navigator counts occurrences, so it must reflect what is on the page:
  // several matching words in one band are several hits, while the same word
  // seen twice because two images overlap is one.
  function countOccurrences(words, query, image) {
    const regex = new RegExp(query, "gi");
    const accepted = [];

    for (const word of words) {
      regex.lastIndex = 0;
      if (!word.text || !regex.test(word.text)) continue;

      const decoded = decodeRegion(word.region);
      const bounds = decoded && regionBounds(decoded.regionIndex, word.imageBounds ?? image);
      if (!bounds) continue;

      const centre = (bounds.top + bounds.bottom) / 2;
      const tolerance = (bounds.bottom - bounds.top) * 0.67;
      if (accepted.some((h) => h.text === word.text && Math.abs(h.y - centre) <= tolerance)) {
        continue;
      }
      accepted.push({ text: word.text, y: centre });
    }

    return accepted.length;
  }

  const image = { contentY: 0, contentHeight: 1600 };
  const word = (text, region, bounds = image) => ({ text, region, imageBounds: bounds });

  it("counts matches in different bands separately", () => {
    // Four stroke* hits across four bands are four occurrences, not one.
    const words = [
      word("strokes.", "blue-0"),
      word("strokes", "green-0"),
      word("strokes.", "yellow-0"),
      word("strokes", "purple-0"),
    ];

    expect(countOccurrences(words, "stroke", image)).toBe(4);
  });

  it("collapses the same word seen on two overlapping images", () => {
    // Images overlap so no line is cut in half, so a word in the overlap is
    // transcribed twice — one occurrence, not two.
    const words = [
      word("strokes", "purple-0", { contentY: 0, contentHeight: 1600 }),
      word("strokes", "blue-1", { contentY: 1480, contentHeight: 1600 }),
    ];

    expect(countOccurrences(words, "stroke", image)).toBe(1);
  });

  it("keeps two genuine occurrences of a word in adjacent bands", () => {
    // A full band apart is a real repeat, not an overlap artefact.
    const words = [word("strokes", "blue-0"), word("strokes", "green-0")];
    expect(countOccurrences(words, "stroke", image)).toBe(2);
  });

  it("counts words with different text in the same band separately", () => {
    const words = [word("strokes", "blue-0"), word("stroke", "blue-0")];
    expect(countOccurrences(words, "stroke", image)).toBe(2);
  });
});

describe("approximate marker geometry", () => {
  // The marker is drawn at the buffer's left edge in content space. The buffer
  // is a window of content wider than the viewport, so this keeps the bar inside
  // the painted region without a repaint on every horizontal scroll — a plain
  // repaint would leave the painted window behind and expose unpainted canvas.
  function markerBar(rect, view) {
    return {
      x: view.bufferLeft,
      y: rect.y,
      // Drawn in content space, so the width divides by zoom to keep a constant
      // on-screen thickness.
      w: 6 / view.zoom,
      h: rect.h,
    };
  }

  const band = { y: 100, h: 267 };

  it("spans the full height of the band, so the marked range is legible", () => {
    const bar = markerBar(band, { bufferLeft: 0, zoom: 1 });
    expect(bar.y).toBe(band.y);
    expect(bar.h).toBe(band.h);
  });

  it("sits at the buffer's left edge", () => {
    expect(markerBar(band, { bufferLeft: 300, zoom: 1 }).x).toBe(300);
  });

  it("keeps a constant on-screen thickness when zoomed", () => {
    const at1 = markerBar(band, { bufferLeft: 0, zoom: 1 });
    const at2 = markerBar(band, { bufferLeft: 0, zoom: 2 });
    expect(at2.w * 2).toBeCloseTo(at1.w);
  });
});
