/**
 * CanvasRenderer - Sliding buffer canvas with leapfrog technique
 *
 * Manages a canvas sized to 3x viewport height. Uses CSS translateY for
 * smooth scrolling within the buffer, and repositions + redraws when
 * scroll exceeds the safe zone (leapfrog).
 */

import {
  drawBackgroundPattern as sharedDrawBackgroundPattern,
  drawStroke as sharedDrawStroke,
  getThemePalette as sharedGetThemePalette,
} from "../../utils/noteRenderer.js";

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
    this.palette = null;

    // Content bounds
    this.contentWidth = 0;
    this.contentHeight = 0;

    // Performance tracking
    this.lastRenderTime = 0;

    // Zoom debounce
    this.zoomRenderTimeout = null;
    this.zoomRenderDebounce = 150; // ms

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
    this.canvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: top left;
      will-change: transform;
    `;

    this.ctx = this.canvas.getContext("2d");
    this.viewportElement.appendChild(this.canvas);
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
  }

  /**
   * Set the spatial index for efficient queries
   * @param {SpatialIndex} index
   */
  setSpatialIndex(index) {
    this.spatialIndex = index;
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
   * Set the total content height (convenience method)
   * @param {number} height
   */
  setContentHeight(height) {
    this.contentHeight = height;
  }

  /**
   * Resize the canvas for the given viewport dimensions
   * @param {number} width - Viewport width (screen pixels)
   * @param {number} height - Viewport height (screen pixels)
   */
  resize(width, height) {
    this.screenViewportWidth = width;
    // Content width is capped at maxContentWidth
    this.viewportWidth = Math.min(width, this.maxContentWidth);
    this.viewportHeight = height;
    this.bufferHeight = height * this.bufferMultiplier;

    this._resizeCanvasBitmap();
    this._updateCanvasPosition();
  }

  /**
   * Update canvas position (centering when needed)
   * @private
   */
  _updateCanvasPosition() {
    const scaledContentWidth = this.viewportWidth * this.zoomScale;

    if (scaledContentWidth < this.screenViewportWidth) {
      // Canvas is smaller than viewport - center it
      // Use relative positioning within flexbox parent
      this.canvas.style.position = "relative";
      this.canvas.style.left = "0";
    } else {
      // Canvas fills or exceeds viewport - position absolutely
      this.canvas.style.position = "absolute";
      this.canvas.style.left = "0";
    }
  }

  /**
   * Resize the canvas bitmap based on current dimensions and zoom
   * @private
   */
  _resizeCanvasBitmap() {
    // Calculate resolution scale (for crisp rendering when zoomed in)
    this.resolutionScale = Math.min(Math.max(1.0, this.zoomScale), this.maxResolutionScale);

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
   */
  render(scrollTop, viewportHeight, scrollLeft = 0) {
    // Convert to content coordinates (account for zoom)
    const contentScrollTop = scrollTop / this.zoomScale;
    const contentViewportHeight = viewportHeight / this.zoomScale;

    // Update viewport height if changed significantly
    if (Math.abs(contentViewportHeight - this.viewportHeight) > 1) {
      this.resize(this.screenViewportWidth, contentViewportHeight);
    }

    // Check if we need to leapfrog (reposition buffer)
    if (this._shouldLeapfrog(contentScrollTop)) {
      this._repositionBuffer(contentScrollTop);
    }
    // Always slide the canvas to match scroll position
    this._slideCanvas(contentScrollTop, scrollLeft);
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
    const screenOffsetX = -scrollLeft;
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

    // Redraw the buffer
    this._drawBuffer();
  }

  /**
   * Draw the entire buffer content
   * @private
   */
  _drawBuffer() {
    const startTime = performance.now();

    // Clear canvas
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    // Ensure palette is current
    if (!this.palette) {
      this.palette = sharedGetThemePalette();
    }

    // Draw background for buffer region
    if (this.background && this.background !== "none") {
      this._drawBackground();
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

    // Draw strokes with offset for buffer position
    this.ctx.save();
    this.ctx.translate(0, -this.bufferTop);

    for (const index of strokeIndices) {
      const stroke = this.strokes[index];
      if (stroke) {
        sharedDrawStroke(this.ctx, stroke, this.palette, false);
      }
    }

    this.ctx.restore();

    this.lastRenderTime = performance.now() - startTime;
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
   */
  setZoom(scale, options = {}) {
    this.zoomScale = scale;

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
   * Force a full redraw of the current buffer
   */
  forceRedraw() {
    this.palette = sharedGetThemePalette();
    this._drawBuffer();
  }

  /**
   * Get render statistics
   * @returns {Object}
   */
  getStats() {
    return {
      bufferTop: this.bufferTop,
      bufferHeight: this.bufferHeight,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      contentWidth: this.contentWidth,
      contentHeight: this.contentHeight,
      zoomScale: this.zoomScale,
      resolutionScale: this.resolutionScale,
      lastRenderTime: this.lastRenderTime,
      canvasSize: `${this.canvas.width}x${this.canvas.height}`,
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.zoomRenderTimeout) {
      clearTimeout(this.zoomRenderTimeout);
    }

    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }

    this.canvas = null;
    this.ctx = null;
    this.strokes = [];
    this.spatialIndex = null;
  }
}
