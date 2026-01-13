/**
 * Note Rendering Utilities
 * Shared rendering functions for notes (strokes, background, text)
 * Used by both the editor and preview components
 */

import { getTheme } from "../modules/theme.js";

/**
 * Get color palette for current theme
 * @returns {string[]} Array of color hex values
 */
export function getThemePalette() {
  const theme = getTheme();

  if (theme === "dark") {
    return ["#ffffff", "#f87171", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#9ca3af", "#fde047"];
  }

  if (theme === "epaper") {
    return ["#000000", "#800000", "#000080", "#006400", "#a52a2a", "#4b0082", "#2f4f4f", "#5d4037"];
  }

  // Light theme (default)
  return ["#000000", "#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#6b7280", "#78350f"];
}

/**
 * Draw a single stroke on a canvas context
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Object} stroke - Stroke data with x, y, width, color/colorIndex
 * @param {string[]|null} palette - Optional color palette (will use theme palette if not provided)
 * @param {boolean} isSelected - Whether the stroke is selected (for highlighting)
 */
export function drawStroke(ctx, stroke, palette = null, isSelected = false) {
  if (!ctx || !stroke.x || stroke.x.length < 2) return;

  const colors = palette || getThemePalette();
  const pointCount = stroke.x.length;

  if (isSelected) {
    ctx.strokeStyle = "rgba(0, 100, 255, 0.7)"; // Highlight color
    ctx.lineWidth = (stroke.width || 2) + 4; // Make it thicker
  } else {
    ctx.strokeStyle =
      stroke.colorIndex !== undefined ? colors[stroke.colorIndex] : stroke.color || colors[0];
    ctx.lineWidth = stroke.width || 2;
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(stroke.x[0], stroke.y[0]);

  if (pointCount === 2) {
    ctx.lineTo(stroke.x[1], stroke.y[1]);
  } else {
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
  ctx.stroke();

  // If selected, draw the actual stroke on top of the highlight
  if (isSelected) {
    ctx.strokeStyle =
      stroke.colorIndex !== undefined ? colors[stroke.colorIndex] : stroke.color || colors[0];
    ctx.lineWidth = stroke.width || 2;
    ctx.stroke();
  }
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
      for (let y = Math.max(20, startY); y < height; y += 20) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      break;

    case "ruled-medium":
      // Draw horizontal lines every 30px
      for (let y = Math.max(30, startY); y < height; y += 30) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      break;

    case "ruled-wide":
      // Draw horizontal lines every 40px
      for (let y = Math.max(40, startY); y < height; y += 40) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      break;

    case "grid-small":
      // Draw grid with 20px squares
      for (let y = Math.max(20, startY); y < height; y += 20) {
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
      for (let y = Math.max(30, startY); y < height; y += 30) {
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
      for (let y = Math.max(40, startY); y < height; y += 40) {
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
export function renderNotePreview(canvas, note, options = {}) {
  const { padding = 10, fullSize = false } = options;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  // For full-size rendering, use fixed 800x600 dimensions
  const canvasWidth = fullSize ? 800 : rect.width;
  const canvasHeight = fullSize ? 600 : rect.height;

  canvas.width = canvasWidth * dpr;
  canvas.height = canvasHeight * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  // Clear canvas
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  // Draw background pattern if exists
  if (note.background && note.background !== "none") {
    drawBackgroundPattern(ctx, note.background, canvasWidth, canvasHeight);
  }

  // Draw strokes if they exist
  if (note.strokes && note.strokes.length > 0) {
    const palette = getThemePalette();

    if (fullSize) {
      // Render at actual positions (like the editor does)
      note.strokes.forEach((stroke) => {
        drawStroke(ctx, stroke, palette);
      });
    } else {
      // Scale to fit (legacy behavior for non-full-size previews)
      const bounds = getStrokeBounds(note.strokes);
      if (bounds) {
        const availableWidth = canvasWidth - padding * 2;
        const availableHeight = canvasHeight - padding * 2;
        const scaleX = availableWidth / Math.max(1, bounds.width);
        const scaleY = availableHeight / Math.max(1, bounds.height);
        const scale = Math.min(scaleX, scaleY);

        // Calculate centered offset to position the scaled content
        const scaledWidth = bounds.width * scale;
        const scaledHeight = bounds.height * scale;
        const offsetX = padding + (availableWidth - scaledWidth) / 2 - bounds.minX * scale;
        const offsetY = padding + (availableHeight - scaledHeight) / 2 - bounds.minY * scale;

        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);

        note.strokes.forEach((stroke) => {
          drawStroke(ctx, stroke, palette);
        });

        ctx.restore();
      }
    }
  }
}
