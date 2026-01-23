/**
 * NoteCanvas - Main entry point for virtualized note rendering
 *
 * Coordinates the VirtualScroller, CanvasRenderer, and SpatialIndex
 * to provide smooth 60fps scrolling and instant zoom for large notes.
 * Supports both viewing and drawing with stylus/pen input.
 */

import { getNote } from "../../modules/storage.js";
import { CanvasRenderer } from "./CanvasRenderer.js";
import { InputHandler } from "./InputHandler.js";
import "./NoteCanvas.css";
import { NoteToolbar } from "./NoteToolbar.js";
import { SpatialIndex } from "./SpatialIndex.js";
import { StrokeManager } from "./StrokeManager.js";
import { VirtualScroller } from "./VirtualScroller.js";

export class NoteCanvas {
  /**
   * @param {HTMLElement} containerElement - Container to mount into
   * @param {Object} options
   * @param {number} options.maxContentWidth - Maximum content width (default 1200)
   */
  constructor(containerElement, options = {}) {
    this.containerElement = containerElement;
    this.maxContentWidth = options.maxContentWidth || 1200;

    // Modules
    this.scroller = null;
    this.renderer = null;
    this.spatialIndex = null;
    this.inputHandler = null;
    this.strokeManager = null;
    this.toolbar = null;
    this.contentHeight = 0;

    // State
    this.noteId = null;
    this.noteData = null;
    this.isInitialized = false;

    // Zoom state
    this.zoomScale = 1.0;
    this.minZoom = 0.5;
    this.maxZoom = 4.0;
    this.zoomStep = 0.05;

    // Gesture tracking
    this.activePointers = new Map();
    this.lastTouchDistance = null;
    this.initialPinchZoom = null;
    this._isZooming = false; // Flag to suppress scroll events during zoom
    this.lastTouchX = null;
    this.lastTouchY = null;

    // Drawing state
    this.isDrawMode = false; // false = Pan Mode, true = Draw Mode
    this.isEraserMode = false;
    this.currentPenColorIndex = 0;
    this.currentPenWidth = 2;
    this.autoSwitchedToDrawMode = false;

    // Bind methods
    this._onScroll = this._onScroll.bind(this);
    this._onViewportResize = this._onViewportResize.bind(this);
    this._onThemeChange = this._onThemeChange.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onPointerDownNav = this._onPointerDownNav.bind(this);
    this._onPointerMoveNav = this._onPointerMoveNav.bind(this);
    this._onPointerUpNav = this._onPointerUpNav.bind(this);
    this._onStrokeStart = this._onStrokeStart.bind(this);
    this._onStrokeMove = this._onStrokeMove.bind(this);
    this._onStrokeEnd = this._onStrokeEnd.bind(this);
    this._toggleMode = this._toggleMode.bind(this);
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

    // Ensure strokes array exists and is shared across modules
    if (!this.noteData.strokes) {
      this.noteData.strokes = [];
    }
    if (!this.noteData.deletedStrokes) {
      this.noteData.deletedStrokes = [];
    }

    // Clear container and setup layout
    this.containerElement.innerHTML = "";
    this.containerElement.className = "note-canvas";

    // 1. Toolbar Container (Fixed height at top)
    const toolbarContainer = document.createElement("div");
    toolbarContainer.className = "note-canvas__toolbar-container";
    this.containerElement.appendChild(toolbarContainer);

    // 2. Scroller Container (Canvas Area - fills remaining space)
    const scrollerContainer = document.createElement("div");
    scrollerContainer.className = "note-canvas__scroller-container";
    this.containerElement.appendChild(scrollerContainer);

    // Initialize scroller
    this.scroller = new VirtualScroller(scrollerContainer, {
      onScroll: this._onScroll,
      onViewportResize: this._onViewportResize,
      maxContentWidth: this.maxContentWidth,
    });

    // Get initial viewport dimensions
    const { width, height } = this.scroller.getViewportSize();

    // Build spatial index with bucket height = viewport height
    this.spatialIndex = new SpatialIndex(height || 800);
    this.spatialIndex.build(this.noteData.strokes);

    // Calculate content dimensions
    const contentBounds = this.spatialIndex.getContentBounds();
    this.contentHeight = contentBounds
      ? Math.max(contentBounds.maxY + 500, height) // Add padding below content
      : height;
    const contentWidth = this.maxContentWidth;

    // Initialize renderer
    this.renderer = new CanvasRenderer(this.scroller.getViewportElement(), {
      maxContentWidth: this.maxContentWidth,
    });
    this.renderer.setData(this.noteData.strokes, this.noteData.background);
    this.renderer.setSpatialIndex(this.spatialIndex);
    this.renderer.setContentSize(contentWidth, this.contentHeight);
    this.renderer.resize(width, height);

    // Initialize stroke manager
    this.strokeManager = new StrokeManager(
      noteId,
      this.noteData.strokes,
      this.noteData.deletedStrokes,
    );

    // Set content size in scroller
    this.scroller.setContentSize(contentWidth, this.contentHeight);

    // Initial render
    this.renderer.render(0, height);

    // Set up event listeners
    this._setupEventListeners();

    // Initialize input handler
    this.inputHandler = new InputHandler(
      this.scroller.getViewportElement(),
      {
        getZoom: () => this.zoomScale,
        getScroll: () => ({
          left: this.scroller.getScrollLeft(),
          top: this.scroller.getScrollTop(),
        }),
        getRect: () => this.scroller.getViewportElement().getBoundingClientRect(),
        getOffset: () => {
          const viewportWidth = this.scroller.getViewportSize().width;
          const contentWidth = this.maxContentWidth;
          const scaledContentWidth = contentWidth * this.zoomScale;

          if (scaledContentWidth < viewportWidth) {
            return { x: (viewportWidth - scaledContentWidth) / 2, y: 0 };
          }
          return { x: 0, y: 0 };
        },
      },
      {
        onStrokeStart: this._onStrokeStart,
        onStrokeMove: this._onStrokeMove,
        onStrokeEnd: this._onStrokeEnd,
      },
    );

    // Create Toolbar
    this.toolbar = new NoteToolbar(toolbarContainer, (mode) => {
      this._setMode(mode);
    });
    this.toolbar.updateMode(this.isDrawMode);

    this.isInitialized = true;

    // Log stats for debugging
    console.log("[NoteCanvas] Initialized:", {
      strokes: this.noteData.strokes?.length || 0,
      contentHeight: this.contentHeight,
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

    // Navigation (Pan/Zoom) via Pointer Events
    viewport.addEventListener("pointerdown", this._onPointerDownNav);
    viewport.addEventListener("pointermove", this._onPointerMoveNav);
    viewport.addEventListener("pointerup", this._onPointerUpNav);
    viewport.addEventListener("pointercancel", this._onPointerUpNav);
    viewport.addEventListener("pointerleave", this._onPointerUpNav);
  }

  /**
   * Handle scroll events from VirtualScroller
   * @private
   */
  _onScroll(scrollTop, scrollLeft, viewportHeight) {
    if (this._isZooming) return;

    // Infinite scroll expansion
    const contentScrollTop = scrollTop / this.zoomScale;
    const contentViewportHeight = viewportHeight / this.zoomScale;

    if (this.contentHeight > 0) {
      const distanceToBottom = this.contentHeight - (contentScrollTop + contentViewportHeight);
      if (distanceToBottom < 500) {
        this._expandCanvas(1000);
      }
    }

    if (!this.renderer) return;
    this.renderer.render(scrollTop, viewportHeight, scrollLeft, this.strokeManager?.currentStroke);
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
    const scrollLeft = this.scroller.getScrollLeft();
    this.renderer.render(scrollTop, height, scrollLeft, this.strokeManager?.currentStroke);
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
   * Expand canvas height for infinite scrolling
   * @private
   */
  _expandCanvas(amount) {
    this.contentHeight += amount;
    this.scroller.setContentSize(this.maxContentWidth, this.contentHeight);
    this.renderer.setContentSize(this.maxContentWidth, this.contentHeight);
  }

  /**
   * Set the current tool mode
   * @param {string} mode - 'pan' | 'draw' | 'eraser'
   */
  _setMode(mode) {
    this.isDrawMode = mode === "draw" || mode === "eraser";
    this.isEraserMode = mode === "eraser";
    this.autoSwitchedToDrawMode = false;

    if (this.toolbar) {
      this.toolbar.updateMode(mode);
    }
  }

  // Legacy toggle for internal calls
  _toggleMode(enableDraw) {
    if (enableDraw) {
      this._setMode("draw");
    } else {
      this._setMode("pan");
    }
  }

  /**
   * Handle stroke start
   * @private
   */
  _onStrokeStart(props) {
    // Auto-switch to draw mode if pen detected
    if (props.pointerType === "pen" && !this.isDrawMode) {
      this._toggleMode(true);
      this.autoSwitchedToDrawMode = true;
    }

    // In Draw Mode: Pen draws, Touch scrolls (unless we add a "Finger Draw" toggle later)
    // In Pan Mode: Everything scrolls
    if (!this.isDrawMode) return false;
    // If auto-switched to draw mode (by pen), touch should still scroll (palm rejection behavior)
    if (this.autoSwitchedToDrawMode && props.pointerType === "touch") return false;

    if (this.isEraserMode) {
      this._handleEraser(props.x, props.y, props.clientX, props.clientY);
      return true;
    }

    const stroke = this.strokeManager.startStroke({
      ...props,
      colorIndex: this.currentPenColorIndex,
      width: this.currentPenWidth,
    });

    this.renderer.drawDirectStroke(stroke);
    return true;
  }

  /**
   * Handle stroke move
   * @private
   */
  _onStrokeMove(points) {
    if (this.isEraserMode) {
      const lastPoint = points[points.length - 1];
      // Use the last point for cursor update and erasing
      this._handleEraser(lastPoint.x, lastPoint.y, lastPoint.clientX, lastPoint.clientY);
      return;
    }

    const stroke = this.strokeManager.addPoints(points);
    if (stroke) {
      this.renderer.drawDirectStroke(stroke);
    }
  }

  /**
   * Handle stroke end
   * @private
   */
  _onStrokeEnd() {
    if (this.isEraserMode) {
      this.renderer.clearOverlay();
      return;
    }

    const stroke = this.strokeManager.endStroke();
    if (stroke) {
      // Update spatial index so the stroke is included in future buffer redraws (scroll/zoom)
      const newIndex = this.noteData.strokes.length - 1;
      this.spatialIndex.insert(stroke, newIndex);
    }
  }

  /**
   * Handle eraser logic
   * @private
   */
  _handleEraser(contentX, contentY, clientX, clientY) {
    // 1. Draw cursor
    const rect = this.scroller.getViewportElement().getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    const eraserRadius = 10; // Screen pixels
    this.renderer.drawEraserCursor(screenX, screenY, eraserRadius);

    // 2. Erase strokes
    // Convert screen radius to content radius for hit testing
    const contentRadius = eraserRadius / this.zoomScale;
    const queryPadding = contentRadius;

    // Query potential hits
    const candidates = this.spatialIndex.query(contentY - queryPadding, contentY + queryPadding);
    let didErase = false;

    for (const index of candidates) {
      const stroke = this.noteData.strokes[index];
      if (stroke._deleted) continue;

      if (this._strokeIntersectsCircle(stroke, contentX, contentY, contentRadius)) {
        stroke._deleted = true;
        didErase = true;
        if (stroke.id) {
          this.noteData.deletedStrokes.push(stroke.id);
        }
      }
    }

    if (didErase) {
      this.renderer.forceRedraw();
      this.strokeManager.forceSave(); // Save changes
    }
  }

  _strokeIntersectsCircle(stroke, cx, cy, r) {
    // Simple bounding box check first
    // (Optimization: SpatialIndex query already did a rough Y check, but X check is needed)
    // For now, just checking points. A proper segment-circle intersection is better but more expensive.
    // Checking if any point is within radius is a fast approximation for high-sample-rate strokes.
    const rSq = r * r;
    return stroke.x.some((x, i) => {
      const dx = x - cx;
      const dy = stroke.y[i] - cy;
      return dx * dx + dy * dy <= rSq;
    });
  }

  /**
   * Handle wheel events for zoom
   * @private
   */
  _onWheel(e) {
    // Only zoom if Ctrl/Cmd is held
    if (!e.ctrlKey && !e.metaKey) return;

    e.preventDefault();

    // Calculate fixed point relative to viewport
    const rect = this.scroller.getViewportElement().getBoundingClientRect();
    const fixedPoint = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    // Calculate new zoom
    const delta = e.deltaY > 0 ? -this.zoomStep : this.zoomStep;
    const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoomScale + delta));

    if (newZoom !== this.zoomScale) {
      this.setZoom(newZoom, { fixedPoint });
    }
  }

  /**
   * Handle pointer down for navigation (Pan/Zoom)
   * @private
   */
  _onPointerDownNav(e) {
    // Ignore pen inputs for navigation (handled by InputHandler/StrokeManager)
    if (e.pointerType === "pen") return;
    // Only allow touch for panning/zooming (mouse uses wheel/scrollbars)
    if (e.pointerType !== "touch") return;

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size === 2) {
      // Start Pinch
      this._isZooming = true;
      this.lastTouchDistance = this._getPointersDistance();
      this.initialPinchZoom = this.zoomScale;
    } else if (this.activePointers.size === 1) {
      // Start Pan
      this.lastTouchX = e.clientX;
      this.lastTouchY = e.clientY;
    }
  }

  /**
   * Handle pointer move for navigation
   * @private
   */
  _onPointerMoveNav(e) {
    if (!this.activePointers.has(e.pointerId)) return;

    // Update pointer position
    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.activePointers.size === 2) {
      // Pinch Zoom
      e.preventDefault();

      const points = Array.from(this.activePointers.values());
      const rect = this.scroller.getViewportElement().getBoundingClientRect();

      const fixedPoint = {
        x: (points[0].x + points[1].x) / 2 - rect.left,
        y: (points[0].y + points[1].y) / 2 - rect.top,
      };

      const currentDistance = this._getPointersDistance();
      const scale = currentDistance / this.lastTouchDistance;
      const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.initialPinchZoom * scale));

      if (newZoom !== this.zoomScale) {
        this.setZoom(newZoom, { immediate: false, fixedPoint });
      }
    } else if (this.activePointers.size === 1) {
      // Pan
      // If in manual draw mode, single touch should draw, not pan
      if (this.isDrawMode && !this.autoSwitchedToDrawMode) return;

      const x = e.clientX;
      const y = e.clientY;
      const dx = x - this.lastTouchX;
      const dy = y - this.lastTouchY;

      this.lastTouchX = x;
      this.lastTouchY = y;

      this.scroller.scrollBy(-dx, -dy);
    }
  }

  /**
   * Handle pointer up/cancel/leave for navigation
   * @private
   */
  _onPointerUpNav(e) {
    if (this.activePointers.has(e.pointerId)) {
      this.activePointers.delete(e.pointerId);

      // Reset gesture states
      if (this.activePointers.size < 2) {
        if (this._isZooming) {
          this._isZooming = false;
          if (this.renderer) {
            this.setZoom(this.zoomScale, { immediate: true });
          }
        }
        this.lastTouchDistance = null;
        this.initialPinchZoom = null;
      }

      if (this.activePointers.size === 0) {
        this.lastTouchX = null;
        this.lastTouchY = null;
      } else if (this.activePointers.size === 1) {
        // Switch back to pan mode with remaining finger
        const point = this.activePointers.values().next().value;
        this.lastTouchX = point.x;
        this.lastTouchY = point.y;
      }
    }
  }

  /**
   * Calculate distance between first two active pointers
   * @private
   */
  _getPointersDistance() {
    const points = Array.from(this.activePointers.values());
    if (points.length < 2) return 0;
    const dx = points[0].x - points[1].x;
    const dy = points[0].y - points[1].y;
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
      this.scroller.setZoom(scale, options.fixedPoint);
    }

    if (this.renderer) {
      const scrollTop = this.scroller?.getScrollTop() || 0;
      const scrollLeft = this.scroller?.getScrollLeft() || 0;
      this.renderer.setZoom(scale, {
        ...options,
        scrollTop,
        scrollLeft,
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
        viewport.removeEventListener("pointerdown", this._onPointerDownNav);
        viewport.removeEventListener("pointermove", this._onPointerMoveNav);
        viewport.removeEventListener("pointerup", this._onPointerUpNav);
        viewport.removeEventListener("pointercancel", this._onPointerUpNav);
        viewport.removeEventListener("pointerleave", this._onPointerUpNav);
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

    if (this.inputHandler) {
      this.inputHandler.destroy();
      this.inputHandler = null;
    }

    if (this.strokeManager) {
      this.strokeManager.forceSave();
      this.strokeManager.destroy();
    }

    if (this.toolbar) {
      this.toolbar.destroy();
      this.toolbar = null;
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
