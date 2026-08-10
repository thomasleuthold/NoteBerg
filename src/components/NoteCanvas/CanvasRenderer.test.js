import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
