import { TextLayer } from "pdfjs-dist";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPdfPage } from "../../modules/pdfManager.js";
import { PdfTextLayerManager } from "./PdfTextLayerManager.js";

// Mock dependencies
vi.mock("pdfjs-dist", () => {
  class TextLayerMock {
    render = vi.fn().mockResolvedValue();
  }
  return {
    TextLayer: vi.fn().mockImplementation(function () {
      return new TextLayerMock();
    }),
  };
});

vi.mock("../../modules/pdfManager.js", () => ({
  loadPdfPage: vi.fn(),
}));

describe("PdfTextLayerManager", () => {
  let viewportElement;
  let mediaManager;
  let manager;
  let mockPage;

  // Helper to flush microtasks (wait for async queue processing)
  const flushPromises = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  beforeEach(() => {
    viewportElement = document.createElement("div");
    mediaManager = {
      getItems: vi.fn(() => []),
    };

    mockPage = {
      getViewport: vi.fn(() => ({ width: 600, height: 800 })),
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: "Hello World", transform: [1, 0, 0, 1, 0, 0] }],
      }),
    };
    loadPdfPage.mockResolvedValue(mockPage);

    vi.useFakeTimers();

    manager = new PdfTextLayerManager(viewportElement, mediaManager);
  });

  afterEach(() => {
    manager.destroy();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("creates container on initialization", () => {
    expect(viewportElement.querySelector(".note-canvas__text-layers")).toBeTruthy();
  });

  it("creates layers for visible PDF pages", async () => {
    const pdfItem = {
      id: "p1",
      type: "pdf-page",
      fileId: "f1",
      pageIndex: 1,
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    };
    mediaManager.getItems.mockReturnValue([pdfItem]);

    // Viewport covers the page
    manager.update(
      { top: 0, bottom: 600, left: 0, right: 800 }, // viewportBounds
      1.0, // zoom
      0, // scrollLeft
      0, // scrollTop
      0, // centeringOffset
      600, // viewportHeight
    );

    // Fast-forward debounce
    vi.runAllTimers();

    // Wait for async creation
    await flushPromises();

    expect(loadPdfPage).toHaveBeenCalledWith("f1", 1);
    expect(TextLayer).toHaveBeenCalled();
    expect(manager.activeLayers.has("p1")).toBe(true);

    const layerEl = manager.activeLayers.get("p1").element;
    expect(layerEl).toBeTruthy();
    expect(viewportElement.contains(layerEl)).toBe(true);
  });

  it("removes layers when scrolled out of view", async () => {
    const pdfItem = {
      id: "p1",
      type: "pdf-page",
      fileId: "f1",
      pageIndex: 1,
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    };
    mediaManager.getItems.mockReturnValue([pdfItem]);

    // 1. Create layer (visible)
    manager.update({ top: 0, bottom: 600, left: 0, right: 800 }, 1.0, 0, 0, 0, 600);
    vi.runAllTimers();
    await flushPromises();

    expect(manager.activeLayers.has("p1")).toBe(true);

    // 2. Scroll away (viewport at 2000, page at 0-800)
    // Buffer is viewportHeight / zoom = 600.
    // Visible range: 2000 +/- 600 = 1400 to 2600.
    // Page (0-800) is outside.
    manager.update({ top: 2000, bottom: 2600, left: 0, right: 800 }, 1.0, 0, 2000, 0, 600);

    expect(manager.activeLayers.has("p1")).toBe(false);
    expect(viewportElement.querySelector(".note-canvas__text-layer")).toBeNull();
  });

  it("updates layer positions", async () => {
    const pdfItem = {
      id: "p1",
      type: "pdf-page",
      fileId: "f1",
      pageIndex: 1,
      x: 100,
      y: 100,
      width: 600,
      height: 800,
    };
    mediaManager.getItems.mockReturnValue([pdfItem]);

    // Initial create
    manager.update({ top: 0, bottom: 600, left: 0, right: 800 }, 1.0, 0, 0, 0, 600);
    vi.runAllTimers();
    await flushPromises();

    const layerEl = manager.activeLayers.get("p1").element;

    // Check initial position (zoom 1)
    // x: 100, y: 100
    expect(layerEl.style.left).toBe("100px");
    expect(layerEl.style.top).toBe("100px");

    // Update with zoom 2
    // x: 100 * 2 = 200. y: 100 * 2 = 200.
    manager.update({ top: 0, bottom: 300, left: 0, right: 400 }, 2.0, 0, 0, 0, 600);

    expect(layerEl.style.left).toBe("200px");
    expect(layerEl.style.top).toBe("200px");
    expect(layerEl.style.width).toBe("1200px"); // 600 * 2
    expect(layerEl.style.height).toBe("1600px"); // 800 * 2
  });

  it("highlights search terms", async () => {
    const pdfItem = {
      id: "p1",
      type: "pdf-page",
      fileId: "f1",
      pageIndex: 1,
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    };
    mediaManager.getItems.mockReturnValue([pdfItem]);

    // Mock text content with specific text
    mockPage.getTextContent.mockResolvedValue({
      items: [
        { str: "Hello world", transform: [1, 0, 0, 1, 0, 0] },
        { str: "Another line", transform: [1, 0, 0, 1, 0, 20] },
      ],
    });

    // Create layer
    manager.update({ top: 0, bottom: 600, left: 0, right: 800 }, 1.0, 0, 0, 0, 600);
    vi.runAllTimers();
    await flushPromises();

    const layerEl = manager.activeLayers.get("p1").element;

    // Simulate PDF.js rendering spans (since we mocked TextLayer.render)
    layerEl.innerHTML = `<span>Hello world</span><span>Another line</span>`;

    // Highlight "Hello"
    manager.highlightSearchTerms("Hello");

    const marks = layerEl.querySelectorAll("mark.search-highlight");
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe("Hello");
  });

  it("clears highlights", async () => {
    const pdfItem = {
      id: "p1",
      type: "pdf-page",
      fileId: "f1",
      pageIndex: 1,
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    };
    mediaManager.getItems.mockReturnValue([pdfItem]);

    manager.update({ top: 0, bottom: 600, left: 0, right: 800 }, 1.0, 0, 0, 0, 600);
    vi.runAllTimers();
    await flushPromises();

    const layerEl = manager.activeLayers.get("p1").element;
    layerEl.innerHTML = `<span><mark class="search-highlight">Hello</mark> world</span>`;

    manager.clearHighlights();

    expect(layerEl.querySelectorAll("mark").length).toBe(0);
    expect(layerEl.textContent).toBe("Hello world");
  });

  it("sets mode correctly", () => {
    manager.setMode("pan");
    expect(manager.container.style.pointerEvents).toBe("auto");

    manager.setMode("draw");
    expect(manager.container.style.pointerEvents).toBe("none");
  });

  it("handles page removal", async () => {
    const pdfItem = {
      id: "p1",
      type: "pdf-page",
      fileId: "f1",
      pageIndex: 1,
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    };
    mediaManager.getItems.mockReturnValue([pdfItem]);

    manager.update({ top: 0, bottom: 600, left: 0, right: 800 }, 1.0, 0, 0, 0, 600);
    vi.runAllTimers();
    await flushPromises();

    expect(manager.activeLayers.has("p1")).toBe(true);
    expect(manager.textContentCache.has("p1")).toBe(true);

    manager.onPageRemoved("p1");

    expect(manager.activeLayers.has("p1")).toBe(false);
    expect(manager.textContentCache.has("p1")).toBe(false);
  });

  it("destroys correctly", () => {
    manager.destroy();
    expect(viewportElement.querySelector(".note-canvas__text-layers")).toBeNull();
    expect(manager.container).toBeNull();
  });
});
