/**
 * PdfTextLayerManager - Manages PDF.js text layers for text selection
 *
 * Creates and positions invisible text overlays on top of PDF pages,
 * enabling native browser text selection and copying.
 *
 * Only renders text layers for visible pages (virtualization).
 */

import { TextLayer } from "pdfjs-dist";
import { loadPdfPage } from "../../modules/pdfManager.js";

export class PdfTextLayerManager {
  /**
   * @param {HTMLElement} viewportElement - The viewport element to mount into
   * @param {Object} mediaManager - MediaManager instance to get PDF items
   */
  constructor(viewportElement, mediaManager) {
    this.viewportElement = viewportElement;
    this.mediaManager = mediaManager;

    // Container for all text layers
    this.container = null;

    // Map of active text layers: pageId -> { element, textLayer, viewport, item }
    this.activeLayers = new Map();

    // Cache for text content to avoid re-fetching
    this.textContentCache = new Map();

    // Current state
    this.mode = "pan";
    this.zoom = 1.0;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.centeringOffset = 0;
    this.viewportHeight = 0;

    // Buffer pages above/below viewport
    this.bufferPages = 1;

    // Debounce layer creation to avoid thrashing
    this._createLayerDebounceTimers = new Map();
    this._createLayerDebounceMs = 100;

    this._createContainer();
  }

  /**
   * Create the container element for text layers
   * @private
   */
  _createContainer() {
    this.container = document.createElement("div");
    this.container.className = "note-canvas__text-layers";
    this.viewportElement.appendChild(this.container);
  }

  /**
   * Update text layers based on current viewport state
   * @param {Object} viewportBounds - { top, bottom, left, right } in content coords
   * @param {number} zoom - Current zoom scale
   * @param {number} scrollLeft - Scroll left in screen pixels
   * @param {number} scrollTop - Scroll top in screen pixels
   * @param {number} centeringOffset - X offset for centering in screen pixels
   * @param {number} viewportHeight - Viewport height in screen pixels
   */
  update(viewportBounds, zoom, scrollLeft, scrollTop, centeringOffset, viewportHeight) {
    this.zoom = zoom;
    this.scrollLeft = scrollLeft;
    this.scrollTop = scrollTop;
    this.centeringOffset = centeringOffset;
    this.viewportHeight = viewportHeight;

    // Get all PDF page items
    const pdfPages = this.mediaManager.getItems().filter((i) => i.type === "pdf-page");

    if (pdfPages.length === 0) {
      this._removeAllLayers();
      return;
    }

    // Find visible pages with buffer
    const visiblePageIds = this._getVisiblePageIds(pdfPages, viewportBounds);

    // Remove layers for pages no longer visible
    for (const pageId of this.activeLayers.keys()) {
      if (!visiblePageIds.has(pageId)) {
        this._removeLayer(pageId);
      }
    }

    // Create/update layers for visible pages
    for (const pageId of visiblePageIds) {
      const item = pdfPages.find((p) => p.id === pageId);
      if (!item) continue;

      if (!this.activeLayers.has(pageId)) {
        this._scheduleLayerCreation(pageId, item);
      } else {
        this._updateLayerPosition(pageId);
      }
    }
  }

  /**
   * Get IDs of pages visible in viewport (with buffer)
   * @private
   */
  _getVisiblePageIds(pdfPages, viewportBounds) {
    const visibleIds = new Set();
    const bufferPixels = this.viewportHeight / this.zoom; // Buffer in content coords

    for (const page of pdfPages) {
      const pageTop = page.y;
      const pageBottom = page.y + page.height;

      // Check if page overlaps with viewport (including buffer)
      const inView =
        pageBottom >= viewportBounds.top - bufferPixels &&
        pageTop <= viewportBounds.bottom + bufferPixels;

      if (inView) {
        visibleIds.add(page.id);
      }
    }

    return visibleIds;
  }

  /**
   * Schedule layer creation with debounce
   * @private
   */
  _scheduleLayerCreation(pageId, item) {
    // Clear any existing timer
    if (this._createLayerDebounceTimers.has(pageId)) {
      clearTimeout(this._createLayerDebounceTimers.get(pageId));
    }

    const timer = setTimeout(() => {
      this._createLayerDebounceTimers.delete(pageId);
      // Check again if still needed (may have scrolled away)
      if (!this.activeLayers.has(pageId)) {
        this._createLayer(pageId, item);
      }
    }, this._createLayerDebounceMs);

    this._createLayerDebounceTimers.set(pageId, timer);
  }

  /**
   * Create a text layer for a PDF page
   * @private
   */
  async _createLayer(pageId, item) {
    try {
      // Create container div
      const div = document.createElement("div");
      div.className = "note-canvas__text-layer textLayer";
      div.dataset.pageId = pageId;

      // Store placeholder immediately to prevent duplicate creation
      this.activeLayers.set(pageId, { element: div, textLayer: null, viewport: null, item });
      this.container.appendChild(div);

      // Load PDF page (fileId is the storage key for the PDF file)
      const page = await loadPdfPage(item.fileId, item.pageIndex);

      // Get text content (cached or fetch)
      let textContent = this.textContentCache.get(pageId);
      if (!textContent) {
        textContent = await page.getTextContent({ normalizeWhitespace: true });
        this.textContentCache.set(pageId, textContent);
      }

      // Get viewport at scale 1.0 (we'll scale via CSS transform)
      const viewport = page.getViewport({ scale: 1.0 });

      // Create text layer using PDF.js TextLayer API
      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: div,
        viewport: viewport,
      });

      await textLayer.render();

      // Update stored layer info
      const layer = this.activeLayers.get(pageId);
      if (layer) {
        layer.textLayer = textLayer;
        layer.viewport = viewport;
        this._updateLayerPosition(pageId);
      }
    } catch (error) {
      console.error(`[PdfTextLayerManager] Failed to create text layer for ${pageId}:`, error);
      // Remove failed layer
      this._removeLayer(pageId);
    }
  }

  /**
   * Update position of a text layer
   * @private
   */
  _updateLayerPosition(pageId) {
    const layer = this.activeLayers.get(pageId);
    if (!layer || !layer.viewport) return;

    const { element, viewport, item } = layer;

    // Calculate scale: PDF viewport units -> display pixels at current zoom
    // item.width is the display width in content coords
    // viewport.width is the PDF page width in PDF units
    const displayScale = item.width / viewport.width;
    const totalScale = displayScale * this.zoom;

    // Position in screen space
    const screenX = item.x * this.zoom - this.scrollLeft + this.centeringOffset;
    const screenY = item.y * this.zoom - this.scrollTop;

    // Apply transform
    element.style.transform = `translate(${screenX}px, ${screenY}px) scale(${totalScale})`;
    element.style.transformOrigin = "top left";

    // Set dimensions to match PDF viewport (will be scaled by transform)
    element.style.width = `${viewport.width}px`;
    element.style.height = `${viewport.height}px`;
  }

  /**
   * Remove a text layer
   * @private
   */
  _removeLayer(pageId) {
    // Clear any pending creation
    if (this._createLayerDebounceTimers.has(pageId)) {
      clearTimeout(this._createLayerDebounceTimers.get(pageId));
      this._createLayerDebounceTimers.delete(pageId);
    }

    const layer = this.activeLayers.get(pageId);
    if (layer) {
      if (layer.element?.parentNode) {
        layer.element.parentNode.removeChild(layer.element);
      }
      this.activeLayers.delete(pageId);
    }
  }

  /**
   * Remove all text layers
   * @private
   */
  _removeAllLayers() {
    for (const pageId of this.activeLayers.keys()) {
      this._removeLayer(pageId);
    }
  }

  /**
   * Set the current mode (affects text selection interactivity)
   * @param {string} mode - 'pan', 'draw', 'eraser', 'lasso'
   */
  setMode(mode) {
    this.mode = mode;

    // Text selection only enabled in pan mode
    const enableTextSelection = mode === "pan";
    this.container.style.pointerEvents = enableTextSelection ? "auto" : "none";
  }

  /**
   * Clear cached text content (e.g., when PDF is removed)
   * @param {string} pageId - Specific page ID to clear, or null for all
   */
  clearCache(pageId = null) {
    if (pageId) {
      this.textContentCache.delete(pageId);
    } else {
      this.textContentCache.clear();
    }
  }

  /**
   * Handle PDF page removal
   * @param {string} pageId - ID of the removed page
   */
  onPageRemoved(pageId) {
    this._removeLayer(pageId);
    this.clearCache(pageId);
  }

  /**
   * Force refresh all text layers (e.g., after zoom change)
   */
  refresh() {
    for (const pageId of this.activeLayers.keys()) {
      this._updateLayerPosition(pageId);
    }
  }

  /**
   * Clean up all resources
   */
  destroy() {
    // Clear all debounce timers
    for (const timer of this._createLayerDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this._createLayerDebounceTimers.clear();

    // Remove all layers
    this._removeAllLayers();

    // Clear cache
    this.textContentCache.clear();

    // Remove container
    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.viewportElement = null;
    this.mediaManager = null;
  }
}
