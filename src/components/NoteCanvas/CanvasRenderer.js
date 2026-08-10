/**
 * CanvasRenderer - Sliding buffer canvas with leapfrog technique
 *
 * Manages a canvas sized to 3x viewport height. Uses CSS translateY for
 * smooth scrolling within the buffer, and repositions + redraws when
 * scroll exceeds the safe zone (leapfrog).
 */

import { clearRenderCache, getRenderedMedia } from "../../modules/mediaManager.js";
import { getPdfInvertDarkMode, getTheme } from "../../modules/theme.js";
import {
  MARKER_ALPHA,
  drawBackgroundPattern as sharedDrawBackgroundPattern,
  drawStroke as sharedDrawStroke,
  getMarkerPalette as sharedGetMarkerPalette,
  getPressureWidth as sharedGetPressureWidth,
  getThemePalette as sharedGetThemePalette,
} from "../../utils/noteRenderer.js";
import {
  getMediaHandles,
  getSelectionHandles,
  MEDIA_HANDLE_SIZE,
  SELECTION_HANDLE_SIZE,
} from "./NoteCanvas.js";

// Highlight styles
const HIGHLIGHT_FILL_STYLE = "rgba(255, 255, 0, 0.3)";
const HIGHLIGHT_STROKE_STYLE = "rgba(255, 200, 0, 0.8)";
const HIGHLIGHT_LINE_WIDTH = 2;

/**
 * Draw a list of marker strokes onto ctx, grouping sub-strokes that share a
 * groupId into a single beginPath…stroke() call so their alpha doesn't stack.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} markerStrokes - Array of marker stroke objects
 * @param {string[]} palette - Pen palette, passed through to sharedDrawStroke for single-stroke groups
 * @param {Set<string>} [selectedIds] - Set of selected stroke IDs (for selection highlight)
 * @param {(stroke: object) => string[]} [getMarkerColorsForStroke] - Resolves the marker
 *   palette to use for a given stroke (defaults to the live theme marker palette).
 *   Lets callers use the light palette for strokes on an un-inverted PDF page.
 */
function drawMarkersGrouped(
  ctx,
  markerStrokes,
  palette,
  selectedIds = null,
  getMarkerColorsForStroke = null,
) {
  if (markerStrokes.length === 0) return;

  // Group by groupId, falling back to individual stroke id
  const groups = new Map(); // key -> stroke[]
  const groupOrder = [];
  for (const stroke of markerStrokes) {
    const key = stroke.groupId || stroke.id;
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key).push(stroke);
  }

  for (const key of groupOrder) {
    const group = groups.get(key);
    const first = group[0];
    const isSelected = selectedIds != null && group.some((s) => selectedIds.has(s.id));
    // All sub-strokes in a group share one drawn path/color; the group's first
    // stroke position decides which palette the whole group uses.
    const colors = getMarkerColorsForStroke
      ? getMarkerColorsForStroke(first)
      : sharedGetMarkerPalette();

    if (group.length === 1) {
      // Single stroke — delegate to shared draw (handles edge cases)
      sharedDrawStroke(ctx, first, palette, isSelected, false, colors);
    } else {
      // Multiple sub-strokes from the same original — draw as one flat-alpha path.
      // Selection underline pass (drawn at full opacity beneath the marker color).
      if (isSelected) {
        ctx.save();
        ctx.strokeStyle = "rgba(0, 100, 255, 0.7)";
        ctx.lineWidth = (first.width || 2) + 4;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        for (const s of group) {
          ctx.moveTo(s.x[0], s.y[0]);
          for (let i = 1; i < s.x.length; i++) {
            ctx.lineTo(s.x[i], s.y[i]);
          }
        }
        ctx.stroke();
        ctx.restore();
      }

      const color = first.colorIndex !== undefined ? colors[first.colorIndex] : colors[0];

      ctx.save();
      ctx.globalAlpha = MARKER_ALPHA;
      ctx.strokeStyle = color;
      ctx.lineWidth = first.width || 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (const s of group) {
        ctx.moveTo(s.x[0], s.y[0]);
        for (let i = 1; i < s.x.length; i++) {
          ctx.lineTo(s.x[i], s.y[i]);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

export class CanvasRenderer {
  /**
   * @param {HTMLElement} viewportElement - Element to mount canvas into
   * @param {Object} options
   * @param {number} options.maxContentWidth - Maximum content width (default 1200)
   */
  constructor(viewportElement, options = {}) {
    this.viewportElement = viewportElement;
    this.maxContentWidth = options.maxContentWidth || 1200;

    // Canvas elements
    this.canvas = null;
    this.ctx = null;
    this.overlayCanvas = null;
    this.overlayCtx = null;

    // Buffer state
    this.bufferTop = 0; // Current buffer Y position in content space
    this.bufferHeight = 0; // Total buffer height (3x viewport)
    this.bufferMultiplier = 3; // How many viewports the buffer covers

    // Viewport state
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.screenViewportWidth = 0; // Actual screen viewport width

    // Zoom state
    this.zoomScale = 1.0;
    this.resolutionScale = 1.0; // For crisp rendering at zoom > 1
    this.maxResolutionScale = 2.0; // Cap resolution scaling for memory

    // Content data
    this.strokes = [];
    this.background = "none";
    this.spatialIndex = null;
    this.mediaManager = null; // Reference to MediaManager
    this.palette = null;
    this.markerPalette = null;
    this.activeStroke = null; // Stroke currently being drawn
    this.selectedStrokeIndices = new Set();
    this.activeStrokeId = null; // ID of the stroke currently being drawn incrementally
    this._activeStrokeColor = null; // Resolved colour of activeStrokeId (see drawDirectStroke)
    this.selectedMediaId = null; // ID of selected media item
    this.lastDrawnPointIndex = 0; // Index of the last point processed in the active stroke
    this.selectionBounds = null;
    this.lineSeparators = []; // Y positions (content coords) of detected line separators
    this.lineIndentLevels = []; // indent level per line band (0 = base, 1 = indented)
    this.highlightRects = []; // Search term highlights
    this.showA4PageBreaks = false; // Show A4 page break lines when no PDF is imported

    // Content bounds
    this.contentWidth = 0;
    this.contentHeight = 0;

    // Scroll state for overlay drawing
    this.contentScrollTop = 0;
    this.contentScrollLeft = 0;

    // Performance tracking
    this.lastRenderTime = 0;

    // Zoom debounce
    this.zoomRenderTimeout = null;
    this.zoomRenderDebounce = 150; // ms

    // Quality rendering debounce (for scroll performance)
    // During scroll, render in fast mode (no pressure). After scroll stops, re-render with full quality.
    this._qualityRenderTimeout = null;
    this._qualityRenderDebounce = 150; // ms after scroll stops
    this._lastRenderWasFastMode = false;

    // PDF Loading Semaphore
    this.activePdfLoads = 0;
    this.maxConcurrentPdfLoads = 2;
    this._pdfQueueCheckTimeout = null;

    // Track if initial draw has happened
    this._needsInitialDraw = true;

    // Initialize
    this._createCanvas();
  }

  /**
   * Create the canvas element
   * @private
   */
  _createCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "sliding-buffer-canvas";

    // desynchronized: low-latency hint. Lets the compositor present ink without
    // waiting for the normal frame queue, which is the largest single source of
    // the gap between the stylus tip and the drawn preview stroke. Unsupported
    // browsers ignore the hint and render normally.
    // Not applied to the overlay: it clears and repaints a full path per move
    // (marker preview, lasso trail), where tearing would be visible. The buffer
    // only ever gets thin opaque segments appended, so tearing is not observable.
    this.ctx = this.canvas.getContext("2d", { desynchronized: true });
    this.viewportElement.appendChild(this.canvas);

    // Create overlay canvas for UI (cursor, selection)
    this.overlayCanvas = document.createElement("canvas");
    this.overlayCanvas.className = "note-canvas__overlay";
    this.overlayCtx = this.overlayCanvas.getContext("2d");
    this.viewportElement.appendChild(this.overlayCanvas);
  }

  /**
   * Set the data to render
   * @param {Array} strokes - Array of stroke objects
   * @param {string} background - Background pattern type
   */
  setData(strokes, background) {
    this.strokes = strokes || [];
    this.background = background || "none";
    this.palette = sharedGetThemePalette();
    this.markerPalette = sharedGetMarkerPalette();
  }

  /**
   * Set selected media item
   * @param {string|null} id
   */
  setSelectedMedia(id) {
    this.selectedMediaId = id;
    this.forceRedraw();
  }

  /**
   * Set selected strokes and their bounding box
   * @param {Set<number>} selectedIndices
   * @param {Object|null} bounds - {minX, minY, maxX, maxY}
   */
  setSelectedStrokes(selectedIndices, bounds) {
    this.selectedStrokeIndices = selectedIndices;
    this.selectionBounds = bounds;
    if (!bounds) {
      this.lineSeparators = [];
      this.lineIndentLevels = [];
    }
    this.forceRedraw();
  }

  /**
   * Set detected line separator Y positions and per-line indent levels for debug visualization.
   * @param {number[]} separatorYs - Y positions in content coordinates
   * @param {number[]} indentLevels - indent level per line band (0 = base, 1 = indented)
   */
  setLineSeparators(separatorYs, indentLevels = []) {
    this.lineSeparators = separatorYs;
    this.lineIndentLevels = indentLevels;
    this.forceRedraw();
  }

  /**
   * Set highlight rectangles
   * @param {Array<{x, y, w, h}>} rects
   */
  setHighlights(rects) {
    this.highlightRects = rects || [];
    this.forceRedraw();
  }

  /**
   * Set the spatial index for efficient queries
   * @param {SpatialIndex} index
   */
  setSpatialIndex(index) {
    this.spatialIndex = index;
  }

  /**
   * Set the media manager
   * @param {MediaManager} manager
   */
  setMediaManager(manager) {
    this.mediaManager = manager;
  }

  /**
   * Set the total content dimensions
   * @param {number} width
   * @param {number} height
   */
  setContentSize(width, height) {
    this.contentWidth = width;
    this.contentHeight = height;
  }

  /**
   * Resize the canvas for the given viewport dimensions
   * @param {number} width - Viewport width (screen pixels)
   * @param {number} height - Viewport height (screen pixels)
   */
  resize(width, height) {
    this.screenViewportWidth = width;
    // Canvas width should match content width to allow horizontal scrolling
    this.viewportWidth = this.maxContentWidth;
    this.viewportHeight = height;
    this.bufferHeight = height * this.bufferMultiplier;

    // Resize overlay to match screen viewport exactly
    this.overlayCanvas.width = width;
    this.overlayCanvas.height = Math.round(height * this.zoomScale);

    // Track if canvas bitmap dimensions actually changed (which clears the canvas)
    const oldWidth = this.canvas.width;
    const oldHeight = this.canvas.height;

    this._resizeCanvasBitmap();
    this._updateCanvasPosition();

    // If canvas was resized, it was cleared by the browser - mark that we need a redraw
    // The next render() call will trigger _repositionBuffer via _needsInitialDraw
    if (this.canvas.width !== oldWidth || this.canvas.height !== oldHeight) {
      this._needsInitialDraw = true;
    }
  }

  /**
   * Update canvas position (centering when needed)
   * Now always uses absolute positioning with transform-based centering for consistency
   * @private
   */
  _updateCanvasPosition() {
    // Always use absolute positioning - centering is now handled in _slideCanvas via transform
    this.canvas.classList.remove("sliding-buffer-canvas--centered");
  }

  /**
   * Calculate the X offset for centering the canvas when content is narrower than viewport
   * @private
   * @returns {number} The centering offset in screen pixels
   */
  _getCenteringOffset() {
    const scaledContentWidth = this.viewportWidth * this.zoomScale;
    if (scaledContentWidth < this.screenViewportWidth) {
      return (this.screenViewportWidth - scaledContentWidth) / 2;
    }
    return 0;
  }

  /**
   * Resize the canvas bitmap based on current dimensions and zoom
   * @private
   */
  _resizeCanvasBitmap() {
    const dpr = window.devicePixelRatio || 1;

    // Calculate resolution scale (for crisp rendering when zoomed in)
    this.resolutionScale = Math.min(
      Math.max(1.0, this.zoomScale * dpr),
      this.maxResolutionScale * dpr,
    );

    // Canvas bitmap size
    const bitmapWidth = Math.round(this.viewportWidth * this.resolutionScale);
    const bitmapHeight = Math.round(this.bufferHeight * this.resolutionScale);

    // Only resize if dimensions changed
    if (this.canvas.width !== bitmapWidth || this.canvas.height !== bitmapHeight) {
      this.canvas.width = bitmapWidth;
      this.canvas.height = bitmapHeight;

      // CSS size matches content dimensions (before zoom transform)
      this.canvas.style.width = `${this.viewportWidth}px`;
      this.canvas.style.height = `${this.bufferHeight}px`;
    }

    // Set transform for resolution scaling
    this.ctx.setTransform(this.resolutionScale, 0, 0, this.resolutionScale, 0, 0);
  }

  /**
   * Resolve the page background colour painted into the buffer bitmap.
   *
   * Reads the same CSS variable the canvas element used to rely on, so the
   * canvas keeps following the active theme — including Nextcloud's own
   * theming, which overrides these variables server-side. Falls back to the
   * theme's default only when the variable is unavailable (e.g. jsdom).
   * @private
   * @returns {string} A CSS colour string
   */
  _getPageBackgroundColor() {
    const fromCss = getComputedStyle(this.viewportElement).getPropertyValue("--bg-primary")?.trim();
    if (fromCss) return fromCss;
    return getTheme() === "dark" ? "#1e1e2e" : "#ffffff";
  }

  /**
   * Main render method - called on every scroll
   * @param {number} scrollTop - Current scroll position (in screen pixels)
   * @param {number} viewportHeight - Current viewport height
   * @param {number} scrollLeft - Current scroll left position (in screen pixels)
   * @param {Object} [activeStroke] - The stroke currently being drawn (optional)
   */
  render(scrollTop, viewportHeight, scrollLeft = 0, activeStroke = null) {
    // Convert to content coordinates (account for zoom)
    const contentScrollTop = scrollTop / this.zoomScale;
    const contentViewportHeight = viewportHeight / this.zoomScale;

    this.contentScrollTop = contentScrollTop;
    this.contentScrollLeft = scrollLeft / this.zoomScale;

    let resized = false;
    // Update viewport height if changed significantly
    if (Math.abs(contentViewportHeight - this.viewportHeight) > 1) {
      this.resize(this.screenViewportWidth, contentViewportHeight);
      resized = true;
    }

    // Update active stroke reference for redraws
    this.activeStroke = activeStroke;

    // Check if we need to leapfrog (reposition buffer)
    if (resized || this._shouldLeapfrog(contentScrollTop)) {
      this._repositionBuffer(contentScrollTop);
    } else {
      // Even if not leapfrogging, we might want to cleanup occasionally during small scrolls
      // But _repositionBuffer handles the bulk of it.
    }
    // Always slide the canvas to match scroll position
    this._slideCanvas(contentScrollTop, scrollLeft);

    // If active stroke is marker, update its preview on overlay (to handle scroll/zoom)
    if (this.activeStroke && this.activeStroke.type === "marker") {
      this._drawMarkerPreview(this.activeStroke, false);
    }
  }

  /**
   * Draw a stroke directly to the canvas (for low latency)
   * Uses incremental drawing to avoid overdraw artifacts on the main canvas
   * @param {Object} stroke - Stroke data
   * @param {boolean} isFinished - Whether this is the final draw call for the stroke
   */
  drawDirectStroke(stroke, isFinished = false) {
    if (!this.ctx || !stroke) return;

    // Reset state if this is a new stroke
    if (this.activeStrokeId !== stroke.id) {
      this.activeStrokeId = stroke.id;
      this.lastDrawnPointIndex = 0;
      // The colour a stroke draws in depends only on its start point, the
      // theme, and PDF page layout — none of which change while a single
      // stroke is being drawn. Resolving it per pointer move meant walking
      // every media item and rebuilding a palette array at stylus sample rate.
      // Scoped to this stroke id, so it cannot outlive the stroke.
      this._activeStrokeColor = null;
    }

    // Special handling for markers: draw full path on overlay to avoid alpha accumulation
    if (stroke.type === "marker") {
      this._drawMarkerPreview(stroke, isFinished);
      return;
    }

    const pointCount = stroke.x.length;
    if (pointCount < 2) return;

    this.ctx.save();
    this.ctx.translate(0, -this.bufferTop);

    // Setup styles manually since we are drawing incrementally. Resolved once
    // per stroke (see the cache reset above), not once per pointer move.
    if (this._activeStrokeColor === null) {
      const uninvertedPdfBounds = this._getUninvertedPdfBounds();
      const colors = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
        ? sharedGetThemePalette("light")
        : this.palette || sharedGetThemePalette();
      this._activeStrokeColor =
        stroke.colorIndex !== undefined ? colors[stroke.colorIndex] : stroke.color || colors[0];
    }
    this.ctx.strokeStyle = this._activeStrokeColor;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    const baseWidth = stroke.width || 2;
    // Shared with the final render (drawStroke) so the live preview and the
    // committed stroke cannot drift apart.
    const getWidth = (p) => sharedGetPressureWidth(p, baseWidth);

    // Start from where we left off
    let i = this.lastDrawnPointIndex;

    // Handle the very first segment (P0 -> Mid(P0, P1))
    if (i === 0) {
      const midX = (stroke.x[0] + stroke.x[1]) / 2;
      const midY = (stroke.y[0] + stroke.y[1]) / 2;
      this.ctx.beginPath();
      this.ctx.lineWidth = getWidth(stroke.pressure[0]);
      this.ctx.moveTo(stroke.x[0], stroke.y[0]);
      this.ctx.lineTo(midX, midY);
      this.ctx.stroke();
      i = 1;
    }

    // Draw curves for new points: Mid(i-1, i) -> P(i) -> Mid(i, i+1)
    for (; i < pointCount - 1; i++) {
      const midPrevX = (stroke.x[i - 1] + stroke.x[i]) / 2;
      const midPrevY = (stroke.y[i - 1] + stroke.y[i]) / 2;
      const midNextX = (stroke.x[i] + stroke.x[i + 1]) / 2;
      const midNextY = (stroke.y[i] + stroke.y[i + 1]) / 2;

      this.ctx.beginPath();
      this.ctx.lineWidth = getWidth(stroke.pressure[i]);
      this.ctx.moveTo(midPrevX, midPrevY);
      this.ctx.quadraticCurveTo(stroke.x[i], stroke.y[i], midNextX, midNextY);
      this.ctx.stroke();
    }

    this.lastDrawnPointIndex = i;

    // Tail segment: Mid(last-1, last) -> P(last).
    //
    // The committed curve above stops at the midpoint between the last two
    // points, so the ink always trails the stylus by roughly half a sample.
    // Drawing the tail on every move (not just on the final call) closes that
    // gap. It is deliberately NOT committed - lastDrawnPointIndex stays put, so
    // the next move re-draws the same region from the same starting geometry.
    // Overdrawing is invisible here because pen strokes are opaque round-capped
    // lines; markers are translucent and would accumulate alpha, but they return
    // early above via _drawMarkerPreview and never reach this path.
    const last = pointCount - 1;
    const prev = last - 1;
    const midX = (stroke.x[prev] + stroke.x[last]) / 2;
    const midY = (stroke.y[prev] + stroke.y[last]) / 2;

    this.ctx.beginPath();
    this.ctx.lineWidth = getWidth(stroke.pressure[last]);
    this.ctx.moveTo(midX, midY);
    this.ctx.lineTo(stroke.x[last], stroke.y[last]);
    this.ctx.stroke();

    if (isFinished) {
      // Reset for next stroke
      this.activeStrokeId = null;
      this.lastDrawnPointIndex = 0;
    }

    this.ctx.restore();
  }

  /**
   * Draw marker preview on overlay canvas
   * @private
   */
  _drawMarkerPreview(stroke, isFinished) {
    // Ensure palette is ready
    if (!this.palette) {
      this.palette = sharedGetThemePalette();
      this.markerPalette = sharedGetMarkerPalette();
    }

    const uninvertedPdfBounds = this._getUninvertedPdfBounds();
    const needsLight = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds);
    const penPalette = needsLight ? sharedGetThemePalette("light") : this.palette;
    const markerColors = needsLight ? sharedGetMarkerPalette("light") : this.markerPalette;

    if (isFinished) {
      // Final draw: Commit to main canvas
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

      this.ctx.save();
      this.ctx.translate(0, -this.bufferTop);
      // Use sharedDrawStroke to ensure consistent rendering with final result
      sharedDrawStroke(this.ctx, stroke, penPalette, false, false, markerColors);
      this.ctx.restore();

      // Reset state
      this.activeStrokeId = null;
      this.lastDrawnPointIndex = 0;
    } else {
      // Preview draw: Draw full stroke on overlay
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

      // Calculate centering offset
      const scaledContentWidth = this.viewportWidth * this.zoomScale;
      const offsetX =
        scaledContentWidth < this.screenViewportWidth
          ? (this.screenViewportWidth - scaledContentWidth) / 2
          : 0;

      this.overlayCtx.save();
      this.overlayCtx.translate(offsetX, 0);
      this.overlayCtx.scale(this.zoomScale, this.zoomScale);
      this.overlayCtx.translate(-this.contentScrollLeft, -this.contentScrollTop);
      sharedDrawStroke(this.overlayCtx, stroke, penPalette, false, false, markerColors);
      this.overlayCtx.restore();
    }
  }

  /**
   * Draw the lasso trail on the overlay canvas
   * @param {Array<{x: number, y: number}>} points - Array of points in content coordinates
   */
  drawLassoTrail(points) {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    if (points.length < 2) return;

    this.overlayCtx.beginPath();
    this.overlayCtx.strokeStyle = "rgba(0, 100, 255, 0.8)";
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.setLineDash([5, 5]);

    // Points are in content coordinates, need to transform to screen coordinates
    // Screen = Content * Zoom - Scroll (handled by overlay CSS transform? No, overlay has CSS transform)
    // Overlay canvas has CSS transform `scale(zoom)`.
    // So we draw in BASE coordinates (content coordinates).
    // But wait, overlay canvas size is set to viewport size in `resize`.
    // In `resize`: overlayCanvas.width = baseCanvasWidth (which is viewportWidth / zoom? No.)
    // Let's check `resize`:
    // overlayCanvas.width = width (screen pixels).
    // overlayCanvas.style.transform = `scale(${zoomScale})`? No, in `resize` it sets width/height to screen size.
    // In `_updateCanvasPosition` or `setZoom`?
    //
    // Let's look at `resize` implementation in this file:
    // this.overlayCanvas.width = width; (screen width)
    // this.overlayCanvas.height = height; (screen height)
    //
    // So overlay is 1:1 with screen pixels.
    // But `drawEraserCursor` receives screen coordinates.
    //
    // `points` passed here are likely content coordinates (from InputHandler).
    // We need to convert content -> screen.
    // ScreenX = ContentX * Zoom - ScrollLeft
    // ScreenY = ContentY * Zoom - ScrollTop
    //
    // However, `CanvasRenderer` doesn't track scroll position perfectly in sync with `VirtualScroller` for overlay drawing unless we pass it.
    // Actually, `drawEraserCursor` works because `NoteCanvas` passes `e.clientX`.
    //
    // For Lasso, `NoteCanvas` collects points.
    // If we draw on overlay, we should probably use screen coordinates or transform context.
    //
    // Let's assume `points` are passed as Screen Coordinates for `drawLassoTrail` to match `drawEraserCursor`.

    this.overlayCtx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      this.overlayCtx.lineTo(points[i].x, points[i].y);
    }
    this.overlayCtx.stroke();
    this.overlayCtx.setLineDash([]);
  }

  /**
   * Draw the eraser cursor on the overlay canvas
   * @param {number} x - Screen X coordinate
   * @param {number} y - Screen Y coordinate
   * @param {number} radius - Radius in screen pixels
   */
  drawEraserCursor(x, y, radius = 10, eraserMode = "stroke") {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.overlayCtx.beginPath();
    this.overlayCtx.arc(x, y, radius, 0, Math.PI * 2);
    if (eraserMode === "part") {
      this.overlayCtx.setLineDash([4, 3]);
      this.overlayCtx.strokeStyle = "rgba(59, 130, 246, 0.7)";
    } else {
      this.overlayCtx.setLineDash([]);
      this.overlayCtx.strokeStyle = "rgba(255, 0, 0, 0.5)";
    }
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.stroke();
    this.overlayCtx.setLineDash([]);
  }

  /**
   * Draw the visual indicator for inserting vertical space
   * @param {{startY: number, currentY: number}} state
   */
  drawInsertSpaceIndicator(state) {
    this.clearOverlay();
    if (!state) return;

    const { startY, currentY } = state;

    const ctx = this.overlayCtx;
    ctx.save();

    // Transform from content space to screen space for drawing on overlay
    const centeringOffset = this._getCenteringOffset();
    ctx.translate(centeringOffset, 0);
    ctx.scale(this.zoomScale, this.zoomScale);
    ctx.translate(-this.contentScrollLeft, -this.contentScrollTop);

    const lineWidth = 1 / this.zoomScale; // Keep line crisp
    const arrowSize = 8 / this.zoomScale;

    // 1. Draw horizontal line
    ctx.beginPath();
    ctx.strokeStyle = "rgba(0, 100, 255, 0.8)";
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([5, 5]);
    ctx.moveTo(0, startY);
    ctx.lineTo(this.contentWidth, startY);
    ctx.stroke();
    ctx.setLineDash([]);

    // 2. Draw arrows (only if dragged)
    if (Math.abs(currentY - startY) >= 1) {
      const arrowX1 = this.contentWidth * 0.25;
      const arrowX2 = this.contentWidth * 0.75;
      const direction = currentY >= startY ? 1 : -1;

      const drawArrow = (x, y1, y2) => {
        ctx.beginPath();
        ctx.moveTo(x, y1);
        ctx.lineTo(x, y2);
        ctx.stroke();

        // Arrowhead
        ctx.beginPath();
        ctx.moveTo(x, y2);
        const baseOffset = arrowSize * direction;
        ctx.lineTo(x - arrowSize / 2, y2 - baseOffset);
        ctx.lineTo(x + arrowSize / 2, y2 - baseOffset);
        ctx.closePath();
        ctx.fillStyle = "rgba(0, 100, 255, 0.8)";
        ctx.fill();
      };

      drawArrow(arrowX1, startY, currentY);
      drawArrow(arrowX2, startY, currentY);
    }

    ctx.restore();
  }

  clearOverlay() {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  /**
   * Check if scroll position requires a leapfrog (buffer reposition)
   * @private
   * @param {number} scrollTop - Scroll position in content coordinates
   * @returns {boolean}
   */
  _shouldLeapfrog(scrollTop) {
    // First render always needs a leapfrog
    if (this.bufferHeight === 0 || this._needsInitialDraw) return true;

    const contentViewportHeight = this.viewportHeight;
    const bufferContentHeight = this.bufferHeight;

    // Calculate safe zone (1 viewport from buffer edges)
    const safeMargin = contentViewportHeight * 0.3;
    const safeTop = this.bufferTop + safeMargin;
    const safeBottom = this.bufferTop + bufferContentHeight - contentViewportHeight - safeMargin;

    // Leapfrog if scroll is outside safe zone, BUT respect document bounds
    // If buffer is at the very top (0), don't leapfrog just because we are near top
    if (scrollTop < safeTop && this.bufferTop > 0) return true;

    // If buffer is at the very bottom, don't leapfrog just because we are near bottom
    const maxBufferTop = Math.max(0, this.contentHeight - bufferContentHeight);
    if (scrollTop > safeBottom && this.bufferTop < maxBufferTop - 1) return true; // -1 for float precision

    return false;
  }

  /**
   * Slide the canvas using CSS transform (no redraw)
   * @private
   * @param {number} scrollTop - Scroll position in content coordinates
   * @param {number} scrollLeft - Scroll left position in screen coordinates
   */
  _slideCanvas(scrollTop, scrollLeft = 0) {
    // Calculate offset from buffer top
    const offset = this.bufferTop - scrollTop;

    // Apply CSS transform (scaled by zoom for screen pixels)
    const screenOffsetY = offset * this.zoomScale;
    // Include centering offset for when content is narrower than viewport
    const centeringOffset = this._getCenteringOffset();
    const screenOffsetX = centeringOffset - scrollLeft;
    const cssScale = this.zoomScale;
    this.canvas.style.transform = `translate(${screenOffsetX}px, ${screenOffsetY}px) scale(${cssScale})`;
  }

  /**
   * Reposition buffer and redraw (leapfrog)
   * @private
   * @param {number} scrollTop - Scroll position in content coordinates
   */
  _repositionBuffer(scrollTop) {
    // Clear initial draw flag
    this._needsInitialDraw = false;

    const contentViewportHeight = this.viewportHeight;
    const bufferContentHeight = this.bufferHeight;

    // Center buffer on viewport
    const newBufferTop = Math.max(0, scrollTop - contentViewportHeight);

    // Clamp to content bounds
    const maxBufferTop = Math.max(0, this.contentHeight - bufferContentHeight);
    this.bufferTop = Math.min(newBufferTop, maxBufferTop);

    // Redraw the buffer in fast mode (no pressure) for scroll performance
    this._drawBuffer(true);

    // Clean up off-screen resources (PDF bitmaps) to prevent OOM
    this._cleanupOffscreenResources();

    // Schedule high-quality re-render after scroll stops
    this._scheduleQualityRender();
  }

  /**
   * Schedule a high-quality re-render after scroll/interaction stops
   * @private
   */
  _scheduleQualityRender() {
    if (this._qualityRenderTimeout) {
      clearTimeout(this._qualityRenderTimeout);
    }

    this._qualityRenderTimeout = setTimeout(() => {
      this._qualityRenderTimeout = null;
      // Only re-render if last render was in fast mode
      if (this._lastRenderWasFastMode) {
        this._drawBuffer(false);
      }
    }, this._qualityRenderDebounce);
  }

  /**
   * Draw the entire buffer content
   * @private
   * @param {boolean} fastMode - Skip pressure rendering for scroll performance
   */
  _drawBuffer(fastMode = false) {
    if (this.bufferHeight <= 0) return;

    const startTime = performance.now();

    // Clear canvas, then paint the page colour into the bitmap itself.
    //
    // The CSS background-color on .sliding-buffer-canvas is not sufficient: a
    // desynchronized context can be promoted to its own compositing/overlay
    // plane, where the element background no longer shows through the
    // transparent parts of the bitmap and the canvas renders black. Painting it
    // here makes the buffer opaque and independent of how it is composited.
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = this._getPageBackgroundColor();
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    // Ensure palette is current
    if (!this.palette) {
      this.palette = sharedGetThemePalette();
      this.markerPalette = sharedGetMarkerPalette();
    }

    // Draw background for buffer region
    if (this.background && this.background !== "none") {
      this._drawBackground();
    }

    // Draw media items (images, PDF pages)
    if (this.mediaManager) {
      this._drawMedia(fastMode);
    }

    // Draw A4 page break lines for notes without an imported PDF
    if (this.showA4PageBreaks) {
      this._drawA4PageBreaks();
    }

    // Query spatial index for visible strokes
    const bufferBottom = this.bufferTop + this.bufferHeight;
    let strokeIndices;

    if (this.spatialIndex) {
      strokeIndices = this.spatialIndex.query(this.bufferTop, bufferBottom);
    } else {
      // Fallback: draw all strokes (inefficient)
      strokeIndices = this.strokes.map((_, i) => i);
    }

    // Tracks whether this repaint painted the in-progress stroke in full, so the
    // incremental cursor can be re-based below (see drawDirectStroke).
    let _activeRedrawnInFull = false;

    // Separate markers and pens to draw markers first (behind pens)
    const markers = [];
    const pens = [];

    for (const index of strokeIndices) {
      const stroke = this.strokes[index];
      if (stroke && !stroke._deleted && !stroke.isDeleted) {
        if (stroke.type === "marker") {
          markers.push(index);
        } else {
          pens.push(index);
        }
      }
    }

    // Draw strokes with offset for buffer position
    this.ctx.save();
    this.ctx.translate(0, -this.bufferTop);

    try {
      // Un-inverted (white) PDF page bounds — strokes starting on one of these
      // need the light palette even in dark theme, to stay visible against the
      // page's actual (white) color. Computed once per draw pass.
      const uninvertedPdfBounds = this._getUninvertedPdfBounds();
      const lightPalette = uninvertedPdfBounds.length > 0 ? sharedGetThemePalette("light") : null;
      const lightMarkerPalette =
        uninvertedPdfBounds.length > 0 ? sharedGetMarkerPalette("light") : null;

      // Helper to draw a list of pen indices (no grouping needed)
      const drawList = (indices) => {
        for (const index of indices) {
          const stroke = this.strokes[index];
          const isSelected = this.selectedStrokeIndices.has(index);
          const strokePalette = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
            ? lightPalette
            : this.palette;
          sharedDrawStroke(this.ctx, stroke, strokePalette, isSelected, fastMode);
        }
      };

      // Helper to draw marker indices, grouping sub-strokes that share a groupId
      // into one beginPath…stroke() call so their alpha doesn't stack.
      // Draw markers first (lower z-index), grouped by groupId to preserve flat alpha.
      const markerStrokes = markers.map((i) => this.strokes[i]);
      const selectedIds = new Set(
        [...this.selectedStrokeIndices].map((i) => this.strokes[i]?.id).filter(Boolean),
      );
      const getMarkerColorsForStroke = (stroke) =>
        this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
          ? lightMarkerPalette
          : this.markerPalette || sharedGetMarkerPalette();
      drawMarkersGrouped(
        this.ctx,
        markerStrokes,
        this.palette,
        selectedIds,
        getMarkerColorsForStroke,
      );
      // Draw pens on top
      drawList(pens);

      // Draw active stroke on top if it exists (always full quality for responsiveness)
      if (this.activeStroke && this.activeStroke.type !== "marker") {
        // If active stroke is marker, it should technically be drawn before pens,
        // but for responsiveness we draw it on top during creation.
        // It will be sorted correctly once finished and added to the main list.
        const activePalette = this._strokeNeedsLightPalette(this.activeStroke, uninvertedPdfBounds)
          ? lightPalette
          : this.palette;
        sharedDrawStroke(this.ctx, this.activeStroke, activePalette, false, false);
        // This repaint just drew the active stroke in full, so the incremental
        // cursor drawDirectStroke() keeps must be re-based to match. Leaving it
        // where it was would make the next incremental call resume past the
        // points we just painted — harmless — but the real hazard is the
        // opposite case below.
        _activeRedrawnInFull = true;
      }

      // Draw highlights
      if (this.highlightRects.length > 0) {
        this.ctx.save();
        this.ctx.fillStyle = HIGHLIGHT_FILL_STYLE;
        this.ctx.strokeStyle = HIGHLIGHT_STROKE_STYLE;
        this.ctx.lineWidth = HIGHLIGHT_LINE_WIDTH;

        for (const rect of this.highlightRects) {
          this.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
          this.ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
        }
        this.ctx.restore();
      }

      // Draw selection bounding box
      if (this.selectionBounds) {
        const { minX, minY, maxX, maxY } = this.selectionBounds;
        const width = maxX - minX;
        const height = maxY - minY;

        this.ctx.save();
        this.ctx.strokeStyle = "rgba(0, 100, 255, 0.6)";
        this.ctx.lineWidth = 1 / this.resolutionScale; // Keep line thin regardless of zoom
        this.ctx.setLineDash([5, 5]);
        this.ctx.strokeRect(minX, minY, width, height);

        // Draw detected line separators and indentation markers for debug visualization
        if (this.lineSeparators.length > 0 || this.lineIndentLevels.length > 0) {
          const overhang = 8 / this.zoomScale;
          const markerSize = 6 / this.zoomScale;

          // Separator lines
          this.ctx.strokeStyle = "rgba(255, 100, 0, 0.7)";
          this.ctx.lineWidth = 1.5 / this.resolutionScale;
          this.ctx.setLineDash([6, 4]);
          for (const sepY of this.lineSeparators) {
            this.ctx.beginPath();
            this.ctx.moveTo(minX - overhang, sepY);
            this.ctx.lineTo(maxX + overhang, sepY);
            this.ctx.stroke();
          }

          // Indentation markers: filled arrow on the left edge of each indented band
          if (this.lineIndentLevels.length > 0) {
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = "rgba(255, 100, 0, 0.75)";
            // Band top/bottom boundaries (separators + selection edges)
            const bandTops = [minY, ...this.lineSeparators];
            const bandBottoms = [...this.lineSeparators, maxY];
            for (let i = 0; i < this.lineIndentLevels.length; i++) {
              if (this.lineIndentLevels[i] === 0) continue;
              const bandMidY = (bandTops[i] + bandBottoms[i]) / 2;
              const arrowX = minX - overhang;
              // Draw a right-pointing triangle
              this.ctx.beginPath();
              this.ctx.moveTo(arrowX, bandMidY - markerSize);
              this.ctx.lineTo(arrowX + markerSize * 1.2, bandMidY);
              this.ctx.lineTo(arrowX, bandMidY + markerSize);
              this.ctx.closePath();
              this.ctx.fill();
            }
          }
        }

        this.ctx.restore();

        // Draw resize handles using shared handle positions
        const handleSize = SELECTION_HANDLE_SIZE / this.zoomScale; // Constant screen size
        const half = handleSize / 2;
        this.ctx.save();
        this.ctx.fillStyle = "#ffffff";
        this.ctx.strokeStyle = "#3b82f6";
        this.ctx.lineWidth = 1 / this.resolutionScale;

        const handles = getSelectionHandles(this.selectionBounds, this.zoomScale);

        for (const { key, x: hx, y: hy } of handles) {
          if (key === "rotate") {
            // Draw rotation handle with stem
            this.ctx.beginPath();
            this.ctx.moveTo(hx, minY);
            this.ctx.lineTo(hx, hy);
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.arc(hx, hy, half, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.stroke();
          } else {
            // Draw square handle for resize
            this.ctx.fillRect(hx - half, hy - half, handleSize, handleSize);
            this.ctx.strokeRect(hx - half, hy - half, handleSize, handleSize);
          }
        }
        this.ctx.restore();
      }
    } finally {
      this.ctx.restore();
    }

    // A repaint clears the whole buffer canvas. drawDirectStroke() paints the
    // in-progress stroke incrementally, resuming from lastDrawnPointIndex — so
    // after a clear, every point below that cursor has been wiped and would
    // never be repainted, leaving the live stroke jagged with missing segments
    // until the finished stroke is committed and drawn from the spatial index.
    //
    // Re-base the cursor to match what is actually on the canvas now:
    //  - active stroke repainted in full  → cursor moves to its last segment
    //  - active stroke absent from this repaint → cursor resets so the next
    //    incremental call redraws the stroke from the beginning.
    if (this.activeStrokeId) {
      if (_activeRedrawnInFull) {
        this.lastDrawnPointIndex = Math.max(0, (this.activeStroke?.x.length ?? 1) - 1);
      } else {
        this.lastDrawnPointIndex = 0;
      }
    }

    this._lastRenderWasFastMode = fastMode;
    this.lastRenderTime = performance.now() - startTime;
  }

  /**
   * Draw media items onto the buffer
   * @private
   * @param {boolean} fastMode - Use faster rendering (lower quality)
   */
  _drawMedia(fastMode = false) {
    const items = this.mediaManager.getItems();
    if (!items || items.length === 0) return;

    this.ctx.save();
    this.ctx.translate(0, -this.bufferTop);

    if (fastMode) {
      this.ctx.imageSmoothingEnabled = false;
    } else {
      this.ctx.imageSmoothingQuality = "high";
    }

    const bufferBottom = this.bufferTop + this.bufferHeight;

    // Sort by z-index if available, otherwise draw in order
    // TODO: Add z-index support to data model

    for (const item of items) {
      // Culling: Skip items not visible in the current buffer
      if (item.y + item.height < this.bufferTop || item.y > bufferBottom) {
        continue;
      }

      if (item.type === "pdf-page") {
        this._drawPdfPage(item, fastMode);
        continue;
      }

      if (item.type === "image" && item.fileId) {
        const img = this.mediaManager.getImage(item.fileId);
        this.ctx.save();

        // Apply rotation for both image and border
        if (item.rotation) {
          const cx = item.x + item.width / 2;
          const cy = item.y + item.height / 2;
          this.ctx.translate(cx, cy);
          this.ctx.rotate((item.rotation * Math.PI) / 180);
          this.ctx.translate(-cx, -cy);
        }

        if (img) {
          this.ctx.drawImage(img, item.x, item.y, item.width, item.height);
        } else {
          // Draw placeholder while loading
          this.ctx.fillStyle = "rgba(200, 200, 200, 0.2)";
          this.ctx.fillRect(item.x, item.y, item.width, item.height);
        }

        // Draw selection border (within the same rotated context)
        if (item.id === this.selectedMediaId) {
          this.ctx.strokeStyle = "#3b82f6";
          this.ctx.lineWidth = 2;
          this.ctx.strokeRect(item.x, item.y, item.width, item.height);
        }
        this.ctx.restore(); // Restore from rotation transform

        // Draw handles (which are pre-rotated) if selected
        if (item.id === this.selectedMediaId) {
          // Draw handles
          const handles = getMediaHandles(item, this.zoomScale);
          const handleSize = MEDIA_HANDLE_SIZE / this.zoomScale;
          const half = handleSize / 2;

          this.ctx.fillStyle = "#ffffff";
          this.ctx.strokeStyle = "#3b82f6";
          this.ctx.lineWidth = 1 / this.resolutionScale;

          for (const h of handles) {
            this.ctx.beginPath();
            if (h.key === "rotate") {
              this.ctx.arc(h.x, h.y, half, 0, Math.PI * 2);
            } else {
              this.ctx.rect(h.x - half, h.y - half, handleSize, handleSize);
            }
            this.ctx.fill();
            this.ctx.stroke();
          }
        }
      }
    }

    this.ctx.restore();
  }

  /**
   * Draw a PDF page item
   * @private
   * Note: This method is called from _drawMedia which already has ctx.translate(0, -this.bufferTop) applied.
   * Do NOT apply another bufferTop translation here.
   */
  /**
   * Bounding boxes (content space) of visible PDF pages that are currently
   * rendered un-inverted, i.e. genuinely white — either because theme is
   * light (nothing is inverted) or because the "invert PDF pages in dark
   * mode" setting is off. Strokes starting inside these boxes need the light
   * palette to stay legible; strokes elsewhere use the live theme palette.
   * Recomputed once per draw pass, not per stroke.
   * @returns {Array<{x:number,y:number,width:number,height:number}>}
   * @private
   */
  _getUninvertedPdfBounds() {
    if (!this.mediaManager) return [];
    if (getTheme() === "dark" && getPdfInvertDarkMode()) return []; // pages are inverted — dark palette is fine everywhere
    return this.mediaManager
      .getItems()
      .filter((item) => item.type === "pdf-page")
      .map((item) => ({ x: item.x, y: item.y, width: item.width, height: item.height }));
  }

  /**
   * Whether theme is dark and this stroke's start point falls on an
   * un-inverted (white) PDF page, so it needs the light palette instead of
   * the dark-mode one to stay visible.
   * @private
   */
  _strokeNeedsLightPalette(stroke, uninvertedPdfBounds) {
    if (getTheme() !== "dark" || uninvertedPdfBounds.length === 0) return false;
    if (!stroke.x || stroke.x.length === 0) return false;
    const px = stroke.x[0];
    const py = stroke.y[0];
    return uninvertedPdfBounds.some(
      (b) => px >= b.x && px <= b.x + b.width && py >= b.y && py <= b.y + b.height,
    );
  }

  /**
   * Draw a PDF page's rendered bitmap. In dark theme, item.renderable is
   * already the inverted bitmap (inverted once at render time in
   * getRenderedMedia/renderPdfPage) so the always-white PDF page reads as
   * dark and the dark-mode stroke palette stays legible on it — no per-frame
   * filter cost here.
   * @private
   */
  _drawPdfRenderable(item) {
    this.ctx.drawImage(item.renderable, item.x, item.y, item.width, item.height);
  }

  _drawPdfPage(item, _fastMode) {
    // 1. Try to draw existing renderable if it matches current scale
    if (
      item.renderable &&
      item.renderableScale === this.resolutionScale &&
      item.renderable.width > 0
    ) {
      this._drawPdfRenderable(item);
      // Draw page break and selection even for cached pages
      this._drawPdfPageBreak(item);
      if (item.id === this.selectedMediaId) {
        this.ctx.strokeStyle = "#3b82f6";
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(item.x, item.y, item.width, item.height);
      }
      return;
    }

    // 2. If we have an existing renderable but scale mismatch (e.g. zooming), draw it anyway as placeholder
    if (item.renderable && item.renderable.width > 0) {
      this._drawPdfRenderable(item);
    }

    // 3. Trigger load for correct scale if not already loading
    if (!item.loading && !item.error && this.activePdfLoads < this.maxConcurrentPdfLoads) {
      // Start loading regardless of fastMode to ensure pages eventually render
      // The forceRedraw() on completion will show them once loaded
      item.loading = true;
      this.activePdfLoads++;

      getRenderedMedia(item, this.resolutionScale, { invertForDarkTheme: true })
        .then((renderable) => {
          item.loading = false;
          this.activePdfLoads--;

          // Only store if item is still within a reasonable range of the viewport
          // This prevents storing bitmaps for pages that were scrolled past quickly
          const inKeepZone = this._isItemInKeepZone(item);

          if (inKeepZone && renderable) {
            // If replacing an existing bitmap (e.g. zoom level change), close the old one first
            if (item.renderable && typeof item.renderable.close === "function") {
              item.renderable.close();
            }
            item.renderable = renderable;
            item.renderableScale = this.resolutionScale;
            // Don't call forceRedraw directly - use debounced queue check instead
            // This prevents cascading redraws when many pages load in succession
          } else if (renderable) {
            // CRITICAL: If we are not keeping this bitmap (scrolled away), we MUST close it immediately.
            // Otherwise it leaks in GPU memory until GC kicks in (which is too slow).
            if (typeof renderable.close === "function") {
              renderable.close();
            } else if (renderable.width !== undefined) {
              renderable.width = 0;
              renderable.height = 0;
            }
            // Don't forceRedraw - item is off-screen anyway
          } else if (inKeepZone) {
            // No renderable and still in view - mark as error to prevent infinite retry loop
            item.error = true;
            // Debounced redraw will show error state
          }
          // Note: If not in keep zone and no renderable, do nothing - item is off-screen
          // The next scroll will trigger a fresh load if needed

          // Schedule a debounced redraw to show loaded pages and pick up queued ones
          this._schedulePdfQueueCheck();
        })
        .catch((err) => {
          item.loading = false;
          this.activePdfLoads--;
          // "PDF file not found" means the file hasn't synced yet — retry after a delay
          // rather than permanently marking as error.
          if (err?.message?.includes("PDF file not found")) {
            setTimeout(() => {
              item.error = false;
              this._schedulePdfQueueCheck();
            }, 5000);
          } else {
            console.error(`[CanvasRenderer] Failed to render PDF page ${item.id}:`, err);
            item.error = true;
          }
          this._schedulePdfQueueCheck();
        });
    }
    // If loading but no cached renderable yet, draw a placeholder
    else if (item.loading && !item.renderable) {
      this.ctx.fillStyle = "rgba(200, 200, 200, 0.1)";
      this.ctx.fillRect(item.x, item.y, item.width, item.height);
      this._drawLoadingIndicator(item);
    }
    // If error, draw error placeholder
    else if (item.error) {
      this.ctx.fillStyle = "rgba(255, 0, 0, 0.05)";
      this.ctx.fillRect(item.x, item.y, item.width, item.height);
      this._drawErrorIndicator(item);
    }

    // Draw page break line at bottom of PDF page (dashed dark blue line)
    this._drawPdfPageBreak(item);

    // Draw selection border if selected
    if (item.id === this.selectedMediaId) {
      this.ctx.strokeStyle = "#3b82f6";
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(item.x, item.y, item.width, item.height);
    }
  }

  /**
   * Draw a loading indicator for a PDF page
   * @private
   */
  _drawLoadingIndicator(item) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;

    this.ctx.save();

    // Pill background
    this.ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    this.ctx.beginPath();
    if (this.ctx.roundRect) {
      this.ctx.roundRect(cx - 40, cy - 15, 80, 30, 15);
    } else {
      this.ctx.rect(cx - 40, cy - 15, 80, 30);
    }
    this.ctx.fill();

    // Text
    this.ctx.fillStyle = "#374151";
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText("Loading...", cx, cy);

    this.ctx.restore();
  }

  /**
   * Draw an error indicator for a PDF page
   * @private
   */
  _drawErrorIndicator(item) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;

    this.ctx.save();

    // Pill background
    this.ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    this.ctx.beginPath();
    if (this.ctx.roundRect) {
      this.ctx.roundRect(cx - 50, cy - 15, 100, 30, 15);
    } else {
      this.ctx.rect(cx - 50, cy - 15, 100, 30);
    }
    this.ctx.fill();

    // Text
    this.ctx.fillStyle = "#ef4444"; // Red
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText("Error loading page", cx, cy);

    this.ctx.restore();
  }

  /**
   * Draw a dashed page break line at the bottom of a PDF page
   * @private
   */
  _drawPdfPageBreak(item) {
    const y = item.y + item.height;
    const lineWidth = 1 / this.resolutionScale; // Keep line crisp at any zoom

    this.ctx.save();
    this.ctx.strokeStyle = "#1e3a5f"; // Dark blue
    this.ctx.lineWidth = lineWidth;
    this.ctx.setLineDash([8, 4]); // Dashed pattern: 8px dash, 4px gap

    this.ctx.beginPath();
    this.ctx.moveTo(item.x, y);
    this.ctx.lineTo(item.x + item.width, y);
    this.ctx.stroke();

    this.ctx.restore();
  }

  /**
   * Draw A4 page break lines across the full content width.
   * Used when the note has no imported PDF so the user can see where pages will break on export.
   * Matches the A4 proportions used in pdfExport.js (CONTENT_WIDTH=1200, A4 72pt/inch).
   * @private
   */
  _drawA4PageBreaks() {
    // A4 page height in content space: same calculation as pdfExport.js Case B
    const A4_CONTENT_PAGE_H = 841.89 / (595.28 / 1200); // ≈ 1696.7 px

    const bufferBottom = this.bufferTop + this.bufferHeight;
    const lineWidth = 1 / this.resolutionScale;

    this.ctx.save();
    this.ctx.translate(0, -this.bufferTop);
    this.ctx.strokeStyle = "#1e3a5f";
    this.ctx.lineWidth = lineWidth;
    this.ctx.setLineDash([8, 4]);

    // Draw lines at the bottom of each page (i=1,2,…), skipping y=0 (top of note)
    const firstBreakIndex = Math.max(1, Math.ceil(this.bufferTop / A4_CONTENT_PAGE_H));
    for (let i = firstBreakIndex; ; i++) {
      const y = i * A4_CONTENT_PAGE_H;
      if (y > bufferBottom) break;
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.contentWidth, y);
      this.ctx.stroke();
    }

    this.ctx.restore();
  }

  /**
   * Check if an item is within the "keep zone" (buffer + margin)
   * Used to determine if we should keep/store its bitmap
   * @private
   */
  _isItemInKeepZone(item) {
    // Keep zone = Buffer +/- 1 viewport height
    // This is generous enough to prevent flickering but tight enough to save memory
    const contentViewportHeight = this.viewportHeight;
    const margin = contentViewportHeight * 0.5;
    const keepTop = this.bufferTop - margin;
    const keepBottom = this.bufferTop + this.bufferHeight + margin;

    return item.y + item.height >= keepTop && item.y <= keepBottom;
  }

  /**
   * Clean up resources for items that have moved out of the keep zone
   * @private
   */
  _cleanupOffscreenResources() {
    if (!this.mediaManager) return;

    const items = this.mediaManager.getItems();

    for (const item of items) {
      if (item.type === "pdf-page" && item.renderable) {
        if (!this._isItemInKeepZone(item)) {
          this._releaseItemMemory(item);
        }
      }
    }
  }

  _releaseItemMemory(item) {
    // CRITICAL: Clear the render cache FIRST, before destroying the renderable.
    // Otherwise the cache holds a reference to a destroyed canvas/bitmap,
    // causing getRenderedMedia to return corrupted resources.
    clearRenderCache(item.id);

    if (item.renderable) {
      // Explicitly close ImageBitmap to free GPU memory immediately
      if (typeof item.renderable.close === "function") {
        item.renderable.close();
      } else if (item.renderable.width !== undefined) {
        // If it's a canvas, resize to 0 to free backing store
        item.renderable.width = 0;
        item.renderable.height = 0;
      }
    }
    item.renderable = null;
    item.renderableScale = null;
    // Do NOT reset item.loading = false here.
    // If a load is pending, let it finish (and discard result).
    // Resetting it here would allow _drawPdfPage to trigger a duplicate load immediately,
    // causing a race condition and potential infinite load loop during rapid scrolling.
  }

  /**
   * Schedule a debounced redraw to pick up queued PDF pages and show loaded ones
   * This prevents immediate forceRedraw cascades while still ensuring
   * pages waiting for a load slot eventually get loaded
   * @private
   */
  _schedulePdfQueueCheck() {
    if (this._pdfQueueCheckTimeout) {
      clearTimeout(this._pdfQueueCheckTimeout);
    }
    this._pdfQueueCheckTimeout = setTimeout(() => {
      this._pdfQueueCheckTimeout = null;
      // Redraw to show newly loaded pages and trigger loading for queued pages
      this.forceRedraw();
    }, 100); // Debounce to batch multiple load completions
  }

  /**
   * Draw background pattern for the buffer region
   * @private
   */
  _drawBackground() {
    // Save context state
    this.ctx.save();

    // Draw background pattern
    // The shared function draws from startY to height, so we need to offset
    this.ctx.translate(0, -this.bufferTop);

    sharedDrawBackgroundPattern(
      this.ctx,
      this.background,
      this.viewportWidth,
      this.bufferTop + this.bufferHeight,
      this.bufferTop,
    );

    this.ctx.restore();
  }

  /**
   * Set zoom level
   * @param {number} scale - Zoom scale (1.0 = 100%)
   * @param {Object} options
   * @param {boolean} options.immediate - Skip debounce and render immediately
   * @param {number} options.scrollTop - Current scroll position for re-render
   * @param {number} options.scrollLeft - Current scroll left position
   * @param {number} options.viewportHeight - Current viewport height (screen pixels)
   */
  setZoom(scale, options = {}) {
    this.zoomScale = scale;

    // Update viewport dimensions if height is provided (handles zoom out buffer expansion)
    // Only do this for immediate renders to avoid clearing canvas during gestures
    if (options.viewportHeight && options.immediate) {
      const contentViewportHeight = options.viewportHeight / scale;
      if (Math.abs(contentViewportHeight - this.viewportHeight) > 1) {
        this.resize(this.screenViewportWidth, contentViewportHeight);
      }
    }

    // Update canvas position (centering)
    this._updateCanvasPosition();

    const contentScrollTop = (options.scrollTop || 0) / scale;
    const screenScrollLeft = options.scrollLeft || 0;

    if (options.immediate) {
      // Immediate full re-render at new resolution
      this._resizeCanvasBitmap();
      if (options.scrollTop !== undefined) {
        this._repositionBuffer(contentScrollTop);
        this._cleanupOffscreenResources();
      }
    } else {
      // Debounced full re-render - capture current scale
      const targetScale = scale;
      if (this.zoomRenderTimeout) {
        clearTimeout(this.zoomRenderTimeout);
      }
      this.zoomRenderTimeout = setTimeout(() => {
        // Use the captured targetScale, not this.zoomScale which may have changed
        this._resizeCanvasBitmap();
        if (options.scrollTop !== undefined) {
          this._repositionBuffer(options.scrollTop / targetScale);
          this._cleanupOffscreenResources();
        }
      }, this.zoomRenderDebounce);
    }

    // Always update visual transform immediately
    this._slideCanvas(contentScrollTop, screenScrollLeft);
  }

  /**
   * Force a full redraw of the current buffer (high quality)
   */
  forceRedraw() {
    this.palette = sharedGetThemePalette();
    this._drawBuffer(false); // Always full quality on explicit redraw
  }

  /**
   * Release all cached PDF page renderables so they reload on next draw.
   * Needed on theme change: rendered PDF bitmaps are inverted for dark theme
   * (see mediaManager.getRenderedMedia), and that inversion is baked in at
   * render time rather than reapplied per-frame, so a live theme toggle
   * would otherwise keep showing pages rendered for the previous theme.
   */
  invalidatePdfRenderables() {
    // A theme switch also changes which palette an in-progress stroke draws
    // in, so drop the colour cached for it (see drawDirectStroke).
    this._activeStrokeColor = null;
    if (!this.mediaManager) return;
    for (const item of this.mediaManager.getItems()) {
      if (item.type === "pdf-page" && item.renderable) {
        this._releaseItemMemory(item);
      }
    }
  }

  /**
   * Render a full one-shot snapshot of the note (background + media + strokes)
   * into a target canvas context, e.g. for a thumbnail. Unlike the live render()
   * loop, this awaits each media item's bitmap before drawing rather than relying
   * on already-cached item.renderable — needed because a freshly constructed
   * renderer (as used for thumbnails) has nothing cached yet. Media is drawn
   * before strokes so z-order matches the editor.
   * @param {CanvasRenderingContext2D} targetCtx
   * @param {number} width - Target width
   * @param {number} height - Target height
   * @param {Object} [options]
   * @param {number} [options.maxPdfPages] - Cap how many pdf-page items are rendered
   *   (in document order), to keep load time reasonable for small previews. Default: unlimited.
   * @returns {Promise<{bgColor: string}>}
   */
  async renderSnapshot(targetCtx, width, height, options = {}) {
    const { maxPdfPages = Infinity } = options;
    // Calculate scale to fit content width into target width
    // We assume we want to capture the full width of the note
    const scale = width / this.maxContentWidth;
    const contentHeight = height / scale;

    targetCtx.save();

    // Fill background using the current theme color (prevents black on JPEG for transparent notes)
    const isDark = getTheme() === "dark";
    const bgColor = isDark ? "#1e1e2e" : "#ffffff";
    targetCtx.fillStyle = bgColor;
    targetCtx.fillRect(0, 0, width, height);

    targetCtx.scale(scale, scale);

    // Ensure palette is ready
    if (!this.palette) {
      this.palette = sharedGetThemePalette();
      this.markerPalette = sharedGetMarkerPalette();
    }

    // 1. Background
    if (this.background && this.background !== "none") {
      sharedDrawBackgroundPattern(
        targetCtx,
        this.background,
        this.maxContentWidth,
        contentHeight,
        0,
      );
    }

    // 2. Media — await each item's bitmap (PDF pages and images alike) since
    // nothing is pre-cached on a freshly constructed renderer.
    let visibleItems = this.mediaManager
      ? this.mediaManager
          .getItems()
          .filter((item) => !item.deleted && item.y <= contentHeight && item.y + item.height >= 0)
      : [];

    if (Number.isFinite(maxPdfPages)) {
      let pdfPageCount = 0;
      visibleItems = visibleItems.filter((item) => {
        if (item.type !== "pdf-page") return true;
        pdfPageCount++;
        return pdfPageCount <= maxPdfPages;
      });
    }

    await Promise.all(
      visibleItems.map(async (item) => {
        if (item.type === "pdf-page") {
          item.renderable = await getRenderedMedia(item, scale, { invertForDarkTheme: true }).catch(
            () => null,
          );
        } else if (item.type === "image" && item.fileId) {
          item.renderable = await getRenderedMedia(item, scale).catch(() => null);
        }
      }),
    );

    for (const item of visibleItems) {
      if (!item.renderable) continue;
      targetCtx.save();
      if (item.rotation) {
        const cx = item.x + item.width / 2;
        const cy = item.y + item.height / 2;
        targetCtx.translate(cx, cy);
        targetCtx.rotate((item.rotation * Math.PI) / 180);
        targetCtx.translate(-cx, -cy);
      }
      targetCtx.drawImage(item.renderable, item.x, item.y, item.width, item.height);
      targetCtx.restore();
    }

    // 3. Strokes — same light-palette-on-white-PDF logic as the live editor.
    const uninvertedPdfBounds = this._getUninvertedPdfBounds();
    const lightPalette = uninvertedPdfBounds.length > 0 ? sharedGetThemePalette("light") : null;
    const lightMarkerPalette =
      uninvertedPdfBounds.length > 0 ? sharedGetMarkerPalette("light") : null;

    // Query spatial index for top region
    const strokeIndices = this.spatialIndex
      ? this.spatialIndex.query(0, contentHeight)
      : this.strokes.map((_, i) => i);

    const markers = [];
    const pens = [];

    for (const index of strokeIndices) {
      const stroke = this.strokes[index];
      if (stroke && !stroke._deleted && !stroke.isDeleted) {
        if (stroke.type === "marker") markers.push(stroke);
        else pens.push(stroke);
      }
    }

    // Draw markers (grouped by groupId to preserve flat alpha), then pens
    const getMarkerColorsForStroke = (stroke) =>
      this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
        ? lightMarkerPalette
        : this.markerPalette || sharedGetMarkerPalette();
    drawMarkersGrouped(targetCtx, markers, this.palette, null, getMarkerColorsForStroke);
    for (const stroke of pens) {
      const strokePalette = this._strokeNeedsLightPalette(stroke, uninvertedPdfBounds)
        ? lightPalette
        : this.palette;
      sharedDrawStroke(targetCtx, stroke, strokePalette, false, false);
    }

    targetCtx.restore();
    return { bgColor };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.zoomRenderTimeout) {
      clearTimeout(this.zoomRenderTimeout);
    }

    if (this._qualityRenderTimeout) {
      clearTimeout(this._qualityRenderTimeout);
    }

    if (this._pdfQueueCheckTimeout) {
      clearTimeout(this._pdfQueueCheckTimeout);
    }

    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }

    if (this.overlayCanvas?.parentElement) {
      this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
    }

    this.canvas = null;
    this.ctx = null;
    this.strokes = [];
    this.spatialIndex = null;
  }
}
