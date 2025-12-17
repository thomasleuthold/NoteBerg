/**
 * Notebook Editor Component
 * Layered canvas approach with text editor and drawing layer
 * Auto-detects input type (stylus vs mouse) for mode switching
 */

import { getNote, updateNote } from '../modules/storage.js';
import { getCurrentNoteId } from '../modules/router.js';

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
let expansionCooldown = 500; // Minimum ms between expansions
let autoSwitchedToDrawMode = false; // Track if draw mode was auto-activated by stylus
let eraserRadius = 20; // Eraser size in pixels

/**
 * Initialize notebook editor for a note
 * @param {string} noteId - ID of note to edit
 */
export async function initNotebookEditor(noteId) {
  if (!noteId) {
    console.warn('No note ID provided to editor');
    return;
  }

  try {
    // Load note data
    currentNoteData = await getNote(noteId);
    if (!currentNoteData) {
      throw new Error('Note not found');
    }

    // Get or create editor container
    const editorContainer = document.getElementById('notebook-editor-container');
    if (!editorContainer) {
      console.error('Editor container not found');
      return;
    }

    // Render editor UI
    renderEditor(editorContainer, currentNoteData);

    // Initialize text editor
    initTextEditor(currentNoteData);

    // Initialize canvas layer
    initCanvasLayer(currentNoteData);

    console.log('Notebook editor initialized for note:', noteId);
  } catch (error) {
    console.error('Error initializing notebook editor:', error);
  }
}

/**
 * Render editor structure
 */
function renderEditor(container, noteData) {
  container.innerHTML = `
    <div class="notebook-editor">
      <div class="editor-toolbar">
        <div class="toolbar-section">
          <button class="toolbar-btn toolbar-btn-text" id="mode-text-btn" title="Text mode">
            T
          </button>
          <button class="toolbar-btn" id="mode-draw-btn" title="Draw mode">
            ✏️
          </button>
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
        <div class="toolbar-section">
          <button class="toolbar-btn" id="clear-canvas-btn" title="Clear drawings">
            🗑️
          </button>
        </div>
        <div class="toolbar-section mode-indicator">
          <span id="current-mode-text">Text Mode</span>
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
  const textEditor = document.getElementById('text-editor');
  if (!textEditor) return;

  // Set initial content (convert markdown to HTML for WYSIWYG)
  if (noteData.content) {
    textEditor.innerHTML = markdownToHtml(noteData.content);
  } else {
    textEditor.innerHTML = '<p><br></p>';
  }

  // Auto-save on input with debounce
  let saveTimeout;
  let resizeTimeout;
  textEditor.addEventListener('input', () => {
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
  textEditor.addEventListener('pointerdown', handlePointerDown);
  textEditor.addEventListener('pointermove', handlePointerMove);
  textEditor.addEventListener('pointerup', handlePointerUp);

  currentEditor = textEditor;
}

/**
 * Initialize canvas layer for drawing
 */
function initCanvasLayer(noteData) {
  canvas = document.getElementById('drawing-canvas');
  if (!canvas) return;

  ctx = canvas.getContext('2d');

  // Size canvas to match editor
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Load existing strokes
  if (noteData.strokes && Array.isArray(noteData.strokes)) {
    strokes = noteData.strokes;
    redrawCanvas();
  }

  // Canvas drawing events with pointer capture for better performance
  canvas.addEventListener('pointerdown', (e) => {
    console.log('=== POINTERDOWN WRAPPER ===', {
      pointerType: e.pointerType,
      isDrawMode: isDrawMode,
      autoSwitchedToDrawMode: autoSwitchedToDrawMode,
      canvasHasActiveClass: canvas.classList.contains('active'),
      canvasPointerEvents: canvas.style.pointerEvents
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
  canvas.addEventListener('pointermove', (e) => {
    if (isDrawing && isDrawMode) {
      e.preventDefault(); // Prevent scrolling during drawing
    }
    handleCanvasPointerMove(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    handleCanvasPointerUp(e);
    if (isDrawMode && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointercancel', handleCanvasPointerUp);

  // Prevent touch scrolling on canvas when in draw mode
  canvas.addEventListener('touchstart', (e) => {
    // Check if we need to auto-switch to text/pan mode
    // IMPORTANT: Only switch if we're NOT currently drawing (to avoid switching mid-stroke)
    if (autoSwitchedToDrawMode && isDrawMode && !isDrawing) {
      console.log('Touch start detected with auto-switched draw mode - switching to text mode');
      switchToTextMode();
      // Don't prevent default - allow scrolling/panning
      return;
    }

    if (isDrawMode) {
      e.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (isDrawMode) {
      e.preventDefault();
    }
  }, { passive: false });
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

  // Get the actual scrollable content height from the text editor
  // Add padding to ensure we have enough space
  const textEditorHeight = currentEditor.scrollHeight + 200; // Extra padding for growth

  // Also check the wrapper's scroll height
  const wrapperScrollHeight = wrapper.scrollHeight;

  // Use the maximum of all measurements to ensure canvas is large enough
  const requiredHeight = Math.max(textEditorHeight, wrapperScrollHeight, rect.height, 800);

  // Resize canvas to match text editor dimensions
  canvas.width = rect.width;
  canvas.height = requiredHeight;

  // Restore strokes
  strokes = currentStrokes;
  redrawCanvas();
}

/**
 * Expand canvas height by a specified amount
 * @param {number} additionalHeight - Height to add in pixels
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
  const currentStrokeInProgress = [...currentStroke];

  // Calculate new height
  const newHeight = canvas.height + additionalHeight;

  // Resize canvas
  canvas.width = rect.width;
  canvas.height = newHeight;

  // Also expand the text editor to match
  if (currentEditor) {
    currentEditor.style.minHeight = `${newHeight}px`;
  }

  // Restore completed strokes
  strokes = currentStrokes;
  redrawCanvas();

  // Restore the current stroke being drawn
  if (currentStrokeInProgress.length > 0) {
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

  let indicator = document.getElementById('expansion-zone-indicator');

  // Create indicator if it doesn't exist
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'expansion-zone-indicator';
    indicator.className = 'expansion-zone-indicator';
    canvas.parentElement.appendChild(indicator);
  }

  const expansionThreshold = 300;
  const distanceFromBottom = canvas.height - (currentY || 0);

  // Show indicator when in expansion zone or force update
  if ((currentY !== null && distanceFromBottom < expansionThreshold) || forceUpdate) {
    const triggerLine = canvas.height - expansionThreshold;
    indicator.style.top = `${triggerLine}px`;
    indicator.style.display = 'block';

    // Fade in/out based on proximity
    if (currentY !== null) {
      const opacity = Math.max(0.2, Math.min(0.6, 1 - distanceFromBottom / expansionThreshold));
      indicator.style.opacity = opacity;
    }
  } else if (currentY === null) {
    // Hide indicator when not drawing
    indicator.style.display = 'none';
  }
}

/**
 * Handle pointer down for auto mode detection
 */
function handlePointerDown(e) {
  console.log('Text editor pointer down:', {
    pointerType: e.pointerType,
    isDrawMode: isDrawMode,
    autoSwitchedToDrawMode: autoSwitchedToDrawMode
  });

  // Auto-detect stylus (pen) input - switch to draw mode
  if (e.pointerType === 'pen') {
    if (!isDrawMode) {
      console.log('Switching to draw mode (stylus detected)');
      switchToDrawMode();
      autoSwitchedToDrawMode = true; // Remember this was auto-switched
    }
    e.preventDefault();
  }
  // Auto-detect touch input - switch to text/pan mode if we auto-switched to draw mode
  else if (e.pointerType === 'touch' && autoSwitchedToDrawMode) {
    console.log('Touch detected with auto-switched draw mode - switching to text mode');
    if (isDrawMode) {
      switchToTextMode();
    }
  }
}

/**
 * Handle pointer move
 */
function handlePointerMove(e) {
  if (e.pointerType === 'pen' && !isDrawMode) {
    console.log('Stylus hover detected on text editor - switching to draw mode');
    switchToDrawMode();
    autoSwitchedToDrawMode = true; // Remember this was auto-switched
    updateModeIndicator();
  }
}

/**
 * Handle pointer up
 */
function handlePointerUp(e) {
  // Nothing to do here for text editor
}

/**
 * Get correct canvas coordinates accounting for scroll
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

  // Scale coordinates if canvas internal size differs from display size
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: x * scaleX,
    y: y * scaleY
  };
}

/**
 * Handle canvas pointer down
 * @returns {boolean} false if mode was switched to text (touch after auto-switch), true otherwise
 */
function handleCanvasPointerDown(e) {
  // Debug logging - including pointer type and buttons
  console.log('Canvas pointer down:', {
    pointerType: e.pointerType,
    buttons: e.buttons,
    button: e.button,
    pointerTypeName: e.pointerType,
    isDrawMode: isDrawMode,
    autoSwitchedToDrawMode: autoSwitchedToDrawMode
  });

  // CRITICAL: Check for stylus/pen input and set auto-switch flag
  // This is needed because once in draw mode, the canvas captures events and text editor doesn't
  if (e.pointerType === 'pen' || e.pointerType === 'eraser') {
    console.log('Stylus detected on canvas - ensuring auto-switch flag is set');
    if (!isDrawMode) {
      switchToDrawMode();
    }
    autoSwitchedToDrawMode = true; // Always set when stylus is used
    updateModeIndicator(); // Update the indicator immediately
  }

  // CRITICAL: Check for auto-switch to text/pan mode when touch is detected
  // This must happen AFTER checking for pen, so pen sets the flag first
  // IMPORTANT: Only switch if we're NOT currently drawing (to avoid switching mid-stroke)
  if (e.pointerType === 'touch' && autoSwitchedToDrawMode && !isDrawing) {
    console.log('Touch on canvas detected with auto-switched draw mode - switching to text mode for panning');
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
  const isEraserButton = e.pointerType === 'eraser' || e.button === 2 || e.button === 5 || e.buttons === 32;
  const shouldErase = isEraserMode || isEraserButton;

  if (shouldErase) {
    console.log('✓ ERASER ACTIVE - starting erase mode', {
      isEraserMode: isEraserMode,
      isEraserButton: isEraserButton
    });
    isErasing = true;
    isDrawing = false; // Don't draw while erasing
  } else {
    console.log('✗ Normal drawing mode');
    isErasing = false;
    isDrawing = true;
    currentStroke = [];
  }

  const { x, y } = getCanvasCoordinates(e);

  // More debug logging
  console.log('Starting stroke:', {
    pointerType: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    isErasing: isErasing,
    x,
    y,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height
  });

  // Update mode indicator with debug info
  updateModeIndicator({
    pointerType: e.pointerType,
    button: e.button,
    buttons: e.buttons,
    isErasing: isErasing
  });

  if (isErasing) {
    // Start erasing at this point
    eraseStrokesAtPoint(x, y);
  } else {
    // Store pointer type with stroke for color differentiation
    currentStroke.push({
      x,
      y,
      pressure: e.pressure || 0.5,
      time: Date.now(),
      pointerType: e.pointerType // Store pointer type
    });
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
    isErasing: isErasing
  });

  if (isErasing) {
    // Erase strokes at current position
    eraseStrokesAtPoint(x, y);

    // Draw eraser cursor indicator
    drawEraserCursor(x, y);
  } else {
    // Normal drawing
    currentStroke.push({
      x,
      y,
      pressure: e.pressure || 0.5,
      time: Date.now(),
      pointerType: e.pointerType
    });

    // Check if drawing near bottom and expand if needed
    const expansionThreshold = 300; // Trigger when within 300px of bottom
    const distanceFromBottom = canvas.height - y;

    if (distanceFromBottom < expansionThreshold) {
      expandCanvas(800); // Add 800px more space
    }

    // Draw incrementally for better performance
    if (currentStroke.length > 1) {
      const prevPoint = currentStroke[currentStroke.length - 2];
      const currPoint = currentStroke[currentStroke.length - 1];

      // Use different colors for different pointer types (debug feature)
      const pointerType = currPoint.pointerType || 'unknown';
      if (pointerType === 'pen') {
        ctx.strokeStyle = '#000000'; // Black for stylus
      } else if (pointerType === 'touch') {
        ctx.strokeStyle = '#ff0000'; // Red for finger touch
      } else if (pointerType === 'mouse') {
        ctx.strokeStyle = '#0000ff'; // Blue for mouse
      } else {
        ctx.strokeStyle = '#888888'; // Gray for unknown
      }

      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      ctx.moveTo(prevPoint.x, prevPoint.y);
      ctx.lineTo(currPoint.x, currPoint.y);
      ctx.stroke();
    }

    // Update expansion zone indicator
    updateExpansionZoneIndicator(y);
  }
}

/**
 * Handle canvas pointer up
 */
function handleCanvasPointerUp(e) {
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

  if (currentStroke.length > 0) {
    // Save stroke
    strokes.push([...currentStroke]);
    currentStroke = [];

    // Hide expansion zone indicator
    updateExpansionZoneIndicator(null);

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
  if (!ctx || stroke.length < 2) return;

  // Determine color based on pointer type (debug feature)
  const pointerType = stroke[0].pointerType || 'pen';
  if (pointerType === 'pen') {
    ctx.strokeStyle = '#000000'; // Black for stylus
  } else if (pointerType === 'touch') {
    ctx.strokeStyle = '#ff0000'; // Red for finger touch
  } else if (pointerType === 'mouse') {
    ctx.strokeStyle = '#0000ff'; // Blue for mouse
  } else {
    ctx.strokeStyle = '#888888'; // Gray for unknown
  }

  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(stroke[0].x, stroke[0].y);

  // Use quadratic curves for smoother lines
  if (stroke.length === 2) {
    ctx.lineTo(stroke[1].x, stroke[1].y);
  } else {
    for (let i = 1; i < stroke.length - 1; i++) {
      const xc = (stroke[i].x + stroke[i + 1].x) / 2;
      const yc = (stroke[i].y + stroke[i + 1].y) / 2;
      ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, xc, yc);
    }
    // Draw last segment
    const last = stroke[stroke.length - 1];
    const secondLast = stroke[stroke.length - 2];
    ctx.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);
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
  strokes.forEach(stroke => {
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
 * @param {Array} stroke - Stroke points
 * @param {number} eraserX - Eraser center x
 * @param {number} eraserY - Eraser center y
 * @returns {boolean} True if stroke intersects with eraser
 */
function strokeIntersectsEraser(stroke, eraserX, eraserY) {
  if (!stroke || stroke.length === 0) return false;

  // Check each segment of the stroke
  for (let i = 0; i < stroke.length - 1; i++) {
    const p1 = stroke[i];
    const p2 = stroke[i + 1];

    if (isPointNearLine(eraserX, eraserY, p1.x, p1.y, p2.x, p2.y, eraserRadius)) {
      return true;
    }
  }

  // Also check if any point is within eraser radius
  for (const point of stroke) {
    const dx = point.x - eraserX;
    const dy = point.y - eraserY;
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
  strokes = strokes.filter(stroke => !strokeIntersectsEraser(stroke, x, y));

  // Only redraw if strokes were removed
  if (strokes.length < originalLength) {
    console.log(`Erased ${originalLength - strokes.length} stroke(s)`);
    redrawCanvas();
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
  ctx.strokeStyle = '#ff0000';
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
    canvas.classList.add('active');
    canvas.style.pointerEvents = 'auto';
  }
  if (currentEditor) {
    currentEditor.style.pointerEvents = 'none';
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
    canvas.classList.remove('active');
    canvas.style.pointerEvents = 'none';
  }
  if (currentEditor) {
    currentEditor.style.pointerEvents = 'auto';
  }

  updateToolbarButtons();
  updateModeIndicator();
}

/**
 * Update mode indicator text with auto-switch status
 */
function updateModeIndicator() {
  const modeText = document.getElementById('current-mode-text');
  if (!modeText) return;

  let mode = 'Text';
  if (isDrawMode) {
    mode = isEraserMode ? 'Erase' : 'Draw';
  }

  const switchType = autoSwitchedToDrawMode ? '(Auto)' : '(Manual)';
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
  autoSwitchedToDrawMode = false; // Clear auto-switch flag
  isEraserMode = false; // Exit eraser mode when switching to draw
  switchToDrawMode();
  updateToolbarButtons();
}

/**
 * Toggle eraser mode (user clicked eraser button)
 */
function toggleEraserMode() {
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
  const textBtn = document.getElementById('mode-text-btn');
  const drawBtn = document.getElementById('mode-draw-btn');
  const eraseBtn = document.getElementById('mode-erase-btn');

  if (textBtn) {
    textBtn.classList.toggle('active', !isDrawMode);
  }
  if (drawBtn) {
    drawBtn.classList.toggle('active', isDrawMode && !isEraserMode);
  }
  if (eraseBtn) {
    eraseBtn.classList.toggle('active', isEraserMode);
  }
}

/**
 * Attach toolbar event listeners
 */
function attachToolbarListeners() {
  // Mode switching - use manual switch functions to clear auto-switch flag
  document.getElementById('mode-text-btn')?.addEventListener('click', manualSwitchToTextMode);
  document.getElementById('mode-draw-btn')?.addEventListener('click', manualSwitchToDrawMode);
  document.getElementById('mode-erase-btn')?.addEventListener('click', toggleEraserMode);

  // Text formatting
  document.getElementById('format-bold-btn')?.addEventListener('click', () => formatText('bold'));
  document.getElementById('format-italic-btn')?.addEventListener('click', () => formatText('italic'));
  document.getElementById('format-heading-btn')?.addEventListener('click', () => formatText('heading'));
  document.getElementById('format-list-btn')?.addEventListener('click', () => formatText('list'));

  // Clear canvas
  document.getElementById('clear-canvas-btn')?.addEventListener('click', clearCanvas);
}

/**
 * Format text (simple implementation)
 */
function formatText(format) {
  if (!currentEditor) return;

  currentEditor.focus();

  switch (format) {
    case 'bold':
      document.execCommand('bold');
      break;
    case 'italic':
      document.execCommand('italic');
      break;
    case 'heading':
      document.execCommand('formatBlock', false, 'h2');
      break;
    case 'list':
      document.execCommand('insertUnorderedList');
      break;
  }
}

/**
 * Clear canvas
 */
async function clearCanvas() {
  strokes = [];
  redrawCanvas();
  await saveNoteContent();
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

    console.log('Note saved');
  } catch (error) {
    console.error('Error saving note:', error);
  }
}

/**
 * Simple markdown to HTML conversion (basic WYSIWYG)
 */
function markdownToHtml(markdown) {
  let html = markdown
    // Headers
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.*?)\*\*/gim, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.*?)\*/gim, '<em>$1</em>')
    // Lists
    .replace(/^\- (.*$)/gim, '<li>$1</li>')
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  // Wrap in paragraph if not already wrapped
  if (!html.startsWith('<')) {
    html = `<p>${html}</p>`;
  }

  // Wrap lists in ul tags
  html = html.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');

  return html;
}

/**
 * Simple HTML to markdown conversion
 */
function htmlToMarkdown(html) {
  let markdown = html
    // Headers
    .replace(/<h1>(.*?)<\/h1>/gim, '# $1\n\n')
    .replace(/<h2>(.*?)<\/h2>/gim, '## $1\n\n')
    .replace(/<h3>(.*?)<\/h3>/gim, '### $1\n\n')
    // Bold
    .replace(/<strong>(.*?)<\/strong>/gim, '**$1**')
    .replace(/<b>(.*?)<\/b>/gim, '**$1**')
    // Italic
    .replace(/<em>(.*?)<\/em>/gim, '*$1*')
    .replace(/<i>(.*?)<\/i>/gim, '*$1*')
    // Lists
    .replace(/<li>(.*?)<\/li>/gim, '- $1\n')
    .replace(/<\/?ul>/gim, '')
    // Line breaks and paragraphs
    .replace(/<br\s*\/?>/gim, '\n')
    .replace(/<\/p><p>/gim, '\n\n')
    .replace(/<\/?p>/gim, '');

  // Clean up extra whitespace
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

  return markdown;
}

/**
 * Initialize notebook editor component
 */
export function initNotebookEditorComponent() {
  // Listen for render notebook event from router
  window.addEventListener('rendernotebook', async (e) => {
    const { noteId } = e.detail;
    if (noteId) {
      await initNotebookEditor(noteId);
    }
  });

  // Listen for navigation changes to cleanup
  window.addEventListener('navigate', (e) => {
    if (e.detail.previousMode === 'notebook') {
      cleanupNotebookEditor();
    }
  });

  console.log('Notebook editor component initialized');
}

/**
 * Cleanup editor
 */
export function cleanupNotebookEditor() {
  if (canvas) {
    window.removeEventListener('resize', resizeCanvas);
  }

  currentEditor = null;
  currentNoteData = null;
  canvas = null;
  ctx = null;
  strokes = [];
  currentStroke = [];
  isDrawing = false;
  isDrawMode = false;
}
