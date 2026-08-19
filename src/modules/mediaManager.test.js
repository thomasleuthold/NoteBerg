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

  it("propagates the error and does not cache when rendering throws", async () => {
    // The error must reach the caller rather than being flattened to null:
    // CanvasRenderer distinguishes a transient failure (retry with backoff) from
    // "this item type renders nothing" (permanent) purely by which one it gets.
    // Swallowing it made every failure permanent and left PDF pages blank.
    loadPdfPage.mockRejectedValue(new Error("load failed"));
    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1 };

    await expect(mediaManager.getRenderedMedia(item, 1.0)).rejects.toThrow("load failed");

    // A second attempt should retry (not serve a cached rejection).
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

describe("concurrent render deduplication", () => {
  // The crash on low-end Android traced back to two overlapping renders of the
  // same page+scale (trivially produced by pinch-zoom) both completing and both
  // writing the cache key, orphaning one full-page bitmap per collision.
  it("joins an in-flight render instead of starting a second one", async () => {
    const restoreCanvas = stubCanvas();
    let resolvePage;
    loadPdfPage.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );

    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1 };
    const first = mediaManager.getRenderedMedia(item, 1.0);
    const second = mediaManager.getRenderedMedia(item, 1.0);

    resolvePage(makePdfPage());
    const [a, b] = await Promise.all([first, second]);

    expect(loadPdfPage).toHaveBeenCalledTimes(1);
    // Both callers must observe the very same object — two distinct canvases
    // would mean one is orphaned while still referenced by a renderer.
    expect(a).toBe(b);
    restoreCanvas();
  });

  it("lets a failed render be retried rather than caching the rejection", async () => {
    loadPdfPage.mockRejectedValueOnce(new Error("PDF file not found"));
    const item = { id: "m1", type: "pdf-page", fileId: "f1", pageIndex: 1 };

    await expect(mediaManager.getRenderedMedia(item, 1.0)).rejects.toThrow("PDF file not found");

    const restoreCanvas = stubCanvas();
    loadPdfPage.mockResolvedValue(makePdfPage());
    expect(await mediaManager.getRenderedMedia(item, 1.0)).not.toBeNull();
    restoreCanvas();
  });
});

describe("cache bounding", () => {
  /** Render `count` distinct pages of the given natural size, oldest first. */
  async function fillCache(count, { pageW = 1200, pageH = 1697, scale = 1.0 } = {}) {
    loadPdfPage.mockResolvedValue(makePdfPage(pageW, pageH));
    const items = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      type: "pdf-page",
      fileId: "f1",
      pageIndex: i + 1,
      width: pageW,
    }));
    const rendered = [];
    for (const item of items) {
      rendered.push(await mediaManager.getRenderedMedia(item, scale));
    }
    // Let the deferred disposal microtasks run.
    await Promise.resolve();
    await Promise.resolve();
    return { items, rendered };
  }

  it("evicts by total bytes, not just entry count", async () => {
    const restoreCanvas = stubCanvas();
    // MAX_CACHE_BYTES is 96MB. A 1200x1697 page is ~7.8MB, so 13 pages
    // (~101MB) must push the oldest out even though the entry count is under
    // MAX_CACHE_ENTRIES (24). Bounding by count alone was the gap that still
    // let a low-end device OOM: bitmap size varies ~16x across the zoom range.
    const { items, rendered } = await fillCache(13);

    expect(rendered[0].width).toBe(0); // oldest disposed

    loadPdfPage.mockClear();
    await mediaManager.getRenderedMedia(items[0], 1.0);
    expect(loadPdfPage).toHaveBeenCalledTimes(1); // evicted -> re-rendered
    restoreCanvas();
  });

  it("keeps many small bitmaps that fit within the byte budget", async () => {
    const restoreCanvas = stubCanvas();
    // Tiny pages: 15 of them stay well under the byte cap and under the entry
    // cap, so nothing should be evicted.
    const { items } = await fillCache(15, { pageW: 80, pageH: 100 });

    loadPdfPage.mockClear();
    await mediaManager.getRenderedMedia(items[0], 1.0);
    expect(loadPdfPage).not.toHaveBeenCalled(); // still cached
    restoreCanvas();
  });

  it("never evicts the entry it is about to return", async () => {
    const restoreCanvas = stubCanvas();
    // A single page far larger than the whole byte budget must still come back
    // usable — evicting it to satisfy the bound would hand back a dead bitmap.
    loadPdfPage.mockResolvedValue(makePdfPage(6000, 9000));
    const huge = { id: "huge", type: "pdf-page", fileId: "f1", pageIndex: 1, width: 6000 };

    const result = await mediaManager.getRenderedMedia(huge, 1.0);
    await Promise.resolve();

    expect(result).not.toBeNull();
    expect(result.width).toBeGreaterThan(0);
    restoreCanvas();
  });

  it("treats a cache hit as a use, so it is not the next eviction victim", async () => {
    const restoreCanvas = stubCanvas();
    loadPdfPage.mockResolvedValue(makePdfPage(1200, 1697));

    const first = { id: "p0", type: "pdf-page", fileId: "f1", pageIndex: 1, width: 1200 };
    await mediaManager.getRenderedMedia(first, 1.0);

    // Fill past the byte cap, refreshing `first` midway so it is no longer the
    // least-recently-used entry and some other page is evicted instead.
    for (let i = 1; i < 14; i++) {
      await mediaManager.getRenderedMedia(
        { id: `p${i}`, type: "pdf-page", fileId: "f1", pageIndex: i + 1, width: 1200 },
        1.0,
      );
      if (i === 5) await mediaManager.getRenderedMedia(first, 1.0); // refresh
    }
    await Promise.resolve();

    loadPdfPage.mockClear();
    await mediaManager.getRenderedMedia(first, 1.0);
    expect(loadPdfPage).not.toHaveBeenCalled(); // still cached
    restoreCanvas();
  });
});

// Within a certain zoom range, PDF pages re-rendered endlessly: two visible
// pages whose bitmaps did not both fit in the byte budget evicted each other in
// turn, and each eviction guaranteed a re-render on the very next frame.
describe("on-screen pinning (render thrash)", () => {
  it("does not evict a pinned entry to make room for a new render", async () => {
    const restoreCanvas = stubCanvas();
    // Two pages at a scale where each bitmap is a large share of the budget, so
    // admitting the second would previously have evicted the first.
    loadPdfPage.mockResolvedValue(makePdfPage(1200, 1697));
    const a = { id: "pa", type: "pdf-page", fileId: "f1", pageIndex: 1, width: 1200 };
    const b = { id: "pb", type: "pdf-page", fileId: "f1", pageIndex: 2, width: 1200 };

    await mediaManager.getRenderedMedia(a, 1.0);
    // The renderer declares A on screen before drawing the next frame.
    mediaManager.setPinnedRenderKeys([mediaManager.getRenderCacheKey(a, 1.0)]);

    // Fill far past the byte budget with other pages.
    for (let i = 0; i < 20; i++) {
      await mediaManager.getRenderedMedia(
        { id: `filler${i}`, type: "pdf-page", fileId: "f1", pageIndex: i + 10, width: 1200 },
        1.0,
      );
    }
    await Promise.resolve();

    loadPdfPage.mockClear();
    await mediaManager.getRenderedMedia(a, 1.0);
    // A is on screen: evicting it would force a re-render next frame, which
    // would evict its neighbour, which is the loop we are preventing.
    expect(loadPdfPage).not.toHaveBeenCalled();

    // Unpinned entries are still evictable — the cache must stay bounded.
    await mediaManager.getRenderedMedia(b, 1.0);
    restoreCanvas();
  });

  it("releases pins so a page that scrolls away becomes evictable again", async () => {
    const restoreCanvas = stubCanvas();
    loadPdfPage.mockResolvedValue(makePdfPage(1200, 1697));
    const a = { id: "pa", type: "pdf-page", fileId: "f1", pageIndex: 1, width: 1200 };

    await mediaManager.getRenderedMedia(a, 1.0);
    mediaManager.setPinnedRenderKeys([mediaManager.getRenderCacheKey(a, 1.0)]);
    // A scrolls out of view: the next frame pins a different set.
    mediaManager.setPinnedRenderKeys([]);

    for (let i = 0; i < 20; i++) {
      await mediaManager.getRenderedMedia(
        { id: `filler${i}`, type: "pdf-page", fileId: "f1", pageIndex: i + 10, width: 1200 },
        1.0,
      );
    }
    await Promise.resolve();

    loadPdfPage.mockClear();
    await mediaManager.getRenderedMedia(a, 1.0);
    // No longer pinned, so it was free to be evicted under budget pressure.
    // A permanent pin would leak budget for every page ever displayed.
    expect(loadPdfPage).toHaveBeenCalledTimes(1);
    restoreCanvas();
  });
});

describe("per-page render scale cap", () => {
  it("clamps the render scale so one page cannot exceed its share of the budget", async () => {
    const restoreCanvas = stubCanvas();
    const page = makePdfPage(595, 842); // A4 at natural size
    loadPdfPage.mockResolvedValue(page);
    const item = { id: "big", type: "pdf-page", fileId: "f1", pageIndex: 1, width: 1200 };

    // Deep zoom: unclamped this asks for a bitmap of hundreds of MB, which alone
    // exceeds the whole cache and makes coexistence with any neighbour impossible.
    await mediaManager.getRenderedMedia(item, 8);

    const renderScale = page.getViewport.mock.calls.at(-1)[0].scale;
    const bytes = 595 * renderScale * (842 * renderScale) * 4;
    // A third of the 96MB budget, so three visible pages still fit at once.
    expect(bytes).toBeLessThanOrEqual((96 * 1024 * 1024) / 3);
    restoreCanvas();
  });

  it("leaves ordinary zoom levels unclamped", async () => {
    const restoreCanvas = stubCanvas();
    const page = makePdfPage(595, 842);
    loadPdfPage.mockResolvedValue(page);
    const item = { id: "normal", type: "pdf-page", fileId: "f1", pageIndex: 1 };

    await mediaManager.getRenderedMedia(item, 2);

    // The cap must not degrade sharpness at scales that comfortably fit.
    expect(page.getViewport).toHaveBeenLastCalledWith({ scale: 2 });
    restoreCanvas();
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

  it("propagates the error when the file is missing from storage", async () => {
    // A missing file is typically transient during sync — the binary simply has
    // not landed yet — so callers must see the failure and be able to retry.
    getFile.mockResolvedValue(null);
    const item = { id: "m1", type: "image", fileId: "missing" };
    await expect(mediaManager.getRenderedMedia(item)).rejects.toThrow("Image file not found");
  });
});
