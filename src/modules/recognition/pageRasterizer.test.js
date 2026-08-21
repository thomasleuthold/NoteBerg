/**
 * Covers band planning and bounds — the pure geometry that decides how a note
 * is split for recognition. Banding exists for legibility, not context economy
 * (DESIGN §3.2), so the assertions are about overlap and coverage rather than
 * request count.
 */

import { describe, expect, it } from "vitest";
import { computeScale, planBands, smallestTextHeight, strokeBounds } from "./pageRasterizer.js";

function stroke(points) {
  return {
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
  };
}

describe("strokeBounds", () => {
  it("spans every point of every stroke", () => {
    const bounds = strokeBounds([
      stroke([
        [10, 20],
        [30, 40],
      ]),
      stroke([
        [5, 50],
        [60, 15],
      ]),
    ]);
    expect(bounds).toEqual({ minX: 5, minY: 15, maxX: 60, maxY: 50 });
  });

  it("returns null when there is nothing to render", () => {
    expect(strokeBounds([])).toBeNull();
    expect(strokeBounds([{ x: [], y: [] }])).toBeNull();
  });

  it("ignores malformed strokes rather than throwing", () => {
    const bounds = strokeBounds([null, { x: null }, stroke([[1, 2]])]);
    expect(bounds).toEqual({ minX: 1, minY: 2, maxX: 1, maxY: 2 });
  });
});

describe("planBands", () => {
  // Images align to the note's A4 page breaks — the same dashed lines drawn on
  // the canvas — so a user who avoids writing across a visible break can rely on
  // no word being split between two images.
  const CONTENT_WIDTH = 1200;
  const PAGE_H = 841.89 / (595.28 / 1200); // ≈ 1696.7

  it("emits one image per virtual page", () => {
    const bands = planBands({ minY: 0, maxY: PAGE_H * 2.5 }, CONTENT_WIDTH);
    expect(bands).toHaveLength(3);
  });

  it("aligns image boundaries to the page breaks the user sees", () => {
    const bands = planBands({ minY: 0, maxY: PAGE_H * 2 }, CONTENT_WIDTH);
    expect(bands[0].contentY).toBeCloseTo(0);
    expect(bands[1].contentY).toBeCloseTo(PAGE_H);
  });

  it("gives every image the same height, one page", () => {
    const bands = planBands({ minY: 0, maxY: PAGE_H * 3 }, CONTENT_WIDTH);
    for (const band of bands) {
      expect(band.contentHeight).toBeCloseTo(PAGE_H);
    }
  });

  it("leaves no gap or overlap between consecutive images", () => {
    // Overlap existed only because slice boundaries fell in arbitrary places
    // and could cut a text line in half. Page alignment removes the reason for
    // it, and with it the duplicate transcriptions it produced.
    const bands = planBands({ minY: 0, maxY: PAGE_H * 3 }, CONTENT_WIDTH);
    for (let i = 1; i < bands.length; i++) {
      const prevBottom = bands[i - 1].contentY + bands[i - 1].contentHeight;
      expect(bands[i].contentY).toBeCloseTo(prevBottom);
    }
  });

  it("renders a short note as a single page-sized image", () => {
    const bands = planBands({ minY: 0, maxY: 200 }, CONTENT_WIDTH);
    expect(bands).toHaveLength(1);
    expect(bands[0].contentHeight).toBeCloseTo(PAGE_H);
  });

  it("numbers images from zero for this render", () => {
    const bands = planBands({ minY: 0, maxY: PAGE_H * 3 }, CONTENT_WIDTH);
    expect(bands.map((b) => b.index)).toEqual([0, 1, 2]);
  });
});

describe("computeScale", () => {
  const opts = { maxImageEdge: 1600 };

  it("scales small content up so fine handwriting is legible", () => {
    // A 1:1 cap previously left a narrow page at its original size, so small
    // text rendered under 10px and no vision model could read it.
    expect(Math.round(194 * computeScale(194, opts))).toBe(1600);
  });

  it("scales wide content down to the configured size", () => {
    expect(Math.round(3000 * computeScale(3000, opts))).toBe(1600);
  });

  it("makes a larger setting produce a larger image", () => {
    // The setting was previously inert for any page narrower than it.
    expect(computeScale(1200, { maxImageEdge: 3200 })).toBeGreaterThan(
      computeScale(1200, { maxImageEdge: 1600 }),
    );
  });

  it("returns 1 for degenerate widths rather than dividing by zero", () => {
    expect(computeScale(0, opts)).toBe(1);
    expect(computeScale(-5, opts)).toBe(1);
  });
});

describe("smallestTextHeight", () => {
  const stroke = (height) => ({ x: [0, 10], y: [0, height] });

  it("reports the height of small text in image pixels", () => {
    const strokes = [stroke(9), stroke(45), stroke(45), stroke(45)];
    // 10th percentile of four sorted heights is the first: the small one.
    expect(smallestTextHeight(strokes, 1)).toBe(9);
  });

  it("scales with the render scale, since that is what the model sees", () => {
    const strokes = [stroke(9), stroke(45), stroke(45), stroke(45)];
    expect(smallestTextHeight(strokes, 2)).toBe(18);
  });

  it("ignores dots and specks, which are tiny by nature not by scale", () => {
    // A full stop would otherwise dominate and always report an alarming figure.
    const strokes = [stroke(1), stroke(1), stroke(40), stroke(40)];
    expect(smallestTextHeight(strokes, 1)).toBe(40);
  });

  it("returns 0 when there is nothing to measure", () => {
    expect(smallestTextHeight([], 1)).toBe(0);
    expect(smallestTextHeight(null, 1)).toBe(0);
  });
});
