import { loadPdfPage } from "./pdfManager.js";
import { getFile } from "./storage.js";
import { getPdfInvertDarkMode, getTheme } from "./theme.js";

// Cache for rendered images/canvases to prevent expensive re-rendering
// Key: `${itemId}-${scale}`
const renderCache = new Map();

/**
 * Clears cached renderables for a specific item (all scales).
 * Call this when releasing item memory to prevent returning stale/closed resources.
 * @param {string} itemId - The item ID to clear from cache
 */
export function clearRenderCache(itemId) {
  for (const key of renderCache.keys()) {
    if (key.startsWith(`${itemId}-`)) {
      renderCache.delete(key);
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
    return renderCache.get(cacheKey);
  }

  let result = null;
  try {
    if (item.type === "pdf-page") {
      result = await renderPdfPage(item, effectiveScale, invert);
    } else if (item.type === "image") {
      result = await renderImage(item);
    }
  } catch (error) {
    console.error(`Failed to render media item ${item.id}:`, error);
    return null;
  }

  if (result) {
    renderCache.set(cacheKey, result);
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
