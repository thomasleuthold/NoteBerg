import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawBackgroundPattern as mockDrawBackgroundPattern } from "../../utils/noteRenderer.js";
import { CanvasRenderer } from "./CanvasRenderer.js";

// Mock dependencies
vi.mock("../../utils/noteRenderer.js", () => ({
  drawBackgroundPattern: vi.fn(),
  drawStroke: vi.fn(),
  getThemePalette: vi.fn(() => ["#000000", "#ff0000"]),
  getMarkerPalette: vi.fn(() => ["#000000", "#ff0000"]),
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
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type) => {
      if (type === "2d") return mockCtx;
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
