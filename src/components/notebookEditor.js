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
let canvas = null;
let ctx = null;
let isDrawing = false;
let currentStroke = [];
let strokes = [];
let lastExpansionTime = 0;
let expansionCooldown = 500; // Minimum ms between expansions

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
          <button class="toolbar-btn" id="mode-text-btn" title="Text mode">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
            </svg>
          </button>
          <button class="toolbar-btn" id="mode-draw-btn" title="Draw mode">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 19l7-7 3 3-7 7-3-3z"/>
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
              <path d="M2 2l7.586 7.586"/>
            </svg>
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
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="8" y1="6" x2="21" y2="6"/>
              <line x1="8" y1="12" x2="21" y2="12"/>
              <line x1="8" y1="18" x2="21" y2="18"/>
              <line x1="3" y1="6" x2="3.01" y2="6"/>
              <line x1="3" y1="12" x2="3.01" y2="12"/>
              <line x1="3" y1="18" x2="3.01" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="toolbar-section">
          <button class="toolbar-btn" id="clear-canvas-btn" title="Clear drawings">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
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
    handleCanvasPointerDown(e);
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
  // Auto-detect stylus (pen) input
  if (e.pointerType === 'pen') {
    switchToDrawMode();
    e.preventDefault();
  }
}

/**
 * Handle pointer move
 */
function handlePointerMove(e) {
  if (e.pointerType === 'pen' && !isDrawMode) {
    switchToDrawMode();
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
 */
function handleCanvasPointerDown(e) {
  if (!isDrawMode) return;

  isDrawing = true;
  currentStroke = [];

  const { x, y } = getCanvasCoordinates(e);

  // Debug logging (can be removed later)
  const rect = canvas.getBoundingClientRect();
  console.log('Pointer down:', {
    clientX: e.clientX,
    clientY: e.clientY,
    calculatedX: x,
    calculatedY: y,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    displayWidth: rect.width,
    displayHeight: rect.height,
    scaleX: canvas.width / rect.width,
    scaleY: canvas.height / rect.height,
    rectTop: rect.top,
    rectLeft: rect.left
  });

  currentStroke.push({ x, y, pressure: e.pressure || 0.5, time: Date.now() });
}

/**
 * Handle canvas pointer move
 */
function handleCanvasPointerMove(e) {
  if (!isDrawing || !isDrawMode) return;

  const { x, y } = getCanvasCoordinates(e);
  currentStroke.push({ x, y, pressure: e.pressure || 0.5, time: Date.now() });

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

    ctx.strokeStyle = '#000000';
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

/**
 * Handle canvas pointer up
 */
function handleCanvasPointerUp(e) {
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

  ctx.strokeStyle = '#000000';
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
 * Switch to draw mode
 */
function switchToDrawMode() {
  isDrawMode = true;
  canvas.style.pointerEvents = 'auto';
  currentEditor.style.pointerEvents = 'none';

  document.getElementById('mode-draw-btn')?.classList.add('active');
  document.getElementById('mode-text-btn')?.classList.remove('active');

  const modeText = document.getElementById('current-mode-text');
  if (modeText) modeText.textContent = 'Draw Mode';
}

/**
 * Switch to text mode
 */
function switchToTextMode() {
  isDrawMode = false;
  canvas.style.pointerEvents = 'none';
  currentEditor.style.pointerEvents = 'auto';

  document.getElementById('mode-text-btn')?.classList.add('active');
  document.getElementById('mode-draw-btn')?.classList.remove('active');

  const modeText = document.getElementById('current-mode-text');
  if (modeText) modeText.textContent = 'Text Mode';
}

/**
 * Attach toolbar event listeners
 */
function attachToolbarListeners() {
  // Mode switching
  document.getElementById('mode-text-btn')?.addEventListener('click', switchToTextMode);
  document.getElementById('mode-draw-btn')?.addEventListener('click', switchToDrawMode);

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
