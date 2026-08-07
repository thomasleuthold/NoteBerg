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

  // ── Partial-eraser churn ────────────────────────────────────────────────────
  // The partial eraser soft-deletes a stroke (leaving it in noteData.strokes)
  // and APPENDS its surviving fragments at ever-higher indices. Erasing the same
  // region repeatedly therefore grows the index without ever shrinking it —
  // which is what makes a long session with erasing progressively slower while
  // pure writing stays fast.

  it("drops emptied buckets so repeated erasing does not leave them behind", () => {
    // One stroke in bucket 0, removed again — the bucket must not linger.
    spatialIndex.insert({ width: 2, x: [10], y: [50] }, 0);
    expect(spatialIndex.buckets.has(0)).toBe(true);

    spatialIndex.remove(0);

    expect(spatialIndex.query(0, 100)).not.toContain(0);
    expect(spatialIndex.buckets.has(0)).toBe(false);
  });

  it("does not grow bucket or bounds state across repeated erase/re-insert cycles", () => {
    // Simulate the eraser loop: remove a stroke, append its replacement at the
    // next free index, 200 times. Live content stays at exactly one stroke.
    spatialIndex.insert({ width: 2, x: [10], y: [50] }, 0);

    let liveIndex = 0;
    for (let i = 1; i <= 200; i++) {
      spatialIndex.remove(liveIndex);
      liveIndex = i;
      spatialIndex.insert({ width: 2, x: [10], y: [50] }, liveIndex);
    }

    // Only the one live stroke should be tracked — not 201 accumulated entries.
    expect(spatialIndex.strokeBounds.size).toBe(1);

    // And the bucket it lives in must hold exactly that one index, so query()
    // does not walk hundreds of stale entries on every frame.
    const bucket = spatialIndex.buckets.get(0);
    expect(bucket.size).toBe(1);
    expect(bucket.has(liveIndex)).toBe(true);

    const visible = spatialIndex.query(0, 100);
    expect(visible).toEqual([liveIndex]);
  });

  it("returns indices in draw order after an erased stroke is re-inserted", () => {
    // Draw order is array order, so query() must return ascending indices.
    // Undo-of-erase re-inserts an OLD index, which lands at the end of the
    // bucket's Set — inside a single bucket (the common case, since buckets are
    // ~a viewport tall) an unsorted result would render the restored stroke on
    // top of strokes drawn after it.
    const inBucketZero = (i) => ({ width: 2, x: [10], y: [10 + i] });
    for (let i = 0; i < 4; i++) spatialIndex.insert(inBucketZero(i), i);

    // Erase stroke 1, then undo that erase.
    spatialIndex.remove(1);
    spatialIndex.insert(inBucketZero(1), 1);

    const result = spatialIndex.query(0, 99); // single bucket
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it("keeps query() allocation bounded as indices climb", () => {
    // totalStrokes drives the _seenBuffer allocation in query(). If it only ever
    // grows, a long erasing session keeps reallocating a larger Uint8Array.
    spatialIndex.insert({ width: 2, x: [10], y: [50] }, 0);
    for (let i = 1; i <= 500; i++) {
      spatialIndex.remove(i - 1);
      spatialIndex.insert({ width: 2, x: [10], y: [50] }, i);
    }

    spatialIndex.query(0, 100);

    // One live stroke at index 500 needs a buffer that can address it, but the
    // index must not be tracking 501 strokes' worth of state.
    expect(spatialIndex.strokeBounds.size).toBe(1);
  });
});
