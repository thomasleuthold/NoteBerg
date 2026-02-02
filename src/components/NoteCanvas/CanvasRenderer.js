/**
 * CanvasRenderer - Sliding buffer canvas with leapfrog technique
 *
 * Manages a canvas sized to 3x viewport height. Uses CSS translateY for
 * smooth scrolling within the buffer, and repositions + redraws when
 * scroll exceeds the safe zone (leapfrog).
 */

import { getRenderedMedia } from "../../modules/mediaManager.js";
import {
  drawBackgroundPattern as sharedDrawBackgroundPattern,
  drawStroke as sharedDrawStroke,
  getMarkerPalette as sharedGetMarkerPalette,
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
    this.selectedMediaId = null; // ID of selected media item
    this.lastDrawnPointIndex = 0; // Index of the last point processed in the active stroke
    this.selectionBounds = null;
    this.highlightRects = []; // Search term highlights

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

    this.ctx = this.canvas.getContext("2d");
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

    // Resize overlay to match viewport exactly (in screen pixels)
    this.overlayCanvas.width = width;
    this.overlayCanvas.height = height;

    this._resizeCanvasBitmap();
    this._updateCanvasPosition();
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

    // Setup styles manually since we are drawing incrementally
    const colors = this.palette || sharedGetThemePalette();
    const color =
      stroke.colorIndex !== undefined ? colors[stroke.colorIndex] : stroke.color || colors[0];
    this.ctx.strokeStyle = color;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";

    const baseWidth = stroke.width || 2;
    const getWidth = (p) => Math.max(0.5, baseWidth * (0.5 + p));

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

    // Draw tail segment if finished: Mid(last-1, last) -> P(last)
    if (isFinished) {
      const last = pointCount - 1;
      const prev = last - 1;
      const midX = (stroke.x[prev] + stroke.x[last]) / 2;
      const midY = (stroke.y[prev] + stroke.y[last]) / 2;

      this.ctx.beginPath();
      this.ctx.lineWidth = getWidth(stroke.pressure[last]);
      this.ctx.moveTo(midX, midY);
      this.ctx.lineTo(stroke.x[last], stroke.y[last]);
      this.ctx.stroke();

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

    if (isFinished) {
      // Final draw: Commit to main canvas
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

      this.ctx.save();
      this.ctx.translate(0, -this.bufferTop);
      // Use sharedDrawStroke to ensure consistent rendering with final result
      sharedDrawStroke(this.ctx, stroke, this.palette);
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
      sharedDrawStroke(this.overlayCtx, stroke, this.palette);
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
  drawEraserCursor(x, y, radius = 10) {
    this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.overlayCtx.beginPath();
    this.overlayCtx.arc(x, y, radius, 0, Math.PI * 2);
    this.overlayCtx.strokeStyle = "rgba(255, 0, 0, 0.5)";
    this.overlayCtx.lineWidth = 2;
    this.overlayCtx.stroke();
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
    if (this.bufferHeight === 0) return true;

    // Calculate safe zone (1 viewport from buffer edges)
    const safeMargin = this.viewportHeight;
    const safeTop = this.bufferTop + safeMargin;
    const safeBottom = this.bufferTop + this.bufferHeight - this.viewportHeight - safeMargin;

    // Leapfrog if scroll is outside safe zone
    return scrollTop < safeTop || scrollTop > safeBottom;
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
    // Center buffer on viewport
    const newBufferTop = Math.max(0, scrollTop - this.viewportHeight);

    // Clamp to content bounds
    const maxBufferTop = Math.max(0, this.contentHeight - this.bufferHeight);
    this.bufferTop = Math.min(newBufferTop, maxBufferTop);

    // Redraw the buffer in fast mode (no pressure) for scroll performance
    this._drawBuffer(true);

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
    const startTime = performance.now();

    // Clear canvas
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
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

    // Query spatial index for visible strokes
    const bufferBottom = this.bufferTop + this.bufferHeight;
    let strokeIndices;

    if (this.spatialIndex) {
      strokeIndices = this.spatialIndex.query(this.bufferTop, bufferBottom);
    } else {
      // Fallback: draw all strokes (inefficient)
      strokeIndices = this.strokes.map((_, i) => i);
    }

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

    // Helper to draw a list of indices
    const drawList = (indices) => {
      for (const index of indices) {
        const stroke = this.strokes[index];
        const isSelected = this.selectedStrokeIndices.has(index);
        sharedDrawStroke(this.ctx, stroke, this.palette, isSelected, fastMode);
      }
    };

    // Draw markers first (lower z-index)
    drawList(markers);
    // Draw pens on top
    drawList(pens);

    // Draw active stroke on top if it exists (always full quality for responsiveness)
    if (this.activeStroke && this.activeStroke.type !== "marker") {
      // If active stroke is marker, it should technically be drawn before pens,
      // but for responsiveness we draw it on top during creation.
      // It will be sorted correctly once finished and added to the main list.
      sharedDrawStroke(this.ctx, this.activeStroke, this.palette, false, false);
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

    this.ctx.restore();

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
  _drawPdfPage(item, _fastMode) {
    if (item.renderable && item.renderableScale === this.resolutionScale) {
      this.ctx.drawImage(item.renderable, item.x, item.y, item.width, item.height);
    } else if (!item.loading) {
      // Start loading regardless of fastMode to ensure pages eventually render
      // The forceRedraw() on completion will show them once loaded
      item.loading = true;
      getRenderedMedia(item, this.resolutionScale)
        .then((renderable) => {
          item.loading = false;
          if (renderable) {
            item.renderable = renderable;
            item.renderableScale = this.resolutionScale;
          }
          this.forceRedraw();
        })
        .catch((err) => {
          console.error(`[CanvasRenderer] Failed to render PDF page ${item.id}:`, err);
          item.loading = false;
        });
    }
    // If loading but no cached renderable yet, draw a placeholder
    else if (item.loading && !item.renderable) {
      this.ctx.fillStyle = "rgba(200, 200, 200, 0.1)";
      this.ctx.fillRect(item.x, item.y, item.width, item.height);
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
   * Clean up resources
   */
  destroy() {
    if (this.zoomRenderTimeout) {
      clearTimeout(this.zoomRenderTimeout);
    }

    if (this._qualityRenderTimeout) {
      clearTimeout(this._qualityRenderTimeout);
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
