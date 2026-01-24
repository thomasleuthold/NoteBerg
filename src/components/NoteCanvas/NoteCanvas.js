/**
 * NoteCanvas - Main entry point for virtualized note rendering
 *
 * Coordinates the VirtualScroller, CanvasRenderer, and SpatialIndex
 * to provide smooth 60fps scrolling and instant zoom for large notes.
 * Supports both viewing and drawing with stylus/pen input.
 */

import { navigateTo } from "../../modules/router.js";
import { deleteNote, getNote, updateNote } from "../../modules/storage.js";
import { showConfirmDialog } from "../modals.js";
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

    // Momentum scrolling
    this.velocityX = 0;
    this.velocityY = 0;
    this.lastMoveTime = 0;
    this.momentumReqId = null;

    // Scroll throttling (requestAnimationFrame batching)
    this._scrollRafId = null;
    this._pendingScroll = null;

    // Drawing state
    this.mode = "pan"; // 'pan' | 'draw' | 'eraser' | 'lasso'
    this.currentPenColorIndex = 0;
    this.currentPenWidth = 2;
    this.autoSwitchedToDrawMode = false;
    this.lassoPoints = []; // Points for lasso selection

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
  }

  /**
   * Check if the note content has changed in storage compared to loaded data
   * Used to determine if a reload is necessary
   * @param {string} noteId
   * @returns {Promise<boolean>}
   */
  async hasContentChanged(noteId) {
    if (noteId !== this.noteId) return true;

    const freshData = await getNote(noteId);
    if (!freshData) return true; // Note deleted?

    // Check strokes count
    const currentStrokesCount = this.noteData.strokes?.length || 0;
    const freshStrokesCount = freshData.strokes?.length || 0;

    // Simple check: if stroke count or background changed, we need reload
    // We ignore metadata changes like 'synced' or 'lastSyncedEtag'
    return (
      currentStrokesCount !== freshStrokesCount || this.noteData.background !== freshData.background
    );
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
    this.toolbar = new NoteToolbar(
      toolbarContainer,
      (mode) => {
        this._setMode(mode);
      },
      {
        onPenSettingsChange: ({ width, colorIndex }) => {
          this.currentPenWidth = width;
          this.currentPenColorIndex = colorIndex;
        },
        onOptionsChange: async (action) => {
          if (action.type === "background") {
            this.noteData.background = action.value;
            this.renderer.background = action.value;
            this.renderer.forceRedraw();
            await updateNote(this.noteId, { background: action.value, modified: Date.now() });
          } else if (action.type === "delete") {
            const confirmed = await showConfirmDialog(
              "Delete Note",
              "Are you sure you want to delete this note?",
              "Delete",
              "btn-danger",
            );
            if (confirmed) {
              await deleteNote(this.noteId);
              navigateTo("overview");
            }
          }
        },
      },
    );
    this.toolbar.updateMode(this.mode);
    this.toolbar.setPenSettings({
      width: this.currentPenWidth,
      colorIndex: this.currentPenColorIndex,
    });

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
   * Uses requestAnimationFrame batching to coalesce multiple scroll events per frame
   * @private
   */
  _onScroll(scrollTop, scrollLeft, viewportHeight) {
    if (this._isZooming) return;

    // Store pending scroll data (overwrites previous if not yet processed)
    this._pendingScroll = { scrollTop, scrollLeft, viewportHeight };

    // Schedule render on next animation frame (coalesces multiple scroll events)
    if (!this._scrollRafId) {
      this._scrollRafId = requestAnimationFrame(() => {
        this._scrollRafId = null;

        if (!this._pendingScroll) return;
        const { scrollTop, scrollLeft, viewportHeight } = this._pendingScroll;
        this._pendingScroll = null;

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
        this.renderer.render(
          scrollTop,
          viewportHeight,
          scrollLeft,
          this.strokeManager?.currentStroke,
        );
      });
    }
  }

  /**
   * Handle viewport resize events
   * @private
   */
  _onViewportResize(width, height) {
    if (!this.renderer || !this.spatialIndex) return;

    // Only rebuild spatial index if height change is very significant (>2x or <0.5x)
    // This avoids expensive O(n) rebuilds on routine resize events
    const currentBucketHeight = this.spatialIndex.bucketHeight;
    const ratio = height / currentBucketHeight;
    if (ratio < 0.5 || ratio > 2.0) {
      this.spatialIndex.setBucketHeight(height, this.noteData?.strokes || []);
    }

    // Resize renderer
    this.renderer.resize(width, height / this.zoomScale);

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
   * @param {string} newMode - 'pan' | 'draw' | 'eraser'
   */
  _setMode(newMode) {
    this.mode = newMode;
    this.autoSwitchedToDrawMode = false;
    this.lassoPoints = [];

    if (this.toolbar) {
      this.toolbar.updateMode(newMode);
    }

    // Clear selection when switching modes (except to pan or lasso)
    if (this.renderer && newMode !== "pan" && newMode !== "lasso") {
      this.renderer.setSelectedStrokes(new Set(), null);
    }
  }

  /**
   * Handle stroke start
   * @private
   */
  _onStrokeStart(props) {
    // Auto-switch to draw mode if pen detected and currently in pan mode
    if (props.pointerType === "pen" && this.mode === "pan") {
      this._setMode("draw");
      this.autoSwitchedToDrawMode = true;
    }

    // In Draw/Eraser Mode: Pen draws/erases, Touch scrolls (unless we add a "Finger Draw" toggle later)
    // In Pan Mode: Everything scrolls
    if (this.mode === "pan") return false;
    // If auto-switched to draw mode (by pen), touch should still scroll (palm rejection behavior)
    if (this.autoSwitchedToDrawMode && props.pointerType === "touch") return false;

    if (this.mode === "eraser") {
      this._handleEraser(props.x, props.y, props.clientX, props.clientY);
      return true;
    }

    if (this.mode === "lasso") {
      // If clicking outside selection, clear it
      if (this.renderer?.selectionBounds) {
        const { minX, minY, maxX, maxY } = this.renderer.selectionBounds;
        const { x, y } = props;
        if (x < minX || x > maxX || y < minY || y > maxY) {
          this.renderer.setSelectedStrokes(new Set(), null);
        }
      }

      this.lassoPoints = [];
      // Store screen coordinates for drawing trail
      this.lassoPoints.push({ x: props.clientX, y: props.clientY });
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
    if (this.mode === "eraser") {
      const lastPoint = points[points.length - 1];
      // Use the last point for cursor update and erasing
      this._handleEraser(lastPoint.x, lastPoint.y, lastPoint.clientX, lastPoint.clientY);
      return;
    }

    if (this.mode === "lasso") {
      // Add points for trail drawing (screen coords)
      // We use the last point from the batch
      const lastPoint = points[points.length - 1];
      this.lassoPoints.push({ x: lastPoint.clientX, y: lastPoint.clientY });

      // Draw trail on overlay (requires screen coordinates relative to viewport)
      const rect = this.scroller.getViewportElement().getBoundingClientRect();
      const relativePoints = this.lassoPoints.map((p) => ({
        x: p.x - rect.left,
        y: p.y - rect.top,
      }));
      this.renderer.drawLassoTrail(relativePoints);
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
    if (this.mode === "eraser" || this.mode === "lasso") {
      if (this.mode === "lasso") {
        this._handleLassoEnd();
      }

      // Clear overlay (eraser cursor or lasso trail)
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
   * Handle end of lasso selection
   * @private
   */
  _handleLassoEnd() {
    if (this.lassoPoints.length < 3) return;

    // Convert screen points to content coordinates for hit testing
    const rect = this.scroller.getViewportElement().getBoundingClientRect();
    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const zoom = this.zoomScale;

    // Calculate offset (centering) to match InputHandler logic
    const viewportWidth = this.scroller.getViewportSize().width;
    const contentWidth = this.maxContentWidth;
    const scaledContentWidth = contentWidth * zoom;
    let offsetX = 0;
    if (scaledContentWidth < viewportWidth) {
      offsetX = (viewportWidth - scaledContentWidth) / 2;
    }

    // Polygon in content coordinates
    const polygon = this.lassoPoints.map((p) => ({
      x: (p.x - rect.left - offsetX + scrollLeft) / zoom,
      y: (p.y - rect.top + scrollTop) / zoom,
    }));

    // Calculate bounding box of lasso polygon
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of polygon) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    // Query spatial index for candidates
    const candidates = this.spatialIndex.query(minY, maxY);
    const selectedIndices = new Set();

    // Selection bounds
    let selMinX = Infinity,
      selMaxX = -Infinity,
      selMinY = Infinity,
      selMaxY = -Infinity;
    let hasSelection = false;

    for (const index of candidates) {
      const stroke = this.noteData.strokes[index];
      if (stroke._deleted || stroke.isDeleted) continue;

      // Calculate stroke bounds
      let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity;
      for (let i = 0; i < stroke.x.length; i++) {
        const x = stroke.x[i];
        const y = stroke.y[i];
        if (x < sMinX) sMinX = x;
        if (x > sMaxX) sMaxX = x;
        if (y < sMinY) sMinY = y;
        if (y > sMaxY) sMaxY = y;
      }

      // Fast fail: if stroke bounds are outside lasso bounds, it cannot be fully inside
      if (sMinX < minX || sMaxX > maxX || sMinY < minY || sMaxY > maxY) {
        continue;
      }

      // Strict check: All points must be inside the polygon
      let isSelected = true;
      for (let i = 0; i < stroke.x.length; i++) {
        if (!this._isPointInPolygon({ x: stroke.x[i], y: stroke.y[i] }, polygon)) {
          isSelected = false;
          break;
        }
      }

      if (isSelected) {
        selectedIndices.add(index);
        // Update selection bounds
        selMinX = Math.min(selMinX, sMinX);
        selMaxX = Math.max(selMaxX, sMaxX);
        selMinY = Math.min(selMinY, sMinY);
        selMaxY = Math.max(selMaxY, sMaxY);
        hasSelection = true;
      }
    }

    const bounds = hasSelection
      ? { minX: selMinX, minY: selMinY, maxX: selMaxX, maxY: selMaxY }
      : null;
    this.renderer.setSelectedStrokes(selectedIndices, bounds);
    this.lassoPoints = [];
  }

  /**
   * Ray-casting algorithm for point in polygon
   * @private
   */
  _isPointInPolygon(point, vs) {
    const x = point.x,
      y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
      const xi = vs[i].x,
        yi = vs[i].y;
      const xj = vs[j].x,
        yj = vs[j].y;

      const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
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
    // Allow mouse only if in Pan mode (not draw/eraser mode)
    if (e.pointerType === "mouse" && this.mode !== "pan" && this.mode !== "lasso") return;

    // Stop any active momentum scrolling
    if (this.momentumReqId) {
      cancelAnimationFrame(this.momentumReqId);
      this.momentumReqId = null;
    }

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Capture pointer to track dragging outside viewport
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (_err) {
      // Ignore capture errors
    }

    if (this.activePointers.size === 2) {
      // Start Pinch
      this._isZooming = true;
      this.lastTouchDistance = this._getPointersDistance();
      this.initialPinchZoom = this.zoomScale;
    } else if (this.activePointers.size === 1) {
      // Start Pan
      this.lastTouchX = e.clientX;
      this.lastTouchY = e.clientY;
      this.lastMoveTime = Date.now();
      this.velocityX = 0;
      this.velocityY = 0;
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

      // Get two pointer positions without creating intermediate array (reduces GC pressure)
      const iter = this.activePointers.values();
      const p1 = iter.next().value;
      const p2 = iter.next().value;
      const rect = this.scroller.getViewportElement().getBoundingClientRect();

      const fixedPoint = {
        x: (p1.x + p2.x) / 2 - rect.left,
        y: (p1.y + p2.y) / 2 - rect.top,
      };

      const currentDistance = this._getPointersDistance();
      const scale = currentDistance / this.lastTouchDistance;
      const newZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.initialPinchZoom * scale));

      if (newZoom !== this.zoomScale) {
        this.setZoom(newZoom, { immediate: false, fixedPoint });
      }
    } else if (this.activePointers.size === 1) {
      // Pan
      // If in manual draw/eraser mode, single touch should draw/erase, not pan
      if (this.mode !== "pan" && !this.autoSwitchedToDrawMode) return;
      // Mouse in draw/eraser/lasso mode is handled by InputHandler or ignored
      if (this.mode !== "pan" && e.pointerType === "mouse") return;

      const x = e.clientX;
      const y = e.clientY;
      const now = Date.now();
      const dt = now - this.lastMoveTime;

      const dx = x - this.lastTouchX;
      const dy = y - this.lastTouchY;

      // Calculate velocity (pixels per ms) with low-pass filter
      if (dt > 0) {
        const vx = dx / dt;
        const vy = dy / dt;
        this.velocityX = this.velocityX * 0.2 + vx * 0.8;
        this.velocityY = this.velocityY * 0.2 + vy * 0.8;
      }

      this.lastTouchX = x;
      this.lastTouchY = y;
      this.lastMoveTime = now;

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
      try {
        e.target.releasePointerCapture(e.pointerId);
      } catch (_err) {
        // Ignore capture errors
      }

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
        // Check for momentum if release was recent
        const now = Date.now();
        if (now - this.lastMoveTime < 100) {
          this._startMomentumScroll();
        }

        this.lastTouchX = null;
        this.lastTouchY = null;
      } else if (this.activePointers.size === 1) {
        // Switch back to pan mode with remaining finger
        const point = this.activePointers.values().next().value;
        this.lastTouchX = point.x;
        this.lastTouchY = point.y;
        this.lastMoveTime = Date.now();
        this.velocityX = 0;
        this.velocityY = 0;
      }
    }
  }

  /**
   * Start momentum scrolling animation
   * @private
   */
  _startMomentumScroll() {
    const friction = 0.75;
    const stopThreshold = 0.05;
    let lastTime = performance.now();

    const animate = (time) => {
      const dt = time - lastTime;
      lastTime = time;

      if (dt > 0) {
        const dx = this.velocityX * dt;
        const dy = this.velocityY * dt;

        this.scroller.scrollBy(-dx, -dy);

        this.velocityX *= friction;
        this.velocityY *= friction;
      }

      if (Math.abs(this.velocityX) > stopThreshold || Math.abs(this.velocityY) > stopThreshold) {
        this.momentumReqId = requestAnimationFrame(animate);
      } else {
        this.momentumReqId = null;
      }
    };

    this.momentumReqId = requestAnimationFrame(animate);
  }

  /**
   * Calculate distance between first two active pointers
   * @private
   */
  _getPointersDistance() {
    if (this.activePointers.size < 2) return 0;
    // Use iterator directly to avoid Array.from allocation
    const iter = this.activePointers.values();
    const p1 = iter.next().value;
    const p2 = iter.next().value;
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
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
   * Clean up all resources
   */
  destroy() {
    // Cancel pending scroll RAF
    if (this._scrollRafId) {
      cancelAnimationFrame(this._scrollRafId);
      this._scrollRafId = null;
    }
    this._pendingScroll = null;

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
