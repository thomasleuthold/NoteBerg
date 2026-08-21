/**
 * Covers the metrics used to compare backends on box accuracy.
 *
 * These exist because box quality is nearly impossible to judge by eye: a
 * highlight one line off looks like a near-miss but is a complete failure.
 */

import { describe, expect, it } from "vitest";
import { gridLikeness, scoreBoxes } from "./boxQuality.js";

/** A stroke occupying a small rectangle around (x, y). */
function strokeAt(x, y, w = 40, h = 20) {
  return { id: `${x}-${y}`, x: [x, x + w], y: [y, y + h] };
}

const rect = (x, y, width = 40, height = 20) => ({ boundingRect: { x, y, width, height } });

describe("scoreBoxes", () => {
  it("reports no empty boxes when every box sits on ink", () => {
    const strokes = [strokeAt(10, 10), strokeAt(100, 10)];
    const words = [rect(10, 10), rect(100, 10)];

    const q = scoreBoxes(words, strokes);
    expect(q.boxCount).toBe(2);
    expect(q.emptyBoxRatio).toBe(0);
  });

  it("flags boxes that land on blank paper", () => {
    // The visible failure mode: a highlight drawn where nothing is written.
    const strokes = [strokeAt(10, 10)];
    const words = [rect(10, 10), rect(500, 500)];

    expect(scoreBoxes(words, strokes).emptyBoxRatio).toBe(0.5);
  });

  it("measures a consistent vertical offset as drift", () => {
    // A systematic offset is correctable; this is the number that reveals it.
    const strokes = [strokeAt(10, 100), strokeAt(10, 200), strokeAt(10, 300)];
    const words = [rect(10, 130), rect(10, 230), rect(10, 330)];

    const q = scoreBoxes(words, strokes);
    expect(q.medianDriftY).toBeCloseTo(30, 0);
  });

  it("reports near-zero drift when boxes align with ink", () => {
    const strokes = [strokeAt(10, 100), strokeAt(10, 200)];
    const words = [rect(10, 100), rect(10, 200)];

    const q = scoreBoxes(words, strokes);
    expect(Math.abs(q.medianDriftY)).toBeLessThan(1);
  });

  it("ignores words without geometry rather than counting them as failures", () => {
    const strokes = [strokeAt(10, 10)];
    const words = [rect(10, 10), { text: "orphan", boundingRect: null }];

    expect(scoreBoxes(words, strokes).boxCount).toBe(1);
  });

  it("returns a fully-failed score when there is nothing to compare", () => {
    expect(scoreBoxes([], [strokeAt(0, 0)]).emptyBoxRatio).toBe(1);
    expect(scoreBoxes([rect(0, 0)], []).emptyBoxRatio).toBe(1);
  });
});

describe("gridLikeness", () => {
  it("returns 1 for a perfectly uniform row pitch", () => {
    // The signature of an invented layout: real notes do not have perfectly
    // even line spacing, so a value near 1 means the model is not measuring.
    const words = [0, 60, 120, 180, 240].map((y) => rect(10, y));
    expect(gridLikeness(words)).toBe(1);
  });

  it("returns a low value for irregular spacing, as real handwriting produces", () => {
    const words = [0, 55, 130, 190, 400].map((y) => rect(10, y));
    expect(gridLikeness(words)).toBeLessThan(0.5);
  });

  it("is undefined for too few rows to judge", () => {
    expect(Number.isNaN(gridLikeness([rect(10, 0), rect(10, 60)]))).toBe(true);
  });
});
