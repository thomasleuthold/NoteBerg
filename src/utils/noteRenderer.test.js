/**
 * src/utils/noteRenderer.test.js
 * Focuses on the real computational logic: theme-dependent palette selection
 * and stroke bounding-box math (used for preview fit-to-bounds scaling).
 * Canvas painting functions (drawStroke, drawBackgroundPattern,
 * renderNoteSnapshot's DOM text-layout walk) are UI-wiring and are skipped,
 * except for renderNotePreview's scale/offset math which is exercised via a
 * spied 2D context, matching the CanvasRenderer.test.js convention.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getTheme = vi.fn();
vi.mock("../modules/theme.js", () => ({
  getTheme: (...args) => getTheme(...args),
}));

import {
  drawStroke,
  getMarkerPalette,
  getPressureWidth,
  getStrokeBounds,
  getThemePalette,
  renderNotePreview,
} from "./noteRenderer.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getThemePalette", () => {
  it("returns the dark palette (white first) when theme is dark", () => {
    getTheme.mockReturnValue("dark");
    const palette = getThemePalette();
    expect(palette[0]).toBe("#ffffff");
    expect(palette).toHaveLength(15);
  });

  it("returns the light palette (black first) for any non-dark theme", () => {
    getTheme.mockReturnValue("light");
    const palette = getThemePalette();
    expect(palette[0]).toBe("#000000");
    expect(palette).toHaveLength(15);
  });
});

describe("getPressureWidth", () => {
  it("increases monotonically with pressure", () => {
    const widths = [0, 0.25, 0.5, 0.75, 1].map((p) => getPressureWidth(p, 4));
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    }
  });

  it("gives handwriting a visible thick/thin range across realistic pressures", () => {
    // Styli seldom report the extremes; the range that matters is the one an
    // actual hand produces. Too narrow a spread here is what makes strokes look
    // uniform regardless of how hard the user presses.
    const light = getPressureWidth(0.25, 4);
    const heavy = getPressureWidth(0.75, 4);
    expect(heavy / light).toBeGreaterThan(1.5);
  });

  it("scales with the pen's base width", () => {
    expect(getPressureWidth(0.5, 8)).toBeCloseTo(getPressureWidth(0.5, 4) * 2, 5);
  });

  it("never returns a width that would vanish or invert", () => {
    expect(getPressureWidth(0, 1)).toBeGreaterThan(0);
    expect(getPressureWidth(-5, 4)).toBeGreaterThan(0);
    expect(getPressureWidth(99, 4)).toBe(getPressureWidth(1, 4));
    expect(getPressureWidth(undefined, 4)).toBeGreaterThan(0);
  });
});

describe("pressure stroke rendering", () => {
  function ctxSpy() {
    return {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: vi.fn(),
      set lineWidth(v) {
        this._widths.push(v);
      },
      _widths: [],
      lineCap: "",
      lineJoin: "",
      strokeStyle: "",
      globalAlpha: 1,
    };
  }

  // A short, fast stroke - the dash over an "i". Pressure drifts slowly, then
  // rises. Batching by a similarity threshold collapsed the slow drift into one
  // width and released it as a single large jump, so a stroke with few samples
  // showed one conspicuous step. Width must instead track every sample.
  function shortStroke() {
    const pressure = [0.3, 0.315, 0.33, 0.345, 0.36, 0.5, 0.62, 0.63];
    return {
      x: pressure.map((_, i) => i * 10),
      y: pressure.map(() => 0),
      pressure,
      width: 4,
      colorIndex: 0,
    };
  }

  it("batches segments rather than emitting one path per sample", () => {
    getTheme.mockReturnValue("light");
    const ctx = ctxSpy();
    const stroke = shortStroke();

    // Draw calls are the budget here: a full-quality repaint covers three
    // viewports of strokes and runs on every scroll pause, so pressure
    // rendering must stay O(pressure changes), not O(points).
    drawStroke(ctx, stroke, null, false, false);

    expect(ctx.stroke.mock.calls.length).toBeLessThan(stroke.pressure.length);
  });

  it("keeps width monotonic with pressure across the whole stroke", () => {
    getTheme.mockReturnValue("light");
    const ctx = ctxSpy();
    const stroke = shortStroke();

    drawStroke(ctx, stroke, null, false, false);

    // Pressure in this profile never decreases, so no batch may be narrower
    // than the one before it.
    const widths = ctx._widths;
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
  });

  it("actually applies the pressure range to a stroke", () => {
    getTheme.mockReturnValue("light");
    const ctx = ctxSpy();

    drawStroke(ctx, shortStroke(), null, false, false);

    const widths = ctx._widths;
    expect(Math.max(...widths) / Math.min(...widths)).toBeGreaterThan(1.4);
  });

  it("ignores pressure in fastMode so scrolling stays cheap", () => {
    getTheme.mockReturnValue("light");
    const ctx = ctxSpy();

    drawStroke(ctx, shortStroke(), null, false, true);

    // One uniform width, and a single batched path rather than one per sample.
    expect(new Set(ctx._widths).size).toBe(1);
    expect(ctx.stroke).toHaveBeenCalledTimes(1);
  });
});

describe("getMarkerPalette", () => {
  it("returns a dark-appropriate marker palette when theme is dark", () => {
    getTheme.mockReturnValue("dark");
    const palette = getMarkerPalette();
    expect(palette).toHaveLength(10);
    expect(palette[0]).toBe("#f8f0b0");
  });

  it("returns the light marker palette otherwise", () => {
    getTheme.mockReturnValue("light");
    const palette = getMarkerPalette();
    expect(palette[0]).toBe("#faeb79");
  });
});

describe("getStrokeBounds", () => {
  it("returns null for an empty or missing stroke list", () => {
    expect(getStrokeBounds([])).toBeNull();
    expect(getStrokeBounds(null)).toBeNull();
  });

  it("returns null when strokes have no points", () => {
    expect(getStrokeBounds([{ x: [], y: [] }])).toBeNull();
  });

  it("computes bounds for a single point, padded by half the stroke width", () => {
    const bounds = getStrokeBounds([{ x: [10], y: [20], width: 4 }]);
    expect(bounds).toEqual({ minX: 8, maxX: 12, minY: 18, maxY: 22, width: 4, height: 4 });
  });

  it("defaults to width 2 when stroke.width is not provided", () => {
    const bounds = getStrokeBounds([{ x: [10], y: [10] }]);
    // default width 2 -> half-width padding of 1
    expect(bounds).toEqual({ minX: 9, maxX: 11, minY: 9, maxY: 11, width: 2, height: 2 });
  });

  it("spans the min/max across multiple points in one stroke", () => {
    // width: 0 is falsy, so the `stroke.width || 2` fallback still applies (padding = 1).
    const bounds = getStrokeBounds([{ x: [0, 100], y: [0, 50], width: 0 }]);
    expect(bounds).toEqual({ minX: -1, maxX: 101, minY: -1, maxY: 51, width: 102, height: 52 });
  });

  it("spans across multiple strokes, with padding applied once to the combined bounds", () => {
    // Padding (half the widest stroke's width) is applied once to the final
    // combined min/max, not per-stroke — applying it inside the per-stroke
    // loop (a previous version of this function did) compounds across
    // strokes: with N strokes the bounds end up padded ~N times over,
    // producing bounding boxes many times larger than the real ink extent
    // for notes with many strokes (confirmed empirically: 100 strokes
    // produced bounds over 2x too wide) — visible as large blank margins
    // around rendered stroke images (get_note's strokes_images format, and
    // the Markers tab's mini stroke previews).
    const bounds = getStrokeBounds([
      { x: [0], y: [0], width: 4 },
      { x: [200], y: [100], width: 4 },
    ]);
    expect(bounds).toEqual({ minX: -2, maxX: 202, minY: -2, maxY: 102, width: 204, height: 104 });
  });

  it("does not compound padding across many strokes", () => {
    // Regression test for the compounding bug above, at a scale (100
    // strokes) that would have made it obviously wrong: real ink spans
    // x:[50,200], padding should be applied exactly once (half-width 1, for
    // the default width-2 fallback), not once per stroke.
    const strokes = Array.from({ length: 100 }, (_, i) => ({
      x: [50, 60, 70, 200],
      y: [i * 30, i * 30 + 5, i * 30 + 10, i * 30 + 2],
      width: 2,
    }));
    const bounds = getStrokeBounds(strokes);
    expect(bounds.minX).toBe(49);
    expect(bounds.maxX).toBe(201);
    expect(bounds.width).toBe(152);
  });

  it("pads by the widest stroke's half-width when strokes have different widths", () => {
    const bounds = getStrokeBounds([
      { x: [0, 100], y: [0, 0], width: 2 },
      { x: [0, 100], y: [50, 50], width: 20 },
    ]);
    expect(bounds).toEqual({ minX: -10, maxX: 110, minY: -10, maxY: 60, width: 120, height: 70 });
  });

  it("ignores strokes with an empty x array when others have points", () => {
    const bounds = getStrokeBounds([
      { x: [], y: [] },
      { x: [5], y: [5], width: 4 },
    ]);
    expect(bounds).toEqual({ minX: 3, maxX: 7, minY: 3, maxY: 7, width: 4, height: 4 });
  });
});

function makeCanvasStub(width, height) {
  const ctx = {
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: null,
    // drawStroke's real implementation runs (not mocked) since we're testing
    // renderNotePreview's own scale/offset math, so the stub needs the full
    // path-drawing surface it calls into.
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    lineWidth: 0,
    lineCap: null,
    lineJoin: null,
    strokeStyle: null,
    globalAlpha: 1,
  };
  return {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width, height }),
    getContext: () => ctx,
    __ctx: ctx,
  };
}

describe("renderNotePreview", () => {
  beforeEach(() => {
    getTheme.mockReturnValue("light");
    window.devicePixelRatio = 1;
  });

  it("sizes the canvas to the element rect times devicePixelRatio", () => {
    const canvas = makeCanvasStub(200, 150);
    renderNotePreview(canvas, { strokes: [], background: "none" });
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(150);
  });

  it("scales the canvas backing store by devicePixelRatio", () => {
    window.devicePixelRatio = 2;
    const canvas = makeCanvasStub(200, 150);
    renderNotePreview(canvas, { strokes: [], background: "none" });
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(300);
    expect(canvas.__ctx.scale).toHaveBeenCalledWith(2, 2);
  });

  it("fills a solid background matching the theme (dark)", () => {
    getTheme.mockReturnValue("dark");
    const canvas = makeCanvasStub(200, 150);
    renderNotePreview(canvas, { strokes: [], background: "none" });
    expect(canvas.__ctx.fillStyle).toBe("#1e1e2e");
    expect(canvas.__ctx.fillRect).toHaveBeenCalledWith(0, 0, 200, 150);
  });

  it("fills a solid background matching the theme (light)", () => {
    const canvas = makeCanvasStub(200, 150);
    renderNotePreview(canvas, { strokes: [], background: "none" });
    expect(canvas.__ctx.fillStyle).toBe("#ffffff");
  });

  it("does not scale/translate for stroke rendering when there are no strokes", () => {
    const canvas = makeCanvasStub(200, 150);
    renderNotePreview(canvas, { strokes: [], background: "none" });
    expect(canvas.__ctx.save).not.toHaveBeenCalled();
  });

  it("centers and scales strokes to fit within the padded canvas area", () => {
    const canvas = makeCanvasStub(220, 220); // 200x200 available after 10px padding each side
    // width=0.02 keeps getStrokeBounds' padding negligible so bounds are ~0..100
    // (100x100) without landing exactly on it due to floating point.
    const strokes = [{ x: [0, 100], y: [0, 100], width: 0.02 }];
    renderNotePreview(canvas, { strokes, background: "none" }, { padding: 10 });

    // availableWidth = 200, bounds.width ~= 100 -> scale ~= 2
    const [scaleX, scaleY] = canvas.__ctx.scale.mock.calls[1]; // call 0 is the DPR scale
    expect(scaleX).toBeCloseTo(2, 2);
    expect(scaleY).toBeCloseTo(2, 2);

    const [offsetX, offsetY] = canvas.__ctx.translate.mock.calls[0];
    expect(offsetX).toBeCloseTo(10, 1);
    expect(offsetY).toBeCloseTo(10, 1);

    expect(canvas.__ctx.save).toHaveBeenCalled();
    expect(canvas.__ctx.restore).toHaveBeenCalled();
  });

  it("does not fail when strokes are present but background is a pattern", () => {
    const canvas = makeCanvasStub(220, 220);
    const strokes = [{ x: [0, 50], y: [0, 50], width: 0 }];
    expect(() =>
      renderNotePreview(canvas, { strokes, background: "grid-small" }, { padding: 10 }),
    ).not.toThrow();
  });
});
