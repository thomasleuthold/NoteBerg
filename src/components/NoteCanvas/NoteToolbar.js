/**
 * NoteToolbar - Floating toolbar for NoteCanvas
 * Manages Pan vs Draw vs Eraser mode switching and pen settings
 */

import { t } from "../../i18n/index.js";
import { getTheme } from "../../modules/theme.js";
import { getIcon } from "../../utils/icons.js";
import { getMarkerPalette, getThemePalette } from "../../utils/noteRenderer.js";

/**
 * Generate pen icon SVG with colored tip
 * @param {string} tipColor - Color for the pen tip
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getPenIconWithColor(tipColor, _size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
    <path d="m15 5 4 4"/>
    <line x1="3" y1="24" x2="21" y2="24" stroke="${tipColor}" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

/**
 * Generate marker icon SVG with colored tip
 * @param {string} tipColor - Color for the marker tip
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getMarkerIconWithColor(tipColor, _size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m9 11-6 6v3h9l3-3"/>
    <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
    <line x1="5" y1="22" x2="22" y2="22" stroke="${tipColor}" stroke-width="4" stroke-linecap="round" opacity="0.7"/>
  </svg>`;
}

/**
 * Generate more options icon SVG
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getMoreIcon(_size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
function getLassoIcon(_size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><path d="M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>`;
}

/**
 * Generate undo icon SVG
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getUndoIcon(_size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`;
}

/**
 * Generate redo icon SVG
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getRedoIcon(_size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>`;
}

/**
 * Generate text mode icon SVG (T with cursor)
 * @param {number} size - Icon size
 * @returns {string} SVG markup
 */
function getTextIcon(_size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`;
}

/**
 * Generate part eraser icon SVG (eraser shape with a stroke passing through it, gap inside)
 * @param {number} size
 * @returns {string}
 */
function getPartEraserIcon(_size = 24) {
  // Eraser shape (same as stroke eraser) overlapping a diagonal stroke.
  // The stroke is visible on both sides of the eraser but absent underneath it,
  // conveying that only the part under the eraser is removed.
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.9-9.9c1-1 2.5-1 3.4 0l4.4 4.4c1 1 1 2.5 0 3.4L10.5 21z"/>
    <path d="m22 21-8 0"/>
    <path d="m1 21 4 0"/>
    <path d="m18 11-4-4"/>
  </svg>`;
}

/**
 * Generate eraser size icon SVG
 * @param {number} size
 * @returns {string}
 */
function getEraserSizeIcon(_size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="7"/>
    <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>
  </svg>`;
}

/**
 * Generate highlighter-only icon SVG (marker with filter lines)
 * @param {number} size
 * @returns {string}
 */
function getHighlighterOnlyIcon(_size = 24) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="m9 11-6 6v3h9l3-3"/>
    <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>
  </svg>`;
}

export class NoteToolbar {
  /**
   * @param {HTMLElement} container - Container to append toolbar to
   * @param {Function} onModeChange - Callback (mode) => void. mode: 'pan' | 'draw' | 'eraser'
   * @param {Object} options - Optional configuration
   * @param {Function} options.onPenSettingsChange - Callback ({ width, colorIndex }) => void
   * @param {Function} options.onOptionsChange - Callback ({ type, value }) => void
   * @param {Function} options.onAction - Callback (action) => void
   * @param {Function} options.onUndo - Callback for undo action
   * @param {Function} options.onRedo - Callback for redo action
   * @param {Function} options.onEraserSettingsChange - Callback ({ eraserMode, eraserSize, eraserHighlighterOnly }) => void
   */
  constructor(container, onModeChange, options = {}) {
    this.container = container;
    this.onModeChange = onModeChange;
    this.onPenSettingsChange = options.onPenSettingsChange || (() => {});
    this.onOptionsChange = options.onOptionsChange || (() => {});
    this.getBackground = options.getBackground || (() => "none");
    this.onAction = options.onAction || (() => {});
    this.onUndo = options.onUndo || (() => {});
    this.onRedo = options.onRedo || (() => {});
    this.onEraserSettingsChange = options.onEraserSettingsChange || (() => {});
    this.element = null;
    this.panBtn = null;
    this.drawBtn = null;
    this.eraserBtn = null;
    this.eraserBtnContainer = null;
    this.eraserDialog = null;
    this.eraserSizeDialog = null;
    this.lassoBtn = null;
    this.undoBtn = null;
    this.redoBtn = null;
    this.insertBtn = null;
    this.insertDialog = null;
    this.penSettingsDialog = null;
    this.optionsBtn = null;
    this.optionsDialog = null;
    this.optionsBtnContainer = null;
    this.currentMode = "pan";

    // Eraser settings state
    this.eraserMode = "stroke"; // 'stroke' | 'part'
    this.eraserSize = 20;
    this.eraserHighlighterOnly = false;

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

    this.panBtn = createBtn("pan", handIcon, t("toolbar.modes.pan"));
    this.panBtn.onclick = () => this.onModeChange("pan");

    this.textBtn = createBtn("text", getTextIcon(24), t("toolbar.modes.text"));
    this.textBtn.onclick = () => this.onModeChange("text");

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

    this.drawBtn = createBtn("draw", penIcon, t("toolbar.modes.draw"));
    this.drawBtn.onclick = (e) => this._handleDrawClick(e);

    this.drawBtnContainer.appendChild(this.drawBtn);

    // Create pen settings dialog
    this._createPenSettingsDialog();

    // Eraser button container (for positioning dialog)
    this.eraserBtnContainer = document.createElement("div");
    this.eraserBtnContainer.className = "note-canvas-toolbar__button-container";

    this.eraserBtn = createBtn("eraser", eraserIcon, t("toolbar.modes.eraser"));
    this.eraserBtn.onclick = (e) => this._handleEraserClick(e);

    this.eraserBtnContainer.appendChild(this.eraserBtn);
    this._createEraserDialog();

    this.lassoBtn = createBtn("lasso", lassoIcon, t("toolbar.modes.lasso"));
    this.lassoBtn.onclick = () => this.onModeChange("lasso");

    // Undo/Redo buttons
    this.undoBtn = createBtn("undo", getUndoIcon(24), t("toolbar.actions.undo"));
    this.undoBtn.onclick = () => this.onUndo();
    this.undoBtn.disabled = true;
    this.undoBtn.classList.add("note-canvas-toolbar__button--disabled");

    this.redoBtn = createBtn("redo", getRedoIcon(24), t("toolbar.actions.redo"));
    this.redoBtn.onclick = () => this.onRedo();
    this.redoBtn.disabled = true;
    this.redoBtn.classList.add("note-canvas-toolbar__button--disabled");

    // Options button container (aligned right)
    this.optionsBtnContainer = document.createElement("div");
    this.optionsBtnContainer.className = "note-canvas-toolbar__options-container";

    this.insertBtn = createBtn(
      "insert",
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
      t("toolbar.actions.insert"),
    );
    this.insertBtn.onclick = (e) => this._handleInsertClick(e);
    this.optionsBtnContainer.appendChild(this.insertBtn);
    this._createInsertDialog();

    this.optionsBtn = createBtn("options", getMoreIcon(24), t("toolbar.actions.options"));
    this.optionsBtn.onclick = (e) => this._handleOptionsClick(e);
    this.optionsBtnContainer.appendChild(this.optionsBtn);

    this._createOptionsDialog();

    this.element.appendChild(this.panBtn);
    this.element.appendChild(this.textBtn);
    this.element.appendChild(this.drawBtnContainer);
    this.element.appendChild(this.eraserBtnContainer);
    this.element.appendChild(this.lassoBtn);
    this.element.appendChild(this.undoBtn);
    this.element.appendChild(this.redoBtn);
    this.element.appendChild(this.optionsBtnContainer);
    this.container.appendChild(this.element);
  }

  /**
   * Handle eraser button click — switch to eraser mode (dialog opens automatically)
   * @private
   */
  _handleEraserClick(e) {
    e.stopPropagation();
    if (this.currentMode !== "eraser") {
      this.onModeChange("eraser");
    }
  }

  /**
   * Create the eraser settings dialog (narrow column, like pen presets)
   * @private
   */
  _createEraserDialog() {
    this.eraserDialog = document.createElement("div");
    this.eraserDialog.className = "note-canvas-toolbar__eraser-dialog";
    this.eraserDialog.addEventListener("click", (e) => e.stopPropagation());
    this._renderEraserDialogContent();
    this.element.appendChild(this.eraserDialog);
    this._createEraserSizeDialog();
  }

  /**
   * Render the eraser dialog column content
   * @private
   */
  _renderEraserDialogContent() {
    this.eraserDialog.innerHTML = "";

    const col = document.createElement("div");
    col.className = "note-canvas-toolbar__eraser-dialog-col";

    const createEraserBtn = (icon, title, isActive, onClick) => {
      const btn = document.createElement("button");
      btn.className = "note-canvas-toolbar__eraser-mode-btn";
      btn.title = title;
      btn.innerHTML = icon;
      if (isActive) btn.classList.add("note-canvas-toolbar__eraser-mode-btn--active");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return btn;
    };

    const sep = () => {
      const el = document.createElement("div");
      el.className = "note-canvas-toolbar__eraser-dialog-separator";
      return el;
    };

    // Stroke eraser button
    col.appendChild(
      createEraserBtn(
        getIcon("eraser", 20),
        t("toolbar.eraser.strokeEraser"),
        this.eraserMode === "stroke",
        () => {
          this.eraserMode = "stroke";
          this._renderEraserDialogContent();
          this.onEraserSettingsChange({ eraserMode: "stroke" });
        },
      ),
    );

    // Part eraser button
    col.appendChild(
      createEraserBtn(
        getPartEraserIcon(20),
        t("toolbar.eraser.partEraser"),
        this.eraserMode === "part",
        () => {
          this.eraserMode = "part";
          this._renderEraserDialogContent();
          this.onEraserSettingsChange({ eraserMode: "part" });
        },
      ),
    );

    col.appendChild(sep());

    // Highlighter-only toggle
    const hlBtn = createEraserBtn(
      getHighlighterOnlyIcon(20),
      t("toolbar.eraser.highlighterOnly"),
      this.eraserHighlighterOnly,
      () => {
        this.eraserHighlighterOnly = !this.eraserHighlighterOnly;
        hlBtn.classList.toggle(
          "note-canvas-toolbar__eraser-mode-btn--active",
          this.eraserHighlighterOnly,
        );
        this.onEraserSettingsChange({ eraserHighlighterOnly: this.eraserHighlighterOnly });
      },
    );
    col.appendChild(hlBtn);

    col.appendChild(sep());

    // Size button (opens size flyout)
    col.appendChild(
      createEraserBtn(getEraserSizeIcon(20), t("toolbar.eraser.size"), false, () =>
        this._toggleEraserSizeDialog(),
      ),
    );

    this.eraserDialog.appendChild(col);
  }

  /**
   * Create the eraser size flyout dialog
   * @private
   */
  _createEraserSizeDialog() {
    this.eraserSizeDialog = document.createElement("div");
    this.eraserSizeDialog.className = "note-canvas-toolbar__eraser-size-dialog";
    this.eraserSizeDialog.addEventListener("click", (e) => e.stopPropagation());

    const label = document.createElement("label");
    label.className = "note-canvas-toolbar__eraser-size-label";
    label.textContent = t("toolbar.eraser.size");

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "note-canvas-toolbar__eraser-size-slider";
    slider.min = 10;
    slider.max = 100;
    slider.step = 5;
    slider.value = this.eraserSize;
    slider.addEventListener("input", (e) => {
      e.stopPropagation();
      this.eraserSize = parseInt(e.target.value, 10);
      this.onEraserSettingsChange({ eraserSize: this.eraserSize });
    });

    this.eraserSizeDialog.appendChild(label);
    this.eraserSizeDialog.appendChild(slider);
    this.element.appendChild(this.eraserSizeDialog);
  }

  _openEraserDialog() {
    if (getTheme() === "dark") {
      this.eraserDialog.classList.add("theme-dark");
    } else {
      this.eraserDialog.classList.remove("theme-dark");
    }
    this.eraserDialog.classList.add("note-canvas-toolbar__eraser-dialog--open");
  }

  _closeEraserDialog() {
    this.eraserDialog?.classList.remove("note-canvas-toolbar__eraser-dialog--open");
    this._closeEraserSizeDialog();
  }

  _openEraserSizeDialog() {
    this.eraserSizeDialog?.classList.add("note-canvas-toolbar__eraser-size-dialog--open");
  }

  _closeEraserSizeDialog() {
    this.eraserSizeDialog?.classList.remove("note-canvas-toolbar__eraser-size-dialog--open");
  }

  _toggleEraserSizeDialog() {
    if (
      this.eraserSizeDialog?.classList.contains("note-canvas-toolbar__eraser-size-dialog--open")
    ) {
      this._closeEraserSizeDialog();
    } else {
      this._openEraserSizeDialog();
    }
  }

  /**
   * Update the main eraser toolbar button icon to reflect current erase mode
   * @param {'stroke'|'part'} eraserMode
   */
  updateEraserIcon(eraserMode) {
    if (!this.eraserBtn) return;
    this.eraserBtn.innerHTML =
      eraserMode === "part" ? getPartEraserIcon(24) : getIcon("eraser", 24);
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

    // Toggle expanded class for shadow
    this.penSettingsDialog.classList.toggle(
      "note-canvas-toolbar__pen-dialog--expanded",
      this.isExpanded,
    );

    // 1. Presets Column
    const presetsCol = document.createElement("div");
    presetsCol.className = "note-canvas-toolbar__presets";

    // Expand/Collapse Button
    const expandBtn = document.createElement("button");
    expandBtn.className = "note-canvas-toolbar__expand-btn";
    expandBtn.innerHTML = this.isExpanded
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>` // Left arrow (collapse)
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>`; // Right arrow (expand)
    expandBtn.title = this.isExpanded
      ? t("toolbar.penDialog.collapse")
      : t("toolbar.penDialog.expand");
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
      saveBtn.title = t("toolbar.penDialog.savePreset");
      saveBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;

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
          title="${t("toolbar.penDialog.colorTitle", { num: index + 1 })}"
        ></button>
      `,
      )
      .join("");

    return `
      <div class="note-canvas-toolbar__pen-dialog-section">
        <label class="note-canvas-toolbar__pen-dialog-label">
          ${t("toolbar.penDialog.lineWidth")}<span class="note-canvas-toolbar__width-value">${this.penWidth}</span>
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
        <label class="note-canvas-toolbar__pen-dialog-label">${t("toolbar.penDialog.color")}</label>
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
          ${getIcon("image", 16)} ${t("toolbar.insert.image")}
        </button>
        <button class="note-canvas-toolbar__option-btn" data-action="insert-camera">
          ${getIcon("camera", 16)} ${t("toolbar.insert.camera")}
        </button>
        <button class="note-canvas-toolbar__option-btn" data-action="insert-pdf">
          ${getIcon("pdf", 16)} ${t("toolbar.insert.pdf")}
        </button>
      </div>
      <div class="note-canvas-toolbar__separator"></div>
      <div class="note-canvas-toolbar__options-section">
        <button class="note-canvas-toolbar__option-btn" data-action="insert-space">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="note-canvas-toolbar__option-icon">
            <path d="M12 8v8m-4-4 4 4 4-4"/>
            <path d="M4 4h16"/>
            <path d="M4 20h16"/>
          </svg>
          ${t("toolbar.insert.space")}
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
        <label class="note-canvas-toolbar__options-label">${t("toolbar.background.label")}</label>
        <div class="note-canvas-toolbar__background-list">
            <button class="note-canvas-toolbar__option-btn background-option" data-value="none">${t("toolbar.background.none")}</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="ruled-narrow">${t("toolbar.background.ruledNarrow")}</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="ruled-medium">${t("toolbar.background.ruledMedium")}</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="ruled-wide">${t("toolbar.background.ruledWide")}</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="grid-small">${t("toolbar.background.gridSmall")}</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="grid-medium">${t("toolbar.background.gridMedium")}</button>
            <button class="note-canvas-toolbar__option-btn background-option" data-value="grid-large">${t("toolbar.background.gridLarge")}</button>
        </div>
      </div>
      <div class="note-canvas-toolbar__separator"></div>
      <div class="note-canvas-toolbar__options-section">
        <button id="nc-export-pdf-btn" class="note-canvas-toolbar__option-btn">
            ${getIcon("download", 16)} ${t("toolbar.exportPdf")}
        </button>
      </div>
      <div class="note-canvas-toolbar__separator"></div>
      <div class="note-canvas-toolbar__options-section">
        <button id="nc-delete-note-btn" class="note-canvas-toolbar__delete-btn">
            ${getIcon("trash", 16)} ${t("toolbar.deleteNote")}
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

    const exportPdfBtn = this.optionsDialog.querySelector("#nc-export-pdf-btn");
    if (exportPdfBtn) {
      exportPdfBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onOptionsChange({ type: "export-pdf" });
        this._closeOptionsDialog();
      });
    }

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
      // Switch to draw mode and show presets (collapsed mode)
      this.onModeChange("draw");
      this.isExpanded = false;
      this._openPenDialog();
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

    if (getTheme() === "dark") {
      this.penSettingsDialog.classList.add("theme-dark");
    } else {
      this.penSettingsDialog.classList.remove("theme-dark");
    }

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
    this._syncBackgroundActiveState();
    this.optionsDialog.classList.add("note-canvas-toolbar__options-dialog--open");
    document.addEventListener("pointerdown", this._handleDocumentPointerDown);
  }

  /**
   * Highlight the background option matching the note's current background.
   * @private
   */
  _syncBackgroundActiveState() {
    const current = this.getBackground() || "none";
    const bgOptions = this.optionsDialog.querySelectorAll(".background-option");
    bgOptions.forEach((btn) => {
      btn.classList.toggle(
        "note-canvas-toolbar__option-btn--active",
        btn.dataset.value === current,
      );
    });
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
    setActive(this.textBtn, mode === "text");
    setActive(this.drawBtn, mode === "draw");
    setActive(this.eraserBtn, mode === "eraser");
    setActive(this.lassoBtn, mode === "lasso");

    // Open/close pen dialog based on draw mode
    if (mode !== "draw") {
      this._closePenDialog();
    }
    // Open/close eraser dialog based on eraser mode
    if (mode === "eraser") {
      this._openEraserDialog();
    } else {
      this._closeEraserDialog();
    }
  }

  /**
   * Update undo/redo button states
   * @param {{ canUndo: boolean, canRedo: boolean }} state
   */
  updateHistoryState(state) {
    if (this.undoBtn) {
      this.undoBtn.disabled = !state.canUndo;
      if (state.canUndo) {
        this.undoBtn.classList.remove("note-canvas-toolbar__button--disabled");
      } else {
        this.undoBtn.classList.add("note-canvas-toolbar__button--disabled");
      }
    }

    if (this.redoBtn) {
      this.redoBtn.disabled = !state.canRedo;
      if (state.canRedo) {
        this.redoBtn.classList.remove("note-canvas-toolbar__button--disabled");
      } else {
        this.redoBtn.classList.add("note-canvas-toolbar__button--disabled");
      }
    }
  }

  destroy() {
    document.removeEventListener("pointerdown", this._handleDocumentPointerDown);

    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
    this.panBtn = null;
    this.textBtn = null;
    this.drawBtn = null;
    this.drawBtnContainer = null;
    this.eraserBtn = null;
    this.eraserBtnContainer = null;
    this.eraserDialog = null;
    this.eraserSizeDialog = null;
    this.lassoBtn = null;
    this.undoBtn = null;
    this.redoBtn = null;
    this.insertBtn = null;
    this.insertDialog = null;
    this.penSettingsDialog = null;
    this.optionsBtn = null;
    this.optionsBtnContainer = null;
    this.optionsDialog = null;
  }
}
