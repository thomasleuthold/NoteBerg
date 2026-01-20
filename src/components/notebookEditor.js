/**
 * Notebook Editor Component
 * Layered canvas approach with text editor and drawing layer
 * Auto-detects input type (stylus vs mouse) for mode switching
 *
 * Note: PerspT (perspective-transform) is loaded globally via script tag in index.html
 */

import { forceRecognition } from "../modules/autoRecognition.js";
import { stopInactivityTimer, syncOnNoteClose } from "../modules/autoSync.js";
import { getCurrentNoteId, navigateTo } from "../modules/router.js";
import { deleteNote, generateId, getNote, updateNote } from "../modules/storage.js";
import { getTheme } from "../modules/theme.js";
import { getIcon } from "../utils/icons.js";
import {
  captureFromCamera,
  fileToDataUrl,
  optimizeImageForDisplay,
  pickImages,
} from "../utils/imageUtils.js";
import { htmlToMarkdown, markdownToHtml } from "../utils/markdown.js";
import {
  drawBackgroundPattern as sharedDrawBackgroundPattern,
  drawStroke as sharedDrawStroke,
  getThemePalette as sharedGetThemePalette,
} from "../utils/noteRenderer.js";
import { showConfirmDialog, showNoteInfoModal } from "./modals.js";

// Editor state
let currentEditor = null;
let currentNoteData = null;
let isDrawMode = false;
let isEraserMode = false; // Manual eraser toggle
let isLassoMode = false; // Manual lasso toggle

// Layered Canvases (4 canvases for memory efficiency)
// - staticCanvas: background pattern + completed strokes (full zoom resolution)
// - dynamicCanvas: active drawing stroke (full zoom resolution)
// - mediaCanvas: images (full zoom resolution)
// - overlayCanvas: cursor + highlights (base resolution only, no zoom scaling)
let staticCanvas = null; // For background + completed strokes
let staticCtx = null;
let dynamicCanvas = null; // For active drawing
let dynamicCtx = null;
let mediaCanvas = null; // For media items (images)
let mediaCtx = null;
let overlayCanvas = null; // For cursor + highlights (stays at base resolution)
let overlayCtx = null;
let canvasRect = null; // Cached bounding client rect for performance

let isDrawing = false;
let isErasing = false; // Track if currently erasing
let isLassoing = false; // Track if currently lassoing
let needsCanvasExpansion = false; // Flag to defer canvas expansion
let lassoPoints = []; // Stores points for the lasso path
const selectedStrokes = new Set(); // Stores selected strokes
let selectionBounds = null; // Bounding box of selected strokes
let isTransforming = false;
let transformMode = null; // 'move', 'resize', 'rotate'
let transformStartPoint = null;
let initialSelectionBounds = null;
let initialStrokesData = []; // Store original points during transformation
let clipboardStrokes = null;
const handleSize = 24; // Size of selection handles
let currentStroke = [];
let strokes = [];
let deletedStrokes = []; // Track IDs of deleted strokes for sync
let mediaItems = []; // Track media items (images)
let deletedMedia = []; // Track IDs of deleted media for sync

// Media manipulation state
let selectedMediaId = null; // Currently selected media item ID
let mediaTransformState = null; // { mode: 'move'|'resize'|'rotate', handle: 'nw'|'ne'|'sw'|'se'|'rotate', startX, startY, initialX, initialY, initialWidth, initialHeight }
const mediaHandleSize = 20; // Size of media resize handles (increased from 12 for easier clicking)
let _mediaHoverState = null; // { mediaId, handle: null|'nw'|'ne'|'sw'|'se' }
let isImageMode = false; // Track if in image manipulation mode
let mediaPanState = null;
let dynamicStrokeDrawScheduled = false;
let dynamicStrokeLastDrawIndex = 0;
let dynamicStrokeLastY = null;
let noteEditedSinceOpen = false;
let pendingExternalRefresh = false;
let lastExpansionTime = 0;
const expansionCooldown = 500; // Minimum ms between expansions
let autoSwitchedToDrawMode = false; // Track if draw mode was auto-activated by stylus
let autoActivatedEraserMode = false; // Track if eraser mode was auto-activated by stylus button
const eraserRadius = 10; // Eraser size in pixels
let activeSearchQuery = null; // Track active search query for highlighting

// Pen settings state
let currentPenWidth = 2;
let currentPenColorIndex = 0;

// Canvas size tracking for overflow handling
let minCanvasWidth = 0; // Minimum width needed to show all content
let minCanvasHeight = 0; // Minimum height needed to show all content

// Base canvas dimensions (unscaled, before zoom resolution multiplier)
let baseCanvasWidth = 0;
let baseCanvasHeight = 0;

// Zoom state
let zoomScale = 1.0; // Current zoom level (1.0 = 100%)
const minZoom = 0.25; // Minimum zoom (25%)
const maxZoom = 2.0; // Maximum zoom (200%)
const zoomStep = 0.1; // Zoom increment per step

// Gesture tracking for pinch-to-zoom
let lastTouchDistance = null;
let initialPinchZoom = null;
let pinchCenter = null; // Store the center point of pinch gesture

// Zoom re-render state
let zoomRerenderTimer = null;
const ZOOM_RERENDER_DEBOUNCE = 300; // ms to wait after zoom gesture ends before re-rendering
let isZoomingGesture = false; // Track if currently performing zoom gesture
let currentResolutionScale = 1.0; // The resolution scale currently applied to the canvas bitmap

// Resize throttling
let resizeThrottleTimer = null;
let lastResizeTime = 0;

// Cached theme palette to avoid repeated theme lookups
let cachedPalette = null;
let cachedTheme = null;

// Debounce and throttle save operations
let isSaving = false; // Flag to prevent re-entrant saves and self-triggered updates
let saveDebounceTimer = null;
const SAVE_DEBOUNCE_MS = 1500; // Save after 1.5s of inactivity
let lastSaveTime = 0;
const SAVE_THROTTLE_MS = 3000; // Also save at least every 3s during writing

/**
 * Helper function to clear a canvas properly regardless of transform state
 * Resets transform, clears the full bitmap, then restores transform
 * @param {CanvasRenderingContext2D} ctx - Canvas context to clear
 * @param {HTMLCanvasElement} canvas - Canvas element
 */
function clearCanvas(ctx, canvas) {
  if (!ctx || !canvas) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/**
 * Initialize notebook editor component
 */
export function initNotebookEditorComponent() {
  // Listen for render notebook event from router
  window.addEventListener("rendernotebook", async (e) => {
    let { noteId, searchQuery } = e.detail || {};

    // Fallback: check session storage for search query if not in event detail
    if (!searchQuery) {
      const storedQuery = sessionStorage.getItem("onejournal_search_query");
      if (storedQuery) {
        searchQuery = storedQuery;
        sessionStorage.removeItem("onejournal_search_query");
      }
    }

    if (noteId) {
      await initNotebookEditor(noteId, searchQuery);
    }
  });

  // Listen for data changes to refresh the editor if the current note was updated
  window.addEventListener("datachange", async () => {
    // Ignore updates that were triggered by this component's own save operations
    if (isSaving) {
      return;
    }
    const noteId = getCurrentNoteId();
    if (noteId && currentNoteData && noteId === currentNoteData.id) {
      // Defer refresh if user is actively interacting with the note
      if (isDrawing || isErasing || isLassoing || isTransforming || noteEditedSinceOpen) {
        pendingExternalRefresh = true;
        console.log(
          "External data change detected but note has unsaved changes. Deferring refresh until note is closed.",
        );
        return;
      }
      console.log("External data change detected for current note. Refreshing editor.");
      await updateEditorContent(noteId);
    }
  });

  // Listen for navigation changes to cleanup
  window.addEventListener("navigate", (e) => {
    if (e.detail.previousMode === "notebook") {
      // Capture noteId before router clears it
      const noteIdBeforeCleanup = currentNoteData?.id;
      // Fire and forget - don't block navigation
      cleanupNotebookEditor(noteIdBeforeCleanup).catch((err) =>
        console.error("Cleanup error:", err),
      );
    }
  });

  console.log("Notebook editor component initialized");
}

/**
 * Initialize notebook editor for a note
 * @param {string} noteId - ID of note to edit
 * @param {string|null} searchQuery - Optional search query to highlight
 */
export async function initNotebookEditor(noteId, searchQuery = null) {
  if (!noteId) {
    console.warn("No note ID provided to editor");
    return;
  }

  try {
    // Load note data
    currentNoteData = await getNote(noteId);
    if (!currentNoteData) {
      throw new Error("Note not found");
    }

    activeSearchQuery = searchQuery;
    console.log("[NotebookEditor] Initializing with search query:", searchQuery);

    // Set default background for existing notes without one
    if (!currentNoteData.background) {
      currentNoteData.background = "none";
    }

    noteEditedSinceOpen = false;

    // Initialize default pen settings
    currentPenColorIndex = 0;

    // Get or create editor container
    const editorContainer = document.getElementById("notebook-editor-container");
    if (!editorContainer) {
      console.error("Editor container not found");
      return;
    }

    // Render editor UI
    renderEditor(editorContainer, currentNoteData);

    // Initialize text editor
    initTextEditor(currentNoteData);

    // Initialize canvas layer
    initCanvasLayer(currentNoteData);

    // Defensive: always default to text mode on open
    autoSwitchedToDrawMode = false;
    autoActivatedEraserMode = false;
    isEraserMode = false;
    isLassoMode = false;
    switchToTextMode();

    // Initialize zoom to ensure transforms are applied on load
    setZoom(1.0, { immediate: true });

    // Initialize save timer
    lastSaveTime = Date.now();

    // Highlight search terms if provided
    if (searchQuery) {
      console.log("[NotebookEditor] Scheduling initial highlight");
      setTimeout(() => {
        highlightSearchTerms(searchQuery);
      }, 100);
    }

    console.log("Notebook editor initialized for note:", noteId);
  } catch (error) {
    console.error("Error initializing notebook editor:", error);
  }
}

/**
 * Render editor structure
 */
function renderEditor(container, _noteData) {
  // Get all icons upfront for better performance
  const icons = {
    pen: getIcon("pen", 20),
    eraser: getIcon("eraser", 20),
    lasso: getIcon("lasso", 20),
    trash: getIcon("trash", 20),
    clipboard: getIcon("clipboard", 20),
    background: getIcon("background", 20),
    zoomOut: getIcon("zoomOut", 20),
    zoomIn: getIcon("zoomIn", 20),
    zoomReset: getIcon("zoomReset", 20),
    info: getIcon("info", 20),
    image: getIcon("image", 20),
    camera: getIcon("camera", 20),
    crop: getIcon("crop", 20),
    arrowUp: getIcon("arrowUp", 20),
    arrowDown: getIcon("arrowDown", 20),
  };

  container.innerHTML = `
    <div class="notebook-editor">
      <div class="editor-toolbar">
        
        <!-- Row 1 -->
        <div class="toolbar-row toolbar-row-top">
          <div class="toolbar-section">
            <div class="toolbar-tabs" role="tablist" aria-label="Editor mode">
              <button class="toolbar-tab" id="mode-text-btn" title="Text mode" role="tab" aria-selected="true">
                T
              </button>
              <button class="toolbar-tab" id="mode-draw-btn" title="Draw mode" role="tab" aria-selected="false">
                ${icons.pen}
              </button>
              <button class="toolbar-tab" id="mode-image-btn" title="Image mode" role="tab" aria-selected="false">
                ${icons.image}
              </button>
            </div>
          </div>
          
          <div class="toolbar-section toolbar-section-right">
            <div class="toolbar-btn-container">
              <button class="toolbar-btn" id="background-btn" title="Background">
                ${icons.background}
              </button>
              <div id="background-settings-dialog" class="background-settings-dialog">
                <div class="background-option" data-background="none">None</div>
                <div class="background-option" data-background="ruled-narrow">Ruled - Narrow</div>
                <div class="background-option" data-background="ruled-medium">Ruled - Medium</div>
                <div class="background-option" data-background="ruled-wide">Ruled - Wide</div>
                <div class="background-option" data-background="grid-small">Grid - Small</div>
                <div class="background-option" data-background="grid-medium">Grid - Medium</div>
                <div class="background-option" data-background="grid-large">Grid - Large</div>
              </div>
            </div>
            <button class="toolbar-btn" id="zoom-out-btn" title="Zoom out">
              ${icons.zoomOut}
            </button>
            <span class="zoom-indicator" id="zoom-level">100%</span>
            <button class="toolbar-btn" id="zoom-in-btn" title="Zoom in">
              ${icons.zoomIn}
            </button>
            <button class="toolbar-btn" id="zoom-reset-btn" title="Reset zoom">
              ${icons.zoomReset}
            </button>
            <div class="toolbar-divider"></div>
            <button class="toolbar-btn" id="delete-note-btn" title="Delete note">
              ${icons.trash}
            </button>
            <button class="toolbar-btn" id="note-info-btn" title="Note properties">
              ${icons.info}
            </button>
          </div>
        </div>

        <!-- Row 2 -->
        <div class="toolbar-row toolbar-row-bottom" id="toolbar-row-2">
          
          <!-- Text Tools -->
          <div id="text-tools" class="toolbar-section text-tools">
            <button class="toolbar-btn toolbar-btn-text" id="format-bold-btn" title="Bold">
              <strong>B</strong>
            </button>
            <button class="toolbar-btn toolbar-btn-text" id="format-italic-btn" title="Italic">
              <em>I</em>
            </button>
            <button class="toolbar-btn toolbar-btn-text" id="format-heading-btn" title="Heading">
              H
            </button>
            <button class="toolbar-btn" id="format-list-btn" title="List">
              •
            </button>
          </div>

          <!-- Image Tools -->
          <div id="image-tools" class="toolbar-section image-tools">
            <button class="toolbar-btn" id="insert-image-btn" title="Insert image">
              ${icons.image}
            </button>
            <button class="toolbar-btn" id="insert-camera-btn" title="Take photo">
              ${icons.camera}
            </button>
            <div class="toolbar-divider"></div>
            <button class="toolbar-btn" id="crop-media-btn" title="Crop image" style="display: none;">
              ${icons.crop}
            </button>
            <button class="toolbar-btn" id="delete-media-btn" title="Delete image" style="display: none;">
              ${icons.trash}
            </button>
            <div class="toolbar-divider" id="layer-divider" style="display: none;"></div>
            <button class="toolbar-btn" id="move-forward-btn" title="Move forward" style="display: none;">
              ${icons.arrowUp}
            </button>
            <button class="toolbar-btn" id="move-backward-btn" title="Move backward" style="display: none;">
              ${icons.arrowDown}
            </button>
          </div>

          <!-- Pen Tools -->
          <div id="pen-tools" class="toolbar-section pen-tools">
            <div class="toolbar-btn-container">
              <button class="toolbar-btn" id="pen-settings-btn" title="Pen Settings">
                ${icons.pen}
              </button>
              <div id="pen-settings-dialog" class="pen-settings-dialog">
                <div class="pen-settings-section">
                  <span class="pen-settings-label">Pen Width: <span id="pen-width-value">2</span>px</span>
                  <div class="pen-width-control">
                    <input type="range" id="pen-width-slider" class="pen-width-slider" min="1" max="15" step="1" value="2">
                  </div>
                </div>
                <div class="pen-settings-section">
                  <span class="pen-settings-label">Pen Color</span>
                  <div id="pen-color-grid" class="pen-color-grid">
                    <!-- Colors injected by JS -->
                  </div>
                </div>
              </div>
            </div>
            <button class="toolbar-btn" id="mode-erase-btn" title="Eraser mode">
              ${icons.eraser}
            </button>
            <button class="toolbar-btn" id="mode-lasso-btn" title="Lasso select">
              ${icons.lasso}
            </button>
            <button class="toolbar-btn toolbar-btn-hidden" id="delete-selection-btn" title="Delete selection">
              ${icons.trash}
            </button>
            <button class="toolbar-btn toolbar-btn-hidden" id="paste-btn" title="Paste">
              ${icons.clipboard}
            </button>
          </div>

        </div>
      </div>

      <div class="editor-content-wrapper" style="position: relative;">
        <div id="text-editor" class="text-editor" contenteditable="true"></div>
        <canvas id="static-canvas" class="static-canvas" style="position: absolute; top: 0; left: 0; z-index: 1;"></canvas>
        <canvas id="media-canvas" class="media-canvas" style="position: absolute; top: 0; left: 0; z-index: 2; pointer-events: none;"></canvas>
        <canvas id="dynamic-canvas" class="dynamic-canvas" style="position: absolute; top: 0; left: 0; z-index: 3;"></canvas>
        <canvas id="overlay-canvas" class="overlay-canvas" style="position: absolute; top: 0; left: 0; z-index: 4; pointer-events: none;"></canvas>
      </div>
    </div>
  `;

  // Attach toolbar event listeners
  attachToolbarListeners();
}

/**
 * Initialize text editor with Markdown WYSIWYG
 */
function initTextEditor(noteData) {
  const textEditor = document.getElementById("text-editor");
  if (!textEditor) return;

  // Set initial content (convert markdown to HTML for WYSIWYG)
  if (noteData.content) {
    textEditor.innerHTML = markdownToHtml(noteData.content);
  } else {
    textEditor.innerHTML = "<p><br></p>";
  }

  // Auto-save on input with debounce
  let saveTimeout;
  let resizeTimeout;
  textEditor.addEventListener("input", () => {
    markNoteEdited();
    // Debounce canvas resize for better performance
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      resizeCanvas();
    }, 100); // Resize after 100ms of no input

    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      scheduleSave();
    }, 5000); // Save after 5 seconds of no input (matches SAVE_DEBOUNCE_MS)
  });

  // Handle input type detection for auto mode switching
  textEditor.addEventListener("pointerdown", handlePointerDown);
  textEditor.addEventListener("pointermove", handlePointerMove);
  textEditor.addEventListener("pointerup", handlePointerUp);
  textEditor.addEventListener("pointercancel", handlePointerUp);

  currentEditor = textEditor;
}

/**
 * Initialize canvas layer for drawing
 */
function initCanvasLayer(noteData) {
  // Setup all canvas layers (4 canvases for memory efficiency)
  staticCanvas = document.getElementById("static-canvas");
  mediaCanvas = document.getElementById("media-canvas");
  dynamicCanvas = document.getElementById("dynamic-canvas");
  overlayCanvas = document.getElementById("overlay-canvas");

  if (!staticCanvas || !mediaCanvas || !dynamicCanvas || !overlayCanvas) {
    console.error("One or more canvas layers are missing from the DOM.");
    return;
  }

  staticCtx = staticCanvas.getContext("2d");
  mediaCtx = mediaCanvas.getContext("2d");
  dynamicCtx = dynamicCanvas.getContext("2d");
  overlayCtx = overlayCanvas.getContext("2d");

  // Initial canvas sizing with throttling
  window.addEventListener("resize", throttledResizeCanvas);

  // Add zoom event listeners
  initZoomListeners();

  // Listen for theme changes to invalidate caches
  window.addEventListener("themechange", () => {
    cachedTheme = null;
    cachedPalette = null;
    redrawBackground(); // Redraw background with new theme colors
    redrawCanvas(); // Redraw strokes with new theme colors
  });

  // Load existing strokes and deleted stroke IDs
  if (noteData.strokes && Array.isArray(noteData.strokes)) {
    strokes = noteData.strokes;
    console.log(`[NotebookEditor] Initial strokes loaded: ${strokes.length}`);
    updateContentBounds();
  }
  if (noteData.deletedStrokes && Array.isArray(noteData.deletedStrokes)) {
    deletedStrokes = noteData.deletedStrokes;
  } else {
    deletedStrokes = [];
  }

  // Load existing media items and deleted media IDs
  if (noteData.media && Array.isArray(noteData.media)) {
    mediaItems = noteData.media;
    console.log(`[NotebookEditor] Initial media items loaded: ${mediaItems.length}`);
  }
  if (noteData.deletedMedia && Array.isArray(noteData.deletedMedia)) {
    deletedMedia = noteData.deletedMedia;
  } else {
    deletedMedia = [];
  }

  requestAnimationFrame(() => {
    resizeCanvas();
    redrawCanvas(); // This will now draw to the static canvas
    redrawMedia(); // Draw media items
  });

  // Add pen detection on the wrapper to enable canvas pointer-events for scrolled areas
  const wrapper = dynamicCanvas.parentElement;
  if (wrapper) {
    wrapper.addEventListener(
      "pointerdown",
      (e) => {
        // If pen detected and not in draw mode, temporarily enable canvas pointer events
        // so handleCanvasPointerDown can receive the event and auto-switch
        if (
          (e.pointerType === "pen" || e.pointerType === "eraser") &&
          !isDrawMode &&
          dynamicCanvas
        ) {
          dynamicCanvas.style.pointerEvents = "auto";
          // Let the event propagate to canvas
        }
      },
      { capture: true },
    ); // Use capture to intercept before canvas
  }

  // Prevent context menu on right-click (e.g., from pen barrel button)
  dynamicCanvas.addEventListener("contextmenu", (e) => {
    if (e.pointerType === "pen") {
      e.preventDefault();
    }
  });

  // Canvas drawing events on the top-most (dynamic) canvas
  dynamicCanvas.addEventListener("pointerdown", (e) => {
    // Auto-detect pen and switch to draw mode if needed
    const shouldContinue = handleCanvasPointerDown(e);
    if (shouldContinue === false) return;

    // Only prevent default and capture for pen events or when in draw mode
    if (e.pointerType === "pen" || e.pointerType === "eraser" || isDrawMode || isErasing) {
      e.preventDefault();
      dynamicCanvas.setPointerCapture(e.pointerId);
    }
  });
  dynamicCanvas.addEventListener("pointermove", (e) => {
    // Make prevention more aggressive: prevent default on any move in draw mode or erasing.
    if (isDrawMode || isErasing) e.preventDefault();
    handleCanvasPointerMove(e);
  });
  dynamicCanvas.addEventListener("pointerup", (e) => {
    handleCanvasPointerUp(e);
    if ((isDrawMode || isErasing) && dynamicCanvas.hasPointerCapture(e.pointerId)) {
      dynamicCanvas.releasePointerCapture(e.pointerId);
    }
  });
  dynamicCanvas.addEventListener("pointercancel", handleCanvasPointerUp);

  // Prevent touch scrolling on canvas when in draw mode
  dynamicCanvas.addEventListener(
    "touchstart",
    (e) => {
      if (autoSwitchedToDrawMode && isDrawMode && !isDrawing && !isErasing) {
        switchToTextMode();
        return;
      }
      if (isDrawMode || isErasing) e.preventDefault();
    },
    { passive: false },
  );

  dynamicCanvas.addEventListener(
    "touchmove",
    (e) => {
      if (isDrawMode || isErasing) e.preventDefault();
    },
    { passive: false },
  );
}

/**
 * Throttled wrapper for resizeCanvas to improve performance
 */
function throttledResizeCanvas() {
  // Skip resize if currently drawing to avoid performance issues
  if (isDrawing || isErasing) {
    return;
  }

  // Throttle resize events to max 60fps (every ~16ms)
  const now = Date.now();
  if (now - lastResizeTime < 16) {
    clearTimeout(resizeThrottleTimer);
    resizeThrottleTimer = setTimeout(resizeCanvas, 16);
    return;
  }

  lastResizeTime = now;
  resizeCanvas();
}

/**
 * Resize canvas to match container
 */
function resizeCanvas() {
  if (!dynamicCanvas || !staticCanvas || !mediaCanvas || !overlayCanvas || !currentEditor) return;

  const wrapper = dynamicCanvas.parentElement;
  const rect = wrapper.getBoundingClientRect();

  // Cache the bounding rect for coordinate calculations
  canvasRect = dynamicCanvas.getBoundingClientRect();

  // Calculate base dimensions (the content coordinate space, independent of zoom)
  // Base canvas should be large enough to show:
  // 1. The viewport at 100% zoom (not scaled by current zoom)
  // 2. All existing content (strokes, media)
  // 3. A minimum size for usability
  // Note: Don't divide by zoomScale - that inflates base size when zoomed out
  const requiredHeight = Math.max(rect.height, minCanvasHeight, 800);
  const requiredWidth = Math.max(rect.width, minCanvasWidth, 800);

  // Prevent excessive canvas sizes that could cause performance issues
  // Optimized for vertical scrolling: narrow width, tall height
  const maxCanvasWidth = 2000;
  const maxCanvasHeight = 25000;
  const safeWidth = Math.min(requiredWidth, maxCanvasWidth);
  const safeHeight = Math.min(requiredHeight, maxCanvasHeight);

  // Update base dimensions - allow both growing and shrinking
  // based on actual content needs
  const prevBaseWidth = baseCanvasWidth;
  const prevBaseHeight = baseCanvasHeight;
  baseCanvasWidth = safeWidth;
  baseCanvasHeight = safeHeight;

  // Calculate the maximum resolution scale we can use without exceeding canvas limits
  const maxResolutionScaleW = maxCanvasWidth / baseCanvasWidth;
  const maxResolutionScaleH = maxCanvasHeight / baseCanvasHeight;
  const maxResolutionScale = Math.min(maxResolutionScaleW, maxResolutionScaleH);

  // Desired resolution scale is the zoom level, capped at maxResolutionScale
  const desiredResolutionScale = Math.max(1.0, zoomScale);
  const actualResolutionScale = Math.min(desiredResolutionScale, maxResolutionScale);

  // Store the resolution scale for preview zoom calculations
  currentResolutionScale = actualResolutionScale;

  // Calculate bitmap dimensions
  const bitmapWidth = Math.round(baseCanvasWidth * actualResolutionScale);
  const bitmapHeight = Math.round(baseCanvasHeight * actualResolutionScale);

  // CSS size = bitmap size (no stretching)
  const cssWidth = bitmapWidth;
  const cssHeight = bitmapHeight;

  // CSS transform handles visual zoom (both scaling up and down)
  const cssTransformScale = zoomScale / actualResolutionScale;
  const needsCssTransform = Math.abs(cssTransformScale - 1.0) > 0.001;

  // Only resize if dimensions actually changed significantly
  const bitmapChanged =
    Math.abs(dynamicCanvas.width - bitmapWidth) > 1 ||
    Math.abs(dynamicCanvas.height - bitmapHeight) > 1;
  const baseChanged = prevBaseWidth !== baseCanvasWidth || prevBaseHeight !== baseCanvasHeight;

  if (bitmapChanged || baseChanged) {
    // Resize full-resolution canvases (static, dynamic, media)
    const fullResCanvases = [dynamicCanvas, staticCanvas, mediaCanvas];
    fullResCanvases.forEach((cvs) => {
      cvs.width = bitmapWidth;
      cvs.height = bitmapHeight;
      cvs.style.width = `${cssWidth}px`;
      cvs.style.height = `${cssHeight}px`;
      // Apply CSS transform for visual zoom (both scaling up and down)
      cvs.style.transformOrigin = "top left";
      if (needsCssTransform) {
        cvs.style.transform = `scale(${cssTransformScale})`;
      } else {
        cvs.style.transform = "none";
      }
    });

    // Overlay canvas stays at base resolution (no zoom scaling) for memory efficiency
    // This canvas is used for cursor and highlights which don't need high resolution
    overlayCanvas.width = baseCanvasWidth;
    overlayCanvas.height = baseCanvasHeight;
    overlayCanvas.style.width = `${baseCanvasWidth}px`;
    overlayCanvas.style.height = `${baseCanvasHeight}px`;
    // Overlay uses CSS transform to match visual size of other canvases
    overlayCanvas.style.transformOrigin = "top left";
    overlayCanvas.style.transform = `scale(${zoomScale})`;

    // Set context transforms for resolution scaling on full-res canvases
    [staticCtx, dynamicCtx, mediaCtx].forEach((ctx) => {
      if (ctx) {
        ctx.setTransform(actualResolutionScale, 0, 0, actualResolutionScale, 0, 0);
      }
    });
    // Overlay context uses identity transform (no scaling)
    if (overlayCtx) {
      overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // Calculate visual size (what user sees after CSS transform)
    const visualWidth = Math.round(cssWidth * cssTransformScale);
    const visualHeight = Math.round(cssHeight * cssTransformScale);

    if (currentEditor) {
      currentEditor.style.minWidth = `${visualWidth}px`;
      currentEditor.style.minHeight = `${visualHeight}px`;
    }

    // Redraw both background and strokes after resize (canvas is cleared when dimensions change)
    redrawBackground();
    redrawCanvas();
    redrawMedia();

    // Re-apply stroke highlighting if active
    if (activeSearchQuery) {
      console.log("[NotebookEditor] Re-applying highlights after resize");
      highlightStrokes(activeSearchQuery);
    }
  }
}

/**
 * Check if media items exceed canvas bounds and expand if needed
 */
function checkAndExpandCanvasForMedia() {
  if (!mediaCanvas || mediaItems.length === 0) return;

  // Find the maximum extents of all media items
  let maxRight = 0;
  let maxBottom = 0;

  for (const item of mediaItems) {
    const right = item.x + item.width;
    const bottom = item.y + item.height;
    maxRight = Math.max(maxRight, right);
    maxBottom = Math.max(maxBottom, bottom);
  }

  // Add padding (100px) to avoid expanding too frequently
  const padding = 100;
  const requiredWidth = maxRight + padding;
  const requiredHeight = maxBottom + padding;

  // Check if expansion is needed
  const needsWidthExpansion = requiredWidth > mediaCanvas.width;
  const needsHeightExpansion = requiredHeight > mediaCanvas.height;

  if (needsWidthExpansion || needsHeightExpansion) {
    const newWidth = Math.max(mediaCanvas.width, requiredWidth);
    const newHeight = Math.max(mediaCanvas.height, requiredHeight);
    expandCanvasToSize(newWidth, newHeight);
  }
}

/**
 * Expand canvas to a specific width and height
 * @param {number} newWidth - Target width in pixels (in unscaled space)
 * @param {number} newHeight - Target height in pixels (in unscaled space)
 */
function expandCanvasToSize(newWidth, newHeight) {
  const fullResCanvases = [dynamicCanvas, staticCanvas, mediaCanvas];
  if (fullResCanvases.some((c) => !c) || !overlayCanvas) return;

  const now = Date.now();
  if (now - lastExpansionTime < expansionCooldown) return;
  lastExpansionTime = now;

  // Create offscreen canvases to preserve current drawings
  const tempCanvases = {
    dynamic: document.createElement("canvas"),
    static: document.createElement("canvas"),
    media: document.createElement("canvas"),
  };

  tempCanvases.dynamic.width =
    tempCanvases.static.width =
    tempCanvases.media.width =
      dynamicCanvas.width;
  tempCanvases.dynamic.height =
    tempCanvases.static.height =
    tempCanvases.media.height =
      dynamicCanvas.height;

  tempCanvases.dynamic.getContext("2d").drawImage(dynamicCanvas, 0, 0);
  tempCanvases.static.getContext("2d").drawImage(staticCanvas, 0, 0);
  tempCanvases.media.getContext("2d").drawImage(mediaCanvas, 0, 0);

  const oldHeight = dynamicCanvas.height;

  // Resize full-resolution canvases
  fullResCanvases.forEach((cvs) => {
    cvs.width = newWidth;
    cvs.height = newHeight;
    cvs.style.width = `${newWidth}px`;
    cvs.style.height = `${newHeight}px`;
  });

  // Resize overlay canvas (base resolution only)
  overlayCanvas.width = baseCanvasWidth;
  overlayCanvas.height = baseCanvasHeight;
  overlayCanvas.style.width = `${baseCanvasWidth}px`;
  overlayCanvas.style.height = `${baseCanvasHeight}px`;

  // Restore the content
  dynamicCtx.drawImage(tempCanvases.dynamic, 0, 0);
  staticCtx.drawImage(tempCanvases.static, 0, 0);
  mediaCtx.drawImage(tempCanvases.media, 0, 0);

  // Draw background expansion if height increased (background is now on staticCanvas)
  if (newHeight > oldHeight) {
    drawBackgroundExpansion(oldHeight, newHeight);
  }

  // Update content editable area size
  if (currentEditor) {
    currentEditor.style.minHeight = `${newHeight}px`;
  }

  console.log(`[Canvas] Expanded to ${newWidth}x${newHeight}`);
}

/**
 * Expand canvas height by a specified amount
 * @param {number} additionalHeight - Height to add in pixels (in unscaled space)
 */
function expandCanvas(additionalHeight) {
  const fullResCanvases = [dynamicCanvas, staticCanvas, mediaCanvas];
  if (fullResCanvases.some((c) => !c) || !overlayCanvas) return;

  const now = Date.now();
  if (now - lastExpansionTime < expansionCooldown) return;
  lastExpansionTime = now;

  const wrapper = dynamicCanvas.parentElement;
  const rect = wrapper.getBoundingClientRect();

  const newHeight = dynamicCanvas.height + additionalHeight;
  const newWidth = Math.max(dynamicCanvas.width, rect.width / zoomScale);

  // Create offscreen canvases to preserve current drawings
  const tempCanvases = {
    dynamic: document.createElement("canvas"),
    static: document.createElement("canvas"),
  };

  tempCanvases.dynamic.width = tempCanvases.static.width = dynamicCanvas.width;
  tempCanvases.dynamic.height = tempCanvases.static.height = dynamicCanvas.height;

  tempCanvases.dynamic.getContext("2d").drawImage(dynamicCanvas, 0, 0);
  tempCanvases.static.getContext("2d").drawImage(staticCanvas, 0, 0);

  const oldHeight = dynamicCanvas.height;

  // Resize full-resolution canvases
  fullResCanvases.forEach((cvs) => {
    cvs.width = newWidth;
    cvs.height = newHeight;
    cvs.style.width = `${newWidth}px`;
    cvs.style.height = `${newHeight}px`;
  });

  // Overlay canvas stays at base resolution
  overlayCanvas.width = baseCanvasWidth;
  overlayCanvas.height = baseCanvasHeight;

  // Restore the content without expensive redraw
  dynamicCtx.drawImage(tempCanvases.dynamic, 0, 0);
  staticCtx.drawImage(tempCanvases.static, 0, 0);

  // Draw background pattern on newly expanded area
  drawBackgroundExpansion(oldHeight, newHeight);

  if (currentEditor) {
    currentEditor.style.minHeight = `${newHeight}px`;
  }

  updateExpansionZoneIndicator(null, true);
}

/**
 * Update expansion zone visual indicator
 * @param {number|null} currentY - Current Y coordinate (null to hide)
 * @param {boolean} forceUpdate - Force update indicator position
 */
function updateExpansionZoneIndicator(currentY = null, forceUpdate = false) {
  if (!dynamicCanvas) return;
  let indicator = document.getElementById("expansion-zone-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "expansion-zone-indicator";
    indicator.className = "expansion-zone-indicator";
    dynamicCanvas.parentElement.appendChild(indicator);
  }
  const expansionThreshold = 300;
  const distanceFromBottom = dynamicCanvas.height - (currentY || 0);

  if ((currentY !== null && distanceFromBottom < expansionThreshold) || forceUpdate) {
    const triggerLine = dynamicCanvas.height - expansionThreshold;
    indicator.style.top = `${triggerLine}px`;
    indicator.style.display = "block";
    if (currentY !== null) {
      const opacity = Math.max(0.2, Math.min(0.6, 1 - distanceFromBottom / expansionThreshold));
      indicator.style.opacity = opacity;
    }
  } else if (currentY === null) {
    indicator.style.display = "none";
  }
}

/**
 * Handle pointer down for auto mode detection
 */
function handlePointerDown(e) {
  // In Image Mode: block all text editor interactions, handle only media
  if (isImageMode && !isDrawMode && (e.pointerType === "mouse" || e.pointerType === "touch")) {
    // Prevent text selection and editing
    e.preventDefault();
    e.stopPropagation();

    canvasRect = dynamicCanvas.getBoundingClientRect();
    const { x, y } = getCanvasCoordinates(e);

    // Check if clicking on media
    const clickedMedia = getMediaAtPoint(x, y);

    if (clickedMedia) {
      selectMedia(clickedMedia.id);

      // Check if clicking on a handle
      const handle = getMediaHandleAtPoint(x, y, clickedMedia);
      if (handle) {
        if (handle === "rotate") {
          // Start rotation operation
          const centerX = clickedMedia.x + clickedMedia.width / 2;
          const centerY = clickedMedia.y + clickedMedia.height / 2;
          const startAngle = Math.atan2(y - centerY, x - centerX);

          mediaTransformState = {
            mode: "rotate",
            startX: x,
            startY: y,
            centerX: centerX,
            centerY: centerY,
            startAngle: startAngle,
            initialRotation: clickedMedia.rotation || 0,
          };
        } else {
          // Start resize operation
          mediaTransformState = {
            mode: "resize",
            handle: handle,
            startX: x,
            startY: y,
            initialX: clickedMedia.x,
            initialY: clickedMedia.y,
            initialWidth: clickedMedia.width,
            initialHeight: clickedMedia.height,
            aspectRatio: clickedMedia.width / clickedMedia.height,
          };
        }

        e.preventDefault();
        e.stopPropagation();

        // Prevent scrolling on touch devices during media manipulation
        if (e.pointerType === "touch") {
          preventScrollDuringMediaManipulation(true);
          // Update canvasRect after changing overflow as it may shift viewport
          canvasRect = dynamicCanvas.getBoundingClientRect();
        }
        const captureTarget = currentEditor || e.target;
        if (captureTarget?.setPointerCapture) {
          try {
            captureTarget.setPointerCapture(e.pointerId);
          } catch (err) {
            console.warn("[Media] Could not set pointer capture:", err);
          }
        }

        return;
      } else {
        // Start move operation
        mediaTransformState = {
          mode: "move",
          startX: x,
          startY: y,
          initialX: clickedMedia.x,
          initialY: clickedMedia.y,
        };
        e.preventDefault();
        e.stopPropagation();

        // Prevent scrolling on touch devices during media manipulation
        if (e.pointerType === "touch") {
          preventScrollDuringMediaManipulation(true);
          // Update canvasRect after changing overflow as it may shift viewport
          canvasRect = dynamicCanvas.getBoundingClientRect();
        }
        const captureTarget = currentEditor || e.target;
        if (captureTarget?.setPointerCapture) {
          try {
            captureTarget.setPointerCapture(e.pointerId);
          } catch (err) {
            console.warn("[Media] Could not set pointer capture:", err);
          }
        }

        return;
      }
    } else {
      if (selectedMediaId) {
        // Clicked outside media, deselect
        selectMedia(null);
      }
      if (e.pointerType === "touch") {
        const wrapper = document.querySelector(".editor-content-wrapper");
        if (wrapper) {
          mediaPanState = {
            startX: e.clientX,
            startY: e.clientY,
            scrollLeft: wrapper.scrollLeft,
            scrollTop: wrapper.scrollTop,
          };
        }
        e.preventDefault();
        e.stopPropagation();
        const captureTarget = currentEditor || e.target;
        if (captureTarget?.setPointerCapture) {
          try {
            captureTarget.setPointerCapture(e.pointerId);
          } catch (err) {
            console.warn("[Media] Could not set pointer capture:", err);
          }
        }
      }
    }

    // Always return early in Image Mode to prevent text editing
    return;
  }

  if (e.pointerType === "pen") {
    if (!isDrawMode && !isEraserMode && !isLassoMode) {
      switchToDrawMode();
      autoSwitchedToDrawMode = true;
    }

    // Manually trigger canvas drawing since the event was on the text editor
    // This ensures drawing works even when scrolled
    if (dynamicCanvas && isDrawMode) {
      // Set pointer capture on canvas to ensure we get all subsequent events
      try {
        dynamicCanvas.setPointerCapture(e.pointerId);
      } catch (err) {
        console.warn("Could not set pointer capture:", err);
      }

      const canvasEvent = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerType: e.pointerType,
        clientX: e.clientX,
        clientY: e.clientY,
        pressure: e.pressure,
        pointerId: e.pointerId,
        buttons: e.buttons,
        button: e.button,
      });
      dynamicCanvas.dispatchEvent(canvasEvent);
    }

    e.preventDefault();
    e.stopPropagation();
  } else if (e.pointerType === "touch" && autoSwitchedToDrawMode) {
    if (isDrawMode) {
      switchToTextMode();
    }
  }
}

/**
 * Handle pointer move
 */
function handlePointerMove(e) {
  // Handle media transformation (move/resize/rotate) - only in Image Mode
  if (
    mediaTransformState &&
    isImageMode &&
    (e.pointerType === "mouse" || e.pointerType === "touch")
  ) {
    // Update canvasRect on every move to handle viewport changes
    canvasRect = dynamicCanvas.getBoundingClientRect();
    const { x, y } = getCanvasCoordinates(e);
    const selected = getSelectedMedia();
    if (!selected) {
      mediaTransformState = null;
      return;
    }

    if (mediaTransformState.mode === "move") {
      // Update position
      const dx = x - mediaTransformState.startX;
      const dy = y - mediaTransformState.startY;
      selected.x = mediaTransformState.initialX + dx;
      selected.y = mediaTransformState.initialY + dy;
    } else if (mediaTransformState.mode === "rotate") {
      // Calculate rotation angle
      const currentAngle = Math.atan2(
        y - mediaTransformState.centerY,
        x - mediaTransformState.centerX,
      );
      const angleDiff = currentAngle - mediaTransformState.startAngle;
      const angleDegrees = (angleDiff * 180) / Math.PI;

      // Update rotation (keep between 0-360)
      let newRotation = mediaTransformState.initialRotation + angleDegrees;
      newRotation = ((newRotation % 360) + 360) % 360; // Normalize to 0-360
      selected.rotation = newRotation;
    } else if (mediaTransformState.mode === "resize") {
      // Calculate new size based on handle, accounting for rotation
      const dx = x - mediaTransformState.startX;
      const dy = y - mediaTransformState.startY;
      const handle = mediaTransformState.handle;

      // Get rotation angle in radians
      const rotation = ((selected.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(-rotation); // Negative to transform back to unrotated space
      const sin = Math.sin(-rotation);

      // Transform mouse delta into rotated coordinate space
      const rotatedDx = dx * cos - dy * sin;
      const rotatedDy = dx * sin + dy * cos;

      let newWidth = mediaTransformState.initialWidth;
      let newHeight = mediaTransformState.initialHeight;
      let newX = mediaTransformState.initialX;
      let newY = mediaTransformState.initialY;

      // Calculate based on which handle is being dragged (in rotated space)
      // Free resize - width and height can be adjusted independently
      if (handle === "se") {
        // Southeast (bottom-right) - increase width right, height down
        newWidth = mediaTransformState.initialWidth + rotatedDx;
        newHeight = mediaTransformState.initialHeight + rotatedDy;
      } else if (handle === "nw") {
        // Northwest (top-left) - decrease width left, height up
        newWidth = mediaTransformState.initialWidth - rotatedDx;
        newHeight = mediaTransformState.initialHeight - rotatedDy;
        // Transform position change back to screen space
        const centerX = mediaTransformState.initialX + mediaTransformState.initialWidth / 2;
        const centerY = mediaTransformState.initialY + mediaTransformState.initialHeight / 2;
        const newCenterX = centerX;
        const newCenterY = centerY;
        newX = newCenterX - newWidth / 2;
        newY = newCenterY - newHeight / 2;
      } else if (handle === "ne") {
        // Northeast (top-right) - increase width right, decrease height up
        newWidth = mediaTransformState.initialWidth + rotatedDx;
        newHeight = mediaTransformState.initialHeight - rotatedDy;
        // Keep bottom-left corner fixed
        const centerX = mediaTransformState.initialX + mediaTransformState.initialWidth / 2;
        const centerY = mediaTransformState.initialY + mediaTransformState.initialHeight / 2;
        newX = centerX - newWidth / 2;
        newY = centerY - newHeight / 2;
      } else if (handle === "sw") {
        // Southwest (bottom-left) - decrease width left, increase height down
        newWidth = mediaTransformState.initialWidth - rotatedDx;
        newHeight = mediaTransformState.initialHeight + rotatedDy;
        // Keep top-right corner fixed
        const centerX = mediaTransformState.initialX + mediaTransformState.initialWidth / 2;
        const centerY = mediaTransformState.initialY + mediaTransformState.initialHeight / 2;
        newX = centerX - newWidth / 2;
        newY = centerY - newHeight / 2;
      }

      // Apply minimum size constraint
      const minSize = 50;
      if (newWidth >= minSize && newHeight >= minSize) {
        selected.width = newWidth;
        selected.height = newHeight;
        selected.x = newX;
        selected.y = newY;
      }
    }

    // Redraw with updated position/size
    redrawMedia();
    markNoteEdited();
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  if (mediaPanState && isImageMode && e.pointerType === "touch" && !mediaTransformState) {
    const wrapper = document.querySelector(".editor-content-wrapper");
    if (wrapper) {
      const dx = e.clientX - mediaPanState.startX;
      const dy = e.clientY - mediaPanState.startY;
      wrapper.scrollLeft = mediaPanState.scrollLeft - dx;
      wrapper.scrollTop = mediaPanState.scrollTop - dy;
    }
    e.preventDefault();
    e.stopPropagation();
    return;
  }

  // Update cursor when hovering over media (but not transforming) - only in Image Mode
  if (!isDrawMode && isImageMode && (e.pointerType === "mouse" || e.pointerType === "touch")) {
    const { x, y } = getCanvasCoordinates(e);
    updateMediaCursor(x, y);
  }

  if (e.pointerType === "pen") {
    if (!isDrawMode && !isEraserMode && !isLassoMode) {
      switchToDrawMode();
      autoSwitchedToDrawMode = true;
      updateModeIndicator();
    }

    // Forward move events to canvas when in draw mode
    if (dynamicCanvas && isDrawMode) {
      const canvasEvent = new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerType: e.pointerType,
        clientX: e.clientX,
        clientY: e.clientY,
        pressure: e.pressure,
        pointerId: e.pointerId,
        buttons: e.buttons,
        button: e.button,
      });
      dynamicCanvas.dispatchEvent(canvasEvent);
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

/**
 * Handle pointer up
 */
function handlePointerUp(e) {
  // Handle media transformation end - only in Image Mode
  if (
    mediaTransformState &&
    isImageMode &&
    (e.pointerType === "mouse" || e.pointerType === "touch")
  ) {
    mediaTransformState = null;

    // Check if canvas needs expansion after transformation
    checkAndExpandCanvasForMedia();

    // Re-enable scrolling on touch devices
    if (e.pointerType === "touch") {
      preventScrollDuringMediaManipulation(false);
    }
    const captureTarget = currentEditor || e.target;
    if (captureTarget?.releasePointerCapture) {
      try {
        captureTarget.releasePointerCapture(e.pointerId);
      } catch (err) {
        console.warn("[Media] Could not release pointer capture:", err);
      }
    }

    scheduleSave();
    return;
  }

  if (mediaPanState && isImageMode && e.pointerType === "touch") {
    mediaPanState = null;
    const captureTarget = currentEditor || e.target;
    if (captureTarget?.releasePointerCapture) {
      try {
        captureTarget.releasePointerCapture(e.pointerId);
      } catch (err) {
        console.warn("[Media] Could not release pointer capture:", err);
      }
    }
    return;
  }

  // Forward up events to canvas when in draw mode
  if (e.pointerType === "pen" && dynamicCanvas && isDrawMode) {
    const canvasEvent = new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerType: e.pointerType,
      clientX: e.clientX,
      clientY: e.clientY,
      pressure: e.pressure,
      pointerId: e.pointerId,
      buttons: e.buttons,
      button: e.button,
    });
    dynamicCanvas.dispatchEvent(canvasEvent);
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * Get correct canvas coordinates accounting for scroll and zoom
 */
function getCanvasCoordinates(e) {
  if (!canvasRect) {
    // Fallback if pointerdown was missed or rect is stale
    canvasRect = dynamicCanvas.getBoundingClientRect();
  }

  let clientX = e.clientX;
  let clientY = e.clientY;

  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  }

  // Get position relative to canvas CSS bounding box
  const screenX = clientX - canvasRect.left;
  const screenY = clientY - canvasRect.top;

  // Convert screen coordinates to base coordinates
  // CSS size = baseCanvasWidth * zoomScale, so base = screen / zoomScale
  // The context transform handles scaling from base to bitmap coordinates
  const x = screenX / zoomScale;
  const y = screenY / zoomScale;

  return { x, y };
}

function isEraserEvent(e) {
  // 1. Check for dedicated eraser pointer type
  if (e.pointerType === "eraser") {
    return true;
  }
  // 2. For pens, check for eraser button states
  if (e.pointerType === "pen") {
    // The `buttons` property is a bitmask. The value 2 represents the secondary
    // (barrel) button. This is the most reliable check for S Pen and other active styluses.
    if ((e.buttons & 2) === 2) {
      return true;
    }
    // As a fallback for some devices, check the `button` property on down events.
    if (e.type === "pointerdown" && e.button === 2) {
      return true;
    }
  }
  return false;
}

/**
 * Handle canvas pointer down
 * @returns {boolean} false if mode was switched to text (touch after auto-switch), true otherwise
 */
function handleCanvasPointerDown(e) {
  if (e.pointerType === "pen" || e.pointerType === "eraser") {
    if (!isDrawMode && !isEraserMode && !isLassoMode) {
      switchToDrawMode();
      autoSwitchedToDrawMode = true;
    }
  }

  if (e.pointerType === "touch" && autoSwitchedToDrawMode && !isDrawing && !isErasing) {
    switchToTextMode();
    e.stopPropagation();
    e.preventDefault();
    return false;
  }

  // --- Cache canvas rect and coordinates ---
  canvasRect = dynamicCanvas.getBoundingClientRect();
  const { x, y } = getCanvasCoordinates(e);

  console.log("[Media] handleCanvasPointerDown - isDrawMode:", isDrawMode, "coords:", x, y);

  // --- Media interaction (only in Image Mode) ---
  if (!isDrawMode && isImageMode) {
    // Check if clicking on media
    const clickedMedia = getMediaAtPoint(x, y);

    if (clickedMedia) {
      // In Image Mode: immediate selection and manipulation
      selectMedia(clickedMedia.id);

      // Check if clicking on a resize/rotate handle
      const handle = getMediaHandleAtPoint(x, y, clickedMedia);
      if (handle === "rotate") {
        const centerX = clickedMedia.x + clickedMedia.width / 2;
        const centerY = clickedMedia.y + clickedMedia.height / 2;
        const startAngle = Math.atan2(y - centerY, x - centerX);

        mediaTransformState = {
          mode: "rotate",
          startX: x,
          startY: y,
          centerX: centerX,
          centerY: centerY,
          startAngle: startAngle,
          initialRotation: clickedMedia.rotation || 0,
        };
        e.preventDefault();
        return false;
      } else if (handle) {
        // Start resize operation
        mediaTransformState = {
          mode: "resize",
          handle: handle,
          startX: x,
          startY: y,
          initialX: clickedMedia.x,
          initialY: clickedMedia.y,
          initialWidth: clickedMedia.width,
          initialHeight: clickedMedia.height,
          aspectRatio: clickedMedia.width / clickedMedia.height,
        };
        e.preventDefault();
        return false;
      } else {
        // Start move operation
        mediaTransformState = {
          mode: "move",
          startX: x,
          startY: y,
          initialX: clickedMedia.x,
          initialY: clickedMedia.y,
        };
        e.preventDefault();
        return false;
      }
    } else {
      // Clicked outside media
      if (selectedMediaId) {
        // Deselect media
        selectMedia(null);
      }
    }

    return true;
  }

  // --- Draw mode handling ---
  const palette = getThemePalette();

  // --- Eraser Activation (Stateful approach) ---
  const isEraser = isEraserMode || isEraserEvent(e);

  if (isLassoMode) {
    // Check for transformation handles first
    if (selectionBounds) {
      const handle = getHandleAtPoint(x, y);
      if (handle) {
        if (handle === "copy") {
          copySelectedStrokes();
          return true;
        }
        isTransforming = true;
        transformMode = handle;
        transformStartPoint = { x, y };
        initialSelectionBounds = { ...selectionBounds };
        initialStrokesData = Array.from(selectedStrokes).map((idx) => ({
          index: idx,
          x: [...strokes[idx].x],
          y: [...strokes[idx].y],
        }));
        return true;
      }
    }

    isLassoing = true;
    isDrawing = false;
    isErasing = false;
    lassoPoints = [];
    selectedStrokes.clear();
    selectionBounds = null;
    const deleteBtn = document.getElementById("delete-selection-btn");
    if (deleteBtn) deleteBtn.style.display = "none";
    // Clear any previous selection visual
    redrawCanvas();
  } else if (isEraser) {
    // Set the state for the duration of this interaction
    isErasing = true;
    isDrawing = false;

    // Activate UI feedback if not already manually in eraser mode
    if (!isEraserMode) {
      isEraserMode = true;
      autoActivatedEraserMode = true;
      updateToolbarButtons();
    }
  } else {
    isErasing = false;
    isDrawing = true;
    needsCanvasExpansion = false; // Reset expansion flag at the start of a stroke
    currentStroke = [];
    dynamicStrokeLastDrawIndex = 0;
    dynamicStrokeLastY = null;
    dynamicStrokeDrawScheduled = false;

    // Clear selection when starting a new drawing
    if (selectedStrokes.size > 0) {
      selectedStrokes.clear();
      const deleteBtn = document.getElementById("delete-selection-btn");
      if (deleteBtn) deleteBtn.style.display = "none";
      redrawCanvas();
    }
  }
  // --- END ERASER LOGIC ---

  if (isErasing) {
    eraseStrokesAtPoint(x, y);
    drawEraserCursor(x, y);
  } else if (isDrawing) {
    // Start drawing
    currentStroke = {
      id: generateId(), // Unique ID for stroke deletion tracking
      pointerType: e.pointerType,
      x: [x],
      y: [y],
      pressure: [e.pressure || 0.5],
      time: [Date.now()],
      colorIndex: currentPenColorIndex,
      width: currentPenWidth,
    };

    // Set context properties once per stroke
    dynamicCtx.strokeStyle = palette[currentStroke.colorIndex] || palette[0];
    dynamicCtx.lineWidth = currentStroke.width || 2;
    dynamicCtx.lineCap = "round";
    dynamicCtx.lineJoin = "round";
    // Clear dynamic layer once per stroke instead of on every move.
    clearCanvas(dynamicCtx, dynamicCanvas);
  }
  return true;
}

/**
 * Draw only the new stroke segments since the last frame.
 */
function drawDynamicStrokeSegments() {
  dynamicStrokeDrawScheduled = false;

  if (!isDrawing || !currentStroke?.x || !dynamicCtx) return;

  const len = currentStroke.x.length;
  const startIndex = Math.max(1, dynamicStrokeLastDrawIndex + 1);
  if (startIndex >= len) {
    if (dynamicStrokeLastY !== null) {
      updateExpansionZoneIndicator(dynamicStrokeLastY);
    }
    return;
  }

  dynamicCtx.beginPath();
  dynamicCtx.moveTo(currentStroke.x[startIndex - 1], currentStroke.y[startIndex - 1]);
  for (let i = startIndex; i < len; i++) {
    dynamicCtx.lineTo(currentStroke.x[i], currentStroke.y[i]);
  }
  dynamicCtx.stroke();

  dynamicStrokeLastDrawIndex = len - 1;
  if (dynamicStrokeLastY !== null) {
    updateExpansionZoneIndicator(dynamicStrokeLastY);
  }
}

function scheduleDynamicStrokeDraw() {
  if (dynamicStrokeDrawScheduled) return;
  dynamicStrokeDrawScheduled = true;
  requestAnimationFrame(drawDynamicStrokeSegments);
}

/**
 * Handle canvas pointer move
 */
function handleCanvasPointerMove(e) {
  // Handle media transformation (move/resize) - only in Image Mode
  if (mediaTransformState && isImageMode) {
    // Update canvasRect on every move to handle viewport changes
    canvasRect = dynamicCanvas.getBoundingClientRect();
    const { x, y } = getCanvasCoordinates(e);
    const selected = getSelectedMedia();
    if (!selected) {
      mediaTransformState = null;
      return;
    }

    if (mediaTransformState.mode === "move") {
      // Update position
      const dx = x - mediaTransformState.startX;
      const dy = y - mediaTransformState.startY;
      selected.x = mediaTransformState.initialX + dx;
      selected.y = mediaTransformState.initialY + dy;
    } else if (mediaTransformState.mode === "resize") {
      // Calculate new size based on handle, accounting for rotation
      const dx = x - mediaTransformState.startX;
      const dy = y - mediaTransformState.startY;
      const handle = mediaTransformState.handle;

      // Get rotation angle in radians
      const rotation = ((selected.rotation || 0) * Math.PI) / 180;
      const cos = Math.cos(-rotation); // Negative to transform back to unrotated space
      const sin = Math.sin(-rotation);

      // Transform mouse delta into rotated coordinate space
      const rotatedDx = dx * cos - dy * sin;
      const rotatedDy = dx * sin + dy * cos;

      let newWidth = mediaTransformState.initialWidth;
      let newHeight = mediaTransformState.initialHeight;
      let newX = mediaTransformState.initialX;
      let newY = mediaTransformState.initialY;

      // Calculate based on which handle is being dragged (in rotated space)
      // Free resize - width and height can be adjusted independently
      if (handle === "se") {
        // Southeast (bottom-right) - increase width right, height down
        newWidth = mediaTransformState.initialWidth + rotatedDx;
        newHeight = mediaTransformState.initialHeight + rotatedDy;
      } else if (handle === "nw") {
        // Northwest (top-left) - decrease width left, height up
        newWidth = mediaTransformState.initialWidth - rotatedDx;
        newHeight = mediaTransformState.initialHeight - rotatedDy;
        // Transform position change back to screen space
        const centerX = mediaTransformState.initialX + mediaTransformState.initialWidth / 2;
        const centerY = mediaTransformState.initialY + mediaTransformState.initialHeight / 2;
        const newCenterX = centerX;
        const newCenterY = centerY;
        newX = newCenterX - newWidth / 2;
        newY = newCenterY - newHeight / 2;
      } else if (handle === "ne") {
        // Northeast (top-right) - increase width right, decrease height up
        newWidth = mediaTransformState.initialWidth + rotatedDx;
        newHeight = mediaTransformState.initialHeight - rotatedDy;
        // Keep bottom-left corner fixed
        const centerX = mediaTransformState.initialX + mediaTransformState.initialWidth / 2;
        const centerY = mediaTransformState.initialY + mediaTransformState.initialHeight / 2;
        newX = centerX - newWidth / 2;
        newY = centerY - newHeight / 2;
      } else if (handle === "sw") {
        // Southwest (bottom-left) - decrease width left, increase height down
        newWidth = mediaTransformState.initialWidth - rotatedDx;
        newHeight = mediaTransformState.initialHeight + rotatedDy;
        // Keep top-right corner fixed
        const centerX = mediaTransformState.initialX + mediaTransformState.initialWidth / 2;
        const centerY = mediaTransformState.initialY + mediaTransformState.initialHeight / 2;
        newX = centerX - newWidth / 2;
        newY = centerY - newHeight / 2;
      }

      // Apply minimum size constraint
      const minSize = 50;
      if (newWidth >= minSize && newHeight >= minSize) {
        selected.width = newWidth;
        selected.height = newHeight;
        selected.x = newX;
        selected.y = newY;
      }
    }

    // Redraw with updated position/size
    redrawMedia();
    markNoteEdited();
    return;
  }

  if (!isDrawMode || (!isDrawing && !isErasing && !isLassoing && !isTransforming)) {
    return;
  }

  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const lastEvent = events[events.length - 1];
  const { x, y } = getCanvasCoordinates(lastEvent);

  if (isTransforming) {
    const dx = x - transformStartPoint.x;
    const dy = y - transformStartPoint.y;

    if (transformMode === "move") {
      initialStrokesData.forEach((data) => {
        strokes[data.index].x = data.x.map((px) => px + dx);
        strokes[data.index].y = data.y.map((py) => py + dy);
      });
    } else if (transformMode === "resize") {
      // Scale from Top-Right fixed point (maxX, minY) since handle is at LL (minX, maxY)
      const scaleX =
        initialSelectionBounds.width === 0
          ? 1
          : (initialSelectionBounds.maxX - x) / initialSelectionBounds.width;
      const scaleY =
        initialSelectionBounds.height === 0
          ? 1
          : (y - initialSelectionBounds.minY) / initialSelectionBounds.height;

      initialStrokesData.forEach((data) => {
        strokes[data.index].x = data.x.map(
          (px) => initialSelectionBounds.maxX - (initialSelectionBounds.maxX - px) * scaleX,
        );
        strokes[data.index].y = data.y.map(
          (py) => initialSelectionBounds.minY + (py - initialSelectionBounds.minY) * scaleY,
        );
      });
    } else if (transformMode === "rotate") {
      const centerX = (initialSelectionBounds.minX + initialSelectionBounds.maxX) / 2;
      const centerY = (initialSelectionBounds.minY + initialSelectionBounds.maxY) / 2;
      const angle1 = Math.atan2(transformStartPoint.y - centerY, transformStartPoint.x - centerX);
      const angle2 = Math.atan2(y - centerY, x - centerX);
      const da = angle2 - angle1;
      const cos = Math.cos(da);
      const sin = Math.sin(da);

      initialStrokesData.forEach((data) => {
        strokes[data.index].x = data.x.map((px, i) => {
          const py = data.y[i];
          const rx = px - centerX;
          const ry = py - centerY;
          return centerX + rx * cos - ry * sin;
        });
        strokes[data.index].y = data.y.map((py, i) => {
          const px = data.x[i];
          const rx = px - centerX;
          const ry = py - centerY;
          return centerY + rx * sin + ry * cos;
        });
      });
    }

    calculateSelectionBounds();
    redrawCanvas(); // This is slow but not part of the current refactor focus
    return;
  }

  if (isLassoing) {
    lassoPoints.push({ x, y });
    drawLassoPath();
  } else if (isErasing) {
    eraseStrokesAtPoint(x, y);
    drawEraserCursor(x, y);
  } else if (isDrawing && currentStroke.x) {
    for (const event of events) {
      const { x: eventX, y: eventY } = getCanvasCoordinates(event);
      currentStroke.x.push(eventX);
      currentStroke.y.push(eventY);
      currentStroke.pressure.push(event.pressure || 0.5);
      currentStroke.time.push(Date.now());
    }

    // Defer canvas expansion to pointerup to avoid stuttering
    if (dynamicCanvas.height - y < 300) {
      needsCanvasExpansion = true;
    }
    dynamicStrokeLastY = y;
    scheduleDynamicStrokeDraw();
  }
}

/**
 * Draw the lasso path on the overlay canvas
 */
function drawLassoPath() {
  if (!overlayCtx || lassoPoints.length < 2) return;

  clearCanvas(overlayCtx, overlayCanvas);
  overlayCtx.strokeStyle = "rgba(0, 100, 255, 0.8)";
  overlayCtx.lineWidth = 2;
  overlayCtx.setLineDash([5, 5]); // Dashed line for selection
  overlayCtx.beginPath();
  overlayCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);

  for (let i = 1; i < lassoPoints.length; i++) {
    overlayCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
  }

  overlayCtx.stroke();
  overlayCtx.setLineDash([]); // Reset line dash
}

/**
 * Handle canvas pointer up
 */
function handleCanvasPointerUp(e) {
  // Handle media transformation end
  if (mediaTransformState) {
    mediaTransformState = null;

    // Check if canvas needs expansion after transformation
    checkAndExpandCanvasForMedia();

    // Re-enable scrolling on touch devices
    if (e.pointerType === "touch") {
      preventScrollDuringMediaManipulation(false);
    }

    scheduleSave();
    return;
  }

  if (isTransforming) {
    isTransforming = false;
    transformMode = null;
    initialStrokesData = [];
    markNoteEdited();
    scheduleSave();
    return;
  }

  // Deactivate auto-activated eraser mode on pointer up
  if (autoActivatedEraserMode) {
    isEraserMode = false;
    autoActivatedEraserMode = false;
    updateToolbarButtons();
  }

  // Clear the overlay canvas of any transient indicators like the eraser cursor
  if (overlayCtx) {
    clearCanvas(overlayCtx, overlayCanvas);
  }

  const wasLassoing = isLassoing;
  isLassoing = false;

  if (wasLassoing && lassoPoints.length > 2) {
    // Finalize lasso selection
    const polygon = lassoPoints;
    selectedStrokes.clear();

    // Pre-calculate lasso bounding box for efficiency
    const lassoBounds = getStrokeBounds({ x: polygon.map((p) => p.x), y: polygon.map((p) => p.y) });

    strokes.forEach((stroke, index) => {
      const strokeBounds = getStrokeBounds(stroke);

      if (doBoundingBoxesIntersect(lassoBounds, strokeBounds)) {
        // Check if all points of the stroke are inside the polygon
        let allPointsInside = true;
        for (let i = 0; i < stroke.x.length; i++) {
          if (!isPointInPolygon(stroke.x[i], stroke.y[i], polygon)) {
            allPointsInside = false;
            break;
          }
        }
        if (allPointsInside) {
          selectedStrokes.add(index);
        }
      }
    });

    lassoPoints = [];
    calculateSelectionBounds();
    redrawCanvas(); // Redraw to show selection highlights

    // show delete button
    const deleteBtn = document.getElementById("delete-selection-btn");
    if (deleteBtn) {
      deleteBtn.style.display = selectedStrokes.size > 0 ? "block" : "none";
    }
  }

  // Reset drawing/erasing state
  const wasErasing = isErasing;
  isErasing = false;
  const wasDrawing = isDrawing;
  isDrawing = false;

  // Save if an action was completed
  if (wasErasing || (wasDrawing && currentStroke.x && currentStroke.x.length > 1)) {
    if (wasDrawing) {
      // Commit the completed stroke to the static canvas
      const palette = getThemePalette();
      sharedDrawStroke(staticCtx, currentStroke, palette, false);

      // Clear the dynamic canvas
      clearCanvas(dynamicCtx, dynamicCanvas);

      strokes.push({ ...currentStroke });
      currentStroke = [];
      updateExpansionZoneIndicator(null);
      updateContentBounds();

      // Perform canvas expansion now if it was needed
      if (needsCanvasExpansion) {
        expandCanvas(800);
        needsCanvasExpansion = false;
      }
    }

    markNoteEdited();
    scheduleSave();
  } else if (wasDrawing) {
    // Stroke was too short (a tap), clear the dynamic canvas
    clearCanvas(dynamicCtx, dynamicCanvas);
    currentStroke = [];
  }

  // Reset dynamic stroke drawing state
  dynamicStrokeDrawScheduled = false;
  dynamicStrokeLastDrawIndex = 0;
  dynamicStrokeLastY = null;

  // Only refresh if user has stopped all interactions AND note has no unsaved changes
  if (
    pendingExternalRefresh &&
    !isDrawing &&
    !isErasing &&
    !isLassoing &&
    !isTransforming &&
    !noteEditedSinceOpen
  ) {
    pendingExternalRefresh = false;
    const noteId = getCurrentNoteId();
    if (noteId && currentNoteData && noteId === currentNoteData.id) {
      updateEditorContent(noteId).catch((err) => console.error("Deferred refresh failed:", err));
    }
  }
}

/**
 * Calculate the bounding box of all selected strokes
 */
function calculateSelectionBounds() {
  if (selectedStrokes.size === 0) {
    selectionBounds = null;
    return;
  }

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  let hasValidStroke = false;

  selectedStrokes.forEach((index) => {
    const stroke = strokes[index];
    const bounds = getStrokeBounds(stroke);
    if (bounds) {
      minX = Math.min(minX, bounds.minX);
      maxX = Math.max(maxX, bounds.maxX);
      minY = Math.min(minY, bounds.minY);
      maxY = Math.max(maxY, bounds.maxY);
      hasValidStroke = true;
    }
  });

  if (!hasValidStroke) {
    selectionBounds = null;
    return;
  }

  selectionBounds = { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Check if a point is over a selection handle
 * @returns {string|null} Handle name or null
 */
function getHandleAtPoint(x, y) {
  if (!selectionBounds) return null;
  const { minX, minY, maxX, maxY } = selectionBounds;
  const h = handleSize / 2;

  if (x >= minX - h && x <= minX + h && y >= minY - h && y <= minY + h) return "rotate";
  if (x >= maxX - h && x <= maxX + h && y >= minY - h && y <= minY + h) return "copy";
  if (x >= maxX - h && x <= maxX + h && y >= maxY - h && y <= maxY + h) return "move";
  if (x >= minX - h && x <= minX + h && y >= maxY - h && y <= maxY + h) return "resize";

  return null;
}

/**
 * Check if a point is inside a polygon using the ray-casting algorithm
 * @param {number} px - Point x
 * @param {number} py - Point y
 * @param {Array<Object>} polygon - Array of {x, y} points
 * @returns {boolean} True if the point is inside
 */
function isPointInPolygon(px, py, polygon) {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;

    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

/**
 * Check if two bounding boxes intersect
 * @param {Object} box1 - { minX, minY, maxX, maxY }
 * @param {Object} box2 - { minX, minY, maxX, maxY }
 * @returns {boolean} True if they intersect
 */
function doBoundingBoxesIntersect(box1, box2) {
  if (!box1 || !box2) return false;
  return (
    box1.minX <= box2.maxX &&
    box1.maxX >= box2.minX &&
    box1.minY <= box2.maxY &&
    box1.maxY >= box2.minY
  );
}

/**
 * Calculate the bounding box of a stroke
 * @param {Object} stroke - Stroke object
 * @returns {Object|null} Bounding box { minX, minY, maxX, maxY } or null
 */
function getStrokeBounds(stroke) {
  if (!stroke || !stroke.x || stroke.x.length === 0) return null;

  let minX = stroke.x[0],
    maxX = stroke.x[0];
  let minY = stroke.y[0],
    maxY = stroke.y[0];

  for (let i = 1; i < stroke.x.length; i++) {
    minX = Math.min(minX, stroke.x[i]);
    maxX = Math.max(maxX, stroke.x[i]);
    minY = Math.min(minY, stroke.y[i]);
    maxY = Math.max(maxY, stroke.y[i]);
  }

  // Add padding for line width
  const padding = (stroke.width || 2) / 2;
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
}

/**
 * Draw background pattern on background canvas (internal helper)
 * @param {string} backgroundType - Type of background pattern
 * @param {number} startY - Starting Y coordinate (for partial redraws)
 * @param {number} endY - Ending Y coordinate (for partial redraws)
 */
function drawBackgroundPattern(backgroundType, startY = 0, endY = null) {
  if (!staticCtx || !staticCanvas || backgroundType === "none") return;

  // Use BASE dimensions, not bitmap dimensions, because context transform handles scaling
  // The context has a transform applied (resolutionScale) that scales drawing operations
  const height = endY || baseCanvasHeight;
  const width = baseCanvasWidth;

  // Background pattern is now drawn on staticCanvas (merged for memory efficiency)
  sharedDrawBackgroundPattern(staticCtx, backgroundType, width, height, startY);
}

/**
 * Redraw entire background on static canvas
 * Since background and strokes share staticCanvas, this redraws everything
 */
function redrawBackground() {
  // Background is now on staticCanvas with strokes, so redraw both together
  redrawCanvas();
}

/**
 * Draw background pattern only on newly expanded area (for performance)
 * @param {number} oldHeight - Previous canvas height
 * @param {number} newHeight - New canvas height
 */
function drawBackgroundExpansion(oldHeight, newHeight) {
  if (!currentNoteData || !currentNoteData.background || currentNoteData.background === "none")
    return;
  drawBackgroundPattern(currentNoteData.background, oldHeight, newHeight);
}

/**
 * Redraws all completed strokes onto the static canvas.
 * This should be called on zoom, pan, resize, or when the underlying data changes.
 */
function redrawCanvas() {
  if (!staticCtx || !staticCanvas) return;

  // Clear both canvases
  clearCanvas(staticCtx, staticCanvas);
  if (dynamicCtx) {
    clearCanvas(dynamicCtx, dynamicCanvas);
  }

  // Draw background pattern first (background is now merged into staticCanvas)
  if (currentNoteData?.background && currentNoteData.background !== "none") {
    drawBackgroundPattern(currentNoteData.background);
  }

  // Draw all completed strokes to the static canvas
  const palette = getThemePalette();
  strokes.forEach((stroke, index) => {
    const isSelected = selectedStrokes.has(index);
    sharedDrawStroke(staticCtx, stroke, palette, isSelected);
  });

  // Draw selection UI on top of the static canvas
  if (selectionBounds && !isLassoing) {
    const { minX, minY, maxX, maxY } = selectionBounds;

    staticCtx.save();
    staticCtx.strokeStyle = "rgba(0, 100, 255, 0.5)";
    staticCtx.setLineDash([5, 5]);
    staticCtx.lineWidth = 1;
    staticCtx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    staticCtx.setLineDash([]);

    // Draw handles
    const h = handleSize;
    const drawHandle = (hx, hy, label) => {
      staticCtx.fillStyle = "white";
      staticCtx.strokeStyle = "rgba(0, 100, 255, 0.8)";
      staticCtx.lineWidth = 2;
      staticCtx.beginPath();
      staticCtx.rect(hx - h / 2, hy - h / 2, h, h);
      staticCtx.fill();
      staticCtx.stroke();

      staticCtx.fillStyle = "rgba(0, 100, 255, 0.8)";
      staticCtx.font = "bold 12px sans-serif";
      staticCtx.textAlign = "center";
      staticCtx.textBaseline = "middle";
      staticCtx.fillText(label, hx, hy);
    };

    drawHandle(minX, minY, "R"); // Rotate
    drawHandle(maxX, minY, "C"); // Copy
    drawHandle(maxX, maxY, "M"); // Move
    drawHandle(minX, maxY, "S"); // Size

    staticCtx.restore();
  }
}

/**
 * Check if a point is near a line segment
 * @param {number} px - Point x
 * @param {number} py - Point y
 * @param {number} x1 - Line start x
 * @param {number} y1 - Line start y
 * @param {number} x2 - Line end x
 * @param {number} y2 - Line end y
 * @param {number} threshold - Distance threshold
 * @returns {boolean} True if point is within threshold distance
 */
function isPointNearLine(px, py, x1, y1, x2, y2, threshold) {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  if (lenSq !== 0) {
    param = dot / lenSq;
  }
  let xx, yy;
  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }
  const dx = px - xx;
  const dy = py - yy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return distance <= threshold;
}

/**
 * Redraw all media items on the media canvas
 */
function redrawMedia() {
  if (!mediaCtx || !mediaCanvas) return;

  // Clear the media canvas
  clearCanvas(mediaCtx, mediaCanvas);

  // Sort media items by zIndex (lower first, higher last) to draw in correct order
  const sortedItems = [...mediaItems].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  console.log(
    "Drawing media in order:",
    sortedItems.map((m) => ({ id: m.id.slice(0, 8), z: m.zIndex || 0 })),
  );

  // Draw all media items in z-index order
  sortedItems.forEach((item) => {
    drawMediaItem(item);
  });

  // Draw selection handles if a media item is selected
  drawMediaSelection();
}

/**
 * Draw a single media item on the media canvas
 * @param {Object} item - Media item with dataUrl, x, y, width, height properties
 */
function drawMediaItem(item) {
  if (!mediaCtx || !item || !item.dataUrl) return;

  // Check if image should be loaded (viewport-based lazy loading)
  if (!shouldLoadMedia(item)) {
    // Unload image if it's too far from viewport to save memory
    if (item.imageElement) {
      item.imageElement = null; // Release memory
    }
    return;
  }

  // Check if image is already loaded and valid
  if (item.imageElement instanceof HTMLImageElement) {
    // Image already loaded, draw immediately
    drawMediaItemImmediate(item);
    return;
  }

  // Load the image if not already loading
  if (item.loading) return;

  // Start loading the image
  item.loading = true;
  const img = new Image();
  img.onload = () => {
    item.imageElement = img;
    item.loading = false;
    // Redraw all media once the image is loaded
    redrawMediaImmediate();
  };
  img.onerror = (error) => {
    console.error("[Media] Failed to load image:", error);
    item.loading = false;
  };
  img.src = item.dataUrl;
}

/**
 * Check if a media item should be loaded based on viewport position
 * Uses a buffer zone to preload images before they enter viewport
 * @param {Object} item - Media item with x, y, width, height
 * @returns {boolean} True if item should be loaded
 */
function shouldLoadMedia(item) {
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (!wrapper) return true; // Load by default if wrapper not found

  // Get viewport dimensions and scroll position
  const viewportWidth = wrapper.clientWidth;
  const viewportHeight = wrapper.clientHeight;
  const scrollLeft = wrapper.scrollLeft;
  const scrollTop = wrapper.scrollTop;

  // Define buffer zone (300px on all sides) for preloading
  const buffer = 300;

  // Calculate item bounds in canvas coordinates
  const itemLeft = item.x * zoomScale;
  const itemTop = item.y * zoomScale;
  const itemRight = (item.x + item.width) * zoomScale;
  const itemBottom = (item.y + item.height) * zoomScale;

  // Calculate viewport bounds with buffer
  const viewportLeft = scrollLeft - buffer;
  const viewportTop = scrollTop - buffer;
  const viewportRight = scrollLeft + viewportWidth + buffer;
  const viewportBottom = scrollTop + viewportHeight + buffer;

  // Check if item intersects with buffered viewport
  const isVisible =
    itemRight >= viewportLeft &&
    itemLeft <= viewportRight &&
    itemBottom >= viewportTop &&
    itemTop <= viewportBottom;

  return isVisible;
}

/**
 * Clean up memory by unloading images that are far from viewport
 * Uses a larger buffer (1000px) to avoid unloading images too aggressively
 */
function cleanupMediaMemory() {
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (!wrapper) return;

  // Get viewport dimensions and scroll position
  const viewportWidth = wrapper.clientWidth;
  const viewportHeight = wrapper.clientHeight;
  const scrollLeft = wrapper.scrollLeft;
  const scrollTop = wrapper.scrollTop;

  // Define larger buffer zone for cleanup (1000px on all sides)
  const cleanupBuffer = 1000;

  // Calculate viewport bounds with cleanup buffer
  const viewportLeft = scrollLeft - cleanupBuffer;
  const viewportTop = scrollTop - cleanupBuffer;
  const viewportRight = scrollLeft + viewportWidth + cleanupBuffer;
  const viewportBottom = scrollTop + viewportHeight + cleanupBuffer;

  let unloadedCount = 0;

  // Check each media item
  for (const item of mediaItems) {
    // Skip if no image loaded
    if (!item.imageElement) continue;

    // Calculate item bounds in canvas coordinates
    const itemLeft = item.x * zoomScale;
    const itemTop = item.y * zoomScale;
    const itemRight = (item.x + item.width) * zoomScale;
    const itemBottom = (item.y + item.height) * zoomScale;

    // Check if item is far outside viewport
    const isFarAway =
      itemRight < viewportLeft ||
      itemLeft > viewportRight ||
      itemBottom < viewportTop ||
      itemTop > viewportBottom;

    if (isFarAway) {
      // Unload the image to free memory
      item.imageElement = null;
      unloadedCount++;
    }
  }

  if (unloadedCount > 0) {
    // Silently cleanup memory
  }
}

/**
 * Redraw all media immediately (for loaded images only)
 */
function redrawMediaImmediate() {
  if (!mediaCtx || !mediaCanvas) return;

  // Clear the media canvas
  clearCanvas(mediaCtx, mediaCanvas);

  // Sort media items by zIndex (lower first, higher last) to draw in correct order
  const sortedItems = [...mediaItems].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  console.log(
    "Drawing media in order:",
    sortedItems.map((m) => ({ id: m.id.slice(0, 8), z: m.zIndex || 0 })),
  );

  // Draw all media items that have loaded images in z-index order
  sortedItems.forEach((item) => {
    if (item.imageElement && item.imageElement instanceof HTMLImageElement) {
      drawMediaItemImmediate(item);
    }
  });
}

/**
 * Draw a media item immediately (assumes image is loaded)
 * @param {Object} item - Media item with loaded imageElement
 */
function drawMediaItemImmediate(item) {
  if (!mediaCtx || !item || !item.imageElement) return;

  mediaCtx.save();

  // Apply rotation if present (check for !== undefined to allow 0)
  if (item.rotation !== undefined && item.rotation !== 0) {
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    mediaCtx.translate(centerX, centerY);
    mediaCtx.rotate((item.rotation * Math.PI) / 180);
    mediaCtx.translate(-centerX, -centerY);
  }

  // Draw the image at the specified position and size
  mediaCtx.drawImage(item.imageElement, item.x, item.y, item.width, item.height);

  mediaCtx.restore();
}

/**
 * Get the selected media item
 * @returns {Object|null} The selected media item or null
 */
function getSelectedMedia() {
  if (!selectedMediaId) return null;
  return mediaItems.find((item) => item.id === selectedMediaId) || null;
}

/**
 * Select a media item by ID
 * @param {string|null} mediaId - Media item ID or null to deselect
 */
function selectMedia(mediaId) {
  selectedMediaId = mediaId;

  // Update crop and delete button visibility
  const cropBtn = document.getElementById("crop-media-btn");
  if (cropBtn) {
    cropBtn.style.display = selectedMediaId ? "block" : "none";
  }

  const deleteBtn = document.getElementById("delete-media-btn");
  if (deleteBtn) {
    deleteBtn.style.display = selectedMediaId ? "block" : "none";
  }

  // Update layer control button visibility
  const layerDivider = document.getElementById("layer-divider");
  if (layerDivider) {
    layerDivider.style.display = selectedMediaId ? "block" : "none";
  }

  const moveForwardBtn = document.getElementById("move-forward-btn");
  if (moveForwardBtn) {
    moveForwardBtn.style.display = selectedMediaId ? "block" : "none";
  }

  const moveBackwardBtn = document.getElementById("move-backward-btn");
  if (moveBackwardBtn) {
    moveBackwardBtn.style.display = selectedMediaId ? "block" : "none";
  }

  // Redraw to show/hide selection
  redrawMedia();
}

/**
 * Check if a point is inside a media item
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {Object} item - Media item
 * @returns {boolean} True if point is inside
 */
function isPointInMedia(x, y, item) {
  // If image is rotated, transform the point to the rotated coordinate space
  let testX = x;
  let testY = y;

  if (item.rotation !== undefined && item.rotation !== 0) {
    // Translate point to image center
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    const dx = x - centerX;
    const dy = y - centerY;

    // Rotate point by negative rotation angle (inverse transformation)
    const angle = (-item.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    testX = centerX + dx * cos - dy * sin;
    testY = centerY + dx * sin + dy * cos;
  }

  return (
    testX >= item.x &&
    testX <= item.x + item.width &&
    testY >= item.y &&
    testY <= item.y + item.height
  );
}

/**
 * Find media item at point (returns topmost item)
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {Object|null} Media item or null
 */
function getMediaAtPoint(x, y) {
  // Iterate backwards to get topmost item first
  for (let i = mediaItems.length - 1; i >= 0; i--) {
    const item = mediaItems[i];
    if (isPointInMedia(x, y, item)) {
      return item;
    }
  }
  return null;
}

/**
 * Check if a point is on a media resize or rotation handle
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {Object} item - Media item
 * @returns {string|null} Handle name ('nw', 'ne', 'sw', 'se', 'rotate') or null
 */
function getMediaHandleAtPoint(x, y, item) {
  // If image is rotated, we need to transform the point to the rotated coordinate space
  let testX = x;
  let testY = y;

  if (item.rotation !== undefined && item.rotation !== 0) {
    // Translate point to image center
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    const dx = x - centerX;
    const dy = y - centerY;

    // Rotate point by negative rotation angle (inverse transformation)
    const angle = (-item.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    testX = centerX + dx * cos - dy * sin;
    testY = centerY + dx * sin + dy * cos;
  }

  const handleRadius = mediaHandleSize * 1.5; // Match the drawing size

  // Check rotation handle first (priority over resize handles)
  // Rotation handle is a half circle at top-center edge, INSIDE the image
  const rotateHandleY = item.y; // At top edge
  const rotateHandleX = item.x + item.width / 2;
  const rotateDx = testX - rotateHandleX;
  const rotateDy = testY - rotateHandleY;
  const rotateDistance = Math.sqrt(rotateDx * rotateDx + rotateDy * rotateDy);
  // Check if within radius AND in the lower half (y >= rotateHandleY) - inside the image
  if (rotateDistance <= handleRadius && testY >= rotateHandleY) {
    return "rotate";
  }

  // Check resize handles (quarter circles INSIDE corners)
  const cornerHandles = [
    { name: "nw", x: item.x, y: item.y, checkX: (dx) => dx >= 0, checkY: (dy) => dy >= 0 }, // bottom-right quarter inside
    {
      name: "ne",
      x: item.x + item.width,
      y: item.y,
      checkX: (dx) => dx <= 0,
      checkY: (dy) => dy >= 0,
    }, // bottom-left quarter inside
    {
      name: "sw",
      x: item.x,
      y: item.y + item.height,
      checkX: (dx) => dx >= 0,
      checkY: (dy) => dy <= 0,
    }, // top-right quarter inside
    {
      name: "se",
      x: item.x + item.width,
      y: item.y + item.height,
      checkX: (dx) => dx <= 0,
      checkY: (dy) => dy <= 0,
    }, // top-left quarter inside
  ];

  for (const handle of cornerHandles) {
    const dx = testX - handle.x;
    const dy = testY - handle.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    // Check if within radius AND in the correct quadrant (INSIDE the image)
    if (distance <= handleRadius && handle.checkX(dx) && handle.checkY(dy)) {
      return handle.name;
    }
  }

  return null;
}

/**
 * Draw selection border and resize handles for selected media
 */
function drawMediaSelection() {
  const selected = getSelectedMedia();
  if (!selected || !mediaCtx) return;

  // Only draw selection in Image Mode
  if (!isImageMode) return;

  mediaCtx.save();

  // Apply rotation transformation if image is rotated
  if (selected.rotation !== undefined && selected.rotation !== 0) {
    const centerX = selected.x + selected.width / 2;
    const centerY = selected.y + selected.height / 2;
    mediaCtx.translate(centerX, centerY);
    mediaCtx.rotate((selected.rotation * Math.PI) / 180);
    mediaCtx.translate(-centerX, -centerY);
  }

  // Draw selection border
  mediaCtx.strokeStyle = "#0066cc";
  mediaCtx.lineWidth = 2;
  mediaCtx.setLineDash([5, 5]);
  mediaCtx.strokeRect(selected.x, selected.y, selected.width, selected.height);
  mediaCtx.setLineDash([]);

  // Only draw manipulation handles in Image Mode
  if (isImageMode) {
    const handleRadius = mediaHandleSize * 1.5; // Bigger diameter for better touch targets

    // Draw resize handles as quarter circles INSIDE corners
    const cornerHandles = [
      { x: selected.x, y: selected.y, startAngle: 0, endAngle: Math.PI * 0.5 }, // nw (bottom-right quarter inside)
      {
        x: selected.x + selected.width,
        y: selected.y,
        startAngle: Math.PI * 0.5,
        endAngle: Math.PI,
      }, // ne (bottom-left quarter inside)
      {
        x: selected.x,
        y: selected.y + selected.height,
        startAngle: Math.PI * 1.5,
        endAngle: Math.PI * 2,
      }, // sw (top-right quarter inside)
      {
        x: selected.x + selected.width,
        y: selected.y + selected.height,
        startAngle: Math.PI,
        endAngle: Math.PI * 1.5,
      }, // se (top-left quarter inside)
    ];

    mediaCtx.fillStyle = "#0066cc";
    mediaCtx.strokeStyle = "#ffffff";
    mediaCtx.lineWidth = 2;

    for (const handle of cornerHandles) {
      mediaCtx.beginPath();
      mediaCtx.arc(handle.x, handle.y, handleRadius, handle.startAngle, handle.endAngle);
      mediaCtx.lineTo(handle.x, handle.y); // Line back to center to close the wedge
      mediaCtx.closePath();
      mediaCtx.fill();
      mediaCtx.stroke();
    }

    // Draw rotation handle as half circle INSIDE top-center edge
    const rotateHandleY = selected.y; // At top edge
    const rotateHandleX = selected.x + selected.width / 2; // Center horizontally

    // Draw rotation handle as half circle pointing down (inside the image)
    mediaCtx.fillStyle = "#00cc66"; // Green color for rotation handle
    mediaCtx.strokeStyle = "#ffffff";
    mediaCtx.lineWidth = 2;
    mediaCtx.beginPath();
    mediaCtx.arc(rotateHandleX, rotateHandleY, handleRadius, 0, Math.PI); // Bottom half (inside image)
    mediaCtx.closePath();
    mediaCtx.fill();
    mediaCtx.stroke();
  }

  mediaCtx.restore();
}

/**
 * Update cursor style based on media interaction state
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 */
function updateMediaCursor(x, y) {
  const textEditorEl = document.getElementById("text-editor");
  if (!textEditorEl) return;

  // Only change cursor in Image Mode
  if (!isImageMode) {
    textEditorEl.style.cursor = "";
    _mediaHoverState = null;
    return;
  }

  // Check if hovering over selected media's handle
  const selected = getSelectedMedia();
  if (selected) {
    const handle = getMediaHandleAtPoint(x, y, selected);
    if (handle) {
      // Set cursor based on handle type
      const cursors = {
        nw: "nw-resize",
        ne: "ne-resize",
        sw: "sw-resize",
        se: "se-resize",
        rotate: "grab", // Rotation cursor
      };
      textEditorEl.style.cursor = cursors[handle] || "move";
      _mediaHoverState = { mediaId: selected.id, handle };
      return;
    }
  }

  // Check if hovering over any media item
  const media = getMediaAtPoint(x, y);
  if (media) {
    textEditorEl.style.cursor = "move";
    _mediaHoverState = { mediaId: media.id, handle: null };
    return;
  }

  // No media hover - reset cursor to default
  textEditorEl.style.cursor = "";
  _mediaHoverState = null;
}

/**
 * Prevent or allow scrolling during media manipulation
 * @param {boolean} prevent - True to prevent scrolling, false to allow
 */
function preventScrollDuringMediaManipulation(prevent) {
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (!wrapper) return;

  if (prevent) {
    // Store original overflow style
    if (!wrapper.dataset.originalOverflow) {
      wrapper.dataset.originalOverflow = wrapper.style.overflow || "";
    }
    if (!wrapper.dataset.originalTouchAction) {
      wrapper.dataset.originalTouchAction = wrapper.style.touchAction || "";
    }
    if (currentEditor && !currentEditor.dataset.originalTouchAction) {
      currentEditor.dataset.originalTouchAction = currentEditor.style.touchAction || "";
    }
    // Prevent scrolling by setting overflow to hidden
    wrapper.style.overflow = "hidden";
    wrapper.style.touchAction = "none";
    if (currentEditor) {
      currentEditor.style.touchAction = "none";
    }
  } else {
    // Restore original overflow style
    const originalOverflow = wrapper.dataset.originalOverflow || "";
    wrapper.style.overflow = originalOverflow;
    if (isImageMode) {
      wrapper.style.touchAction = "";
      if (currentEditor) {
        currentEditor.style.touchAction = "";
        delete currentEditor.dataset.originalTouchAction;
      }
    } else {
      const originalTouchAction = wrapper.dataset.originalTouchAction || "";
      wrapper.style.touchAction = originalTouchAction;
      if (currentEditor) {
        const editorTouchAction = currentEditor.dataset.originalTouchAction || "";
        currentEditor.style.touchAction = editorTouchAction;
        delete currentEditor.dataset.originalTouchAction;
      }
    }
    // Clear the stored value
    delete wrapper.dataset.originalOverflow;
    delete wrapper.dataset.originalTouchAction;
  }
}

/**
 * Delete the selected media item
 */
function deleteSelectedMedia() {
  if (!selectedMediaId) return;

  // Find and remove the item
  const index = mediaItems.findIndex((item) => item.id === selectedMediaId);
  if (index !== -1) {
    // Add to deleted list for tombstone tracking
    deletedMedia.push(selectedMediaId);

    // Remove from media items
    mediaItems.splice(index, 1);

    // Deselect
    selectMedia(null);

    // Mark as edited and save
    markNoteEdited();

    // Redraw
    redrawMedia();
  }
}

/**
 * Move selected media forward (increase z-index)
 */
function moveMediaForward() {
  if (!selectedMediaId) return;

  const selected = getSelectedMedia();
  if (!selected) return;

  // Initialize zIndex if not set
  if (selected.zIndex === undefined) {
    selected.zIndex = 0;
  }

  // Find the next higher zIndex among all media items
  const higherItems = mediaItems
    .filter((item) => item.id !== selectedMediaId && (item.zIndex || 0) > selected.zIndex)
    .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

  if (higherItems.length > 0) {
    // Swap with the next higher item
    const nextItem = higherItems[0];
    const temp = selected.zIndex;
    selected.zIndex = nextItem.zIndex;
    nextItem.zIndex = temp;
  } else {
    // Already at the top, increment by 1
    selected.zIndex++;
  }

  // Mark as edited and redraw
  markNoteEdited();
  redrawMedia();
  scheduleSave();
}

/**
 * Move selected media backward (decrease z-index)
 */
function moveMediaBackward() {
  if (!selectedMediaId) return;

  const selected = getSelectedMedia();
  if (!selected) return;

  // Initialize zIndex if not set
  if (selected.zIndex === undefined) {
    selected.zIndex = 0;
  }

  // Find the next lower zIndex among all media items
  const lowerItems = mediaItems
    .filter((item) => item.id !== selectedMediaId && (item.zIndex || 0) < selected.zIndex)
    .sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));

  if (lowerItems.length > 0) {
    // Swap with the next lower item
    const nextItem = lowerItems[0];
    const temp = selected.zIndex;
    selected.zIndex = nextItem.zIndex;
    nextItem.zIndex = temp;
  } else {
    // Already at the bottom, decrement by 1
    selected.zIndex--;
  }

  // Mark as edited and redraw
  markNoteEdited();
  redrawMedia();
  scheduleSave();
}

/**
 * Enter crop mode for the selected media item
 */
function enterCropMode() {
  const selected = getSelectedMedia();
  if (!selected || !selected.imageElement) {
    console.warn("[Crop] No valid media selected");
    return;
  }

  // Create crop overlay
  const overlay = document.createElement("div");
  overlay.id = "crop-overlay";
  overlay.className = "crop-overlay active";
  overlay.dataset.cropMode = "simple"; // Default to simple crop mode

  // Create crop container
  const container = document.createElement("div");
  container.className = "crop-container";

  // Create mode toggle buttons
  const modeToggle = document.createElement("div");
  modeToggle.className = "crop-mode-toggle";

  const simpleModeBtn = document.createElement("button");
  simpleModeBtn.textContent = "Simple Crop";
  simpleModeBtn.className = "crop-mode-btn crop-mode-simple active";
  simpleModeBtn.onclick = () => switchCropMode("simple");

  const perspectiveModeBtn = document.createElement("button");
  perspectiveModeBtn.textContent = "Perspective";
  perspectiveModeBtn.className = "crop-mode-btn crop-mode-perspective";
  perspectiveModeBtn.onclick = () => switchCropMode("perspective");

  modeToggle.appendChild(simpleModeBtn);
  modeToggle.appendChild(perspectiveModeBtn);

  // Create image element for cropping
  const img = document.createElement("img");
  img.className = "crop-image";
  img.src = selected.dataUrl;
  img.style.maxWidth = "90vw";
  img.style.maxHeight = "70vh";

  // Create crop area (initially 80% of image size, centered)
  const cropArea = document.createElement("div");
  cropArea.className = "crop-area";
  cropArea.id = "crop-area";

  // Create crop handles (for simple crop mode)
  const handles = ["nw", "ne", "sw", "se"];
  handles.forEach((pos) => {
    const handle = document.createElement("div");
    handle.className = `crop-handle crop-${pos}`;
    handle.dataset.position = pos;
    cropArea.appendChild(handle);
  });

  // Create perspective corners (for perspective mode, hidden by default)
  const perspectiveArea = document.createElement("div");
  perspectiveArea.className = "perspective-area";
  perspectiveArea.id = "perspective-area";
  perspectiveArea.style.display = "none";

  const corners = [
    { name: "tl", label: "TL" },
    { name: "tr", label: "TR" },
    { name: "br", label: "BR" },
    { name: "bl", label: "BL" },
  ];
  corners.forEach((corner) => {
    const cornerHandle = document.createElement("div");
    cornerHandle.className = `perspective-corner perspective-${corner.name}`;
    cornerHandle.dataset.corner = corner.name;
    cornerHandle.innerHTML = `<span class="corner-label">${corner.label}</span>`;
    perspectiveArea.appendChild(cornerHandle);
  });

  // Create crop controls
  const controls = document.createElement("div");
  controls.className = "crop-controls";

  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  applyBtn.className = "crop-btn crop-apply-btn";
  applyBtn.onclick = () => applyCrop(selected.id);

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.className = "crop-btn crop-cancel-btn";
  cancelBtn.onclick = exitCropMode;

  controls.appendChild(cancelBtn);
  controls.appendChild(applyBtn);

  // Assemble the UI
  container.appendChild(modeToggle);
  container.appendChild(img);
  container.appendChild(cropArea);
  container.appendChild(perspectiveArea);
  container.appendChild(controls);
  overlay.appendChild(container);
  document.body.appendChild(overlay);

  // Initialize crop area after image loads
  img.onload = () => {
    const imgRect = img.getBoundingClientRect();
    const cropWidth = imgRect.width * 0.8;
    const cropHeight = imgRect.height * 0.8;
    const cropLeft = (imgRect.width - cropWidth) / 2;
    const cropTop = (imgRect.height - cropHeight) / 2;

    cropArea.style.left = `${cropLeft}px`;
    cropArea.style.top = `${cropTop}px`;
    cropArea.style.width = `${cropWidth}px`;
    cropArea.style.height = `${cropHeight}px`;

    // Initialize crop area dragging
    initCropAreaDrag(cropArea, img);

    // Initialize perspective corners at crop area corners
    initPerspectiveCorners(perspectiveArea, img, {
      left: cropLeft,
      top: cropTop,
      width: cropWidth,
      height: cropHeight,
    });
  };
}

/**
 * Exit crop mode
 */
function exitCropMode() {
  const overlay = document.getElementById("crop-overlay");
  if (overlay) {
    overlay.remove();
  }
}

/**
 * Switch between simple crop and perspective correction modes
 * @param {string} mode - "simple" or "perspective"
 */
function switchCropMode(mode) {
  const overlay = document.getElementById("crop-overlay");
  const cropArea = document.getElementById("crop-area");
  const perspectiveArea = document.getElementById("perspective-area");
  const simpleModeBtn = overlay?.querySelector(".crop-mode-simple");
  const perspectiveModeBtn = overlay?.querySelector(".crop-mode-perspective");

  if (!overlay || !cropArea || !perspectiveArea) return;

  overlay.dataset.cropMode = mode;

  if (mode === "simple") {
    // Show simple crop mode
    cropArea.style.display = "block";
    perspectiveArea.style.display = "none";
    simpleModeBtn?.classList.add("active");
    perspectiveModeBtn?.classList.remove("active");
  } else if (mode === "perspective") {
    // Show perspective mode
    cropArea.style.display = "none";
    perspectiveArea.style.display = "block";
    simpleModeBtn?.classList.remove("active");
    perspectiveModeBtn?.classList.add("active");
  }
}

/**
 * Initialize perspective corner handles
 * @param {HTMLElement} perspectiveArea - Container for perspective corners
 * @param {HTMLImageElement} img - The crop image element
 * @param {Object} initialRect - Initial position {left, top, width, height}
 */
function initPerspectiveCorners(perspectiveArea, img, initialRect) {
  // Position corners at the initial crop area corners
  const corners = {
    tl: { x: initialRect.left, y: initialRect.top },
    tr: { x: initialRect.left + initialRect.width, y: initialRect.top },
    br: { x: initialRect.left + initialRect.width, y: initialRect.top + initialRect.height },
    bl: { x: initialRect.left, y: initialRect.top + initialRect.height },
  };

  // Position each corner handle
  Object.entries(corners).forEach(([name, pos]) => {
    const cornerHandle = perspectiveArea.querySelector(`.perspective-${name}`);
    if (cornerHandle) {
      cornerHandle.style.left = `${pos.x}px`;
      cornerHandle.style.top = `${pos.y}px`;
    }
  });

  // Make corners draggable
  perspectiveArea.querySelectorAll(".perspective-corner").forEach((cornerHandle) => {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    cornerHandle.addEventListener("pointerdown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = cornerHandle.offsetLeft;
      startTop = cornerHandle.offsetTop;
      cornerHandle.style.cursor = "grabbing";
      if (cornerHandle.setPointerCapture) {
        try {
          cornerHandle.setPointerCapture(e.pointerId);
        } catch (err) {
          console.warn("[Crop] Could not set pointer capture:", err);
        }
      }
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener("pointermove", (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Get current image bounds (need to recalculate as img position may have changed)
      const currentImgRect = img.getBoundingClientRect();
      const containerRect = perspectiveArea.getBoundingClientRect();

      // Calculate image bounds relative to container
      const imgLeft = currentImgRect.left - containerRect.left;
      const imgTop = currentImgRect.top - containerRect.top;
      const imgRight = imgLeft + currentImgRect.width;
      const imgBottom = imgTop + currentImgRect.height;

      // Constrain to image bounds
      newLeft = Math.max(imgLeft, Math.min(newLeft, imgRight));
      newTop = Math.max(imgTop, Math.min(newTop, imgBottom));

      cornerHandle.style.left = `${newLeft}px`;
      cornerHandle.style.top = `${newTop}px`;

      // Draw lines connecting corners
      drawPerspectiveLines(perspectiveArea);
      e.preventDefault();
    });

    const endDrag = (e) => {
      if (isDragging) {
        isDragging = false;
        cornerHandle.style.cursor = "grab";
        if (cornerHandle.releasePointerCapture) {
          try {
            cornerHandle.releasePointerCapture(e.pointerId);
          } catch (err) {
            console.warn("[Crop] Could not release pointer capture:", err);
          }
        }
      }
    };
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);
  });

  // Draw initial connecting lines
  drawPerspectiveLines(perspectiveArea);
}

/**
 * Draw lines connecting perspective corners
 * @param {HTMLElement} perspectiveArea - Container for perspective corners
 */
function drawPerspectiveLines(perspectiveArea) {
  // Remove existing lines
  const existingLines = perspectiveArea.querySelectorAll(".perspective-line");
  existingLines.forEach((line) => {
    line.remove();
  });

  // Get corner positions
  const corners = {};
  perspectiveArea.querySelectorAll(".perspective-corner").forEach((corner) => {
    const name = corner.dataset.corner;
    corners[name] = {
      x: corner.offsetLeft,
      y: corner.offsetTop,
    };
  });

  // Draw lines between corners (TL->TR, TR->BR, BR->BL, BL->TL)
  const connections = [
    ["tl", "tr"],
    ["tr", "br"],
    ["br", "bl"],
    ["bl", "tl"],
  ];

  connections.forEach(([from, to]) => {
    const fromPos = corners[from];
    const toPos = corners[to];

    const line = document.createElement("div");
    line.className = "perspective-line";

    // Calculate line position and rotation
    const dx = toPos.x - fromPos.x;
    const dy = toPos.y - fromPos.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    line.style.left = `${fromPos.x}px`;
    line.style.top = `${fromPos.y}px`;
    line.style.width = `${length}px`;
    line.style.transform = `rotate(${angle}deg)`;
    line.style.transformOrigin = "0 0";

    perspectiveArea.appendChild(line);
  });
}

/**
 * Initialize crop area dragging and resizing
 */
function initCropAreaDrag(cropArea, img) {
  let isDragging = false;
  let isResizing = false;
  let resizeHandle = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let startWidth = 0;
  let startHeight = 0;

  const imgRect = img.getBoundingClientRect();

  // Handle drag on crop area
  cropArea.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("crop-handle")) {
      // Resize mode
      isResizing = true;
      resizeHandle = e.target.dataset.position;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = cropArea.offsetLeft;
      startTop = cropArea.offsetTop;
      startWidth = cropArea.offsetWidth;
      startHeight = cropArea.offsetHeight;
    } else {
      // Drag mode
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = cropArea.offsetLeft;
      startTop = cropArea.offsetTop;
    }
    if (cropArea.setPointerCapture) {
      try {
        cropArea.setPointerCapture(e.pointerId);
      } catch (err) {
        console.warn("[Crop] Could not set pointer capture:", err);
      }
    }
    e.preventDefault();
  });

  document.addEventListener("pointermove", (e) => {
    if (isDragging) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Constrain to image bounds
      newLeft = Math.max(0, Math.min(newLeft, imgRect.width - cropArea.offsetWidth));
      newTop = Math.max(0, Math.min(newTop, imgRect.height - cropArea.offsetHeight));

      cropArea.style.left = `${newLeft}px`;
      cropArea.style.top = `${newTop}px`;
      e.preventDefault();
    } else if (isResizing) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let newLeft = startLeft;
      let newTop = startTop;
      let newWidth = startWidth;
      let newHeight = startHeight;

      if (resizeHandle === "se") {
        newWidth = startWidth + dx;
        newHeight = startHeight + dy;
      } else if (resizeHandle === "sw") {
        newWidth = startWidth - dx;
        newHeight = startHeight + dy;
        newLeft = startLeft + dx;
      } else if (resizeHandle === "ne") {
        newWidth = startWidth + dx;
        newHeight = startHeight - dy;
        newTop = startTop + dy;
      } else if (resizeHandle === "nw") {
        newWidth = startWidth - dx;
        newHeight = startHeight - dy;
        newLeft = startLeft + dx;
        newTop = startTop + dy;
      }

      // Apply minimum size
      const minSize = 50;
      if (newWidth >= minSize && newHeight >= minSize) {
        // Constrain to image bounds
        newLeft = Math.max(0, Math.min(newLeft, imgRect.width - newWidth));
        newTop = Math.max(0, Math.min(newTop, imgRect.height - newHeight));
        newWidth = Math.min(newWidth, imgRect.width - newLeft);
        newHeight = Math.min(newHeight, imgRect.height - newTop);

        cropArea.style.left = `${newLeft}px`;
        cropArea.style.top = `${newTop}px`;
        cropArea.style.width = `${newWidth}px`;
        cropArea.style.height = `${newHeight}px`;
      }
      e.preventDefault();
    }
  });

  const endInteraction = (e) => {
    isDragging = false;
    isResizing = false;
    resizeHandle = null;
    if (e && cropArea.releasePointerCapture) {
      try {
        cropArea.releasePointerCapture(e.pointerId);
      } catch (err) {
        console.warn("[Crop] Could not release pointer capture:", err);
      }
    }
  };
  document.addEventListener("pointerup", endInteraction);
  document.addEventListener("pointercancel", endInteraction);
}

/**
 * Apply crop to the selected media item
 */
async function applyCrop(mediaId) {
  const item = mediaItems.find((m) => m.id === mediaId);
  if (!item || !item.imageElement) {
    console.error("[Crop] Media item not found");
    exitCropMode();
    return;
  }

  const overlay = document.getElementById("crop-overlay");
  const img = document.querySelector(".crop-image");
  if (!overlay || !img) {
    console.error("[Crop] Crop UI elements not found");
    exitCropMode();
    return;
  }

  const cropMode = overlay.dataset.cropMode;
  const imgRect = img.getBoundingClientRect();

  if (cropMode === "perspective") {
    // Apply perspective correction
    await applyPerspectiveCorrection(item, img, imgRect);
  } else {
    // Apply simple crop
    await applySimpleCrop(item, img, imgRect);
  }

  // Exit crop mode
  exitCropMode();

  // Mark as edited and redraw
  markNoteEdited();
  redrawMedia();
  scheduleSave();
}

/**
 * Apply simple rectangular crop
 * @param {Object} item - Media item to crop
 * @param {HTMLImageElement} img - Display image element
 * @param {DOMRect} imgRect - Image bounding rectangle
 */
async function applySimpleCrop(item, _img, imgRect) {
  const cropArea = document.getElementById("crop-area");
  if (!cropArea) {
    console.error("[Crop] Crop area not found");
    return;
  }

  const cropRect = cropArea.getBoundingClientRect();

  // Calculate crop coordinates relative to the displayed image
  const scaleX = item.imageElement.naturalWidth / imgRect.width;
  const scaleY = item.imageElement.naturalHeight / imgRect.height;

  const cropX = (cropRect.left - imgRect.left) * scaleX;
  const cropY = (cropRect.top - imgRect.top) * scaleY;
  const cropWidth = cropRect.width * scaleX;
  const cropHeight = cropRect.height * scaleY;

  // Create a canvas to crop the image
  const canvas = document.createElement("canvas");
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext("2d");

  // Draw the cropped portion
  ctx.drawImage(
    item.imageElement,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );

  // Convert to data URL
  const croppedDataUrl = canvas.toDataURL("image/jpeg", 0.85);

  // Calculate new displayed size
  const displayScaleX = cropRect.width / imgRect.width;
  const displayScaleY = cropRect.height / imgRect.height;
  const newDisplayWidth = item.width * displayScaleX;
  const newDisplayHeight = item.height * displayScaleY;

  // Update the media item
  item.dataUrl = croppedDataUrl;
  item.imageElement = null; // Force reload
  item.width = newDisplayWidth;
  item.height = newDisplayHeight;
}

/**
 * Apply perspective correction to straighten document photos
 * @param {Object} item - Media item to transform
 * @param {HTMLImageElement} _img - Display image element
 * @param {DOMRect} imgRect - Image bounding rectangle
 */
async function applyPerspectiveCorrection(item, _img, imgRect) {
  try {
    console.log("[Crop] Starting perspective correction...");

    const perspectiveArea = document.getElementById("perspective-area");
    if (!perspectiveArea) {
      console.error("[Crop] Perspective area not found");
      return;
    }

    // Get corner positions (relative to perspectiveArea)
    const corners = {};
    perspectiveArea.querySelectorAll(".perspective-corner").forEach((corner) => {
      const name = corner.dataset.corner;
      corners[name] = {
        x: corner.offsetLeft,
        y: corner.offsetTop,
      };
    });

    // Calculate image offset within perspectiveArea container
    const containerRect = perspectiveArea.getBoundingClientRect();
    const imgOffsetX = imgRect.left - containerRect.left;
    const imgOffsetY = imgRect.top - containerRect.top;

    // Adjust corner positions to be relative to the image (not the container)
    const imgRelativeCorners = {};
    for (const [name, pos] of Object.entries(corners)) {
      imgRelativeCorners[name] = {
        x: pos.x - imgOffsetX,
        y: pos.y - imgOffsetY,
      };
    }

    // Validate corners form a quadrilateral (no crossing lines)
    if (!isValidQuadrilateral(imgRelativeCorners)) {
      alert("Invalid corner positions. Lines cannot cross each other.");
      return;
    }

    // Calculate scale from displayed image to natural image size
    const scaleX = item.imageElement.naturalWidth / imgRect.width;
    const scaleY = item.imageElement.naturalHeight / imgRect.height;

    // Convert corner positions to natural image coordinates
    const srcCorners = [
      imgRelativeCorners.tl.x * scaleX,
      imgRelativeCorners.tl.y * scaleY, // top-left
      imgRelativeCorners.tr.x * scaleX,
      imgRelativeCorners.tr.y * scaleY, // top-right
      imgRelativeCorners.br.x * scaleX,
      imgRelativeCorners.br.y * scaleY, // bottom-right
      imgRelativeCorners.bl.x * scaleX,
      imgRelativeCorners.bl.y * scaleY, // bottom-left
    ];

    // Calculate output dimensions using natural image coordinates (after scaling)
    // This ensures we use the actual pixel distances, not distorted display distances
    const topWidth = Math.sqrt(
      (srcCorners[2] - srcCorners[0]) ** 2 + (srcCorners[3] - srcCorners[1]) ** 2,
    );
    const bottomWidth = Math.sqrt(
      (srcCorners[4] - srcCorners[6]) ** 2 + (srcCorners[5] - srcCorners[7]) ** 2,
    );
    const leftHeight = Math.sqrt(
      (srcCorners[6] - srcCorners[0]) ** 2 + (srcCorners[7] - srcCorners[1]) ** 2,
    );
    const rightHeight = Math.sqrt(
      (srcCorners[4] - srcCorners[2]) ** 2 + (srcCorners[5] - srcCorners[3]) ** 2,
    );

    // Calculate perspective distortion ratios
    const widthRatio = Math.max(topWidth, bottomWidth) / Math.min(topWidth, bottomWidth);
    const heightRatio = Math.max(leftHeight, rightHeight) / Math.min(leftHeight, rightHeight);

    // For documents photographed at an angle, both edges are distorted
    // Use the geometric mean (sqrt of product) to estimate the true dimension
    // This balances between the longer and shorter edges
    const outputWidth = Math.sqrt(topWidth * bottomWidth);
    const outputHeight = Math.sqrt(leftHeight * rightHeight);

    console.log("[Crop] Dimension calculation:", {
      topWidth: topWidth.toFixed(1),
      bottomWidth: bottomWidth.toFixed(1),
      leftHeight: leftHeight.toFixed(1),
      rightHeight: rightHeight.toFixed(1),
      widthRatio: widthRatio.toFixed(2),
      heightRatio: heightRatio.toFixed(2),
      outputWidth: outputWidth.toFixed(1),
      outputHeight: outputHeight.toFixed(1),
    });

    // Destination corners (perfect rectangle)
    const dstCorners = [
      0,
      0, // top-left
      outputWidth,
      0, // top-right
      outputWidth,
      outputHeight, // bottom-right
      0,
      outputHeight, // bottom-left
    ];

    console.log("[Crop] Transform params:", {
      outputWidth,
      outputHeight,
      scaleX,
      scaleY,
    });

    // Validate output dimensions
    if (
      outputWidth <= 0 ||
      outputHeight <= 0 ||
      !Number.isFinite(outputWidth) ||
      !Number.isFinite(outputHeight)
    ) {
      throw new Error(`Invalid output dimensions: ${outputWidth}x${outputHeight}`);
    }

    // Use the perspective transform library (loaded globally in index.html)
    if (!window.PerspT) {
      throw new Error("Perspective transform library not loaded. Please refresh the page.");
    }

    // Create transformation
    const perspT = window.PerspT(srcCorners, dstCorners);

    // Create output canvas
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(outputWidth);
    canvas.height = Math.round(outputHeight);
    const ctx = canvas.getContext("2d");

    console.log("[Crop] Canvas size:", canvas.width, "x", canvas.height);

    // Create temporary canvas for source image
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = item.imageElement.naturalWidth;
    srcCanvas.height = item.imageElement.naturalHeight;
    const srcCtx = srcCanvas.getContext("2d");
    srcCtx.drawImage(item.imageElement, 0, 0);

    const srcImageData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
    const srcData = srcImageData.data;

    // Create output image data
    const outputImageData = ctx.createImageData(canvas.width, canvas.height);
    const outputData = outputImageData.data;

    // Apply perspective transformation pixel by pixel
    let pixelsTransformed = 0;
    const totalPixels = canvas.width * canvas.height;

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        // Transform destination point to source point
        const srcPoint = perspT.transformInverse(x, y);
        const srcX = Math.round(srcPoint[0]);
        const srcY = Math.round(srcPoint[1]);

        // Check if source point is within bounds
        if (srcX >= 0 && srcX < srcCanvas.width && srcY >= 0 && srcY < srcCanvas.height) {
          const srcIndex = (srcY * srcCanvas.width + srcX) * 4;
          const dstIndex = (y * canvas.width + x) * 4;

          // Copy pixel
          outputData[dstIndex] = srcData[srcIndex]; // R
          outputData[dstIndex + 1] = srcData[srcIndex + 1]; // G
          outputData[dstIndex + 2] = srcData[srcIndex + 2]; // B
          outputData[dstIndex + 3] = 255; // A - force opaque
          pixelsTransformed++;
        }
      }
    }

    console.log(
      `[Crop] Transformed ${pixelsTransformed}/${totalPixels} pixels (${((pixelsTransformed / totalPixels) * 100).toFixed(1)}%)`,
    );

    // Put transformed image data on canvas
    ctx.putImageData(outputImageData, 0, 0);

    // Convert to data URL
    const transformedDataUrl = canvas.toDataURL("image/jpeg", 0.85);

    // Update the media item
    item.dataUrl = transformedDataUrl;
    item.imageElement = null; // Force reload
    item.width = outputWidth / scaleX; // Convert back to display coordinates
    item.height = outputHeight / scaleY;

    console.log("[Crop] Perspective correction completed successfully");
  } catch (error) {
    console.error("[Crop] Perspective correction failed:", error);
    alert(`Failed to apply perspective correction: ${error.message}`);
    throw error;
  }
}

/**
 * Check if four corners form a valid quadrilateral (no crossing lines)
 * @param {Object} corners - Corner positions {tl, tr, br, bl}
 * @returns {boolean} True if valid
 */
function isValidQuadrilateral(corners) {
  // Check if any lines cross each other
  // We need to check if TL-TR crosses BL-BR, and if TL-BL crosses TR-BR

  const linesCross = (p1, p2, p3, p4) => {
    const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  };

  // Check if top-bottom lines cross
  if (linesCross(corners.tl, corners.tr, corners.bl, corners.br)) return false;

  // Check if left-right lines cross
  if (linesCross(corners.tl, corners.bl, corners.tr, corners.br)) return false;

  return true;
}

/**
 * Check if a stroke intersects with eraser circle
 * @param {Object} stroke - Stroke object with x, y arrays
 * @param {number} eraserX - Eraser center x
 * @param {number} eraserY - Eraser center y
 * @returns {boolean} True if stroke intersects with eraser
 */
function strokeIntersectsEraser(stroke, eraserX, eraserY) {
  if (!stroke || !stroke.x || stroke.x.length === 0) return false;
  const pointCount = stroke.x.length;
  for (let i = 0; i < pointCount - 1; i++) {
    const x1 = stroke.x[i];
    const y1 = stroke.y[i];
    const x2 = stroke.x[i + 1];
    const y2 = stroke.y[i + 1];
    if (isPointNearLine(eraserX, eraserY, x1, y1, x2, y2, eraserRadius)) {
      return true;
    }
  }
  for (let i = 0; i < pointCount; i++) {
    const dx = stroke.x[i] - eraserX;
    const dy = stroke.y[i] - eraserY;
    if (Math.sqrt(dx * dx + dy * dy) <= eraserRadius) {
      return true;
    }
  }
  return false;
}

/**
 * Erase strokes at a given point
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 */
function eraseStrokesAtPoint(x, y) {
  const originalLength = strokes.length;

  // Track deleted stroke IDs
  const erasedStrokeIds = strokes
    .filter((stroke) => strokeIntersectsEraser(stroke, x, y))
    .map((stroke) => stroke.id)
    .filter((id) => id); // Only track strokes that have IDs

  strokes = strokes.filter((stroke) => !strokeIntersectsEraser(stroke, x, y));

  if (strokes.length < originalLength) {
    // Add erased stroke IDs to deletedStrokes list
    deletedStrokes.push(...erasedStrokeIds);
    markNoteEdited();
    // Clear selection to avoid stale indices after mutation
    if (selectedStrokes.size > 0) {
      selectedStrokes.clear();
      selectionBounds = null;
      const deleteBtn = document.getElementById("delete-selection-btn");
      if (deleteBtn) {
        deleteBtn.style.display = "none";
      }
    }
    redrawCanvas();
    updateContentBounds();
  }
}

/**
 * Draw eraser cursor indicator on the overlay canvas
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 */
function drawEraserCursor(x, y) {
  if (!overlayCtx) return;
  clearCanvas(overlayCtx, overlayCanvas);
  overlayCtx.strokeStyle = "red";
  overlayCtx.lineWidth = 1;
  overlayCtx.beginPath();
  overlayCtx.arc(x, y, eraserRadius, 0, 2 * Math.PI);
  overlayCtx.stroke();
}

/**
 * Switch to draw mode
 */
function switchToDrawMode() {
  isDrawMode = true;
  isImageMode = false;

  // Clear any active media transformation
  mediaTransformState = null;

  // Re-enable scrolling (in case it was disabled during media manipulation)
  preventScrollDuringMediaManipulation(false);

  // Clear media selection when switching to draw mode
  if (selectedMediaId) {
    selectMedia(null);
  }

  if (dynamicCanvas) {
    dynamicCanvas.classList.add("active");
    dynamicCanvas.style.pointerEvents = "auto";
  }
  if (currentEditor) {
    currentEditor.style.pointerEvents = "none";
  }
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (wrapper) {
    wrapper.classList.remove("image-mode-active");
  }

  updateToolbarButtons();
  updateModeIndicator();
}

/**
 * Switch to text mode
 */
function switchToTextMode() {
  isDrawMode = false;
  isImageMode = false;

  // Clear any active media transformation
  mediaTransformState = null;

  // Re-enable scrolling (in case it was disabled during media manipulation)
  preventScrollDuringMediaManipulation(false);

  // Deselect any selected media
  if (selectedMediaId) {
    selectMedia(null);
  }

  if (dynamicCanvas) {
    dynamicCanvas.classList.remove("active");
    dynamicCanvas.style.pointerEvents = "none";
  }
  // Ensure other canvas layers are also transparent to pointer events
  if (staticCanvas) {
    staticCanvas.style.pointerEvents = "none";
  }
  if (overlayCanvas) {
    overlayCanvas.style.pointerEvents = "none";
  }

  // Hide pen settings dialog
  const dialog = document.getElementById("pen-settings-dialog");
  if (dialog) {
    dialog.style.display = "none";
  }
  // Hide delete selection button and clear selection
  const deleteBtn = document.getElementById("delete-selection-btn");
  if (deleteBtn) {
    deleteBtn.style.display = "none";
  }
  if (selectedStrokes.size > 0) {
    selectedStrokes.clear();
    selectionBounds = null;
    redrawCanvas();
  }

  if (currentEditor) {
    currentEditor.style.pointerEvents = "auto";
  }
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (wrapper) {
    wrapper.classList.remove("image-mode-active");
  }

  updateToolbarButtons();
  updateModeIndicator();
}

/**
 * Update mode indicator text with auto-switch status
 */
function updateModeIndicator() {
  const modeText = document.getElementById("current-mode-text");
  if (!modeText) return;

  let mode = "Text";
  if (isImageMode) {
    mode = "Image";
  } else if (isDrawMode) {
    mode = isEraserMode ? "Erase" : "Draw";
  }

  const switchType = autoSwitchedToDrawMode ? "(Auto)" : "(Manual)";
  modeText.textContent = `${mode} Mode ${switchType}`;
}

/**
 * Manually switch to text mode (user clicked button)
 */
function manualSwitchToTextMode() {
  autoSwitchedToDrawMode = false; // Clear auto-switch flag
  isEraserMode = false; // Exit eraser mode when switching to text

  // Deselect media when leaving Image Mode
  if (isImageMode && selectedMediaId) {
    selectMedia(null);
  }

  switchToTextMode();
  updateToolbarButtons();
}

/**
 * Manually switch to draw mode (user clicked button)
 */
function manualSwitchToDrawMode() {
  // If already in draw mode (and not erasing), do nothing (settings are now on separate button)
  if (isDrawMode && !isEraserMode && !isLassoMode) {
    return;
  }

  // Clear selection when switching modes
  if (selectedStrokes.size > 0) {
    selectedStrokes.clear();
    selectionBounds = null;
    const deleteBtn = document.getElementById("delete-selection-btn");
    if (deleteBtn) deleteBtn.style.display = "none";
    redrawCanvas();
  }

  autoSwitchedToDrawMode = false; // Clear auto-switch flag
  isEraserMode = false; // Exit eraser mode when switching to draw
  isLassoMode = false;
  switchToDrawMode();
  updateToolbarButtons();
}

/**
 * Switch to image mode
 */
function switchToImageMode() {
  isImageMode = true;
  isDrawMode = false;
  isEraserMode = false;
  isLassoMode = false;
  autoSwitchedToDrawMode = false;

  // Disable drawing canvases
  if (dynamicCanvas) {
    dynamicCanvas.classList.remove("active");
    dynamicCanvas.style.pointerEvents = "none";
  }
  if (staticCanvas) {
    staticCanvas.style.pointerEvents = "none";
  }
  if (overlayCanvas) {
    overlayCanvas.style.pointerEvents = "none";
  }

  // Enable text editor for scrolling on background
  if (currentEditor) {
    currentEditor.style.pointerEvents = "auto";
  }
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (wrapper) {
    wrapper.classList.add("image-mode-active");
  }
  // Clear stroke selection
  if (selectedStrokes.size > 0) {
    selectedStrokes.clear();
    selectionBounds = null;
    const deleteBtn = document.getElementById("delete-selection-btn");
    if (deleteBtn) deleteBtn.style.display = "none";
    redrawCanvas();
  }

  updateToolbarButtons();
  updateModeIndicator();
}

/**
 * Exit image mode and return to text mode
 */
function _exitImageMode() {
  isImageMode = false;
  selectMedia(null); // Deselect any selected media
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (wrapper) {
    wrapper.classList.remove("image-mode-active");
  }
  switchToTextMode();
}

/**
 * Manually switch to image mode (user clicked button)
 */
function manualSwitchToImageMode() {
  switchToImageMode();
}

/**
 * Toggle eraser mode (user clicked eraser button)
 */
function toggleEraserMode() {
  // Hide pen settings dialog when switching to eraser
  const dialog = document.getElementById("pen-settings-dialog");
  if (dialog) {
    dialog.style.display = "none";
  }

  // Clear selection when switching modes
  if (selectedStrokes.size > 0) {
    selectedStrokes.clear();
    selectionBounds = null;
    const deleteBtn = document.getElementById("delete-selection-btn");
    if (deleteBtn) deleteBtn.style.display = "none";
    redrawCanvas();
  }

  isEraserMode = !isEraserMode;
  isLassoMode = false;
  autoSwitchedToDrawMode = false; // This is a manual action, so clear the auto-switch flag.

  // If enabling eraser mode, make sure we're in draw mode
  if (isEraserMode && !isDrawMode) {
    switchToDrawMode();
  }

  updateToolbarButtons();
  updateModeIndicator();
}

/**
 * Toggle lasso mode (user clicked lasso button)
 */
function toggleLassoMode() {
  // Hide pen settings dialog when switching to lasso
  const dialog = document.getElementById("pen-settings-dialog");
  if (dialog) {
    dialog.style.display = "none";
  }

  isLassoMode = !isLassoMode;
  isEraserMode = false; // Disable eraser mode
  if (selectedStrokes.size > 0) {
    selectedStrokes.clear();
    selectionBounds = null;
    redrawCanvas();
  }
  autoSwitchedToDrawMode = false; // This is a manual action

  // If enabling lasso mode, make sure we're in draw mode
  if (isLassoMode && !isDrawMode) {
    switchToDrawMode();
  }

  updateToolbarButtons();
  updateModeIndicator();
}

/**
 * Update toolbar button active states
 */
function updateToolbarButtons() {
  const textBtn = document.getElementById("mode-text-btn");
  const drawBtn = document.getElementById("mode-draw-btn");
  const imageBtn = document.getElementById("mode-image-btn");
  const penBtn = document.getElementById("pen-settings-btn");
  const eraseBtn = document.getElementById("mode-erase-btn");
  const lassoBtn = document.getElementById("mode-lasso-btn");

  if (textBtn) {
    textBtn.classList.toggle("active", !isDrawMode && !isImageMode);
    textBtn.setAttribute("aria-selected", (!isDrawMode && !isImageMode).toString());
  }
  if (drawBtn) {
    drawBtn.classList.toggle("active", isDrawMode);
    drawBtn.setAttribute("aria-selected", isDrawMode.toString());
  }
  if (imageBtn) {
    imageBtn.classList.toggle("active", isImageMode);
    imageBtn.setAttribute("aria-selected", isImageMode.toString());
  }
  if (penBtn) {
    penBtn.classList.toggle("active", isDrawMode && !isEraserMode && !isLassoMode);
  }
  if (eraseBtn) {
    eraseBtn.classList.toggle("active", isEraserMode);
  }
  if (lassoBtn) {
    lassoBtn.classList.toggle("active", isLassoMode);
  }

  // Toggle Row 2 sections based on mode
  const textTools = document.getElementById("text-tools");
  const imageTools = document.getElementById("image-tools");
  const penTools = document.getElementById("pen-tools");

  if (textTools && imageTools && penTools) {
    if (isDrawMode) {
      // Draw Mode: show pen tools only
      textTools.style.display = "none";
      imageTools.style.display = "none";
      penTools.style.display = "flex";
    } else if (isImageMode) {
      // Image Mode: show image tools only
      textTools.style.display = "none";
      imageTools.style.display = "flex";
      penTools.style.display = "none";
    } else {
      // Text Mode: show text tools only
      textTools.style.display = "flex";
      imageTools.style.display = "none";
      penTools.style.display = "none";
    }
  }
}

/**
 * Get pen color palette based on current theme
 */
function getThemePalette() {
  const theme = getTheme();

  // Return cached palette if theme hasn't changed
  if (cachedTheme === theme && cachedPalette !== null) {
    return cachedPalette;
  }

  // Theme changed or first call - get palette from shared utility and cache it
  cachedTheme = theme;
  cachedPalette = sharedGetThemePalette();

  return cachedPalette;
}

/**
 * Toggle pen settings dialog visibility
 */
function togglePenSettingsDialog() {
  const dialog = document.getElementById("pen-settings-dialog");
  const bgDialog = document.getElementById("background-settings-dialog");
  if (!dialog) return;

  // Close background dialog if open
  if (bgDialog) bgDialog.style.display = "none";

  const isVisible = dialog.style.display === "block";
  if (isVisible) {
    dialog.style.display = "none";
  } else {
    updatePenSettingsUI();
    dialog.style.display = "block";
  }
}

/**
 * Toggle background settings dialog visibility
 */
function toggleBackgroundSettingsDialog() {
  const dialog = document.getElementById("background-settings-dialog");
  const penDialog = document.getElementById("pen-settings-dialog");
  if (!dialog) return;

  // Close pen dialog if open
  if (penDialog) penDialog.style.display = "none";

  const isVisible = dialog.style.display === "block";
  if (isVisible) {
    dialog.style.display = "none";
  } else {
    updateBackgroundSettingsUI();
    dialog.style.display = "block";
  }
}

/**
 * Update background settings dialog UI
 */
function updateBackgroundSettingsUI() {
  const dialog = document.getElementById("background-settings-dialog");
  if (!dialog || !currentNoteData) return;

  const currentBackground = currentNoteData.background || "none";
  const options = dialog.querySelectorAll(".background-option");

  options.forEach((option) => {
    const bgType = option.dataset.background;
    if (bgType === currentBackground) {
      option.classList.add("active");
    } else {
      option.classList.remove("active");
    }
  });
}

/**
 * Set note background
 * @param {string} backgroundType - Background pattern type
 */
function setNoteBackground(backgroundType) {
  if (!currentNoteData) return;

  currentNoteData.background = backgroundType;
  markNoteEdited();
  updateBackgroundSettingsUI();
  redrawBackground();

  // Save the change immediately to prevent race conditions.
  saveNoteContent().catch((err) => console.error("Save on background change failed:", err));

  // Close the dialog
  const dialog = document.getElementById("background-settings-dialog");
  if (dialog) {
    dialog.style.display = "none";
  }
}

/**
 * Update pen settings dialog UI
 */
function updatePenSettingsUI() {
  const palette = getThemePalette();
  const colorGrid = document.getElementById("pen-color-grid");
  const widthSlider = document.getElementById("pen-width-slider");
  const widthValue = document.getElementById("pen-width-value");

  if (widthSlider) widthSlider.value = currentPenWidth;
  if (widthValue) widthValue.textContent = currentPenWidth;

  if (colorGrid) {
    colorGrid.innerHTML = palette
      .map(
        (color, index) => `
      <div class="pen-color-option ${index === currentPenColorIndex ? "active" : ""}" 
           style="background-color: ${color}" 
           data-index="${index}"></div>
    `,
      )
      .join("");

    // Add listeners to color options
    colorGrid.querySelectorAll(".pen-color-option").forEach((opt) => {
      opt.addEventListener("click", () => {
        currentPenColorIndex = parseInt(opt.dataset.index, 10);
        updatePenSettingsUI();
      });
    });
  }
}

/**
 * Handle clicks/touches outside the pen settings dialog to close it
 */
function handleOutsideClick(e) {
  const dialog = document.getElementById("pen-settings-dialog");
  const settingsBtn = document.getElementById("pen-settings-btn");
  const bgDialog = document.getElementById("background-settings-dialog");
  const bgBtn = document.getElementById("background-btn");

  if (dialog && dialog.style.display === "block") {
    // Close if the target is not the dialog itself and not the button that toggles it
    if (!dialog.contains(e.target) && !settingsBtn?.contains(e.target)) {
      dialog.style.display = "none";
    }
  }

  if (bgDialog && bgDialog.style.display === "block") {
    // Close if the target is not the dialog itself and not the button that toggles it
    if (!bgDialog.contains(e.target) && !bgBtn?.contains(e.target)) {
      bgDialog.style.display = "none";
    }
  }
}

/**
 * Attach toolbar event listeners
 */
function attachToolbarListeners() {
  // Mode switching - use manual switch functions to clear auto-switch flag
  document.getElementById("mode-text-btn")?.addEventListener("click", manualSwitchToTextMode);
  document.getElementById("mode-draw-btn")?.addEventListener("click", manualSwitchToDrawMode);
  document.getElementById("mode-image-btn")?.addEventListener("click", manualSwitchToImageMode);
  document.getElementById("mode-erase-btn")?.addEventListener("click", toggleEraserMode);
  document.getElementById("mode-lasso-btn")?.addEventListener("click", toggleLassoMode);
  document.getElementById("pen-settings-btn")?.addEventListener("click", () => {
    if (!isDrawMode || isEraserMode || isLassoMode) {
      manualSwitchToDrawMode();
    } else {
      togglePenSettingsDialog();
    }
  });

  // Add global listener to close pen settings when clicking outside
  document.addEventListener("pointerdown", handleOutsideClick);

  // Background settings
  document
    .getElementById("background-btn")
    ?.addEventListener("click", toggleBackgroundSettingsDialog);

  // Background options listeners
  const bgOptions = document.querySelectorAll(".background-option");
  bgOptions.forEach((option) => {
    option.addEventListener("click", () => {
      const bgType = option.dataset.background;
      setNoteBackground(bgType);
    });
  });

  // Pen settings listeners
  document.getElementById("pen-width-slider")?.addEventListener("input", (e) => {
    currentPenWidth = parseInt(e.target.value, 10);
    const widthValue = document.getElementById("pen-width-value");
    if (widthValue) {
      widthValue.textContent = currentPenWidth;
    }
  });

  // Text formatting
  document.getElementById("format-bold-btn")?.addEventListener("click", () => formatText("bold"));
  document
    .getElementById("format-italic-btn")
    ?.addEventListener("click", () => formatText("italic"));
  document
    .getElementById("format-heading-btn")
    ?.addEventListener("click", () => formatText("heading"));
  document.getElementById("format-list-btn")?.addEventListener("click", () => formatText("list"));

  // Image import and manipulation
  document.getElementById("insert-image-btn")?.addEventListener("click", handleInsertImage);
  document.getElementById("insert-camera-btn")?.addEventListener("click", handleInsertCamera);
  document.getElementById("crop-media-btn")?.addEventListener("click", enterCropMode);
  document.getElementById("delete-media-btn")?.addEventListener("click", deleteSelectedMedia);
  document.getElementById("move-forward-btn")?.addEventListener("click", moveMediaForward);
  document.getElementById("move-backward-btn")?.addEventListener("click", moveMediaBackward);

  // Zoom controls (use immediate rendering for button clicks)
  document
    .getElementById("zoom-in-btn")
    ?.addEventListener("click", () => adjustZoom(zoomStep, { immediate: true }));
  document
    .getElementById("zoom-out-btn")
    ?.addEventListener("click", () => adjustZoom(-zoomStep, { immediate: true }));
  document
    .getElementById("zoom-reset-btn")
    ?.addEventListener("click", () => setZoom(1.0, { immediate: true, preserveViewport: true }));

  // Delete note
  document.getElementById("delete-note-btn")?.addEventListener("click", deleteCurrentNote);

  // Note info
  document.getElementById("note-info-btn")?.addEventListener("click", () => {
    if (currentNoteData) {
      showNoteInfoModal(currentNoteData);
    }
  });

  // Delete selection
  document.getElementById("delete-selection-btn")?.addEventListener("click", deleteSelectedStrokes);
  // Paste
  document.getElementById("paste-btn")?.addEventListener("click", pasteStrokes);
}

/**
 * Deletes the strokes currently in the selectedStrokes set
 */
function deleteSelectedStrokes() {
  if (selectedStrokes.size === 0) return;
  markNoteEdited();

  // Track deleted stroke IDs
  const deletedStrokeIds = Array.from(selectedStrokes)
    .map((index) => strokes[index]?.id)
    .filter((id) => id); // Only track strokes that have IDs

  // Filter out the selected strokes
  strokes = strokes.filter((_, index) => !selectedStrokes.has(index));

  // Add deleted stroke IDs to deletedStrokes list
  deletedStrokes.push(...deletedStrokeIds);

  // Clear the selection
  selectedStrokes.clear();
  selectionBounds = null;

  // Hide the delete button
  const deleteBtn = document.getElementById("delete-selection-btn");
  if (deleteBtn) {
    deleteBtn.style.display = "none";
  }

  // Redraw and save (async, don't block)
  redrawCanvas();
  updateContentBounds();

  saveNoteContent().catch((err) => console.error("Save after delete failed:", err));
}

/**
 * Copies the selected strokes to the clipboard
 */
function copySelectedStrokes() {
  if (selectedStrokes.size === 0) return;

  clipboardStrokes = Array.from(selectedStrokes).map((index) =>
    JSON.parse(JSON.stringify(strokes[index])),
  );

  const pasteBtn = document.getElementById("paste-btn");
  if (pasteBtn) pasteBtn.style.display = "block";

  // Flash the selection box as feedback
  const originalBounds = { ...selectionBounds };
  selectionBounds = null;
  redrawCanvas();
  setTimeout(() => {
    selectionBounds = originalBounds;
    redrawCanvas();
  }, 100);
}

/**
 * Pastes the strokes from the clipboard
 */
function pasteStrokes() {
  if (!clipboardStrokes || clipboardStrokes.length === 0) return;
  markNoteEdited();

  const offset = 30;
  const newStrokes = clipboardStrokes.map((stroke) => {
    const copy = JSON.parse(JSON.stringify(stroke));
    copy.id = generateId(); // Assign new ID to pasted stroke
    copy.x = copy.x.map((x) => x + offset);
    copy.y = copy.y.map((y) => y + offset);
    return copy;
  });

  const startIndex = strokes.length;
  strokes.push(...newStrokes);

  // Select the pasted strokes
  selectedStrokes.clear();
  for (let i = 0; i < newStrokes.length; i++) {
    selectedStrokes.add(startIndex + i);
  }

  calculateSelectionBounds();
  redrawCanvas();

  saveNoteContent().catch((err) => console.error("Save after paste failed:", err));
}

/**
 * Format text (simple implementation)
 */
function formatText(format) {
  if (!currentEditor) return;

  currentEditor.focus();

  switch (format) {
    case "bold":
      document.execCommand("bold");
      break;
    case "italic":
      document.execCommand("italic");
      break;
    case "heading":
      document.execCommand("formatBlock", false, "h2");
      break;
    case "list":
      document.execCommand("insertUnorderedList");
      break;
  }
}

/**
 * Calculate initial position and size for a new image
 * Centers the image in the visible viewport and scales it to fit if needed
 * @param {number} imageWidth - Original image width
 * @param {number} imageHeight - Original image height
 * @returns {Object} {x, y, width, height} - Calculated position and size
 */
function calculateInitialImagePlacement(imageWidth, imageHeight) {
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (!wrapper) {
    // Fallback if wrapper not found
    return {
      x: 100,
      y: 100,
      width: imageWidth,
      height: imageHeight,
    };
  }

  // Get viewport dimensions
  const viewportWidth = wrapper.clientWidth;
  const viewportHeight = wrapper.clientHeight;
  const scrollLeft = wrapper.scrollLeft;
  const scrollTop = wrapper.scrollTop;

  // Calculate maximum size (leave 20% margin on each side)
  const maxWidth = viewportWidth * 0.6;
  const maxHeight = viewportHeight * 0.6;

  // Scale image to fit within max dimensions while maintaining aspect ratio
  let finalWidth = imageWidth;
  let finalHeight = imageHeight;

  if (finalWidth > maxWidth || finalHeight > maxHeight) {
    const widthRatio = maxWidth / finalWidth;
    const heightRatio = maxHeight / finalHeight;
    const scale = Math.min(widthRatio, heightRatio);

    finalWidth = finalWidth * scale;
    finalHeight = finalHeight * scale;
  }

  // Center in viewport
  const centerX = scrollLeft + (viewportWidth - finalWidth) / 2;
  const centerY = scrollTop + (viewportHeight - finalHeight) / 2;

  return {
    x: Math.max(0, centerX),
    y: Math.max(0, centerY),
    width: finalWidth,
    height: finalHeight,
  };
}

/**
 * Handle image import from file system
 */
async function handleInsertImage() {
  try {
    const files = await pickImages(true);
    if (files.length === 0) return;

    // Process images (get original data URLs without downsampling)
    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const dataUrl = await fileToDataUrl(file);

          // Load image to get original dimensions
          const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error("Failed to load image"));
            image.src = dataUrl;
          });

          return {
            success: true,
            dataUrl: dataUrl,
            width: img.width,
            height: img.height,
            fileName: file.name,
          };
        } catch (error) {
          return {
            success: false,
            error: error.message,
            fileName: file.name,
          };
        }
      }),
    );

    // Filter successful results
    const successful = results.filter((r) => r.success);

    if (successful.length > 0) {
      // Add images to note
      successful.forEach((result, index) => {
        // Calculate initial placement (centered in viewport, scaled to fit)
        const placement = calculateInitialImagePlacement(result.width, result.height);

        // Offset multiple images slightly so they don't stack exactly on top of each other
        const offset = index * 30;

        // Create media item with original full-resolution image
        const mediaItem = {
          id: generateId(),
          dataUrl: result.dataUrl, // Original full-resolution image
          originalWidth: result.width, // Store original dimensions
          originalHeight: result.height,
          width: placement.width, // Display dimensions
          height: placement.height,
          x: placement.x + offset,
          y: placement.y + offset,
          rotation: 0,
          createdAt: Date.now(),
        };

        mediaItems.push(mediaItem);
      });

      // Mark note as edited and save
      markNoteEdited();

      // Redraw media canvas
      redrawMedia();
    }

    // Report failures
    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      console.error(`[Image Import] Failed to process ${failed.length} image(s)`);
      failed.forEach((result) => {
        console.error(`[Image Import] ${result.fileName}: ${result.error}`);
      });
    }
  } catch (error) {
    console.error("[Image Import] Error:", error);
  }
}

/**
 * Handle image capture from camera
 */
async function handleInsertCamera() {
  try {
    const file = await captureFromCamera("environment");
    if (!file) return;

    // Get original image data without downsampling
    const dataUrl = await fileToDataUrl(file);

    // Load image to get original dimensions
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Failed to load image"));
      image.src = dataUrl;
    });

    // Calculate initial placement (centered in viewport, scaled to fit)
    const placement = calculateInitialImagePlacement(img.width, img.height);

    // Create media item with original full-resolution image
    const mediaItem = {
      id: generateId(),
      dataUrl: dataUrl, // Original full-resolution image
      originalWidth: img.width, // Store original dimensions
      originalHeight: img.height,
      width: placement.width, // Display dimensions
      height: placement.height,
      x: placement.x,
      y: placement.y,
      rotation: 0,
      createdAt: Date.now(),
    };

    mediaItems.push(mediaItem);

    // Mark note as edited and save
    markNoteEdited();

    // Redraw media canvas
    redrawMedia();
  } catch (error) {
    console.error("[Camera] Error:", error);
  }
}

/**
 * Delete current note
 */
async function deleteCurrentNote() {
  if (!currentNoteData) return;

  const confirmed = await showConfirmDialog(
    "Delete Note",
    `Are you sure you want to delete "${currentNoteData.title}"?`,
    "Delete",
    "btn-danger",
  );

  if (confirmed) {
    await deleteNote(currentNoteData.id);
    // Navigate back to overview
    navigateTo("overview");
    // Trigger data change event to update sidebar
    window.dispatchEvent(new CustomEvent("datachange"));
  }
}

/**
 * Set zoom level
 * @param {number} newZoom - New zoom scale (e.g., 1.0 = 100%, 1.5 = 150%)
 * @param {Object} options - Options for zoom behavior
 * @param {boolean} options.immediate - If true, skip debounced re-render and render immediately (default: false)
 * @param {Object} options.fixedPoint - Point to keep fixed during zoom (in viewport coordinates)
 * @param {number} options.fixedPoint.clientX - X coordinate in viewport
 * @param {number} options.fixedPoint.clientY - Y coordinate in viewport
 * @param {boolean} options.preserveViewport - If true, scale scroll to keep same content visible (for reset zoom)
 */
function setZoom(newZoom, options = {}) {
  const { immediate = false, fixedPoint = null, preserveViewport = false } = options;

  // Store old zoom for calculating scroll adjustment
  const oldZoom = zoomScale;

  // Clamp zoom to valid range
  zoomScale = Math.max(minZoom, Math.min(maxZoom, newZoom));

  // Skip if zoom hasn't changed
  if (zoomScale === oldZoom && !immediate) {
    return;
  }

  // Get wrapper for scroll calculations
  const wrapper = document.querySelector(".editor-content-wrapper");

  // Calculate scroll adjustment
  let newScrollLeft = wrapper ? wrapper.scrollLeft : 0;
  let newScrollTop = wrapper ? wrapper.scrollTop : 0;

  if (preserveViewport && wrapper && oldZoom !== 0) {
    // Scale scroll position proportionally to keep the same content visible at top-left
    // Content at scroll position S at zoom Z is at base coordinate S/Z
    // To show the same base content at new zoom, scroll to S * (newZoom/oldZoom)
    const zoomRatio = zoomScale / oldZoom;
    newScrollLeft = wrapper.scrollLeft * zoomRatio;
    newScrollTop = wrapper.scrollTop * zoomRatio;
  } else if (fixedPoint && wrapper) {
    // Get the fixed point's position relative to the wrapper viewport
    const wrapperRect = wrapper.getBoundingClientRect();
    const viewportX = fixedPoint.clientX - wrapperRect.left;
    const viewportY = fixedPoint.clientY - wrapperRect.top;

    // Calculate the point in content space (base coordinates, unzoomed)
    // Content position = (scroll + viewport offset) / zoom
    const contentX = (wrapper.scrollLeft + viewportX) / oldZoom;
    const contentY = (wrapper.scrollTop + viewportY) / oldZoom;

    // Calculate new scroll position to keep the content point at the same viewport position
    // New scroll = content position * new zoom - viewport offset
    newScrollLeft = contentX * zoomScale - viewportX;
    newScrollTop = contentY * zoomScale - viewportY;
  }

  // Update zoom indicator
  updateZoomIndicator();

  // Handle canvas re-rendering
  if (immediate || !isZoomingGesture) {
    // Immediate re-render: properly sets bitmap, CSS size, and CSS transform
    rerenderCanvasAtNativeZoom();

    // Apply scroll after re-render (dimensions have changed)
    if (wrapper) {
      wrapper.scrollLeft = newScrollLeft;
      wrapper.scrollTop = newScrollTop;
    }
  } else {
    // Preview zoom during gesture: use CSS transform on existing bitmap
    // This is smooth but may be blurry; proper re-render happens after gesture ends
    //
    // The canvas bitmap is currently at: baseSize * currentResolutionScale
    // To achieve visual zoom of zoomScale, we need CSS transform of: zoomScale / currentResolutionScale
    const previewTransformScale = zoomScale / currentResolutionScale;

    // Full-resolution canvases use preview transform based on their current resolution
    const fullResCanvases = [dynamicCanvas, staticCanvas, mediaCanvas];
    fullResCanvases.forEach((cvs) => {
      if (cvs) {
        cvs.style.transformOrigin = "top left";
        cvs.style.transform = `scale(${previewTransformScale})`;
      }
    });

    // Overlay canvas is always at base resolution, so it scales by zoomScale directly
    if (overlayCanvas) {
      overlayCanvas.style.transformOrigin = "top left";
      overlayCanvas.style.transform = `scale(${zoomScale})`;
    }

    // Apply zoom to text editor using CSS transform (text editor is always at base size)
    if (currentEditor) {
      currentEditor.style.transformOrigin = "top left";
      currentEditor.style.transform = `scale(${zoomScale})`;
    }

    // Apply scroll position adjustment
    if (wrapper) {
      wrapper.scrollLeft = newScrollLeft;
      wrapper.scrollTop = newScrollTop;
    }

    // Schedule proper re-render after gesture ends
    scheduleZoomRerender();
  }
}

/**
 * Schedule a debounced canvas re-render at native zoom resolution
 * Called during zoom gestures to avoid re-rendering on every frame
 */
function scheduleZoomRerender() {
  // Clear any existing timer
  if (zoomRerenderTimer) {
    clearTimeout(zoomRerenderTimer);
  }

  // Schedule re-render after debounce period
  zoomRerenderTimer = setTimeout(() => {
    rerenderCanvasAtNativeZoom();
    zoomRerenderTimer = null;
  }, ZOOM_RERENDER_DEBOUNCE);
}

/**
 * Re-render canvas at native zoom resolution
 * This is called after zoom changes to ensure crisp rendering
 *
 * Strategy:
 * 1. During preview zoom: CSS transform handles scaling visually (smooth but blurry)
 * 2. After gesture: Re-render canvas at higher bitmap resolution, then REMOVE CSS transform
 *
 * The key insight is that preview zoom uses CSS transform, but final rendering
 * uses bitmap resolution scaling. We must remove the CSS transform after re-rendering
 * to avoid double-scaling.
 *
 * CSS size of canvas = baseCanvasWidth * zoomScale (to match the zoomed view)
 * Bitmap resolution = baseCanvasWidth * resolutionScale (for crisp rendering)
 * Context transform = resolutionScale (to draw at higher resolution)
 * CSS transform = none (removed after re-render, handled by CSS size)
 */
function rerenderCanvasAtNativeZoom() {
  if (!dynamicCanvas || !staticCtx || baseCanvasWidth === 0 || baseCanvasHeight === 0) {
    console.warn("[Zoom] Cannot re-render: base canvas dimensions not initialized");
    return;
  }

  console.log("[Zoom] Re-rendering canvas at native resolution for zoom:", zoomScale);

  // Optimized for vertical scrolling: narrow width, tall height
  const maxCanvasWidth = 2000;
  const maxCanvasHeight = 25000;

  // Calculate the maximum resolution scale we can use without exceeding canvas limits
  const maxResolutionScaleW = maxCanvasWidth / baseCanvasWidth;
  const maxResolutionScaleH = maxCanvasHeight / baseCanvasHeight;
  const maxResolutionScale = Math.min(maxResolutionScaleW, maxResolutionScaleH);

  // For zoom > 1.0: increase bitmap resolution for crisp rendering (up to max)
  // For zoom <= 1.0: use base resolution (bitmap stays at base size)
  // In both cases, CSS transform handles the final visual scaling
  const desiredResolutionScale = Math.max(1.0, zoomScale);
  const actualResolutionScale = Math.min(desiredResolutionScale, maxResolutionScale);

  // Store the resolution scale for preview zoom calculations
  currentResolutionScale = actualResolutionScale;

  // Calculate bitmap dimensions (always >= base size)
  const bitmapWidth = Math.round(baseCanvasWidth * actualResolutionScale);
  const bitmapHeight = Math.round(baseCanvasHeight * actualResolutionScale);

  // CSS transform handles the visual zoom:
  // - For zoom > 1 and within bitmap capacity: cssTransformScale ≈ 1 (bitmap handles it)
  // - For zoom > 1 beyond bitmap capacity: cssTransformScale > 1 (CSS scales up)
  // - For zoom < 1: cssTransformScale < 1 (CSS scales down)
  const cssTransformScale = zoomScale / actualResolutionScale;

  // CSS size = bitmap size (no stretching between bitmap and CSS)
  const cssWidth = bitmapWidth;
  const cssHeight = bitmapHeight;

  // Apply CSS transform if scale is not 1.0 (either scaling up or down)
  const needsCssTransform = Math.abs(cssTransformScale - 1.0) > 0.001;

  console.log("[Zoom] Base canvas dimensions:", baseCanvasWidth, "x", baseCanvasHeight);
  console.log("[Zoom] Zoom scale:", zoomScale, "Resolution scale:", actualResolutionScale);
  console.log(
    "[Zoom] Bitmap:",
    bitmapWidth,
    "x",
    bitmapHeight,
    "CSS transform:",
    cssTransformScale,
  );

  // Update full-resolution canvas dimensions
  const fullResCanvases = [dynamicCanvas, staticCanvas, mediaCanvas];

  fullResCanvases.forEach((cvs) => {
    if (cvs) {
      // Update bitmap resolution
      cvs.width = bitmapWidth;
      cvs.height = bitmapHeight;

      // Set CSS size to match bitmap (1:1, no stretching)
      cvs.style.width = `${cssWidth}px`;
      cvs.style.height = `${cssHeight}px`;

      // Apply CSS transform for visual zoom (both scaling up and down)
      cvs.style.transformOrigin = "top left";
      if (needsCssTransform) {
        cvs.style.transform = `scale(${cssTransformScale})`;
      } else {
        cvs.style.transform = "none";
      }
    }
  });

  // Overlay canvas stays at base resolution (no zoom scaling on bitmap)
  if (overlayCanvas) {
    overlayCanvas.width = baseCanvasWidth;
    overlayCanvas.height = baseCanvasHeight;
    overlayCanvas.style.width = `${baseCanvasWidth}px`;
    overlayCanvas.style.height = `${baseCanvasHeight}px`;
    // Overlay uses CSS transform to match visual size
    overlayCanvas.style.transformOrigin = "top left";
    overlayCanvas.style.transform = `scale(${zoomScale})`;
  }

  // Text editor still uses CSS transform for scaling (it doesn't have bitmap resolution)
  if (currentEditor) {
    currentEditor.style.transformOrigin = "top left";
    currentEditor.style.transform = `scale(${zoomScale})`;
  }

  // Context transform scales drawing from base coordinates to bitmap coordinates
  const contextScale = actualResolutionScale;

  [staticCtx, dynamicCtx, mediaCtx].forEach((ctx) => {
    if (ctx) {
      ctx.setTransform(contextScale, 0, 0, contextScale, 0, 0);
    }
  });

  // Overlay context uses identity transform (always at base resolution)
  if (overlayCtx) {
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Redraw all canvas content at the new resolution
  redrawBackground();
  redrawCanvas();
  redrawMedia();

  // Re-apply stroke highlighting if active
  if (activeSearchQuery) {
    console.log("[NotebookEditor] Re-applying highlights after zoom re-render");
    highlightStrokes(activeSearchQuery);
  }

  console.log(
    "[Zoom] Canvas re-rendered - bitmap:",
    bitmapWidth,
    "x",
    bitmapHeight,
    "CSS:",
    cssWidth,
    "x",
    cssHeight,
  );
}

/**
 * Adjust zoom by a delta amount
 * @param {number} delta - Amount to change zoom (e.g., 0.1 for +10%, -0.1 for -10%)
 * @param {Object} options - Options passed to setZoom
 */
function adjustZoom(delta, options = {}) {
  setZoom(zoomScale + delta, options);
}

/**
 * Update zoom level indicator in toolbar
 */
function updateZoomIndicator() {
  const indicator = document.getElementById("zoom-level");
  if (indicator) {
    indicator.textContent = `${Math.round(zoomScale * 100)}%`;
  }
}

/**
 * Update content bounds tracking for overflow handling
 */
function updateContentBounds() {
  if (!dynamicCanvas || !currentEditor) return;

  // Calculate minimum canvas dimensions needed to show all content
  // Start from 0 and find the actual content bounds
  let maxX = 0;
  let maxY = 0;

  // Check all strokes to find the extent
  for (const stroke of strokes) {
    if (stroke.x && stroke.y) {
      for (let i = 0; i < stroke.x.length; i++) {
        maxX = Math.max(maxX, stroke.x[i] + 50); // Add padding
        maxY = Math.max(maxY, stroke.y[i] + 50);
      }
    }
  }

  // Check all media items to find the extent
  for (const media of mediaItems) {
    if (media.position && media.size) {
      maxX = Math.max(maxX, media.position.x + media.size.width + 50);
      maxY = Math.max(maxY, media.position.y + media.size.height + 50);
    }
  }

  // Update minimum dimensions (the actual content bounds)
  minCanvasWidth = maxX;
  minCanvasHeight = maxY;

  // Expand canvas if needed
  if (dynamicCanvas.width < minCanvasWidth) {
    const wrapper = dynamicCanvas.parentElement;
    const rect = wrapper.getBoundingClientRect();

    const newWidth = Math.max(minCanvasWidth, rect.width);
    dynamicCanvas.width = staticCanvas.width = mediaCanvas.width = newWidth;

    redrawBackground(); // Redraw background after canvas resize clears it
    redrawCanvas();
  }
}

/**
 * Initialize zoom event listeners (CTRL+wheel and pinch gestures)
 */
function initZoomListeners() {
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (!wrapper) return;

  // Debounced scroll handler for lazy loading media
  let scrollTimeout = null;
  let cleanupTimeout = null;
  wrapper.addEventListener("scroll", () => {
    if (scrollTimeout) {
      clearTimeout(scrollTimeout);
    }
    scrollTimeout = setTimeout(() => {
      // Trigger lazy loading check on scroll
      redrawMedia();
    }, 100); // 100ms debounce

    // Cleanup memory less frequently (every 2 seconds of idle)
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
    }
    cleanupTimeout = setTimeout(() => {
      cleanupMediaMemory();
    }, 2000); // 2 second debounce for cleanup
  });

  // CTRL + Mouse wheel zoom (Windows/Desktop)
  let wheelZoomEndTimer = null;
  wrapper.addEventListener(
    "wheel",
    (e) => {
      // Only zoom with CTRL key pressed
      if (e.ctrlKey) {
        e.preventDefault();

        // Mark as zooming gesture for debounced re-render
        isZoomingGesture = true;

        // wheelDelta is positive for zoom in, negative for zoom out
        const delta = e.deltaY < 0 ? zoomStep : -zoomStep;
        const newZoom = zoomScale + delta;

        // Zoom around mouse cursor position
        setZoom(newZoom, {
          fixedPoint: {
            clientX: e.clientX,
            clientY: e.clientY,
          },
        });

        // Clear existing end timer and set new one
        if (wheelZoomEndTimer) {
          clearTimeout(wheelZoomEndTimer);
        }
        wheelZoomEndTimer = setTimeout(() => {
          isZoomingGesture = false;
          // Trigger lazy loading check after zoom
          redrawMedia();
          wheelZoomEndTimer = null;
        }, ZOOM_RERENDER_DEBOUNCE + 50);
      }
    },
    { passive: false },
  );

  // Touch event listeners for pinch-to-zoom (Android/Mobile)
  wrapper.addEventListener(
    "touchstart",
    (e) => {
      // Only handle pinch gestures (2 fingers)
      if (e.touches.length === 2) {
        e.preventDefault();

        // Mark as zooming gesture for debounced re-render
        isZoomingGesture = true;

        // Calculate initial distance between fingers
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
        initialPinchZoom = zoomScale;

        // Store the center point between fingers
        pinchCenter = {
          clientX: (touch1.clientX + touch2.clientX) / 2,
          clientY: (touch1.clientY + touch2.clientY) / 2,
        };

        console.log("Pinch zoom started:", { lastTouchDistance, initialPinchZoom, pinchCenter });
      }
    },
    { passive: false },
  );

  wrapper.addEventListener(
    "touchmove",
    (e) => {
      // Handle pinch gesture
      if (e.touches.length === 2 && lastTouchDistance !== null) {
        e.preventDefault();

        // Calculate current distance between fingers
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        const currentDistance = Math.sqrt(dx * dx + dy * dy);

        // Calculate zoom based on pinch distance change
        const pinchScale = currentDistance / lastTouchDistance;
        const newZoom = initialPinchZoom * pinchScale;

        // Zoom around the center point between fingers
        setZoom(newZoom, {
          fixedPoint: pinchCenter,
        });
      }
      // Single finger scroll - allow default behavior (scrolling)
      // This is handled by the browser automatically
    },
    { passive: false },
  );

  wrapper.addEventListener("touchend", (e) => {
    // Reset pinch tracking when fingers are lifted
    if (e.touches.length < 2) {
      if (lastTouchDistance !== null) {
        // Mark gesture as ended
        isZoomingGesture = false;

        // Trigger final re-render at native resolution
        rerenderCanvasAtNativeZoom();

        // Trigger lazy loading check after zoom ends
        redrawMedia();
      }
      lastTouchDistance = null;
      initialPinchZoom = null;
      pinchCenter = null;
    }
  });

  wrapper.addEventListener("touchcancel", () => {
    // Reset pinch tracking on cancel
    lastTouchDistance = null;
    initialPinchZoom = null;
    pinchCenter = null;
    isZoomingGesture = false;
  });
}

/**
 * Schedule a debounced save - multiple rapid calls will only result in one save
 * Runs completely asynchronously without blocking drawing operations
 */
function scheduleSave() {
  // 1. Debounce Logic: Always schedule a save for after the user stops writing.
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }
  saveDebounceTimer = setTimeout(() => {
    saveNoteContent().catch((err) => console.error("Debounced save failed:", err));
    lastSaveTime = Date.now(); // Record the time of this save
  }, SAVE_DEBOUNCE_MS);

  // 2. Throttle Logic: If it's been too long since the last save, save now.
  const now = Date.now();
  if (now - lastSaveTime > SAVE_THROTTLE_MS) {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer); // Clear the pending debounce timer
      saveDebounceTimer = null;
    }
    // This save happens immediately, not in a timeout.
    saveNoteContent().catch((err) => console.error("Throttled save failed:", err));
    lastSaveTime = now; // Record the time of this immediate save
  }
}

function markNoteEdited() {
  noteEditedSinceOpen = true;
}

/**
 * Save note content immediately (without debouncing)
 */
async function saveNoteContent(noteIdOverride = null) {
  const noteId = noteIdOverride || getCurrentNoteId();
  if (!noteId || !currentEditor) return;

  // Prevent re-entrant saves and data-change echos
  if (isSaving) return;

  const hadHighlights =
    activeSearchQuery && currentEditor.querySelector('span[style*="background-color: yellow"]');

  try {
    isSaving = true;

    // Temporarily remove highlights before saving
    if (hadHighlights) {
      removeTextHighlights();
    }

    // Convert HTML back to markdown (simplified)
    const htmlContent = currentEditor.innerHTML;
    const markdownContent = htmlToMarkdown(htmlContent);

    // Prepare media items for storage (strip transient properties)
    const mediaForStorage = mediaItems.map((item) => ({
      id: item.id,
      dataUrl: item.dataUrl,
      width: item.width,
      height: item.height,
      x: item.x,
      y: item.y,
      rotation: item.rotation,
      createdAt: item.createdAt,
    }));

    // Update note with content, strokes, deleted stroke IDs, media, and background setting
    await updateNote(noteId, {
      content: markdownContent,
      strokes: strokes,
      deletedStrokes: deletedStrokes,
      media: mediaForStorage,
      deletedMedia: deletedMedia,
      background: currentNoteData?.background || "none",
      modified: Date.now(),
    });

    // Check note size and warn if too large
    checkNoteSizeAndWarn(markdownContent, strokes, mediaForStorage);

    // Note: We no longer trigger sync while note is open
    // Sync will happen when the note is closed via cleanupNotebookEditor()

    console.log("Note saved");
  } catch (error) {
    console.error("Error saving note:", error);
  } finally {
    isSaving = false; // Ensure the lock is always released
    // Re-apply highlights if they were removed
    if (hadHighlights) {
      highlightText(activeSearchQuery);
    }
  }
}

// Markdown conversion functions are now imported from ../utils/markdown.js

/**
 * Check note size and warn user if it's too large
 * @param {string} content - Markdown content
 * @param {Array} strokes - Drawing strokes
 * @param {Array} media - Media items
 */
function checkNoteSizeAndWarn(content, strokes, media) {
  // Calculate approximate size in bytes
  const contentSize = new Blob([content]).size;
  const strokesSize = new Blob([JSON.stringify(strokes)]).size;
  const mediaSize = new Blob([JSON.stringify(media)]).size;
  const totalSize = contentSize + strokesSize + mediaSize;

  // Convert to MB
  const totalSizeMB = totalSize / (1024 * 1024);

  // Warn if note exceeds 50MB
  const WARNING_SIZE_MB = 50;
  const CRITICAL_SIZE_MB = 100;

  if (totalSizeMB > CRITICAL_SIZE_MB) {
    console.warn(
      `[Media] ⚠️ CRITICAL: Note size is ${totalSizeMB.toFixed(1)}MB. This may cause sync issues and slow performance. Consider splitting into multiple notes.`,
    );
    // Show browser alert for critical size (only once per session per note)
    if (!window._shownCriticalSizeWarning) {
      window._shownCriticalSizeWarning = true;
      setTimeout(() => {
        alert(
          `⚠️ Warning: This note is very large (${totalSizeMB.toFixed(1)}MB).\n\nLarge notes may:\n• Sync slowly\n• Cause performance issues\n• Exceed storage limits\n\nConsider splitting it into multiple notes.`,
        );
      }, 100);
    }
  } else if (totalSizeMB > WARNING_SIZE_MB) {
    console.warn(
      `[Media] ⚠️ Note size is ${totalSizeMB.toFixed(1)}MB (warning threshold). Consider optimizing images or splitting content.`,
    );
  }

  // Log media breakdown if there are images
  if (media.length > 0) {
    const mediaSizeMB = mediaSize / (1024 * 1024);
    console.log(
      `[Media] Note contains ${media.length} image(s), total media size: ${mediaSizeMB.toFixed(1)}MB`,
    );
  }
}

/**
 * Removes highlight spans from the text editor, preserving the text.
 */
function removeTextHighlights() {
  if (!currentEditor) return;
  const highlights = currentEditor.querySelectorAll('span[style*="background-color: yellow"]');
  highlights.forEach((span) => {
    const parent = span.parentNode;
    if (parent) {
      while (span.firstChild) {
        parent.insertBefore(span.firstChild, span);
      }
      parent.removeChild(span);
      parent.normalize(); // Merges adjacent text nodes
    }
  });
}

/**
 * Update editor content after external changes (e.g., sync) while preserving state.
 * @param {string} noteId - The ID of the note to update.
 */
async function updateEditorContent(noteId) {
  if (!noteId || !currentNoteData || noteId !== currentNoteData.id) {
    return; // Should not happen if called from the event listener, but good practice
  }

  // 1. Preserve state (scroll and zoom) and a copy of local data
  const wrapper = document.querySelector(".editor-content-wrapper");
  const scrollLeft = wrapper ? wrapper.scrollLeft : 0;
  const scrollTop = wrapper ? wrapper.scrollTop : 0;
  const currentZoom = zoomScale;
  const localStrokes = [...strokes];
  const localDeletedStrokeIds = new Set(deletedStrokes);

  // 2. Reload data from storage
  const newNoteData = await getNote(noteId);
  if (!newNoteData) {
    console.log(`Note ${noteId} not found after sync. Navigating away.`);
    cleanupNotebookEditor();
    navigateTo("overview"); // Navigate to a safe place
    return;
  }

  // Set default background for existing notes without one
  if (!newNoteData.background) {
    newNoteData.background = "none";
  }

  currentNoteData = newNoteData;

  // 3. Re-render text content if it has changed
  if (currentEditor) {
    const currentHtmlContent = currentEditor.innerHTML;
    const newHtmlContent = markdownToHtml(newNoteData.content);
    if (currentHtmlContent !== newHtmlContent) {
      currentEditor.innerHTML = newHtmlContent;
      if (activeSearchQuery) {
        highlightText(activeSearchQuery);
      }
    }
  }

  // 4. Merge strokes to prevent data loss from race conditions
  if (dynamicCanvas) {
    const newStrokes = newNoteData.strokes || [];
    const newDeletedStrokeIds = new Set(newNoteData.deletedStrokes || []);
    const strokeMap = new Map();

    // Add local strokes to the map, respecting deletions from the sync
    for (const stroke of localStrokes) {
      if (stroke.id && !newDeletedStrokeIds.has(stroke.id)) {
        strokeMap.set(stroke.id, stroke);
      }
    }

    // Add/overwrite with strokes from the sync
    for (const stroke of newStrokes) {
      if (stroke.id) {
        strokeMap.set(stroke.id, stroke);
      }
    }

    // Ensure the currently-being-drawn stroke is preserved
    if (
      isDrawing &&
      currentStroke &&
      currentStroke.id &&
      !newDeletedStrokeIds.has(currentStroke.id)
    ) {
      strokeMap.set(currentStroke.id, { ...currentStroke });
    }

    const mergedStrokes = Array.from(strokeMap.values());
    mergedStrokes.sort((a, b) => (a.time?.[0] || 0) - (b.time?.[0] || 0));

    // Update main state
    strokes = mergedStrokes;
    deletedStrokes = Array.from(new Set([...localDeletedStrokeIds, ...newDeletedStrokeIds]));
    console.log(`[NotebookEditor] Strokes merged. New total count: ${strokes.length}`);

    // Recalculate content bounds and redraw everything
    updateContentBounds();
    resizeCanvas();
  }

  // 5. Restore state
  setZoom(currentZoom);
  if (wrapper) {
    requestAnimationFrame(() => {
      wrapper.scrollLeft = scrollLeft;
      wrapper.scrollTop = scrollTop;
    });
  }

  console.log("Notebook editor content updated and state preserved via merge.");
}

/**
 * Cleanup editor
 * @param {string} noteIdOverride - Optional noteId to use (when router has already cleared it)
 */
export async function cleanupNotebookEditor(noteIdOverride = null) {
  const noteId = noteIdOverride || getCurrentNoteId();

  // Before anything else, check if there's an un-ended stroke and commit it.
  // This handles the case where the user navigates away mid-stroke.
  if (isDrawing && currentStroke && currentStroke.x && currentStroke.x.length > 1) {
    console.log("[NotebookEditor] Committing in-progress stroke on cleanup.");
    strokes.push({ ...currentStroke });
    markNoteEdited();
  }

  // Clear any pending debounced saves since we're doing an immediate save now
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
  }

  // SEQUENCE ON CLOSE:
  // 0. Optimize media images to 2x display size to reduce storage
  if (noteId && mediaItems.length > 0) {
    try {
      console.log(
        `[NotebookEditor] Step 0: Optimizing ${mediaItems.length} media items for storage...`,
      );
      let optimizedCount = 0;

      for (const item of mediaItems) {
        // Optimize to 2x display size
        const optimized = await optimizeImageForDisplay(item.dataUrl, item.width, item.height);

        // Only update if optimization actually changed the image
        if (optimized.dataUrl !== item.dataUrl) {
          item.dataUrl = optimized.dataUrl;
          item.originalWidth = optimized.width;
          item.originalHeight = optimized.height;
          optimizedCount++;
        }
      }

      if (optimizedCount > 0) {
        console.log(`[NotebookEditor] Optimized ${optimizedCount} images for storage`);
        markNoteEdited(); // Ensure optimized images get saved
      }
    } catch (error) {
      console.error("Failed to optimize media during cleanup:", error);
    }
  }

  // 1. Persist strokes to storage (await to ensure completion)
  if (noteId && currentEditor && noteEditedSinceOpen) {
    try {
      console.log("[NotebookEditor] Step 1: Persisting strokes on close...");
      await saveNoteContent(noteId);
    } catch (error) {
      console.error("Failed to save note during cleanup:", error);
    }
  }

  // 2. Trigger handwriting recognition (await to ensure completion)
  if (noteId && strokes && strokes.length > 0 && noteEditedSinceOpen) {
    try {
      console.log(
        `[NotebookEditor] Step 2: Sending ${strokes.length} total strokes to recognition...`,
      );
      await forceRecognition(noteId, strokes);
    } catch (err) {
      console.warn("Recognition on close failed. Reason:", err);
      // Add more detail in case the default err.toString() is not useful
      if (err instanceof Error) {
        console.warn(`Error details: name=${err.name}, message=${err.message}`);
      } else {
        try {
          console.warn("Full error object:", JSON.stringify(err, null, 2));
        } catch {
          console.warn("Could not stringify the error object.");
        }
      }
    }
  }

  // 3. Trigger sync in background (don't await - let it run async)
  if (noteId && noteEditedSinceOpen) {
    console.log("[NotebookEditor] Step 3: Triggering sync in background...");
    stopInactivityTimer();
    syncOnNoteClose(noteId).catch((err) => console.error("Background sync failed:", err));
  }

  if (dynamicCanvas) {
    window.removeEventListener("resize", throttledResizeCanvas);
  }

  // Remove global listener
  document.removeEventListener("pointerdown", handleOutsideClick);

  // Re-enable scrolling in case it was disabled
  preventScrollDuringMediaManipulation(false);

  currentEditor = null;
  currentNoteData = null;

  dynamicCanvas = null;
  dynamicCtx = null;
  staticCanvas = null;
  staticCtx = null;
  mediaCanvas = null;
  mediaCtx = null;
  overlayCanvas = null;
  overlayCtx = null;
  canvasRect = null;

  strokes = [];
  deletedStrokes = [];
  mediaItems = [];
  deletedMedia = [];
  selectedMediaId = null;
  mediaTransformState = null;
  currentStroke = [];
  isDrawing = false;
  isDrawMode = false;
  isEraserMode = false;
  isLassoMode = false;
  selectionBounds = null;
  isTransforming = false;
  transformMode = null;
  clipboardStrokes = null;
  activeSearchQuery = null;
  noteEditedSinceOpen = false;
  pendingExternalRefresh = false;
}
/**
 * Highlight search terms in text and strokes
 * @param {string} query - Search query
 */
function highlightSearchTerms(query) {
  highlightText(query);
  highlightStrokes(query);
}

/**
 * Highlight search terms in text editor
 * @param {string} query - Search query
 */
function highlightText(query) {
  if (!query || !currentEditor) return;
  // Clear prior highlights to avoid nested spans and DOM bloat.
  removeTextHighlights();
  console.log("[NotebookEditor] Highlighting text for:", query);
  console.log("[NotebookEditor] Editor text content length:", currentEditor.innerText?.length || 0);

  // Create regex pattern from query with wildcard support
  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escapeRegex(query).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  const regex = new RegExp(pattern, "gi");

  const walker = document.createTreeWalker(currentEditor, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  console.log(`[NotebookEditor] Found ${nodes.length} text nodes to check`);

  nodes.forEach((node) => {
    if (
      node.parentNode &&
      node.parentNode.nodeName !== "SCRIPT" &&
      node.parentNode.nodeName !== "STYLE"
    ) {
      regex.lastIndex = 0; // Ensure regex is reset before test
      const text = node.nodeValue;
      // Check if node contains match
      if (regex.test(text)) {
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        regex.lastIndex = 0; // Reset regex state
        let match = regex.exec(text);
        while (match !== null) {
          if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
          }
          const span = document.createElement("span");
          span.style.backgroundColor = "yellow";
          span.style.color = "black";
          span.textContent = match[0];
          fragment.appendChild(span);
          lastIndex = match.index + match[0].length;
          match = regex.exec(text);
        }
        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
        }
        node.parentNode.replaceChild(fragment, node);
      }
    }
  });
}

/**
 * Highlight search terms in strokes (on overlay canvas)
 * @param {string} query - Search query
 */
function highlightStrokes(query) {
  if (!query || !currentNoteData?.recognition?.words || !overlayCtx) {
    // Clear previous highlights if query is cleared
    if (overlayCtx) {
      clearCanvas(overlayCtx, overlayCanvas);
    }
    return;
  }
  console.log(
    "[NotebookEditor] Highlighting strokes for:",
    query,
    "Word count:",
    currentNoteData.recognition.words.length,
  );

  // Create regex pattern from query with wildcard support
  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escapeRegex(query).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
  const regex = new RegExp(pattern, "gi");

  // Clear previous highlights (overlay canvas is shared with cursor)
  clearCanvas(overlayCtx, overlayCanvas);

  let matchCount = 0;
  overlayCtx.save();
  overlayCtx.fillStyle = "rgba(255, 255, 0, 0.3)";
  overlayCtx.strokeStyle = "rgba(255, 200, 0, 0.8)";
  overlayCtx.lineWidth = 2;

  currentNoteData.recognition.words.forEach((word) => {
    regex.lastIndex = 0; // Ensure regex is reset before test
    if (word.text && regex.test(word.text)) {
      matchCount++;

      regex.lastIndex = 0; // Reset for next test

      // Support multiple structures for bounding box (nested or flat), prioritizing boundingRect
      const box = word.boundingRect || word.boundingBox || word.rect || word;

      if (!box) {
        console.warn("[NotebookEditor] Missing bounding box for word:", word.text);
        return;
      }

      // Handle potential property variations (x/y vs left/top)
      const x = box.x !== undefined ? box.x : box.left;
      const y = box.y !== undefined ? box.y : box.top;
      const w = box.width !== undefined ? box.width : box.w;
      const h = box.height !== undefined ? box.height : box.h;

      if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
        console.log("[NotebookEditor] Highlighting match:", word.text, { x, y, w, h });
        overlayCtx.fillRect(x, y, w, h);
        overlayCtx.strokeRect(x, y, w, h);
      } else {
        console.warn(
          "[NotebookEditor] Could not determine bounding box dimensions for word:",
          word.text,
          "Object:",
          box,
        );
      }
    }
  });
  overlayCtx.restore();
  console.log(`[NotebookEditor] Finished highlighting. Matches found: ${matchCount}`);
}
