import { beforeEach, describe, expect, it } from "vitest";
import { SpatialIndex } from "./SpatialIndex.js";

describe("SpatialIndex", () => {
  let spatialIndex;
  const bucketHeight = 100;

  beforeEach(() => {
    spatialIndex = new SpatialIndex(bucketHeight);
  });

  it("should insert strokes into correct buckets", () => {
    // Stroke 1: y=50 to y=150 (Spans Bucket 0 and 1)
    const stroke1 = { width: 2, x: [10, 20], y: [50, 150] };
    spatialIndex.insert(stroke1, 0);

    // Stroke 2: y=250 to y=300 (Spans Bucket 2 and 3)
    const stroke2 = { width: 2, x: [10, 20], y: [250, 300] };
    spatialIndex.insert(stroke2, 1);

    // Verify internal state (implementation detail check for robustness)
    expect(spatialIndex.buckets.get(0).has(0)).toBe(true);
    expect(spatialIndex.buckets.get(1).has(0)).toBe(true);
    expect(spatialIndex.buckets.get(2).has(1)).toBe(true);
  });

  it("should query strokes visible in viewport", () => {
    const stroke1 = { width: 2, x: [10], y: [50, 150] }; // Index 0
    const stroke2 = { width: 2, x: [10], y: [250, 300] }; // Index 1

    spatialIndex.insert(stroke1, 0);
    spatialIndex.insert(stroke2, 1);

    // Query 0-100 (Should see stroke 1)
    const result1 = spatialIndex.query(0, 100);
    expect(result1).toContain(0);
    expect(result1).not.toContain(1);

    // Query 200-300 (Should see stroke 2)
    const result2 = spatialIndex.query(200, 300);
    expect(result2).toContain(1);
    expect(result2).not.toContain(0);
  });

  it("should remove strokes correctly", () => {
    const stroke = { width: 2, x: [10], y: [50] };
    spatialIndex.insert(stroke, 0);

    expect(spatialIndex.query(0, 100)).toContain(0);

    spatialIndex.remove(0);
    expect(spatialIndex.query(0, 100)).not.toContain(0);
  });

  it("should handle bulk build", () => {
    const strokes = [
      { width: 2, x: [10], y: [50] },
      { width: 2, x: [10], y: [150] },
    ];

    spatialIndex.build(strokes);

    expect(spatialIndex.totalStrokes).toBe(2);
    expect(spatialIndex.query(0, 100)).toContain(0);
    expect(spatialIndex.query(100, 200)).toContain(1);
  });
});
