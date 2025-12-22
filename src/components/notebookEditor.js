/**
 * Notebook Editor Component
 * Layered canvas approach with text editor and drawing layer
 * Auto-detects input type (stylus vs mouse) for mode switching
 */

import { getCurrentNoteId, navigateTo } from "../modules/router.js";
import { deleteNote, getNote, updateNote } from "../modules/storage.js";
import { getTheme } from "../modules/theme.js";
import { showConfirmDialog } from "./modals.js";

// Editor state
let currentEditor = null;
let currentNoteData = null;
let isDrawMode = false;
let isEraserMode = false; // Manual eraser toggle
let canvas = null;
let ctx = null;
let isDrawing = false;
let isErasing = false; // Track if currently erasing
let currentStroke = [];
let strokes = [];
let lastExpansionTime = 0;
const expansionCooldown = 500; // Minimum ms between expansions
let autoSwitchedToDrawMode = false; // Track if draw mode was auto-activated by stylus
const eraserRadius = 20; // Eraser size in pixels

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
    </style>
    <div class="notebook-editor">
      <div class="editor-toolbar">
        <div class="toolbar-section">
          <button class="toolbar-btn toolbar-btn-text" id="mode-text-btn" title="Text mode">
            T
          </button>
          <div class="toolbar-btn-container">
            <button class="toolbar-btn" id="mode-draw-btn" title="Draw mode">
              ✏️
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
            🧽
          </button>
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
            -
          </button>
          <span class="zoom-indicator" id="zoom-level">100%</span>
          <button class="toolbar-btn" id="zoom-in-btn" title="Zoom in">
            +
          </button>
          <button class="toolbar-btn" id="zoom-reset-btn" title="Reset zoom">
            ⟲
          </button>
          <div class="toolbar-divider"></div>
          <button class="toolbar-btn" id="delete-note-btn" title="Delete note">
            🗑️
          </button>
        </div>
      </div>

      <div class="editor-content-wrapper">
        <div id="text-editor" class="text-editor" contenteditable="true"></div>
        <canvas id="drawing-canvas" class="drawing-canvas"></canvas>
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
  if (!canvas) return;

  ctx = canvas.getContext("2d");

  // Initial canvas sizing
  window.addEventListener("resize", resizeCanvas);

  // Add zoom event listeners
  initZoomListeners();

  // Load existing strokes
  if (noteData.strokes && Array.isArray(noteData.strokes)) {
    strokes = noteData.strokes;
    // Calculate content bounds from existing strokes
    updateContentBounds();
  }

  // Size canvas AFTER loading strokes and calculating bounds
  // Use requestAnimationFrame to ensure DOM is fully laid out
  requestAnimationFrame(() => {
    resizeCanvas();
    redrawCanvas();
  });

  // Canvas drawing events with pointer capture for better performance
  canvas.addEventListener("pointerdown", (e) => {
    console.log("=== POINTERDOWN WRAPPER ===", {
      pointerType: e.pointerType,
      isDrawMode: isDrawMode,
      autoSwitchedToDrawMode: autoSwitchedToDrawMode,
      canvasHasActiveClass: canvas.classList.contains("active"),
      canvasPointerEvents: canvas.style.pointerEvents,
    });

    // Call handleCanvasPointerDown first - it will set autoSwitchedToDrawMode for pen
    // and return early for touch if needed
    const shouldContinue = handleCanvasPointerDown(e);

    // If handleCanvasPointerDown returned false, it switched to text mode - don't prevent default
    if (shouldContinue === false) {
      return;
    }

    if (isDrawMode) {
      e.preventDefault(); // Prevent scrolling and default touch behavior
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (isDrawing && isDrawMode) {
      e.preventDefault(); // Prevent scrolling during drawing
    }
    handleCanvasPointerMove(e);
  });
  canvas.addEventListener("pointerup", (e) => {
    handleCanvasPointerUp(e);
    if (isDrawMode && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointercancel", handleCanvasPointerUp);

  // Prevent touch scrolling on canvas when in draw mode
  canvas.addEventListener(
    "touchstart",
    (e) => {
      // Check if we need to auto-switch to text/pan mode
      // IMPORTANT: Only switch if we're NOT currently drawing (to avoid switching mid-stroke)
      if (autoSwitchedToDrawMode && isDrawMode && !isDrawing) {
        console.log("Touch start detected with auto-switched draw mode - switching to text mode");
        switchToTextMode();
        // Don't prevent default - allow scrolling/panning
        return;
      }

      if (isDrawMode) {
        e.preventDefault();
      }
    },
    { passive: false },
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (isDrawMode) {
        e.preventDefault();
      }
    },
    { passive: false },
  );
}

/**
 * Resize canvas to match container
 */
function resizeCanvas() {
  if (!canvas || !currentEditor) return;

  const wrapper = canvas.parentElement;
  const rect = wrapper.getBoundingClientRect();

  // Store current strokes
  const currentStrokes = [...strokes];

  // Account for zoom when calculating base dimensions
  // rect.width/height are the scaled sizes, we need the unscaled sizes
  const baseWidth = rect.width / zoomScale;
  const baseHeight = rect.height / zoomScale;

  // Get the actual scrollable content height from the text editor
  // The scrollHeight already accounts for zoom via CSS transform
  const textEditorHeight = currentEditor.scrollHeight / zoomScale + 200; // Extra padding for growth

  // Also check the wrapper's scroll height
  const wrapperScrollHeight = wrapper.scrollHeight / zoomScale;

  // Use the maximum of all measurements to ensure canvas is large enough
  const requiredHeight = Math.max(
    textEditorHeight,
    wrapperScrollHeight,
    baseHeight,
    minCanvasHeight,
    800,
  );

  // Calculate required width based on content bounds
  // Don't let canvas shrink below current width to prevent squeezing
  const requiredWidth = Math.max(baseWidth, minCanvasWidth, canvas.width, 800);

  // Resize canvas to match text editor dimensions (unscaled)
  canvas.width = requiredWidth;
  canvas.height = requiredHeight;

  // Set canvas CSS size explicitly (in unscaled pixels)
  // This prevents squeezing when window resizes
  canvas.style.width = `${requiredWidth}px`;
  canvas.style.height = `${requiredHeight}px`;

  // Update text editor width to match canvas (important for horizontal scroll)
  if (currentEditor) {
    currentEditor.style.minWidth = `${requiredWidth}px`;
  }

  // Restore strokes
  strokes = currentStrokes;
  redrawCanvas();
}

/**
 * Expand canvas height by a specified amount
 * @param {number} additionalHeight - Height to add in pixels (in unscaled space)
 */
function expandCanvas(additionalHeight) {
  if (!canvas) return;

  // Prevent too-frequent expansions
  const now = Date.now();
  if (now - lastExpansionTime < expansionCooldown) {
    return;
  }
  lastExpansionTime = now;

  const wrapper = canvas.parentElement;
  const rect = wrapper.getBoundingClientRect();

  // Store current strokes AND the current stroke being drawn
  const currentStrokes = [...strokes];
  const currentStrokeInProgress = currentStroke.x
    ? {
        pointerType: currentStroke.pointerType,
        x: [...currentStroke.x],
        y: [...currentStroke.y],
        pressure: [...currentStroke.pressure],
        time: [...currentStroke.time],
      }
    : null;

  // Calculate new height (additionalHeight is already in unscaled space)
  const newHeight = canvas.height + additionalHeight;

  // Calculate base width accounting for zoom
  const baseWidth = rect.width / zoomScale;

  // Resize canvas (dimensions in unscaled space)
  canvas.width = baseWidth;
  canvas.height = newHeight;

  // Set canvas CSS size explicitly
  canvas.style.width = `${baseWidth}px`;
  canvas.style.height = `${newHeight}px`;

  // Also expand the text editor to match (needs to be scaled for CSS transform)
  if (currentEditor) {
    currentEditor.style.minHeight = `${newHeight}px`;
  }

  // Restore completed strokes
  strokes = currentStrokes;
  redrawCanvas();

  // Restore the current stroke being drawn
  if (currentStrokeInProgress && currentStrokeInProgress.x.length > 0) {
    currentStroke = currentStrokeInProgress;
    drawStroke(currentStroke);
  }

  // Update expansion zone indicator position
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

  // Create indicator if it doesn't exist
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "expansion-zone-indicator";
    indicator.className = "expansion-zone-indicator";
    canvas.parentElement.appendChild(indicator);
  }

  const expansionThreshold = 300;
  const distanceFromBottom = canvas.height - (currentY || 0);

  // Show indicator when in expansion zone or force update
  if ((currentY !== null && distanceFromBottom < expansionThreshold) || forceUpdate) {
    const triggerLine = canvas.height - expansionThreshold;
    indicator.style.top = `${triggerLine}px`;
    indicator.style.display = "block";

    // Fade in/out based on proximity
    if (currentY !== null) {
      const opacity = Math.max(0.2, Math.min(0.6, 1 - distanceFromBottom / expansionThreshold));
      indicator.style.opacity = opacity;
    }
  } else if (currentY === null) {
    // Hide indicator when not drawing
    indicator.style.display = "none";
  }
}

/**
 * Handle pointer down for auto mode detection
 */
function handlePointerDown(e) {
  console.log("Text editor pointer down:", {
    pointerType: e.pointerType,
    isDrawMode: isDrawMode,
    autoSwitchedToDrawMode: autoSwitchedToDrawMode,
  });

  // Auto-detect stylus (pen) input - switch to draw mode
  if (e.pointerType === "pen") {
    if (!isDrawMode) {
      console.log("Switching to draw mode (stylus detected)");
      switchToDrawMode();
      autoSwitchedToDrawMode = true; // Remember this was auto-switched
    }
    e.preventDefault();
  }
  // Auto-detect touch input - switch to text/pan mode if we auto-switched to draw mode
  else if (e.pointerType === "touch" && autoSwitchedToDrawMode) {
    console.log("Touch detected with auto-switched draw mode - switching to text mode");
    if (isDrawMode) {
      switchToTextMode();
    }
  }
}

/**
 * Handle pointer move
 */
function handlePointerMove(e) {
  if (e.pointerType === "pen" && !isDrawMode) {
    console.log("Stylus hover detected on text editor - switching to draw mode");
    switchToDrawMode();
    autoSwitchedToDrawMode = true; // Remember this was auto-switched
    updateModeIndicator();
  }
}

/**
 * Handle pointer up
 */
function handlePointerUp(_e) {
  // Nothing to do here for text editor
}

/**
 * Get correct canvas coordinates accounting for scroll and zoom
 */
function getCanvasCoordinates(e) {
  // Get the actual pointer coordinates
  let clientX = e.clientX;
  let clientY = e.clientY;

  // For touch events, use the first touch point
  if (e.touches && e.touches.length > 0) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  }

  // Get canvas position relative to viewport
  const rect = canvas.getBoundingClientRect();

  // Calculate coordinates relative to canvas
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  // Scale coordinates from display size to canvas internal size
  // rect.width/height includes the CSS zoom transform effect
  // canvas.width/height is the actual internal size (unzoomed)
  // So scaleX/scaleY accounts for both the CSS sizing and zoom
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: x * scaleX,
    y: y * scaleY,
  };
}

/**
 * Handle canvas pointer down
 * @returns {boolean} false if mode was switched to text (touch after auto-switch), true otherwise
 */
function handleCanvasPointerDown(e) {
  // Debug logging - including pointer type and buttons
  console.log("Canvas pointer down:", {
    pointerType: e.pointerType,
    buttons: e.buttons,
    button: e.button,
    pointerTypeName: e.pointerType,
    isDrawMode: isDrawMode,
    autoSwitchedToDrawMode: autoSwitchedToDrawMode,
  });

  // CRITICAL: Check for stylus/pen input and set auto-switch flag
  // This is needed because once in draw mode, the canvas captures events and text editor doesn't
  if (e.pointerType === "pen" || e.pointerType === "eraser") {
    console.log("Stylus detected on canvas - ensuring auto-switch flag is set");
    if (!isDrawMode) {
      switchToDrawMode();
    }
    autoSwitchedToDrawMode = true; // Always set when stylus is used
    updateModeIndicator(); // Update the indicator immediately
  }

  // CRITICAL: Check for auto-switch to text/pan mode when touch is detected
  // This must happen AFTER checking for pen, so pen sets the flag first
  // IMPORTANT: Only switch if we're NOT currently drawing (to avoid switching mid-stroke)
  if (e.pointerType === "touch" && autoSwitchedToDrawMode && !isDrawing) {
    console.log(
      "Touch on canvas detected with auto-switched draw mode - switching to text mode for panning",
    );
    switchToTextMode();
    e.stopPropagation(); // Stop event propagation
    e.preventDefault(); // Prevent default to avoid any drawing
    return false; // Signal to wrapper that we switched to text mode
  }

  // If we're not in draw mode, don't proceed with drawing
  if (!isDrawMode) return true;

  // Check if eraser is active
  // Method 1: Manual eraser mode (user clicked eraser button)
  // Method 2: Automatic detection for devices that support it:
  //   - Check if pointerType is 'eraser' (some devices report this)
  //   - Check button state for various stylus types:
  //     - Samsung S Pen: button === 2 (secondary button when pen button held) - NOTE: May not work on S Pen
  //     - Other stylus: button === 5 or buttons === 32
  const isEraserButton =
    e.pointerType === "eraser" || e.button === 2 || e.button === 5 || e.buttons === 32;
  const shouldErase = isEraserMode || isEraserButton;

  if (shouldErase) {
    console.log("✓ ERASER ACTIVE - starting erase mode", {
      isEraserMode: isEraserMode,
      isEraserButton: isEraserButton,
    });
    isErasing = true;
    isDrawing = false; // Don't draw while erasing
  } else {
    console.log("✗ Normal drawing mode");
    isErasing = false;
    isDrawing = true;
    currentStroke = [];
  }

  const { x, y } = getCanvasCoordinates(e);

  // More debug logging
  console.log("Starting stroke:", {
    pointerType: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    isErasing: isErasing,
    x,
    y,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });

  // Update mode indicator with debug info
  updateModeIndicator({
    pointerType: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    isErasing: isErasing,
  });

  if (isErasing) {
    // Start erasing at this point
    eraseStrokesAtPoint(x, y);
  } else {
    // Initialize stroke structure if this is the first point
    if (currentStroke.length === 0) {
      currentStroke = {
        pointerType: e.pointerType, // Store once per stroke
        x: [],
        y: [],
        pressure: [],
        time: [],
        colorIndex: currentPenColorIndex,
        width: currentPenWidth,
      };
    }

    // Add point data to arrays
    currentStroke.x.push(x);
    currentStroke.y.push(y);
    currentStroke.pressure.push(e.pressure || 0.5);
    currentStroke.time.push(Date.now());
  }

  return true; // Continue with normal drawing
}

/**
 * Handle canvas pointer move
 */
function handleCanvasPointerMove(e) {
  if ((!isDrawing && !isErasing) || !isDrawMode) return;

  const { x, y } = getCanvasCoordinates(e);

  // Update mode indicator with debug info during move
  updateModeIndicator({
    pointerType: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    isErasing: isErasing,
  });

  if (isErasing) {
    // Erase strokes at current position
    eraseStrokesAtPoint(x, y);

    // Draw eraser cursor indicator
    drawEraserCursor(x, y);
  } else {
    // Normal drawing - add point to arrays
    currentStroke.x.push(x);
    currentStroke.y.push(y);
    currentStroke.pressure.push(e.pressure || 0.5);
    currentStroke.time.push(Date.now());

    // Check if drawing near bottom and expand if needed
    const expansionThreshold = 300; // Trigger when within 300px of bottom
    const distanceFromBottom = canvas.height - y;

    if (distanceFromBottom < expansionThreshold) {
      expandCanvas(800); // Add 800px more space
    }

    // Draw incrementally for better performance
    const pointCount = currentStroke.x.length;
    if (pointCount > 1) {
      const prevX = currentStroke.x[pointCount - 2];
      const prevY = currentStroke.y[pointCount - 2];
      const currX = currentStroke.x[pointCount - 1];
      const currY = currentStroke.y[pointCount - 1];

      const palette = getThemePalette();
      ctx.strokeStyle = palette[currentStroke.colorIndex] || palette[0];
      ctx.lineWidth = currentStroke.width || 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      ctx.moveTo(prevX, prevY);
      ctx.lineTo(currX, currY);
      ctx.stroke();
    }

    // Update expansion zone indicator
    updateExpansionZoneIndicator(y);
  }
}

/**
 * Handle canvas pointer up
 */
function handleCanvasPointerUp(_e) {
  if (isErasing) {
    isErasing = false;
    // Redraw canvas to remove eraser cursor
    redrawCanvas();
    // Auto-save after erasing
    setTimeout(async () => {
      await saveNoteContent();
    }, 500);
    return;
  }

  if (!isDrawing) return;

  isDrawing = false;

  if (currentStroke.x && currentStroke.x.length > 0) {
    // Save stroke (deep copy)
    strokes.push({
      pointerType: currentStroke.pointerType,
      x: [...currentStroke.x],
      y: [...currentStroke.y],
      pressure: [...currentStroke.pressure],
      time: [...currentStroke.time],
      colorIndex: currentStroke.colorIndex,
      width: currentStroke.width,
    });
    currentStroke = [];

    // Hide expansion zone indicator
    updateExpansionZoneIndicator(null);

    // Update content bounds for overflow handling
    updateContentBounds();

    // Auto-save
    setTimeout(async () => {
      await saveNoteContent();
    }, 500);
  }
}

/**
 * Draw a single stroke with smooth curves
 */
function drawStroke(stroke) {
  if (!ctx || !stroke.x || stroke.x.length < 2) return;

  const pointCount = stroke.x.length;

  const palette = getThemePalette();
  // Use colorIndex if available (theme-aware), fallback to hardcoded color (legacy)
  ctx.strokeStyle = (stroke.colorIndex !== undefined) 
    ? palette[stroke.colorIndex] 
    : (stroke.color || palette[0]);
  ctx.lineWidth = stroke.width || 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(stroke.x[0], stroke.y[0]);

  // Use quadratic curves for smoother lines
  if (pointCount === 2) {
    ctx.lineTo(stroke.x[1], stroke.y[1]);
  } else {
    for (let i = 1; i < pointCount - 1; i++) {
      const xc = (stroke.x[i] + stroke.x[i + 1]) / 2;
      const yc = (stroke.y[i] + stroke.y[i + 1]) / 2;
      ctx.quadraticCurveTo(stroke.x[i], stroke.y[i], xc, yc);
    }
    // Draw last segment
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
}

/**
 * Redraw entire canvas
 */
function redrawCanvas() {
  if (!ctx) return;

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw all strokes
  // Note: Zoom is handled by CSS transform on the canvas element,
  // so we don't apply ctx.scale() here
  strokes.forEach((stroke) => {
    drawStroke(stroke);
  });
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
  // Calculate distance from point to line segment
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

  // Check each segment of the stroke
  for (let i = 0; i < pointCount - 1; i++) {
    const x1 = stroke.x[i];
    const y1 = stroke.y[i];
    const x2 = stroke.x[i + 1];
    const y2 = stroke.y[i + 1];

    if (isPointNearLine(eraserX, eraserY, x1, y1, x2, y2, eraserRadius)) {
      return true;
    }
  }

  // Also check if any point is within eraser radius
  for (let i = 0; i < pointCount; i++) {
    const dx = stroke.x[i] - eraserX;
    const dy = stroke.y[i] - eraserY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= eraserRadius) {
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
  // Filter out strokes that intersect with the eraser
  const originalLength = strokes.length;
  strokes = strokes.filter((stroke) => !strokeIntersectsEraser(stroke, x, y));

  // Only redraw if strokes were removed
  if (strokes.length < originalLength) {
    console.log(`Erased ${originalLength - strokes.length} stroke(s)`);
    redrawCanvas();
    // Update content bounds after erasing
    updateContentBounds();
  }
}

/**
 * Draw eraser cursor indicator
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 */
function drawEraserCursor(x, y) {
  if (!ctx) return;

  // Save context state
  ctx.save();

  // Draw eraser circle outline
  ctx.strokeStyle = "#ff0000";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]); // Dashed line
  ctx.beginPath();
  ctx.arc(x, y, eraserRadius, 0, 2 * Math.PI);
  ctx.stroke();

  // Restore context state
  ctx.restore();
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
  if (isDrawMode && !isEraserMode) {
    togglePenSettingsDialog();
    return;
  }

  autoSwitchedToDrawMode = false; // Clear auto-switch flag
  isEraserMode = false; // Exit eraser mode when switching to draw
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

  isEraserMode = !isEraserMode;

  // If enabling eraser mode, make sure we're in draw mode
  if (isEraserMode && !isDrawMode) {
    autoSwitchedToDrawMode = false; // Clear auto-switch flag
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

  if (textBtn) {
    textBtn.classList.toggle("active", !isDrawMode);
  }
  if (drawBtn) {
    drawBtn.classList.toggle("active", isDrawMode && !isEraserMode);
  }
  if (eraseBtn) {
    eraseBtn.classList.toggle("active", isEraserMode);
  }
}

/**
 * Get pen color palette based on current theme
 */
function getThemePalette() {
  const theme = getTheme();
  if (theme === "dark") {
    return ["#ffffff", "#f87171", "#60a5fa", "#34d399", "#fbbf24", "#a78bfa", "#9ca3af", "#fde047"];
  } else if (theme === "epaper") {
    return ["#000000", "#800000", "#000080", "#006400", "#a52a2a", "#4b0082", "#2f4f4f", "#5d4037"];
  }
  // Default Light theme
  return ["#000000", "#ef4444", "#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#6b7280", "#78350f"];
}

/**
 * Toggle pen settings dialog visibility
 */
function togglePenSettingsDialog() {
  const dialog = document.getElementById("pen-settings-dialog");
  if (!dialog) return;

  const isVisible = dialog.style.display === "block";
  if (isVisible) {
    dialog.style.display = "none";
  } else {
    updatePenSettingsUI();
    dialog.style.display = "block";
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
  const drawBtn = document.getElementById("mode-draw-btn");

  if (dialog && dialog.style.display === "block") {
    // Close if the target is not the dialog itself and not the button that toggles it
    if (!dialog.contains(e.target) && !drawBtn?.contains(e.target)) {
      dialog.style.display = "none";
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

  // Add global listener to close pen settings when clicking outside
  document.addEventListener("pointerdown", handleOutsideClick);

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

  // Apply same CSS transform to canvas to keep them aligned
  // Don't set width/height here - let resizeCanvas() handle sizing
  if (canvas) {
    canvas.style.transformOrigin = "top left";
    canvas.style.transform = `scale(${zoomScale})`;
  }

  // Redraw canvas with zoom applied via context transform
  if (canvas && ctx) {
    // Store current scroll position
    const wrapper = document.querySelector(".editor-content-wrapper");
    const scrollLeft = wrapper ? wrapper.scrollLeft : 0;
    const scrollTop = wrapper ? wrapper.scrollTop : 0;

    // Redraw canvas with zoom applied via context transform
    redrawCanvas();

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

  // Listen for navigation changes to cleanup
  window.addEventListener("navigate", (e) => {
    if (e.detail.previousMode === "notebook") {
      cleanupNotebookEditor();
    }
  });

  console.log("Notebook editor component initialized");
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
}
