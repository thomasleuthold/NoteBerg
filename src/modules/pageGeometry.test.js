/**
 * Covers virtual page geometry.
 *
 * Recognition splits a note into page-aligned images using these bounds, so a
 * page that fails to cover the ink is not a layout nit: the strokes inside it
 * are dropped from the rendered image and the note comes back blank.
 */

import { describe, expect, it } from "vitest";
import { pageHeight, pagesInRange } from "./pageGeometry.js";

/** The width NoteCanvas lays content out at. */
const WIDTH = 1200;
const H = pageHeight(WIDTH);

describe("pageHeight", () => {
  it("keeps A4's aspect ratio, so pages match the exported PDF", () => {
    expect(pageHeight(WIDTH) / WIDTH).toBeCloseTo(841.89 / 595.28, 5);
  });

  it("scales with content width", () => {
    expect(pageHeight(600)).toBeCloseTo(pageHeight(1200) / 2, 5);
  });
});

describe("pagesInRange", () => {
  it("returns the single page a short note sits on", () => {
    expect(pagesInRange(0, 100, WIDTH)).toEqual([{ index: 0, top: 0, bottom: H }]);
  });

  it("returns every page a note spans", () => {
    const pages = pagesInRange(0, H * 2 + 10, WIDTH);
    expect(pages.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it("does not add a page for ink ending exactly on a boundary", () => {
    // Without the epsilon, a note ending flush with a page break would render an
    // extra blank image and spend a request transcribing nothing.
    expect(pagesInRange(0, H, WIDTH).map((p) => p.index)).toEqual([0]);
  });

  it("covers ink above the origin instead of clamping it away", () => {
    // Regression: content can end up at a negative Y — undoing an "insert space"
    // shift moves strokes up with no clamp. Clamping the first page at zero
    // excluded that ink from every image, so recognition rendered a blank page
    // and the model correctly reported no handwriting.
    const pages = pagesInRange(-200, -150, WIDTH);
    expect(pages).toHaveLength(1);
    expect(pages[0].top).toBeLessThan(-150);
    expect(pages[0].bottom).toBeGreaterThan(-150);
  });

  it("covers a note straddling the origin with pages on both sides", () => {
    const pages = pagesInRange(-200, 100, WIDTH);
    expect(pages.map((p) => p.index)).toEqual([-1, 0]);
    expect(pages[0].top).toBeLessThanOrEqual(-200);
    expect(pages.at(-1).bottom).toBeGreaterThanOrEqual(100);
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(pagesInRange(100, 100, WIDTH)).toEqual([]);
    expect(pagesInRange(100, 50, WIDTH)).toEqual([]);
  });

  it("returns nothing when the content width is unusable", () => {
    expect(pagesInRange(0, 100, 0)).toEqual([]);
  });

  it("produces contiguous pages with no gap between them", () => {
    const pages = pagesInRange(0, H * 3, WIDTH);
    for (let i = 1; i < pages.length; i++) {
      expect(pages[i].top).toBeCloseTo(pages[i - 1].bottom, 6);
    }
  });
});
