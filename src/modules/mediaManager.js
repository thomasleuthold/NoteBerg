import { loadPdfPage } from "./pdfManager.js";
import { getFile } from "./storage.js";

// Cache for rendered images/canvases to prevent expensive re-rendering
// Key: `${itemId}-${scale}`
const renderCache = new Map();

/**
 * Gets a renderable image (Canvas or ImageBitmap) for a media item.
 * Handles caching automatically.
 * @param {Object} item - The media item from note data
 * @param {number} scale - The render scale (default 1.0)
 * @returns {Promise<HTMLCanvasElement|ImageBitmap|null>}
 */
export async function getRenderedMedia(item, scale = 1.0) {
  // Round scale to avoid cache fragmentation (e.g., 1.0, 1.5, 2.0)
  const effectiveScale = Math.max(1.0, Math.ceil(scale * 2) / 2);
  const cacheKey = `${item.id}-${effectiveScale}`;

  if (renderCache.has(cacheKey)) {
    return renderCache.get(cacheKey);
  }

  let result = null;
  try {
    if (item.type === "pdf-page") {
      result = await renderPdfPage(item, effectiveScale);
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

async function renderPdfPage(item, scale) {
  const page = await loadPdfPage(item.pdfId, item.pageIndex);

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

/**
 * Clear cache for a specific item or all
 */
export function clearMediaCache(itemId = null) {
  if (itemId) {
    // Clear all scales for this item
    for (const key of renderCache.keys()) {
      if (key.startsWith(`${itemId}-`)) {
        renderCache.delete(key);
      }
    }
  } else {
    renderCache.clear();
  }
}
