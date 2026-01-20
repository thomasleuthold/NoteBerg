/**
 * NoteCanvas - Main entry point for virtualized note rendering
 *
 * Coordinates the VirtualScroller, CanvasRenderer, and SpatialIndex
 * to provide smooth 60fps scrolling and instant zoom for large notes.
 *
 * Phase 1: Read-only rendering only.
 */

import { getNote } from "../../modules/storage.js";
import { CanvasRenderer } from "./CanvasRenderer.js";
import { SpatialIndex } from "./SpatialIndex.js";
import { VirtualScroller } from "./VirtualScroller.js";

export class NoteCanvas {
  /**
   * @param {HTMLElement} containerElement - Container to mount into
   */
  constructor(containerElement) {
    this.containerElement = containerElement;

    // Modules
    this.scroller = null;
    this.renderer = null;
    this.spatialIndex = null;

    // State
    this.noteId = null;
    this.noteData = null;
    this.isInitialized = false;

    // Zoom state
    this.zoomScale = 1.0;
    this.minZoom = 0.25;
    this.maxZoom = 2.0;
    this.zoomStep = 0.1;

    // Gesture tracking
    this.lastTouchDistance = null;
    this.initialPinchZoom = null;

    // Bind methods
    this._onScroll = this._onScroll.bind(this);
    this._onViewportResize = this._onViewportResize.bind(this);
    this._onThemeChange = this._onThemeChange.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
  }

  /**
   * Load and render a note
   * @param {string} noteId - ID of the note to load
   */
  async load(noteId) {
    this.noteId = noteId;

    // Fetch note data
    this.noteData = await getNote(noteId);
    if (!this.noteData) {
      console.error("[NoteCanvas] Note not found:", noteId);
      return;
    }

    console.log(`[NoteCanvas] Loading note with ${this.noteData.strokes?.length || 0} strokes`);

    // Initialize scroller
    this.scroller = new VirtualScroller(this.containerElement, {
      onScroll: this._onScroll,
      onViewportResize: this._onViewportResize,
    });

    // Get initial viewport dimensions
    const { width, height } = this.scroller.getViewportSize();

    // Build spatial index with bucket height = viewport height
    this.spatialIndex = new SpatialIndex(height || 800);
    this.spatialIndex.build(this.noteData.strokes || []);

    // Calculate content height
    const contentBounds = this.spatialIndex.getContentBounds();
    const contentHeight = contentBounds
      ? Math.max(contentBounds.maxY + 100, height) // Add padding below content
      : height;

    // Initialize renderer
    this.renderer = new CanvasRenderer(this.scroller.getViewportElement());
    this.renderer.setData(this.noteData.strokes || [], this.noteData.background);
    this.renderer.setSpatialIndex(this.spatialIndex);
    this.renderer.setContentHeight(contentHeight);
    this.renderer.resize(width, height);

    // Set content height in scroller
    this.scroller.setContentHeight(contentHeight);

    // Initial render
    this.renderer.render(0, height);

    // Set up event listeners
    this._setupEventListeners();

    this.isInitialized = true;

    // Log stats for debugging
    console.log("[NoteCanvas] Initialized:", {
      strokes: this.noteData.strokes?.length || 0,
      contentHeight,
      indexStats: this.spatialIndex.getStats(),
    });

    // Expose for debugging
    window.__noteCanvas = this;
  }

  /**
   * Set up global event listeners
   * @private
   */
  _setupEventListeners() {
    // Theme changes
    window.addEventListener("themechange", this._onThemeChange);

    // Zoom via mouse wheel
    const viewport = this.scroller.getViewportElement();
    viewport.addEventListener("wheel", this._onWheel, { passive: false });

    // Zoom via pinch gesture
    viewport.addEventListener("touchstart", this._onTouchStart, { passive: false });
    viewport.addEventListener("touchmove", this._onTouchMove, { passive: false });
    viewport.addEventListener("touchend", this._onTouchEnd, { passive: true });
  }

  /**
   * Handle scroll events from VirtualScroller
   * @private
   */
  _onScroll(scrollTop, viewportHeight) {
    if (!this.renderer) return;
    this.renderer.render(scrollTop, viewportHeight);
  }

  /**
   * Handle viewport resize events
   * @private
   */
  _onViewportResize(width, height) {
    if (!this.renderer || !this.spatialIndex) return;

    // Update spatial index bucket size
    this.spatialIndex.setBucketHeight(height, this.noteData?.strokes || []);

    // Resize renderer
    this.renderer.resize(width, height);

    // Re-render
    const scrollTop = this.scroller.getScrollTop();
    this.renderer.render(scrollTop, height);
  }

  /**
   * Handle theme changes
   * @private
   */
  _onThemeChange() {
    if (!this.renderer) return;
    this.renderer.forceRedraw();
  }

  /**
   * Handle wheel events for zoom
   * @private
   */
  _onWheel(e) {
    // Only zoom if Ctrl/Cmd is held
    if (!e.ctrlKey && !e.metaKey) return;

    e.preventDefault();

    // Calculate new zoom
    const delta = e.deltaY > 0 ? -this.zoomStep : this.zoomStep;
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomScale + delta));

    if (newZoom !== this.zoomScale) {
      this.setZoom(newZoom);
    }
  }

  /**
   * Handle touch start for pinch zoom
   * @private
   */
  _onTouchStart(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      this.lastTouchDistance = this._getTouchDistance(e.touches);
      this.initialPinchZoom = this.zoomScale;
    }
  }

  /**
   * Handle touch move for pinch zoom
   * @private
   */
  _onTouchMove(e) {
    if (e.touches.length === 2 && this.lastTouchDistance !== null) {
      e.preventDefault();

      const currentDistance = this._getTouchDistance(e.touches);
      const scale = currentDistance / this.lastTouchDistance;
      const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.initialPinchZoom * scale));

      if (newZoom !== this.zoomScale) {
        this.setZoom(newZoom, { immediate: false });
      }
    }
  }

  /**
   * Handle touch end for pinch zoom
   * @private
   */
  _onTouchEnd(e) {
    if (e.touches.length < 2) {
      this.lastTouchDistance = null;
      this.initialPinchZoom = null;

      // Trigger final zoom render
      if (this.renderer) {
        this.setZoom(this.zoomScale, { immediate: true });
      }
    }
  }

  /**
   * Calculate distance between two touch points
   * @private
   */
  _getTouchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Set zoom level
   * @param {number} scale - Zoom scale (1.0 = 100%)
   * @param {Object} options
   * @param {boolean} options.immediate - Render immediately vs debounced
   */
  setZoom(scale, options = {}) {
    this.zoomScale = scale;

    if (this.scroller) {
      this.scroller.setZoom(scale);
    }

    if (this.renderer) {
      const scrollTop = this.scroller?.getScrollTop() || 0;
      this.renderer.setZoom(scale, {
        ...options,
        scrollTop,
      });
    }
  }

  /**
   * Get current viewport info
   * @returns {Object}
   */
  getViewport() {
    if (!this.scroller) return null;
    return {
      ...this.scroller.getViewportBounds(),
      zoom: this.zoomScale,
    };
  }

  /**
   * Unload the current note (called before loading another)
   */
  unload() {
    // Nothing to save in Phase 1 (read-only)
    console.log("[NoteCanvas] Unloading note:", this.noteId);
  }

  /**
   * Clean up all resources
   */
  destroy() {
    // Unload first
    this.unload();

    // Remove event listeners
    window.removeEventListener("themechange", this._onThemeChange);

    if (this.scroller) {
      const viewport = this.scroller.getViewportElement();
      if (viewport) {
        viewport.removeEventListener("wheel", this._onWheel);
        viewport.removeEventListener("touchstart", this._onTouchStart);
        viewport.removeEventListener("touchmove", this._onTouchMove);
        viewport.removeEventListener("touchend", this._onTouchEnd);
      }
    }

    // Destroy modules
    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }

    if (this.scroller) {
      this.scroller.destroy();
      this.scroller = null;
    }

    if (this.spatialIndex) {
      this.spatialIndex.clear();
      this.spatialIndex = null;
    }

    // Clear state
    this.noteId = null;
    this.noteData = null;
    this.isInitialized = false;

    // Clear debug reference
    if (window.__noteCanvas === this) {
      window.__noteCanvas = null;
    }
  }
}
