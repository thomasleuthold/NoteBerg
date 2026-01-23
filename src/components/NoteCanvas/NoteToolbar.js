/**
 * NoteToolbar - Floating toolbar for NoteCanvas
 * Manages Pan vs Draw vs Eraser mode switching and pen settings
 */

import { getIcon } from "../../utils/icons.js";
import { getThemePalette } from "../../utils/noteRenderer.js";

/**
 * Generate pen icon SVG with colored tip
 * @param {string} tipColor - Color for the pen tip
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getPenIconWithColor(tipColor, size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
    <path d="m15 5 4 4"/>
    <circle cx="4" cy="20" r="2" fill="${tipColor}" stroke="${tipColor}"/>
  </svg>`;
}

export class NoteToolbar {
  /**
   * @param {HTMLElement} container - Container to append toolbar to
   * @param {Function} onModeChange - Callback (mode) => void. mode: 'pan' | 'draw' | 'eraser'
   * @param {Object} options - Optional configuration
   * @param {Function} options.onPenSettingsChange - Callback ({ width, colorIndex }) => void
   */
  constructor(container, onModeChange, options = {}) {
    this.container = container;
    this.onModeChange = onModeChange;
    this.onPenSettingsChange = options.onPenSettingsChange || (() => {});
    this.element = null;
    this.panBtn = null;
    this.drawBtn = null;
    this.eraserBtn = null;
    this.penSettingsDialog = null;
    this.currentMode = "pan";

    // Pen settings state
    this.penWidth = 2;
    this.penColorIndex = 0;

    // Bind methods
    this._handleDocumentClick = this._handleDocumentClick.bind(this);

    this._createDOM();
  }

  _createDOM() {
    this.element = document.createElement("div");
    this.element.className = "note-canvas-toolbar";

    const createBtn = (id, icon, title) => {
      const btn = document.createElement("button");
      btn.id = `nc-tool-${id}`;
      btn.className = "note-canvas-toolbar__button";
      btn.title = title;
      btn.innerHTML = icon;
      return btn;
    };

    // Use icons from icons.js
    const handIcon = getIcon("hand", 24);
    const eraserIcon = getIcon("eraser", 24);

    this.panBtn = createBtn("pan", handIcon, "Pan Mode");
    this.panBtn.onclick = () => this.onModeChange("pan");

    // Draw button container (for positioning dialog)
    this.drawBtnContainer = document.createElement("div");
    this.drawBtnContainer.className = "note-canvas-toolbar__button-container";

    // Get initial pen color for icon
    const palette = getThemePalette();
    const initialColor = palette[this.penColorIndex] || palette[0];
    const penIcon = getPenIconWithColor(initialColor, 24);

    this.drawBtn = createBtn("draw", penIcon, "Draw Mode");
    this.drawBtn.onclick = (e) => this._handleDrawClick(e);

    this.drawBtnContainer.appendChild(this.drawBtn);

    // Create pen settings dialog
    this._createPenSettingsDialog();

    this.eraserBtn = createBtn("eraser", eraserIcon, "Eraser Mode");
    this.eraserBtn.onclick = () => this.onModeChange("eraser");

    this.element.appendChild(this.panBtn);
    this.element.appendChild(this.drawBtnContainer);
    this.element.appendChild(this.eraserBtn);
    this.container.appendChild(this.element);
  }

  /**
   * Create the pen settings dialog element
   * @private
   */
  _createPenSettingsDialog() {
    this.penSettingsDialog = document.createElement("div");
    this.penSettingsDialog.className = "note-canvas-toolbar__pen-dialog";
    this.penSettingsDialog.innerHTML = this._getPenDialogHTML();

    this.drawBtnContainer.appendChild(this.penSettingsDialog);

    // Set up event listeners for dialog controls
    this._setupPenDialogListeners();
  }

  /**
   * Generate HTML for pen settings dialog
   * @private
   */
  _getPenDialogHTML() {
    const palette = getThemePalette();

    const colorSwatches = palette
      .map(
        (color, index) => `
        <button
          class="note-canvas-toolbar__color-swatch ${index === this.penColorIndex ? "note-canvas-toolbar__color-swatch--active" : ""}"
          data-color-index="${index}"
          style="background-color: ${color}"
          title="Color ${index + 1}"
        ></button>
      `,
      )
      .join("");

    return `
      <div class="note-canvas-toolbar__pen-dialog-section">
        <label class="note-canvas-toolbar__pen-dialog-label">
          Line Width: <span class="note-canvas-toolbar__width-value">${this.penWidth}</span>
        </label>
        <input
          type="range"
          class="note-canvas-toolbar__width-slider"
          min="0.25"
          max="15"
          step="0.25"
          value="${this.penWidth}"
        />
      </div>
      <div class="note-canvas-toolbar__pen-dialog-section">
        <label class="note-canvas-toolbar__pen-dialog-label">Color</label>
        <div class="note-canvas-toolbar__color-grid">
          ${colorSwatches}
        </div>
      </div>
    `;
  }

  /**
   * Set up event listeners for pen dialog controls
   * @private
   */
  _setupPenDialogListeners() {
    // Width slider
    const slider = this.penSettingsDialog.querySelector(".note-canvas-toolbar__width-slider");
    const widthValue = this.penSettingsDialog.querySelector(".note-canvas-toolbar__width-value");

    if (slider) {
      slider.addEventListener("input", (e) => {
        this.penWidth = parseFloat(e.target.value);
        if (widthValue) {
          widthValue.textContent = this.penWidth;
        }
        this._notifyPenSettingsChange();
      });
    }

    // Color swatches
    const swatches = this.penSettingsDialog.querySelectorAll(".note-canvas-toolbar__color-swatch");
    swatches.forEach((swatch) => {
      swatch.addEventListener("click", (e) => {
        e.stopPropagation();
        const index = parseInt(swatch.dataset.colorIndex, 10);
        this._selectColor(index);
      });
    });

    // Prevent dialog clicks from closing it
    this.penSettingsDialog.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  /**
   * Select a color by index
   * @private
   */
  _selectColor(index) {
    this.penColorIndex = index;

    // Update active state on swatches
    const swatches = this.penSettingsDialog.querySelectorAll(".note-canvas-toolbar__color-swatch");
    swatches.forEach((swatch, i) => {
      if (i === index) {
        swatch.classList.add("note-canvas-toolbar__color-swatch--active");
      } else {
        swatch.classList.remove("note-canvas-toolbar__color-swatch--active");
      }
    });

    // Update pen icon color
    this._updatePenIconColor();

    this._notifyPenSettingsChange();
  }

  /**
   * Update the pen button icon to reflect the selected color
   * @private
   */
  _updatePenIconColor() {
    const palette = getThemePalette();
    const color = palette[this.penColorIndex] || palette[0];
    this.drawBtn.innerHTML = getPenIconWithColor(color, 24);
  }

  /**
   * Notify parent of pen settings change
   * @private
   */
  _notifyPenSettingsChange() {
    this.onPenSettingsChange({
      width: this.penWidth,
      colorIndex: this.penColorIndex,
    });
  }

  /**
   * Handle draw button click
   * @private
   */
  _handleDrawClick(e) {
    e.stopPropagation();

    if (this.currentMode === "draw") {
      // Already in draw mode - toggle dialog
      this._togglePenDialog();
    } else {
      // Switch to draw mode
      this.onModeChange("draw");
    }
  }

  /**
   * Toggle pen settings dialog visibility
   * @private
   */
  _togglePenDialog() {
    const isOpen = this.penSettingsDialog.classList.contains(
      "note-canvas-toolbar__pen-dialog--open",
    );

    if (isOpen) {
      this._closePenDialog();
    } else {
      this._openPenDialog();
    }
  }

  /**
   * Open pen settings dialog
   * @private
   */
  _openPenDialog() {
    // Refresh colors in case theme changed
    this._refreshColorSwatches();

    this.penSettingsDialog.classList.add("note-canvas-toolbar__pen-dialog--open");
    document.addEventListener("click", this._handleDocumentClick);
  }

  /**
   * Close pen settings dialog
   * @private
   */
  _closePenDialog() {
    this.penSettingsDialog.classList.remove("note-canvas-toolbar__pen-dialog--open");
    document.removeEventListener("click", this._handleDocumentClick);
  }

  /**
   * Handle document click to close dialog
   * @private
   */
  _handleDocumentClick(e) {
    // Check if click is outside dialog and draw button
    if (!this.penSettingsDialog.contains(e.target) && !this.drawBtn.contains(e.target)) {
      this._closePenDialog();
    }
  }

  /**
   * Refresh color swatches (e.g., after theme change)
   * @private
   */
  _refreshColorSwatches() {
    const palette = getThemePalette();
    const swatches = this.penSettingsDialog.querySelectorAll(".note-canvas-toolbar__color-swatch");

    swatches.forEach((swatch, index) => {
      if (palette[index]) {
        swatch.style.backgroundColor = palette[index];
      }
    });

    // Also update pen icon color
    this._updatePenIconColor();
  }

  /**
   * Update current pen settings (called externally to sync state)
   * @param {Object} settings - { width, colorIndex }
   */
  setPenSettings(settings) {
    if (settings.width !== undefined) {
      this.penWidth = settings.width;
      const slider = this.penSettingsDialog?.querySelector(".note-canvas-toolbar__width-slider");
      const widthValue = this.penSettingsDialog?.querySelector(".note-canvas-toolbar__width-value");
      if (slider) slider.value = this.penWidth;
      if (widthValue) widthValue.textContent = this.penWidth;
    }

    if (settings.colorIndex !== undefined) {
      this._selectColor(settings.colorIndex);
    }
  }

  updateMode(mode) {
    this.currentMode = mode;

    const setActive = (btn, active) => {
      if (active) {
        btn.classList.add("note-canvas-toolbar__button--active");
      } else {
        btn.classList.remove("note-canvas-toolbar__button--active");
      }
    };

    setActive(this.panBtn, mode === "pan");
    setActive(this.drawBtn, mode === "draw");
    setActive(this.eraserBtn, mode === "eraser");

    // Close pen dialog when switching away from draw mode
    if (mode !== "draw") {
      this._closePenDialog();
    }
  }

  destroy() {
    document.removeEventListener("click", this._handleDocumentClick);

    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
    this.panBtn = null;
    this.drawBtn = null;
    this.drawBtnContainer = null;
    this.eraserBtn = null;
    this.penSettingsDialog = null;
  }
}
