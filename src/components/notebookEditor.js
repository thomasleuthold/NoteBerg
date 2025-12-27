/**
 * Notebook Editor Component
 * Layered canvas approach with text editor and drawing layer
 * Auto-detects input type (stylus vs mouse) for mode switching
 */

import { getCurrentNoteId, navigateTo } from "../modules/router.js";
import { deleteNote, getNote, updateNote } from "../modules/storage.js";
import { getTheme } from "../modules/theme.js";
import { showConfirmDialog, showNoteInfoModal } from "./modals.js";

// Editor state
let currentEditor = null;
let currentNoteData = null;
let isDrawMode = false;
let isEraserMode = false; // Manual eraser toggle
let isLassoMode = false; // Manual lasso toggle
let canvas = null;
let ctx = null;
let backgroundCanvas = null;
let backgroundCtx = null;
let cursorCanvas = null;
let cursorCtx = null;
let isDrawing = false;
let isErasing = false; // Track if currently erasing
let isLassoing = false; // Track if currently lassoing
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
let lastExpansionTime = 0;
const expansionCooldown = 500; // Minimum ms between expansions
let autoSwitchedToDrawMode = false; // Track if draw mode was auto-activated by stylus
let autoActivatedEraserMode = false; // Track if eraser mode was auto-activated by stylus button
const eraserRadius = 10; // Eraser size in pixels

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

// Cached background pattern colors to avoid repeated getComputedStyle calls
let cachedPatternRuleColor = null;
let cachedPatternGridColor = null;

/**
 * Initialize notebook editor component
 */
export function initNotebookEditorComponent() {
  // Listen for render notebook event from router
  window.addEventListener("rendernotebook", async (e) => {
    const { noteId } = e.detail;
    if (noteId) {
      await initNotebookEditor(noteId);
    }
  });

  // Listen for data changes to refresh the editor if the current note was updated
  window.addEventListener("datachange", async () => {
    const noteId = getCurrentNoteId();
    if (noteId && currentNoteData && noteId === currentNoteData.id) {
      console.log("External data change detected for current note. Refreshing editor.");
      await updateEditorContent(noteId);
    }
  });

  // Listen for navigation changes to cleanup
  window.addEventListener("navigate", (e) => {
    if (e.detail.previousMode === "notebook") {
      cleanupNotebookEditor();
    }
  });

  console.log("Notebook editor component initialized");
}

/**
 * Initialize notebook editor for a note
 * @param {string} noteId - ID of note to edit
 */
export async function initNotebookEditor(noteId) {
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

    // Set default background for existing notes without one
    if (!currentNoteData.background) {
      currentNoteData.background = "none";
    }

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

    // Initialize zoom to ensure transforms are applied on load
    setZoom(1.0);

    console.log("Notebook editor initialized for note:", noteId);
  } catch (error) {
    console.error("Error initializing notebook editor:", error);
  }
}

/**
 * Render editor structure
 */
function renderEditor(container, _noteData) {
  container.innerHTML = `
    <style>
      .editor-content-wrapper {
        position: relative;
      }
      #text-editor {
        position: relative;
        z-index: 1; /* Behind the canvases */
      }
      .drawing-canvas, .cursor-canvas {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 10; /* On top of the text editor */
        pointer-events: none; /* Default to none to allow text interaction */
        touch-action: none; /* Prevent browser gesture handling */
      }
      .drawing-canvas.active {
        pointer-events: auto; /* Enable events in draw mode */
      }
      .toolbar-btn {
        width: auto;
        height: auto;
        padding: 12px;
      }
      .toolbar-btn svg {
        width: 24px;
        height: 24px;
        display: block;
      }
      .toolbar-btn-container {
        position: relative;
        display: inline-block;
      }
      .pen-settings-dialog {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 100;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        width: 200px;
        margin-top: 5px;
      }
      .pen-settings-section {
        margin-bottom: 12px;
      }
      .pen-settings-label {
        display: block;
        font-size: 0.75rem;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }
      .pen-color-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
      }
      .pen-color-option {
        width: 30px;
        height: 30px;
        border-radius: 50%;
        cursor: pointer;
        border: 2px solid transparent;
      }
      .pen-color-option.active {
        border-color: var(--color-primary);
        transform: scale(1.1);
      }
      .pen-width-control {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .background-settings-dialog {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 100;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 12px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        width: 200px;
        margin-top: 5px;
      }
      .background-option {
        padding: 8px 12px;
        margin-bottom: 4px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
        border: 1px solid var(--border-primary);
      }
      .background-option:hover {
        background-color: var(--bg-hover);
      }
      .background-option.active {
        background-color: var(--color-primary-light);
        border-color: var(--color-primary);
      }
    </style>
    <div class="notebook-editor">
      <div class="editor-toolbar">
        <div class="toolbar-section">
          <button class="toolbar-btn toolbar-btn-text" id="mode-text-btn" title="Text mode">
            T
          </button>
          <div class="toolbar-btn-container">
            <button class="toolbar-btn" id="mode-draw-btn" title="Draw mode">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
            <div id="pen-settings-dialog" class="pen-settings-dialog" style="display: none;">
              <div class="pen-settings-section">
                <span class="pen-settings-label">Pen Width: <span id="pen-width-value">2</span>px</span>
                <div class="pen-width-control">
                  <input type="range" id="pen-width-slider" min="1" max="15" step="1" value="2" style="width: 100%;">
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.9-9.9c1-1 2.5-1 3.4 0l4.4 4.4c1 1 1 2.5 0 3.4L10.5 21z"/><path d="m22 21-10 0"/><path d="m18 11-4-4"/></svg>
          </button>
          <button class="toolbar-btn" id="mode-lasso-btn" title="Lasso select">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>
          </button>
          <button class="toolbar-btn" id="delete-selection-btn" title="Delete selection" style="display: none;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
          </button>
          <button class="toolbar-btn" id="paste-btn" title="Paste" style="display: none;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>
          </button>
          <div class="toolbar-divider"></div>
          <div class="toolbar-btn-container">
            <button class="toolbar-btn" id="background-btn" title="Background">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>
            </button>
            <div id="background-settings-dialog" class="background-settings-dialog" style="display: none;">
              <div class="background-option" data-background="none">None</div>
              <div class="background-option" data-background="ruled-narrow">Ruled - Narrow</div>
              <div class="background-option" data-background="ruled-medium">Ruled - Medium</div>
              <div class="background-option" data-background="ruled-wide">Ruled - Wide</div>
              <div class="background-option" data-background="grid-small">Grid - Small</div>
              <div class="background-option" data-background="grid-medium">Grid - Medium</div>
              <div class="background-option" data-background="grid-large">Grid - Large</div>
            </div>
          </div>
          <div class="toolbar-divider"></div>
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
        <div class="toolbar-section toolbar-section-right">
          <button class="toolbar-btn" id="zoom-out-btn" title="Zoom out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/></svg>
          </button>
          <span class="zoom-indicator" id="zoom-level">100%</span>
          <button class="toolbar-btn" id="zoom-in-btn" title="Zoom in">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/></svg>
          </button>
          <button class="toolbar-btn" id="zoom-reset-btn" title="Reset zoom">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
          <div class="toolbar-divider"></div>
          <button class="toolbar-btn" id="delete-note-btn" title="Delete note">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
          </button>
          <button class="toolbar-btn" id="note-info-btn" title="Note properties">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          </button>
        </div>
      </div>

      <div class="editor-content-wrapper">
        <div id="text-editor" class="text-editor" contenteditable="true"></div>
        <canvas id="background-canvas" class="background-canvas"></canvas>
        <canvas id="drawing-canvas" class="drawing-canvas"></canvas>
        <canvas id="cursor-canvas" class="cursor-canvas"></canvas>
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
    // Debounce canvas resize for better performance
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      resizeCanvas();
    }, 100); // Resize after 100ms of no input

    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      await saveNoteContent();
    }, 1000); // Save after 1 second of no input
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
  canvas = document.getElementById("drawing-canvas");
  backgroundCanvas = document.getElementById("background-canvas");
  cursorCanvas = document.getElementById("cursor-canvas");
  if (!canvas || !backgroundCanvas || !cursorCanvas) return;

  ctx = canvas.getContext("2d");
  backgroundCtx = backgroundCanvas.getContext("2d");
  cursorCtx = cursorCanvas.getContext("2d");

  // Initial canvas sizing with throttling
  window.addEventListener("resize", throttledResizeCanvas);

  // Add zoom event listeners
  initZoomListeners();

  // Listen for theme changes to invalidate caches
  window.addEventListener("themechange", () => {
    cachedTheme = null;
    cachedPalette = null;
    cachedPatternRuleColor = null;
    cachedPatternGridColor = null;
    redrawBackground(); // Redraw background with new theme colors
    redrawCanvas(); // Redraw strokes with new theme colors
  });

  // Load existing strokes
  if (noteData.strokes && Array.isArray(noteData.strokes)) {
    strokes = noteData.strokes;
    updateContentBounds();
  }

  requestAnimationFrame(() => {
    resizeCanvas();
    redrawCanvas();
  });

  // Add pen detection on the wrapper to enable canvas pointer-events for scrolled areas
  const wrapper = canvas.parentElement;
  if (wrapper) {
    wrapper.addEventListener(
      "pointerdown",
      (e) => {
        // If pen detected and not in draw mode, temporarily enable canvas pointer events
        // so handleCanvasPointerDown can receive the event and auto-switch
        if ((e.pointerType === "pen" || e.pointerType === "eraser") && !isDrawMode && canvas) {
          canvas.style.pointerEvents = "auto";
          // Let the event propagate to canvas
        }
      },
      { capture: true },
    ); // Use capture to intercept before canvas
  }

  // Prevent context menu on right-click (e.g., from pen barrel button)
  canvas.addEventListener("contextmenu", (e) => {
    if (e.pointerType === "pen") {
      e.preventDefault();
    }
  });

  // Canvas drawing events
  canvas.addEventListener("pointerdown", (e) => {
    // Auto-detect pen and switch to draw mode if needed
    const shouldContinue = handleCanvasPointerDown(e);
    if (shouldContinue === false) return;

    // Only prevent default and capture for pen events or when in draw mode
    if (e.pointerType === "pen" || e.pointerType === "eraser" || isDrawMode || isErasing) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    // Make prevention more aggressive: prevent default on any move in draw mode or erasing.
    if (isDrawMode || isErasing) e.preventDefault();
    handleCanvasPointerMove(e);
  });
  canvas.addEventListener("pointerup", (e) => {
    handleCanvasPointerUp(e);
    if ((isDrawMode || isErasing) && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointercancel", handleCanvasPointerUp);

  // Prevent touch scrolling on canvas when in draw mode
  canvas.addEventListener(
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

  canvas.addEventListener(
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
  if (!canvas || !backgroundCanvas || !cursorCanvas || !currentEditor) return;

  const wrapper = canvas.parentElement;
  const rect = wrapper.getBoundingClientRect();

  const baseWidth = rect.width / zoomScale;
  const baseHeight = rect.height / zoomScale;

  // Don't use scrollHeight with CSS transforms - it's unreliable
  // Instead, use the wrapper dimensions and minimum bounds from content
  const requiredHeight = Math.max(
    baseHeight,
    minCanvasHeight,
    canvas.height, // Keep current canvas height to prevent shrinking
    800,
  );
  const requiredWidth = Math.max(baseWidth, minCanvasWidth, 800);

  // Prevent excessive canvas sizes that could cause performance issues
  const maxCanvasSize = 10000;
  const safeWidth = Math.min(requiredWidth, maxCanvasSize);
  const safeHeight = Math.min(requiredHeight, maxCanvasSize);

  // Only resize if dimensions actually changed significantly
  const widthChanged = Math.abs(canvas.width - safeWidth) > 1;
  const heightChanged = Math.abs(canvas.height - safeHeight) > 1;

  if (widthChanged || heightChanged) {
    // Resize all three canvases
    canvas.width = backgroundCanvas.width = cursorCanvas.width = safeWidth;
    canvas.height = backgroundCanvas.height = cursorCanvas.height = safeHeight;
    canvas.style.width = backgroundCanvas.style.width = cursorCanvas.style.width = `${safeWidth}px`;
    canvas.style.height =
      backgroundCanvas.style.height =
      cursorCanvas.style.height =
        `${safeHeight}px`;

    if (currentEditor) {
      currentEditor.style.minWidth = `${safeWidth}px`;
      currentEditor.style.minHeight = `${safeHeight}px`;
    }

    // Redraw both background and strokes after resize (canvas is cleared when dimensions change)
    redrawBackground();
    redrawCanvas();
  }
}

/**
 * Expand canvas height by a specified amount
 * @param {number} additionalHeight - Height to add in pixels (in unscaled space)
 */
function expandCanvas(additionalHeight) {
  if (!canvas || !backgroundCanvas || !cursorCanvas) return;

  const now = Date.now();
  if (now - lastExpansionTime < expansionCooldown) return;
  lastExpansionTime = now;

  const wrapper = canvas.parentElement;
  const rect = wrapper.getBoundingClientRect();

  const newHeight = canvas.height + additionalHeight;
  const baseWidth = rect.width / zoomScale;

  // During active drawing, use a faster resize strategy
  // Create offscreen canvases to preserve current drawing and background
  if (isDrawing && ctx && backgroundCtx) {
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.drawImage(canvas, 0, 0);

    const tempBgCanvas = document.createElement("canvas");
    tempBgCanvas.width = backgroundCanvas.width;
    tempBgCanvas.height = backgroundCanvas.height;
    const tempBgCtx = tempBgCanvas.getContext("2d");
    tempBgCtx.drawImage(backgroundCanvas, 0, 0);

    // Resize all canvases
    canvas.width = backgroundCanvas.width = cursorCanvas.width = baseWidth;
    canvas.height = backgroundCanvas.height = cursorCanvas.height = newHeight;
    canvas.style.width = backgroundCanvas.style.width = cursorCanvas.style.width = `${baseWidth}px`;
    canvas.style.height =
      backgroundCanvas.style.height =
      cursorCanvas.style.height =
        `${newHeight}px`;

    // Restore the content without expensive redraw
    ctx.drawImage(tempCanvas, 0, 0);
    backgroundCtx.drawImage(tempBgCanvas, 0, 0);

    // Draw background pattern on newly expanded area
    drawBackgroundExpansion(tempBgCanvas.height, newHeight);
  } else {
    // Not actively drawing - do normal resize with full redraw
    canvas.width = backgroundCanvas.width = cursorCanvas.width = baseWidth;
    canvas.height = backgroundCanvas.height = cursorCanvas.height = newHeight;
    canvas.style.width = backgroundCanvas.style.width = cursorCanvas.style.width = `${baseWidth}px`;
    canvas.style.height =
      backgroundCanvas.style.height =
      cursorCanvas.style.height =
        `${newHeight}px`;

    redrawBackground();
    redrawCanvas();
  }

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
  if (!canvas) return;
  let indicator = document.getElementById("expansion-zone-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "expansion-zone-indicator";
    indicator.className = "expansion-zone-indicator";
    canvas.parentElement.appendChild(indicator);
  }
  const expansionThreshold = 300;
  const distanceFromBottom = canvas.height - (currentY || 0);

  if ((currentY !== null && distanceFromBottom < expansionThreshold) || forceUpdate) {
    const triggerLine = canvas.height - expansionThreshold;
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
    if (canvas && isDrawMode) {
      // Set pointer capture on canvas to ensure we get all subsequent events
      try {
        canvas.setPointerCapture(e.pointerId);
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
      canvas.dispatchEvent(canvasEvent);
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
    if (canvas && isDrawMode) {
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
      canvas.dispatchEvent(canvasEvent);
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
  if (e.pointerType === "pen" && canvas && isDrawMode) {
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
    canvas.dispatchEvent(canvasEvent);
    e.preventDefault();
    e.stopPropagation();
  }
}

/**
 * Get correct canvas coordinates accounting for scroll and zoom
 */
function getCanvasCoordinates(e) {
  let clientX = e.clientX;
  let clientY = e.clientY;

  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  }

  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

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
    currentStroke = [];

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
  } else {
    // Start drawing
    if (currentStroke.length === 0) {
      currentStroke = {
        pointerType: e.pointerType,
        x: [],
        y: [],
        pressure: [],
        time: [],
        colorIndex: currentPenColorIndex,
        width: currentPenWidth,
      };
    }
    currentStroke.x.push(x);
    currentStroke.y.push(y);
    currentStroke.pressure.push(e.pressure || 0.5);
    currentStroke.time.push(Date.now());
  }
  return true;
}

/**
 * Handle canvas pointer move
 */
function handleCanvasPointerMove(e) {
  if (!isDrawMode || (!isDrawing && !isErasing && !isLassoing && !isTransforming)) {
    return;
  }

  const { x, y } = getCanvasCoordinates(e);

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
    redrawCanvas();
    return;
  }

  if (isLassoing) {
    lassoPoints.push({ x, y });
    drawLassoPath();
  } else if (isErasing) {
    eraseStrokesAtPoint(x, y);
    drawEraserCursor(x, y);
  } else if (isDrawing) {
    // Clear cursor canvas when moving to draw
    if (cursorCtx) {
      cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    }

    currentStroke.x.push(x);
    currentStroke.y.push(y);
    currentStroke.pressure.push(e.pressure || 0.5);
    currentStroke.time.push(Date.now());

    if (canvas.height - y < 300) {
      expandCanvas(800);
    }

    const pointCount = currentStroke.x.length;
    if (pointCount > 1) {
      const prevX = currentStroke.x[pointCount - 2];
      const prevY = currentStroke.y[pointCount - 2];
      const currX = currentStroke.x[pointCount - 1];
      const currY = currentStroke.y[pointCount - 1];

      // Use cached stroke style instead of recalculating on every move
      if (!currentStroke.cachedStyle) {
        const palette = getThemePalette();
        currentStroke.cachedStyle = palette[currentStroke.colorIndex] || palette[0];
      }

      ctx.strokeStyle = currentStroke.cachedStyle;
      ctx.lineWidth = currentStroke.width || 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(currX, currY);
      ctx.stroke();
    }
    updateExpansionZoneIndicator(y);
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
    setTimeout(async () => {
      await saveNoteContent();
    }, 500);
    return;
  }

  // Deactivate auto-activated eraser mode on pointer up
  if (autoActivatedEraserMode) {
    isEraserMode = false;
    autoActivatedEraserMode = false;
    updateToolbarButtons();
  }

  // Clear the cursor canvas
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
  if (wasErasing || (wasDrawing && currentStroke.x && currentStroke.x.length > 0)) {
    if (wasDrawing) {
      strokes.push({ ...currentStroke });
      currentStroke = [];
      updateExpansionZoneIndicator(null);
      updateContentBounds();
    }
    setTimeout(async () => {
      await saveNoteContent();
    }, 500);
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
 * Draw a single stroke with smooth curves
 */
function drawStroke(stroke, index) {
  if (!ctx || !stroke.x || stroke.x.length < 2) return;

  const isSelected = selectedStrokes.has(index);

  const pointCount = stroke.x.length;
  const palette = getThemePalette();

  if (isSelected) {
    ctx.strokeStyle = "rgba(0, 100, 255, 0.7)"; // Highlight color
    ctx.lineWidth = (stroke.width || 2) + 4; // Make it thicker
  } else {
    ctx.strokeStyle =
      stroke.colorIndex !== undefined ? palette[stroke.colorIndex] : stroke.color || palette[0];
    ctx.lineWidth = stroke.width || 2;
  }

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(stroke.x[0], stroke.y[0]);

  if (pointCount === 2) {
    ctx.lineTo(stroke.x[1], stroke.y[1]);
  } else {
    for (let i = 1; i < pointCount - 1; i++) {
      const xc = (stroke.x[i] + stroke.x[i + 1]) / 2;
      const yc = (stroke.y[i] + stroke.y[i + 1]) / 2;
      ctx.quadraticCurveTo(stroke.x[i], stroke.y[i], xc, yc);
    }
    const lastIdx = pointCount - 1;
    const secondLastIdx = pointCount - 2;
    ctx.quadraticCurveTo(
      stroke.x[secondLastIdx],
      stroke.y[secondLastIdx],
      stroke.x[lastIdx],
      stroke.y[lastIdx],
    );
  }
  ctx.stroke();

  // If not selected, draw the actual stroke on top of the highlight
  if (isSelected) {
    ctx.strokeStyle =
      stroke.colorIndex !== undefined ? palette[stroke.colorIndex] : stroke.color || palette[0];
    ctx.lineWidth = stroke.width || 2;
    ctx.stroke();
  }
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

  // Get pattern color from cache or CSS variable
  let patternColor;
  if (backgroundType.startsWith("ruled")) {
    if (!cachedPatternRuleColor) {
      cachedPatternRuleColor = getComputedStyle(document.documentElement)
        .getPropertyValue("--pattern-rule-color")
        .trim();
    }
    patternColor = cachedPatternRuleColor;
  } else {
    if (!cachedPatternGridColor) {
      cachedPatternGridColor = getComputedStyle(document.documentElement)
        .getPropertyValue("--pattern-grid-color")
        .trim();
    }
    patternColor = cachedPatternGridColor;
  }

  backgroundCtx.strokeStyle = patternColor;
  backgroundCtx.lineWidth = 1;
  backgroundCtx.beginPath();

  switch (backgroundType) {
    case "ruled-narrow":
      // Draw horizontal lines every 20px
      for (let y = Math.max(20, startY); y < height; y += 20) {
        backgroundCtx.moveTo(0, y);
        backgroundCtx.lineTo(width, y);
      }
      break;

    case "ruled-medium":
      // Draw horizontal lines every 30px
      for (let y = Math.max(30, startY); y < height; y += 30) {
        backgroundCtx.moveTo(0, y);
        backgroundCtx.lineTo(width, y);
      }
      break;

    case "ruled-wide":
      // Draw horizontal lines every 40px
      for (let y = Math.max(40, startY); y < height; y += 40) {
        backgroundCtx.moveTo(0, y);
        backgroundCtx.lineTo(width, y);
      }
      break;

    case "grid-small":
      // Draw grid with 20px squares
      for (let y = Math.max(20, startY); y < height; y += 20) {
        backgroundCtx.moveTo(0, y);
        backgroundCtx.lineTo(width, y);
      }
      for (let x = 20; x < width; x += 20) {
        backgroundCtx.moveTo(x, startY);
        backgroundCtx.lineTo(x, height);
      }
      break;

    case "grid-medium":
      // Draw grid with 30px squares
      for (let y = Math.max(30, startY); y < height; y += 30) {
        backgroundCtx.moveTo(0, y);
        backgroundCtx.lineTo(width, y);
      }
      for (let x = 30; x < width; x += 30) {
        backgroundCtx.moveTo(x, startY);
        backgroundCtx.lineTo(x, height);
      }
      break;

    case "grid-large":
      // Draw grid with 40px squares
      for (let y = Math.max(40, startY); y < height; y += 40) {
        backgroundCtx.moveTo(0, y);
        backgroundCtx.lineTo(width, y);
      }
      for (let x = 40; x < width; x += 40) {
        backgroundCtx.moveTo(x, startY);
        backgroundCtx.lineTo(x, height);
      }
      break;
  }

  backgroundCtx.stroke();
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
 * Redraw entire canvas (strokes only - background is on separate canvas)
 */
function redrawCanvas() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw strokes
  strokes.forEach((stroke, index) => {
    drawStroke(stroke, index);
  });

  // Draw selection UI
  if (selectionBounds && !isLassoing) {
    const { minX, minY, maxX, maxY } = selectionBounds;

    ctx.save();
    ctx.strokeStyle = "rgba(0, 100, 255, 0.5)";
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.setLineDash([]);

    // Draw handles
    const h = handleSize;
    const drawHandle = (hx, hy, label) => {
      ctx.fillStyle = "white";
      ctx.strokeStyle = "rgba(0, 100, 255, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(hx - h / 2, hy - h / 2, h, h);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "rgba(0, 100, 255, 0.8)";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, hx, hy);
    };

    drawHandle(minX, minY, "R"); // Rotate
    drawHandle(maxX, minY, "C"); // Copy
    drawHandle(maxX, maxY, "M"); // Move
    drawHandle(minX, maxY, "S"); // Size

    ctx.restore();
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
  strokes = strokes.filter((stroke) => !strokeIntersectsEraser(stroke, x, y));
  if (strokes.length < originalLength) {
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
  if (canvas) {
    canvas.classList.add("active");
    canvas.style.pointerEvents = "auto";
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
  if (canvas) {
    canvas.classList.remove("active");
    canvas.style.pointerEvents = "none";
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
  // If already in draw mode (and not erasing), toggle settings dialog
  if (isDrawMode && !isEraserMode && !isLassoMode) {
    togglePenSettingsDialog();
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
  const eraseBtn = document.getElementById("mode-erase-btn");
  const lassoBtn = document.getElementById("mode-lasso-btn");

  if (textBtn) {
    textBtn.classList.toggle("active", !isDrawMode);
  }
  if (drawBtn) {
    drawBtn.classList.toggle("active", isDrawMode && !isEraserMode && !isLassoMode);
  }
  if (eraseBtn) {
    eraseBtn.classList.toggle("active", isEraserMode);
  }
  if (lassoBtn) {
    lassoBtn.classList.toggle("active", isLassoMode);
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

  // Theme changed or first call - compute and cache the palette
  cachedTheme = theme;
  if (theme === "dark") {
    cachedPalette = [
      "#ffffff",
      "#f87171",
      "#60a5fa",
      "#34d399",
      "#fbbf24",
      "#a78bfa",
      "#9ca3af",
      "#fde047",
    ];
  } else if (theme === "epaper") {
    cachedPalette = [
      "#000000",
      "#800000",
      "#000080",
      "#006400",
      "#a52a2a",
      "#4b0082",
      "#2f4f4f",
      "#5d4037",
    ];
  } else {
    // Default Light theme
    cachedPalette = [
      "#000000",
      "#ef4444",
      "#3b82f6",
      "#10b981",
      "#f59e0b",
      "#8b5cf6",
      "#6b7280",
      "#78350f",
    ];
  }

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
async function setNoteBackground(backgroundType) {
  if (!currentNoteData) return;

  currentNoteData.background = backgroundType;
  updateBackgroundSettingsUI();
  redrawBackground();

  // Save the background change
  await updateNote(currentNoteData.id, { background: backgroundType });
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
  const drawBtn = document.getElementById("mode-draw-btn");
  const bgDialog = document.getElementById("background-settings-dialog");
  const bgBtn = document.getElementById("background-btn");

  if (dialog && dialog.style.display === "block") {
    // Close if the target is not the dialog itself and not the button that toggles it
    if (!dialog.contains(e.target) && !drawBtn?.contains(e.target)) {
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
async function deleteSelectedStrokes() {
  if (selectedStrokes.size === 0) return;

  // Filter out the selected strokes
  strokes = strokes.filter((_, index) => !selectedStrokes.has(index));

  // Clear the selection
  selectedStrokes.clear();
  selectionBounds = null;

  // Hide the delete button
  const deleteBtn = document.getElementById("delete-selection-btn");
  if (deleteBtn) {
    deleteBtn.style.display = "none";
  }

  // Redraw and save
  redrawCanvas();
  updateContentBounds();
  await saveNoteContent();
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
async function pasteStrokes() {
  if (!clipboardStrokes || clipboardStrokes.length === 0) return;

  const offset = 30;
  const newStrokes = clipboardStrokes.map((stroke) => {
    const copy = JSON.parse(JSON.stringify(stroke));
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
  await saveNoteContent();
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
  // Don't set width/height here - let resizeCanvas() handle sizing
  if (canvas) {
    canvas.style.transformOrigin = "top left";
    canvas.style.transform = `scale(${zoomScale})`;
  }
  if (backgroundCanvas) {
    backgroundCanvas.style.transformOrigin = "top left";
    backgroundCanvas.style.transform = `scale(${zoomScale})`;
  }
  if (cursorCanvas) {
    cursorCanvas.style.transformOrigin = "top left";
    cursorCanvas.style.transform = `scale(${zoomScale})`;
  }

  // Resize and redraw canvas with new zoom scale
  if (canvas && ctx) {
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
  if (!canvas || !currentEditor) return;

  // Calculate minimum canvas dimensions needed to show all content
  let maxX = canvas.width;
  let maxY = canvas.height;

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
  if (canvas.width < minCanvasWidth) {
    const wrapper = canvas.parentElement;
    const rect = wrapper.getBoundingClientRect();
    const currentStrokes = [...strokes];

    canvas.width = Math.max(minCanvasWidth, rect.width);
    strokes = currentStrokes;
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
 * Save note content
 */
async function saveNoteContent() {
  const noteId = getCurrentNoteId();
  if (!noteId || !currentEditor) return;

  try {
    // Convert HTML back to markdown (simplified)
    const htmlContent = currentEditor.innerHTML;
    const markdownContent = htmlToMarkdown(htmlContent);

    // Update note with content and strokes
    await updateNote(noteId, {
      content: markdownContent,
      strokes: strokes,
      modified: Date.now(),
    });

    console.log("Note saved");
  } catch (error) {
    console.error("Error saving note:", error);
  }
}

/**
 * Simple markdown to HTML conversion (basic WYSIWYG)
 */
function markdownToHtml(markdown) {
  let html = markdown
    // Headers
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    // Bold
    .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.*?)\*/gim, "<em>$1</em>")
    // Lists
    .replace(/^- (.*$)/gim, "<li>$1</li>")
    // Paragraphs
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith("<")) {
    html = `<p>${html}</p>`;
  }

  // Wrap lists in ul tags
  html = html.replace(/(<li>.*<\/li>)/gim, "<ul>$1</ul>");

  return html;
}

/**
 * Simple HTML to markdown conversion
 */
function htmlToMarkdown(html) {
  let markdown = html
    // Headers
    .replace(/<h1>(.*?)<\/h1>/gim, "# $1\n\n")
    .replace(/<h2>(.*?)<\/h2>/gim, "## $1\n\n")
    .replace(/<h3>(.*?)<\/h3>/gim, "### $1\n\n")
    // Bold
    .replace(/<strong>(.*?)<\/strong>/gim, "**$1**")
    .replace(/<b>(.*?)<\/b>/gim, "**$1**")
    // Italic
    .replace(/<em>(.*?)<\/em>/gim, "*$1*")
    .replace(/<i>(.*?)<\/i>/gim, "*$1*")
    // Lists
    .replace(/<li>(.*?)<\/li>/gim, "- $1\n")
    .replace(/<\/?ul>/gim, "")
    // Line breaks and paragraphs
    .replace(/<br\s*\/?>/gim, "\n")
    .replace(/<\/p><p>/gim, "\n\n")
    .replace(/<\/?p>/gim, "");

  // Clean up extra whitespace
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  return markdown;
}

/**
 * Update editor content after external changes (e.g., sync) while preserving state.
 * @param {string} noteId - The ID of the note to update.
 */
async function updateEditorContent(noteId) {
  if (!noteId || !currentNoteData || noteId !== currentNoteData.id) {
    return; // Should not happen if called from the event listener, but good practice
  }

  // 1. Preserve state (scroll and zoom)
  const wrapper = document.querySelector(".editor-content-wrapper");
  const scrollLeft = wrapper ? wrapper.scrollLeft : 0;
  const scrollTop = wrapper ? wrapper.scrollTop : 0;
  const currentZoom = zoomScale; // `zoomScale` is a module-level variable

  // 2. Reload data from storage
  const newNoteData = await getNote(noteId);
  if (!newNoteData) {
    // The note may have been deleted on another client and synced.
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

  // 3. Re-render content if it has changed
  if (currentEditor) {
    const currentHtmlContent = currentEditor.innerHTML;
    const newHtmlContent = markdownToHtml(newNoteData.content);
    if (currentHtmlContent !== newHtmlContent) {
      currentEditor.innerHTML = newHtmlContent;
    }
  }

  if (canvas) {
    strokes = newNoteData.strokes || [];
    // Recalculate content bounds based on new strokes
    updateContentBounds();
    // `resizeCanvas` will handle resizing and `redrawCanvas`
    resizeCanvas();
  }

  // 4. Restore state
  setZoom(currentZoom);
  if (wrapper) {
    // Use requestAnimationFrame to ensure the browser has time to reflow
    requestAnimationFrame(() => {
      wrapper.scrollLeft = scrollLeft;
      wrapper.scrollTop = scrollTop;
    });
  }

  console.log("Notebook editor content updated and state preserved.");
}

/**
 * Cleanup editor
 */
export function cleanupNotebookEditor() {
  if (canvas) {
    window.removeEventListener("resize", resizeCanvas);
  }

  // Remove global listener
  document.removeEventListener("pointerdown", handleOutsideClick);

  currentEditor = null;
  currentNoteData = null;
  canvas = null;
  ctx = null;
  strokes = [];
  currentStroke = [];
  isDrawing = false;
  isDrawMode = false;
  isEraserMode = false;
  isLassoMode = false;
  selectionBounds = null;
  isTransforming = false;
  transformMode = null;
  clipboardStrokes = null;
}
