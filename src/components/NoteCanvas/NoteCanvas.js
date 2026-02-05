/**
 * NoteCanvas - Main entry point for virtualized note rendering
 *
 * Coordinates the VirtualScroller, CanvasRenderer, and SpatialIndex
 * to provide smooth 60fps scrolling and instant zoom for large notes.
 * Supports both viewing and drawing with stylus/pen input.
 */

import { forceRecognition } from "../../modules/autoRecognition.js";
import { importPdf } from "../../modules/pdfManager.js";
import { navigateTo } from "../../modules/router.js";
import {
  deleteFile,
  deleteNote,
  generateId,
  getNote,
  saveFile,
  updateNote,
} from "../../modules/storage.js";
import { getIcon } from "../../utils/icons.js";
import { captureFromCamera, pickImages, processImageFile } from "../../utils/imageUtils.js";
import { showAlertDialog, showConfirmDialog } from "../modals.js";
import { CanvasRenderer } from "./CanvasRenderer.js";
import { ImageCropper } from "./ImageCropper.js";
import { InputHandler } from "./InputHandler.js";
import { MediaManager } from "./MediaManager.js";
import { MediaOverlay } from "./MediaOverlay.js";
import "./NoteCanvas.css";
import {
  CropImageCommand,
  DeleteMediaCommand,
  DrawStrokeCommand,
  EraseStrokesCommand,
  InsertMediaCommand,
  ReorderMediaCommand,
  TransformMediaCommand,
  TransformStrokesCommand,
} from "./commands/index.js";
import { HistoryManager } from "./HistoryManager.js";
import { NoteToolbar } from "./NoteToolbar.js";
import { PdfTextLayerManager } from "./PdfTextLayerManager.js";
import { SpatialIndex } from "./SpatialIndex.js";
import { StrokeManager } from "./StrokeManager.js";
import { VirtualScroller } from "./VirtualScroller.js";

// Selection handle constants (exported for use by CanvasRenderer)
export const SELECTION_HANDLE_SIZE = 15; // Visual size in content pixels (scaled by zoom)
export const SELECTION_HANDLE_HIT_AREA = 25; // Hit area for touch/click detection
export const ROTATION_HANDLE_OFFSET = 25; // Distance of rotation handle from top edge
export const MEDIA_HANDLE_SIZE = 15; // Larger handles for media
export const SELECTION_BOUNDS_PADDING = 2; // Padding around selection bounds
export const MIN_SELECTION_SIZE = 10; // Minimum width/height during resize

// Scratch-out gesture detection constants
const SCRATCH_MIN_POINTS = 30; // Minimum points in stroke to consider as scratch
const SCRATCH_MIN_SIZE = 30; // Minimum width/height to avoid accidental triggers
const SCRATCH_DENSITY_THRESHOLD = 5.0; // Ink-to-diagonal ratio (strokes < threshold < scratch)
const SCRATCH_DIRECTION_THRESHOLD = 8; // Minimum movement to register direction change
const SCRATCH_MIN_DIRECTION_CHANGES = 4; // Minimum back-and-forth changes (4 turns = 5 segments)
const SCRATCH_ERASE_PADDING = 15; // Padding around gesture bounds for erasing

/**
 * Compute selection handle positions for a given bounds
 * @param {Object} bounds - {minX, minY, maxX, maxY}
 * @param {number} zoomScale - Current zoom level
 * @returns {Array<{key: string, x: number, y: number}>} Array of handle positions
 */
export function getSelectionHandles(bounds, zoomScale) {
  const { minX, minY, maxX, maxY } = bounds;
  const width = maxX - minX;
  const height = maxY - minY;
  const rotateOffset = ROTATION_HANDLE_OFFSET / zoomScale;

  return [
    { key: "rotate", x: minX + width / 2, y: minY - rotateOffset },
    { key: "nw", x: minX, y: minY },
    { key: "n", x: minX + width / 2, y: minY },
    { key: "ne", x: maxX, y: minY },
    { key: "e", x: maxX, y: minY + height / 2 },
    { key: "se", x: maxX, y: maxY },
    { key: "s", x: minX + width / 2, y: maxY },
    { key: "sw", x: minX, y: maxY },
    { key: "w", x: minX, y: minY + height / 2 },
  ];
}

/**
 * Compute media handle positions (rotated)
 * @param {Object} item - Media item {x, y, width, height, rotation}
 * @param {number} zoomScale - Current zoom level
 * @returns {Array<{key: string, x: number, y: number}>}
 */
export function getMediaHandles(item, zoomScale) {
  const { x, y, width, height, rotation = 0 } = item;
  const cx = x + width / 2;
  const cy = y + height / 2;
  const rotateOffset = (ROTATION_HANDLE_OFFSET + 10) / zoomScale; // Slightly further out

  // Helper to rotate a point around center
  const rotatePoint = (px, py) => {
    if (rotation === 0) return { x: px, y: py };
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x: cx + (px - cx) * cos - (py - cy) * sin,
      y: cy + (px - cx) * sin + (py - cy) * cos,
    };
  };

  // Define unrotated handle positions
  const handles = [
    { key: "rotate", x: cx, y: y - rotateOffset },
    { key: "nw", x: x, y: y },
    { key: "n", x: cx, y: y },
    { key: "ne", x: x + width, y: y },
    { key: "e", x: x + width, y: cy },
    { key: "se", x: x + width, y: y + height },
    { key: "s", x: cx, y: y + height },
    { key: "sw", x: x, y: y + height },
    { key: "w", x: x, y: cy },
  ];

  // Apply rotation
  return handles.map((h) => {
    const p = rotatePoint(h.x, h.y);
    return { key: h.key, x: p.x, y: p.y };
  });
}

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
    this.mediaManager = null;
    this.strokeManager = null;
    this.mediaOverlay = null;
    this.pdfTextLayerManager = null;
    this.toolbar = null;
    this.contentHeight = 0;

    // State
    this.noteId = null;
    this.noteData = null;
    this.pendingLiveUpdate = false;
    this._pendingMediaUpdate = false;
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
    this.stylusDetected = false; // Track if a stylus has been used in this session
    this.transformState = null; // { mode: 'move'|'resize', handle, startX, startY, initialBounds, initialStrokes }
    this.strokesChanged = false; // Track if strokes have been modified
    this.mediaChanged = false; // Track if media has been modified
    this.activeSearchQuery = null; // Track active search query for highlighting
    this.mediaDragState = null; // { item, startX, startY, initialX, initialY }
    this.selectedMediaId = null; // Track selected media item
    this.penPresets = null; // Pen presets configuration

    // Long press state
    this.longPressTimer = null;
    this.longPressStart = null;

    // Undo/redo history
    this.historyManager = null;

    // Eraser batching for undo (multiple strokes erased in one gesture = one undo)
    this._eraserBatch = null;

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
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onDataChange = this._onDataChange.bind(this);
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

    // If local has MORE strokes than DB, we are ahead (unsaved changes). Do not reload.
    if (currentStrokesCount > freshStrokesCount) {
      return false;
    }

    // Simple check: if stroke count or background changed, we need reload
    // We ignore metadata changes like 'synced' or 'lastSyncedEtag'
    return (
      currentStrokesCount !== freshStrokesCount || this.noteData.background !== freshData.background
    );
  }

  /**
   * Applies live updates from storage (e.g., after a sync) without a full reload.
   * This merges remote changes with local, in-memory changes to prevent data loss,
   * especially for strokes drawn while the sync was in progress.
   */
  async applyLiveUpdate() {
    if (!this.noteId || !this.isInitialized) return;

    console.log(`[NoteCanvas] Applying live update for note ${this.noteId}`);

    const freshDataFromDB = await getNote(this.noteId);
    if (!freshDataFromDB) {
      console.warn("[NoteCanvas] Note not found during live update. Cannot apply changes.");
      return;
    }

    const inMemoryData = this.noteData;

    // --- MERGE STROKES ---
    const dbStrokes = freshDataFromDB.strokes || [];
    const memStrokes = inMemoryData.strokes || [];
    const dbDeleted = new Set(freshDataFromDB.deletedStrokes || []);
    const memDeleted = new Set(inMemoryData.deletedStrokes || []);

    const allDeletedIds = new Set([...dbDeleted, ...memDeleted]);
    const mergedStrokesMap = new Map();

    // Add all strokes from memory first, then overwrite with DB data.
    // This ensures the just-finished stroke from memory is included,
    // and any strokes updated by the sync take precedence.
    [...memStrokes, ...dbStrokes].forEach((stroke) => {
      if (stroke.id) mergedStrokesMap.set(stroke.id, stroke);
    });

    const finalStrokes = Array.from(mergedStrokesMap.values()).filter(
      (stroke) => !allDeletedIds.has(stroke.id),
    );

    // --- UPDATE IN-MEMORY DATA IN-PLACE ---
    // This is important so modules that hold a reference see the changes.
    inMemoryData.strokes.length = 0;
    Array.prototype.push.apply(inMemoryData.strokes, finalStrokes);

    inMemoryData.deletedStrokes.length = 0;
    Array.prototype.push.apply(inMemoryData.deletedStrokes, Array.from(allDeletedIds));

    // For now, we assume media and other properties are less likely to have
    // in-memory vs. DB conflicts during a drawing session. We prioritize
    // the DB version for these.
    inMemoryData.media = freshDataFromDB.media || [];
    inMemoryData.deletedMedia = freshDataFromDB.deletedMedia || [];
    inMemoryData.penPresets = freshDataFromDB.penPresets || inMemoryData.penPresets;
    inMemoryData.pdfSource = freshDataFromDB.pdfSource;
    inMemoryData.background = freshDataFromDB.background;
    inMemoryData.modified = freshDataFromDB.modified;
    inMemoryData.lastSyncedEtag = freshDataFromDB.lastSyncedEtag;
    inMemoryData.synced = freshDataFromDB.synced;

    // --- UPDATE MODULES ---
    this.strokeManager.markDirty(); // The merged state needs to be saved back.
    this.spatialIndex.build(inMemoryData.strokes);
    this.mediaManager.setItems(inMemoryData.media);
    this.renderer.setData(inMemoryData.strokes, inMemoryData.background);

    // Force redraw immediately to show updated state (we know we aren't drawing)
    this.renderer.forceRedraw();
    this._renderPdfControls();

    // Clear history after sync (external changes invalidate undo commands)
    this.historyManager?.clear();

    console.log(`[NoteCanvas] Live update applied. Stroke count: ${inMemoryData.strokes.length}`);
  }

  /**
   * Load and render a note
   * @param {string} noteId - ID of the note to load
   * @param {string|null} searchQuery - Optional search query to highlight
   */
  async load(noteId, searchQuery = null) {
    this.noteId = noteId;
    this.activeSearchQuery = searchQuery;

    // Fetch note data
    this.noteData = await getNote(noteId);
    if (!this.noteData) {
      console.error("[NoteCanvas] Note not found:", noteId);
      return;
    }

    // Ensure strokes array exists and is shared across modules
    if (!this.noteData.strokes) {
      this.noteData.strokes = [];
    }
    if (!this.noteData.deletedStrokes) {
      this.noteData.deletedStrokes = [];
    }
    if (!this.noteData.media) {
      this.noteData.media = [];
    }
    if (!this.noteData.deletedMedia) {
      this.noteData.deletedMedia = [];
    }

    // Initialize pen presets
    this.penPresets = this.noteData.penPresets || [
      { width: 1.5, colorIndex: 0, type: "pen" },
      { width: 2, colorIndex: 1, type: "pen" },
      { width: 2, colorIndex: 2, type: "pen" },
      { width: 2, colorIndex: 3, type: "pen" },
      { width: 25, colorIndex: 0, type: "marker" }, // Yellow
      { width: 25, colorIndex: 1, type: "marker" }, // Green
      { width: 25, colorIndex: 2, type: "marker" }, // Orange
    ];

    // Migration: Ensure markers exist in presets for old notes
    if (!this.penPresets.some((p) => p.type === "marker")) {
      this.penPresets.push(
        { width: 25, colorIndex: 0, type: "marker" },
        { width: 25, colorIndex: 1, type: "marker" },
        { width: 25, colorIndex: 2, type: "marker" },
      );
      this.noteData.penPresets = this.penPresets;
    }

    // Set initial pen settings to match first preset
    this.currentPenWidth = this.penPresets[0].width;
    this.currentPenColorIndex = this.penPresets[0].colorIndex;
    this.currentPenType = this.penPresets[0].type || "pen";

    // Clear container and setup layout
    this.containerElement.innerHTML = "";
    this.containerElement.className = "note-canvas";
    this.containerElement.style.touchAction = "none"; // Prevent browser gestures

    // 1. Toolbar Container (Fixed height at top)
    const toolbarContainer = document.createElement("div");
    toolbarContainer.className = "note-canvas__toolbar-container";
    this.containerElement.appendChild(toolbarContainer);

    // 2. Scroller Container (Canvas Area - fills remaining space)
    const scrollerContainer = document.createElement("div");
    scrollerContainer.className = "note-canvas__scroller-container";
    scrollerContainer.style.position = "relative"; // Ensure positioning context for PDF controls
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

    // Calculate content dimensions from strokes
    const contentBounds = this.spatialIndex.getContentBounds();
    let maxContentY = contentBounds ? contentBounds.maxY : 0;

    // Include media items (images, PDF pages) in content height calculation
    if (this.noteData.media && this.noteData.media.length > 0) {
      for (const item of this.noteData.media) {
        const itemBottom = (item.y || 0) + (item.height || 0);
        if (itemBottom > maxContentY) {
          maxContentY = itemBottom;
        }
      }
    }

    this.contentHeight = Math.max(maxContentY + 500, height); // Add padding below content
    const contentWidth = this.maxContentWidth;

    // Initialize MediaManager
    this.mediaManager = new MediaManager(noteId, this.noteData.media);
    this.mediaManager.setOnImageLoaded(() => this.renderer.forceRedraw());

    // Initialize MediaOverlay
    this.mediaOverlay = new MediaOverlay(this.scroller.getViewportElement(), {
      onDelete: (id) => this.deleteSelectedMedia(id),
      onCrop: (id) => this.cropSelectedMedia(id),
      onToFront: (id) => this.moveSelectedMediaToFront(id),
      onToBack: (id) => this.moveSelectedMediaToBack(id),
    });

    // Initialize PDF Text Layer Manager (for text selection in PDFs)
    this.pdfTextLayerManager = new PdfTextLayerManager(
      this.scroller.getViewportElement(),
      this.mediaManager,
    );

    // Initialize renderer
    this.renderer = new CanvasRenderer(this.scroller.getViewportElement(), {
      maxContentWidth: this.maxContentWidth,
    });
    this.renderer.setData(this.noteData.strokes, this.noteData.background);
    this.renderer.setSpatialIndex(this.spatialIndex);
    this.renderer.setMediaManager(this.mediaManager);
    this.renderer.setContentSize(contentWidth, this.contentHeight);
    this.renderer.resize(width, height);

    // Initialize stroke manager
    this.strokeManager = new StrokeManager(
      noteId,
      this.noteData.strokes,
      this.noteData.deletedStrokes,
    );

    // Initialize history manager for undo/redo
    this.historyManager = new HistoryManager({
      maxHistory: 50,
      onStateChange: (state) => {
        this.toolbar?.updateHistoryState?.(state);
      },
    });
    this.historyManager.setNoteCanvas(this);

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
        penPresets: this.penPresets,
        onPresetChange: async (updatedPresets) => {
          this.penPresets = updatedPresets;
          this.noteData.penPresets = updatedPresets;
          this.strokeManager.savePresets(updatedPresets);
        },
        onPenSettingsChange: ({ width, colorIndex, type }) => {
          this.currentPenWidth = width;
          this.currentPenColorIndex = colorIndex;
          this.currentPenType = type;
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
        onAction: (action) => {
          if (action === "insert-image") this.insertImage("picker");
          if (action === "insert-camera") this.insertImage("camera");
          if (action === "insert-pdf") this.insertPdf();
        },
        onUndo: () => this.historyManager?.undo(),
        onRedo: () => this.historyManager?.redo(),
      },
    );
    this.toolbar.updateMode(this.mode);
    this.toolbar.setPenSettings({
      width: this.currentPenWidth,
      colorIndex: this.currentPenColorIndex,
      type: this.currentPenType,
    });

    // Highlight search terms if provided
    if (this.activeSearchQuery) {
      this._highlightSearchTerms(this.activeSearchQuery);
    }

    this.isInitialized = true;
    this._renderPdfControls();

    // Expose for debugging
    window.__noteCanvas = this;
  }

  /**
   * Insert an image into the note
   * @param {string} source - 'picker' or 'camera'
   */
  async insertImage(source = "picker") {
    try {
      let files = [];
      if (source === "camera") {
        const file = await captureFromCamera();
        if (file) files = [file];
      } else {
        files = await pickImages(true);
      }

      if (files.length === 0) {
        return;
      }

      // Calculate center of viewport for insertion
      const viewport = this.scroller.getViewportBounds();
      const centerX = viewport.left + viewport.width / 2;
      const centerY = viewport.top + viewport.height / 2;

      const insertedItems = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        try {
          const processed = await processImageFile(file);

          // Convert DataURL to Blob for storage
          let blob;
          try {
            const res = await fetch(processed.dataUrl);
            blob = await res.blob();
          } catch (fetchErr) {
            console.warn("[NoteCanvas] fetch(dataUrl) failed, using fallback conversion", fetchErr);
            const arr = processed.dataUrl.split(",");
            const mime = arr[0].match(/:(.*?);/)[1];
            const bstr = atob(arr[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) u8arr[n] = bstr.charCodeAt(n);
            blob = new Blob([u8arr], { type: mime });
          }

          const fileId = await saveFile(blob);

          const item = {
            id: generateId(),
            type: "image",
            fileId: fileId,
            x: centerX - processed.width / 4 + i * 20, // Offset slightly
            y: centerY - processed.height / 4 + i * 20,
            width: processed.width / 2, // Insert at 50% scale initially
            height: processed.height / 2,
            rotation: 0,
          };

          this.mediaManager.addItem(item);
          insertedItems.push(item);
        } catch (err) {
          console.error(`[NoteCanvas] Error processing file ${file.name}:`, err);
        }
      }

      // Save changes
      await this._saveMediaChanges();
      this.renderer.forceRedraw();

      // Record undo command for inserted images
      if (insertedItems.length > 0) {
        this.historyManager?.push(new InsertMediaCommand(insertedItems));
      }
    } catch (error) {
      console.error("[NoteCanvas] Failed to insert image:", error);
    }
  }

  /**
   * Insert a PDF into the note
   */
  async insertPdf() {
    // Check for pdfSource OR existence of pdf-page items (fallback for data consistency)
    const hasPdfPages = this.mediaManager?.getItems().some((i) => i.type === "pdf-page");
    if (this.noteData.pdfSource || hasPdfPages) {
      await showAlertDialog(
        "PDF Already Imported",
        "Only one PDF can be imported per note. Please remove the current PDF before importing a new one.",
      );
      return;
    }

    try {
      const file = await this._pickPdfFile();
      if (!file) return;

      // Import PDF (saves file and extracts pages)
      const { pages, fileId } = await importPdf(file);

      if (pages.length > 0) {
        // Determine insertion point (center of viewport)
        const viewport = this.scroller.getViewportBounds();
        const startY = viewport.top + 50;
        // Use maxContentWidth to ensure it fills the canvas width (typically 1200px)
        const targetWidth = this.maxContentWidth || 1200;
        let currentY = startY;

        const insertedPages = [];

        // Add pages to media items
        for (const page of pages) {
          // Scale page to fit content width while maintaining aspect ratio
          const scaleFactor = targetWidth / page.width;
          const newItem = {
            ...page,
            width: targetWidth,
            height: page.height * scaleFactor,
            x: 0,
            y: currentY,
          };
          currentY += newItem.height;
          this.mediaManager.addItem(newItem);
          insertedPages.push(newItem);
        }

        // Store reference to the PDF document at the note level
        if (!this.noteData.pdfSource) {
          this.noteData.pdfSource = fileId;
        }

        // Save changes
        await this._saveMediaChanges();
        this.renderer.forceRedraw();
        this._renderPdfControls();

        // Record undo command for PDF insert (all pages + pdfSource)
        this.historyManager?.push(new InsertMediaCommand(insertedPages, fileId));

        // Expand canvas if needed
        const lastPage = pages[pages.length - 1];
        const bottom = lastPage.y + lastPage.height;
        if (bottom > this.contentHeight) {
          this._expandCanvas(bottom - this.contentHeight + 500);
        }
      }
    } catch (error) {
      console.error("[NoteCanvas] Failed to insert PDF:", error);
      alert(`Failed to import PDF: ${error.message}`);
    }
  }

  /**
   * Render the PDF option button if a PDF is present
   * @private
   */
  _renderPdfControls() {
    // Remove existing if any
    const existing = this.containerElement.querySelector(".note-canvas__pdf-controls");
    if (existing) existing.remove();

    // Check for pdfSource OR existence of pdf-page items (fallback for data consistency)
    const hasPdfPages = this.mediaManager?.getItems().some((i) => i.type === "pdf-page");
    if (!this.noteData.pdfSource && !hasPdfPages) return;

    const scrollerContainer = this.containerElement.querySelector(
      ".note-canvas__scroller-container",
    );
    if (!scrollerContainer) return;

    const controls = document.createElement("div");
    controls.className = "note-canvas__pdf-controls";
    controls.style.position = "absolute";
    controls.style.zIndex = "1"; // Above canvas

    const btn = document.createElement("button");
    btn.className = "note-canvas__pdf-btn";
    btn.title = "PDF Options";
    btn.style.background = "var(--bg-secondary)";
    btn.style.border = "1px solid var(--border-color)";
    btn.style.borderRadius = "50%";
    btn.style.width = "40px";
    btn.style.height = "40px";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.cursor = "pointer";
    btn.style.boxShadow = "0 2px 5px rgba(0,0,0,0.1)";
    btn.style.color = "var(--text-primary)";

    btn.innerHTML = getIcon("pdf", 20);

    btn.onclick = (e) => {
      e.stopPropagation();
      this._showPdfOptions(e.clientX, e.clientY);
    };

    controls.appendChild(btn);
    scrollerContainer.appendChild(controls);
    this._updatePdfControlsPosition();
  }

  /**
   * Update position of PDF controls to stick to the first page
   * @private
   */
  _updatePdfControlsPosition() {
    const controls = this.containerElement.querySelector(".note-canvas__pdf-controls");
    if (!controls) return;

    const pdfPages = this.mediaManager.getItems().filter((i) => i.type === "pdf-page");
    if (pdfPages.length === 0) return;

    // Find first page (min Y)
    let firstPage = pdfPages[0];
    for (let i = 1; i < pdfPages.length; i++) {
      if (pdfPages[i].y < firstPage.y) firstPage = pdfPages[i];
    }

    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const viewportWidth = this.scroller.getViewportSize().width;
    const scaledContentWidth = this.maxContentWidth * this.zoomScale;
    const offsetX =
      scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;

    const pageRightX = firstPage.x + firstPage.width;
    const pageTopY = firstPage.y;
    const screenX = pageRightX * this.zoomScale - scrollLeft + offsetX;
    const screenY = pageTopY * this.zoomScale - scrollTop;
    controls.style.left = `${screenX - 50}px`; // 50px from right edge (40px btn + 10px margin)
    controls.style.top = `${screenY + 10}px`;
  }

  /**
   * Show PDF options menu
   * @private
   */
  _showPdfOptions(x, y) {
    const existing = document.getElementById("pdf-options-menu");
    if (existing) existing.remove();

    const menu = document.createElement("div");
    menu.id = "pdf-options-menu";
    menu.className =
      "note-canvas-toolbar__options-dialog note-canvas-toolbar__options-dialog--open";
    menu.style.position = "fixed";

    // Calculate position to prevent cutoff
    const menuWidth = 180;
    let left = x - menuWidth + 40;
    if (left + menuWidth > window.innerWidth - 10) {
      left = window.innerWidth - menuWidth - 10;
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${y + 10}px`;
    menu.style.zIndex = "1000";

    menu.innerHTML = `
      <div class="note-canvas-toolbar__options-content">
        <div class="note-canvas-toolbar__options-section">
          <button class="note-canvas-toolbar__delete-btn" id="pdf-delete-btn">
            ${getIcon("trash", 16)} Delete PDF
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(menu);

    const deleteBtn = menu.querySelector("#pdf-delete-btn");
    deleteBtn.onclick = () => {
      this.deletePdf();
      menu.remove();
      document.removeEventListener("pointerdown", closeMenu);
    };

    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener("pointerdown", closeMenu);
      }
    };

    setTimeout(() => {
      document.addEventListener("pointerdown", closeMenu);
    }, 0);
  }

  /**
   * Pick a PDF file from the file system
   * @private
   */
  _pickPdfFile() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf";
      input.onchange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
          resolve(e.target.files[0]);
        } else {
          resolve(null);
        }
      };
      input.click();
    });
  }

  /**
   * Highlight search terms in the note
   * @private
   * @param {string} query
   */
  _highlightSearchTerms(query) {
    let recognition = this.noteData?.recognition;

    // Handle case where recognition might be a JSON string (legacy data artifact)
    if (typeof recognition === "string") {
      try {
        recognition = JSON.parse(recognition);
        this.noteData.recognition = recognition;
      } catch (_e) {
        return;
      }
    }

    if (!recognition?.words || !Array.isArray(recognition.words)) return;

    // Create regex pattern from query with wildcard support
    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escapeRegex(query).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    const regex = new RegExp(pattern, "gi");

    const rects = [];

    recognition.words.forEach((word) => {
      if (!word) return;

      regex.lastIndex = 0;
      if (word.text && regex.test(word.text)) {
        // Support multiple structures for bounding box
        const box = word.boundingRect || word.boundingBox || word.rect || word;

        if (box) {
          const x = box.x !== undefined ? box.x : box.left;
          const y = box.y !== undefined ? box.y : box.top;
          const w = box.width !== undefined ? box.width : box.w;
          const h = box.height !== undefined ? box.height : box.h;

          if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
            rects.push({ x, y, w, h });
          }
        }
      }
    });

    if (this.renderer) {
      this.renderer.setHighlights(rects);
    }
  }

  /**
   * Set up global event listeners
   * @private
   */
  _setupEventListeners() {
    // Theme changes
    window.addEventListener("datachange", this._onDataChange);
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
    window.addEventListener("keydown", this._onKeyDown);
  }

  /**
   * Handle external data changes (e.g., from sync)
   * @private
   */
  async _onDataChange(e) {
    const { noteId } = e.detail || {};

    // Is this change for the currently open note?
    if (!noteId || noteId !== this.noteId) {
      return;
    }

    // The user is actively drawing. Defer the update until they finish.
    if (this.inputHandler?.isDrawing) {
      console.log("[NoteCanvas] Data change detected while drawing. Deferring update.");
      this.pendingLiveUpdate = true;
      return;
    }

    await this.applyLiveUpdate();
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

        // If we have a pending media update (from sync), force a redraw of the media layer
        if (this._pendingMediaUpdate) {
          this.renderer.forceRedraw();
          this._pendingMediaUpdate = false;
        }

        this.renderer.render(
          scrollTop,
          viewportHeight,
          scrollLeft,
          this.strokeManager?.currentStroke,
        );
        this._updateMediaOverlay();
        this._updatePdfTextLayers();
        this._updatePdfControlsPosition();
      });
    }
  }

  /**
   * Update PDF text layer positions
   * @private
   */
  _updatePdfTextLayers() {
    if (!this.pdfTextLayerManager) return;

    const viewportBounds = this.scroller.getViewportBounds();
    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const { height: viewportHeight, width: viewportWidth } = this.scroller.getViewportSize();

    // Calculate centering offset
    const scaledContentWidth = this.maxContentWidth * this.zoomScale;
    const centeringOffset =
      scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;

    this.pdfTextLayerManager.update(
      viewportBounds,
      this.zoomScale,
      scrollLeft,
      scrollTop,
      centeringOffset,
      viewportHeight,
    );
  }

  /**
   * Handle viewport resize events
   * @private
   */
  _onViewportResize(width, height) {
    if (!this.renderer || !this.spatialIndex || height <= 0) return;

    // Only rebuild spatial index if height change is very significant (>2x or <0.5x)
    // This avoids expensive O(n) rebuilds on routine resize events
    const currentBucketHeight = this.spatialIndex.bucketHeight;
    const ratio = height / currentBucketHeight;
    if (ratio < 0.5 || ratio > 2.0) {
      this.spatialIndex.setBucketHeight(height, this.noteData?.strokes || []);
    }

    // Resize renderer
    this.renderer.resize(width, height / this.zoomScale);

    // If we have a pending media update, force redraw now
    if (this._pendingMediaUpdate) {
      this.renderer.forceRedraw();
      this._pendingMediaUpdate = false;
    }

    // Re-render
    const scrollTop = this.scroller.getScrollTop();
    const scrollLeft = this.scroller.getScrollLeft();
    this.renderer.render(scrollTop, height, scrollLeft, this.strokeManager?.currentStroke);
    this._updateMediaOverlay();
    this._updatePdfTextLayers();
    this._updatePdfControlsPosition();
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
    this.transformState = null;
    this.mediaDragState = null;
    this._clearLongPress();

    if (this.toolbar) {
      this.toolbar.updateMode(newMode);
    }

    // Clear selection when switching modes (except to pan or lasso)
    if (this.renderer && newMode !== "pan" && newMode !== "lasso") {
      this.renderer.setSelectedStrokes(new Set(), null);
    }

    // Update PDF text layer interactivity (only enabled in pan mode)
    if (this.pdfTextLayerManager) {
      this.pdfTextLayerManager.setMode(newMode);
    }

    // Add mode class to container for CSS-based behavior
    this.containerElement.classList.remove(
      "note-canvas--pan-mode",
      "note-canvas--draw-mode",
      "note-canvas--eraser-mode",
      "note-canvas--lasso-mode",
    );
    this.containerElement.classList.add(`note-canvas--${newMode}-mode`);
  }

  /**
   * Handle stroke start
   * @private
   */
  _onStrokeStart(props) {
    // Detect stylus usage
    if (props.pointerType === "pen") {
      this.stylusDetected = true;
      // Auto-switch to draw mode if currently in pan mode
      if (this.mode === "pan") {
        this._setMode("draw");
        this.autoSwitchedToDrawMode = true;
      }
    }

    // Handle Media Interactions (Selection & Manipulation)
    const mediaResult = this._handleMediaInteraction(
      props.x,
      props.y,
      props.clientX,
      props.clientY,
    );
    if (mediaResult.consumed) {
      return true; // Started dragging selected media
    }

    if (this.mode === "pan") return false;
    // If stylus has been detected, touch inputs are strictly for navigation (pan/zoom)
    if (this.stylusDetected && props.pointerType === "touch") return false;

    if (this.mode === "eraser") {
      this._handleEraser(props.x, props.y, props.clientX, props.clientY);
      return true;
    }

    if (this.mode === "lasso") {
      // Check for interaction with existing selection
      if (this.renderer?.selectionBounds) {
        const { x, y } = props;
        const handle = this._getHandleAtPoint(x, y);

        if (handle) {
          this._startTransform(handle === "rotate" ? "rotate" : "resize", x, y, handle);
          return true;
        }

        if (this._isPointInSelection(x, y)) {
          this._startTransform("move", x, y);
          return true;
        }
      }

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
      type: this.currentPenType,
    });

    this.renderer.drawDirectStroke(stroke);
    return true;
  }

  /**
   * Handle stroke move
   * @private
   */
  _onStrokeMove(points) {
    // Check long press movement threshold
    if (this.longPressTimer) {
      const lastPoint = points[points.length - 1];
      this._checkLongPressMove(lastPoint.clientX, lastPoint.clientY);
    }

    if (this.mediaDragState) {
      const lastPoint = points[points.length - 1];
      this._handleMediaTransformMove(lastPoint.x, lastPoint.y);
      this.renderer.forceRedraw();
      this._updateMediaOverlay();
      return;
    }

    if (this.transformState) {
      const lastPoint = points[points.length - 1];
      this._handleTransformMove(lastPoint.x, lastPoint.y);
      return;
    }

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
    this._clearLongPress();

    if (this.mediaDragState) {
      this.mediaDragState = null;
      this._saveMediaChanges();
      return;
    }

    if (this.transformState) {
      this._endTransform();
      return;
    }

    if (this.mode === "eraser" || this.mode === "lasso") {
      if (this.mode === "eraser") {
        // Commit eraser batch to history (multiple strokes = one undo)
        this._commitEraserBatch();
      } else if (this.mode === "lasso") {
        this._handleLassoEnd();
      }

      // Clear overlay (eraser cursor or lasso trail)
      this.renderer.clearOverlay();
      return;
    }

    // Check for scratch-out gesture (only in draw mode)
    if (this.mode === "draw" && this.strokeManager.currentStroke) {
      const stroke = this.strokeManager.currentStroke;
      if (this._isScratchGesture(stroke)) {
        this._handleScratchErase(stroke);
        this.strokeManager.cancelCurrentStroke();
        this.renderer.forceRedraw(); // Clear the gesture stroke from screen
        return;
      }
    }

    const stroke = this.strokeManager.endStroke();
    if (stroke) {
      // Draw the final segment (tail) of the stroke
      this.renderer.drawDirectStroke(stroke, true);

      // Update spatial index so the stroke is included in future buffer redraws (scroll/zoom)
      const newIndex = this.noteData.strokes.length - 1;
      this.spatialIndex.insert(stroke, newIndex);
      this.strokesChanged = true;

      // Record undo command for drawing
      this.historyManager?.push(new DrawStrokeCommand(stroke, newIndex));
    }

    // After stroke is finished, check if a deferred update is pending.
    if (this.pendingLiveUpdate) {
      this.pendingLiveUpdate = false;
      console.log("[NoteCanvas] Applying deferred live update after stroke end.");
      this.applyLiveUpdate().catch((err) => {
        console.error("Failed to apply deferred live update:", err);
      });
    }
  }

  /**
   * Handle keyboard events
   * @private
   */
  _onKeyDown(e) {
    // Undo: Ctrl+Z (or Cmd+Z on Mac)
    if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      this.historyManager?.undo();
      return;
    }

    // Redo: Ctrl+Y or Ctrl+Shift+Z (or Cmd+Shift+Z on Mac)
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault();
      this.historyManager?.redo();
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.selectedMediaId) {
        this.deleteSelectedMedia();
      }
    }
  }

  /**
   * Start long press detection
   * @private
   */
  _startLongPress(item, clientX, clientY) {
    this._clearLongPress();
    this.longPressStart = { x: clientX, y: clientY };
    this.longPressTimer = setTimeout(() => {
      this._triggerLongPress(item);
    }, 500); // 500ms for long press
  }

  /**
   * Clear long press state
   * @private
   */
  _clearLongPress() {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.longPressStart = null;
  }

  /**
   * Check if movement exceeds threshold for long press
   * @private
   */
  _checkLongPressMove(clientX, clientY) {
    if (!this.longPressStart) return;
    const dist = Math.sqrt(
      (clientX - this.longPressStart.x) ** 2 + (clientY - this.longPressStart.y) ** 2,
    );
    if (dist > 10) {
      // 10px threshold
      this._clearLongPress();
    }
  }

  /**
   * Trigger long press action (select item)
   * @private
   */
  _triggerLongPress(item) {
    this.longPressTimer = null;

    // Select the item
    this.selectedMediaId = item.id;
    this.renderer.setSelectedMedia(item.id);
    this._updateMediaOverlay();

    // Cancel current stroke if drawing
    if (this.strokeManager.currentStroke) {
      this.strokeManager.cancelCurrentStroke();
      this.renderer.forceRedraw(); // Clear the partial stroke
    }

    // Note: We don't automatically start dragging here to avoid jumps.
    // The user sees the selection border and can then drag.
  }

  /**
   * Handle media interaction at a point (shared logic for stroke and nav handlers)
   * @private
   * @param {number} x - Content X coordinate
   * @param {number} y - Content Y coordinate
   * @param {number} clientX - Screen X coordinate (for long press)
   * @param {number} clientY - Screen Y coordinate (for long press)
   * @returns {{ consumed: boolean, startedDrag: boolean }} Result of interaction check
   */
  _handleMediaInteraction(x, y, clientX, clientY) {
    const hitItem = this.mediaManager.hitTest(x, y);

    // Check handles first
    let hitHandle = null;
    if (this.selectedMediaId) {
      const selectedItem = this.mediaManager.getItems().find((i) => i.id === this.selectedMediaId);
      if (selectedItem) {
        hitHandle = this._getMediaHandleAtPoint(x, y, selectedItem);
      }
    }

    // Case 1: Interacting with an already selected item -> Start drag
    if (hitHandle || (hitItem && hitItem.id === this.selectedMediaId)) {
      const item = hitHandle
        ? this.mediaManager.getItems().find((i) => i.id === this.selectedMediaId)
        : hitItem;
      this.mediaDragState = {
        item: item,
        mode: hitHandle ? (hitHandle === "rotate" ? "rotate" : "resize") : "move",
        handle: hitHandle,
        startX: x,
        startY: y,
        initialX: item.x,
        initialY: item.y,
        initialWidth: item.width,
        initialHeight: item.height,
        initialRotation: item.rotation || 0,
        centerX: item.x + item.width / 2,
        centerY: item.y + item.height / 2,
      };
      return { consumed: true, startedDrag: true };
    }

    // Case 2: Clicking outside selected item -> Deselect
    if (this.selectedMediaId && (!hitItem || hitItem.id !== this.selectedMediaId)) {
      this.selectedMediaId = null;
      this.renderer.setSelectedMedia(null);
      this.mediaOverlay.hide();
    }

    // Case 3: Long press detection on unselected item (but not PDF pages)
    if (hitItem && !this.selectedMediaId && hitItem.type !== "pdf-page") {
      this._startLongPress(hitItem, clientX, clientY);
    }

    return { consumed: false, startedDrag: false };
  }

  /**
   * Check if point hits a media handle
   * @private
   */
  _getMediaHandleAtPoint(x, y, item) {
    const handles = getMediaHandles(item, this.zoomScale);
    // Use larger hit area for touch
    const hitRadius = SELECTION_HANDLE_HIT_AREA / this.zoomScale / 2;

    for (const h of handles) {
      if (Math.abs(x - h.x) <= hitRadius && Math.abs(y - h.y) <= hitRadius) {
        return h.key;
      }
    }
    return null;
  }

  /**
   * Handle media transform (move/resize/rotate)
   * @private
   */
  _handleMediaTransformMove(x, y) {
    const state = this.mediaDragState;
    const item = state.item;

    if (state.mode === "move") {
      const dx = x - state.startX;
      const dy = y - state.startY;
      item.x = state.initialX + dx;
      item.y = state.initialY + dy;
    } else if (state.mode === "rotate") {
      // Calculate angle from center
      const startAngle = Math.atan2(state.startY - state.centerY, state.startX - state.centerX);
      const currentAngle = Math.atan2(y - state.centerY, x - state.centerX);
      const deltaAngle = (currentAngle - startAngle) * (180 / Math.PI);
      item.rotation = (state.initialRotation + deltaAngle) % 360;
    } else if (state.mode === "resize") {
      // Rotate point back to unrotated coordinate space for simpler resizing logic
      // This is an approximation; full rotated resizing is complex.
      // For simplicity, we calculate distance from center or opposite corner.

      // Simple approach: Calculate distance change from center
      // This works well for corner resizing while maintaining aspect ratio
      const dx = x - state.startX;
      const dy = y - state.startY;

      // Determine resize direction based on handle
      const isLeft = state.handle.includes("w");
      const isTop = state.handle.includes("n");

      // Rotate the delta vector by -rotation to align with item axes
      const rad = (-(item.rotation || 0) * Math.PI) / 180;
      const rdx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const rdy = dx * Math.sin(rad) + dy * Math.cos(rad);

      let newWidth = state.initialWidth;
      let newHeight = state.initialHeight;
      let newX = state.initialX;
      let newY = state.initialY;

      // Apply resize logic
      if (state.handle.length === 2) {
        // Corner (aspect ratio locked)
        // Use the larger delta to drive the scale
        const ratio = state.initialWidth / state.initialHeight;
        let change = 0;

        if (state.handle === "se") change = Math.max(rdx, rdy);
        else if (state.handle === "nw") change = Math.max(-rdx, -rdy);
        else if (state.handle === "ne") change = Math.max(rdx, -rdy);
        else if (state.handle === "sw") change = Math.max(-rdx, rdy);

        newWidth = Math.max(50, state.initialWidth + change);
        newHeight = newWidth / ratio;

        // Adjust position to keep opposite corner fixed (roughly)
        // For perfect rotated resizing, we'd need to rotate the pivot point.
        // Simplified: Center-based scaling if we don't want to do full matrix math here
        // Let's do center-based scaling for now as it's robust for rotated items
        const widthDiff = newWidth - state.initialWidth;
        const heightDiff = newHeight - state.initialHeight;

        // Adjust center based on handle
        // This is a simplification. For full corner pinning, we need more math.
        // But center-expansion is often acceptable for rotated items.
        // Let's try to pin the center for now to avoid jumping.
        newX = state.initialX - widthDiff / 2;
        newY = state.initialY - heightDiff / 2;
      } else {
        // Side (one dimension)
        if (state.handle === "e") newWidth += rdx;
        else if (state.handle === "w") {
          newWidth -= rdx;
          newX -= rdx;
        } // This X adjustment is only valid if rotation is 0
        else if (state.handle === "s") newHeight += rdy;
        else if (state.handle === "n") {
          newHeight -= rdy;
          newY -= rdy;
        }

        // For rotated side resizing, center-based is safer without full matrix logic
        if (item.rotation) {
          newX = state.initialX - (newWidth - state.initialWidth) / 2;
          newY = state.initialY - (newHeight - state.initialHeight) / 2;
        }
      }

      item.width = Math.max(50, newWidth);
      item.height = Math.max(50, newHeight);
      if (item.rotation) {
        item.x = newX;
        item.y = newY;
      } else {
        // Non-rotated logic (standard)
        if (isLeft) item.x = state.initialX + (state.initialWidth - item.width);
        if (isTop) item.y = state.initialY + (state.initialHeight - item.height);
      }
    }
  }

  /**
   * Update media overlay position
   * @private
   */
  _updateMediaOverlay() {
    if (this.selectedMediaId && this.mediaOverlay) {
      const item = this.mediaManager.getItems().find((i) => i.id === this.selectedMediaId);
      if (item) {
        const scrollLeft = this.scroller.getScrollLeft();
        const scrollTop = this.scroller.getScrollTop();
        const viewport = this.scroller.getViewportElement().getBoundingClientRect();

        // Calculate offset (centering)
        const viewportWidth = this.scroller.getViewportSize().width;
        const scaledContentWidth = this.maxContentWidth * this.zoomScale;
        const offsetX =
          scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;

        this.mediaOverlay.show(item, this.zoomScale, scrollLeft, scrollTop, viewport, offsetX);
      }
    }
  }

  /**
   * Delete the currently selected media item
   */
  async deleteSelectedMedia(id = null) {
    const targetId = id || this.selectedMediaId;
    if (!targetId) return;

    // Find item to get fileId before removing
    const item = this.mediaManager.getItems().find((i) => i.id === targetId);

    if (!item) {
      return;
    }

    // Record undo command BEFORE deleting (need full item data)
    this.historyManager?.push(new DeleteMediaCommand([{ ...item }]));

    // Track deleted media ID
    this.noteData.deletedMedia.push(targetId);

    // Remove from manager
    this.mediaManager.removeItem(targetId);
    this.selectedMediaId = null;
    this.renderer.setSelectedMedia(null);
    this.mediaOverlay.hide();

    // Clean up PDF text layer if this was a PDF page
    if (item.type === "pdf-page" && this.pdfTextLayerManager) {
      this.pdfTextLayerManager.onPageRemoved(targetId);
    }

    // Save changes to note structure
    await this._saveMediaChanges();

    // Note: We do NOT delete binary files on user delete action
    // This allows undo to restore the media. Files are cleaned up separately.

    this.renderer.forceRedraw();
  }

  /**
   * Crop the selected media item
   */
  async cropSelectedMedia(id) {
    const item = this.mediaManager.getItems().find((i) => i.id === id);
    const img = this.mediaManager.getImage(item?.fileId);

    if (!item || !img) return;

    // Capture original state for undo
    const originalFileId = item.fileId;
    const originalDimensions = { width: item.width, height: item.height };

    const cropper = new ImageCropper();
    const blob = await cropper.show(img);

    if (blob) {
      // Save new file
      const newFileId = await saveFile(blob);

      // Update item
      // We need to update width/height to match new aspect ratio but keep same display width?
      // Or reset to natural size? Let's keep width and adjust height.
      const newImg = new Image();
      newImg.src = URL.createObjectURL(blob);
      await new Promise((r) => {
        newImg.onload = r;
      });

      const ratio = newImg.height / newImg.width;
      const newHeight = item.width * ratio;

      // Record undo command BEFORE applying changes
      this.historyManager?.push(
        new CropImageCommand(id, originalFileId, originalDimensions, newFileId, {
          width: item.width,
          height: newHeight,
        }),
      );

      this.mediaManager.updateItem(id, {
        fileId: newFileId,
        height: newHeight,
      });

      this._saveMediaChanges();
      this.renderer.forceRedraw();
      this._updateMediaOverlay();
    }
  }

  moveSelectedMediaToFront(id) {
    // Find original index for undo
    const items = this.mediaManager.getItems();
    const originalIndex = items.findIndex((i) => i.id === id);

    if (originalIndex !== -1 && originalIndex !== items.length - 1) {
      this.historyManager?.push(new ReorderMediaCommand(id, "front", originalIndex));
    }

    this.mediaManager.moveItemToFront(id);
    this._saveMediaChanges();
    this.renderer.forceRedraw();
    this._updateMediaOverlay();
  }

  moveSelectedMediaToBack(id) {
    // Find original index for undo
    const items = this.mediaManager.getItems();
    const originalIndex = items.findIndex((i) => i.id === id);

    if (originalIndex !== -1 && originalIndex !== 0) {
      this.historyManager?.push(new ReorderMediaCommand(id, "back", originalIndex));
    }

    this.mediaManager.moveItemToBack(id);
    this._saveMediaChanges();
    this.renderer.forceRedraw();
    this._updateMediaOverlay();
  }

  /**
   * Save media changes to storage
   * @private
   */
  async _saveMediaChanges() {
    if (this.noteId && this.mediaManager) {
      this.mediaChanged = true;
      const items = this.mediaManager.getItems();
      // Strip non-serializable properties (renderable, loading, error) before sending to worker
      // These are runtime-only properties used for rendering, not persisted data
      const serializableMedia = items.map(
        ({
          renderable: _renderable,
          renderableScale: _renderableScale,
          loading: _loading,
          error: _error,
          ...rest
        }) => rest,
      );
      this.noteData.media = serializableMedia;
      // Use StrokeManager (which uses StorageWorker) to save media updates
      // This prevents race conditions between stroke saving and media saving
      this.strokeManager.saveMedia({
        media: serializableMedia,
        deletedMedia: this.noteData.deletedMedia,
        pdfSource: this.noteData.pdfSource,
      });
    }
  }

  /**
   * Detect if a stroke is a scratch-out gesture
   * Definition: At least 3 horizontal segments (Back-Forth-Back)
   * @private
   */
  _isScratchGesture(stroke) {
    if (!stroke || stroke.x.length < SCRATCH_MIN_POINTS) return false;

    // Disable scratch-out for marker pens
    if (stroke.type === "marker") return false;

    // 1. Calculate bounds and total path length
    let minX = stroke.x[0],
      maxX = stroke.x[0],
      minY = stroke.y[0],
      maxY = stroke.y[0];
    let totalLength = 0;

    for (let i = 1; i < stroke.x.length; i++) {
      minX = Math.min(minX, stroke.x[i]);
      maxX = Math.max(maxX, stroke.x[i]);
      minY = Math.min(minY, stroke.y[i]);
      maxY = Math.max(maxY, stroke.y[i]);

      const dx = stroke.x[i] - stroke.x[i - 1];
      const dy = stroke.y[i] - stroke.y[i - 1];
      totalLength += Math.sqrt(dx * dx + dy * dy);
    }

    const width = maxX - minX;
    const height = maxY - minY;
    const diag = Math.sqrt(width * width + height * height);

    // Minimum size threshold to avoid accidental triggers on small letters
    if (width < SCRATCH_MIN_SIZE && height < SCRATCH_MIN_SIZE) return false;

    // Density check: Scratch-out has high ink-to-area ratio (vs straight line or simple curve)
    // Letters like 'Z' or 'M' usually have ratio < threshold. Scratches usually > threshold.
    if (diag === 0 || totalLength / diag < SCRATCH_DENSITY_THRESHOLD) return false;

    // 2. Analyze direction changes in primary axis (Horizontal or Vertical)
    const isHorizontal = width > height;
    const primaryValues = isHorizontal ? stroke.x : stroke.y;

    let changes = 0;
    let currentDir = 0;
    let lastVal = primaryValues[0];

    for (let i = 1; i < primaryValues.length; i++) {
      const d = primaryValues[i] - lastVal;
      if (Math.abs(d) > SCRATCH_DIRECTION_THRESHOLD) {
        const dir = Math.sign(d);
        if (currentDir !== 0 && dir !== currentDir) {
          changes++;
        }
        currentDir = dir;
        lastVal = primaryValues[i];
      }
    }

    // Require minimum direction changes to avoid false positives like 'M', 'W', 'Z'
    return changes >= SCRATCH_MIN_DIRECTION_CHANGES;
  }

  /**
   * Erase strokes covered by the scratch gesture
   * @private
   */
  _handleScratchErase(gestureStroke) {
    // Calculate bounds of the gesture
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;

    for (let i = 0; i < gestureStroke.x.length; i++) {
      minX = Math.min(minX, gestureStroke.x[i]);
      maxX = Math.max(maxX, gestureStroke.x[i]);
      minY = Math.min(minY, gestureStroke.y[i]);
      maxY = Math.max(maxY, gestureStroke.y[i]);
    }

    // Add padding to catch small nearby strokes (like 'i' dots)
    const eraseRect = {
      minX: minX - SCRATCH_ERASE_PADDING,
      maxX: maxX + SCRATCH_ERASE_PADDING,
      minY: minY - SCRATCH_ERASE_PADDING,
      maxY: maxY + SCRATCH_ERASE_PADDING,
    };

    // Use lasso logic to find strokes fully contained in the (rectangular) erase area
    // We create a polygon from the rect to reuse _findStrokesInPolygon logic
    const polygon = [
      { x: eraseRect.minX, y: eraseRect.minY },
      { x: eraseRect.maxX, y: eraseRect.minY },
      { x: eraseRect.maxX, y: eraseRect.maxY },
      { x: eraseRect.minX, y: eraseRect.maxY },
    ];

    // Find strokes. Note: _findStrokesInPolygon checks if stroke is FULLY inside.
    // For a scratch-out, usually we want to delete anything we scribbled over.
    // However, checking intersection is expensive. Checking "fully inside bounding box of scratch"
    // is a safe and performant approximation if the user scribbles widely enough.
    // If we want "intersects", we'd need a different query.
    // Let's stick to "fully inside the expanded bounding box" for safety and performance.
    const { selectedIndices } = this._findStrokesInPolygon(polygon, eraseRect);

    if (selectedIndices.size > 0) {
      // Collect erased strokes for undo command
      const erasedStrokes = [];

      selectedIndices.forEach((index) => {
        const s = this.noteData.strokes[index];
        if (s) {
          s._deleted = true;
          erasedStrokes.push({ index, id: s.id });
          if (s.id) this.noteData.deletedStrokes.push(s.id);
        }
      });

      // Record undo command for scratch erase
      if (erasedStrokes.length > 0) {
        this.historyManager?.push(new EraseStrokesCommand(erasedStrokes));
      }

      this.strokesChanged = true;
      this.strokeManager.markDirty();
      this.strokeManager.forceSave();
      this.renderer.forceRedraw();
    }
  }

  /**
   * Handle end of lasso selection
   * @private
   */
  _handleLassoEnd() {
    if (this.lassoPoints.length < 3) return;

    // Convert screen points to content coordinates
    const polygon = this._convertLassoToContentCoords();
    const lassoBounds = this._calculatePolygonBounds(polygon);

    // Find strokes fully contained within the lasso polygon
    const { selectedIndices, selectionBounds } = this._findStrokesInPolygon(polygon, lassoBounds);

    this.renderer.setSelectedStrokes(selectedIndices, selectionBounds);
    this.lassoPoints = [];
  }

  /**
   * Convert lasso screen points to content coordinates
   * @private
   * @returns {Array<{x: number, y: number}>} Polygon in content coordinates
   */
  _convertLassoToContentCoords() {
    const rect = this.scroller.getViewportElement().getBoundingClientRect();
    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const zoom = this.zoomScale;

    // Calculate offset (centering) to match InputHandler logic
    const viewportWidth = this.scroller.getViewportSize().width;
    const scaledContentWidth = this.maxContentWidth * zoom;
    const offsetX =
      scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;

    return this.lassoPoints.map((p) => ({
      x: (p.x - rect.left - offsetX + scrollLeft) / zoom,
      y: (p.y - rect.top + scrollTop) / zoom,
    }));
  }

  /**
   * Calculate bounding box of a polygon
   * @private
   * @param {Array<{x: number, y: number}>} polygon
   * @returns {{minX: number, maxX: number, minY: number, maxY: number}}
   */
  _calculatePolygonBounds(polygon) {
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

    return { minX, maxX, minY, maxY };
  }

  /**
   * Find all strokes fully contained within a polygon
   * @private
   * @param {Array<{x: number, y: number}>} polygon - Lasso polygon in content coords
   * @param {{minX: number, maxX: number, minY: number, maxY: number}} lassoBounds
   * @returns {{selectedIndices: Set<number>, selectionBounds: Object|null}}
   */
  _findStrokesInPolygon(polygon, lassoBounds) {
    const { minX, maxX, minY, maxY } = lassoBounds;
    const candidates = this.spatialIndex.query(minY, maxY);
    const selectedIndices = new Set();

    let selMinX = Infinity,
      selMaxX = -Infinity,
      selMinY = Infinity,
      selMaxY = -Infinity;
    let hasSelection = false;

    for (const index of candidates) {
      const stroke = this.noteData.strokes[index];
      if (!stroke || stroke._deleted || stroke.isDeleted) continue;

      // Use cached bounds from spatial index
      const strokeBounds = this.spatialIndex.strokeBounds.get(index);
      if (!strokeBounds) continue;

      const { minX: sMinX, maxX: sMaxX, minY: sMinY, maxY: sMaxY } = strokeBounds;

      // Fast fail: stroke bounds must be fully inside lasso bounds
      if (sMinX < minX || sMaxX > maxX || sMinY < minY || sMaxY > maxY) {
        continue;
      }

      // Check if all stroke points are inside the polygon
      if (this._isStrokeFullyInPolygon(stroke, polygon)) {
        selectedIndices.add(index);
        selMinX = Math.min(selMinX, sMinX);
        selMaxX = Math.max(selMaxX, sMaxX);
        selMinY = Math.min(selMinY, sMinY);
        selMaxY = Math.max(selMaxY, sMaxY);
        hasSelection = true;
      }
    }

    const selectionBounds = hasSelection
      ? {
          minX: selMinX - SELECTION_BOUNDS_PADDING,
          minY: selMinY - SELECTION_BOUNDS_PADDING,
          maxX: selMaxX + SELECTION_BOUNDS_PADDING,
          maxY: selMaxY + SELECTION_BOUNDS_PADDING,
        }
      : null;

    return { selectedIndices, selectionBounds };
  }

  /**
   * Check if all points of a stroke are inside a polygon
   * @private
   * @param {Object} stroke - Stroke with x[] and y[] arrays
   * @param {Array<{x: number, y: number}>} polygon
   * @returns {boolean}
   */
  _isStrokeFullyInPolygon(stroke, polygon) {
    for (let i = 0; i < stroke.x.length; i++) {
      if (!this._isPointInPolygon({ x: stroke.x[i], y: stroke.y[i] }, polygon)) {
        return false;
      }
    }
    return true;
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
    const newlyErased = [];

    for (const index of candidates) {
      const stroke = this.noteData.strokes[index];
      if (stroke._deleted) continue;

      if (this._strokeIntersectsCircle(stroke, contentX, contentY, contentRadius)) {
        stroke._deleted = true;
        newlyErased.push({ index, id: stroke.id });
        if (stroke.id) {
          this.noteData.deletedStrokes.push(stroke.id);
        }
      }
    }

    if (newlyErased.length > 0) {
      // Add to eraser batch for undo (multiple strokes in one gesture = one undo)
      if (!this._eraserBatch) {
        this._eraserBatch = [];
      }
      this._eraserBatch.push(...newlyErased);

      this.renderer.forceRedraw();
      this.strokeManager.markDirty();
      this.strokeManager.forceSave(); // Save changes
      this.strokesChanged = true;
    }
  }

  /**
   * Commit the eraser batch to history (called when eraser gesture ends)
   * @private
   */
  _commitEraserBatch() {
    if (this._eraserBatch && this._eraserBatch.length > 0) {
      const cmd = new EraseStrokesCommand(this._eraserBatch);
      this.historyManager?.push(cmd);
    }
    this._eraserBatch = null;
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
   * Check if point is on a resize handle
   * @private
   */
  _getHandleAtPoint(x, y) {
    const bounds = this.renderer.selectionBounds;
    if (!bounds) return null;

    const half = SELECTION_HANDLE_HIT_AREA / this.zoomScale / 2;
    const handles = getSelectionHandles(bounds, this.zoomScale);

    for (const { key, x: hx, y: hy } of handles) {
      if (Math.abs(x - hx) <= half && Math.abs(y - hy) <= half) {
        return key;
      }
    }
    return null;
  }

  /**
   * Check if point is inside selection bounds
   * @private
   */
  _isPointInSelection(x, y) {
    const bounds = this.renderer.selectionBounds;
    if (!bounds) return false;
    return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
  }

  /**
   * Start a move or resize operation
   * @private
   */
  _startTransform(mode, x, y, handle = null) {
    const selectedIndices = Array.from(this.renderer.selectedStrokeIndices);

    // Clone only the coordinate arrays we need (much faster than JSON deep copy)
    const initialStrokes = selectedIndices.map((index) => {
      const stroke = this.noteData.strokes[index];
      return {
        x: stroke.x.slice(),
        y: stroke.y.slice(),
      };
    });

    this.transformState = {
      mode,
      handle,
      startX: x,
      startY: y,
      initialBounds: { ...this.renderer.selectionBounds },
      initialStrokes,
      selectedIndices,
    };
  }

  /**
   * Handle move during transform
   * @private
   */
  _handleTransformMove(x, y) {
    const { mode, handle, startX, startY, initialBounds, initialStrokes, selectedIndices } =
      this.transformState;
    const dx = x - startX;
    const dy = y - startY;

    let newBounds = { ...initialBounds };

    if (mode === "move") {
      this._handleMove(dx, dy, newBounds, initialStrokes, selectedIndices);
    } else if (mode === "resize") {
      this._handleResize(dx, dy, handle, newBounds, initialBounds, initialStrokes, selectedIndices);
    } else if (mode === "rotate") {
      newBounds = this._handleRotate(
        x,
        y,
        startX,
        startY,
        initialBounds,
        initialStrokes,
        selectedIndices,
      );
    }

    // Update renderer
    this.renderer.setSelectedStrokes(this.renderer.selectedStrokeIndices, newBounds);
  }

  /**
   * Handle move transform - translate all selected strokes
   * @private
   */
  _handleMove(dx, dy, newBounds, initialStrokes, selectedIndices) {
    newBounds.minX += dx;
    newBounds.maxX += dx;
    newBounds.minY += dy;
    newBounds.maxY += dy;

    // Update strokes in-place for better performance
    selectedIndices.forEach((index, i) => {
      const stroke = this.noteData.strokes[index];
      const initial = initialStrokes[i];
      for (let j = 0; j < stroke.x.length; j++) {
        stroke.x[j] = initial.x[j] + dx;
        stroke.y[j] = initial.y[j] + dy;
      }
    });
  }

  /**
   * Handle resize transform - scale all selected strokes
   * @private
   */
  _handleResize(dx, dy, handle, newBounds, initialBounds, initialStrokes, selectedIndices) {
    // Calculate new bounds based on handle
    if (handle.includes("e")) newBounds.maxX += dx;
    if (handle.includes("w")) newBounds.minX += dx;
    if (handle.includes("s")) newBounds.maxY += dy;
    if (handle.includes("n")) newBounds.minY += dy;

    // Calculate initial dimensions with safety check for zero
    const initialWidth = initialBounds.maxX - initialBounds.minX;
    const initialHeight = initialBounds.maxY - initialBounds.minY;

    // Enforce minimum size constraints
    const minSize = MIN_SELECTION_SIZE / this.zoomScale;
    let newWidth = newBounds.maxX - newBounds.minX;
    let newHeight = newBounds.maxY - newBounds.minY;

    if (newWidth < minSize) {
      if (handle.includes("w")) newBounds.minX = newBounds.maxX - minSize;
      else newBounds.maxX = newBounds.minX + minSize;
      newWidth = minSize;
    }
    if (newHeight < minSize) {
      if (handle.includes("n")) newBounds.minY = newBounds.maxY - minSize;
      else newBounds.maxY = newBounds.minY + minSize;
      newHeight = minSize;
    }

    // Enforce aspect ratio for corner handles
    if (handle.length === 2 && initialHeight > 0) {
      const initialRatio = initialWidth / initialHeight;
      const currentRatio = newWidth / newHeight;

      if (currentRatio > initialRatio) {
        // Too wide, adjust height
        const targetHeight = newWidth / initialRatio;
        if (handle.includes("n")) newBounds.minY = newBounds.maxY - targetHeight;
        else newBounds.maxY = newBounds.minY + targetHeight;
      } else {
        // Too tall, adjust width
        const targetWidth = newHeight * initialRatio;
        if (handle.includes("w")) newBounds.minX = newBounds.maxX - targetWidth;
        else newBounds.maxX = newBounds.minX + targetWidth;
      }
    }

    // Calculate scale factors with division-by-zero protection
    const scaleX = initialWidth > 0 ? (newBounds.maxX - newBounds.minX) / initialWidth : 1;
    const scaleY = initialHeight > 0 ? (newBounds.maxY - newBounds.minY) / initialHeight : 1;

    // Update strokes by scaling
    selectedIndices.forEach((index, i) => {
      const stroke = this.noteData.strokes[index];
      const initial = initialStrokes[i];

      for (let j = 0; j < stroke.x.length; j++) {
        stroke.x[j] = newBounds.minX + (initial.x[j] - initialBounds.minX) * scaleX;
        stroke.y[j] = newBounds.minY + (initial.y[j] - initialBounds.minY) * scaleY;
      }
    });
  }

  /**
   * Handle rotate transform - rotate all selected strokes around center
   * @private
   * @returns {Object} New bounds after rotation
   */
  _handleRotate(x, y, startX, startY, initialBounds, initialStrokes, selectedIndices) {
    const centerX = (initialBounds.minX + initialBounds.maxX) / 2;
    const centerY = (initialBounds.minY + initialBounds.maxY) / 2;

    const startAngle = Math.atan2(startY - centerY, startX - centerX);
    const currentAngle = Math.atan2(y - centerY, x - centerX);
    const angle = currentAngle - startAngle;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Rotate strokes and track new bounds
    let rMinX = Infinity,
      rMaxX = -Infinity,
      rMinY = Infinity,
      rMaxY = -Infinity;

    selectedIndices.forEach((index, i) => {
      const stroke = this.noteData.strokes[index];
      const initial = initialStrokes[i];

      for (let j = 0; j < stroke.x.length; j++) {
        const px = initial.x[j] - centerX;
        const py = initial.y[j] - centerY;
        const newX = centerX + px * cos - py * sin;
        const newY = centerY + px * sin + py * cos;
        stroke.x[j] = newX;
        stroke.y[j] = newY;

        // Track bounds while we're iterating
        rMinX = Math.min(rMinX, newX);
        rMaxX = Math.max(rMaxX, newX);
        rMinY = Math.min(rMinY, newY);
        rMaxY = Math.max(rMaxY, newY);
      }
    });

    return {
      minX: rMinX - SELECTION_BOUNDS_PADDING,
      maxX: rMaxX + SELECTION_BOUNDS_PADDING,
      minY: rMinY - SELECTION_BOUNDS_PADDING,
      maxY: rMaxY + SELECTION_BOUNDS_PADDING,
    };
  }

  /**
   * End transform operation
   * @private
   */
  _endTransform() {
    const { selectedIndices, initialStrokes } = this.transformState;

    // Capture final coordinates for undo command
    const finalCoords = selectedIndices.map((index) => {
      const stroke = this.noteData.strokes[index];
      return {
        x: stroke.x.slice(),
        y: stroke.y.slice(),
      };
    });

    // Check if anything actually changed
    const hasChanges = initialStrokes.some((initial, i) => {
      const final = finalCoords[i];
      return initial.x.some((x, j) => x !== final.x[j] || initial.y[j] !== final.y[j]);
    });

    // Record undo command if there were changes
    if (hasChanges) {
      const cmd = new TransformStrokesCommand(selectedIndices, initialStrokes, finalCoords);
      this.historyManager?.push(cmd);
    }

    // Update spatial index (with validation to handle stale references)
    selectedIndices.forEach((index) => {
      const stroke = this.noteData.strokes[index];
      if (!stroke || stroke._deleted) return; // Skip invalid/deleted strokes

      this.spatialIndex.remove(index);
      this.spatialIndex.insert(stroke, index);
    });

    // Recalculate content height if strokes moved down
    const contentBounds = this.spatialIndex.getContentBounds();
    if (contentBounds) {
      const newHeight = Math.max(contentBounds.maxY + 500, this.scroller.getViewportSize().height);
      if (newHeight > this.contentHeight) {
        this._expandCanvas(newHeight - this.contentHeight);
      }
    }

    this.strokeManager.markDirty();
    this.strokeManager.forceSave();
    this.strokesChanged = true;
    this.transformState = null;

    // Force full redraw to ensure high quality
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
    // Handle media hit testing for Pan mode
    const { x, y } = this.inputHandler.getContentCoordinates(e.clientX, e.clientY);
    const mediaResult = this._handleMediaInteraction(x, y, e.clientX, e.clientY);

    if (mediaResult.consumed) {
      // Started dragging selected media - consume event to prevent pan
      e.preventDefault();
      e.stopPropagation();
      return;
    }

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
    // Check long press movement
    if (this.longPressTimer) {
      this._checkLongPressMove(e.clientX, e.clientY);
    }

    // Handle media dragging in Pan mode
    if (this.mediaDragState) {
      const { x, y } = this.inputHandler.getContentCoordinates(e.clientX, e.clientY);
      this._handleMediaTransformMove(x, y);
      this.renderer.forceRedraw();
      this._updateMediaOverlay();
      return;
    }

    if (!this.activePointers.has(e.pointerId)) return;

    // Prevent panning if currently drawing (prevents palm movements from sliding canvas while writing)
    if (this.inputHandler?.isDrawing) return;

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
      // If in manual draw/eraser mode, single touch should draw/erase, not pan.
      // UNLESS stylus mode is active (stylusDetected), then touch always pans.
      if (!this.stylusDetected && this.mode !== "pan" && !this.autoSwitchedToDrawMode) return;
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
    this._clearLongPress();

    if (this.mediaDragState) {
      const state = this.mediaDragState;
      const item = state.item;

      // Check if transform actually changed anything
      const hasChanged =
        item.x !== state.initialX ||
        item.y !== state.initialY ||
        item.width !== state.initialWidth ||
        item.height !== state.initialHeight ||
        (item.rotation || 0) !== state.initialRotation;

      if (hasChanged) {
        // Record undo command with initial and final states
        this.historyManager?.push(
          new TransformMediaCommand(
            item.id,
            {
              x: state.initialX,
              y: state.initialY,
              width: state.initialWidth,
              height: state.initialHeight,
              rotation: state.initialRotation,
            },
            {
              x: item.x,
              y: item.y,
              width: item.width,
              height: item.height,
              rotation: item.rotation || 0,
            },
          ),
        );
      }

      this.mediaDragState = null;
      this._saveMediaChanges();
    }

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
    const friction = 0.95; // Increased from 0.75 for natural, longer glide
    const stopThreshold = 0.05; // Lower threshold for smoother stop
    let lastTime = performance.now();

    const animate = (time) => {
      const dt = time - lastTime;
      lastTime = time;

      if (dt > 0) {
        const dx = this.velocityX * dt;
        const dy = this.velocityY * dt;

        this.scroller.scrollBy(-dx, -dy);

        // Apply friction adjusted for time delta (normalize to ~60fps)
        const timeFactor = dt / 16.67;
        const currentFriction = friction ** timeFactor;
        this.velocityX *= currentFriction;
        this.velocityY *= currentFriction;
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
      if (this._pendingMediaUpdate) {
        this.renderer.forceRedraw();
        this._pendingMediaUpdate = false;
      }

      const scrollTop = this.scroller?.getScrollTop() || 0;
      const scrollLeft = this.scroller?.getScrollLeft() || 0;
      this.renderer.setZoom(scale, {
        ...options,
        scrollTop,
        scrollLeft,
      });
    }

    // Update PDF text layers after zoom
    this._updatePdfTextLayers();
    this._updatePdfControlsPosition();
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
   * Generate and save a thumbnail for the current note
   * Stores promise on instance so destroy() can wait for completion
   * @private
   */
  _saveThumbnail() {
    if (!this.noteId || !this.renderer || !this.noteData || !this.strokeManager?.worker) return;

    // Capture all required state SYNCHRONOUSLY before any async work
    const noteId = this.noteId;
    const oldThumbnailId = this.noteData.thumbnailFileId;
    const worker = this.strokeManager.worker;

    // 1. Create offscreen canvas and render SYNCHRONOUSLY
    const thumbWidth = 800; // Match display resolution (800x600) to avoid blur
    const thumbHeight = 600; // 4:3 aspect ratio
    const canvas = document.createElement("canvas");
    canvas.width = thumbWidth;
    canvas.height = thumbHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 2. Render snapshot SYNCHRONOUSLY (before destroy() nullifies renderer)
    this.renderer.renderSnapshot(ctx, thumbWidth, thumbHeight);

    // Store the promise so destroy() can wait for it
    this._pendingThumbnailSave = this._doSaveThumbnail(canvas, noteId, oldThumbnailId, worker);
  }

  /**
   * Internal async implementation of thumbnail save
   * All synchronous state is captured and passed as parameters
   * @private
   */
  async _doSaveThumbnail(canvas, noteId, oldThumbnailId, worker) {
    try {
      // 3. Convert to Blob (async)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));

      if (!blob) return;

      // 4. Save to storage (async)
      const fileId = await saveFile(blob);

      // 5. Update note metadata
      const timestamp = Date.now();

      // Update in-memory data if still valid
      if (this.noteData && this.noteId === noteId) {
        this.noteData.thumbnailFileId = fileId;
        this.noteData.thumbnailTimestamp = timestamp;
      }

      // Post to worker - this must happen before CLOSE is sent
      worker.postMessage({
        type: "SAVE_THUMBNAIL",
        noteId: noteId,
        thumbnailFileId: fileId,
        thumbnailTimestamp: timestamp,
      });

      if (oldThumbnailId) {
        deleteFile(oldThumbnailId).catch(() => {});
      }
    } catch (error) {
      console.error("[NoteCanvas] Failed to save thumbnail:", error);
    }
  }

  /**
   * Delete the imported PDF and all its pages
   */
  async deletePdf() {
    if (!this.noteData.pdfSource) return;

    const confirmed = await showConfirmDialog(
      "Delete PDF",
      "Are you sure you want to remove the PDF document? This will remove all pages.",
      "Delete",
      "btn-danger",
    );

    if (!confirmed) return;

    // 1. Identify PDF pages and capture data for undo
    const pdfPages = this.mediaManager.getItems().filter((i) => i.type === "pdf-page");
    const sourceFileId = this.noteData.pdfSource;

    // Record undo command BEFORE deleting (need full item data)
    if (pdfPages.length > 0) {
      this.historyManager?.push(
        new DeleteMediaCommand(
          pdfPages.map((p) => ({ ...p })),
          true,
          sourceFileId,
        ),
      );
    }

    // 2. Remove PDF pages
    pdfPages.forEach((p) => {
      this.noteData.deletedMedia.push(p.id);
      this.mediaManager.removeItem(p.id);
      if (this.pdfTextLayerManager) {
        this.pdfTextLayerManager.onPageRemoved(p.id);
      }
    });

    // 3. Remove source reference
    this.noteData.pdfSource = null;

    // 3. Save changes (triggers sync via dirty flag in StrokeManager)
    await this._saveMediaChanges();

    // 4. Cleanup local file (fire and forget)
    if (sourceFileId) {
      deleteFile(sourceFileId).catch(() => {});
    }

    this.renderer.forceRedraw();
    this._renderPdfControls();
    this._saveThumbnail();
  }

  /**
   * Clean up all resources
   */
  destroy() {
    // Trigger handwriting recognition if strokes changed
    if (this.strokesChanged && this.noteId && this.noteData?.strokes) {
      const activeStrokes = this.noteData.strokes.filter((s) => !s._deleted && !s.isDeleted);
      if (activeStrokes.length > 0) {
        forceRecognition(this.noteId, activeStrokes).catch((e) =>
          console.error("[NoteCanvas] Recognition failed:", e),
        );
      }
    }

    // Save thumbnail if changes were made or if it's missing
    // This initiates the async save and stores promise in _pendingThumbnailSave
    if (
      (this.strokesChanged || this.mediaChanged || !this.noteData?.thumbnailFileId) &&
      this.noteId
    ) {
      this._saveThumbnail();
    }

    // Cancel pending scroll RAF
    if (this._scrollRafId) {
      cancelAnimationFrame(this._scrollRafId);
      this._scrollRafId = null;
    }
    this._pendingScroll = null;

    // Remove event listeners
    window.removeEventListener("themechange", this._onThemeChange);
    window.removeEventListener("datachange", this._onDataChange);
    window.removeEventListener("keydown", this._onKeyDown);

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

    // Destroy modules (except strokeManager - must wait for thumbnail)
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

    if (this.mediaManager) {
      this.mediaManager.destroy();
      this.mediaManager = null;
    }

    if (this.mediaOverlay) {
      this.mediaOverlay.destroy();
      this.mediaOverlay = null;
    }

    if (this.historyManager) {
      this.historyManager.destroy();
      this.historyManager = null;
    }

    if (this.pdfTextLayerManager) {
      this.pdfTextLayerManager.destroy();
      this.pdfTextLayerManager = null;
    }

    if (this.inputHandler) {
      this.inputHandler.destroy();
      this.inputHandler = null;
    }

    if (this.toolbar) {
      this.toolbar.destroy();
      this.toolbar = null;
    }

    // Wait for pending thumbnail save before destroying strokeManager
    // This ensures SAVE_THUMBNAIL message is sent before CLOSE
    const cleanupStrokeManager = () => {
      if (this.strokeManager) {
        this.strokeManager.forceSave();
        this.strokeManager.destroy();
        this.strokeManager = null;
      }
    };

    if (this._pendingThumbnailSave) {
      this._pendingThumbnailSave.then(cleanupStrokeManager).catch(cleanupStrokeManager);
    } else {
      cleanupStrokeManager();
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
