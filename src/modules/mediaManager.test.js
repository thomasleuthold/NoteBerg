/**
 * src/modules/mediaManager.test.js
 * Covers the render cache key rounding, PDF page scale calculation, and
 * error-swallowing behavior. pdfManager/storage are mocked; Image/canvas
 * are stubbed like in imageUtils.test.js since jsdom doesn't decode real
 * images or render canvases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadPdfPage = vi.fn();
vi.mock("./pdfManager.js", () => ({
  loadPdfPage: (...args) => loadPdfPage(...args),
}));

const getFile = vi.fn();
vi.mock("./storage.js", () => ({
  getFile: (...args) => getFile(...args),
}));

let mediaManager;

function makePdfPage(baseWidth = 595, baseHeight = 842) {
  const getViewport = vi.fn(({ scale }) => ({
    width: baseWidth * scale,
    height: baseHeight * scale,
  }));
  return {
    getViewport,
    render: vi.fn(() => ({ promise: Promise.resolve() })),
  };
}

function stubCanvas() {
  const ctx = { drawImage: vi.fn() };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx);
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  };
}

function stubImage() {
  class FakeImage {
    set src(_value) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mediaManager = await import("./mediaManager.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getRenderedMedia caching", () => {
  it("caches by rounded scale so nearby scales share a render", async () => {
    const restoreCanvas = stubCanvas();
    const page = makePdfPage();
    loadPdfPage.mockResolvedValue(page);

    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1 };
    await mediaManager.getRenderedMedia(item, 1.0);
    await mediaManager.getRenderedMedia(item, 1.4); // rounds up to 1.5, differs from 1.0 -> re-renders once
    await mediaManager.getRenderedMedia(item, 1.5); // same effective scale as previous call -> cache hit

    expect(loadPdfPage).toHaveBeenCalledTimes(2);
    restoreCanvas();
  });

  it("never uses an effective scale below 1.0", async () => {
    const restoreCanvas = stubCanvas();
    const page = makePdfPage();
    loadPdfPage.mockResolvedValue(page);

    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1 };
    await mediaManager.getRenderedMedia(item, 0.3);
    await mediaManager.getRenderedMedia(item, 0.9);

    // Both round down to the 1.0 floor -> same cache key -> only rendered once.
    expect(loadPdfPage).toHaveBeenCalledTimes(1);
    restoreCanvas();
  });

  it("returns null and does not cache when rendering throws", async () => {
    loadPdfPage.mockRejectedValue(new Error("load failed"));
    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1 };

    const result = await mediaManager.getRenderedMedia(item, 1.0);
    expect(result).toBeNull();

    // A second attempt should retry (not serve a cached null).
    const page = makePdfPage();
    loadPdfPage.mockResolvedValue(page);
    const restoreCanvas = stubCanvas();
    const result2 = await mediaManager.getRenderedMedia(item, 1.0);
    expect(result2).not.toBeNull();
    restoreCanvas();
  });

  it("returns null for an unknown item type without calling either loader", async () => {
    const item = { id: "m1", type: "sticky-note", fileId: "f1" };
    const result = await mediaManager.getRenderedMedia(item);
    expect(result).toBeNull();
    expect(loadPdfPage).not.toHaveBeenCalled();
    expect(getFile).not.toHaveBeenCalled();
  });
});

describe("clearRenderCache", () => {
  it("removes all cached scales for a given item id only", async () => {
    const restoreCanvas = stubCanvas();
    loadPdfPage.mockResolvedValue(makePdfPage());

    const itemA = { id: "a", type: "pdf-page", fileId: "f1", pageIndex: 1 };
    const itemB = { id: "b", type: "pdf-page", fileId: "f2", pageIndex: 1 };
    await mediaManager.getRenderedMedia(itemA, 1.0);
    await mediaManager.getRenderedMedia(itemB, 1.0);

    mediaManager.clearRenderCache("a");
    loadPdfPage.mockClear();

    await mediaManager.getRenderedMedia(itemA, 1.0); // must re-render
    await mediaManager.getRenderedMedia(itemB, 1.0); // still cached

    expect(loadPdfPage).toHaveBeenCalledTimes(1);
    restoreCanvas();
  });
});

describe("PDF page scale calculation", () => {
  it("scales the viewport using item.width relative to the natural page width", async () => {
    const restoreCanvas = stubCanvas();
    const page = makePdfPage(595, 842);
    loadPdfPage.mockResolvedValue(page);

    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1, width: 1190 }; // 2x natural width
    await mediaManager.getRenderedMedia(item, 1.0);

    // getViewport called once for the unscaled baseline, once for the final scale.
    expect(page.getViewport).toHaveBeenNthCalledWith(1, { scale: 1.0 });
    expect(page.getViewport).toHaveBeenNthCalledWith(2, { scale: 2 });
    restoreCanvas();
  });

  it("falls back to the raw scale when item.width is not provided", async () => {
    const restoreCanvas = stubCanvas();
    const page = makePdfPage(595, 842);
    loadPdfPage.mockResolvedValue(page);

    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1 };
    await mediaManager.getRenderedMedia(item, 1.5);

    expect(page.getViewport).toHaveBeenNthCalledWith(2, { scale: 1.5 });
    restoreCanvas();
  });
});

describe("image rendering", () => {
  it("loads the file blob, resolves an Image, and revokes the object URL", async () => {
    stubImage();
    const blob = new Blob(["fake"], { type: "image/png" });
    getFile.mockResolvedValue(blob);

    const item = { id: "m1", type: "image", fileId: "f1" };
    const result = await mediaManager.getRenderedMedia(item);

    expect(result).toBeInstanceOf(Image);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });

  it("returns null (via the catch) when the file is missing from storage", async () => {
    getFile.mockResolvedValue(null);
    const item = { id: "m1", type: "image", fileId: "missing" };
    const result = await mediaManager.getRenderedMedia(item);
    expect(result).toBeNull();
  });
});
