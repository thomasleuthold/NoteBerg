/**
 * NoteToolbar - Floating toolbar for NoteCanvas
 * Manages Pan vs Draw vs Eraser mode switching and pen settings
 */

import { getIcon } from "../../utils/icons.js";
import { getMarkerPalette, getThemePalette } from "../../utils/noteRenderer.js";

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

/**
 * Generate marker icon SVG with colored tip
 * @param {string} tipColor - Color for the marker tip
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getMarkerIconWithColor(tipColor, size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="3" fill="${tipColor}" stroke="${tipColor}" />
  </svg>`;
}

/**
 * Generate more options icon SVG
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getMoreIcon(size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="1"/>
    <circle cx="12" cy="5" r="1"/>
    <circle cx="12" cy="19" r="1"/>
  </svg>`;
}

/**
 * Generate lasso icon SVG
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getLassoIcon(size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>`;
}

export class NoteToolbar {
  /**
   * @param {HTMLElement} container - Container to append toolbar to
   * @param {Function} onModeChange - Callback (mode) => void. mode: 'pan' | 'draw' | 'eraser'
   * @param {Object} options - Optional configuration
   * @param {Function} options.onPenSettingsChange - Callback ({ width, colorIndex }) => void
   * @param {Function} options.onOptionsChange - Callback ({ type, value }) => void
   * @param {Function} options.onAction - Callback (action) => void
   */
  constructor(container, onModeChange, options = {}) {
    this.container = container;
    this.onModeChange = onModeChange;
    this.onPenSettingsChange = options.onPenSettingsChange || (() => {});
    this.onOptionsChange = options.onOptionsChange || (() => {});
    this.onAction = options.onAction || (() => {});
    this.element = null;
    this.panBtn = null;
    this.drawBtn = null;
    this.eraserBtn = null;
    this.lassoBtn = null;
    this.insertBtn = null;
    this.insertDialog = null;
    this.penSettingsDialog = null;
    this.optionsBtn = null;
    this.optionsDialog = null;
    this.optionsBtnContainer = null;
    this.currentMode = "pan";

    // Presets state
    this.penPresets = options.penPresets;
    this.onPresetChange = options.onPresetChange || (() => {});
    this.isExpanded = false; // Default to quick mode (collapsed)

    // Pen settings state
    this.penWidth = this.penPresets[0].width;
    this.penColorIndex = this.penPresets[0].colorIndex;
    this.penType = this.penPresets[0].type || "pen";
    this.lastSelectedPresetIndex = 0;

    // Bind methods
    this._handleDocumentPointerDown = this._handleDocumentPointerDown.bind(this);

    this._createDOM();
  }

  _createDOM() {
    this.element = document.createElement("div");
    this.element.className = "note-canvas-toolbar";
    this.element.style.position = "relative";
    this.element.style.zIndex = "100";
    this.element.style.overflow = "visible";

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
    const lassoIcon = getLassoIcon(24);

    this.panBtn = createBtn("pan", handIcon, "Pan Mode");
    this.panBtn.onclick = () => this.onModeChange("pan");

    // Draw button container (for positioning dialog)
    this.drawBtnContainer = document.createElement("div");
    this.drawBtnContainer.className = "note-canvas-toolbar__button-container";

    // Get initial pen color for icon
    const palette = this.penType === "marker" ? getMarkerPalette() : getThemePalette();
    const initialColor = palette[this.penColorIndex] || palette[0];
    const penIcon =
      this.penType === "marker"
        ? getMarkerIconWithColor(initialColor, 24)
        : getPenIconWithColor(initialColor, 24);

    this.drawBtn = createBtn("draw", penIcon, "Draw Mode");
    this.drawBtn.onclick = (e) => this._handleDrawClick(e);

    this.drawBtnContainer.appendChild(this.drawBtn);

    // Create pen settings dialog
    this._createPenSettingsDialog();

    this.eraserBtn = createBtn("eraser", eraserIcon, "Eraser Mode");
    this.eraserBtn.onclick = () => this.onModeChange("eraser");

    this.lassoBtn = createBtn("lasso", lassoIcon, "Lasso Select");
    this.lassoBtn.onclick = () => this.onModeChange("lasso");

    // Options button container (aligned right)
    this.optionsBtnContainer = document.createElement("div");
    this.optionsBtnContainer.className = "note-canvas-toolbar__button-container";
    this.optionsBtnContainer.style.marginLeft = "auto";
    this.optionsBtnContainer.style.display = "flex";
    this.optionsBtnContainer.style.gap = "16px";

    this.insertBtn = createBtn(
      "insert",
      `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
      "Insert",
    );
    this.insertBtn.onclick = (e) => this._handleInsertClick(e);
    this.optionsBtnContainer.appendChild(this.insertBtn);
    this._createInsertDialog();

    this.optionsBtn = createBtn("options", getMoreIcon(24), "Note Options");
    this.optionsBtn.onclick = (e) => this._handleOptionsClick(e);
    this.optionsBtnContainer.appendChild(this.optionsBtn);

    this._createOptionsDialog();

    this.element.appendChild(this.panBtn);
    this.element.appendChild(this.drawBtnContainer);
    this.element.appendChild(this.eraserBtn);
    this.element.appendChild(this.lassoBtn);
    this.element.appendChild(this.optionsBtnContainer);
    this.container.appendChild(this.element);
  }

  /**
   * Create the pen settings dialog element
   * @private
   */
  _createPenSettingsDialog() {
    this.penSettingsDialog = document.createElement("div");
    this.penSettingsDialog.className = "note-canvas-toolbar__pen-dialog";

    // Prevent dialog clicks from closing it
    this.penSettingsDialog.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    this._renderDialogContent();

    this.element.appendChild(this.penSettingsDialog);
  }

  /**
   * Render the dialog content based on expanded state
   * @private
   */
  _renderDialogContent() {
    this.penSettingsDialog.innerHTML = "";

    // 1. Presets Column
    const presetsCol = document.createElement("div");
    presetsCol.className = "note-canvas-toolbar__presets";

    // Expand/Collapse Button
    const expandBtn = document.createElement("button");
    expandBtn.className = "note-canvas-toolbar__expand-btn";
    expandBtn.innerHTML = this.isExpanded
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>` // Left arrow (collapse)
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>`; // Right arrow (expand)
    expandBtn.title = this.isExpanded ? "Collapse" : "Expand Settings";
    expandBtn.onclick = (e) => {
      e.stopPropagation();
      this.isExpanded = !this.isExpanded;
      this._renderDialogContent();
    };
    presetsCol.appendChild(expandBtn);

    // Render Presets
    const themePalette = getThemePalette();
    const markerPalette = getMarkerPalette();

    this.penPresets.forEach((preset, index) => {
      const row = document.createElement("div");
      row.className = "note-canvas-toolbar__preset-row";

      const btn = document.createElement("button");
      btn.className = "note-canvas-toolbar__preset-btn";
      if (
        this.penWidth === preset.width &&
        this.penColorIndex === preset.colorIndex &&
        (preset.type || "pen") === this.penType
      ) {
        btn.classList.add("note-canvas-toolbar__preset-btn--active");
      }

      const currentPalette = preset.type === "marker" ? markerPalette : themePalette;
      const color = currentPalette[preset.colorIndex] || currentPalette[0];
      const size = Math.min(20, Math.max(4, preset.width * 2));

      const dot = document.createElement("div");
      dot.style.width = `${size}px`;
      dot.style.height = `${size}px`;
      dot.style.backgroundColor = color;
      dot.style.borderRadius = "50%";
      if (preset.type === "marker") {
        dot.style.borderRadius = "2px";
        dot.style.opacity = "0.6";
      }
      btn.appendChild(dot);

      btn.onclick = (e) => {
        e.stopPropagation();
        const currentPreset = this.penPresets[index];
        this.penWidth = currentPreset.width;
        this.penColorIndex = currentPreset.colorIndex;
        this.penType = currentPreset.type || "pen";
        this.lastSelectedPresetIndex = index;
        this._updatePenIconColor();
        this._notifyPenSettingsChange();
        this._updatePresetActiveStates();
        if (this.isExpanded) {
          this._updateSettingsUI();
        }
      };

      // Save Button
      const saveBtn = document.createElement("button");
      saveBtn.className = "note-canvas-toolbar__save-preset-btn";
      saveBtn.title = "Save current settings to this preset";
      saveBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;

      saveBtn.onclick = (e) => {
        e.stopPropagation();
        this.penPresets[index] = {
          width: this.penWidth,
          colorIndex: this.penColorIndex,
          type: this.penType,
        };

        // Update visual state of the preset button immediately
        const activePalette = this.penType === "marker" ? markerPalette : themePalette;
        const newColor = activePalette[this.penColorIndex] || activePalette[0];
        const newSize = Math.min(20, Math.max(4, this.penWidth * 2));
        dot.style.width = `${newSize}px`;
        dot.style.height = `${newSize}px`;
        dot.style.backgroundColor = newColor;

        if (this.penType === "marker") {
          dot.style.borderRadius = "2px";
          dot.style.opacity = "0.6";
        } else {
          dot.style.borderRadius = "50%";
          dot.style.opacity = "1";
        }

        this.onPresetChange(this.penPresets);
        this._updatePresetActiveStates();
      };

      row.appendChild(btn);
      row.appendChild(saveBtn);
      presetsCol.appendChild(row);
    });

    this.penSettingsDialog.appendChild(presetsCol);

    // 2. Settings Column (Only if expanded)
    if (this.isExpanded) {
      const settingsCol = document.createElement("div");
      settingsCol.className = "note-canvas-toolbar__settings-container";
      settingsCol.innerHTML = this._getPenDialogHTML();
      this.penSettingsDialog.appendChild(settingsCol);
      this._setupPenDialogListeners();
    }
  }

  /**
   * Update preset buttons active state
   * @private
   */
  _updatePresetActiveStates() {
    // 1. Check if current settings match any preset exactly
    let matchIndex = -1;
    this.penPresets.forEach((preset, index) => {
      if (
        this.penWidth === preset.width &&
        this.penColorIndex === preset.colorIndex &&
        (preset.type || "pen") === this.penType
      ) {
        matchIndex = index;
      }
    });

    // If we found a match, that becomes our "last selected" (contextually)
    if (matchIndex !== -1) {
      this.lastSelectedPresetIndex = matchIndex;
    }

    const btns = this.penSettingsDialog.querySelectorAll(".note-canvas-toolbar__preset-btn");
    const saveBtns = this.penSettingsDialog.querySelectorAll(
      ".note-canvas-toolbar__save-preset-btn",
    );

    btns.forEach((btn, index) => {
      const saveBtn = saveBtns[index];

      if (index === matchIndex) {
        btn.classList.add("note-canvas-toolbar__preset-btn--active");
        saveBtn.style.display = "none";
      } else {
        btn.classList.remove("note-canvas-toolbar__preset-btn--active");
        // Show save button if this was the last selected preset and we are in a "modified" state (no exact match)
        if (matchIndex === -1 && index === this.lastSelectedPresetIndex) {
          saveBtn.style.display = "flex";
        } else {
          saveBtn.style.display = "none";
        }
      }
    });
  }

  /**
   * Update settings UI (slider, swatches) to match current state
   * @private
   */
  _updateSettingsUI() {
    const settingsContainer = this.penSettingsDialog.querySelector(
      ".note-canvas-toolbar__settings-container",
    );
    if (settingsContainer) {
      settingsContainer.innerHTML = this._getPenDialogHTML();
      this._setupPenDialogListeners();
    }
  }

  /**
   * Generate HTML for pen settings dialog
   * @private
   */
  _getPenDialogHTML() {
    const isMarker = this.penType === "marker";
    const palette = isMarker ? getMarkerPalette() : getThemePalette();
    const minWidth = isMarker ? 10 : 0.2;
    const maxWidth = isMarker ? 50 : 15;
    const step = isMarker ? 5 : 0.1;

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
        <div class="note-canvas-toolbar__width-control">
          <button class="note-canvas-toolbar__width-btn" data-action="decrease">-</button>
          <input
            type="range"
            class="note-canvas-toolbar__width-slider"
            min="${minWidth}"
            max="${maxWidth}"
            step="${step}"
            value="${this.penWidth}"
          />
          <button class="note-canvas-toolbar__width-btn" data-action="increase">+</button>
        </div>
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
   * Create the insert dialog element
   * @private
   */
  _createInsertDialog() {
    this.insertDialog = document.createElement("div");
    this.insertDialog.className = "note-canvas-toolbar__options-dialog"; // Reuse options dialog style
    this.insertDialog.style.right = "50px"; // Offset to align with insert button

    const content = document.createElement("div");
    content.className = "note-canvas-toolbar__options-content";
    content.innerHTML = `
      <div class="note-canvas-toolbar__options-section">
        <button class="note-canvas-toolbar__option-btn" data-action="insert-image">
          ${getIcon("image", 16)} Insert Image
        </button>
        <button class="note-canvas-toolbar__option-btn" data-action="insert-camera">
          ${getIcon("camera", 16)} Take Photo
        </button>
      </div>
    `;
    this.insertDialog.appendChild(content);

    this.optionsBtnContainer.appendChild(this.insertDialog);
    this._setupInsertDialogListeners();
  }

  /**
   * Create the options dialog element
   * @private
   */
  _createOptionsDialog() {
    this.optionsDialog = document.createElement("div");
    this.optionsDialog.className = "note-canvas-toolbar__options-dialog";

    const content = document.createElement("div");
    content.className = "note-canvas-toolbar__options-content";
    content.innerHTML = this._getOptionsDialogHTML();
    this.optionsDialog.appendChild(content);

    this.optionsBtnContainer.appendChild(this.optionsDialog);
    this._setupOptionsDialogListeners();
  }

  /**
   * Generate HTML for options dialog
   * @private
   */
  _getOptionsDialogHTML() {
    return `
      <div class="note-canvas-toolbar__options-section">
        <label class="note-canvas-toolbar__options-label">Background</label>
        <div class="note-canvas-toolbar__background-list">
            <button class="note-canvas-toolbar__option-btn background-option" data-value="none">None</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="ruled-narrow">Ruled - Narrow</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="ruled-medium">Ruled - Medium</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="ruled-wide">Ruled - Wide</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="grid-small">Grid - Small</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="grid-medium">Grid - Medium</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="grid-large">Grid - Large</button>
        </div>
      </div>
      <div class="note-canvas-toolbar__separator"></div>
      <div class="note-canvas-toolbar__options-section">
        <button id="nc-delete-note-btn" class="note-canvas-toolbar__delete-btn">
            ${getIcon("trash", 16)} Delete Note
        </button>
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
    const decreaseBtn = this.penSettingsDialog.querySelector('[data-action="decrease"]');
    const increaseBtn = this.penSettingsDialog.querySelector('[data-action="increase"]');

    const snapValue = (val) => {
      if (this.penType === "marker") {
        // Snap to nearest 5 for marker
        return Math.round(val / 5) * 5;
      }
      if (val <= 2) {
        // Snap to nearest 0.2
        const snapped = Math.round(val * 5) / 5;
        return Math.max(0.2, snapped);
      }
      // Snap to nearest 1
      return Math.round(val);
    };

    const updateWidth = (val) => {
      const newVal = snapValue(val);
      this.penWidth = newVal;
      if (slider) slider.value = newVal;
      if (widthValue) widthValue.textContent = newVal % 1 === 0 ? newVal : newVal.toFixed(1);
      this._notifyPenSettingsChange();
      this._updatePresetActiveStates();
    };

    if (slider) {
      slider.addEventListener("input", (e) => {
        const val = parseFloat(e.target.value);
        updateWidth(val);
      });
    }

    if (decreaseBtn) {
      decreaseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        let current = this.penWidth;
        // Handle floating point precision
        current = Math.round(current * 10) / 10;

        let next;
        if (this.penType === "marker") {
          next = current - 5;
          if (next < 10) next = 10;
        } else {
          if (current <= 2.001) {
            next = current - 0.2;
          } else {
            next = current - 1;
          }
        }
        updateWidth(next);
      });
    }

    if (increaseBtn) {
      increaseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        let current = this.penWidth;
        current = Math.round(current * 10) / 10;

        let next;
        if (this.penType === "marker") {
          next = current + 5;
        } else {
          next = current < 2 ? current + 0.2 : current + 1;
        }
        updateWidth(next);
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
  }

  /**
   * Set up event listeners for options dialog controls
   * @private
   */
  _setupOptionsDialogListeners() {
    const bgOptions = this.optionsDialog.querySelectorAll(".background-option");
    bgOptions.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const value = e.target.dataset.value;
        this.onOptionsChange({ type: "background", value });
        // Update visual state
        bgOptions.forEach((b) => {
          b.classList.remove("note-canvas-toolbar__option-btn--active");
        });
        e.target.classList.add("note-canvas-toolbar__option-btn--active");
      });
    });

    const deleteBtn = this.optionsDialog.querySelector("#nc-delete-note-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        this.onOptionsChange({ type: "delete" });
        this._closeOptionsDialog();
      });
    }

    this.optionsDialog.addEventListener("click", (e) => e.stopPropagation());
  }

  /**
   * Set up event listeners for insert dialog controls
   * @private
   */
  _setupInsertDialogListeners() {
    const btns = this.insertDialog.querySelectorAll(".note-canvas-toolbar__option-btn");
    btns.forEach((btn) => {
      btn.addEventListener("click", (e) => {
        this.onAction(e.target.dataset.action);
        this._closeInsertDialog();
      });
    });
  }

  /**
   * Select a color by index
   * @private
   */
  _selectColor(index, notify = true) {
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

    if (notify) {
      this._notifyPenSettingsChange();
    }
    this._updatePresetActiveStates();
  }

  /**
   * Update the pen button icon to reflect the selected color
   * @private
   */
  _updatePenIconColor() {
    const palette = this.penType === "marker" ? getMarkerPalette() : getThemePalette();
    const color = palette[this.penColorIndex] || palette[0];
    if (this.penType === "marker") {
      this.drawBtn.innerHTML = getMarkerIconWithColor(color, 24);
    } else {
      this.drawBtn.innerHTML = getPenIconWithColor(color, 24);
    }
  }

  /**
   * Notify parent of pen settings change
   * @private
   */
  _notifyPenSettingsChange() {
    this.onPenSettingsChange({
      width: this.penWidth,
      colorIndex: this.penColorIndex,
      type: this.penType,
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
      // Ensure dialog starts hidden when switching to draw mode
      this._closePenDialog();
    }
  }

  /**
   * Handle insert button click
   * @private
   */
  _handleInsertClick(e) {
    e.stopPropagation();
    this._closeOptionsDialog(); // Close other dialogs
    this._closePenDialog();
    this._toggleInsertDialog();
  }

  /**
   * Handle options button click
   * @private
   */
  _handleOptionsClick(e) {
    e.stopPropagation();
    if (this.optionsDialog.classList.contains("note-canvas-toolbar__options-dialog--open")) {
      this._closeOptionsDialog();
    } else {
      this._closeInsertDialog(); // Close other dialogs
      this._openOptionsDialog();
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
    this._renderDialogContent(); // Ensure correct state rendered

    this.penSettingsDialog.classList.add("note-canvas-toolbar__pen-dialog--open");
    document.addEventListener("pointerdown", this._handleDocumentPointerDown);
  }

  /**
   * Close pen settings dialog
   * @private
   */
  _closePenDialog() {
    this.penSettingsDialog.classList.remove("note-canvas-toolbar__pen-dialog--open");
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);
  }

  /**
   * Toggle insert dialog visibility
   * @private
   */
  _toggleInsertDialog() {
    this.insertDialog.classList.toggle("note-canvas-toolbar__options-dialog--open");
    if (this.insertDialog.classList.contains("note-canvas-toolbar__options-dialog--open")) {
      document.addEventListener("pointerdown", this._handleDocumentPointerDown);
    }
  }

  /**
   * Close insert dialog
   * @private
   */
  _closeInsertDialog() {
    this.insertDialog.classList.remove("note-canvas-toolbar__options-dialog--open");
  }

  /**
   * Open options dialog
   * @private
   */
  _openOptionsDialog() {
    this.optionsDialog.classList.add("note-canvas-toolbar__options-dialog--open");
    document.addEventListener("pointerdown", this._handleDocumentPointerDown);
  }

  /**
   * Close options dialog
   * @private
   */
  _closeOptionsDialog() {
    this.optionsDialog.classList.remove("note-canvas-toolbar__options-dialog--open");
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);
  }

  /**
   * Handle document pointer down to close dialog
   * @private
   */
  _handleDocumentPointerDown(e) {
    // Check if click is outside dialog and draw button
    if (
      this.penSettingsDialog.classList.contains("note-canvas-toolbar__pen-dialog--open") &&
      !this.penSettingsDialog.contains(e.target) &&
      !this.drawBtn.contains(e.target)
    ) {
      // If in full mode (expanded), collapse to preset mode
      if (this.isExpanded) {
        this.isExpanded = false;
        this._renderDialogContent();
      }
    }
    // Check if click is outside options dialog and options button
    if (
      this.optionsDialog.classList.contains("note-canvas-toolbar__options-dialog--open") &&
      !this.optionsDialog.contains(e.target) &&
      !this.optionsBtn.contains(e.target)
    ) {
      this._closeOptionsDialog();
    }
    // Check if click is outside insert dialog and insert button
    if (
      this.insertDialog.classList.contains("note-canvas-toolbar__options-dialog--open") &&
      !this.insertDialog.contains(e.target) &&
      !this.insertBtn.contains(e.target)
    ) {
      this._closeInsertDialog();
    }
  }

  /**
   * Refresh color swatches (e.g., after theme change)
   * @private
   */
  _refreshColorSwatches() {
    const palette = this.penType === "marker" ? getMarkerPalette() : getThemePalette();
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
   * @param {Object} settings - { width, colorIndex, type }
   */
  setPenSettings(settings) {
    if (settings.width !== undefined) {
      this.penWidth = settings.width;
      const slider = this.penSettingsDialog?.querySelector(".note-canvas-toolbar__width-slider");
      const widthValue = this.penSettingsDialog?.querySelector(".note-canvas-toolbar__width-value");
      if (slider) slider.value = this.penWidth;
      if (widthValue) widthValue.textContent = this.penWidth;
      this._updatePresetActiveStates();
    }

    if (settings.colorIndex !== undefined) {
      this._selectColor(settings.colorIndex);
    }

    if (settings.type !== undefined) {
      this.penType = settings.type;
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
    setActive(this.lassoBtn, mode === "lasso");

    // Close pen dialog when switching away from draw mode
    if (mode !== "draw") {
      this._closePenDialog();
    }
  }

  destroy() {
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);

    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
    this.panBtn = null;
    this.drawBtn = null;
    this.drawBtnContainer = null;
    this.eraserBtn = null;
    this.lassoBtn = null;
    this.insertBtn = null;
    this.insertDialog = null;
    this.penSettingsDialog = null;
    this.optionsBtn = null;
    this.optionsBtnContainer = null;
    this.optionsDialog = null;
  }
}
