import { loadPdfPage } from "./pdfManager.js";
import { getFile } from "./storage.js";
import { getPdfInvertDarkMode, getTheme } from "./theme.js";

// Cache for rendered images/canvases to prevent expensive re-rendering.
// Key: `${itemId}-${scale}` (plus "-inverted"), value: the in-flight *Promise*.
//
// Caching the promise rather than the resolved bitmap is what makes concurrent
// callers safe: two overlapping requests for the same page+scale (trivially
// produced by pinch-zooming a long scanned PDF, where each zoom step re-enters
// _drawPdfPage before the previous render settled) would otherwise both run a
// full pdf.js render and both write the key — orphaning one large canvas that
// is still referenced by item.renderable. On a low-end Android WebView those
// orphans are megabytes each and the renderer process gets OOM-killed, which
// presents as the app simply closing. Same pattern pdfManager.getPdfDocument
// already uses for document loads.
//
// Insertion order is the LRU order: Map preserves it, and a cache hit re-inserts
// the key to mark it fresh.
const renderCache = new Map();

// Bounds the cache so rapid zoom in/out (each half-step is a distinct scale, and
// each scale is a full-page bitmap) cannot grow without limit.
//
// Bounded by BYTES, not entry count: page bitmaps vary by two orders of
// magnitude across the zoom range (a 1200x1697 page is ~7.8MB at scale 1 but
// ~124MB at scale 4), so any fixed entry count is either uselessly loose at high
// zoom or wastefully tight at low zoom. 96MB is chosen to sit well under the
// per-process budget of a low-end Android WebView, which must also hold the
// renderer's own buffer bitmap (itself tens of MB) and the decoded PDF.
const MAX_CACHE_BYTES = 96 * 1024 * 1024;

// A safety net independent of size, so a pathological run of tiny bitmaps cannot
// grow the Map unboundedly.
const MAX_CACHE_ENTRIES = 24;

/**
 * Approximate the memory a rendered bitmap holds, in bytes (4 bytes per pixel).
 * @param {HTMLCanvasElement|ImageBitmap|HTMLImageElement|null} renderable
 * @returns {number}
 */
function renderableBytes(renderable) {
  if (!renderable) return 0;
  return (renderable.width || 0) * (renderable.height || 0) * 4;
}

/**
 * Release the backing store of a rendered bitmap.
 *
 * Only ever called on a value the cache has already dropped, so no live drawing
 * path can still hold it. Zeroing a canvas that is still referenced elsewhere
 * makes drawImage throw InvalidStateError, which is why disposal is confined to
 * this module rather than done by callers.
 * @param {HTMLCanvasElement|ImageBitmap|HTMLImageElement|null} renderable
 */
function disposeRenderable(renderable) {
  if (!renderable) return;
  if (typeof renderable.close === "function") {
    // ImageBitmap: frees GPU memory immediately rather than at GC time.
    renderable.close();
  } else if (renderable instanceof HTMLCanvasElement) {
    // Canvas: resizing to 0 drops the backing store. Guarded to canvases only —
    // an HTMLImageElement has a writable width/height that does NOT free memory
    // and would corrupt the element for any other holder.
    renderable.width = 0;
    renderable.height = 0;
  }
}

// Resolved byte size per cache key, so eviction can weigh entries without
// awaiting each promise. Kept strictly in step with renderCache.
const cacheSizes = new Map();

/** Total resolved bytes currently held by the cache. */
function totalCacheBytes() {
  let total = 0;
  for (const bytes of cacheSizes.values()) total += bytes;
  return total;
}

/**
 * Drop a single key and release its bitmap once it settles.
 * The entry is removed from the cache first, so a late-arriving consumer can
 * never pick up a disposed bitmap.
 */
function dropKey(key) {
  const entry = renderCache.get(key);
  renderCache.delete(key);
  cacheSizes.delete(key);
  Promise.resolve(entry)
    .then(disposeRenderable)
    .catch(() => {});
}

/**
 * Evict least-recently-used entries until the cache is within both bounds.
 * `protectedKey` is never evicted — it is the render the current caller is about
 * to return, and disposing it would hand back a zero-sized bitmap.
 */
function evictIfNeeded(protectedKey) {
  while (renderCache.size > MAX_CACHE_ENTRIES || totalCacheBytes() > MAX_CACHE_BYTES) {
    // Oldest first (Map preserves insertion order; a hit re-inserts).
    let victim;
    for (const key of renderCache.keys()) {
      if (key !== protectedKey) {
        victim = key;
        break;
      }
    }
    // Only the protected entry remains — nothing further can be freed.
    if (victim === undefined) return;
    dropKey(victim);
  }
}

/**
 * Clears cached renderables for a specific item (all scales) and releases them.
 * Call this when releasing item memory to prevent returning stale/closed resources.
 * @param {string} itemId - The item ID to clear from cache
 */
export function clearRenderCache(itemId) {
  for (const key of [...renderCache.keys()]) {
    if (key.startsWith(`${itemId}-`)) {
      dropKey(key);
    }
  }
}

/**
 * Gets a renderable image (Canvas or ImageBitmap) for a media item.
 * Handles caching automatically.
 * @param {Object} item - The media item from note data
 * @param {number} scale - The render scale (default 1.0)
 * @param {Object} [options]
 * @param {boolean} [options.invertForDarkTheme] - For pdf-page items, invert the
 *   rendered bitmap when the app theme is dark and the user has the "invert PDF
 *   pages in dark mode" preference enabled, so the (always white) PDF page reads
 *   as dark and the dark-mode stroke palette stays legible when annotating on
 *   top. Only the live editor canvas opts in — thumbnails/snapshots and PDF
 *   export intentionally render the page as-is.
 * @returns {Promise<HTMLCanvasElement|ImageBitmap|null>}
 */
export async function getRenderedMedia(item, scale = 1.0, options = {}) {
  const { invertForDarkTheme = false } = options;
  const invert =
    invertForDarkTheme &&
    item.type === "pdf-page" &&
    getTheme() === "dark" &&
    getPdfInvertDarkMode();

  // Round scale to avoid cache fragmentation (e.g., 1.0, 1.5, 2.0)
  const effectiveScale = Math.max(1.0, Math.ceil(scale * 2) / 2);
  // Inversion state must be part of the cache key — otherwise a call with
  // invertForDarkTheme:false (e.g. a thumbnail) could serve a bitmap that was
  // inverted for a different caller (e.g. the editor canvas), or vice versa.
  const cacheKey = `${item.id}-${effectiveScale}${invert ? "-inverted" : ""}`;

  if (renderCache.has(cacheKey)) {
    const cached = renderCache.get(cacheKey);
    // Re-insert to mark as most-recently-used (Map keeps insertion order).
    const bytes = cacheSizes.get(cacheKey);
    renderCache.delete(cacheKey);
    cacheSizes.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    if (bytes !== undefined) cacheSizes.set(cacheKey, bytes);
    return cached;
  }

  const renderPromise = (async () => {
    if (item.type === "pdf-page") {
      return await renderPdfPage(item, effectiveScale, invert);
    }
    if (item.type === "image") {
      return await renderImage(item);
    }
    return null;
  })();

  // Publish the in-flight promise before awaiting it, so a concurrent caller
  // for the same key joins this render instead of starting a second one.
  renderCache.set(cacheKey, renderPromise);

  let result = null;
  try {
    result = await renderPromise;
  } catch (error) {
    console.error(`Failed to render media item ${item.id}:`, error);
    // Drop the failed entry so callers can retry (e.g. once a PDF finishes
    // syncing). Guarded by identity: a clearRenderCache() during the await may
    // already have replaced this key, and we must not evict a newer render.
    if (renderCache.get(cacheKey) === renderPromise) {
      renderCache.delete(cacheKey);
      cacheSizes.delete(cacheKey);
    }
    return null;
  }

  // Identity guard: clearRenderCache() may have dropped this key while we were
  // awaiting. Re-registering its size here would leak a phantom size entry and
  // let eviction under-count the cache forever.
  const stillCached = renderCache.get(cacheKey) === renderPromise;

  if (result && stillCached) {
    cacheSizes.set(cacheKey, renderableBytes(result));
    // Never evict the entry we are about to hand back.
    evictIfNeeded(cacheKey);
  } else if (!result && stillCached) {
    // Unknown item type resolved to null — don't hold the key.
    renderCache.delete(cacheKey);
    cacheSizes.delete(cacheKey);
  }

  return result;
}

async function renderPdfPage(item, scale, invert) {
  const page = await loadPdfPage(item.fileId, item.pageIndex);

  // Calculate PDF render scale to match item dimensions at current zoom
  // We need the natural dimensions to calculate the ratio
  const unscaledViewport = page.getViewport({ scale: 1.0 });

  // Avoid division by zero
  const baseWidth = unscaledViewport.width || 595;

  // If item.width is defined, we use it to determine the scale.
  // Otherwise we default to 1.0 * scale.
  const pdfScale = item.width ? (item.width * scale) / baseWidth : scale;

  const viewport = page.getViewport({ scale: pdfScale });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Invert the rendered page once (cached), rather than per-frame via
  // ctx.filter on every drawImage, which would add measurable cost during
  // scroll. hue-rotate(180deg) after invert() keeps colored PDF content
  // looking roughly natural instead of a pure photo negative.
  if (invert) {
    const invertedCanvas = document.createElement("canvas");
    invertedCanvas.width = canvas.width;
    invertedCanvas.height = canvas.height;
    const invertedCtx = invertedCanvas.getContext("2d");
    invertedCtx.filter = "invert(1) hue-rotate(180deg)";
    invertedCtx.drawImage(canvas, 0, 0);
    return invertedCanvas;
  }

  return canvas;
}

async function renderImage(item) {
  const blob = await getFile(item.fileId);
  if (!blob) throw new Error("Image file not found");

  const img = new Image();
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}
