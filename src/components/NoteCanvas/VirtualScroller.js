/**
 * VirtualScroller - Decouples scrollbar from canvas
 *
 * Creates a phantom div to establish the scrollable height while keeping
 * the actual canvas viewport in a sticky position. This allows smooth
 * native scrolling without the canvas needing to be sized to the full document.
 */

export class VirtualScroller {
  /**
   * @param {HTMLElement} parentElement - Container element to mount into
   * @param {Object} options
   * @param {function} options.onScroll - Callback: (scrollTop, scrollLeft, viewportHeight) => void
   * @param {function} options.onViewportResize - Callback: (width, height) => void
   * @param {number} options.maxContentWidth - Maximum content width (default 1200)
   * @param {number} options.zoom - Initial zoom scale (default 1.0)
   */
  constructor(parentElement, options = {}) {
    this.parentElement = parentElement;
    this.onScroll = options.onScroll || (() => {});
    this.onViewportResize = options.onViewportResize || (() => {});
    this.maxContentWidth = options.maxContentWidth || 1200;

    // State
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.contentWidth = 0;
    this.contentHeight = 0;
    this.zoomScale = options.zoom || options.zoomScale || 1.0;

    // DOM elements (created in _createDOM)
    this.container = null;
    this.phantomDiv = null;
    this.viewport = null;

    // Observers
    this.resizeObserver = null;

    // Bind methods
    this._handleScroll = this._handleScroll.bind(this);
    this._handleResize = this._handleResize.bind(this);

    // Initialize
    this._createDOM();
    this._setupEventListeners();
  }

  /**
   * Create the DOM structure
   * @private
   */
  _createDOM() {
    // Main scrollable container
    this.container = document.createElement("div");
    this.container.className = "virtual-scroll-container";
    this.container.style.cssText = `
      position: relative;
      overflow: auto;
      height: 100%;
      width: 100%;
    `;

    // Phantom div that establishes scroll dimensions
    this.phantomDiv = document.createElement("div");
    this.phantomDiv.className = "phantom-size";
    this.phantomDiv.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
      visibility: hidden;
    `;

    // Viewport that stays fixed in view (sticky positioning)
    this.viewport = document.createElement("div");
    this.viewport.className = "canvas-viewport";
    this.viewport.style.cssText = `
      position: sticky;
      top: 0;
      left: 0;
      overflow: hidden;
      display: flex;
      align-items: flex-start;
    `;

    // Assemble
    this.container.appendChild(this.phantomDiv);
    this.container.appendChild(this.viewport);
    this.parentElement.appendChild(this.container);

    // Get initial dimensions
    const rect = this.container.getBoundingClientRect();
    this.viewportWidth = rect.width;
    this.viewportHeight = rect.height;

    // Apply initial size and alignment
    this.viewport.style.width = `${this.viewportWidth}px`;
    this.viewport.style.height = `${this.viewportHeight}px`;
    this._updateViewportAlignment();
  }

  /**
   * Set up event listeners
   * @private
   */
  _setupEventListeners() {
    // Scroll listener
    this.container.addEventListener("scroll", this._handleScroll, { passive: true });

    // Resize observer for viewport changes
    this.resizeObserver = new ResizeObserver(this._handleResize);
    this.resizeObserver.observe(this.container);
  }

  /**
   * Handle scroll events
   * @private
   */
  _handleScroll() {
    this.scrollTop = this.container.scrollTop;
    this.scrollLeft = this.container.scrollLeft;
    this.onScroll(this.scrollTop, this.scrollLeft, this.viewportHeight);
  }

  /**
   * Handle resize events
   * @private
   */
  _handleResize(entries) {
    const entry = entries[0];
    if (!entry) return;

    const { width, height } = entry.contentRect;

    // Only trigger if dimensions actually changed
    if (width !== this.viewportWidth || height !== this.viewportHeight) {
      this.viewportWidth = width;
      this.viewportHeight = height;
      this.viewport.style.width = `${width}px`;
      this.viewport.style.height = `${height}px`;
      this._updatePhantomSize();
      this._updateViewportAlignment();
      this.onViewportResize(width, height);
    }
  }

  /**
   * Set the total content dimensions
   * @param {number} width - Content width in pixels (before zoom)
   * @param {number} height - Content height in pixels (before zoom)
   */
  setContentSize(width, height) {
    this.contentWidth = width;
    this.contentHeight = height;
    this._updatePhantomSize();
  }

  /**
   * Set the total content height (convenience method)
   * @param {number} height - Content height in pixels (before zoom)
   */
  setContentHeight(height) {
    this.setContentSize(this.contentWidth || this.maxContentWidth, height);
  }

  /**
   * Set the zoom scale (affects phantom size)
   * @param {number} scale - Zoom scale (1.0 = 100%)
   * @param {Object} [fixedPoint] - Point to keep fixed {x, y} in viewport coordinates
   */
  setZoom(scale, fixedPoint = null) {
    const oldScale = this.zoomScale;
    this.zoomScale = scale;
    this._updatePhantomSize();

    if (fixedPoint) {
      const { x, y } = fixedPoint;

      // Calculate content coordinates of the fixed point using old scale
      const contentX = (this.scrollLeft + x) / oldScale;
      const contentY = (this.scrollTop + y) / oldScale;

      // Calculate new scroll position
      const newScrollLeft = contentX * scale - x;
      const newScrollTop = contentY * scale - y;

      // Apply new scroll position and update state immediately
      this.container.scrollLeft = newScrollLeft;
      this.container.scrollTop = newScrollTop;
      this.scrollLeft = this.container.scrollLeft;
      this.scrollTop = this.container.scrollTop;
    }
  }

  /**
   * Update the phantom div size based on content and zoom
   * @private
   */
  _updatePhantomSize() {
    const scaledWidth = this.contentWidth * this.zoomScale;
    const scaledHeight = this.contentHeight * this.zoomScale;

    // Phantom needs to be at least as big as viewport to allow scrolling
    // When content is smaller than viewport, we don't need phantom to be larger
    const phantomWidth = Math.max(scaledWidth, 1);
    const phantomHeight = Math.max(scaledHeight, 1);

    this.phantomDiv.style.width = `${phantomWidth}px`;
    this.phantomDiv.style.height = `${phantomHeight}px`;
    this._updateViewportAlignment();
  }

  /**
   * Update viewport alignment (center vs start) based on content size
   * @private
   */
  _updateViewportAlignment() {
    if (!this.viewport) return;
    // If content is smaller than viewport, center it.
    // If content is larger, align start so we can scroll to see the rest.
    this.viewport.style.justifyContent = this.shouldCenterCanvas() ? "center" : "flex-start";
  }

  /**
   * Get the current viewport bounds
   * @returns {{ top: number, bottom: number, left: number, right: number, height: number, width: number }}
   */
  getViewportBounds() {
    return {
      top: this.scrollTop / this.zoomScale,
      bottom: (this.scrollTop + this.viewportHeight) / this.zoomScale,
      left: this.scrollLeft / this.zoomScale,
      right: (this.scrollLeft + this.viewportWidth) / this.zoomScale,
      height: this.viewportHeight / this.zoomScale,
      width: this.viewportWidth / this.zoomScale,
    };
  }

  /**
   * Scroll to a specific position
   * @param {number} x - Target X position in content coordinates (before zoom)
   * @param {number} y - Target Y position in content coordinates (before zoom)
   * @param {boolean} smooth - Whether to use smooth scrolling
   */
  scrollTo(x, y, smooth = false) {
    const scaledX = x * this.zoomScale;
    const scaledY = y * this.zoomScale;
    this.container.scrollTo({
      left: scaledX,
      top: scaledY,
      behavior: smooth ? "smooth" : "instant",
    });
  }

  /**
   * Get the viewport element (where canvases should be mounted)
   * @returns {HTMLElement}
   */
  getViewportElement() {
    return this.viewport;
  }

  /**
   * Get current scroll position
   * @returns {{ top: number, left: number }}
   */
  getScrollPosition() {
    return {
      top: this.scrollTop,
      left: this.scrollLeft,
    };
  }

  /**
   * Get current scroll top (convenience method)
   * @returns {number}
   */
  getScrollTop() {
    return this.scrollTop;
  }

  /**
   * Get current scroll left
   * @returns {number}
   */
  getScrollLeft() {
    return this.scrollLeft;
  }

  /**
   * Get current viewport dimensions
   * @returns {{ width: number, height: number }}
   */
  getViewportSize() {
    return {
      width: this.viewportWidth,
      height: this.viewportHeight,
    };
  }

  /**
   * Check if canvas should be centered (when smaller than viewport)
   * @returns {boolean}
   */
  shouldCenterCanvas() {
    const scaledWidth = this.contentWidth * this.zoomScale;
    return scaledWidth < this.viewportWidth;
  }

  /**
   * Clean up event listeners and DOM
   */
  destroy() {
    // Remove event listeners
    this.container.removeEventListener("scroll", this._handleScroll);

    // Disconnect resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Remove DOM elements
    if (this.container?.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }

    this.container = null;
    this.phantomDiv = null;
    this.viewport = null;
  }
}
