import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRenderCache, getRenderedMedia } from "../../modules/mediaManager.js";
import { getPdfInvertDarkMode, getTheme } from "../../modules/theme.js";
import { drawBackgroundPattern as mockDrawBackgroundPattern } from "../../utils/noteRenderer.js";
import { CanvasRenderer } from "./CanvasRenderer.js";

// Mock dependencies
vi.mock("../../utils/noteRenderer.js", () => ({
  drawBackgroundPattern: vi.fn(),
  drawStroke: vi.fn(),
  getThemePalette: vi.fn(() => ["#000000", "#ff0000"]),
  getMarkerPalette: vi.fn(() => ["#000000", "#ff0000"]),
  // Mirrors the real mapping's contract (monotonic, scales with baseWidth)
  // without pinning this test to the tuning constants.
  getPressureWidth: vi.fn((p, baseWidth) => Math.max(0.5, baseWidth * (0.35 + p))),
  MARKER_MAX_ALPHA: 0.6,
}));

vi.mock("./NoteCanvas.js", () => ({
  getMediaHandles: vi.fn(() => []),
  getSelectionHandles: vi.fn(() => [
    { key: "nw", x: 0, y: 0 },
    { key: "rotate", x: 50, y: -20 },
  ]),
  MEDIA_HANDLE_SIZE: 10,
  SELECTION_HANDLE_SIZE: 10,
}));

vi.mock("../../modules/mediaManager.js", () => ({
  getRenderedMedia: vi.fn(),
  clearRenderCache: vi.fn(),
}));

vi.mock("../../modules/theme.js", () => ({
  getTheme: vi.fn(() => "light"),
  getPdfInvertDarkMode: vi.fn(() => false),
}));

describe("CanvasRenderer", () => {
  let viewportElement;
  let renderer;
  let mockCtx;
  let contextOptions;

  beforeEach(() => {
    viewportElement = document.createElement("div");

    // Mock Canvas Context
    mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      rotate: vi.fn(),
      clearRect: vi.fn(),
      setTransform: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      strokeRect: vi.fn(),
      fillRect: vi.fn(),
      arc: vi.fn(),
      drawImage: vi.fn(),
      quadraticCurveTo: vi.fn(),
      setLineDash: vi.fn(),
    };

    // Mock HTMLCanvasElement.getContext
    // We need to spy on the prototype to affect the canvas created inside the class
    // Records the options each context was requested with, so tests can assert
    // the low-latency hint on the buffer (first 2d context created).
    contextOptions = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type, options) => {
      if (type === "2d") {
        contextOptions.push(options);
        return mockCtx;
      }
      return null;
    });

    renderer = new CanvasRenderer(viewportElement);
  });

  afterEach(() => {
    renderer.destroy();
    vi.restoreAllMocks();
  });

  it("initializes canvases", () => {
    expect(viewportElement.querySelectorAll("canvas")).toHaveLength(2);
    expect(renderer.canvas).toBeTruthy();
    expect(renderer.overlayCanvas).toBeTruthy();
  });

  it("resizes correctly", () => {
    renderer.resize(800, 600);
    expect(renderer.viewportWidth).toBe(1200); // Default maxContentWidth
    expect(renderer.viewportHeight).toBe(600);
    expect(renderer.canvas.width).toBeGreaterThan(0);
  });

  it("renders buffer and clears context", () => {
    renderer.resize(800, 600);
    renderer.render(0, 600);

    // Check if clearRect was called
    expect(mockCtx.clearRect).toHaveBeenCalled();
  });

  it("draws direct stroke incrementally", () => {
    const stroke = {
      id: "s1",
      x: [10, 20, 30],
      y: [10, 20, 30],
      pressure: [0.5, 0.5, 0.5],
      colorIndex: 0,
      width: 2,
    };

    // First draw
    renderer.drawDirectStroke(stroke);
    expect(mockCtx.beginPath).toHaveBeenCalled();
    expect(mockCtx.stroke).toHaveBeenCalled();

    // Verify it tracks state
    expect(renderer.activeStrokeId).toBe("s1");
  });

  // Writing feel: the gap between the stylus tip and the rendered preview ink.
  // Both of these trade nothing but latency, so a regression here is silent —
  // the app still draws correctly, just further behind the pen.
  describe("live stroke latency", () => {
    it("requests a low-latency context for the buffer canvas", () => {
      // The buffer is where in-progress ink lands. Without the hint the paint
      // waits a full compositor frame before it reaches the screen.
      expect(contextOptions[0]).toMatchObject({ desynchronized: true });
    });

    it("paints an opaque page background into the buffer bitmap", () => {
      // A desynchronized context can be promoted to its own compositing plane,
      // where the element's CSS background-color no longer shows through the
      // transparent parts of the bitmap — the canvas renders black in light
      // theme. The buffer must carry its own background, not rely on CSS.
      renderer.resize(800, 600);
      renderer.render(0, 600);

      expect(mockCtx.fillRect).toHaveBeenCalledWith(
        0,
        0,
        renderer.canvas.width,
        renderer.canvas.height,
      );
    });

    it("resolves the stroke colour once per stroke, not once per pointer move", () => {
      // Colour resolution walks every media item and can rebuild a palette
      // array. At stylus sample rate that ran on the lowest-latency path in the
      // app; the inputs cannot change mid-stroke, so it belongs outside the loop.
      const getItems = vi.fn(() => []);
      renderer.setMediaManager({ getItems });

      const stroke = {
        id: "s-colour",
        x: [0, 10, 20],
        y: [0, 0, 0],
        pressure: [0.5, 0.5, 0.5],
        colorIndex: 0,
        width: 2,
      };

      renderer.drawDirectStroke(stroke);
      const afterFirstMove = getItems.mock.calls.length;

      for (let i = 0; i < 5; i++) {
        stroke.x.push(30 + i * 10);
        stroke.y.push(0);
        stroke.pressure.push(0.5);
        renderer.drawDirectStroke(stroke);
      }

      expect(getItems.mock.calls.length).toBe(afterFirstMove);
    });

    it("re-resolves the colour for the next stroke", () => {
      // The cache is keyed to the active stroke id. If it leaked across
      // strokes, a pen colour change would not take effect until the buffer
      // happened to repaint.
      renderer.setMediaManager({ getItems: vi.fn(() => []) });

      const first = {
        id: "s-a",
        x: [0, 10, 20],
        y: [0, 0, 0],
        pressure: [0.5, 0.5, 0.5],
        colorIndex: 0,
        width: 2,
      };
      renderer.drawDirectStroke(first);
      const firstColor = mockCtx.strokeStyle;

      const second = { ...first, id: "s-b", colorIndex: 1 };
      renderer.drawDirectStroke(second);

      expect(mockCtx.strokeStyle).not.toBe(firstColor);
    });

    it("does not desynchronize the overlay canvas", () => {
      // The overlay clears and repaints a whole path per move (marker preview,
      // lasso trail), where an unsynchronized present would tear visibly.
      expect(contextOptions[1]?.desynchronized).toBeFalsy();
    });

    it("draws ink all the way to the newest point while still drawing", () => {
      // Midpoint smoothing ends the committed curve halfway between the last
      // two points. If the remainder is only drawn once the stroke finishes,
      // the ink permanently trails the stylus by half a sample.
      const stroke = {
        id: "s-tail",
        x: [0, 10, 20],
        y: [0, 0, 0],
        pressure: [0.5, 0.5, 0.5],
        colorIndex: 0,
        width: 2,
      };

      renderer.drawDirectStroke(stroke); // still drawing — isFinished omitted

      expect(mockCtx.lineTo).toHaveBeenCalledWith(20, 0);
    });

    it("re-draws the tail from the same geometry on the next move instead of extending it", () => {
      // The tail is provisional. The next move must lay the real curve over that
      // same region starting from the midpoint it already used; if the tail were
      // committed, the following segment would start from the tip instead and
      // the curve would kink at every sample.
      const stroke = {
        id: "s-tail2",
        x: [0, 10, 20],
        y: [0, 0, 0],
        pressure: [0.5, 0.5, 0.5],
        colorIndex: 0,
        width: 2,
      };

      renderer.drawDirectStroke(stroke);
      mockCtx.moveTo.mockClear();

      // Next sample arrives; the curve through P2 must be drawn from mid(P1,P2),
      // the same point the provisional tail started at.
      stroke.x.push(30);
      stroke.y.push(0);
      stroke.pressure.push(0.5);
      renderer.drawDirectStroke(stroke);

      expect(mockCtx.moveTo).toHaveBeenCalledWith(15, 0);
    });
  });

  // A buffer repaint clears the canvas. The in-progress stroke is painted
  // incrementally from lastDrawnPointIndex, so if that cursor survives a clear
  // unchanged, the points below it are wiped and never repainted — the live
  // stroke shows as jagged with missing segments until the finished stroke is
  // committed. Erasing makes repaints frequent, which is when it shows up.
  describe("in-progress stroke survives a buffer repaint", () => {
    function liveStroke(points) {
      return {
        id: "live",
        x: points.map((_, i) => i * 10),
        y: points.map((_, i) => i * 10),
        pressure: points.map(() => 0.5),
        colorIndex: 0,
        width: 2,
      };
    }

    it("rebases the incremental cursor when the repaint drew the active stroke", () => {
      renderer.resize(800, 600);
      const stroke = liveStroke(new Array(6));

      renderer.drawDirectStroke(stroke);
      expect(renderer.lastDrawnPointIndex).toBeGreaterThan(0);

      // A repaint mid-stroke: render() supplies the active stroke, so
      // _drawBuffer paints it in full.
      renderer.render(0, 600, 0, stroke);

      // Canvas now holds the whole stroke, so the cursor must point at its end —
      // not at a stale earlier offset.
      expect(renderer.lastDrawnPointIndex).toBe(stroke.x.length - 1);
    });

    it("resets the cursor when the repaint did NOT draw the active stroke", () => {
      renderer.resize(800, 600);
      const stroke = liveStroke(new Array(6));

      renderer.drawDirectStroke(stroke);
      const cursorBefore = renderer.lastDrawnPointIndex;
      expect(cursorBefore).toBeGreaterThan(0);

      // forceRedraw() (e.g. from an erase command) clears the buffer. With no
      // active stroke supplied, the live stroke is wiped off the canvas.
      renderer.activeStroke = null;
      renderer.forceRedraw("test");

      // The cursor must go back to 0 so the next incremental draw repaints the
      // stroke from its start; otherwise the wiped segments never come back.
      expect(renderer.lastDrawnPointIndex).toBe(0);
    });
  });

  it("draws selection bounds and handles", () => {
    renderer.resize(800, 600);
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    renderer.setSelectedStrokes(new Set([1]), bounds);

    // Trigger a render (which calls _drawBuffer)
    renderer.forceRedraw();

    expect(mockCtx.strokeRect).toHaveBeenCalledWith(0, 0, 100, 100);
    // Should draw handles (mocked to return 2 handles)
    // 1 rect for resize handle, 1 arc for rotate handle
    expect(mockCtx.fillRect).toHaveBeenCalled();
    expect(mockCtx.arc).toHaveBeenCalled();
  });

  it("handles zoom changes", () => {
    vi.useFakeTimers();
    renderer.setZoom(2.0);

    // Should debounce
    expect(renderer.zoomScale).toBe(2.0);

    vi.runAllTimers();
    // After timer, it should resize bitmap
    expect(mockCtx.setTransform).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("draws eraser cursor on overlay", () => {
    renderer.drawEraserCursor(100, 100, 10);
    // Overlay context is also mocked by the same spy since it's a canvas
    expect(mockCtx.arc).toHaveBeenCalledWith(100, 100, 10, 0, Math.PI * 2);
  });

  it("draws background pattern", () => {
    renderer.resize(800, 600);
    renderer.background = "grid-small";

    // Trigger render
    renderer.forceRedraw();

    expect(mockDrawBackgroundPattern).toHaveBeenCalled();
  });

  it("draws media items", () => {
    const mockImage = new Image();
    renderer.resize(800, 600); // Initialize buffer

    const mediaManager = {
      getItems: vi.fn(() => [
        {
          id: "m1",
          type: "image",
          fileId: "f1",
          x: 10,
          y: 10,
          width: 100,
          height: 100,
          rotation: 0,
        },
      ]),
      getImage: vi.fn(() => mockImage),
    };

    renderer.setMediaManager(mediaManager);
    renderer.forceRedraw();

    expect(mockCtx.drawImage).toHaveBeenCalledWith(mockImage, 10, 10, 100, 100);
  });

  it("draws rotated media items", () => {
    const mockImage = new Image();
    renderer.resize(800, 600); // Initialize buffer

    const mediaManager = {
      getItems: vi.fn(() => [
        {
          id: "m1",
          type: "image",
          fileId: "f1",
          x: 10,
          y: 10,
          width: 100,
          height: 100,
          rotation: 45,
        },
      ]),
      getImage: vi.fn(() => mockImage),
    };

    renderer.setMediaManager(mediaManager);
    renderer.forceRedraw();

    expect(mockCtx.rotate).toHaveBeenCalled();
    expect(mockCtx.drawImage).toHaveBeenCalled();
  });

  describe("_getCenteringOffset", () => {
    it("returns 0 when content fills or exceeds the screen viewport", () => {
      renderer.resize(1200, 600); // screenViewportWidth=1200, viewportWidth=1200 (maxContentWidth), zoom=1
      expect(renderer._getCenteringOffset()).toBe(0);
    });

    it("centers narrower content within a wider screen viewport", () => {
      renderer.resize(1200, 600);
      renderer.zoomScale = 0.5; // scaled content width = 1200 * 0.5 = 600
      // screenViewportWidth is fixed at resize-time (1200); centering offset = (1200-600)/2
      expect(renderer._getCenteringOffset()).toBe(300);
    });

    it("returns 0 when zoomed content exactly fills the screen viewport", () => {
      renderer.resize(1200, 600);
      renderer.zoomScale = 1.0;
      expect(renderer._getCenteringOffset()).toBe(0);
    });
  });

  describe("_isItemInKeepZone", () => {
    beforeEach(() => {
      renderer.resize(800, 600); // viewportHeight = 600, so margin = 300
      renderer.bufferTop = 1000;
      renderer.bufferHeight = 1800; // 3x viewport by default
      // keepTop = 1000 - 300 = 700; keepBottom = 1000 + 1800 + 300 = 3100
    });

    it("keeps an item that overlaps the buffer region", () => {
      const item = { y: 1500, height: 100 };
      expect(renderer._isItemInKeepZone(item)).toBe(true);
    });

    it("keeps an item within the margin above the buffer", () => {
      const item = { y: 750, height: 50 }; // bottom edge 800, still >= keepTop (700)
      expect(renderer._isItemInKeepZone(item)).toBe(true);
    });

    it("releases an item entirely above the keep zone", () => {
      const item = { y: 200, height: 50 }; // bottom edge 250, < keepTop (700)
      expect(renderer._isItemInKeepZone(item)).toBe(false);
    });

    it("releases an item entirely below the keep zone", () => {
      const item = { y: 3200, height: 50 }; // top edge 3200, > keepBottom (3100)
      expect(renderer._isItemInKeepZone(item)).toBe(false);
    });

    it("keeps an item exactly at the keep zone boundary", () => {
      const item = { y: 3100, height: 0 }; // y === keepBottom
      expect(renderer._isItemInKeepZone(item)).toBe(true);
    });
  });

  describe("in-flight PDF render invalidation", () => {
    // Regression cover for two field-reported failures on low-end Android:
    // pinch-zooming a long scanned PDF would freeze the page ("zoom sticks"),
    // and continuing to pinch closed the app (renderer OOM / use-after-free).
    // Both trace back to an async render resolving after the state it was
    // requested for is gone.
    let item;
    let mediaItems;

    /** A stand-in for a rendered page bitmap, distinguishable per render. */
    function makeRenderable(tag) {
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 100;
      canvas.dataset.tag = tag;
      return canvas;
    }

    beforeEach(() => {
      item = {
        id: "page-1",
        type: "pdf-page",
        fileId: "f1",
        pageIndex: 1,
        x: 0,
        y: 0,
        width: 600,
        height: 800,
      };
      mediaItems = [item];
      renderer.setMediaManager({ getItems: () => mediaItems });
      // Put the item inside the keep zone so storage is not rejected for
      // position reasons — the assertions below isolate scale/generation.
      renderer.viewportHeight = 600;
      renderer.bufferTop = 0;
      renderer.bufferHeight = 1800;
      renderer.selectedMediaId = null;
    });

    it("discards a render that resolves after the resolution scale changed", async () => {
      let resolveRender;
      getRenderedMedia.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRender = resolve;
        }),
      );

      renderer.resolutionScale = 1;
      renderer._drawPdfPage(item, false);
      expect(item.loading).toBe(true);

      // Zoom changes while the render is still in flight.
      renderer.resolutionScale = 2;
      renderer._renderGeneration++;

      resolveRender(makeRenderable("stale"));
      await vi.waitFor(() => expect(item.loading).toBe(false));

      // The stale bitmap must not be adopted: doing so left renderableScale
      // permanently mismatched against resolutionScale, so every subsequent
      // frame re-requested the page and the view never converged.
      expect(item.renderable).toBeFalsy();
      expect(renderer.activePdfLoads).toBe(0);
    });

    it("accepts a render that resolves while still current", async () => {
      const renderable = makeRenderable("fresh");
      getRenderedMedia.mockResolvedValueOnce(renderable);

      renderer.resolutionScale = 1.5;
      renderer._drawPdfPage(item, false);

      await vi.waitFor(() => expect(item.loading).toBe(false));

      expect(item.renderable).toBe(renderable);
      expect(item.renderableScale).toBe(1.5);
    });

    it("does not destroy a resolved bitmap it declines to store", async () => {
      const renderable = makeRenderable("declined");
      getRenderedMedia.mockResolvedValueOnce(renderable);

      renderer.resolutionScale = 1;
      renderer._drawPdfPage(item, false);
      renderer._renderGeneration++; // supersede before it lands

      await vi.waitFor(() => expect(item.loading).toBe(false));

      // The bitmap is owned by the mediaManager cache, which may still be
      // handing it to a concurrent caller (thumbnails share that cache).
      // Zeroing it here is what made drawImage throw InvalidStateError.
      expect(renderable.width).toBe(100);
      expect(renderable.height).toBe(100);
    });

    it("bumps the generation when the resolution scale changes", () => {
      renderer.zoomScale = 1;
      renderer._resizeCanvasBitmap();
      const before = renderer._renderGeneration;

      renderer.zoomScale = 2;
      renderer._resizeCanvasBitmap();

      expect(renderer._renderGeneration).toBeGreaterThan(before);
    });

    it("does not bump the generation when the resolution scale is unchanged", () => {
      renderer.zoomScale = 1;
      renderer._resizeCanvasBitmap();
      const before = renderer._renderGeneration;

      renderer._resizeCanvasBitmap();

      expect(renderer._renderGeneration).toBe(before);
    });

    it("releases item memory without zeroing the shared bitmap", () => {
      const renderable = makeRenderable("released");
      item.renderable = renderable;
      item.renderableScale = 1;

      renderer._releaseItemMemory(item);

      expect(item.renderable).toBeNull();
      expect(item.renderableScale).toBeNull();
      // Disposal is the cache's responsibility (clearRenderCache), not ours.
      expect(clearRenderCache).toHaveBeenCalledWith("page-1");
      expect(renderable.width).toBe(100);
    });

    it("invalidates in-flight renders on theme change even with no bitmap yet", () => {
      const before = renderer._renderGeneration;
      item.renderable = null; // still loading when the theme flips
      renderer.invalidatePdfRenderables();
      expect(renderer._renderGeneration).toBeGreaterThan(before);
    });
  });

  describe("zoom bitmap geometry", () => {
    // The canvas bitmap is stretched onto its CSS box by the browser. If the two
    // axes end up with different bitmap-to-CSS ratios, the image is squashed
    // along one of them — seen in the field as a brief directional distortion
    // while pinch-zooming a PDF.
    beforeEach(() => {
      renderer.resize(1000, 800); // viewportWidth := maxContentWidth (1200), bufferHeight := 2400
    });

    /** Ratio of bitmap pixels to CSS pixels on each axis. */
    function axisScales() {
      return {
        x: renderer.canvas.width / Number.parseFloat(renderer.canvas.style.width),
        y: renderer.canvas.height / Number.parseFloat(renderer.canvas.style.height),
      };
    }

    it("keeps the horizontal and vertical bitmap scales equal across zoom levels", () => {
      // 1.3 and 1.7 quantize to distinct half-steps and give bitmap dimensions
      // whose independent rounding previously diverged between the axes.
      for (const zoom of [1, 1.3, 1.7, 2, 2.4]) {
        renderer.zoomScale = zoom;
        renderer._resizeCanvasBitmap();
        const { x, y } = axisScales();
        expect(x).toBeCloseTo(y, 10);
      }
    });

    it("quantizes resolutionScale so small zoom deltas do not reallocate the bitmap", () => {
      renderer.zoomScale = 1.6;
      renderer._resizeCanvasBitmap();
      const width = renderer.canvas.width;
      const height = renderer.canvas.height;
      const generation = renderer._renderGeneration;

      // A nudge within the same half-step must not touch the bitmap at all:
      // each reallocation is multiple megabytes and discards the painted buffer.
      renderer.zoomScale = 1.7;
      renderer._resizeCanvasBitmap();

      expect(renderer.canvas.width).toBe(width);
      expect(renderer.canvas.height).toBe(height);
      expect(renderer._renderGeneration).toBe(generation);
    });
  });

  describe("PDF bounds caching and lookup", () => {
    // These bounds decide which palette a stroke draws in, so a stale cache
    // shows up as wrong stroke colours on PDF pages. The lookup was also
    // O(strokes x pages) per repaint before being indexed.
    let mediaItems;
    let mediaManager;

    function makePage(id, y, { height = 800, x = 0, width = 600 } = {}) {
      return { id, type: "pdf-page", x, y, width, height };
    }

    beforeEach(() => {
      mediaItems = [makePage("p1", 0), makePage("p2", 800), makePage("p3", 1600)];
      mediaManager = {
        version: 0,
        getItems: () => mediaItems,
      };
      renderer.setMediaManager(mediaManager);
      getTheme.mockReturnValue("light"); // light theme -> pages are un-inverted
    });

    it("returns one bounds entry per PDF page, sorted by y", () => {
      const bounds = renderer._getUninvertedPdfBounds();
      expect(bounds.map((b) => b.y)).toEqual([0, 800, 1600]);
    });

    it("reuses the cached array while media is unchanged", () => {
      const first = renderer._getUninvertedPdfBounds();
      const second = renderer._getUninvertedPdfBounds();
      expect(second).toBe(first); // identity: no rebuild, no allocation
    });

    it("rebuilds when the media version changes", () => {
      const first = renderer._getUninvertedPdfBounds();
      mediaItems.push(makePage("p4", 2400));
      mediaManager.version++;

      const second = renderer._getUninvertedPdfBounds();
      expect(second).not.toBe(first);
      expect(second).toHaveLength(4);
    });

    it("sorts pages that are not stored in y order", () => {
      mediaItems = [makePage("p3", 1600), makePage("p1", 0), makePage("p2", 800)];
      mediaManager.version++;
      expect(renderer._getUninvertedPdfBounds().map((b) => b.y)).toEqual([0, 800, 1600]);
    });

    describe("_strokeNeedsLightPalette", () => {
      beforeEach(() => {
        getTheme.mockReturnValue("dark");
        getPdfInvertDarkMode.mockReturnValue(false); // pages stay white in dark theme
      });

      /** Stroke whose first point is at (x, y). */
      const strokeAt = (x, y) => ({ x: [x], y: [y] });

      it("matches a stroke on the first page", () => {
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(100, 50), bounds)).toBe(true);
      });

      it("matches a stroke on a middle page", () => {
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(100, 900), bounds)).toBe(true);
      });

      it("matches a stroke on the last page", () => {
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(100, 1700), bounds)).toBe(true);
      });

      it("matches at exact page boundaries", () => {
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(0, 0), bounds)).toBe(true);
        expect(renderer._strokeNeedsLightPalette(strokeAt(600, 800), bounds)).toBe(true);
      });

      it("rejects a stroke below every page", () => {
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(100, 5000), bounds)).toBe(false);
      });

      it("rejects a stroke horizontally outside the page", () => {
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(2000, 50), bounds)).toBe(false);
      });

      it("rejects a stroke in a vertical gap between pages", () => {
        mediaItems = [makePage("p1", 0, { height: 100 }), makePage("p2", 1000, { height: 100 })];
        mediaManager.version++;
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(100, 500), bounds)).toBe(false);
      });

      it("finds a match on a tall page that an earlier short page overlaps", () => {
        // The backward walk is bounded by the tallest page; a naive bound that
        // stopped at the first non-matching page would miss this.
        mediaItems = [
          makePage("tall", 0, { height: 3000 }),
          makePage("short", 100, { height: 50 }),
        ];
        mediaManager.version++;
        const bounds = renderer._getUninvertedPdfBounds();
        expect(renderer._strokeNeedsLightPalette(strokeAt(100, 2500), bounds)).toBe(true);
      });

      it("agrees with a brute-force scan across many random points", () => {
        // Guards the binary search against off-by-one errors the fixed cases
        // above might not surface.
        mediaItems = Array.from({ length: 40 }, (_, i) => makePage(`p${i}`, i * 800));
        mediaManager.version++;
        const bounds = renderer._getUninvertedPdfBounds();
        const bruteForce = (px, py) =>
          bounds.some((b) => px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height);

        for (let i = 0; i < 300; i++) {
          const px = (i * 137) % 900;
          const py = (i * 523) % 34000;
          expect(renderer._strokeNeedsLightPalette(strokeAt(px, py), bounds)).toBe(
            bruteForce(px, py),
          );
        }
      });
    });
  });

  describe("media culling", () => {
    function makeItems(count) {
      return Array.from({ length: count }, (_, i) => ({
        id: `p${i}`,
        type: "pdf-page",
        x: 0,
        y: i * 800,
        width: 600,
        height: 800,
      }));
    }

    it("returns only items overlapping the range, in array (z) order", () => {
      const items = makeItems(40);
      renderer.setMediaManager({ version: 0, getItems: () => items });

      const visible = renderer._getItemsOverlapping(items, 8000, 10000);
      const ids = visible.map((i) => i.id);

      expect(ids).toEqual(["p9", "p10", "p11", "p12"]);
      // Array order preserved so z-order is unchanged.
      const indices = visible.map((i) => items.indexOf(i));
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    });

    it("agrees with a brute-force filter for both small and indexed lists", () => {
      // 8 items takes the linear path, 40 takes the sorted-index path.
      for (const count of [8, 40]) {
        const items = makeItems(count);
        renderer.setMediaManager({ version: 0, getItems: () => items });

        for (const top of [0, 750, 3200, 100000]) {
          const bottom = top + 1500;
          const expected = items.filter((i) => i.y + i.height >= top && i.y <= bottom);
          expect(renderer._getItemsOverlapping(items, top, bottom)).toEqual(expected);
        }
      }
    });

    it("rebuilds its index when media changes", () => {
      const items = makeItems(40);
      const manager = { version: 0, getItems: () => items };
      renderer.setMediaManager(manager);
      renderer._getItemsOverlapping(items, 0, 1000);

      // Move a page into the queried range and bump the version.
      items[30].y = 500;
      manager.version++;

      const ids = renderer._getItemsOverlapping(items, 0, 1000).map((i) => i.id);
      expect(ids).toContain("p30");
    });

    it("handles items taller than the query range", () => {
      const items = makeItems(40);
      items[0].height = 20000; // one very tall page spanning many others
      renderer.setMediaManager({ version: 0, getItems: () => items });

      const ids = renderer._getItemsOverlapping(items, 15000, 16000).map((i) => i.id);
      expect(ids).toContain("p0");
    });
  });

  describe("zoom re-render scheduling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      renderer.resize(1000, 800);
      renderer.setContentSize(1200, 100000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("coalesces a pinch into a single debounced re-render", () => {
      const repositionSpy = vi.spyOn(renderer, "_repositionBuffer");

      // Simulate a pinch: many zoom steps well inside the debounce window.
      for (let i = 1; i <= 20; i++) {
        renderer.setZoom(1 + i * 0.05, { scrollTop: i * 10, scrollLeft: 0 });
      }
      // Nothing heavy may run while the fingers are still moving.
      expect(repositionSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(renderer.zoomRenderDebounce + 10);
      expect(repositionSpy).toHaveBeenCalledTimes(1);
    });

    it("settles using the live scroll position, not one captured mid-gesture", () => {
      const repositionSpy = vi.spyOn(renderer, "_repositionBuffer");

      renderer.setZoom(2, { scrollTop: 1000, scrollLeft: 0 });
      // The view keeps moving after that first zoom step.
      renderer.setZoom(2, { scrollTop: 8000, scrollLeft: 0 });

      vi.advanceTimersByTime(renderer.zoomRenderDebounce + 10);

      // 8000 screen px / zoom 2 = 4000 content px. Using the stale 1000 would
      // reposition the buffer to the wrong part of the document.
      expect(repositionSpy).toHaveBeenCalledWith(4000);
    });

    it("cancels a pending debounced pass when an immediate zoom supersedes it", () => {
      renderer.setZoom(1.5, { scrollTop: 500, scrollLeft: 0 });
      const repositionSpy = vi.spyOn(renderer, "_repositionBuffer");

      // Pointer-up settle.
      renderer.setZoom(1.5, { scrollTop: 500, scrollLeft: 0, immediate: true });
      expect(repositionSpy).toHaveBeenCalledTimes(1);

      // The superseded timer must not fire a second full redraw.
      vi.advanceTimersByTime(renderer.zoomRenderDebounce + 10);
      expect(repositionSpy).toHaveBeenCalledTimes(1);
    });
  });
});
