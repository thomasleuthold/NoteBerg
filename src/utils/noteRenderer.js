/**
 * Note Rendering Utilities
 * Shared rendering functions for notes (strokes, background, text)
 * Used by both the editor and preview components
 */

import { getTheme } from "../modules/theme.js";

export const MARKER_ALPHA = 0.3;

/**
 * Get color palette for current theme (15 colors)
 * @returns {string[]} Array of color hex values
 */
export function getThemePalette() {
  const theme = getTheme();

  if (theme === "dark") {
    // Dark theme: white first, then colors visible on dark backgrounds
    return [
      "#ffffff",
      "#ff7272",
      "#7cb7ff",
      "#38ffb6",
      "#ffec46",
      "#fc9e51",
      "#b39bfc",
      "#f472b6",
      "#2dd4bf",
      "#a3e635",
      "#e879f9",
      "#38bdf8",
      "#facc15",
      "#9ca3af",
      "#fcb58c",
    ];
  }

  // Light theme (default): black first, then colors visible on light backgrounds
  return [
    "#000000",
    "#ef4444",
    "#3b82f6",
    "#10b981",
    "#f59e0b",
    "#8b5cf6",
    "#f97316",
    "#ec4899",
    "#14b8a6",
    "#84cc16",
    "#d946ef",
    "#0ea5e9",
    "#eab308",
    "#6b7280",
    "#78350f",
  ];
}

/**
 * Get color palette for marker pens (pale/bright colors)
 * @returns {string[]} Array of color hex values
 */
export function getMarkerPalette() {
  const theme = getTheme();

  if (theme === "dark") {
    return [
      "#f8f0b0",
      "#c4f7d6",
      "#f7d4ad",
      "#cadff8",
      "#fcd4ea",
      "#ead8fd",
      "#fcdada",
      "#ffd06b",
      "#d8fdee",
      "#cccccc",
    ];
  }

  return [
    "#faeb79",
    "#9dfabd",
    "#f8ca94",
    "#a5caf7",
    "#fda3d6",
    "#d0a9fa",
    "#ff7b7b",
    "#e6af3a",
    "#affcdd",
    "#6e6e6e",
  ];
}

/**
 * Draw a single stroke on a canvas context
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} stroke - Stroke data with x, y, width, color/colorIndex
 * @param {string[]|null} palette - Optional color palette (will use theme palette if not provided)
 * @param {boolean} isSelected - Whether the stroke is selected (for highlighting)
 * @param {boolean} fastMode - Skip pressure rendering for performance (use during scroll)
 */
export function drawStroke(ctx, stroke, palette = null, isSelected = false, fastMode = false) {
  if (!ctx || !stroke.x || stroke.x.length < 2) return;

  const isMarker = stroke.type === "marker";
  // Use marker palette if it's a marker, otherwise use provided palette or theme palette
  const colors = isMarker ? getMarkerPalette() : palette || getThemePalette();

  const baseWidth = stroke.width || 2;
  const color =
    stroke.colorIndex !== undefined ? colors[stroke.colorIndex] : stroke.color || colors[0];

  if (isSelected) {
    ctx.save();
    ctx.strokeStyle = "rgba(0, 100, 255, 0.7)"; // Highlight color
    ctx.lineWidth = baseWidth + 4; // Make it thicker
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    drawSimplePath(ctx, stroke);
    ctx.stroke();
    ctx.restore();
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;

  // Apply transparency for markers
  if (isMarker) {
    ctx.globalAlpha = MARKER_ALPHA;
  }

  // Check for pressure data (skip in fast mode for scroll performance)
  // Also skip pressure for markers to avoid alpha stacking artifacts (overlapping segments)
  const usePressure =
    !fastMode && !isMarker && stroke.pressure && stroke.pressure.length === stroke.x.length;

  if (usePressure) {
    drawPressurePath(ctx, stroke, baseWidth);
  } else {
    ctx.lineWidth = baseWidth;
    ctx.beginPath();
    drawSimplePath(ctx, stroke);
    ctx.stroke();
  }

  // Reset alpha
  if (isMarker) {
    ctx.globalAlpha = 1.0;
  }
}

function drawSimplePath(ctx, stroke) {
  const pointCount = stroke.x.length;
  ctx.moveTo(stroke.x[0], stroke.y[0]);

  if (pointCount === 2) {
    ctx.lineTo(stroke.x[1], stroke.y[1]);
    return;
  }

  for (let i = 1; i < pointCount - 1; i++) {
    const xc = (stroke.x[i] + stroke.x[i + 1]) / 2;
    const yc = (stroke.y[i] + stroke.y[i + 1]) / 2;
    ctx.quadraticCurveTo(stroke.x[i], stroke.y[i], xc, yc);
  }

  const lastIdx = pointCount - 1;
  const secondLastIdx = pointCount - 2;
  ctx.quadraticCurveTo(
    stroke.x[secondLastIdx],
    stroke.y[secondLastIdx],
    stroke.x[lastIdx],
    stroke.y[lastIdx],
  );
}

/**
 * Draw a pressure-sensitive path with batched segments.
 * Groups consecutive segments with similar pressure into single paths
 * to reduce canvas API calls from O(N) to O(pressure_changes).
 */
function drawPressurePath(ctx, stroke, baseWidth) {
  const x = stroke.x;
  const y = stroke.y;
  const p = stroke.pressure;
  const pointCount = x.length;

  // Map pressure (0.0-1.0) to width multiplier (0.5-1.5)
  const getWidth = (pressure) => Math.max(0.5, baseWidth * (0.5 + pressure));

  if (pointCount === 2) {
    ctx.beginPath();
    ctx.lineWidth = getWidth((p[0] + p[1]) / 2);
    ctx.moveTo(x[0], y[0]);
    ctx.lineTo(x[1], y[1]);
    ctx.stroke();
    return;
  }

  // Threshold for "similar enough" pressure (relative to baseWidth)
  // This batches segments together, reducing beginPath/stroke calls
  const PRESSURE_THRESHOLD = 0.08;

  let currentWidth = getWidth(p[0]);

  ctx.beginPath();
  ctx.lineWidth = currentWidth;
  ctx.moveTo(x[0], y[0]);

  for (let i = 1; i < pointCount; i++) {
    const targetWidth = getWidth(p[i]);
    const widthDiff = Math.abs(targetWidth - currentWidth) / baseWidth;

    // Check if pressure changed significantly (start new batch)
    const shouldStartNewBatch = widthDiff > PRESSURE_THRESHOLD && i < pointCount - 1;

    if (shouldStartNewBatch) {
      // Draw curve to midpoint before starting new batch
      const xc = (x[i - 1] + x[i]) / 2;
      const yc = (y[i - 1] + y[i]) / 2;
      ctx.quadraticCurveTo(x[i - 1], y[i - 1], xc, yc);

      // Finish current batch
      ctx.stroke();

      // Start new batch
      ctx.beginPath();
      ctx.lineWidth = targetWidth;
      currentWidth = targetWidth;

      // Continue from midpoint
      ctx.moveTo(xc, yc);
    } else if (i === pointCount - 1) {
      // Last point - draw final segment
      ctx.quadraticCurveTo(x[i - 1], y[i - 1], x[i], y[i]);
    } else {
      // Continue building path - draw curve to midpoint
      const xc = (x[i] + x[i + 1]) / 2;
      const yc = (y[i] + y[i + 1]) / 2;
      ctx.quadraticCurveTo(x[i], y[i], xc, yc);
    }
  }

  // Finish final batch
  ctx.stroke();
}

/**
 * Draw background pattern on a canvas
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {string} backgroundType - Type of background (ruled-narrow, ruled-medium, ruled-wide, grid-small, grid-medium, grid-large, none)
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @param {number} startY - Starting Y coordinate (for partial redraws)
 */
export function drawBackgroundPattern(ctx, backgroundType, width, height, startY = 0) {
  if (!ctx || backgroundType === "none") return;

  // Get pattern color from CSS variable
  let patternColor;
  if (backgroundType.startsWith("ruled")) {
    patternColor =
      getComputedStyle(document.documentElement).getPropertyValue("--pattern-rule-color").trim() ||
      "#e5e7eb";
  } else {
    patternColor =
      getComputedStyle(document.documentElement).getPropertyValue("--pattern-grid-color").trim() ||
      "#e5e7eb";
  }

  ctx.strokeStyle = patternColor;
  ctx.lineWidth = 1;
  ctx.beginPath();

  switch (backgroundType) {
    case "ruled-narrow":
      // Draw horizontal lines every 20px
      for (let y = Math.max(20, Math.ceil(startY / 20) * 20); y < height; y += 20) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      break;

    case "ruled-medium":
      // Draw horizontal lines every 30px
      for (let y = Math.max(30, Math.ceil(startY / 30) * 30); y < height; y += 30) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      break;

    case "ruled-wide":
      // Draw horizontal lines every 40px
      for (let y = Math.max(40, Math.ceil(startY / 40) * 40); y < height; y += 40) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      break;

    case "grid-small":
      // Draw grid with 20px squares
      for (let y = Math.max(20, Math.ceil(startY / 20) * 20); y < height; y += 20) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      for (let x = 20; x < width; x += 20) {
        ctx.moveTo(x, startY);
        ctx.lineTo(x, height);
      }
      break;

    case "grid-medium":
      // Draw grid with 30px squares
      for (let y = Math.max(30, Math.ceil(startY / 30) * 30); y < height; y += 30) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      for (let x = 30; x < width; x += 30) {
        ctx.moveTo(x, startY);
        ctx.lineTo(x, height);
      }
      break;

    case "grid-large":
      // Draw grid with 40px squares
      for (let y = Math.max(40, Math.ceil(startY / 40) * 40); y < height; y += 40) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      for (let x = 40; x < width; x += 40) {
        ctx.moveTo(x, startY);
        ctx.lineTo(x, height);
      }
      break;
  }

  ctx.stroke();
}

/**
 * Calculate bounding box for strokes
 * @param {Array} strokes - Array of stroke objects
 * @returns {Object|null} Bounding box with minX, maxX, minY, maxY, width, height
 */
export function getStrokeBounds(strokes) {
  if (!strokes || strokes.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let hasPoints = false;

  strokes.forEach((stroke) => {
    if (!stroke.x || stroke.x.length === 0) return;
    hasPoints = true;
    for (let i = 0; i < stroke.x.length; i++) {
      minX = Math.min(minX, stroke.x[i]);
      maxX = Math.max(maxX, stroke.x[i]);
      minY = Math.min(minY, stroke.y[i]);
      maxY = Math.max(maxY, stroke.y[i]);
    }
    const w = (stroke.width || 2) / 2;
    minX -= w;
    maxX += w;
    minY -= w;
    maxY += w;
  });

  if (!hasPoints) return null;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Render note preview on a canvas
 * Renders background pattern and strokes at their actual positions, scaled to fit
 * Text is rendered separately as HTML overlay in the overview component
 *
 * @param {HTMLCanvasElement} canvas - Canvas element for the preview
 * @param {Object} note - Note data with strokes, background, content
 * @param {Object} options - Rendering options
 * @param {number} options.padding - Padding around content (default: 10)
 * @param {boolean} options.fullSize - Render at full editor size (800x600) without fitting (default: false)
 * @param {boolean} options.showTextIndicator - Unused (kept for compatibility)
 */
// Content coordinate space width — matches CanvasRenderer.maxContentWidth
const CONTENT_WIDTH = 1200;

export function renderNotePreview(canvas, note, options = {}) {
  const { padding = 10, fullSize = false } = options;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const canvasWidth = fullSize ? 360 : rect.width;
  const canvasHeight = fullSize ? 500 : rect.height;

  canvas.width = canvasWidth * dpr;
  canvas.height = canvasHeight * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Fill solid background (prevents black on JPEG-encoded thumbnails)
  const isDark = getTheme() === "dark";
  ctx.fillStyle = isDark ? "#1e1e2e" : "#ffffff";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  if (fullSize) {
    // Render at content scale: 1200px content → canvasWidth px display
    const scale = canvasWidth / CONTENT_WIDTH;
    const contentHeight = canvasHeight / scale;

    if (note.background && note.background !== "none") {
      drawBackgroundPattern(ctx, note.background, CONTENT_WIDTH, contentHeight, 0);
    }

    if (note.strokes && note.strokes.length > 0) {
      const palette = getThemePalette();
      ctx.save();
      ctx.scale(scale, scale);
      note.strokes.forEach((stroke) => {
        if (!stroke._deleted && !stroke.isDeleted) drawStroke(ctx, stroke, palette);
      });
      ctx.restore();
    }
  } else {
    // Compact fit-to-bounds for small previews
    if (note.background && note.background !== "none") {
      drawBackgroundPattern(ctx, note.background, canvasWidth, canvasHeight);
    }

    if (note.strokes && note.strokes.length > 0) {
      const palette = getThemePalette();
      const bounds = getStrokeBounds(note.strokes);
      if (bounds) {
        const availableWidth = canvasWidth - padding * 2;
        const availableHeight = canvasHeight - padding * 2;
        const scaleX = availableWidth / Math.max(1, bounds.width);
        const scaleY = availableHeight / Math.max(1, bounds.height);
        const scale = Math.min(scaleX, scaleY);
        const offsetX = padding + (availableWidth - bounds.width * scale) / 2 - bounds.minX * scale;
        const offsetY =
          padding + (availableHeight - bounds.height * scale) / 2 - bounds.minY * scale;

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        note.strokes.forEach((stroke) => {
          if (!stroke._deleted && !stroke.isDeleted) drawStroke(ctx, stroke, palette);
        });
        ctx.restore();
      }
    }
  }
}

/**
 * Walk a laid-out text editor element and return draw commands for the thumbnail canvas.
 * Requires editorElement to be in the DOM and visible.
 */
function snapshotTextLayout(editorElement, thumbWidth, thumbHeight, dpr) {
  const maxContentWidth = 1200;
  const thumbScale = thumbWidth / maxContentWidth;
  const contentHeight = thumbHeight / thumbScale;
  const editorZoom = 1.0; // overview always renders at zoom=1
  const draws = [];

  try {
    const editorRect = editorElement.getBoundingClientRect();
    if (editorRect.width === 0 && editorRect.height === 0) return draws;

    const walker = document.createTreeWalker(editorElement, NodeFilter.SHOW_TEXT);
    const range = document.createRange();

    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const text = textNode.textContent;
      if (!text.trim()) continue;
      const el = textNode.parentElement;
      if (!el) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;

      range.selectNode(textNode);
      const rects = range.getClientRects();
      if (!rects.length) continue;

      const screenFontSize = parseFloat(cs.fontSize) || 16;
      const thumbFontSize = (screenFontSize / editorZoom) * thumbScale * dpr;
      const font = `${cs.fontStyle} ${cs.fontWeight} ${thumbFontSize.toFixed(2)}px ${cs.fontFamily}`;
      const color = cs.color;

      for (const rect of rects) {
        const contentX = (rect.left - editorRect.left) / editorZoom;
        const contentY = (rect.top - editorRect.top) / editorZoom;
        if (contentY > contentHeight) continue;
        draws.push({
          type: "text",
          text,
          font,
          color,
          tx: contentX * thumbScale * dpr,
          ty: (contentY + rect.height * 0.85) * thumbScale * dpr,
        });
      }
    }

    for (const cell of editorElement.querySelectorAll("td, th")) {
      const cs = window.getComputedStyle(cell);
      const rect = cell.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      const contentX = (rect.left - editorRect.left) / editorZoom;
      const contentY = (rect.top - editorRect.top) / editorZoom;
      if (contentY > contentHeight) continue;
      const bw = parseFloat(cs.borderTopWidth) || 0;
      if (bw <= 0) continue;
      // Fall back to a visible color when the computed border color is transparent
      // (happens when the ghost div is outside the full CSS cascade for --border-color vars).
      const borderColor = cs.borderTopColor === "rgba(0, 0, 0, 0)" ? "#cccccc" : cs.borderTopColor;
      draws.push({
        type: "rect",
        x: contentX * thumbScale * dpr,
        y: contentY * thumbScale * dpr,
        w: (rect.width / editorZoom) * thumbScale * dpr,
        h: (rect.height / editorZoom) * thumbScale * dpr,
        color: borderColor,
        lineWidth: Math.max(0.5, (bw / editorZoom) * thumbScale * dpr),
      });
    }
  } catch (e) {
    console.warn("[noteRenderer] text snapshot failed:", e);
  }
  return draws;
}

function drawTextSnapshot(ctx, draws) {
  for (const cmd of draws) {
    if (cmd.type === "rect") {
      ctx.strokeStyle = cmd.color;
      ctx.lineWidth = cmd.lineWidth;
      ctx.strokeRect(cmd.x, cmd.y, cmd.w, cmd.h);
    } else {
      ctx.font = cmd.font;
      ctx.fillStyle = cmd.color;
      ctx.fillText(cmd.text, cmd.tx, cmd.ty);
    }
  }
}

/**
 * Render a high-quality note snapshot into a canvas.
 * Layers (in order): background fill → background pattern → media (images + first PDF page)
 *                    → strokes → text.
 *
 * @param {HTMLCanvasElement} canvas - Target canvas
 * @param {Object} note - Full note object (strokes, background, content HTML, media array)
 */
export async function renderNoteSnapshot(canvas, note) {
  const dpr = window.devicePixelRatio || 1;
  const thumbWidth = 360;
  const thumbHeight = 500;
  const maxContentWidth = 1200;
  const scale = thumbWidth / maxContentWidth;
  const contentHeight = thumbHeight / scale;

  canvas.width = thumbWidth * dpr;
  canvas.height = thumbHeight * dpr;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.scale(dpr, dpr);

  // 1. Background fill + pattern (via CanvasRenderer for correct theme color + pattern rendering)
  // Dynamic import keeps pdfjs-dist out of the module graph for test environments.
  // CanvasRenderer requires a DOM element to mount its internal canvases; detached div satisfies it.
  const { CanvasRenderer } = await import("../components/NoteCanvas/CanvasRenderer.js");
  const detachedMount = document.createElement("div");
  const renderer = new CanvasRenderer(detachedMount, { maxContentWidth });

  // Set strokes empty for this pass — we draw them ourselves after media so z-order is correct.
  renderer.setData([], note.background || "none");
  renderer.renderSnapshot(ctx, thumbWidth, thumbHeight);
  renderer.destroy();

  // 2. Media: images and first PDF page (loaded async, drawn at content-space coordinates)
  if (Array.isArray(note.media) && note.media.length > 0) {
    const { getRenderedMedia } = await import("../modules/mediaManager.js");
    const visibleItems = note.media
      .filter((item) => !item.deleted && item.y < contentHeight)
      .sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));

    // Only render the first PDF page to keep load time reasonable
    let pdfPageRendered = false;

    await Promise.all(
      visibleItems.map(async (item) => {
        if (item.type === "pdf-page") {
          if (pdfPageRendered) return;
          pdfPageRendered = true;
        }
        const renderable = await getRenderedMedia(item, scale).catch(() => null);
        if (!renderable) return;

        ctx.save();
        ctx.scale(scale, scale);
        if (item.rotation) {
          const cx = item.x + item.width / 2;
          const cy = item.y + item.height / 2;
          ctx.translate(cx, cy);
          ctx.rotate((item.rotation * Math.PI) / 180);
          ctx.translate(-cx, -cy);
        }
        ctx.drawImage(renderable, item.x, item.y, item.width, item.height);
        ctx.restore();
      }),
    );
  }

  // 3. Strokes (drawn on top of media, same as in the editor)
  if (Array.isArray(note.strokes) && note.strokes.length > 0) {
    const palette = getThemePalette();
    ctx.save();
    ctx.scale(scale, scale);
    note.strokes.forEach((stroke) => {
      if (!stroke._deleted && !stroke.isDeleted) drawStroke(ctx, stroke, palette);
    });
    ctx.restore();
  }

  // 4. Text layer — inject HTML into a hidden off-screen element so the browser lays it out
  //    at 1200px width (the content coordinate space), then walk with getBoundingClientRect().
  if (note.content) {
    const ghost = document.createElement("div");
    ghost.className = "text-editor";
    // opacity:0 keeps the element invisible while still participating in layout
    // (visibility:hidden causes getBoundingClientRect to return zeros in some browsers).
    ghost.style.cssText =
      "position:fixed;left:0;top:-9999px;width:1200px;opacity:0;pointer-events:none;z-index:-1;";
    ghost.innerHTML = note.content;
    document.body.appendChild(ghost);
    try {
      drawTextSnapshot(ctx, snapshotTextLayout(ghost, thumbWidth, thumbHeight, dpr));
    } finally {
      document.body.removeChild(ghost);
    }
  }
}
