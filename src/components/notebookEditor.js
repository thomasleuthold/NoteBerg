/**
 * Notebook Editor Component
 * Layered canvas approach with text editor and drawing layer
 * Auto-detects input type (stylus vs mouse) for mode switching
 */

import { forceRecognition } from "../modules/autoRecognition.js";
import { resetInactivityTimer, stopInactivityTimer, syncOnNoteClose } from "../modules/autoSync.js";
import { getCurrentNoteId, navigateTo } from "../modules/router.js";
import { deleteNote, generateId, getNote, updateNote } from "../modules/storage.js";
import { getTheme } from "../modules/theme.js";
import { getIcon } from "../utils/icons.js";
import { pickImages, captureFromCamera, processImageFiles } from "../utils/imageUtils.js";
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

// Layered Canvases
let staticCanvas = null; // For completed strokes
let staticCtx = null;
let highlightCanvas = null; // For search highlights
let highlightCtx = null;
let dynamicCanvas = null; // For active drawing
let dynamicCtx = null;
let backgroundCanvas = null;
let backgroundCtx = null;
let cursorCanvas = null;
let cursorCtx = null;
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

// Zoom state
let zoomScale = 1.0; // Current zoom level (1.0 = 100%)
const minZoom = 0.5; // Minimum zoom (50%)
const maxZoom = 3.0; // Maximum zoom (300%)
const zoomStep = 0.1; // Zoom increment per step

// Gesture tracking for pinch-to-zoom
let lastTouchDistance = null;
let initialPinchZoom = null;

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
      if (isDrawing || isErasing || isLassoing || isTransforming) {
        pendingExternalRefresh = true;
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
    setZoom(1.0);

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
            <div class="toolbar-divider"></div>
            <button class="toolbar-btn" id="insert-image-btn" title="Insert image">
              ${icons.image}
            </button>
            <button class="toolbar-btn" id="insert-camera-btn" title="Take photo">
              ${icons.camera}
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
        <canvas id="background-canvas" class="background-canvas" style="position: absolute; top: 0; left: 0; z-index: 1;"></canvas>
        <canvas id="static-canvas" class="static-canvas" style="position: absolute; top: 0; left: 0; z-index: 2;"></canvas>
        <canvas id="highlight-canvas" class="highlight-canvas" style="position: absolute; top: 0; left: 0; z-index: 3; pointer-events: none;"></canvas>
        <canvas id="dynamic-canvas" class="dynamic-canvas" style="position: absolute; top: 0; left: 0; z-index: 4;"></canvas>
        <canvas id="cursor-canvas" class="cursor-canvas" style="position: absolute; top: 0; left: 0; z-index: 5; pointer-events: none;"></canvas>
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

  currentEditor = textEditor;
}

/**
 * Initialize canvas layer for drawing
 */
function initCanvasLayer(noteData) {
  // Setup all canvas layers
  backgroundCanvas = document.getElementById("background-canvas");
  staticCanvas = document.getElementById("static-canvas");
  highlightCanvas = document.getElementById("highlight-canvas");
  dynamicCanvas = document.getElementById("dynamic-canvas");
  cursorCanvas = document.getElementById("cursor-canvas");

  if (!backgroundCanvas || !staticCanvas || !highlightCanvas || !dynamicCanvas || !cursorCanvas) {
    console.error("One or more canvas layers are missing from the DOM.");
    return;
  }

  backgroundCtx = backgroundCanvas.getContext("2d");
  staticCtx = staticCanvas.getContext("2d");
  highlightCtx = highlightCanvas.getContext("2d");
  dynamicCtx = dynamicCanvas.getContext("2d");
  cursorCtx = cursorCanvas.getContext("2d");

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

  requestAnimationFrame(() => {
    resizeCanvas();
    redrawCanvas(); // This will now draw to the static canvas
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
  if (
    !dynamicCanvas ||
    !staticCanvas ||
    !backgroundCanvas ||
    !cursorCanvas ||
    !highlightCanvas ||
    !currentEditor
  )
    return;

  const wrapper = dynamicCanvas.parentElement;
  const rect = wrapper.getBoundingClientRect();

  // Cache the bounding rect for coordinate calculations
  canvasRect = dynamicCanvas.getBoundingClientRect();

  const baseWidth = rect.width / zoomScale;
  const baseHeight = rect.height / zoomScale;

  // Don't use scrollHeight with CSS transforms - it's unreliable
  // Instead, use the wrapper dimensions and minimum bounds from content
  const requiredHeight = Math.max(
    baseHeight,
    minCanvasHeight,
    dynamicCanvas.height, // Keep current canvas height to prevent shrinking
    800,
  );
  const requiredWidth = Math.max(baseWidth, minCanvasWidth, 800);

  // Prevent excessive canvas sizes that could cause performance issues
  const maxCanvasSize = 10000;
  const safeWidth = Math.min(requiredWidth, maxCanvasSize);
  const safeHeight = Math.min(requiredHeight, maxCanvasSize);

  // Only resize if dimensions actually changed significantly
  const widthChanged = Math.abs(dynamicCanvas.width - safeWidth) > 1;
  const heightChanged = Math.abs(dynamicCanvas.height - safeHeight) > 1;

  if (widthChanged || heightChanged) {
    // Resize all canvases
    const canvases = [dynamicCanvas, staticCanvas, backgroundCanvas, cursorCanvas, highlightCanvas];
    canvases.forEach((cvs) => {
      cvs.width = safeWidth;
      cvs.height = safeHeight;
      cvs.style.width = `${safeWidth}px`;
      cvs.style.height = `${safeHeight}px`;
    });

    if (currentEditor) {
      currentEditor.style.minWidth = `${safeWidth}px`;
      currentEditor.style.minHeight = `${safeHeight}px`;
    }

    // Redraw both background and strokes after resize (canvas is cleared when dimensions change)
    redrawBackground();
    redrawCanvas();

    // Re-apply stroke highlighting if active
    if (activeSearchQuery) {
      console.log("[NotebookEditor] Re-applying highlights after resize");
      highlightStrokes(activeSearchQuery);
    }
  }
}

/**
 * Expand canvas height by a specified amount
 * @param {number} additionalHeight - Height to add in pixels (in unscaled space)
 */
function expandCanvas(additionalHeight) {
  const canvases = [dynamicCanvas, staticCanvas, backgroundCanvas, cursorCanvas, highlightCanvas];
  if (canvases.some((c) => !c)) return;

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
    background: document.createElement("canvas"),
    highlight: document.createElement("canvas"),
  };

  tempCanvases.dynamic.width =
    tempCanvases.static.width =
    tempCanvases.background.width =
    tempCanvases.highlight.width =
      dynamicCanvas.width;
  tempCanvases.dynamic.height =
    tempCanvases.static.height =
    tempCanvases.background.height =
    tempCanvases.highlight.height =
      dynamicCanvas.height;

  tempCanvases.dynamic.getContext("2d").drawImage(dynamicCanvas, 0, 0);
  tempCanvases.static.getContext("2d").drawImage(staticCanvas, 0, 0);
  tempCanvases.background.getContext("2d").drawImage(backgroundCanvas, 0, 0);
  tempCanvases.highlight.getContext("2d").drawImage(highlightCanvas, 0, 0);

  // Resize all canvases
  canvases.forEach((cvs) => {
    cvs.width = newWidth;
    cvs.height = newHeight;
    cvs.style.width = `${newWidth}px`;
    cvs.style.height = `${newHeight}px`;
  });

  // Restore the content without expensive redraw
  dynamicCtx.drawImage(tempCanvases.dynamic, 0, 0);
  staticCtx.drawImage(tempCanvases.static, 0, 0);
  backgroundCtx.drawImage(tempCanvases.background, 0, 0);
  highlightCtx.drawImage(tempCanvases.highlight, 0, 0);

  // Draw background pattern on newly expanded area
  drawBackgroundExpansion(tempCanvases.background.height, newHeight);

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

  const x = clientX - canvasRect.left;
  const y = clientY - canvasRect.top;
  const scaleX = dynamicCanvas.width / canvasRect.width;
  const scaleY = dynamicCanvas.height / canvasRect.height;

  return { x: x * scaleX, y: y * scaleY };
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

  if (!isDrawMode) return true;

  // --- Cache canvas rect and context settings ---
  canvasRect = dynamicCanvas.getBoundingClientRect();
  const palette = getThemePalette();

  // --- Eraser Activation (Stateful approach) ---
  const isEraser = isEraserMode || isEraserEvent(e);
  const { x, y } = getCanvasCoordinates(e);

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
    dynamicCtx.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height);
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
 * Draw the lasso path on the cursor canvas
 */
function drawLassoPath() {
  if (!cursorCtx || lassoPoints.length < 2) return;

  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  cursorCtx.strokeStyle = "rgba(0, 100, 255, 0.8)";
  cursorCtx.lineWidth = 2;
  cursorCtx.setLineDash([5, 5]); // Dashed line for selection
  cursorCtx.beginPath();
  cursorCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);

  for (let i = 1; i < lassoPoints.length; i++) {
    cursorCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
  }

  cursorCtx.stroke();
  cursorCtx.setLineDash([]); // Reset line dash
}

/**
 * Handle canvas pointer up
 */
function handleCanvasPointerUp(_e) {
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

  // Clear the cursor canvas of any transient indicators like the eraser cursor
  if (cursorCtx) {
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
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
      dynamicCtx.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height);

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
    dynamicCtx.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height);
    currentStroke = [];
  }

  // Reset dynamic stroke drawing state
  dynamicStrokeDrawScheduled = false;
  dynamicStrokeLastDrawIndex = 0;
  dynamicStrokeLastY = null;

  if (pendingExternalRefresh && !isDrawing && !isErasing && !isLassoing && !isTransforming) {
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
  if (!backgroundCtx || !backgroundCanvas || backgroundType === "none") return;

  const height = endY || backgroundCanvas.height;
  const width = backgroundCanvas.width;

  sharedDrawBackgroundPattern(backgroundCtx, backgroundType, width, height, startY);
}

/**
 * Redraw entire background canvas
 */
function redrawBackground() {
  if (!backgroundCtx || !backgroundCanvas || !currentNoteData) return;
  backgroundCtx.clearRect(0, 0, backgroundCanvas.width, backgroundCanvas.height);

  if (currentNoteData.background && currentNoteData.background !== "none") {
    drawBackgroundPattern(currentNoteData.background);
  }
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
  staticCtx.clearRect(0, 0, staticCanvas.width, staticCanvas.height);
  if (dynamicCtx) {
    dynamicCtx.clearRect(0, 0, dynamicCanvas.width, dynamicCanvas.height);
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
 * Draw eraser cursor indicator on the top canvas
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 */
function drawEraserCursor(x, y) {
  if (!cursorCtx) return;
  cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
  cursorCtx.strokeStyle = "red";
  cursorCtx.lineWidth = 1;
  cursorCtx.beginPath();
  cursorCtx.arc(x, y, eraserRadius, 0, 2 * Math.PI);
  cursorCtx.stroke();
}

/**
 * Switch to draw mode
 */
function switchToDrawMode() {
  isDrawMode = true;
  if (dynamicCanvas) {
    dynamicCanvas.classList.add("active");
    dynamicCanvas.style.pointerEvents = "auto";
  }
  if (currentEditor) {
    currentEditor.style.pointerEvents = "none";
  }

  updateToolbarButtons();
  updateModeIndicator();
}

/**
 * Switch to text mode
 */
function switchToTextMode() {
  isDrawMode = false;
  if (dynamicCanvas) {
    dynamicCanvas.classList.remove("active");
    dynamicCanvas.style.pointerEvents = "none";
  }
  // Ensure other canvas layers are also transparent to pointer events
  if (staticCanvas) {
    staticCanvas.style.pointerEvents = "none";
  }
  if (cursorCanvas) {
    cursorCanvas.style.pointerEvents = "none";
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
  if (isDrawMode) {
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
  const penBtn = document.getElementById("pen-settings-btn");
  const eraseBtn = document.getElementById("mode-erase-btn");
  const lassoBtn = document.getElementById("mode-lasso-btn");

  if (textBtn) {
    textBtn.classList.toggle("active", !isDrawMode);
    textBtn.setAttribute("aria-selected", (!isDrawMode).toString());
  }
  if (drawBtn) {
    drawBtn.classList.toggle("active", isDrawMode);
    drawBtn.setAttribute("aria-selected", isDrawMode.toString());
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
  const penTools = document.getElementById("pen-tools");

  if (textTools && penTools) {
    if (isDrawMode) {
      textTools.style.display = "none";
      penTools.style.display = "flex";
    } else {
      textTools.style.display = "flex";
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

  // Image import
  document.getElementById("insert-image-btn")?.addEventListener("click", handleInsertImage);
  document.getElementById("insert-camera-btn")?.addEventListener("click", handleInsertCamera);

  // Zoom controls
  document.getElementById("zoom-in-btn")?.addEventListener("click", () => adjustZoom(zoomStep));
  document.getElementById("zoom-out-btn")?.addEventListener("click", () => adjustZoom(-zoomStep));
  document.getElementById("zoom-reset-btn")?.addEventListener("click", () => setZoom(1.0));

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
 * Handle image import from file system
 */
async function handleInsertImage() {
  try {
    const files = await pickImages(true);
    if (files.length === 0) return;

    console.log(`[Image Import] Processing ${files.length} image(s)...`);

    // Process images with progress
    const results = await processImageFiles(files, (current, total) => {
      console.log(`[Image Import] Processing ${current}/${total}...`);
    });

    // Filter successful results
    const successful = results.filter(r => r.success);

    if (successful.length > 0) {
      console.log(`[Image Import] Successfully processed ${successful.length} image(s)`);

      // Add images to note (will implement in Phase 3)
      // For now, just log the results
      successful.forEach(result => {
        console.log(`[Image Import] ${result.fileName}: ${result.data.width}x${result.data.height}, ${result.data.size}KB`);
      });

      // TODO: Add images to currentNoteData.media array and render them
      // markNoteEdited();
    }

    // Report failures
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      console.error(`[Image Import] Failed to process ${failed.length} image(s)`);
      failed.forEach(result => {
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

    console.log("[Camera] Processing captured image...");

    // Process the captured image
    const results = await processImageFiles([file]);

    if (results[0]?.success) {
      console.log(`[Camera] Successfully processed image: ${results[0].data.width}x${results[0].data.height}, ${results[0].data.size}KB`);

      // Add image to note (will implement in Phase 3)
      // TODO: Add image to currentNoteData.media array and render it
      // markNoteEdited();
    } else {
      console.error(`[Camera] Failed to process image: ${results[0]?.error}`);
    }
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
 */
function setZoom(newZoom) {
  // Clamp zoom to valid range
  zoomScale = Math.max(minZoom, Math.min(maxZoom, newZoom));

  // Apply zoom to text editor using CSS transform
  if (currentEditor) {
    currentEditor.style.transformOrigin = "top left";
    currentEditor.style.transform = `scale(${zoomScale})`;
  }

  // Apply same CSS transform to all canvases to keep them aligned
  const canvases = [dynamicCanvas, staticCanvas, backgroundCanvas, cursorCanvas, highlightCanvas];
  canvases.forEach((cvs) => {
    if (cvs) {
      cvs.style.transformOrigin = "top left";
      cvs.style.transform = `scale(${zoomScale})`;
    }
  });

  // Resize and redraw canvas with new zoom scale
  if (dynamicCanvas && staticCtx) {
    // Store current scroll position
    const wrapper = document.querySelector(".editor-content-wrapper");
    const scrollLeft = wrapper ? wrapper.scrollLeft : 0;
    const scrollTop = wrapper ? wrapper.scrollTop : 0;

    // Resize canvas to account for new zoom scale, then redraw
    resizeCanvas();

    // Restore scroll position
    if (wrapper) {
      wrapper.scrollLeft = scrollLeft;
      wrapper.scrollTop = scrollTop;
    }
  }

  // Update zoom indicator
  updateZoomIndicator();
}

/**
 * Adjust zoom by a delta amount
 * @param {number} delta - Amount to change zoom (e.g., 0.1 for +10%, -0.1 for -10%)
 */
function adjustZoom(delta) {
  setZoom(zoomScale + delta);
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
  let maxX = dynamicCanvas.width;
  let maxY = dynamicCanvas.height;

  // Check all strokes to find the extent
  for (const stroke of strokes) {
    if (stroke.x && stroke.y) {
      for (let i = 0; i < stroke.x.length; i++) {
        maxX = Math.max(maxX, stroke.x[i] + 50); // Add padding
        maxY = Math.max(maxY, stroke.y[i] + 50);
      }
    }
  }

  // Update minimum dimensions
  minCanvasWidth = maxX;
  minCanvasHeight = maxY;

  // Expand canvas if needed
  if (dynamicCanvas.width < minCanvasWidth) {
    const wrapper = dynamicCanvas.parentElement;
    const rect = wrapper.getBoundingClientRect();

    dynamicCanvas.width =
      staticCanvas.width =
      backgroundCanvas.width =
      cursorCanvas.width =
      highlightCanvas.width =
        Math.max(minCanvasWidth, rect.width);

    redrawCanvas();
  }
}

/**
 * Initialize zoom event listeners (CTRL+wheel and pinch gestures)
 */
function initZoomListeners() {
  const wrapper = document.querySelector(".editor-content-wrapper");
  if (!wrapper) return;

  // CTRL + Mouse wheel zoom (Windows/Desktop)
  wrapper.addEventListener(
    "wheel",
    (e) => {
      // Only zoom with CTRL key pressed
      if (e.ctrlKey) {
        e.preventDefault();

        // wheelDelta is positive for zoom in, negative for zoom out
        const delta = e.deltaY < 0 ? zoomStep : -zoomStep;
        adjustZoom(delta);
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

        // Calculate initial distance between fingers
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const dx = touch2.clientX - touch1.clientX;
        const dy = touch2.clientY - touch1.clientY;
        lastTouchDistance = Math.sqrt(dx * dx + dy * dy);
        initialPinchZoom = zoomScale;

        console.log("Pinch zoom started:", { lastTouchDistance, initialPinchZoom });
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

        setZoom(newZoom);
      }
      // Single finger scroll - allow default behavior (scrolling)
      // This is handled by the browser automatically
    },
    { passive: false },
  );

  wrapper.addEventListener("touchend", (e) => {
    // Reset pinch tracking when fingers are lifted
    if (e.touches.length < 2) {
      lastTouchDistance = null;
      initialPinchZoom = null;
    }
  });

  wrapper.addEventListener("touchcancel", () => {
    // Reset pinch tracking on cancel
    lastTouchDistance = null;
    initialPinchZoom = null;
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

    // Update note with content, strokes, deleted stroke IDs, and background setting
    await updateNote(noteId, {
      content: markdownContent,
      strokes: strokes,
      deletedStrokes: deletedStrokes,
      background: currentNoteData?.background || "none",
      modified: Date.now(),
    });

    // Reset inactivity timer after save
    resetInactivityTimer(noteId);

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

  currentEditor = null;
  currentNoteData = null;

  dynamicCanvas = null;
  dynamicCtx = null;
  staticCanvas = null;
  staticCtx = null;
  backgroundCanvas = null;
  backgroundCtx = null;
  cursorCanvas = null;
  cursorCtx = null;
  highlightCanvas = null;
  highlightCtx = null;
  canvasRect = null;

  strokes = [];
  deletedStrokes = [];
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
 * Highlight search terms in strokes (canvas)
 * @param {string} query - Search query
 */
function highlightStrokes(query) {
  if (!query || !currentNoteData?.recognition?.words || !highlightCtx) {
    // Clear previous highlights if query is cleared
    if (highlightCtx) {
      highlightCtx.clearRect(0, 0, highlightCanvas.width, highlightCanvas.height);
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

  // Clear previous highlights
  highlightCtx.clearRect(0, 0, highlightCanvas.width, highlightCanvas.height);

  let matchCount = 0;
  highlightCtx.save();
  highlightCtx.fillStyle = "rgba(255, 255, 0, 0.3)";
  highlightCtx.strokeStyle = "rgba(255, 200, 0, 0.8)";
  highlightCtx.lineWidth = 2;

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
        highlightCtx.fillRect(x, y, w, h);
        highlightCtx.strokeRect(x, y, w, h);
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
  highlightCtx.restore();
  console.log(`[NotebookEditor] Finished highlighting. Matches found: ${matchCount}`);
}
