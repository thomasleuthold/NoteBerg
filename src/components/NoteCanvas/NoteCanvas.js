/**
 * NoteCanvas - Main entry point for virtualized note rendering
 *
 * Coordinates the VirtualScroller, CanvasRenderer, and SpatialIndex
 * to provide smooth 60fps scrolling and instant zoom for large notes.
 * Supports both viewing and drawing with stylus/pen input.
 */

import { t } from "../../i18n/index.js";
import { forceRecognition } from "../../modules/autoRecognition.js";
import { getEncryptionKey, isAppUnlocked } from "../../modules/masterPassword.js";
import { downloadPdfBytes, exportNoteToPdf } from "../../modules/pdfExport.js";
import { getPdfOutline, importPdf, loadPdfPage } from "../../modules/pdfManager.js";
import { navigateTo } from "../../modules/router.js";
import {
  deleteFile,
  deleteNote,
  generateId,
  getFile,
  getNote,
  registerPendingUpload,
  saveFile,
  saveMediaForNote,
  updateNote,
} from "../../modules/storage.js";

const _IS_NEXTCLOUD = import.meta.env.VITE_PLATFORM === "nextcloud";

import { getIcon } from "../../utils/icons.js";
import { captureFromCamera, pickImages, processImageFile } from "../../utils/imageUtils.js";
import {
  drawStroke as sharedDrawStroke,
  getThemePalette as sharedGetThemePalette,
} from "../../utils/noteRenderer.js";
import { showAlertDialog, showConfirmDialog, showProgressDialog } from "../modals.js";
import { AppClipboard } from "./AppClipboard.js";
import { CanvasRenderer } from "./CanvasRenderer.js";
import { ContextFloatingMenu } from "./ContextFloatingMenu.js";
import { ImageCropper } from "./ImageCropper.js";
import { InputHandler } from "./InputHandler.js";
import { MediaManager } from "./MediaManager.js";
import { MediaOverlay } from "./MediaOverlay.js";
import { SelectionOverlay } from "./SelectionOverlay.js";
import { TaskCheckboxLayer } from "./TaskCheckboxLayer.js";
import "./NoteCanvas.css";
import {
  CropImageCommand,
  DeleteMediaCommand,
  DrawStrokeCommand,
  EraseStrokePartsCommand,
  EraseStrokesCommand,
  InsertMediaCommand,
  MarkTaskCommand,
  PasteStrokesCommand,
  ReorderMediaCommand,
  ShiftContentCommand,
  TransformMediaCommand,
  TransformStrokesCommand,
} from "./commands/index.js";
import { HistoryManager } from "./HistoryManager.js";
import { NoteNavigator } from "./NoteNavigator.js";
import { NoteToolbar } from "./NoteToolbar.js";
import { PdfTextLayerManager } from "./PdfTextLayerManager.js";
import { RecordingManager } from "./RecordingManager.js";
import { SoundDialog } from "./SoundDialog.js";
import { SpatialIndex } from "./SpatialIndex.js";
import { StrokeManager } from "./StrokeManager.js";
import { detectLineIndentation, detectStrokeLines } from "./strokeLineDetection.js";
import { TextEditorLayer } from "./TextEditorLayer.js";
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
    this.selectionOverlay = null;
    this.taskCheckboxLayer = null;
    this.pdfTextLayerManager = null;
    this.toolbar = null;
    this.contentHeight = 0;
    this.recordingManager = null;
    this.soundDialog = null;

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
    this._textModePanState = null; // Touch-pan state for text mode (threshold detection)
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
    this.textChanged = false; // Track if text content has been modified
    this.activeSearchQuery = null; // Track active search query for highlighting
    this.mediaDragState = null; // { item, startX, startY, initialX, initialY }
    this.selectedMediaId = null; // Track selected media item
    this.penPresets = null; // Pen presets configuration
    this.selectedTaskId = null; // Track selected task ID for removal
    this.taskSelectionBounds = null; // Track bounds for task selection in non-lasso mode

    // Long press state
    this.longPressTimer = null;
    this.longPressStart = null;

    // Undo/redo history
    this.historyManager = null;
    this.insertSpaceState = null; // { startY: number, currentY: number }

    // Eraser batching for undo (multiple strokes erased in one gesture = one undo)
    this._eraserBatch = null;

    // Eraser settings
    this.eraserMode = "stroke"; // 'stroke' | 'part'
    this.eraserSize = 20; // diameter in screen pixels
    this.eraserHighlighterOnly = false;
    this._partEraserOps = null; // Array of ops accumulated during a part-erase gesture

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

    // If local has MORE strokes than DB AND local is dirty (unsaved changes in progress),
    // do not reload — we are ahead because the user is actively drawing.
    // If freshData.synced === true, the DB reflects a downloaded server version and we must
    // reload even if the count decreased (e.g. another device erased strokes).
    if (currentStrokesCount > freshStrokesCount && freshData.synced === false) {
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
    // Merge tasks like strokes: union of local+remote, deletedTasks wins
    const localDeletedTaskIds = new Set([
      ...(inMemoryData.deletedTasks || []),
      ...(freshDataFromDB.deletedTasks || []),
    ]);
    const mergedTasksMap = new Map();
    [...(inMemoryData.tasks || []), ...(freshDataFromDB.tasks || [])].forEach((t) => {
      if (t.id) mergedTasksMap.set(t.id, t);
    });
    // Filter out deleted tasks and orphaned stroke tasks (strokes gone after merge)
    const mergedActiveStrokeIds = new Set(finalStrokes.map((s) => s.id));
    const mergedTasks = Array.from(mergedTasksMap.values()).filter((t) => {
      if (localDeletedTaskIds.has(t.id)) return false;
      if (t.type === "stroke") {
        const alive = t.strokeIds.some((id) => mergedActiveStrokeIds.has(id));
        if (!alive) localDeletedTaskIds.add(t.id);
        return alive;
      }
      return true;
    });
    inMemoryData.tasks = mergedTasks;
    inMemoryData.deletedTasks = Array.from(localDeletedTaskIds);
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
    this.renderer.showA4PageBreaks =
      !inMemoryData.pdfSource && !this.mediaManager.getItems().some((i) => i.type === "pdf-page");

    // Force redraw immediately to show updated state (we know we aren't drawing)
    this.renderer.forceRedraw();
    this._renderPdfControls();
    this._saveTasks();
    this._updateTaskCheckboxes();
    this._updateNavigatorSubjects();

    // Clear history after sync (external changes invalidate undo commands)
    this.historyManager?.clear();

    console.log(`[NoteCanvas] Live update applied. Stroke count: ${inMemoryData.strokes.length}`);
  }

  /**
   * Load and render a note
   * @param {string} noteId - ID of the note to load
   * @param {Object|string|null} options - Options object or search query string (legacy)
   * @param {string} options.searchQuery - Optional search query to highlight
   * @param {string} options.taskId - Optional task ID to scroll to
   */
  async load(noteId, options = {}) {
    const { searchQuery = null, taskId = null } =
      typeof options === "string" ? { searchQuery: options } : options || {};
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
    if (!this.noteData.deletedTasks) {
      this.noteData.deletedTasks = [];
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

    // Initialize SelectionOverlay (3-dot menu for lasso selection)
    this.selectionOverlay = new SelectionOverlay(this.scroller.getViewportElement(), {
      onCopy: () => this._copySelectedStrokes(),
      onMarkAsTask: () => this._markSelectedStrokesAsTask(),
      onRemoveTask: () => this._removeTaskFromSelectedStrokes(),
      onDelete: () => this._deleteSelectedStrokes(),
    });

    // Initialize tasks array and task checkbox layer
    this.noteData.tasks = this.noteData.tasks || [];
    this.taskCheckboxLayer = new TaskCheckboxLayer(this.scroller.getViewportElement(), {
      onToggle: (taskId, checked) => this._toggleTask(taskId, checked),
      onTaskClick: (taskId) => this._selectTaskStrokes(taskId),
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
    this.renderer.showA4PageBreaks =
      !this.noteData.pdfSource && !this.mediaManager.getItems().some((i) => i.type === "pdf-page");
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

    // Initialize Text Editor Layer (WYSIWYG text editing)
    this.textEditorLayer = new TextEditorLayer(
      this.scroller.getViewportElement(),
      scrollerContainer,
      {
        maxContentWidth: this.maxContentWidth,
        onContentChange: (html) => this._onTextContentChange(html),
        onHeightChange: (height) => this._onTextHeightChange(height),
        historyManager: this.historyManager,
        onTaskCreate: (taskId) => this._createTextTask(taskId),
        onTaskToggle: (taskId, checked) => this._toggleTask(taskId, checked),
      },
    );
    this.textEditorLayer.init(this.noteData.content || "");
    this.textEditorLayer.setContentHeight(this.contentHeight);

    // Render text task checkboxes if any exist. Deferred to allow editor to initialize.
    this._renderTasksTimeout = setTimeout(() => {
      this.textEditorLayer.renderTaskCheckboxes(this.noteData.tasks);
    }, 0);

    // Set content size in scroller
    this.scroller.setContentSize(contentWidth, this.contentHeight);

    // Initial render
    this.renderer.render(0, height);
    this._updateTaskCheckboxes();

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
          } else if (action.type === "export-pdf") {
            await this._exportPdf();
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
          if (action === "insert-space") this._setMode("insert-space");
        },
        onUndo: () => this.historyManager?.undo(),
        onRedo: () => this.historyManager?.redo(),
        onEraserSettingsChange: ({ eraserMode, eraserSize, eraserHighlighterOnly }) => {
          if (eraserMode !== undefined) {
            this.eraserMode = eraserMode;
            this.toolbar.updateEraserIcon(eraserMode);
          }
          if (eraserSize !== undefined) this.eraserSize = eraserSize;
          if (eraserHighlighterOnly !== undefined)
            this.eraserHighlighterOnly = eraserHighlighterOnly;
        },
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
    await this._initNavigator(taskId);
    this._initSoundDialog();

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

          // Convert DataURL to Blob for storage.
          // NC CSP blocks fetch() on data: URLs, so use direct base64 decode there.
          let blob;
          if (!_IS_NEXTCLOUD) {
            try {
              const res = await fetch(processed.dataUrl);
              blob = await res.blob();
            } catch (fetchErr) {
              console.warn(
                "[NoteCanvas] fetch(dataUrl) failed, using fallback conversion",
                fetchErr,
              );
            }
          }
          if (!blob) {
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
    if (!this.noteData) return;
    // Check for pdfSource OR existence of pdf-page items (fallback for data consistency)
    const hasPdfPages = this.mediaManager?.getItems().some((i) => i.type === "pdf-page");
    if (this.noteData.pdfSource || hasPdfPages) {
      await showAlertDialog(
        "PDF Already Imported",
        "Only one PDF can be imported per note. Please remove the current PDF before importing a new one.",
      );
      return;
    }

    this._pendingPdfImport = (async () => {
      const file = await this._pickPdfFile();
      if (!file) {
        this._pendingPdfImport = null;
        return;
      }
      const progress = showProgressDialog(t("canvas.pdf.importProgressTitle"));
      try {
        const { pages, fileId } = await importPdf(file, (phase, current, total) => {
          if (phase === "upload") {
            progress.update(1, 1, t("canvas.pdf.importProgressUpload"));
          } else {
            progress.update(current, total, t("canvas.pdf.importProgressPage", { current, total }));
          }
        });

        if (pages.length > 0) {
          const viewport = this.scroller.getViewportBounds();
          const startY = viewport.top + 50;
          const targetWidth = this.maxContentWidth || 1200;
          let currentY = startY;

          const insertedPages = [];
          for (const page of pages) {
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

          if (!this.noteData.pdfSource) {
            this.noteData.pdfSource = fileId;
          }

          await this._saveMediaChanges((current, total) => {
            progress.update(
              current,
              total,
              t("canvas.pdf.importProgressSaving", { current, total }),
            );
          });
          this.renderer.showA4PageBreaks = false;
          this.renderer.forceRedraw();
          this._renderPdfControls();
          this.historyManager?.push(new InsertMediaCommand(insertedPages, fileId));

          const lastPage = pages[pages.length - 1];
          const bottom = lastPage.y + lastPage.height;
          if (bottom > this.contentHeight) {
            this._expandCanvas(bottom - this.contentHeight + 500);
          }
        }
      } catch (error) {
        console.error("[NoteCanvas] Failed to insert PDF:", error);
        alert(`Failed to import PDF: ${error.message}`);
      } finally {
        progress.close();
        this._pendingPdfImport = null;
      }
    })();
    await this._pendingPdfImport;
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
            ${getIcon("trash", 16)} ${t("canvas.pdf.delete")}
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
      let settled = false;
      const done = (file) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("focus", onFocus);
        resolve(file ?? null);
      };
      // Fallback for platforms that fire neither cancel nor change on dismiss:
      // resolve null on the next window focus after the picker closes.
      const onFocus = () => setTimeout(() => done(null), 300);
      window.addEventListener("focus", onFocus);
      input.onchange = (e) => done(e.target.files?.[0]);
      input.oncancel = () => done(null);
      input.click();
    });
  }

  /**
   * Highlight search terms in the note
   * @private
   * @param {string} query
   */
  _highlightSearchTerms(query) {
    // Highlight recognized handwriting strokes on the canvas
    let recognition = this.noteData?.recognition;

    // Handle case where recognition might be a JSON string (legacy data artifact)
    if (typeof recognition === "string") {
      try {
        recognition = JSON.parse(recognition);
        this.noteData.recognition = recognition;
      } catch (_e) {
        recognition = null;
      }
    }

    if (recognition?.words && Array.isArray(recognition.words)) {
      const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = escapeRegex(query).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
      const regex = new RegExp(pattern, "gi");

      const rects = [];

      recognition.words.forEach((word) => {
        if (!word) return;

        regex.lastIndex = 0;
        if (word.text && regex.test(word.text)) {
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

    // Highlight in text editor layer
    if (this.textEditorLayer) {
      this.textEditorLayer.highlightSearchTerms(query);
    }

    // Highlight in PDF text layers
    if (this.pdfTextLayerManager) {
      this.pdfTextLayerManager.highlightSearchTerms(query);
    }
  }

  /**
   * Initialize the note navigator widget.
   * @private
   * @param {string|null} autoNavigateTaskId - Task ID to scroll to on load
   */
  async _initNavigator(autoNavigateTaskId = null) {
    const scrollerContainer = this.containerElement.querySelector(
      ".note-canvas__scroller-container",
    );
    if (!scrollerContainer) return;

    this.navigator = new NoteNavigator(scrollerContainer, {
      onNavigate: (contentY, subjectKey, item) => {
        if (!this.scroller) return;
        const scrollToTop = subjectKey === "pdf-page" || subjectKey === "pdf-chapter";
        const viewportHeight = this.scroller.getViewportSize().height / this.scroller.zoomScale;
        const targetScrollY = scrollToTop
          ? Math.max(0, contentY)
          : Math.max(0, contentY - viewportHeight / 2);

        // Ensure canvas is large enough to scroll to this position
        if (targetScrollY + viewportHeight > this.contentHeight) {
          this._expandCanvas(targetScrollY + viewportHeight - this.contentHeight + 500);
          // Force reflow
          this.scroller.container.offsetHeight;
        }

        this.scroller.scrollTo(0, targetScrollY, false);

        if (item?.bounds) {
          this._highlightTaskRegion(item.bounds);
        }
      },
    });

    // Load PDF outline if a PDF is present
    const pdfPages = this.mediaManager?.getItems().filter((i) => i.type === "pdf-page");
    if (pdfPages && pdfPages.length > 0) {
      const fileId = this.noteData.pdfSource || pdfPages[0].fileId;
      if (fileId) {
        try {
          const outline = await getPdfOutline(fileId);
          if (outline.length > 0) {
            // Map outline entries to precise content Y positions
            const mappedEntries = await Promise.all(
              outline.map(async (entry) => {
                const pageItem = pdfPages.find((p) => p.pageIndex === entry.pageIndex);
                if (!pageItem) return null;

                // If destY is available, compute precise position within the page
                if (entry.destY != null) {
                  try {
                    const page = await loadPdfPage(pageItem.fileId, pageItem.pageIndex);
                    const viewport = page.getViewport({ scale: 1.0 });
                    const displayScale = pageItem.width / viewport.width;
                    // destY is in PDF coords (from bottom), convert to top-down
                    const pdfY = viewport.height - entry.destY;
                    const contentY = pageItem.y + pdfY * displayScale;
                    return { y: contentY, label: entry.title };
                  } catch (_e) {
                    return { y: pageItem.y, label: entry.title };
                  }
                }
                return { y: pageItem.y, label: entry.title };
              }),
            );
            this._pdfOutline = mappedEntries.filter(Boolean);
          }
        } catch (_e) {
          // Outline not available
        }
      }
    }

    await this._updateNavigatorSubjects();

    // Handle auto-navigation to task
    if (autoNavigateTaskId) {
      let taskSubject = this.navigator.subjects.find((s) => s.key === "task");
      let itemIndex = taskSubject
        ? taskSubject.items.findIndex((i) => i.id === autoNavigateTaskId)
        : -1;

      // Retry loop: wait for text editor to render if task not found yet
      let retries = 0;
      while (itemIndex === -1 && retries < 20) {
        await new Promise((r) => setTimeout(r, 100));
        await this._updateNavigatorSubjects();
        taskSubject = this.navigator.subjects.find((s) => s.key === "task");
        itemIndex = taskSubject
          ? taskSubject.items.findIndex((i) => i.id === autoNavigateTaskId)
          : -1;
        retries++;
      }

      if (taskSubject && itemIndex !== -1) {
        // Select subject and navigate
        this.navigator.currentSubjectIndex = this.navigator.subjects.indexOf(taskSubject);
        this.navigator.currentItemIndex = itemIndex;
        this.navigator._render();
        this.navigator._navigateTo(itemIndex);
      } else {
        console.warn(`[NoteCanvas] Failed to find task ${autoNavigateTaskId} after retries`);
      }
    } else if (this.activeSearchQuery) {
      // Handle auto-navigation to first search result
      const searchSubject = this.navigator.subjects.find((s) => s.key === "search");
      if (searchSubject && searchSubject.items.length > 0) {
        this.navigator.currentSubjectIndex = this.navigator.subjects.indexOf(searchSubject);
        this.navigator.currentItemIndex = 0;
        this.navigator._render();
        this.navigator._navigateTo(0);
      }
    }
  }

  /**
   * Build and set navigator subjects based on current note state.
   * @private
   */
  async _updateNavigatorSubjects() {
    if (!this.navigator) return;

    const subjects = [];

    // 1. Search term matches
    if (this.activeSearchQuery) {
      const searchItems = await this._getSearchMatchPositions(this.activeSearchQuery);
      if (searchItems.length > 0) {
        subjects.push({ key: "search", label: "Search", items: searchItems });
      }
    }

    // 2. PDF pages
    const pdfPages = this.mediaManager?.getItems().filter((i) => i.type === "pdf-page");
    if (pdfPages && pdfPages.length > 0) {
      const sorted = [...pdfPages].sort((a, b) => a.y - b.y);
      subjects.push({
        key: "pdf-page",
        label: "Pages",
        items: sorted.map((p) => ({ y: p.y, label: `Page ${p.pageIndex}` })),
      });
    }

    // 3. PDF chapters
    if (this._pdfOutline && this._pdfOutline.length > 0) {
      subjects.push({
        key: "pdf-chapter",
        label: "Chapters",
        items: this._pdfOutline,
      });
    }

    // 4. Highlighter strokes (grouped within 50px)
    const markerStrokes = this.noteData.strokes.filter((s) => s.type === "marker" && !s._deleted);
    if (markerStrokes.length > 0) {
      const rawItems = markerStrokes
        .map((s) => ({ y: Math.min(...s.y) }))
        .sort((a, b) => a.y - b.y);

      // Group items within 50px vertically
      const grouped = [];
      let group = [rawItems[0]];
      for (let i = 1; i < rawItems.length; i++) {
        if (rawItems[i].y - group[group.length - 1].y <= 50) {
          group.push(rawItems[i]);
        } else {
          const avgY = group.reduce((sum, it) => sum + it.y, 0) / group.length;
          grouped.push({ y: avgY });
          group = [rawItems[i]];
        }
      }
      const avgY = group.reduce((sum, it) => sum + it.y, 0) / group.length;
      grouped.push({ y: avgY });

      subjects.push({ key: "highlighter", label: "Highlights", items: grouped });
    }

    // 5. Tasks
    const tasks = (this.noteData.tasks || []).filter((t) => {
      if (t.type === "stroke") {
        return t.strokeIds.some((id) => {
          const stroke = this.noteData.strokes.find((s) => s.id === id);
          return stroke && !stroke._deleted && !stroke.isDeleted;
        });
      }
      return true;
    });
    if (tasks.length > 0) {
      const taskItems = tasks
        .map((t) => {
          // Stroke Task
          if (t.type === "stroke") {
            let minY = Infinity;
            let maxY = -Infinity;
            let minX = Infinity;
            let maxX = -Infinity;
            let hasStrokes = false;

            t.strokeIds.forEach((id) => {
              const stroke = this.noteData.strokes.find((s) => s.id === id);
              if (stroke && !stroke._deleted && !stroke.isDeleted) {
                hasStrokes = true;
                for (let i = 0; i < stroke.y.length; i++) {
                  minY = Math.min(minY, stroke.y[i]);
                  maxY = Math.max(maxY, stroke.y[i]);
                  minX = Math.min(minX, stroke.x[i]);
                  maxX = Math.max(maxX, stroke.x[i]);
                }
              }
            });
            if (!hasStrokes) return null;
            return {
              y: (minY + maxY) / 2,
              label: t.checked ? "done" : "open",
              id: t.id,
              bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
            };
          }
          // Text tasks: approximate position from DOM if available
          const el = this.textEditorLayer?._editorElement?.querySelector(
            `[data-task-id="${t.id}"]`,
          );
          if (!el) {
            return null;
          }
          const scrollTop = this.scroller.getScrollTop();
          const scrollLeft = this.scroller.getScrollLeft();
          const rect = el.getBoundingClientRect();

          // Skip if not rendered yet
          if (rect.width === 0 && rect.height === 0) {
            return null;
          }

          const containerRect = this.scroller.getViewportElement().getBoundingClientRect();
          const y = (rect.top - containerRect.top + scrollTop) / this.zoomScale;

          // Calculate bounds for highlight
          const viewportWidth = this.scroller.getViewportSize().width;
          const scaledContentWidth = this.maxContentWidth * this.zoomScale;
          const offsetX =
            scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;
          const x = (rect.left - containerRect.left + scrollLeft - offsetX) / this.zoomScale;
          const w = rect.width / this.zoomScale;
          const h = rect.height / this.zoomScale;

          return { y, label: t.checked ? "done" : "open", id: t.id, bounds: { x, y, w, h } };
        })
        .filter(Boolean)
        .sort((a, b) => a.y - b.y);

      if (taskItems.length > 0) {
        subjects.push({ key: "task", label: "Tasks", items: taskItems });
      }
    }

    // Auto-select: search if active, else pdf-page, else highlighter, else task
    let autoSelect;
    if (this.activeSearchQuery && subjects.some((s) => s.key === "search")) {
      autoSelect = "search";
    } else if (subjects.some((s) => s.key === "pdf-page")) {
      autoSelect = "pdf-page";
    } else if (subjects.some((s) => s.key === "highlighter")) {
      autoSelect = "highlighter";
    } else if (subjects.some((s) => s.key === "task")) {
      autoSelect = "task";
    }

    this.navigator.setSubjects(subjects, autoSelect);

    // Auto-expand if search query is active
    if (this.activeSearchQuery && subjects.length > 0 && !this.navigator.expanded) {
      this.navigator.expanded = true;
      this.navigator._render();
    }
  }

  /**
   * Initialize sound recording dialog.
   * @private
   */
  _initSoundDialog() {
    const scrollerContainer = this.containerElement.querySelector(
      ".note-canvas__scroller-container",
    );
    if (!scrollerContainer) return;

    this.recordingManager = new RecordingManager({
      onChange: () => {},
      onSave: ({ recordings, deletedRecordings }) => {
        this._saveRecordingChanges(recordings, deletedRecordings);
      },
    });

    this.recordingManager.setRecordings(this.noteData.recordings ?? []);

    this.soundDialog = new SoundDialog(scrollerContainer, this.recordingManager);
  }

  /**
   * Persist recording changes via the StorageWorker.
   * @private
   */
  _saveRecordingChanges(recordings, deletedRecordings) {
    if (!this.noteId) return;
    this.noteData.recordings = recordings;
    this.noteData.deletedRecordings = deletedRecordings;
    this.mediaChanged = true;

    if (_IS_NEXTCLOUD) {
      const notebookId = this.noteData.notebookId ?? null;
      // Upload any new recording blobs then save metadata
      const uploads = recordings
        .filter((r) => r.fileId)
        .map((r) => {
          const uploadPromise = getFile(r.fileId)
            .then((blob) => {
              if (blob) return saveMediaForNote(blob, r.fileId, this.noteId, notebookId);
            })
            .catch((e) =>
              console.error("[NoteCanvas] WebDAV recording upload failed:", r.fileId, e),
            );
          // Register so SoundDialog can await upload completion before setting audio src
          registerPendingUpload(r.fileId, uploadPromise);
          return uploadPromise;
        });
      Promise.all(uploads).then(() =>
        updateNote(this.noteId, { recordings, deletedRecordings }).catch((e) =>
          console.error("[NoteCanvas] WebDAV recordings save failed:", e),
        ),
      );
      return;
    }

    if (!this.strokeManager) return;
    this.strokeManager.saveRecordings({ recordings, deletedRecordings });
  }

  /**
   * Flash a highlight on a specific task region
   * @private
   */
  _highlightTaskRegion(bounds) {
    if (this.renderer) {
      this.renderer.setHighlights([bounds]);
      // Clear highlight after animation
      setTimeout(() => {
        this.renderer.setHighlights([]);
      }, 1500);
    }
  }

  /**
   * Collect Y positions of all search term matches across content types.
   * @private
   * @param {string} query
   * @returns {Promise<Array<{y: number}>>}
   */
  async _getSearchMatchPositions(query) {
    const positions = [];

    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escapeRegex(query).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    const regex = new RegExp(pattern, "gi");

    // 1. Handwriting recognition matches
    let recognition = this.noteData?.recognition;
    if (typeof recognition === "string") {
      try {
        recognition = JSON.parse(recognition);
      } catch (_e) {
        recognition = null;
      }
    }
    if (recognition?.words && Array.isArray(recognition.words)) {
      for (const word of recognition.words) {
        if (!word?.text) continue;
        regex.lastIndex = 0;
        if (regex.test(word.text)) {
          const box = word.boundingRect || word.boundingBox || word.rect || word;
          const y = box.y !== undefined ? box.y : box.top;
          if (y !== undefined) {
            positions.push({ y });
          }
        }
      }
    }

    // 2. PDF text matches — find precise Y position of each match within pages
    const pdfPages = this.mediaManager?.getItems().filter((i) => i.type === "pdf-page");
    if (pdfPages && pdfPages.length > 0) {
      const pageChecks = pdfPages.map(async (pageItem) => {
        try {
          const page = await loadPdfPage(pageItem.fileId, pageItem.pageIndex);
          const cached = this.pdfTextLayerManager?.textContentCache?.get(pageItem.id);
          const content = cached || (await page.getTextContent({ normalizeWhitespace: true }));
          const viewport = page.getViewport({ scale: 1.0 });
          const displayScale = pageItem.width / viewport.width;

          const matches = [];
          for (const textItem of content.items) {
            if (!textItem.str) continue;
            const r = new RegExp(pattern, "gi");
            if (r.test(textItem.str)) {
              // transform[5] is Y in PDF coords (bottom-up), convert to top-down
              const pdfY = viewport.height - textItem.transform[5];
              const contentY = pageItem.y + pdfY * displayScale;
              matches.push({ y: contentY });
            }
          }
          return matches;
        } catch (_e) {
          return [];
        }
      });
      const results = await Promise.all(pageChecks);
      for (const pageMatches of results) {
        for (const m of pageMatches) {
          positions.push(m);
        }
      }
    }

    // 3. Text editor matches — check raw note content with regex
    if (this.noteData?.content) {
      // Strip HTML tags for matching
      const textContent = this.noteData.content.replace(/<[^>]+>/g, "");
      regex.lastIndex = 0;
      if (regex.test(textContent)) {
        // Content matches — add position at top (text editor starts at y=0)
        positions.push({ y: 0 });
      }
    }

    // Sort by Y and deduplicate nearby positions (within 20px)
    positions.sort((a, b) => a.y - b.y);
    const deduped = [];
    for (const pos of positions) {
      if (deduped.length === 0 || pos.y - deduped[deduped.length - 1].y > 20) {
        deduped.push(pos);
      }
    }

    return deduped;
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

    // Right-click paste menu (stopPropagation prevents the global window prevention in main.js)
    viewport.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (AppClipboard.canPasteInMode(this.mode)) {
        this._showPasteMenu(e.clientX, e.clientY);
      }
    });

    window.addEventListener("keydown", this._onKeyDown);
  }

  /**
   * Handle external data changes (e.g., from sync)
   * @private
   */
  async _onDataChange(e) {
    const { noteId, source } = e.detail || {};

    // Is this change for the currently open note?
    if (!noteId || noteId !== this.noteId) {
      return;
    }

    // Local saves (own writes) must not trigger applyLiveUpdate — that would
    // reload from storage and clear the undo history after every keystroke/stroke.
    if (source === "local") {
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
        this._updateSelectionOverlay();
        this._updateTaskCheckboxes();
        this._updatePdfTextLayers();
        this._updateTextEditorLayer();
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
   * Update text editor layer position based on current scroll and zoom
   * @private
   */
  _updateTextEditorLayer() {
    if (!this.textEditorLayer) return;

    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const { width: viewportWidth } = this.scroller.getViewportSize();

    const scaledContentWidth = this.maxContentWidth * this.zoomScale;
    const centeringOffset =
      scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;

    this.textEditorLayer.update(this.zoomScale, scrollLeft, scrollTop, centeringOffset);
  }

  /**
   * Handle text content change from the editor
   * @private
   * @param {string} html - HTML content
   */
  _onTextContentChange(html) {
    this.noteData.content = html;
    this.textChanged = true;

    if (import.meta.env.VITE_PLATFORM === "nextcloud") {
      // In NC build the worker is disabled — save content directly to WebDAV.
      // Text is debounced by TextEditorLayer before calling here, so no extra debounce needed.
      this._pendingTextSave = updateNote(this.noteId, { content: html }).catch((e) =>
        console.error("[NoteCanvas] WebDAV text save failed:", e),
      );
    } else if (this.strokeManager?.worker) {
      // Save via worker (reuse StrokeManager's worker for sequential message processing)
      let key = null;
      if (isAppUnlocked()) {
        try {
          key = getEncryptionKey();
        } catch (_e) {
          // Key not available
        }
      }

      this.strokeManager.worker.postMessage({
        type: "SAVE_CONTENT",
        noteId: this.noteId,
        content: html,
        key,
      });
    }

    // Clean up orphaned text tasks (spans removed by editing)
    if (this.textEditorLayer?.cleanupOrphanedTextTasks(this.noteData.tasks)) {
      this._saveTasks();
      this._updateNavigatorSubjects();
    }
  }

  /**
   * Handle text content height change (for expanding scrollable area)
   * @private
   * @param {number} textHeight - New text content height in content pixels
   */
  _onTextHeightChange(textHeight) {
    const neededHeight = textHeight + 200;
    if (neededHeight > this.contentHeight) {
      this._expandCanvas(neededHeight - this.contentHeight);
    }
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
    this._updateTextEditorLayer();
    this._updatePdfControlsPosition();
    this._updateTaskCheckboxes();
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
    if (this.textEditorLayer) {
      this.textEditorLayer.setContentHeight(this.contentHeight);
    }

    // Force reflow to ensure the browser acknowledges the new scroll height
    this.scroller.container.offsetHeight;
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
    this.insertSpaceState = null;
    this._clearLongPress();

    if (this.toolbar) {
      this.toolbar.updateMode(newMode);
    }

    // Clear selection when switching modes (except to pan or lasso)
    if (this.renderer && newMode !== "pan" && newMode !== "lasso") {
      this.renderer.setSelectedStrokes(new Set(), null);
      this.selectedTaskId = null;
      this.taskSelectionBounds = null;
      this.selectionOverlay?.hide();
    }

    if (this.renderer) {
      this.renderer.clearOverlay();
    }

    // Update PDF text layer interactivity (only enabled in pan mode)
    if (this.pdfTextLayerManager) {
      this.pdfTextLayerManager.setMode(newMode);
    }

    // Update text editor layer interactivity (only enabled in text mode)
    if (this.textEditorLayer) {
      this.textEditorLayer.setMode(newMode);
    }

    // Add mode class to container for CSS-based behavior
    this.containerElement.classList.remove(
      "note-canvas--pan-mode",
      "note-canvas--draw-mode",
      "note-canvas--eraser-mode",
      "note-canvas--lasso-mode",
      "note-canvas--insert-space-mode",
      "note-canvas--text-mode",
    );
    this.containerElement.classList.add(`note-canvas--${newMode}-mode`);
  }

  /**
   * Handle stroke start
   * @private
   */
  _onStrokeStart(props) {
    if (this.mode === "text") return false;

    // Check for task interaction (bounding box)
    if (props.target) {
      const taskBox = props.target.closest(".note-canvas__task-bounding-box");
      if (taskBox) {
        const taskId = taskBox.dataset.taskId;
        const isSelected = this.selectedTaskId === taskId;
        // If not selected, or if selected but NOT in lasso mode (so no transform possible),
        // return false to allow click event (selection/menu toggle).
        if (!isSelected || this.mode !== "lasso") {
          return false;
        }
      }
    }

    if (this.mode === "insert-space") {
      this.insertSpaceState = { startY: props.y, currentY: props.y };
      this.renderer.drawInsertSpaceIndicator(this.insertSpaceState);
      return true;
    }

    // Detect stylus usage
    if (props.pointerType === "pen") {
      this.stylusDetected = true;
      // Auto-switch to draw mode if currently in pan or text mode
      if (this.mode === "pan" || this.mode === "text") {
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
          this.selectedTaskId = null;
          this.taskSelectionBounds = null;
          this.selectionOverlay?.hide();
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
    if (this.insertSpaceState) {
      const lastPoint = points[points.length - 1];
      // Allow dragging up and down
      this.insertSpaceState.currentY = lastPoint.y;
      this.renderer.drawInsertSpaceIndicator(this.insertSpaceState);
      return;
    }

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
      this._updateSelectionOverlay();
      this._updateTaskCheckboxes();
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
    if (this.insertSpaceState) {
      const { startY, currentY } = this.insertSpaceState;
      const yShift = currentY - startY;

      if (yShift !== 0) {
        const affectedStrokeIds = [];
        const affectedMediaIds = [];

        // Find strokes to shift
        this.noteData.strokes.forEach((stroke, index) => {
          if (stroke._deleted || !stroke.id) return;
          const bounds = this.spatialIndex.strokeBounds.get(index);
          if (bounds && bounds.minY > startY) {
            affectedStrokeIds.push(stroke.id);
          }
        });

        // Find media to shift (excluding PDF pages)
        this.noteData.media.forEach((media) => {
          if (media.type !== "pdf-page" && media.y > startY) {
            affectedMediaIds.push(media.id);
          }
        });

        if (affectedStrokeIds.length > 0 || affectedMediaIds.length > 0) {
          // Create and push command BEFORE changing data
          const command = new ShiftContentCommand(yShift, affectedStrokeIds, affectedMediaIds);
          this.historyManager?.push(command);

          // Apply the shift
          command.redo(this);
        }
      }

      this.insertSpaceState = null;
      this.renderer.clearOverlay();
      this._setMode("pan"); // Revert to pan mode after action
      return;
    }

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
        if (this.eraserMode === "stroke") {
          this._commitEraserBatch();
        } else {
          this._commitPartEraserBatch();
        }
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

    // Paste: Ctrl+V — only on canvas modes (text mode lets the browser/editor handle it)
    if ((e.ctrlKey || e.metaKey) && e.key === "v" && this.mode !== "text") {
      if (AppClipboard.canPasteInMode(this.mode)) {
        e.preventDefault();
        const center = this._getViewportCenter();
        this._pasteAtContentPoint(center.x, center.y);
      }
      return;
    }

    // Delete/Backspace: delete selected media (not in text mode — let editor handle it)
    if (this.mode !== "text" && (e.key === "Delete" || e.key === "Backspace")) {
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
    this._clearCanvasLongPress();
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
    this._checkCanvasLongPressMove(clientX, clientY);
  }

  /**
   * Start a canvas-level long press for the paste menu (separate from media long-press).
   * @private
   */
  _startCanvasLongPress(clientX, clientY) {
    this._clearCanvasLongPress();
    this._canvasLongPressStart = { x: clientX, y: clientY };
    this._canvasLongPressTimer = setTimeout(() => {
      this._canvasLongPressTimer = null;
      this._canvasLongPressStart = null;
      this._showPasteMenu(clientX, clientY);
    }, 500);
  }

  /** @private */
  _clearCanvasLongPress() {
    if (this._canvasLongPressTimer) {
      clearTimeout(this._canvasLongPressTimer);
      this._canvasLongPressTimer = null;
    }
    this._canvasLongPressStart = null;
  }

  /** @private */
  _checkCanvasLongPressMove(clientX, clientY) {
    if (!this._canvasLongPressStart) return;
    const dist = Math.sqrt(
      (clientX - this._canvasLongPressStart.x) ** 2 + (clientY - this._canvasLongPressStart.y) ** 2,
    );
    // 3px threshold — cancel on any real movement so slow pans don't trigger the paste menu
    if (dist > 3) {
      this._clearCanvasLongPress();
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
      const dx = x - state.startX;
      const dy = y - state.startY;

      const isLeft = state.handle.includes("w");
      const isTop = state.handle.includes("n");
      const isRight = state.handle.includes("e");
      const isBottom = state.handle.includes("s");

      // Rotate the delta vector by -rotation to align with item axes
      const rad = (-state.initialRotation * Math.PI) / 180;
      const rdx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const rdy = dx * Math.sin(rad) + dy * Math.cos(rad);

      let newWidth = state.initialWidth;
      let newHeight = state.initialHeight;

      if (state.handle.length === 2) {
        // Corner handle: aspect-ratio locked, opposite corner stays pinned
        const ratio = state.initialWidth / state.initialHeight;

        // Compute width change based on the dragged corner direction
        let wChange = 0;
        if (isRight) wChange = rdx;
        else if (isLeft) wChange = -rdx;

        let hChange = 0;
        if (isBottom) hChange = rdy;
        else if (isTop) hChange = -rdy;

        // Use whichever axis moved more to drive aspect-ratio resize
        const change = Math.abs(wChange) > Math.abs(hChange) ? wChange : hChange * ratio;
        newWidth = Math.max(50, state.initialWidth + change);
        newHeight = newWidth / ratio;
      } else {
        // Side handle: adjust one dimension
        if (isRight) newWidth += rdx;
        else if (isLeft) newWidth -= rdx;
        else if (isBottom) newHeight += rdy;
        else if (isTop) newHeight -= rdy;

        newWidth = Math.max(50, newWidth);
        newHeight = Math.max(50, newHeight);
      }

      item.width = newWidth;
      item.height = newHeight;

      const isRotated = Math.abs(item.rotation || 0) % 360 > 0.1;
      if (isRotated) {
        // For rotated items, center-based scaling avoids complex pivot math
        item.x = state.initialX - (newWidth - state.initialWidth) / 2;
        item.y = state.initialY - (newHeight - state.initialHeight) / 2;
      } else {
        // Pin the opposite corner/edge: only move origin when dragging left or top edges
        item.x = isLeft ? state.initialX + (state.initialWidth - item.width) : state.initialX;
        item.y = isTop ? state.initialY + (state.initialHeight - item.height) : state.initialY;
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
   * Update selection overlay position
   * @private
   */
  _updateSelectionOverlay() {
    const bounds = this.renderer?.selectionBounds;

    if (!this.selectionOverlay?.isVisible && !bounds) return;
    if (!bounds) {
      this.selectionOverlay?.hide();
      return;
    }

    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const viewport = this.scroller.getViewportElement().getBoundingClientRect();

    const viewportWidth = this.scroller.getViewportSize().width;
    const scaledContentWidth = this.maxContentWidth * this.zoomScale;
    const offsetX =
      scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;

    if (this.selectionOverlay.isVisible) {
      this.selectionOverlay.updatePosition(
        bounds,
        this.zoomScale,
        scrollLeft,
        scrollTop,
        viewport,
        offsetX,
      );
    } else {
      this.selectionOverlay.show(bounds, this.zoomScale, scrollLeft, scrollTop, viewport, offsetX);
    }
  }

  /**
   * Update task checkbox positions (placeholder for Phase 3)
   * @private
   */
  _updateTaskCheckboxes() {
    if (!this.taskCheckboxLayer) return;
    const strokeTasks = (this.noteData?.tasks || []).filter((t) => t.type === "stroke");
    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const viewportWidth = this.scroller.getViewportSize().width;
    const scaledContentWidth = this.maxContentWidth * this.zoomScale;
    const offsetX =
      scaledContentWidth < viewportWidth ? (viewportWidth - scaledContentWidth) / 2 : 0;

    this.taskCheckboxLayer.update(
      strokeTasks,
      this.noteData.strokes,
      this.zoomScale,
      scrollLeft,
      scrollTop,
      offsetX,
    );
  }

  /**
   * Mark the currently selected strokes as a task
   * @private
   */
  _markSelectedStrokesAsTask() {
    const selectedIndices = this.renderer.selectedStrokeIndices;
    if (selectedIndices.size === 0) return;

    // Rotated selections have unreliable line detection — treat as a single block.
    // Otherwise detect text lines and group by indentation.
    let taskStrokeGroups; // Array<number[]> of stroke indices per task
    if (this.selectionRotated) {
      taskStrokeGroups = [[...selectedIndices]];
    } else {
      const { lineGroups } = detectStrokeLines(this.noteData.strokes, selectedIndices);
      const indentLevels = detectLineIndentation(this.noteData.strokes, lineGroups);

      taskStrokeGroups = [];
      for (let i = 0; i < lineGroups.length; i++) {
        if (indentLevels[i] === 0 || taskStrokeGroups.length === 0) {
          taskStrokeGroups.push([...lineGroups[i]]);
        } else {
          for (const idx of lineGroups[i]) taskStrokeGroups[taskStrokeGroups.length - 1].push(idx);
        }
      }
    }

    const now = Date.now();
    const tasks = taskStrokeGroups.map((indices) => ({
      id: generateId(),
      type: "stroke",
      strokeIds: indices.map((i) => this.noteData.strokes[i].id),
      checked: false,
      created: now,
      modified: now,
    }));

    // Remove any existing stroke tasks that share strokes with the new ones (dedup guard)
    const newStrokeIdSets = tasks.map((t) => new Set(t.strokeIds));
    const displaced = this.noteData.tasks.filter(
      (existing) =>
        existing.type === "stroke" &&
        newStrokeIdSets.some((s) => existing.strokeIds.some((id) => s.has(id))),
    );
    for (const t of displaced) {
      if (!this.noteData.deletedTasks.includes(t.id)) this.noteData.deletedTasks.push(t.id);
    }
    this.noteData.tasks = this.noteData.tasks.filter((t) => !displaced.includes(t));

    for (const task of tasks) this.noteData.tasks.push(task);
    this._saveTasks();

    // Single undoable command for all created tasks
    this.historyManager?.push(new MarkTaskCommand(tasks));

    // Clear selection and overlay
    this.renderer.setSelectedStrokes(new Set(), null);
    this.selectedTaskId = null;
    this.taskSelectionBounds = null;
    this.selectionOverlay?.hide();

    // Update UI
    this._updateTaskCheckboxes();
    this._updateNavigatorSubjects();
  }

  /**
   * Delete the currently selected strokes
   * @private
   */
  _deleteSelectedStrokes() {
    const selectedIndices = Array.from(this.renderer.selectedStrokeIndices);
    if (selectedIndices.length === 0) return;

    const cmd = EraseStrokesCommand.fromIndices(this, selectedIndices);
    cmd.redo(this);
    this.historyManager?.push(cmd);

    this.renderer.setSelectedStrokes(new Set(), null);
    this.selectedTaskId = null;
    this.taskSelectionBounds = null;
    this.selectionOverlay?.hide();

    // Clean up orphaned tasks
    this._cleanupOrphanedTasks();
  }

  /**
   * Copy currently selected strokes to the in-app clipboard and system clipboard (as PNG).
   * @private
   */
  _copySelectedStrokes() {
    const selectedIndices = Array.from(this.renderer.selectedStrokeIndices);
    if (selectedIndices.length === 0) return;

    const bounds = this.renderer.selectionBounds;
    const strokes = selectedIndices.map((i) => this.noteData.strokes[i]);

    // Deep-clone strokes so later edits don't affect clipboard contents
    const cloned = strokes.map((s) => ({
      ...s,
      x: [...s.x],
      y: [...s.y],
      pressure: s.pressure ? [...s.pressure] : [],
      time: s.time ? [...s.time] : [],
    }));

    AppClipboard.copy("strokes", cloned, { ...bounds });

    // Also write PNG to system clipboard for cross-app paste
    this._renderSelectionToPng(strokes, bounds).catch(() => {
      // System clipboard write failed — in-app clipboard still works
    });
  }

  /**
   * Render a set of strokes to an offscreen canvas and write the PNG to the system clipboard.
   * @param {Object[]} strokes
   * @param {{minX:number,minY:number,maxX:number,maxY:number}} bounds - Content coordinates
   * @returns {Promise<void>}
   * @private
   */
  async _renderSelectionToPng(strokes, bounds) {
    const MAX_SIZE = 2000;
    const PADDING = 20; // content-coord padding around strokes

    const rawW = bounds.maxX - bounds.minX + PADDING * 2;
    const rawH = bounds.maxY - bounds.minY + PADDING * 2;
    const scale = Math.min(1, MAX_SIZE / Math.max(rawW, rawH));
    const canvasW = Math.round(rawW * scale);
    const canvasH = Math.round(rawH * scale);

    const offscreen = document.createElement("canvas");
    offscreen.width = canvasW;
    offscreen.height = canvasH;
    const ctx = offscreen.getContext("2d");

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Translate so bounds.minX/minY maps to PADDING
    ctx.scale(scale, scale);
    ctx.translate(-bounds.minX + PADDING, -bounds.minY + PADDING);

    const palette = sharedGetThemePalette();
    const markers = strokes.filter((s) => s.type === "marker");
    const pens = strokes.filter((s) => s.type !== "marker");
    for (const s of [...markers, ...pens]) {
      sharedDrawStroke(ctx, s, palette, false, false);
    }

    const blob = await new Promise((resolve) => offscreen.toBlob(resolve, "image/png"));
    if (!blob) return;

    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  /**
   * Returns the center of the current viewport in content coordinates.
   * @returns {{x: number, y: number}}
   * @private
   */
  _getViewportCenter() {
    const scrollLeft = this.scroller.getScrollLeft();
    const scrollTop = this.scroller.getScrollTop();
    const { width, height } = this.scroller.getViewportSize();
    const x = (scrollLeft + width / 2) / this.zoomScale;
    const y = (scrollTop + height / 2) / this.zoomScale;
    return { x, y };
  }

  /**
   * Show the paste floating menu at a screen position, if the clipboard has
   * content that can be pasted in the current mode.
   * @param {number} clientX
   * @param {number} clientY
   * @private
   */
  _showPasteMenu(clientX, clientY) {
    if (!AppClipboard.canPasteInMode(this.mode)) return;

    const { x: contentX, y: contentY } = this.inputHandler.getContentCoordinates(clientX, clientY);

    const viewport = this.scroller.getViewportElement();
    new ContextFloatingMenu(
      viewport,
      [
        {
          label: "Paste",
          icon: getIcon("clipboard", 16),
          action: () => this._pasteAtContentPoint(contentX, contentY),
        },
      ],
      { x: clientX, y: clientY },
    );
  }

  /**
   * Paste clipboard content at the given content-coordinate position.
   * Strokes are centered on the point and auto-selected.
   * @param {number} contentX
   * @param {number} contentY
   * @private
   */
  _pasteAtContentPoint(contentX, contentY) {
    const item = AppClipboard.paste();
    if (!item) return;

    if (item.type === "strokes") {
      const { data: clonedStrokes, bounds } = item;
      if (!clonedStrokes?.length) return;

      // Compute offset to center pasted strokes on the target point
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      const dx = contentX - centerX;
      const dy = contentY - centerY;

      const newIndices = [];
      const newBounds = {
        minX: bounds.minX + dx,
        minY: bounds.minY + dy,
        maxX: bounds.maxX + dx,
        maxY: bounds.maxY + dy,
      };

      for (const src of clonedStrokes) {
        const stroke = {
          ...src,
          id: generateId(),
          x: src.x.map((v) => v + dx),
          y: src.y.map((v) => v + dy),
          pressure: src.pressure ? [...src.pressure] : [],
          time: src.time ? [...src.time] : [],
          _deleted: false,
        };

        const newIndex = this.noteData.strokes.length;
        this.noteData.strokes.push(stroke);
        this.spatialIndex.insert(stroke, newIndex);
        newIndices.push(newIndex);
      }

      this.strokesChanged = true;
      this.strokeManager.markDirty();
      this.strokeManager.forceSave();

      // Switch to lasso mode so pasted strokes can be immediately moved/transformed
      if (this.mode !== "lasso") {
        this._setMode("lasso");
      }

      // Auto-select pasted strokes so the user can immediately move them
      this.renderer.setSelectedStrokes(new Set(newIndices), newBounds);
      this._updateSelectionOverlay();

      this.historyManager?.push(
        new PasteStrokesCommand(
          newIndices.map((i) => this.noteData.strokes[i]),
          newIndices,
        ),
      );

      this.renderer.forceRedraw();
    }
  }

  /**
   * Select strokes associated with a task
   * @private
   */
  _selectTaskStrokes(taskId) {
    const task = this.noteData.tasks.find((t) => t.id === taskId);
    if (!task || task.type !== "stroke") return;

    const selectedIndices = new Set();
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let hasStrokes = false;

    task.strokeIds.forEach((id) => {
      const index = this.noteData.strokes.findIndex((s) => s.id === id);
      if (index !== -1) {
        const stroke = this.noteData.strokes[index];
        if (!stroke._deleted && !stroke.isDeleted) {
          selectedIndices.add(index);

          // Calculate bounds
          for (let i = 0; i < stroke.x.length; i++) {
            minX = Math.min(minX, stroke.x[i]);
            maxX = Math.max(maxX, stroke.x[i]);
            minY = Math.min(minY, stroke.y[i]);
            maxY = Math.max(maxY, stroke.y[i]);
          }
          hasStrokes = true;
        }
      }
    });

    if (!hasStrokes) return;

    const bounds = {
      minX: minX - SELECTION_BOUNDS_PADDING,
      minY: minY - SELECTION_BOUNDS_PADDING,
      maxX: maxX + SELECTION_BOUNDS_PADDING,
      maxY: maxY + SELECTION_BOUNDS_PADDING,
    };

    this.selectedTaskId = taskId;

    this.renderer.setSelectedStrokes(selectedIndices, bounds);
    this.taskSelectionBounds = null;
    this.selectionOverlay.setTaskMode(true);
    this._updateSelectionOverlay();
  }

  _removeTaskFromSelectedStrokes() {
    if (!this.selectedTaskId) return;
    // Record deletion so sync can't restore it
    if (!this.noteData.deletedTasks.includes(this.selectedTaskId)) {
      this.noteData.deletedTasks.push(this.selectedTaskId);
    }
    // Remove task (just delete it, strokes remain)
    this.noteData.tasks = this.noteData.tasks.filter((t) => t.id !== this.selectedTaskId);
    this._saveTasks();

    // Clear selection
    this.renderer.setSelectedStrokes(new Set(), null);
    this.selectedTaskId = null;
    this.taskSelectionBounds = null;
    this.selectionOverlay.hide();

    this._updateTaskCheckboxes();
    this._updateNavigatorSubjects();
  }

  /**
   * Toggle task checked status
   * @param {string} taskId
   * @param {boolean} checked
   * @private
   */
  _toggleTask(taskId, checked) {
    const task = this.noteData.tasks.find((t) => t.id === taskId);
    if (!task) return;

    task.checked = checked;
    task.modified = Date.now();
    this._saveTasks();

    this._updateTaskCheckboxes();
    this._updateNavigatorSubjects();

    // Re-render text task checkboxes to reflect the new state
    this.textEditorLayer?.renderTaskCheckboxes(this.noteData.tasks);
  }

  /**
   * Save tasks to storage
   * @private
   */
  _saveTasks() {
    if (_IS_NEXTCLOUD) {
      updateNote(this.noteId, {
        tasks: this.noteData.tasks,
        deletedTasks: this.noteData.deletedTasks,
      }).catch((e) => console.error("[NoteCanvas] WebDAV tasks save failed:", e));
      return;
    }
    if (this.strokeManager?.worker) {
      let key = null;
      if (isAppUnlocked()) {
        try {
          key = getEncryptionKey();
        } catch (_e) {
          // Key not available
        }
      }
      this.strokeManager.worker.postMessage({
        type: "SAVE_TASKS",
        noteId: this.noteId,
        tasks: this.noteData.tasks,
        deletedTasks: this.noteData.deletedTasks,
        key,
      });
    }
  }

  /**
   * Create a text task (called from TextEditorLayer)
   * @param {string} taskId
   * @private
   */
  _createTextTask(taskId) {
    const task = {
      id: taskId,
      type: "text",
      strokeIds: [],
      checked: false,
      created: Date.now(),
      modified: Date.now(),
    };
    this.noteData.tasks.push(task);
    this._saveTasks();
    this.historyManager?.push(new MarkTaskCommand(task));
    this._updateNavigatorSubjects();

    // Re-render text task checkboxes, with a timeout to ensure the editor has updated
    setTimeout(() => {
      this.textEditorLayer?.renderTaskCheckboxes(this.noteData.tasks);
    }, 0);
  }

  /**
   * Remove tasks whose strokes are all deleted
   * @private
   */
  _cleanupOrphanedTasks() {
    if (!this.noteData?.tasks) return;

    const activeStrokeIds = new Set(
      this.noteData.strokes.filter((s) => !s._deleted && !s.isDeleted).map((s) => s.id),
    );

    const before = this.noteData.tasks.length;
    const deletedTasks = this.noteData.deletedTasks || [];
    this.noteData.tasks = this.noteData.tasks.filter((t) => {
      if (t.type !== "stroke") return true;
      const orphaned = !t.strokeIds.some((id) => activeStrokeIds.has(id));
      if (orphaned && !deletedTasks.includes(t.id)) deletedTasks.push(t.id);
      return !orphaned;
    });
    this.noteData.deletedTasks = deletedTasks;

    if (this.noteData.tasks.length !== before) {
      this._saveTasks();
      this._updateTaskCheckboxes();
      this._updateNavigatorSubjects();
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
  async _saveMediaChanges(onProgress) {
    if (!this.noteId || !this.mediaManager || !this.noteData) return;
    // Capture IDs immediately — destroy() nulls this.noteId mid-async and would corrupt paths
    const noteId = this.noteId;
    const noteData = this.noteData;
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
    noteData.media = serializableMedia;
    this.mediaManager.setItems(serializableMedia);

    if (_IS_NEXTCLOUD) {
      const notebookId = noteData.notebookId ?? null;
      // Deduplicate by fileId — pdf-page items all share the same fileId (the PDF blob).
      // pdfSource is the same file and is uploaded separately below, so skip it here too.
      const uploadedIds = new Set();
      if (noteData.pdfSource) uploadedIds.add(noteData.pdfSource);
      const uniqueMediaItems = serializableMedia.filter((i) => {
        if (!i.fileId || uploadedIds.has(i.fileId)) return false;
        uploadedIds.add(i.fileId);
        return true;
      });
      const hasPdfSource = !!noteData.pdfSource;
      const totalUploads = uniqueMediaItems.length + (hasPdfSource ? 1 : 0) + 1;
      let uploaded = 0;
      for (const item of uniqueMediaItems) {
        const blob = await getFile(item.fileId);
        if (blob) {
          await saveMediaForNote(blob, item.fileId, noteId, notebookId).catch((e) =>
            console.error("[NoteCanvas] WebDAV media upload failed:", item.fileId, e),
          );
        }
        onProgress?.(++uploaded, totalUploads);
      }
      if (hasPdfSource) {
        const pdfBlob = await getFile(noteData.pdfSource);
        if (pdfBlob) {
          await saveMediaForNote(pdfBlob, noteData.pdfSource, noteId, notebookId).catch((e) =>
            console.error("[NoteCanvas] WebDAV PDF upload failed:", e),
          );
        }
        onProgress?.(++uploaded, totalUploads);
      }
      await updateNote(noteId, {
        media: serializableMedia,
        deletedMedia: noteData.deletedMedia,
        pdfSource: noteData.pdfSource,
      }).catch((e) => console.error("[NoteCanvas] WebDAV media save failed:", e));
    } else {
      // Use StrokeManager (which uses StorageWorker) to save media updates
      // This prevents race conditions between stroke saving and media saving
      this.strokeManager.saveMedia({
        media: serializableMedia,
        deletedMedia: noteData.deletedMedia,
        pdfSource: noteData.pdfSource,
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
      this._cleanupOrphanedTasks();
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

    this.selectedTaskId = null;
    this.taskSelectionBounds = null;
    this.selectionOverlay.setTaskMode(false);

    // Detect text lines + indentation and show debug visualization
    this.selectionRotated = false;
    if (selectedIndices.size > 0) {
      const { separatorYs, lineGroups } = detectStrokeLines(this.noteData.strokes, selectedIndices);
      const indentLevels = detectLineIndentation(this.noteData.strokes, lineGroups);
      this.renderer.setLineSeparators(separatorYs, indentLevels);
    } else {
      this.renderer.setLineSeparators([], []);
    }

    // Show selection overlay if strokes are selected
    if (selectionBounds && selectedIndices.size > 0) {
      this._updateSelectionOverlay();
    } else {
      this.selectionOverlay?.hide();
    }
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
    const eraserRadius = this.eraserSize / 2; // Screen pixels (eraserSize is diameter)
    this.renderer.drawEraserCursor(screenX, screenY, eraserRadius, this.eraserMode);

    // 2. Erase strokes
    // Convert screen radius to content radius for hit testing
    const contentRadius = eraserRadius / this.zoomScale;
    const queryPadding = contentRadius;

    // Query potential hits
    const candidates = this.spatialIndex.query(contentY - queryPadding, contentY + queryPadding);

    if (this.eraserMode === "stroke") {
      const newlyErased = [];

      for (const index of candidates) {
        const stroke = this.noteData.strokes[index];
        if (stroke._deleted) continue;
        if (this.eraserHighlighterOnly && stroke.type !== "marker") continue;

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
        this.strokeManager.forceSave();
        this.strokesChanged = true;
      }
    } else {
      // Part eraser: split strokes in real-time
      if (!this._partEraserOps) {
        this._partEraserOps = [];
      }

      let anyChanged = false;

      for (const index of candidates) {
        const stroke = this.noteData.strokes[index];
        if (stroke._deleted) continue;
        if (this.eraserHighlighterOnly && stroke.type !== "marker") continue;

        // Effective erase radius accounts for the stroke's own half-width so
        // wide markers are hit even when the eraser only overlaps their ink,
        // not their center-line.
        const halfWidth = (stroke.width || 2) / 2;
        const effectiveR = contentRadius + halfWidth;
        const effectiveRSq = effectiveR * effectiveR;

        // Find which point indices are within the effective eraser radius.
        // Test segment-circle intersection: for each segment [i, i+1], if the
        // closest point on the segment to the eraser center is within effectiveR,
        // mark both endpoints as removed.
        const removedSet = new Set();
        const n = stroke.x.length;
        for (let i = 0; i < n; i++) {
          // Test the point itself
          const dx = stroke.x[i] - contentX;
          const dy = stroke.y[i] - contentY;
          if (dx * dx + dy * dy <= effectiveRSq) {
            removedSet.add(i);
          }
          // Test segment to next point
          if (i < n - 1) {
            const ax = stroke.x[i],
              ay = stroke.y[i];
            const bx = stroke.x[i + 1],
              by = stroke.y[i + 1];
            const abx = bx - ax,
              aby = by - ay;
            const acx = contentX - ax,
              acy = contentY - ay;
            const ab2 = abx * abx + aby * aby;
            if (ab2 > 0) {
              const t = Math.max(0, Math.min(1, (acx * abx + acy * aby) / ab2));
              const closestX = ax + t * abx - contentX;
              const closestY = ay + t * aby - contentY;
              if (closestX * closestX + closestY * closestY <= effectiveRSq) {
                removedSet.add(i);
                removedSet.add(i + 1);
              }
            }
          }
        }
        if (removedSet.size === 0) continue;

        // Split and replace in real-time
        const subStrokes = this._splitStrokeByRemovedPoints(stroke, removedSet);

        // Soft-delete original
        stroke._deleted = true;
        if (stroke.id && !this.noteData.deletedStrokes.includes(stroke.id)) {
          this.noteData.deletedStrokes.push(stroke.id);
        }

        // Push sub-strokes into noteData.strokes and spatial index
        const subStrokeEntries = subStrokes.map((s) => {
          const subIndex = this.noteData.strokes.length;
          this.noteData.strokes.push(s);
          this.spatialIndex.insert(s, subIndex);
          return { stroke: s, index: subIndex };
        });

        this._partEraserOps.push({
          originalIndex: index,
          originalId: stroke.id,
          subStrokes: subStrokeEntries,
        });

        anyChanged = true;
      }

      if (anyChanged) {
        this.renderer.forceRedraw();
        this.strokeManager.markDirty();
        this.strokeManager.forceSave();
        this.strokesChanged = true;
      }
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
      this._cleanupOrphanedTasks();
    }
    this._eraserBatch = null;
  }

  _commitPartEraserBatch() {
    if (this._partEraserOps && this._partEraserOps.length > 0) {
      const cmd = new EraseStrokePartsCommand(this._partEraserOps);
      this.historyManager?.push(cmd);
      this._cleanupOrphanedTasks();
    }
    this._partEraserOps = null;
  }

  /**
   * Split a stroke into sub-strokes by removing a set of point indices.
   * Returns contiguous segments of remaining points (each with at least 2 points).
   * @param {object} stroke
   * @param {Set<number>} removedSet
   * @returns {object[]}
   */
  _splitStrokeByRemovedPoints(stroke, removedSet) {
    const totalPoints = stroke.x.length;
    const subStrokes = [];
    let segmentStart = null;

    for (let i = 0; i <= totalPoints; i++) {
      const isRemoved = i === totalPoints || removedSet.has(i);

      if (!isRemoved && segmentStart === null) {
        segmentStart = i;
      } else if (isRemoved && segmentStart !== null) {
        const length = i - segmentStart;
        if (length >= 2) {
          const subStroke = {
            id: generateId(),
            x: stroke.x.slice(segmentStart, i),
            y: stroke.y.slice(segmentStart, i),
            pressure: stroke.pressure.slice(segmentStart, i),
            time: stroke.time.slice(segmentStart, i),
            colorIndex: stroke.colorIndex,
            width: stroke.width,
            pointerType: stroke.pointerType,
            type: stroke.type,
          };
          // Marker sub-strokes share a groupId so the renderer can draw them
          // as one path, preserving flat alpha (no alpha stacking at joins).
          if (stroke.type === "marker") {
            subStroke.groupId = stroke.groupId || stroke.id;
          }
          subStrokes.push(subStroke);
        }
        segmentStart = null;
      }
    }

    return subStrokes;
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
      initialLineSeparators: [...this.renderer.lineSeparators],
      initialLineIndentLevels: [...this.renderer.lineIndentLevels],
    };
  }

  /**
   * Handle move during transform
   * @private
   */
  _handleTransformMove(x, y) {
    const {
      mode,
      handle,
      startX,
      startY,
      initialBounds,
      initialStrokes,
      selectedIndices,
      initialLineSeparators,
      initialLineIndentLevels,
    } = this.transformState;
    const dx = x - startX;
    const dy = y - startY;

    let newBounds = { ...initialBounds };

    if (mode === "move") {
      this._handleMove(dx, dy, newBounds, initialStrokes, selectedIndices);
      // Shift separators by the same dy
      this.renderer.setLineSeparators(
        initialLineSeparators.map((sepY) => sepY + dy),
        initialLineIndentLevels,
      );
    } else if (mode === "resize") {
      this._handleResize(dx, dy, handle, newBounds, initialBounds, initialStrokes, selectedIndices);
      // Scale separator Y positions proportionally within the new bounds
      const oldHeight = initialBounds.maxY - initialBounds.minY;
      const newHeight = newBounds.maxY - newBounds.minY;
      if (oldHeight > 0) {
        this.renderer.setLineSeparators(
          initialLineSeparators.map(
            (sepY) => newBounds.minY + ((sepY - initialBounds.minY) / oldHeight) * newHeight,
          ),
          initialLineIndentLevels,
        );
      }
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
      // Clear separators during rotate — they're no longer meaningful as horizontal lines
      this.renderer.setLineSeparators([], []);
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

    // After rotate, line detection is unreliable (rotated strokes span large Y ranges
    // and confuse the density histogram). Treat the whole selection as one block.
    if (this.transformState.mode === "rotate") {
      this.selectionRotated = true;
      this.renderer.setLineSeparators([], []);
    }

    this.transformState = null;

    // Force full redraw to ensure high quality
    this.renderer.forceRedraw();
    this._updateSelectionOverlay();
    this._updateTaskCheckboxes();
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
    // In text mode, let mouse events pass through to the text editor (no pan, no media hit)
    if (this.mode === "text" && e.pointerType === "mouse") return;

    // Deselect task if clicking outside task UI or selection overlay
    const isTaskInteraction =
      e.target.closest &&
      (e.target.closest(".note-canvas__task-bounding-box") ||
        e.target.closest(".note-canvas__task-checkbox") ||
        e.target.closest(".note-canvas__selection-overlay"));

    if (this.selectedTaskId && !isTaskInteraction) {
      this.renderer.setSelectedStrokes(new Set(), null);
      this.selectedTaskId = null;
      this.taskSelectionBounds = null;
      this.selectionOverlay?.hide();
    }

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

    const isTextModeTouch = this.mode === "text" && e.pointerType === "touch";

    this.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // In text mode, delay pointer capture until the user drags beyond a threshold.
    // This lets taps reach the text editor for cursor placement.
    if (isTextModeTouch) {
      this._textModePanState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        target: e.target,
        captured: false,
      };
    } else {
      // Capture pointer to track dragging outside viewport
      try {
        e.target.setPointerCapture(e.pointerId);
      } catch (_err) {
        // Ignore capture errors
      }
    }

    if (this.activePointers.size === 2) {
      // Start Pinch
      this._isZooming = true;
      this.lastTouchDistance = this._getPointersDistance();
      this.initialPinchZoom = this.zoomScale;
      this._clearCanvasLongPress();
    } else if (this.activePointers.size === 1) {
      // Start Pan
      this.lastTouchX = e.clientX;
      this.lastTouchY = e.clientY;
      this.lastMoveTime = Date.now();
      this.velocityX = 0;
      this.velocityY = 0;

      // Start canvas long-press to show paste menu (touch only — right-click handled via contextmenu)
      if (e.pointerType === "touch" && AppClipboard.canPasteInMode(this.mode)) {
        this._startCanvasLongPress(e.clientX, e.clientY);
      }
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
    } else if (this._canvasLongPressTimer) {
      // Canvas paste long-press: check movement independently (no media item involved)
      this._checkCanvasLongPressMove(e.clientX, e.clientY);
    }

    if (this.mode === "insert-space" && !this.insertSpaceState) {
      const { y } = this.inputHandler.getContentCoordinates(e.clientX, e.clientY);
      this.renderer.drawInsertSpaceIndicator({ startY: y, currentY: y });
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
      // In text mode, allow touch panning (with threshold to distinguish from taps)
      const isTextModeTouch = this.mode === "text" && e.pointerType === "touch";
      if (!isTextModeTouch) {
        // If in manual draw/eraser mode, single touch should draw/erase, not pan.
        // UNLESS stylus mode is active (stylusDetected), then touch always pans.
        if (!this.stylusDetected && this.mode !== "pan" && !this.autoSwitchedToDrawMode) return;
        // Mouse in draw/eraser/lasso mode is handled by InputHandler or ignored
        if (this.mode !== "pan" && e.pointerType === "mouse") return;
      }

      const x = e.clientX;
      const y = e.clientY;

      // In text mode, require a drag threshold before capturing for pan.
      // Below threshold, the touch is a tap for cursor placement.
      if (isTextModeTouch && this._textModePanState && !this._textModePanState.captured) {
        const totalDx = x - this._textModePanState.startX;
        const totalDy = y - this._textModePanState.startY;
        if (totalDx * totalDx + totalDy * totalDy < 64) return; // 8px threshold
        // Exceeded threshold — capture pointer and start panning
        this._textModePanState.captured = true;
        try {
          this._textModePanState.target.setPointerCapture(e.pointerId);
        } catch (_err) {
          // Ignore capture errors
        }
        // Clear any text selection that may have started
        window.getSelection()?.removeAllRanges();
        // Reset pan origin to current position to avoid jump
        this.lastTouchX = x;
        this.lastTouchY = y;
        this.lastMoveTime = Date.now();
        return;
      }
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

    if (this.mode === "insert-space" && !this.insertSpaceState) {
      this.renderer.clearOverlay();
    }

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

    // Clean up text-mode touch pan state
    const wasTextModePan = this._textModePanState?.pointerId === e.pointerId;
    const didCapture = wasTextModePan && this._textModePanState.captured;
    if (wasTextModePan) {
      this._textModePanState = null;
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
        // Check for momentum if release was recent (skip if tap in text mode)
        const now = Date.now();
        if (now - this.lastMoveTime < 100 && (!wasTextModePan || didCapture)) {
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

    // Update PDF text layers and text editor after zoom
    this._updatePdfTextLayers();
    this._updateTextEditorLayer();
    this._updatePdfControlsPosition();
    this._updateTaskCheckboxes();
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

  /**
   * Delete the imported PDF and all its pages
   */
  async deletePdf() {
    if (!this.noteData.pdfSource) return;

    const confirmed = await showConfirmDialog(
      t("canvas.pdf.deleteConfirmTitle"),
      t("canvas.pdf.deleteConfirmMsg"),
      t("common.delete"),
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

    this.renderer.showA4PageBreaks = true;
    this.renderer.forceRedraw();
    this._renderPdfControls();
  }

  /**
   * Export the note to a PDF file and trigger a browser download.
   * @private
   */
  async _exportPdf() {
    const progress = showProgressDialog(t("canvas.pdf.exportProgressTitle"));
    try {
      const mediaItems = this.mediaManager.getItems();
      const bytes = await exportNoteToPdf(this.noteData, mediaItems, (current, total) => {
        progress.update(current, total, t("canvas.pdf.exportProgressPage", { current, total }));
      });
      progress.close();
      const filename = `${this.noteData.title || "note"}.pdf`;
      await downloadPdfBytes(bytes, filename);
    } catch (err) {
      progress.close();
      console.error("[NoteCanvas] PDF export failed:", err);
      await showAlertDialog(t("canvas.pdf.exportError"), err.message);
    }
  }

  /**
   * Clean up all resources
   */
  destroy() {
    // Step 1: Force-flush any pending content to the worker immediately.
    // Text content must be flushed before the thumbnail save so the DB reflects the
    // latest hasContent flag, and before recognition which reads DB content.
    // Strokes must be flushed for the same reasons.
    this._pendingTextSave = null;
    if (this.textEditorLayer) {
      this.textEditorLayer.forceSave();
    }
    const pendingTextSave = this._pendingTextSave || null;
    let pendingStrokeSave = null;
    if (this.strokeManager) {
      pendingStrokeSave = this.strokeManager.forceSave() || null;
    }

    // Step 2: Trigger handwriting recognition if strokes changed.
    // Runs concurrently with thumbnail save — both are awaited before sync starts.
    let pendingRecognition = null;
    if (this.strokesChanged && this.noteId && this.noteData?.strokes) {
      const activeStrokes = this.noteData.strokes.filter((s) => !s._deleted && !s.isDeleted);
      if (activeStrokes.length > 0) {
        pendingRecognition = forceRecognition(this.noteId, activeStrokes).catch((e) =>
          console.error("[NoteCanvas] Recognition failed:", e),
        );
      }
    }

    // Cancel pending task render
    if (this._renderTasksTimeout) {
      clearTimeout(this._renderTasksTimeout);
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

    if (this.selectionOverlay) {
      this.selectionOverlay.destroy();
      this.selectionOverlay = null;
    }

    if (this.taskCheckboxLayer) {
      this.taskCheckboxLayer.destroy();
      this.taskCheckboxLayer = null;
    }

    if (this.historyManager) {
      this.historyManager.destroy();
      this.historyManager = null;
    }

    if (this.pdfTextLayerManager) {
      this.pdfTextLayerManager.destroy();
      this.pdfTextLayerManager = null;
    }

    if (this.textEditorLayer) {
      this.textEditorLayer.destroy();
      this.textEditorLayer = null;
    }

    if (this.inputHandler) {
      this.inputHandler.destroy();
      this.inputHandler = null;
    }

    if (this.toolbar) {
      this.toolbar.destroy();
      this.toolbar = null;
    }

    if (this.navigator) {
      this.navigator.destroy();
      this.navigator = null;
    }

    if (this.soundDialog) {
      this.soundDialog.destroy();
      this.soundDialog = null;
    }

    if (this.recordingManager) {
      this.recordingManager.destroy();
      this.recordingManager = null;
    }

    const cleanupStrokeManager = () => {
      if (this.strokeManager) {
        this.strokeManager.destroy(); // sends CLOSE to worker
        this.strokeManager = null;
      }
    };

    // Capture flags before clearing state
    const hadMediaChanges = this.mediaChanged;

    // Clear state
    this.noteId = null;
    this.noteData = null;
    this.isInitialized = false;

    // Clear debug reference
    if (window.__noteCanvas === this) {
      window.__noteCanvas = null;
    }

    // Return promise that resolves when all async work (recognition) completes.
    // Resolves with { mediaChanged } so callers can decide whether to force a sync even
    // when the note's synced flag appears clean (the Web Worker may not have processed
    // SAVE_MEDIA yet when syncOnNoteClose reads the index store).
    cleanupStrokeManager();

    // Wait for recognition, stroke save, and any in-progress PDF import
    const pending = [Promise.resolve()];
    if (pendingRecognition) pending.push(pendingRecognition);
    if (pendingStrokeSave) pending.push(pendingStrokeSave);
    if (pendingTextSave) pending.push(pendingTextSave);
    if (this._pendingPdfImport) pending.push(this._pendingPdfImport);
    return Promise.all(pending).then(() => ({ mediaChanged: hadMediaChanges }));
  }
}
