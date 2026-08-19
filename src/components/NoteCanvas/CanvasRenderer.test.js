import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRenderCache,
  getRenderCacheKey,
  getRenderedMedia,
  setPinnedRenderKeys,
} from "../../modules/mediaManager.js";
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
  setPinnedRenderKeys: vi.fn(),
  // Mirrors the real key format so pin assertions compare against real keys.
  getRenderCacheKey: vi.fn(
    (item, scale = 1.0) => `${item.id}-${Math.max(1.0, Math.ceil(scale * 2) / 2)}`,
  ),
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
      // A real CanvasRenderingContext2D has these; the loading/error page
      // indicators call them, and roundRect is feature-detected at the call site.
      rect: vi.fn(),
      roundRect: vi.fn(),
      closePath: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 0 })),
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
    // The viewport is tracked in screen pixels; the buffer is derived from it.
    expect(renderer.screenViewportWidth).toBe(800);
    expect(renderer.screenViewportHeight).toBe(600);
    expect(renderer.canvas.width).toBeGreaterThan(0);
    expect(renderer.canvas.height).toBeGreaterThan(0);
  });

  it("renders buffer and clears context", () => {
    renderer.resize(800, 600);
    renderer.render(0, 600);

    // Check if clearRect was called
    expect(mockCtx.clearRect).toHaveBeenCalled();
  });

  it("does not resize the buffer from render(), whatever height it is passed", () => {
    // resize() is the single writer of viewport size, driven by VirtualScroller's
    // ResizeObserver. render() used to re-derive it from its viewportHeight
    // argument, which fired repeatedly mid-flick on mobile as the URL bar shows
    // and hides — reallocating the bitmap and forcing a full repaint during a
    // scroll, duplicating work the ResizeObserver was already about to do.
    renderer.setContentSize(1200, 100000);
    renderer.resize(800, 600);
    // Settle the buffer at the established viewport first, so the comparison
    // below isolates render()'s behaviour rather than the initial draw's.
    renderer.render(0, 600);
    const bitmapHeight = renderer.canvas.height;
    const bufferHeight = renderer.bufferHeight;

    // A height wildly different from the established one must be ignored.
    renderer.render(0, 320);

    expect(renderer.screenViewportHeight).toBe(600);
    expect(renderer.canvas.height).toBe(bitmapHeight);
    expect(renderer.bufferHeight).toBe(bufferHeight);
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
    it("does not request a desynchronized context for either canvas", () => {
      // The hint saves about a frame of stylus latency, but it promotes the
      // canvas onto its own compositing plane where any unpainted moment
      // composites as solid BLACK instead of the page colour. On Chrome for
      // Android that turned ordinary transient paint gaps into a black note and
      // a black flicker while scrolling; Firefox ignores the hint and stayed
      // readable through the same states. Readability wins over a frame.
      expect(contextOptions[0]?.desynchronized).toBeFalsy();
      expect(contextOptions[1]?.desynchronized).toBeFalsy();
    });

    it("paints an opaque page background into the buffer bitmap", () => {
      // Belt-and-braces now that the context is synchronized, but still the
      // right thing: the buffer carries its own background rather than relying
      // on the element's CSS background showing through transparent pixels.
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

    it("pins the visible PDF pages so the cache cannot evict what is on screen", () => {
      // Two pages in the buffer, one far below it. The cache must be told about
      // exactly the on-screen pair: if it may evict one of them, the next frame
      // re-renders it, which evicts the other, and the pages thrash forever
      // within whatever zoom range makes both bitmaps not fit at once.
      const second = { ...item, id: "page-2", pageIndex: 2, y: 900 };
      const offscreen = { ...item, id: "page-99", pageIndex: 99, y: 100000 };
      mediaItems = [item, second, offscreen];
      renderer.resolutionScale = 2;
      getRenderedMedia.mockResolvedValue(makeRenderable("pinned"));

      renderer._drawBuffer(false);

      expect(setPinnedRenderKeys).toHaveBeenCalled();
      const pinned = [...vi.mocked(setPinnedRenderKeys).mock.calls.at(-1)[0]];
      expect(pinned).toEqual(
        expect.arrayContaining([
          getRenderCacheKey(item, 2, { invertForDarkTheme: true }),
          getRenderCacheKey(second, 2, { invertForDarkTheme: true }),
        ]),
      );
      // A page nowhere near the viewport must stay evictable.
      expect(pinned).not.toContain(getRenderCacheKey(offscreen, 2, { invertForDarkTheme: true }));
    });

    it("releases the pins when the renderer is destroyed", () => {
      getRenderedMedia.mockResolvedValue(makeRenderable("destroyed"));
      renderer._drawBuffer(false);
      vi.mocked(setPinnedRenderKeys).mockClear();

      renderer.destroy();

      // Nothing of this renderer is on screen any more; leaving pins set would
      // reserve cache budget for bitmaps no one will ever draw.
      expect(setPinnedRenderKeys).toHaveBeenCalledWith([]);
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

    it("draws a loading placeholder for a page queued behind the load semaphore", () => {
      // With maxConcurrentPdfLoads slots taken, this page cannot start loading
      // yet: loading === false and error === false. It must still paint a
      // placeholder — the branch structure previously matched no case at all, so
      // every page past the first two rendered as a blank void with no
      // indicator, which is exactly what "PDF pages 2+ are blank" looked like.
      const indicator = vi.spyOn(renderer, "_drawLoadingIndicator");
      const fillRect = vi.spyOn(renderer.ctx, "fillRect");
      renderer.activePdfLoads = renderer.maxConcurrentPdfLoads;
      getRenderedMedia.mockClear();

      renderer._drawPdfPage(item, false);

      expect(getRenderedMedia).not.toHaveBeenCalled(); // no slot -> no load started
      expect(item.loading).toBeFalsy();
      expect(item.error).toBeFalsy(); // queued is not an error state
      expect(fillRect).toHaveBeenCalledWith(item.x, item.y, item.width, item.height);
      expect(indicator).toHaveBeenCalledWith(item);
    });

    it("retries a failed render instead of latching the page into an error state", async () => {
      vi.useFakeTimers();
      try {
        // A render failure is usually transient — the PDF binary may still be
        // downloading. Latching item.error permanently left the page blank for
        // the rest of the session even after the file arrived.
        getRenderedMedia.mockRejectedValueOnce(new Error("PDF file not found"));

        renderer._drawPdfPage(item, false);
        await vi.waitFor(() => expect(item.loading).toBe(false));

        // Error is set so the next frame does not immediately re-request...
        expect(item.error).toBe(true);
        expect(renderer.activePdfLoads).toBe(0);

        // ...but the page must recover on its own once the file is available:
        // the backoff clears item.error and the debounced queue check redraws,
        // with no user interaction. Latching item.error permanently is what left
        // pages blank for the rest of the session.
        const renderable = makeRenderable("recovered");
        getRenderedMedia.mockResolvedValue(renderable);

        await vi.advanceTimersByTimeAsync(10000);
        await vi.waitFor(() => expect(item.renderable).toBe(renderable));
        expect(item.error).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops retrying a persistently failing page", async () => {
      vi.useFakeTimers();
      try {
        getRenderedMedia.mockRejectedValue(new Error("corrupt page"));

        // Drive more attempts than the retry budget allows.
        for (let i = 0; i < 6; i++) {
          renderer._drawPdfPage(item, false);
          await vi.waitFor(() => expect(item.loading).toBe(false));
          await vi.advanceTimersByTimeAsync(30000);
        }

        // A genuinely undecodable page must settle into the error state rather
        // than re-rendering forever and burning battery on a low-end tablet.
        expect(item.error).toBe(true);
        await vi.advanceTimersByTimeAsync(60000);
        expect(item.error).toBe(true);
      } finally {
        vi.useRealTimers();
      }
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
      // resolutionScale tracks device pixel density only — the buffer is sized
      // in screen space, so zoom no longer enters into it.
      const originalDpr = window.devicePixelRatio;
      try {
        Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
        renderer._resizeCanvasBitmap();
        const before = renderer._renderGeneration;

        Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
        renderer._resizeCanvasBitmap();

        expect(renderer._renderGeneration).toBeGreaterThan(before);
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: originalDpr,
          configurable: true,
        });
      }
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

    it("quantizes bitmap size so small zoom deltas do not reallocate it", () => {
      renderer.resize(400, 800);
      renderer.setContentSize(1200, 100000);
      renderer.zoomScale = 1.6;
      renderer._updateBufferExtent();
      renderer._resizeCanvasBitmap();
      const width = renderer.canvas.width;
      const height = renderer.canvas.height;
      const generation = renderer._renderGeneration;

      // A nudge within the same quantum must not touch the bitmap at all: each
      // reallocation is multiple megabytes and discards the painted buffer.
      renderer.zoomScale = 1.62;
      renderer._updateBufferExtent();
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

  describe("pending media placeholder", () => {
    // While an image insert is still encoding/storing, the item has no fileId.
    // The canvas must still show something at its position, animated, so the
    // user can see the insert is in progress.
    const pendingItem = {
      id: "pending-1",
      type: "image",
      pending: true,
      x: 100,
      y: 100,
      width: 200,
      height: 150,
      rotation: 0,
    };

    beforeEach(() => {
      renderer.resize(1000, 800);
      renderer.setContentSize(1200, 5000);
    });

    it("draws a placeholder for an item that has no file yet", () => {
      renderer.setMediaManager({
        version: 0,
        getItems: () => [pendingItem],
        getImage: vi.fn(() => null),
      });

      renderer.forceRedraw();

      // A filled box at the item's position stands in for the image.
      expect(mockCtx.fillRect).toHaveBeenCalledWith(100, 100, 200, 150);
      // Plus a spinner arc, which is what marks it as in-progress rather than broken.
      expect(mockCtx.arc).toHaveBeenCalled();
    });

    it("never asks for a file for a pending item", () => {
      const getImage = vi.fn(() => null);
      renderer.setMediaManager({ version: 0, getItems: () => [pendingItem], getImage });

      renderer.forceRedraw();

      // There is no fileId to look up; doing so would be a bug.
      expect(getImage).not.toHaveBeenCalled();
    });

    it("draws the real image instead once the item is resolved", () => {
      const img = { width: 400, height: 300 };
      const resolved = { ...pendingItem, fileId: "f1" };
      delete resolved.pending;

      renderer.setMediaManager({
        version: 1,
        getItems: () => [resolved],
        getImage: vi.fn(() => img),
      });

      mockCtx.arc.mockClear();
      renderer.forceRedraw();

      expect(mockCtx.drawImage).toHaveBeenCalledWith(img, 100, 100, 200, 150);
      // No spinner over a finished image.
      expect(mockCtx.arc).not.toHaveBeenCalled();
    });

    describe("animation loop", () => {
      let rafCallbacks;

      beforeEach(() => {
        rafCallbacks = [];
        vi.stubGlobal("requestAnimationFrame", (cb) => {
          rafCallbacks.push(cb);
          return rafCallbacks.length;
        });
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
      });

      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("keeps repainting while a pending item exists", () => {
        renderer.setMediaManager({
          version: 0,
          getItems: () => [pendingItem],
          getImage: vi.fn(() => null),
        });

        renderer.startPendingMediaAnimation();
        expect(rafCallbacks).toHaveLength(1);

        // Each frame must schedule the next, or the spinner freezes.
        rafCallbacks.shift()();
        expect(rafCallbacks).toHaveLength(1);
      });

      it("stops on its own once nothing is pending", () => {
        let items = [pendingItem];
        renderer.setMediaManager({
          version: 0,
          getItems: () => items,
          getImage: vi.fn(() => null),
        });

        renderer.startPendingMediaAnimation();
        items = []; // insert finished
        rafCallbacks.shift()();

        // No follow-up frame: the loop costs nothing outside an active insert.
        expect(rafCallbacks).toHaveLength(0);
      });

      it("does not stack loops when started repeatedly", () => {
        renderer.setMediaManager({
          version: 0,
          getItems: () => [pendingItem],
          getImage: vi.fn(() => null),
        });

        renderer.startPendingMediaAnimation();
        renderer.startPendingMediaAnimation();
        renderer.startPendingMediaAnimation();

        expect(rafCallbacks).toHaveLength(1);
      });

      it("does not repaint after the renderer is destroyed", () => {
        renderer.setMediaManager({
          version: 0,
          getItems: () => [pendingItem],
          getImage: vi.fn(() => null),
        });

        renderer.startPendingMediaAnimation();
        const frame = rafCallbacks.shift();
        renderer.destroy();

        // A frame already queued when the note closed must be inert, not paint
        // into a torn-down canvas.
        expect(() => frame()).not.toThrow();
        expect(rafCallbacks).toHaveLength(0);
      });
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
      expect(repositionSpy.mock.calls[0][0]).toBe(4000);
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

    it("leaves the buffer opaque after a settling zoom", () => {
      // The single settle paint is the only one that will happen, so it must
      // leave the bitmap painted. An unpainted bitmap shows nothing at all where
      // the note should be.
      mockCtx.fillRect.mockClear();
      renderer.setZoom(2, { scrollTop: 1000, scrollLeft: 0, immediate: true });

      expect(mockCtx.fillRect).toHaveBeenCalled();
    });

    it("settles at full quality without queueing a second repaint", () => {
      const drawSpy = vi.spyOn(renderer, "_drawBuffer");

      // Pointer-up settle: the final state is known, nothing more is coming, so
      // a fast pass would only be thrown away and repainted moments later.
      renderer.setZoom(2, { scrollTop: 1000, scrollLeft: 0, immediate: true });
      expect(drawSpy).toHaveBeenCalledWith(false);

      drawSpy.mockClear();
      vi.advanceTimersByTime(renderer._qualityRenderDebounce + 10);
      expect(drawSpy).not.toHaveBeenCalled();
    });

    it("leaves the buffer opaque after a debounced zoom settle", () => {
      mockCtx.fillRect.mockClear();
      renderer.setZoom(1.5, { scrollTop: 300, scrollLeft: 0 });
      vi.advanceTimersByTime(renderer.zoomRenderDebounce + 10);

      expect(mockCtx.fillRect).toHaveBeenCalled();
    });

    it("settles a debounced zoom at full quality without a second repaint", () => {
      const drawSpy = vi.spyOn(renderer, "_drawBuffer");

      renderer.setZoom(1.5, { scrollTop: 300, scrollLeft: 0 });
      vi.advanceTimersByTime(renderer.zoomRenderDebounce + 10);
      expect(drawSpy).toHaveBeenCalledWith(false);

      drawSpy.mockClear();
      vi.advanceTimersByTime(renderer._qualityRenderDebounce + 10);
      expect(drawSpy).not.toHaveBeenCalled();
    });

    it("keeps the bitmap the same size at every zoom level", () => {
      // The core invariant of screen-space sizing, and what makes the black-note
      // failure unreachable: the bitmap covers a fixed number of SCREEN pixels,
      // so zoom changes how much content it shows, never how much memory it
      // costs. Sizing in content space (screen / zoom) is what previously let
      // zoom-out grow the bitmap past the browser's canvas area cap, where
      // Chrome silently drops the backing store and every later draw becomes a
      // no-op, leaving the note blank.
      renderer.resize(400, 800);
      renderer.setContentSize(1200, 100000);

      const areas = new Set();
      for (const scale of [1, 2, 4, 8]) {
        renderer.setZoom(scale, {
          scrollTop: 5000,
          scrollLeft: 0,
          immediate: true,
          viewportHeight: 800,
        });
        areas.add(renderer.canvas.width * renderer.canvas.height);
      }

      // One distinct size across the whole zoom range.
      expect(areas.size).toBe(1);
    });

    it("keeps the bitmap within the canvas area limit on a high-dpr phone", () => {
      // dpr multiplies into both axes, so it is the case most likely to blow the
      // cap. 16M px is the conservative worst-case limit for Chrome on Android.
      const originalDpr = window.devicePixelRatio;
      Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
      try {
        renderer.resize(400, 800);
        renderer.setContentSize(1200, 100000);

        for (const scale of [0.25, 0.5, 1, 2, 4, 8]) {
          renderer.setZoom(scale, {
            scrollTop: 5000,
            scrollLeft: 0,
            immediate: true,
            viewportHeight: 800,
          });
          const area = renderer.canvas.width * renderer.canvas.height;
          expect(area, `zoom ${scale} allocated ${area}px`).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: originalDpr,
          configurable: true,
        });
      }
    });

    it("keeps the bitmap within the canvas area limit on large desktop viewports", () => {
      // The buffer multipliers are constants but the bitmap grows with VIEWPORT
      // AREA, so a budget that holds on a 400x800 phone is exceeded by an
      // ordinary laptop: 1400x900 at dpr 2 allocated 19M px, and 1920x1080 at
      // dpr 2 about 30M px, past the ~16M cap where Chrome drops the backing
      // store and leaves the canvas permanently blank.
      const originalDpr = window.devicePixelRatio;
      const viewports = [
        [1400, 900, 2],
        [1920, 1080, 2],
        [1920, 1080, 3],
        [2560, 1440, 2],
        [3840, 2160, 2],
      ];

      try {
        for (const [vw, vh, dpr] of viewports) {
          Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
          renderer.resize(vw, vh);
          renderer.setContentSize(1200, 100000);

          for (const scale of [0.25, 0.5, 1, 2, 4]) {
            renderer.setZoom(scale, {
              scrollTop: 5000,
              scrollLeft: 0,
              immediate: true,
              viewportHeight: vh,
            });
            const area = renderer.canvas.width * renderer.canvas.height;
            expect(
              area,
              `${vw}x${vh} dpr${dpr} zoom ${scale} allocated ${area}px`,
            ).toBeLessThanOrEqual(16 * 1024 * 1024);

            // The area clamp must never widen the buffer past the note itself:
            // zoomed out on a large display one viewport spans several times the
            // note width, and flooring the clamp at the raw viewport width
            // inflated the buffer to 4043 content px against a 1200px note.
            //
            // Allowance is one BITMAP_SIZE_QUANTUM expressed in CONTENT pixels —
            // extents round up to a whole quantum of DEVICE pixels, which at low
            // zoom is many content pixels.
            const quantumInContentPx = 256 / (scale * renderer.resolutionScale);
            expect(
              renderer.bufferWidth,
              `${vw}x${vh} dpr${dpr} zoom ${scale} buffer width`,
            ).toBeLessThanOrEqual(1200 + quantumInContentPx);
          }
        }
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: originalDpr,
          configurable: true,
        });
      }
    });

    it("still covers the full viewport when the area cap trims the buffer", () => {
      // The cap shortens the vertical lead-in, but never below one viewport —
      // a buffer smaller than the visible region leaves an unpainted band.
      const originalDpr = window.devicePixelRatio;
      Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
      try {
        renderer.resize(1920, 1080);
        renderer.setContentSize(1200, 100000);
        renderer.setZoom(1, {
          scrollTop: 5000,
          scrollLeft: 0,
          immediate: true,
          viewportHeight: 1080,
        });

        const viewport = renderer._getContentViewport();
        expect(renderer.bufferHeight).toBeGreaterThanOrEqual(viewport.height);
        expect(renderer.bufferTop).toBeLessThanOrEqual(renderer.contentScrollTop);
        expect(renderer.bufferTop + renderer.bufferHeight).toBeGreaterThanOrEqual(
          renderer.contentScrollTop + viewport.height,
        );
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: originalDpr,
          configurable: true,
        });
      }
    });

    it("keeps the visible area inside the buffer on both axes", () => {
      // The gray-screen failure: if the buffer is positioned so the visible
      // region falls outside it, the page background paints but no strokes do.
      // Must hold on X as well as Y now that the buffer is screen-sized.
      renderer.resize(400, 800);
      renderer.setContentSize(1200, 100000);
      renderer.setZoom(4, {
        scrollTop: 20000,
        scrollLeft: 2000,
        immediate: true,
        viewportHeight: 800,
      });

      const viewport = renderer._getContentViewport();
      const scrollTop = renderer.contentScrollTop;
      const scrollLeft = renderer.contentScrollLeft;

      expect(renderer.bufferTop).toBeLessThanOrEqual(scrollTop);
      expect(renderer.bufferTop + renderer.bufferHeight).toBeGreaterThanOrEqual(
        scrollTop + viewport.height,
      );
      expect(renderer.bufferLeft).toBeLessThanOrEqual(scrollLeft);
      expect(renderer.bufferLeft + renderer.bufferWidth).toBeGreaterThanOrEqual(
        scrollLeft + viewport.width,
      );
    });

    it("is stable where it was just centred, on both axes", () => {
      // If _shouldLeapfrog returns true immediately after _repositionBuffer
      // centres the buffer, every frame triggers a full redraw.
      renderer.resize(400, 800);
      renderer.setContentSize(1200, 100000);
      renderer.setZoom(4, {
        scrollTop: 20000,
        scrollLeft: 2000,
        immediate: true,
        viewportHeight: 800,
      });

      expect(renderer._shouldLeapfrog(renderer.contentScrollTop, renderer.contentScrollLeft)).toBe(
        false,
      );
    });

    it("does not change the buffer extent when the bitmap is resized", () => {
      // The Chrome jumping report: _resizeCanvasBitmap used to round the bitmap
      // up and grow bufferWidth/bufferHeight to match. bufferTop/bufferLeft are
      // centred against the extent by _repositionBuffer, which runs on a
      // different schedule, so the origin was left centred for a shorter buffer
      // and the content shifted under the user — most visibly on images, which
      // are large contiguous objects, and worst at high zoom.
      renderer.resize(400, 800);
      renderer.setContentSize(1200, 100000);
      renderer.setZoom(4, {
        scrollTop: 20000,
        scrollLeft: 500,
        immediate: true,
        viewportHeight: 800,
      });

      const width = renderer.bufferWidth;
      const height = renderer.bufferHeight;
      const top = renderer.bufferTop;
      const left = renderer.bufferLeft;

      // A bitmap resize triggered by something OTHER than a reposition — a
      // device-pixel-ratio change, a container resize — must not move the
      // buffer out from under the already-centred origin.
      Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
      renderer._resizeCanvasBitmap();
      Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });

      expect(renderer.bufferWidth).toBe(width);
      expect(renderer.bufferHeight).toBe(height);
      expect(renderer.bufferTop).toBe(top);
      expect(renderer.bufferLeft).toBe(left);
    });

    it("keeps the buffer origin centred against the extent actually drawn", () => {
      // Whatever quantization does to the extent, the origin must stay centred
      // against the final value — otherwise the visible region drifts within the
      // buffer and the content appears to jump between frames.
      renderer.resize(400, 800);
      renderer.setContentSize(1200, 100000);

      for (const zoom of [1, 2, 4, 8]) {
        renderer.setZoom(zoom, {
          scrollTop: 20000,
          scrollLeft: 500,
          immediate: true,
          viewportHeight: 800,
        });

        // Recomputing the origin from the current extent must be a no-op.
        const viewport = renderer._getContentViewport();
        const expectedTop = renderer._centreBufferOnAxis(
          renderer.contentScrollTop,
          renderer.bufferHeight,
          viewport.height,
          renderer.contentHeight,
        );
        const expectedLeft = renderer._centreBufferOnAxis(
          renderer.contentScrollLeft,
          renderer.bufferWidth,
          viewport.width,
          renderer.maxContentWidth,
        );

        expect(renderer.bufferTop, `zoom ${zoom} bufferTop drifted`).toBeCloseTo(expectedTop, 6);
        expect(renderer.bufferLeft, `zoom ${zoom} bufferLeft drifted`).toBeCloseTo(expectedLeft, 6);
      }
    });

    it("redraws rarely during a sustained scroll, at every zoom", () => {
      // The Chrome jumping report. Each leapfrog is a full redraw of every
      // stroke and image, so a buffer with too little vertical lead-in makes an
      // ordinary flick repaint every few frames — visible as the content
      // jumping, and worst with images because they are large contiguous
      // objects. The buffer is screen-sized, so the lead-in must hold up at high
      // zoom too, where it spans much less content.
      for (const zoom of [1, 2, 4]) {
        renderer.resize(400, 800);
        renderer.setContentSize(1200, 100000);
        renderer.setZoom(zoom, {
          scrollTop: 0,
          scrollLeft: 0,
          immediate: true,
          viewportHeight: 800,
        });

        const spy = vi.spyOn(renderer, "_repositionBuffer");
        // 60 frames of a flick at ~60 screen px per frame.
        for (let frame = 1; frame <= 60; frame++) {
          renderer.render(frame * 60, 800, 0);
        }
        const leaps = spy.mock.calls.length;
        spy.mockRestore();

        // Measured at 2 with the chosen multipliers; 4 with the previous ones,
        // which is what the jumping looked like on device.
        expect(leaps, `zoom ${zoom} repainted ${leaps} times in 60 frames`).toBeLessThanOrEqual(3);
      }
    });

    it("stays under the canvas area cap with the chosen buffer multipliers", () => {
      // Guards the other half of the tradeoff: vertical lead-in and horizontal
      // lead-in multiply into the bitmap area, so raising either to cure
      // jumping can silently reintroduce the black-note failure.
      const originalDpr = window.devicePixelRatio;
      try {
        Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
        renderer.resize(400, 800);
        renderer.setContentSize(1200, 100000);

        for (const zoom of [0.5, 1, 2, 4, 8]) {
          renderer.setZoom(zoom, {
            scrollTop: 5000,
            scrollLeft: 0,
            immediate: true,
            viewportHeight: 800,
          });
          const area = renderer.canvas.width * renderer.canvas.height;
          expect(area, `zoom ${zoom} allocated ${area}px`).toBeLessThanOrEqual(16 * 1024 * 1024);
        }
      } finally {
        Object.defineProperty(window, "devicePixelRatio", {
          value: originalDpr,
          configurable: true,
        });
      }
    });

    it("leapfrogs horizontally once panned past the buffer edge", () => {
      // The cost of a screen-sized buffer: it no longer spans full note width,
      // so horizontal panning must trigger a redraw the same way vertical
      // scrolling does. Without this the note would go blank to the side.
      renderer.resize(400, 800);
      renderer.setContentSize(1200, 100000);
      renderer.setZoom(4, {
        scrollTop: 0,
        scrollLeft: 0,
        immediate: true,
        viewportHeight: 800,
      });

      const farRight = renderer.bufferLeft + renderer.bufferWidth + 100;
      expect(renderer._shouldLeapfrog(renderer.contentScrollTop, farRight)).toBe(true);
    });

    it("still uses a fast pass plus a quality pass when scrolling", () => {
      // Scrolling is the case the two-phase draw exists for: more frames are
      // coming, so the cheap pass is what keeps the scroll at framerate.
      renderer.setZoom(1, { scrollTop: 0, scrollLeft: 0, immediate: true });
      const drawSpy = vi.spyOn(renderer, "_drawBuffer");

      // Scroll far enough to force a leapfrog.
      renderer.render(20000, 800, 0);

      expect(drawSpy).toHaveBeenCalledWith(true);

      drawSpy.mockClear();
      vi.advanceTimersByTime(renderer._qualityRenderDebounce + 10);
      expect(drawSpy).toHaveBeenCalledWith(false);
    });
  });
});
