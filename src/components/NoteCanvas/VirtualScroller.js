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
   * @param {function} options.onScroll - Callback: (scrollTop, viewportHeight) => void
   * @param {function} options.onViewportResize - Callback: (width, height) => void
   */
  constructor(parentElement, options = {}) {
    this.parentElement = parentElement;
    this.onScroll = options.onScroll || (() => {});
    this.onViewportResize = options.onViewportResize || (() => {});

    // State
    this.scrollTop = 0;
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.contentHeight = 0;
    this.zoomScale = 1.0;

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
      overflow-y: auto;
      overflow-x: hidden;
      height: 100%;
      width: 100%;
    `;

    // Phantom div that establishes scroll height
    this.phantomDiv = document.createElement("div");
    this.phantomDiv.className = "phantom-height";
    this.phantomDiv.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 1px;
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
      width: 100%;
      height: 100%;
      overflow: hidden;
    `;

    // Assemble
    this.container.appendChild(this.phantomDiv);
    this.container.appendChild(this.viewport);
    this.parentElement.appendChild(this.container);

    // Get initial dimensions
    const rect = this.container.getBoundingClientRect();
    this.viewportWidth = rect.width;
    this.viewportHeight = rect.height;
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
    this.onScroll(this.scrollTop, this.viewportHeight);
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
      this.onViewportResize(width, height);
    }
  }

  /**
   * Set the total content height
   * @param {number} height - Content height in pixels (before zoom)
   */
  setContentHeight(height) {
    this.contentHeight = height;
    this._updatePhantomHeight();
  }

  /**
   * Set the zoom scale (affects phantom height)
   * @param {number} scale - Zoom scale (1.0 = 100%)
   */
  setZoom(scale) {
    this.zoomScale = scale;
    this._updatePhantomHeight();
  }

  /**
   * Update the phantom div height based on content and zoom
   * @private
   */
  _updatePhantomHeight() {
    const scaledHeight = this.contentHeight * this.zoomScale;
    this.phantomDiv.style.height = `${scaledHeight}px`;
  }

  /**
   * Get the current viewport bounds
   * @returns {{ top: number, bottom: number, height: number, width: number }}
   */
  getViewportBounds() {
    return {
      top: this.scrollTop / this.zoomScale,
      bottom: (this.scrollTop + this.viewportHeight) / this.zoomScale,
      height: this.viewportHeight / this.zoomScale,
      width: this.viewportWidth / this.zoomScale,
    };
  }

  /**
   * Scroll to a specific Y position
   * @param {number} y - Target Y position in content coordinates (before zoom)
   * @param {boolean} smooth - Whether to use smooth scrolling
   */
  scrollTo(y, smooth = false) {
    const scaledY = y * this.zoomScale;
    this.container.scrollTo({
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
   * @returns {number}
   */
  getScrollTop() {
    return this.scrollTop;
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
