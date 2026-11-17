/**
 * TextLayer - the typed text of a note: text boxes over the page
 * (documentation/text_boxes_design.md)
 *
 * Every text is in a box (TextBox.js): the implicit main box (text written
 * before boxes existed, unwrapped at the top of note.content) and any number of
 * positioned boxes. The layer sits in the VirtualScroller viewport, positioned
 * with top/left + scale(), below the ink, and owns the shared vertical toolbar.
 *
 * One Trumbowyg instance at most, on the active box (DESIGN §4.2): activating
 * a box mounts the editor on it, leaving it destroys the editor and the box is
 * static HTML again. Mounting is not an edit: a box left without a change keeps
 * its stored string. Without an active box the toolbar shows a disabled copy
 * of the button pane.
 *
 * Integrates with HistoryManager for unified undo/redo across text and
 * strokes: every text change, create, move, resize and delete is one
 * TextChangeCommand on the whole HTML.
 */

import trumbowygIconsSvg from "../../assets/trumbowyg-icons.svg?raw";
// jQuery must be on `window` before Trumbowyg is imported (separate module avoids hoisting issues)
import jQuery from "./jquerySetup.js";

// Import Trumbowyg core and CSS (relies on window.jQuery set by jquerySetup)
import "trumbowyg";
import "trumbowyg/dist/ui/trumbowyg.css";

// Import plugins
import "./textColorPlugin.js";
import "trumbowyg/dist/plugins/fontsize/trumbowyg.fontsize.js";
// Note: trumbowyg.indent.js uses execCommand('indent') which is removed in
// modern Chromium. We register a custom indent/outdent plugin below instead.
import "trumbowyg/dist/plugins/lineheight/trumbowyg.lineheight.js";
import "trumbowyg/dist/plugins/table/trumbowyg.table.js";
import "trumbowyg/dist/plugins/table/ui/trumbowyg.table.css";

import { t } from "../../i18n/index.js";
import { HELP_IDS } from "../../modules/helpGuidance.js";
import {
  BOX_PADDING,
  boxHtml,
  clampBox,
  fitNewBox,
  MAIN_BOX_GEOMETRY,
  MIN_BOX_WIDTH,
  mayHaveBoxes,
  newBoxId,
  PAGE_WIDTH,
  parseContent,
  stripBoxWrappers,
} from "../../modules/textBoxes.js";
import { snapGrid } from "../../utils/backgroundGrid.js";
import { getIcon } from "../../utils/icons.js";
import { sanitizeNoteHtml, sanitizePastedHtml } from "../../utils/sanitizeHtml.js";
import { searchRegex } from "../../utils/searchPattern.js";
import { startHelpTour } from "../HelpOverlay.js";
import { getHelpContent, getHelpLabels } from "../helpContent.js";
import { ContextFloatingMenu } from "./ContextFloatingMenu.js";
import { mapCaretOffset } from "./caretMapping.js";
import { TextChangeCommand } from "./commands/TextChangeCommand.js";
import { MERGE_HINT_SELECTOR, renderMergeHints, stripMergeHintLabels } from "./mergeHints.js";
import { SelectionFloatingBar } from "./SelectionFloatingBar.js";
import { isEmptyBoxHtml, TextBox } from "./TextBox.js";
import "../../styles/textBoxes.css";
import "./TextLayer.css";
import { normalizeBareLines, TextTaskManager } from "./TextTaskManager.js";

// Custom indent/outdent plugin — uses margin-left instead of the deprecated
// execCommand('indent') which is removed in modern Chromium.
const INDENT_STEP = 8; // px per indent level (in content-space, zoom-independent)

function _getBlockElements(trumbowyg) {
  // Bare inline lines at the editor root (first typed line, Chromium's
  // list→text conversion) have no block element to indent — wrap them first.
  normalizeBareLines(trumbowyg.$ed[0]);
  trumbowyg.saveRange();
  const range = trumbowyg.range;
  if (!range) return [];
  const editor = trumbowyg.$ed[0];
  const blocks = new Set();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    const style = window.getComputedStyle(node);
    if (style.display === "block" || style.display === "list-item") {
      if (range.intersectsNode(node)) blocks.add(node);
    }
    node = walker.nextNode();
  }
  // Fall back to the paragraph/div containing the collapsed cursor
  if (blocks.size === 0) {
    let el = range.startContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    while (el && el !== editor) {
      const s = window.getComputedStyle(el);
      if (s.display === "block" || s.display === "list-item") {
        blocks.add(el);
        break;
      }
      el = el.parentElement;
    }
  }
  return [...blocks];
}

jQuery.extend(true, jQuery.trumbowyg, {
  plugins: {
    indentCustom: {
      init: (trumbowyg) => {
        trumbowyg.addBtnDef("indent", {
          fn: () => {
            for (const el of _getBlockElements(trumbowyg)) {
              const cur = Number.parseInt(el.style.marginLeft || "0", 10);
              el.style.marginLeft = `${cur + INDENT_STEP}px`;
            }
            trumbowyg.$ta.trigger("tbwchange");
          },
          title: "Indent",
          ico: "indent",
        });
        trumbowyg.addBtnDef("outdent", {
          fn: () => {
            for (const el of _getBlockElements(trumbowyg)) {
              const cur = Number.parseInt(el.style.marginLeft || "0", 10);
              el.style.marginLeft = `${Math.max(0, cur - INDENT_STEP)}px`;
            }
            trumbowyg.$ta.trigger("tbwchange");
          },
          title: "Outdent",
          ico: "outdent",
        });
      },
    },
  },
});

// Define Mark as Task plugin for Trumbowyg
jQuery.extend(true, jQuery.trumbowyg, {
  plugins: {
    markAsTask: {
      init: (trumbowyg) => {
        trumbowyg.addBtnDef("markAsTask", {
          fn: () => {
            trumbowyg.saveRange();

            // Access layer instance attached to trumbowyg object
            if (trumbowyg.textEditorLayer?.textTaskManager) {
              trumbowyg.textEditorLayer.textTaskManager.toggleTaskOnSelection(trumbowyg);
            } else {
              // Fallback
              trumbowyg.$ta.trigger("tbwmarkastask");
            }
          },
          title: "Mark as Task",
          hasIcon: false,
          text: "Task",
        });

        // Map our pseudo-tag to the button name so active state works
        trumbowyg.tagToButton.markastask = "markAsTask";
      },
      // tagHandler: called by getTagsRecursive for each ancestor element.
      // Return ["markastask"] when cursor is inside a task span.
      tagHandler: (element) => {
        if (element.classList?.contains("task-text") && element.dataset?.taskId) {
          return ["markastask"];
        }
        return [];
      },
    },
  },
});

const EDITOR_OPTIONS = {
  btns: [
    ["formatting"],
    ["fontsize"],
    ["bold", "italic", "underline", "strikethrough"],
    ["foreColor", "backColor"],
    ["lineheight"],
    ["indent", "outdent"],
    ["unorderedList", "orderedList", "markAsTask"],
    ["table"],
    ["removeformat"],
  ],
  autogrow: false,
  autogrowOnEnter: false,
  resetCss: false,
  semantic: false,
  tagsToRemove: ["script", "link"],
};

const ARROW_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
/** Icons of the badge that follows a finger: arrows in four directions (move) or two (resize). */
const DRAG_BADGE_ICONS = {
  move: `<svg ${ARROW_ATTRS}><path d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"/></svg>`,
  resize: `<svg ${ARROW_ATTRS}><path d="M2 12h20M5 9l-3 3 3 3M19 9l3 3-3 3"/></svg>`,
};

/** Below a box's last line, a tap this close continues it instead of starting a box (DESIGN §5). */
const CONTINUE_ZONE = 48;
/** One text line (16 px × 1.5). */
const LINE_HEIGHT = 24;
/** The implicit main box's frame and hit area reach this far right of its widest line. */
const MAIN_HUG_MARGIN = 48;
/** A press longer than this before its click is no tap (a click without a press is none either). */
const TAP_MAX_MS = 1500;
/** A pointer that moves farther than this (screen px) between press and release did not tap. */
const TAP_SLOP = 6;
/** Content-height changes smaller than this are not reported (avoids churn while typing). */
const HEIGHT_EPSILON = 10;

/** Remove UI-only markup from editor HTML: checkboxes, search marks, hint labels. */
function cleanEditorHtml(rawHtml) {
  // A temporary element, so the live editor DOM is not touched (no cursor jumps)
  const tempDiv = document.createElement("div");
  tempDiv.innerHTML = rawHtml;

  // 1. Remove injected checkboxes (UI only, not persisted)
  for (const cb of tempDiv.querySelectorAll(".task-text-checkbox")) cb.remove();

  // 2. Unwrap search highlights
  for (const mark of tempDiv.querySelectorAll("mark.search-highlight")) {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }

  // 3. Conflict hints keep their attributes but not their generated label
  stripMergeHintLabels(tempDiv);

  // Normalize to merge text nodes
  tempDiv.normalize();
  return tempDiv.innerHTML;
}

/**
 * A collapsed range at the end of the text, inside its last line (after the
 * last character, or in an empty last paragraph before its <br>), so typing
 * goes into that line rather than after it.
 */
function endOfText(root) {
  let node = root;
  for (;;) {
    let last = node.lastChild;
    while (
      last &&
      last.nodeType === Node.TEXT_NODE &&
      last.data.trim() === "" &&
      last.previousSibling
    ) {
      last = last.previousSibling;
    }
    if (!last || last.nodeType !== Node.ELEMENT_NODE || last.tagName === "BR") break;
    if (last.getAttribute("contenteditable") === "false") break;
    node = last;
  }
  const range = document.createRange();
  const last = node.lastChild;
  if (last?.nodeType === Node.TEXT_NODE) range.setStart(last, last.length);
  else if (last?.tagName === "BR") range.setStartBefore(last);
  else range.selectNodeContents(node);
  range.collapse(!last || last.tagName === "BR" || last.nodeType === Node.TEXT_NODE);
  return range;
}

/** The caret position at a client point, as a collapsed range (null where there is none). */
function caretRangeAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos?.offsetNode) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return document.caretRangeFromPoint?.(x, y) ?? null;
}

export class TextLayer {
  /**
   * @param {HTMLElement} viewportElement - The VirtualScroller's viewport element
   * @param {HTMLElement} scrollerContainer - The scroller container (for placing the vertical toolbar)
   * @param {Object} options
   * @param {number} options.maxContentWidth - Maximum content width (default 1200)
   * @param {Function} options.onContentChange - Callback (htmlContent) => void
   * @param {Function} options.onHeightChange - Callback (heightPx) => void
   * @param {import('./HistoryManager.js').HistoryManager} options.historyManager - For unified undo/redo
   * @param {Function} [options.onTaskCreate] - (taskId) => void
   * @param {Function} [options.onTaskToggle] - (taskId, checked) => void
   * @param {(files: File[], at: {x: number, y: number}|null) => void} [options.onImageInsert] -
   *   images pasted or dropped in text mode, to be placed on the page at `at`
   *   (content px; null: the viewport centre)
   * @param {() => string} [options.getBackground] - the note's background type (snapping)
   * @param {() => boolean} [options.isTapCancelled] - whether the touch that just
   *   ended was not a tap (it panned, pinched, stopped a scroll, or hit an image)
   * @param {() => boolean} [options.isCanvasBusy] - whether a press now belongs to
   *   the canvas (an image is selected: the press moves or deselects it)
   */
  constructor(viewportElement, scrollerContainer, options = {}) {
    this.viewportElement = viewportElement;
    this.scrollerContainer = scrollerContainer;
    this.maxContentWidth = options.maxContentWidth || PAGE_WIDTH;
    this.onContentChange = options.onContentChange || (() => {});
    this.onHeightChange = options.onHeightChange || (() => {});
    this.historyManager = options.historyManager || null;
    this.onTaskCreate = options.onTaskCreate || null;
    this.onTaskToggle = options.onTaskToggle || null;
    this.onTaskCycleStatus = options.onTaskCycleStatus || null;
    this.onTaskProperties = options.onTaskProperties || null;
    this.onImageInsert = options.onImageInsert || null;
    this.getBackground = options.getBackground || (() => "none");
    this.isTapCancelled = options.isTapCancelled || (() => false);
    this.isCanvasBusy = options.isCanvasBusy || (() => false);

    // DOM elements
    this.container = null;
    this.toolbarWrapper = null;
    this.textTaskManager = null;
    /** The active box's editor (jQuery) and its element; null without an active box. */
    this.$editor = null;
    this._editorElement = null;

    // Boxes: the implicit main box (or null), then the others in DOM order
    this._main = null;
    this._boxes = [];
    this._active = null;
    this._mountedHtml = "";
    this._maybeEdited = false;

    // State
    this.mode = "pan";
    this.readOnly = false;
    this.zoom = 1.0;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.centeringOffset = 0;
    this.isDirty = false;
    this._saveTimer = null;
    this._historyTimer = null;
    this._resizeObserver = null;
    this._contentHeight = 0;
    this._totalContentHeight = 0;
    this._tasks = [];
    this._searchQuery = "";
    this._pointerDown = null;
    this._drag = null;
    this._hovered = null;
    this._mainHug = null;
    this._framesPending = false;

    // Undo/redo state
    this._lastHtml = "";
    this._suppressHistory = false;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onPaste = this._onPaste.bind(this);
    this._onDragOver = this._onDragOver.bind(this);
    this._onDrop = this._onDrop.bind(this);
    this._onEditorKeyDown = this._onEditorKeyDown.bind(this);
    this._onEditorChange = this._onEditorChange.bind(this);
    this._onMarkAsTask = this._onMarkAsTask.bind(this);
    this._onChromeDown = this._onChromeDown.bind(this);
    this._onChromeMove = this._onChromeMove.bind(this);
    this._onChromeUp = this._onChromeUp.bind(this);
    this._onToolbarAction = this._onToolbarAction.bind(this);

    this._createDOM();
  }

  /**
   * Create the DOM elements for the text layer
   * @private
   */
  _createDOM() {
    // Container div positioned absolutely in the viewport.
    // Uses top/left for scroll positioning instead of CSS transform translate,
    // so the browser's auto-scroll-to-caret calculation uses the correct
    // layout position. Only transform: scale() is used for zoom.
    this.container = document.createElement("div");
    // text-boxes: the box layout shared with the thumbnail and PDF export
    this.container.className = "note-canvas__text-editor-layer text-boxes";
    this.viewportElement.appendChild(this.container);

    // Frame of the implicit main box: hugs its text (DESIGN §4.3)
    this._mainFrame = document.createElement("div");
    this._mainFrame.className = "text-box__frame";
    this._mainFrame.hidden = true;
    this.container.appendChild(this._mainFrame);

    // Move handle, resize handle and delete button of the active (or hovered) box
    this._chrome = this._createChrome();
    this.container.appendChild(this._chrome);

    // Vertical toolbar wrapper (fixed position on left side of scroller container)
    this.toolbarWrapper = document.createElement("div");
    this.toolbarWrapper.className = "note-canvas__trumbowyg-toolbar";
    this.toolbarWrapper.style.display = "none"; // Hidden until text mode
    this.scrollerContainer.appendChild(this.toolbarWrapper);

    // Prevent toolbar/dropdown clicks from stealing focus from the editor.
    // Without this, saveRange() gets a null range when clicking dropdown items.
    this.toolbarWrapper.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    this.toolbarWrapper.addEventListener("mousedown", this._onToolbarAction, true);
    this.toolbarWrapper.addEventListener("click", this._onToolbarAction, true);
    // The table plugin's dropdown is shown here too (_patchDropdownPositioning)
    this._setupTableGridPicking(this.toolbarWrapper);
    this._setupTableDropdownButtons(this.toolbarWrapper);

    this.container.addEventListener("pointerdown", this._onPointerDown);
    this.container.addEventListener("pointermove", this._onPointerMove);
    this.container.addEventListener("pointerleave", this._onPointerLeave);
    this.container.addEventListener("click", this._onClick);
    this.container.addEventListener("paste", this._onPaste);
    this.container.addEventListener("dragover", this._onDragOver);
    this.container.addEventListener("drop", this._onDrop);
  }

  /** @private */
  _createChrome() {
    const chrome = document.createElement("div");
    chrome.className = "text-box__chrome";
    chrome.hidden = true;

    const handle = document.createElement("div");
    handle.className = "text-box__handle";
    handle.dataset.action = "move";
    handle.title = t("canvas.textBox.move");
    handle.innerHTML = getIcon("move", 14);

    // Options, not a delete button: a slip while grabbing the bar must not
    // delete the box. The menu holds Delete (later also Copy, box types).
    const options = document.createElement("button");
    options.type = "button";
    options.className = "text-box__options";
    options.dataset.action = "options";
    options.title = t("canvas.textBox.options");
    options.setAttribute("aria-label", t("canvas.textBox.options"));
    options.setAttribute("aria-haspopup", "menu");
    options.innerHTML = getIcon("moreVertical", 16);
    handle.appendChild(options);

    const resize = document.createElement("div");
    resize.className = "text-box__resize";
    resize.dataset.action = "resize";
    resize.title = t("canvas.textBox.resize");

    chrome.append(handle, resize);
    chrome.addEventListener("pointerdown", this._onChromeDown);
    chrome.addEventListener("pointermove", this._onChromeMove);
    chrome.addEventListener("pointerup", this._onChromeUp);
    chrome.addEventListener("pointercancel", this._onChromeUp);
    // Acts on click, so a press that drags off it does nothing
    options.addEventListener("click", (e) => {
      e.stopPropagation();
      const box = this._chromeBox;
      if (box) this._openBoxOptions(box, options);
    });
    return chrome;
  }

  /**
   * The options menu of a box, under its ⋮ button.
   * @private
   */
  _openBoxOptions(box, button) {
    this._closeBoxOptions();
    const rect = button.getBoundingClientRect();
    this._optionsMenu = new ContextFloatingMenu(
      this.viewportElement,
      [
        {
          label: t("common.delete"),
          icon: getIcon("trash", 16),
          action: () => {
            this._optionsMenu = null;
            this._deleteBox(box);
          },
        },
      ],
      { x: rect.left, y: rect.bottom },
    );
  }

  /** @private */
  _closeBoxOptions() {
    this._optionsMenu?.destroy();
    this._optionsMenu = null;
  }

  /**
   * Initialize the layer and load content
   * @param {string} htmlContent - Initial HTML content
   */
  init(htmlContent) {
    // Inject SVG sprite inline so Trumbowyg skips its fetch() — avoids SSO proxy
    // interception (Yunohost) and works regardless of BASE_URL or <base> tag.
    // Trumbowyg skips the fetch when #trumbowyg-icons already exists in the DOM.
    if (!document.getElementById("trumbowyg-icons")) {
      const div = document.createElement("div");
      div.id = "trumbowyg-icons";
      div.style.cssText = "width:0;height:0;overflow:hidden;visibility:hidden";
      div.innerHTML = trumbowygIconsSvg;
      document.body.insertBefore(div, document.body.firstChild);
    }
    // Set svgPath to "" so Trumbowyg uses <use href="#icon"> against the inline sprite.
    jQuery.trumbowyg.svgPath = "";

    // Initialize TextTaskManager: renders and cleans up over every box, toggles
    // in the active one
    this.textTaskManager = new TextTaskManager(null, {
      onTaskCreate: this.onTaskCreate,
      onTaskToggle: this.onTaskToggle,
      onTaskCycleStatus: this.onTaskCycleStatus,
      onTaskProperties: this.onTaskProperties,
      triggerChange: () => this.$editor?.trigger("tbwchange"),
    });
    this.textTaskManager.rootElement = this.container;

    // Track the height of every box: the content height is the lowest box
    // bottom, and NoteCanvas expands the shared contentHeight (phantom div +
    // canvas) to it
    this._resizeObserver = new ResizeObserver((entries) => this._onBoxResize(entries));

    // The toolbar without an active box: the button pane, disabled
    this._disabledPane = this._buildDisabledPane();
    this.toolbarWrapper.appendChild(this._disabledPane);

    // Set initial content — note HTML is untrusted synced data, sanitize before
    // it enters the live DOM. _lastHtml must hold the layer's own form so
    // dirty-detection compares like with like.
    this._applyContent(sanitizeNoteHtml(htmlContent || ""));
    this._lastHtml = this.getContent();

    // Initial position update
    this._updatePosition();
  }

  // ─── The one editor ─────────────────────────────────────────────────────────

  /**
   * Mount Trumbowyg on an element. NC's <base> tag is taken out during init so
   * baseHref resolves to "" — otherwise <use href="#icon"> becomes
   * <use href="[pageURL]#icon">.
   * @private
   */
  _mountTrumbowyg(host) {
    const baseTag = document.querySelector("base");
    if (baseTag) baseTag.remove();
    const $host = jQuery(host);
    $host.trumbowyg(EDITOR_OPTIONS);
    if (baseTag) document.head.appendChild(baseTag);

    // Trumbowyg inserts its SVG sprite as body.childNodes[0], breaking NC's flex body layout
    // (#header must be first). Relocate it to after #header (or to body end as fallback).
    const sprite = document.getElementById("trumbowyg-icons");
    if (sprite) {
      const header = document.getElementById("header");
      if (header?.parentNode) {
        if (sprite.previousSibling !== header)
          header.parentNode.insertBefore(sprite, header.nextSibling);
      } else if (sprite !== document.body.lastChild) {
        document.body.appendChild(sprite);
      }
    }
    return $host;
  }

  /**
   * The button pane as a static, disabled copy (DESIGN §4.2): the toolbar
   * keeps its layout without an editor behind it. Built from a throwaway
   * instance, so it matches the live pane exactly.
   * @private
   */
  _buildDisabledPane() {
    const probe = document.createElement("div");
    probe.style.display = "none";
    this.container.appendChild(probe);
    const host = document.createElement("div");
    probe.appendChild(host);
    const $host = this._mountTrumbowyg(host);
    const livePane = probe.querySelector(".trumbowyg-button-pane");
    const pane = livePane ? livePane.cloneNode(true) : document.createElement("div");
    $host.trumbowyg("destroy");
    probe.remove();

    pane.classList.add("trumbowyg-button-pane", "note-canvas__toolbar-pane--disabled");
    pane.title = t("canvas.textBox.toolbarHint");
    for (const button of pane.querySelectorAll("button")) {
      button.disabled = true;
      button.removeAttribute("title");
    }
    const taskBtn = pane.querySelector(".trumbowyg-markAsTask-button");
    if (taskBtn) taskBtn.innerHTML = getIcon("checkSquare", 20);
    return pane;
  }

  /**
   * Make `box` the active box: mount the editor on it and focus it. Runs
   * synchronously, so a call from a tap handler focuses within the user's
   * gesture (Android opens the keyboard only then).
   * @param {TextBox} box
   * @param {{clientX?: number, clientY?: number, atEnd?: boolean, addLine?: boolean}} [where] -
   *   caret at a client point (where the user tapped), or at the end
   * @private
   */
  _activate(box, where = {}) {
    if (this.readOnly) return;
    if (this._active === box) {
      this._editorElement?.focus({ preventScroll: true });
      return;
    }
    this._deactivate();

    const host = TextBox.createContentElement();
    host.innerHTML = box.html;
    box.replaceContentElement(host);
    const $host = this._mountTrumbowyg(host);

    this.$editor = $host;
    this._editorElement = host;
    this._active = box;
    host.textEditorLayer = this; // Link instance for direct access from plugins

    // Attach instance to Trumbowyg object for plugin access
    const trumbowyg = $host.data("trumbowyg");
    if (trumbowyg) trumbowyg.textEditorLayer = this;

    // Move toolbar to fixed vertical sidebar
    const trumbowygBox = box.el.querySelector(".trumbowyg-box");
    this._editorBox = trumbowygBox;
    const btnPane = trumbowygBox?.querySelector(".trumbowyg-button-pane");
    this._disabledPane.remove();
    if (btnPane) this.toolbarWrapper.appendChild(btnPane);
    this._livePane = btnPane ?? null;

    // Move dropdown menus to toolbar wrapper (Trumbowyg appends them to $box)
    this._liveDropdowns = trumbowygBox
      ? [...trumbowygBox.querySelectorAll(".trumbowyg-dropdown")]
      : [];
    for (const dd of this._liveDropdowns) this.toolbarWrapper.appendChild(dd);

    // Inject icon for Mark as Task button
    const taskBtn = this.toolbarWrapper.querySelector(".trumbowyg-markAsTask-button");
    if (taskBtn) taskBtn.innerHTML = getIcon("checkSquare", 20);

    if (trumbowygBox) {
      trumbowygBox.addEventListener("mousedown", (e) => {
        if (e.target.closest(".trumbowyg-dropdown")) e.preventDefault();
      });
      // The table plugin's grid and buttons live here (see _onToolbarAction)
      trumbowygBox.addEventListener("mousedown", this._onToolbarAction, true);
      trumbowygBox.addEventListener("click", this._onToolbarAction, true);
    }

    // Patch Trumbowyg's dropdown positioning to work with our vertical toolbar
    this._patchDropdownPositioning();

    // The table plugin checks t.$box.find('.trumbowyg-table-button').hasClass('active-button')
    // to decide whether to show edit options vs. create grid. Since we moved buttons to
    // toolbarWrapper, add a hidden proxy inside $box that mirrors the real button's classes.
    this._setupTableButtonProxy(trumbowygBox);

    // Listen for content changes, and for Mark as Task (the jQuery plugin event
    // and the native DOM fallback both funnel through one handler)
    $host.on("tbwchange", this._onEditorChange);
    $host.on("tbwmarkastask", this._onMarkAsTask);
    host.addEventListener("tbwmarkastask", this._onMarkAsTask);
    host.addEventListener("keydown", this._onEditorKeyDown);

    // Mounting is not an edit: the box keeps its stored string unless the
    // editor's HTML really changes (Trumbowyg normalizes on load)
    this._mountedHtml = cleanEditorHtml(host.innerHTML);
    this._maybeEdited = false;

    if (this.textTaskManager) {
      this.textTaskManager.editorElement = host;
      this.textTaskManager.renderCheckboxes(this._tasks);
    }
    renderMergeHints(host);
    if (this._searchQuery) this._highlightIn(host, this._searchQuery);

    // Floating copy/cut/paste bar for text selections (works on Android and desktop)
    this._selectionFloatingBar = new SelectionFloatingBar(host, this.viewportElement);

    box.el.classList.add("text-box--active");
    this._updateToolbarState();

    host.focus({ preventScroll: true });
    if (where.addLine) this._appendEmptyLine(host);
    this._placeCaretWhere(host, where);
    this._scheduleFrames();
  }

  /**
   * Leave the active box: its text goes back to static HTML, the editor is
   * destroyed. A box left empty is removed (no stray empty boxes); its content
   * is already gone from getContent(), so this is no change to record.
   * @private
   */
  _deactivate() {
    const box = this._active;
    if (!box) return;
    const html = this._htmlOf(box);

    if (this._editorElement && document.activeElement === this._editorElement) {
      this._editorElement.blur();
    }

    this._selectionFloatingBar?.destroy();
    this._selectionFloatingBar = null;
    this._tableProxyObserver?.disconnect();
    this._tableProxyObserver = null;

    const host = this._editorElement;
    host.removeEventListener("tbwmarkastask", this._onMarkAsTask);
    host.removeEventListener("keydown", this._onEditorKeyDown);
    host.textEditorLayer = null;
    const trumbowyg = this.$editor.data("trumbowyg");
    if (trumbowyg) {
      trumbowyg.textEditorLayer = null;
      jQuery("body", trumbowyg.doc).off(`mousedown.${trumbowyg.eventNamespace}`);
    }
    this.$editor.off("tbwchange", this._onEditorChange);
    this.$editor.off("tbwmarkastask", this._onMarkAsTask);
    this.$editor.trumbowyg("destroy");

    // The pane and dropdowns live in the toolbar, outside Trumbowyg's box
    this._livePane?.remove();
    for (const dd of this._liveDropdowns ?? []) dd.remove();
    // The table plugin's dropdown, moved here when shown
    for (const dd of this.toolbarWrapper.querySelectorAll(".trumbowyg-dropdown")) dd.remove();
    this._livePane = null;
    this._liveDropdowns = [];
    this.toolbarWrapper.appendChild(this._disabledPane);

    // destroy() leaves the editor's content behind in a wrapper of its own,
    // with Trumbowyg's normalization applied: replaced by the stored string
    for (const leftover of box.el.querySelectorAll(
      ":scope > .trumbowyg-editor-box, :scope > .trumbowyg-box",
    )) {
      leftover.remove();
    }
    box.html = html;
    box.contentEl = TextBox.createContentElement();
    box.el.insertBefore(box.contentEl, box.el.firstChild);
    box.renderStatic();
    box.el.classList.remove("text-box--active");

    this.$editor = null;
    this._editorElement = null;
    this._editorBox = null;
    this._active = null;
    this._maybeEdited = false;
    if (this.textTaskManager) {
      this.textTaskManager.editorElement = null;
      this.textTaskManager.renderCheckboxes(this._tasks);
    }
    if (this._searchQuery) this._highlightIn(box.contentEl, this._searchQuery);

    if (isEmptyBoxHtml(html)) this._removeBoxElement(box);
    this._updateToolbarState();
    this._scheduleFrames();
  }

  /** The box's current inner HTML: the editor's for an edited active box, else the stored string. @private */
  _htmlOf(box) {
    if (box !== this._active || !this._maybeEdited || !this._editorElement) return box.html;
    const now = cleanEditorHtml(this._editorElement.innerHTML);
    return now === this._mountedHtml ? box.html : now;
  }

  /** @private */
  _onEditorChange() {
    if (this._suppressHistory) return;
    this._maybeEdited = true;
    this.isDirty = true;
    this._debounceSave();
    this._debounceHistoryPush();
    this._scheduleFrames();
  }

  /**
   * After a toolbar or dropdown action: record what it changed. Most actions
   * go through Trumbowyg's execCmd, which reports a change (tbwchange); the
   * table plugin writes the DOM itself and reports nothing, so a table
   * inserted (or a row added) would otherwise be neither saved nor undoable
   * until the next keystroke. Runs after the action; does nothing when the
   * text did not change.
   * @private
   */
  _onToolbarAction(e) {
    if (!e.target.closest?.("button, td, .trumbowyg-dropdown")) return;
    setTimeout(() => {
      if (!this._editorElement || this._suppressHistory) return;
      this._maybeEdited = true;
      if (this.getContent() !== this._lastHtml) this._onEditorChange();
    }, 0);
  }

  /**
   * The table size grid: picked on release, not on press. The table plugin
   * builds the table on mousedown at the cell pressed and marks the size only
   * on hover, so marking by pressing the first cell and dragging to the size
   * wanted (the only way with a finger, which has no hover) built a 1 x 1
   * table. Here a press starts marking, moving marks (the plugin's own
   * highlight and size label), and the release builds the table of the cell
   * under the pointer. A tap or a click picks its cell as before.
   * @private
   */
  _setupTableGridPicking(trumbowygBox) {
    const BUILD = "notebergTableBuild";
    const gridOf = (e) => e.target.closest?.(".trumbowyg-dropdown-table table");
    let pick = null;
    const cellAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("td");
      return el && pick?.table.contains(el) ? el : null;
    };
    // The plugin's own handlers: mouseover marks, mousedown builds, mouseup closes
    const send = (cell, type) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      if (type === "mousedown") event[BUILD] = true;
      cell.dispatchEvent(event);
    };

    trumbowygBox.addEventListener(
      "pointerdown",
      (e) => {
        const table = gridOf(e);
        if (!table) return;
        // No pan, no focus change, no compatibility mousedown (which would build)
        e.preventDefault();
        e.stopPropagation();
        pick = { table, pointerId: e.pointerId };
        try {
          table.setPointerCapture(e.pointerId);
        } catch (_err) {
          // Pointer already gone
        }
        const cell = cellAt(e);
        if (cell) send(cell, "mouseover");
      },
      true,
    );
    trumbowygBox.addEventListener(
      "pointermove",
      (e) => {
        if (!pick || e.pointerId !== pick.pointerId) return;
        const cell = cellAt(e);
        if (cell) send(cell, "mouseover");
      },
      true,
    );
    const end = (e) => {
      if (!pick || e.pointerId !== pick.pointerId) return;
      const cell = e.type === "pointerup" ? cellAt(e) : null;
      pick = null;
      if (!cell) return;
      send(cell, "mousedown");
      send(cell, "mouseup");
    };
    trumbowygBox.addEventListener("pointerup", end, true);
    trumbowygBox.addEventListener("pointercancel", end, true);
    // A mousedown the browser sends itself (some inputs still send one) must
    // not build: only the one sent on release does
    trumbowygBox.addEventListener(
      "mousedown",
      (e) => {
        if (gridOf(e) && !e[BUILD]) e.stopPropagation();
      },
      true,
    );
  }

  /**
   * The table dropdown's buttons (row, column and cell actions) act on the tap
   * (release without moving), for every input. Trumbowyg runs them on
   * mousedown and finds the table cell from the editor's selection. With a
   * finger there is no real mousedown: the browser sends one after the tap,
   * when the tap may already have taken the focus (on Android the keyboard
   * closes and the page resizes). Here the press keeps the focus and the
   * selection (preventDefault, which leaves scrolling alone), and the release
   * runs the button's own mousedown handler. A finger that moves scrolls the
   * menu instead (the browser cancels the pointer) and runs nothing.
   * @private
   */
  _setupTableDropdownButtons(root) {
    let press = null;
    const buttonOf = (e) => {
      const button = e.target.closest?.(".trumbowyg-dropdown-table button");
      return button && root.contains(button) ? button : null;
    };
    root.addEventListener(
      "pointerdown",
      (e) => {
        const button = buttonOf(e);
        if (!button) return;
        e.preventDefault();
        e.stopPropagation();
        press = { button, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      },
      true,
    );
    root.addEventListener(
      "pointermove",
      (e) => {
        if (press && e.pointerId === press.pointerId) {
          if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > TAP_SLOP) press = null;
        }
      },
      true,
    );
    root.addEventListener(
      "pointerup",
      (e) => {
        if (!press || e.pointerId !== press.pointerId) return;
        const { button } = press;
        press = null;
        if (buttonOf(e) !== button) return;
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      },
      true,
    );
    root.addEventListener(
      "pointercancel",
      (e) => {
        if (press && e.pointerId === press.pointerId) press = null;
      },
      true,
    );
  }

  /** Mark as Task, and the first-use help for it. @private */
  _onMarkAsTask() {
    if (this.readOnly) return;
    this.textTaskManager?.toggleTaskOnSelection(this.$editor?.data("trumbowyg"));
    // First-ever "Mark as Task" use on this device. Anchors to the toolbar
    // button (queryable now that the action has fired), centered otherwise.
    const markAsTask = getHelpContent().markAsTask;
    startHelpTour(
      HELP_IDS.MARK_AS_TASK,
      [
        {
          target: document.querySelector(".trumbowyg-markAsTask-button"),
          title: markAsTask.title,
          body: markAsTask.body,
        },
      ],
      getHelpLabels(),
    );
  }

  /** Esc leaves the box; Delete/Backspace in an empty box removes it. @private */
  _onEditorKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this._deactivate();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && this._active && !this._active.implicit) {
      if (isEmptyBoxHtml(cleanEditorHtml(this._editorElement.innerHTML))) {
        e.preventDefault();
        this._deleteBox(this._active);
      }
    }
  }

  /** Enable or disable the toolbar's hint state. @private */
  _updateToolbarState() {
    this.toolbarWrapper.classList.toggle("note-canvas__trumbowyg-toolbar--idle", !this._active);
  }

  /** Put the caret where the user tapped, or at the end of the box. @private */
  _placeCaretWhere(host, { clientX, clientY, atEnd } = {}) {
    let range = null;
    if (!atEnd && clientX !== undefined && clientY !== undefined) {
      range = caretRangeAt(clientX, clientY);
      if (range && !host.contains(range.startContainer)) range = null;
    }
    if (!range) range = endOfText(host);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /** Caret to the end of the active box (a tap in its continue zone). @private */
  _continueActive(addLine) {
    const host = this._editorElement;
    host.focus({ preventScroll: true });
    if (addLine) this._appendEmptyLine(host);
    this._placeCaretWhere(host, { atEnd: true });
  }

  /** An empty line at the end of the box, for a tap more than one line below it. @private */
  _appendEmptyLine(host) {
    const p = document.createElement("p");
    p.appendChild(document.createElement("br"));
    host.appendChild(p);
    this.$editor?.trigger("tbwchange");
  }

  /**
   * Patch Trumbowyg's dropdown method so dropdowns position relative to our vertical toolbar.
   * Standard dropdowns live in the toolbar wrapper. The table plugin creates its dropdown
   * dynamically inside $box (the transformed container) — we handle both cases.
   * @private
   */
  _patchDropdownPositioning() {
    const trumbowygInstance = this.$editor.data("trumbowyg");
    if (!trumbowygInstance) return;

    const toolbarWrapper = this.toolbarWrapper;
    const textLayer = this;
    const prefix = trumbowygInstance.o.prefix; // "trumbowyg-"
    const scrollerContainer = this.scrollerContainer;
    const originalBox = trumbowygInstance.$box;

    const hideAll = (eventNs) => {
      jQuery(`.${prefix}dropdown`, toolbarWrapper).hide();
      originalBox.find(`.${prefix}dropdown`).hide();
      jQuery(`.${prefix}active`, trumbowygInstance.$btnPane).removeClass(`${prefix}active`);
      jQuery("body", trumbowygInstance.doc).off(`mousedown.${eventNs}`);
    };

    trumbowygInstance.dropdown = function (name) {
      const $body = jQuery("body", this.doc);
      // Search toolbar wrapper first (standard dropdowns moved during init),
      // then $box (table plugin creates dropdowns dynamically there)
      let $dropdown = originalBox.find(`[data-${prefix}dropdown=${name}]`);
      if ($dropdown.length > 0) {
        // The table plugin builds its dropdown in the box (a new one each time
        // it opens). Inside the text layer it would be zoomed with the page and
        // stacked below everything above the layer (the footer, other
        // overlays), so a tap on its lower buttons could land on those
        // instead. It is shown in the toolbar like every other dropdown.
        for (const stale of toolbarWrapper.querySelectorAll(`[data-${prefix}dropdown=${name}]`)) {
          stale.remove();
        }
        toolbarWrapper.appendChild($dropdown[0]);
        // Table plugin: close dropdown when a grid cell is picked
        // (tableBuild inserts the table but doesn't close the dropdown)
        $dropdown.off("mouseup.dropdownDismiss").on("mouseup.dropdownDismiss", "td", () => {
          hideAll(this.eventNamespace);
        });
      } else {
        $dropdown = jQuery(`[data-${prefix}dropdown=${name}]`, toolbarWrapper);
      }
      if ($dropdown.length === 0) return;

      const $btn = jQuery(`.${prefix}${name}-button`, this.$btnPane);
      const show = $dropdown.is(":hidden");

      $body.trigger("mousedown");

      if (show) {
        $btn.addClass(`${prefix}active`);

        const btnRect = $btn[0].getBoundingClientRect();
        const containerRect = scrollerContainer.getBoundingClientRect();
        const desiredLeft = containerRect.left + toolbarWrapper.offsetWidth;
        const desiredTop = btnRect.top;

        $dropdown.css({ position: "fixed", top: desiredTop, left: desiredLeft }).show();
        textLayer._keepOnScreen($dropdown[0]);

        jQuery(window).trigger("scroll");

        $body.on(`mousedown.${this.eventNamespace}`, (e) => {
          if (!$dropdown.is(e.target) && $dropdown.has(e.target).length === 0) {
            hideAll(this.eventNamespace);
          }
        });
      }
    };
  }

  /**
   * Move a shown dropdown up so its bottom stays in the visible area: above the
   * on-screen keyboard (the visual viewport shrinks for it), at worst at the top.
   * @private
   */
  _keepOnScreen(dropdown) {
    const rect = dropdown.getBoundingClientRect();
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const top = viewport ? viewport.offsetTop : 0;
    if (rect.bottom <= bottom) return;
    dropdown.style.top = `${Math.max(top + 4, bottom - rect.height - 4)}px`;
  }

  /**
   * Add a hidden proxy element inside $box that mirrors the table button's classes.
   * The table plugin checks $box.find('.trumbowyg-table-button') to decide dropdown content.
   * Since the real button is in the toolbar wrapper (outside $box), we sync classes via observer.
   * @private
   */
  _setupTableButtonProxy(trumbowygBox) {
    if (!trumbowygBox) return;
    const realBtn = this.toolbarWrapper.querySelector(".trumbowyg-table-button");
    if (!realBtn) return;

    const proxy = document.createElement("span");
    proxy.className = realBtn.className;
    proxy.style.display = "none";
    trumbowygBox.appendChild(proxy);

    this._tableProxyObserver = new MutationObserver(() => {
      proxy.className = realBtn.className;
    });
    this._tableProxyObserver.observe(realBtn, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  // ─── Boxes ──────────────────────────────────────────────────────────────────

  /** Every box, the implicit main box first. @private */
  _allBoxes() {
    return this._main ? [this._main, ...this._boxes] : [...this._boxes];
  }

  /** Add a box element in DOM order (the main box first, the others after it). @private */
  _addBox(box, { asMain = false } = {}) {
    if (asMain) {
      this._main = box;
      this.container.insertBefore(box.el, this.container.firstChild);
    } else {
      this._boxes.push(box);
      this.container.insertBefore(box.el, this._mainFrame);
    }
    this._resizeObserver?.observe(box.el);
  }

  /** Take a box off the layer (no history: callers record what they changed). @private */
  _removeBoxElement(box) {
    if (this._active === box) this._deactivate();
    this._resizeObserver?.unobserve?.(box.el);
    box.destroy();
    if (box === this._main) this._main = null;
    else this._boxes = this._boxes.filter((b) => b !== box);
    if (this._hovered === box) this._hovered = null;
    this._updateContentHeight();
    this._scheduleFrames();
  }

  /** @private */
  _onBoxResize(entries) {
    for (const entry of entries) {
      const box = this._allBoxes().find((b) => b.el === entry.target);
      if (!box) continue;
      // borderBoxSize includes padding, giving us the full element height
      box.height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
    }
    this._updateContentHeight();
    this._scheduleFrames();
  }

  /** Content height = the lowest box bottom; reported to NoteCanvas when it changes. @private */
  _updateContentHeight() {
    let height = 0;
    for (const box of this._allBoxes()) height = Math.max(height, box.bottom);
    if (Math.abs(height - this._contentHeight) > HEIGHT_EPSILON) {
      this._contentHeight = height;
      this.onHeightChange(height);
    }
  }

  /** Below the lowest content: where a box without valid geometry goes. @private */
  _belowLowest() {
    let lowest = 0;
    for (const box of this._allBoxes()) {
      if (box.implicit || box.y !== null) lowest = Math.max(lowest, box.bottom);
    }
    return lowest + LINE_HEIGHT;
  }

  /**
   * Show `html` as the layer's content: boxes are matched by id, and only
   * those that changed are touched (an undo or a live take-in leaves the
   * others, and the active box's editor, alone where nothing changed).
   * @private
   */
  _applyContent(html) {
    const parsed = parseContent(html);

    // The implicit main box
    if (parsed.main !== "") {
      if (!this._main) {
        this._addBox(new TextBox({ id: null, html: parsed.main, implicit: true }), {
          asMain: true,
        });
      } else if (this._htmlOf(this._main) !== parsed.main) {
        this._setBoxHtml(this._main, parsed.main);
      }
    } else if (this._main) {
      this._removeBoxElement(this._main);
    }

    // The other boxes, by id
    const byId = new Map(this._boxes.map((b) => [b.id, b]));
    const next = [];
    for (const model of parsed.boxes) {
      let box = byId.get(model.id);
      if (box) {
        byId.delete(model.id);
        if (model.y !== null && (box.x !== model.x || box.y !== model.y || box.w !== model.w)) {
          box.setGeometry(model);
        }
        if (this._htmlOf(box) !== model.html) this._setBoxHtml(box, model.html);
      } else {
        box = new TextBox(model);
        this._resizeObserver?.observe(box.el);
      }
      next.push(box);
    }
    for (const gone of byId.values()) this._removeBoxElement(gone);

    // DOM order follows the content's; existing elements are moved only when it
    // changed (moving the active box would lose its caret)
    const inOrder =
      next.every((box, i) => this._boxes[i] === box) && next.length === this._boxes.length;
    this._boxes = next;
    if (!inOrder) {
      for (const box of next) {
        if (box.el.nextSibling !== this._mainFrame || box.el.parentNode !== this.container) {
          this.container.insertBefore(box.el, this._mainFrame);
        }
      }
    }

    // A box without valid geometry is placed below the lowest content
    for (const box of next) {
      if (box.y === null) box.setGeometry({ x: box.x, y: this._belowLowest(), w: box.w });
    }

    this._updateContentHeight();
    this._scheduleFrames();
  }

  /** Change a box's stored HTML and what it shows. @private */
  _setBoxHtml(box, html) {
    box.html = html;
    if (box === this._active) {
      this.$editor.trumbowyg("html", html);
      renderMergeHints(this._editorElement);
      this._mountedHtml = cleanEditorHtml(this._editorElement.innerHTML);
      this._maybeEdited = false;
    } else {
      box.renderStatic();
    }
    if (this._searchQuery) this._highlightIn(box.contentEl, this._searchQuery);
  }

  /** Content coordinates of a client point. @private */
  _contentPoint(clientX, clientY) {
    const rect = this.container.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.zoom, y: (clientY - rect.top) / this.zoom };
  }

  /**
   * The implicit main box's frame: its text column up to the widest line plus
   * a margin, and down to its last line, so the page beside legacy text is
   * empty page (DESIGN §4.3). Content px; null when it shows nothing.
   * @private
   */
  _measureMainHug() {
    const main = this._main;
    if (!main?.implicit) return null;
    // The lines' text, and what has a size without text: a range over the
    // whole content would also return every block's full-width box
    const rects = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(main.contentEl, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.trim() === "") continue;
      range.selectNodeContents(node);
      rects.push(...(range.getClientRects?.() ?? []));
    }
    for (const el of main.contentEl.querySelectorAll("img, table, hr, .task-text-checkbox")) {
      rects.push(el.getBoundingClientRect());
    }
    if (rects.length === 0) return null;
    const origin = this.container.getBoundingClientRect();
    let right = 0;
    let bottom = 0;
    for (const r of rects) {
      right = Math.max(right, (r.right - origin.left) / this.zoom);
      bottom = Math.max(bottom, (r.bottom - origin.top) / this.zoom);
    }
    const x = MAIN_BOX_GEOMETRY.x;
    const y = MAIN_BOX_GEOMETRY.y;
    const w = Math.max(MIN_BOX_WIDTH, Math.min(PAGE_WIDTH - x, right + MAIN_HUG_MARGIN - x));
    return { x, y, w, h: Math.max(LINE_HEIGHT, bottom + BOX_PADDING.bottom - y) };
  }

  /** A box's frame in content px: its rect, or the main box's hug. @private */
  _frameOf(box) {
    if (box.implicit) return box === this._main ? this._mainHug : null;
    return { x: box.x, y: box.y ?? 0, w: box.w, h: box.el.offsetHeight || box.height };
  }

  /** The box under a content point: the active box first, then the topmost. @private */
  _hitBox(point) {
    const inside = (f) =>
      f && point.x >= f.x && point.x <= f.x + f.w && point.y >= f.y && point.y <= f.y + f.h;
    if (this._active && inside(this._frameOf(this._active))) return this._active;
    const boxes = this._allBoxes();
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (inside(this._frameOf(boxes[i]))) return boxes[i];
    }
    return null;
  }

  /**
   * A box whose continue zone holds the point: within two lines below its
   * last line, inside its column (DESIGN §5). The nearest such box wins.
   * @returns {{box: TextBox, addLine: boolean}|null}
   * @private
   */
  _continueZone(point) {
    let best = null;
    for (const box of this._allBoxes()) {
      const f = this._frameOf(box);
      if (!f) continue;
      const lastLine = f.y + f.h - BOX_PADDING.bottom;
      const below = point.y - lastLine;
      if (below <= 0 || below > CONTINUE_ZONE) continue;
      if (point.x < f.x || point.x > f.x + f.w) continue;
      if (!best || below < best.below) best = { box, below };
    }
    return best ? { box: best.box, addLine: best.below > LINE_HEIGHT } : null;
  }

  /** Snap a box's text origin to the background's grid. @private */
  _snap(value, step, floor = false) {
    return (floor ? Math.floor(value / step) : Math.round(value / step)) * step;
  }

  /**
   * Create an empty box with its caret at a content point (snapped). It is
   * not part of the content until it holds text, so a mistaken tap costs
   * nothing; its first text is its creation, as one undo step.
   * @private
   */
  _createBoxAt(point, clientPoint) {
    const grid = snapGrid(this.getBackground());
    const textX = this._snap(point.x, grid.x);
    const textY = this._snap(point.y, grid.y, true);
    const { x, w } = fitNewBox(textX - BOX_PADDING.left);
    const y = Math.max(0, textY - BOX_PADDING.top);
    const box = new TextBox({ id: newBoxId(), x, y, w, html: "" });
    this._addBox(box);
    this._activate(box, { atEnd: true, ...clientPoint });

    // First-ever text box on this device: how to move it, and how a tap below
    // the text keeps typing
    const content = getHelpContent().firstTextBox;
    startHelpTour(
      HELP_IDS.FIRST_TEXT_BOX,
      [{ target: null, title: content.title, body: content.body }],
      getHelpLabels(),
    );
  }

  /** Remove a box as a user action (× or Delete in an empty box): one undo step. @private */
  _deleteBox(box) {
    this._pushHistoryCommand();
    this._removeBoxElement(box);
    this._commitChange();
  }

  /** Record and save a change made outside the editor (box created, moved, deleted). @private */
  _commitChange() {
    const after = this.getContent();
    if (after === this._lastHtml) return;
    if (this.historyManager) this.historyManager.push(new TextChangeCommand(this._lastHtml, after));
    this._lastHtml = after;
    clearTimeout(this._saveTimer);
    this.isDirty = false;
    this.onContentChange(after);
  }

  /**
   * Move boxes down or up (insert-space, DESIGN §7) and save. Recorded by the
   * caller's command (ShiftContentCommand), so the text change becomes the
   * new undo baseline instead of a step of its own.
   * @param {string[]} ids
   * @param {number} dy
   */
  moveBoxes(ids, dy) {
    const wanted = new Set(ids);
    const boxes = this._boxes.filter((b) => wanted.has(b.id));
    if (boxes.length === 0 || dy === 0) return;
    for (const box of boxes)
      box.setGeometry({ x: box.x, y: Math.max(0, (box.y ?? 0) + dy), w: box.w });
    const after = this.getContent();
    this._lastHtml = after;
    this._updateContentHeight();
    this._scheduleFrames();
    clearTimeout(this._saveTimer);
    this.isDirty = false;
    this.onContentChange(after);
  }

  /** Record pending typing as its own undo step now (before another command is pushed). */
  flushHistory() {
    this._pushHistoryCommand();
  }

  /**
   * Ids of the boxes whose top is below a content y (insert-space moves those;
   * the implicit main box never moves).
   * @param {number} y
   * @returns {string[]}
   */
  boxIdsBelow(y) {
    return this._boxes.filter((b) => (b.y ?? 0) > y).map((b) => b.id);
  }

  // ─── Pointer routing (text mode) ────────────────────────────────────────────

  /** Whether the layer takes pointer input now. @private */
  _interactive() {
    return this.mode === "text" && !this.readOnly;
  }

  /**
   * Whether an event is the layer's to route: not on the handles, and not on
   * the editor's own UI that lives inside the active box (the table grid,
   * colour dropdowns, modals), which would otherwise read as a tap on empty
   * page and leave the box before the editor acts on it.
   * @private
   */
  _ownsEvent(e) {
    const target = e.target;
    if (target.closest?.(".text-box__chrome, .trumbowyg-dropdown, .trumbowyg-modal-box"))
      return false;
    if (this._editorBox?.contains(target) && !this._editorElement?.contains(target)) return false;
    return true;
  }

  /**
   * Mouse and pen: a press on a static box activates it right away, with the
   * caret where it landed, so a drag from there selects text. Touch waits for
   * the tap (click): a finger that moves pans (NoteCanvas).
   * @private
   */
  _onPointerDown(e) {
    if (!this._interactive() || !this._ownsEvent(e)) return;
    this._pointerDown = {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
      handled: false,
      time: performance.now(),
    };
    // The canvas has this press (asked before it acts on it, so a press that
    // deselects an image does nothing else)
    if (this.isCanvasBusy()) {
      this._pointerDown.handled = true;
      return;
    }
    if (e.pointerType === "touch") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Task checkboxes and conflict hints act on click: no mount under them
    if (e.target.closest?.(".task-text-checkbox, .merge-hint")) return;

    const point = this._contentPoint(e.clientX, e.clientY);
    const box = this._hitBox(point);
    if (box && box === this._active) return; // the editor places the caret itself
    if (box) {
      e.preventDefault();
      this._pointerDown.handled = true;
      this._activate(box, { clientX: e.clientX, clientY: e.clientY });
      this._startDragSelect();
      return;
    }
    // Empty page: what happens is decided on release (a press that drags creates nothing)
    e.preventDefault();
  }

  /** Extend the selection while a press that activated a box drags on. @private */
  _startDragSelect() {
    const host = this._editorElement;
    if (!host) return;
    const selection = window.getSelection();
    const anchor = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    if (!anchor) return;
    const onMove = (ev) => {
      const range = caretRangeAt(ev.clientX, ev.clientY);
      if (!range || !host.contains(range.startContainer)) return;
      selection.setBaseAndExtent(
        anchor.startContainer,
        anchor.startOffset,
        range.startContainer,
        range.startOffset,
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  /**
   * A tap (any input) after the press: on a static box (touch) it activates
   * it; on empty page it leaves the active box, or else continues the box
   * above (continue zone) or creates a box there (DESIGN §5).
   * @private
   */
  _onClick(e) {
    if (!this._interactive()) return;
    const down = this._pointerDown;
    this._pointerDown = null;
    if (!this._ownsEvent(e) || e.target.closest?.(".task-text-checkbox, .merge-hint")) return;
    // Only a tap that began on the layer: a tap on a menu that closed under
    // the finger (the table actions) sends its click to what is below it
    if (!down || down.handled || performance.now() - down.time > TAP_MAX_MS) return;
    const type = e.pointerType || down?.type || "mouse";
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP) return;
    if (type === "touch" && this.isTapCancelled()) return;

    const point = this._contentPoint(e.clientX, e.clientY);
    const box = this._hitBox(point);
    if (box === this._active && box) return; // the editor placed the caret
    if (box) {
      this._activate(box, { clientX: e.clientX, clientY: e.clientY });
      return;
    }
    const zone = this._continueZone(point);
    // Just below the box being edited: typing goes on there
    if (zone && zone.box === this._active) {
      this._continueActive(zone.addLine);
      return;
    }
    if (this._active) {
      // First tap beside the text only leaves it (and closes the keyboard)
      this._deactivate();
      return;
    }
    if (zone) {
      this._activate(zone.box, { atEnd: true, addLine: zone.addLine });
      return;
    }
    this._createBoxAt(point);
  }

  /** Mouse hover shows a box's handles (text mode only). @private */
  _onPointerMove(e) {
    if (!this._interactive() || e.pointerType !== "mouse" || this._drag) return;
    if (e.target.closest?.(".text-box__chrome")) return;
    const box = this._hitBox(this._contentPoint(e.clientX, e.clientY));
    if (box !== this._hovered) {
      this._hovered = box;
      this._updateChrome();
    }
  }

  /** @private */
  _onPointerLeave(e) {
    if (e.pointerType !== "mouse" || this._drag || !this._hovered) return;
    this._hovered = null;
    this._updateChrome();
  }

  // ─── Move and resize ────────────────────────────────────────────────────────

  /** @private */
  _onChromeDown(e) {
    const action = e.target.closest("[data-action]")?.dataset.action;
    const box = this._chromeBox;
    if (!box || !this._interactive() || (action !== "move" && action !== "resize")) return;
    if (e.target.closest(".text-box__options")) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch (_err) {
      // Pointer already gone
    }
    // Typing so far is its own undo step, apart from the move
    this._pushHistoryCommand();
    // The legacy main box moves with its full text column (no line wraps
    // differently), but is resized from the width its frame shows
    let frame = { x: box.x, y: box.y ?? 0, w: box.w };
    if (box.implicit) {
      frame = { ...MAIN_BOX_GEOMETRY };
      if (action === "resize") frame.w = this._mainHug?.w ?? frame.w;
    }
    this._drag = {
      action,
      box,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      frame,
      moved: false,
      touch: e.pointerType === "touch",
    };
    if (this._drag.touch) this._showDragBadge(action, e.clientX, e.clientY);
  }

  /**
   * A big badge that follows the finger during a touch move or resize: the
   * handle itself is small and hidden under the fingertip. Sits above the
   * finger so it stays visible.
   * @private
   */
  _showDragBadge(action, clientX, clientY) {
    if (!this._dragBadge) {
      this._dragBadge = document.createElement("div");
      this._dragBadge.className = "text-box__drag-badge";
      this.container.appendChild(this._dragBadge);
    }
    const badge = this._dragBadge;
    if (badge.dataset.action !== action) {
      badge.dataset.action = action;
      badge.innerHTML = DRAG_BADGE_ICONS[action];
    }
    badge.hidden = false;
    this._moveDragBadge(clientX, clientY);
  }

  /** @private */
  _moveDragBadge(clientX, clientY) {
    const badge = this._dragBadge;
    if (!badge) return;
    const origin = this.container.getBoundingClientRect();
    badge.style.left = `${(clientX - origin.left) / this.zoom}px`;
    badge.style.top = `${(clientY - origin.top) / this.zoom}px`;
  }

  /** @private */
  _hideDragBadge() {
    if (this._dragBadge) this._dragBadge.hidden = true;
  }

  /** @private */
  _onChromeMove(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    if (drag.touch) this._moveDragBadge(e.clientX, e.clientY);
    const dx = (e.clientX - drag.startX) / this.zoom;
    const dy = (e.clientY - drag.startY) / this.zoom;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 3) return;
    drag.moved = true;

    // The implicit main box becomes an ordinary box at its first move or
    // resize, at the geometry that keeps its text in place
    if (drag.box.implicit) this._wrapMainBox(drag.box);

    const grid = snapGrid(this.getBackground());
    const { frame } = drag;
    let geometry;
    // An axis the pointer has not really moved along keeps its value: a
    // straight drag down does not shift the text sideways onto the grid
    const along = (delta, step) => Math.abs(delta) >= step / 2;
    if (drag.action === "move") {
      const textX = along(dx, grid.x)
        ? this._snap(frame.x + dx + BOX_PADDING.left, grid.x)
        : frame.x + BOX_PADDING.left;
      const textY = along(dy, grid.y)
        ? this._snap(frame.y + dy + BOX_PADDING.top, grid.y)
        : frame.y + BOX_PADDING.top;
      geometry = clampBox({ x: textX - BOX_PADDING.left, y: textY - BOX_PADDING.top, w: frame.w });
    } else {
      const right = along(dx, grid.x)
        ? this._snap(frame.x + frame.w + dx, grid.x)
        : frame.x + frame.w;
      geometry = clampBox({
        x: frame.x,
        y: frame.y,
        w: Math.min(PAGE_WIDTH - frame.x, right - frame.x),
      });
      geometry.x = frame.x;
    }
    drag.box.setGeometry(geometry);
    this._updateContentHeight();
    this._updateChrome();
  }

  /** One command per move or resize, on release. @private */
  _onChromeUp(e) {
    const drag = this._drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this._drag = null;
    this._hideDragBadge();
    if (drag.moved) this._commitChange();
    this._scheduleFrames();
  }

  /** @private */
  _wrapMainBox(box) {
    box.wrap(newBoxId(), { ...MAIN_BOX_GEOMETRY });
    this._main = null;
    this._boxes.unshift(box);
    this._mainHug = null;
    // Still first in DOM order, where its text already was
  }

  // ─── Frames and handles ─────────────────────────────────────────────────────

  /** Re-measure the main box's frame and place the handles, once per frame. @private */
  _scheduleFrames() {
    if (this._framesPending) return;
    this._framesPending = true;
    const run = () => {
      this._framesPending = false;
      this._updateFrames();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }

  /** @private */
  _updateFrames() {
    if (!this.container) return;
    this._mainHug = this._measureMainHug();
    const hug = this._mainHug;
    this._mainFrame.hidden = !hug;
    if (hug) {
      Object.assign(this._mainFrame.style, {
        left: `${hug.x}px`,
        top: `${hug.y}px`,
        width: `${hug.w}px`,
        height: `${hug.h}px`,
      });
      this._mainFrame.classList.toggle("text-box__frame--active", this._active === this._main);
    }
    this._updateChrome();
  }

  /** Handles on the hovered box (mouse), else the active one; text mode only. @private */
  _updateChrome() {
    const box = this._drag?.box ?? this._hovered ?? this._active;
    const frame = box && this._interactive() ? this._frameOf(box) : null;
    this._chromeBox = frame ? box : null;
    this._chrome.hidden = !frame;
    if (!frame) return;
    // No room above at the top of the page (the legacy main box starts there):
    // the move handle goes below the frame instead, where it can be grabbed
    const handleHeight = 24 / this.zoom;
    this._chrome.classList.toggle("text-box__chrome--handle-below", frame.y < handleHeight);
    Object.assign(this._chrome.style, {
      left: `${frame.x}px`,
      top: `${frame.y}px`,
      width: `${frame.w}px`,
      height: `${Math.max(frame.h, LINE_HEIGHT)}px`,
    });
  }

  // ─── Paste and drop ─────────────────────────────────────────────────────────

  /**
   * Paste into the active box: a pasted image becomes a page image at the
   * caret (DESIGN §12), pasted HTML loses its images and box wrappers.
   * @private
   */
  _onPaste(e) {
    if (this.readOnly || !this._active) return;
    const data = e.clipboardData;
    if (!data) return;
    const files = [];
    for (const item of data.items ?? []) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      this.onImageInsert?.(files, this._caretInsertPoint());
      return;
    }
    const html = data.getData?.("text/html");
    if (html && (/<(img|picture)\b/i.test(html) || mayHaveBoxes(html))) {
      e.preventDefault();
      e.stopPropagation();
      // Box wrappers from another note go first; their text stays
      const clean = sanitizePastedHtml(stripBoxWrappers(html));
      document.execCommand("insertHTML", false, clean);
      this.$editor?.trigger("tbwchange");
    }
  }

  /** Where a pasted image goes: the box's text column, just below the caret's line. @private */
  _caretInsertPoint() {
    const host = this._editorElement;
    const selection = window.getSelection?.();
    if (!host || !selection?.rangeCount || !host.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const node = range.startContainer;
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      rect = element?.getBoundingClientRect?.() ?? null;
    }
    if (!rect) return null;
    const origin = this.container.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const padLeft = Number.parseFloat(getComputedStyle(host).paddingLeft) || 0;
    return {
      x: (hostRect.left - origin.left) / this.zoom + padLeft,
      y: (rect.bottom - origin.top) / this.zoom,
    };
  }

  /** Allow an image file to be dropped in text mode. @private */
  _onDragOver(e) {
    if (!this._interactive() || ![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }

  /** An image file dropped in text mode becomes a page image at the drop point. @private */
  _onDrop(e) {
    if (!this._interactive()) return;
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    this.onImageInsert?.(files, this._contentPoint(e.clientX, e.clientY));
  }

  // ─── Viewport ───────────────────────────────────────────────────────────────

  /**
   * Update position based on scroll and zoom.
   * Uses top/left CSS properties for scroll positioning (not transform translate)
   * so the browser's auto-scroll-to-caret uses the correct layout position.
   * @param {number} zoom - Current zoom scale
   * @param {number} scrollLeft - Horizontal scroll offset in screen pixels
   * @param {number} scrollTop - Vertical scroll offset in screen pixels
   * @param {number} centeringOffset - X offset for centering in screen pixels
   */
  update(zoom, scrollLeft, scrollTop, centeringOffset) {
    this.zoom = zoom;
    this.scrollLeft = scrollLeft;
    this.scrollTop = scrollTop;
    this.centeringOffset = centeringOffset;
    this._updatePosition();
  }

  /**
   * Set the total content height (so the text layer covers the full scrollable area).
   * This keeps the text layer container in sync with the drawing layer's height.
   * @param {number} height - Content height in content pixels
   */
  setContentHeight(height) {
    this._totalContentHeight = height;
    if (this.container) {
      this.container.style.height = `${height}px`;
    }
  }

  /**
   * Apply positioning to the text layer using top/left + scale.
   * Using top/left instead of transform: translate() ensures the browser's
   * auto-scroll-to-caret calculation uses the correct layout position.
   * @private
   */
  _updatePosition() {
    if (!this.container) return;

    const screenX = -this.scrollLeft + this.centeringOffset;
    const screenY = -this.scrollTop;

    this.container.style.top = `${screenY}px`;
    this.container.style.left = `${screenX}px`;
    this.container.style.transform = `scale(${this.zoom})`;
    this.container.style.width = `${this.maxContentWidth}px`;
    // Handles are sized in screen pixels: counter-scaled by 1/zoom (DESIGN §5)
    this.container.style.setProperty("--text-box-inv-zoom", String(1 / this.zoom));
  }

  /**
   * Set mode (enables/disables pointer events and toolbar visibility)
   * @param {string} mode - 'pan', 'draw', 'eraser', 'lasso', 'text'
   */
  setMode(mode) {
    // A viewer never gets the editor: text stays visible but cannot be changed
    if (this.readOnly) mode = "pan";
    if (mode !== "text") {
      this._closeBoxOptions();
      this._deactivate();
      this._hovered = null;
    }
    this.mode = mode;
    // Show/hide Trumbowyg toolbar
    if (this.toolbarWrapper) {
      this.toolbarWrapper.style.display = mode === "text" ? "" : "none";
    }
    this._updateChrome();
    // pointer-events controlled by CSS on .note-canvas container class
  }

  /**
   * Show the text without letting it be changed (a read-only shared notebook).
   * @param {boolean} readOnly
   */
  setReadOnly(readOnly) {
    if (readOnly) this._deactivate();
    this.readOnly = readOnly;
    this.setMode("pan");
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  /**
   * Highlight search terms in every box using <mark> elements.
   * @param {string} query - Search query (supports * and ? wildcards)
   */
  highlightSearchTerms(query) {
    this.clearHighlights();
    this._searchQuery = query || "";
    if (!query) return;
    for (const box of this._allBoxes()) this._highlightIn(box.contentEl, query);
  }

  /** @private */
  _highlightIn(root, query) {
    if (!root) return;
    const regex = searchRegex(query, { capture: true });

    // Walk all text nodes and wrap matches with <mark>
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      if (node.parentElement?.closest("mark.search-highlight")) continue;
      if (!regex.test(node.textContent)) continue;
      regex.lastIndex = 0;

      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      for (const match of node.textContent.matchAll(regex)) {
        // Text before match
        if (match.index > lastIndex) {
          frag.appendChild(document.createTextNode(node.textContent.slice(lastIndex, match.index)));
        }
        // Matched text in <mark>
        const mark = document.createElement("mark");
        mark.className = "search-highlight";
        mark.textContent = match[0];
        frag.appendChild(mark);
        lastIndex = match.index + match[0].length;
      }
      // Remaining text
      if (lastIndex < node.textContent.length) {
        frag.appendChild(document.createTextNode(node.textContent.slice(lastIndex)));
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  /**
   * Remove all search highlight marks from every box.
   */
  clearHighlights() {
    this._searchQuery = "";
    if (!this.container) return;
    const marks = this.container.querySelectorAll("mark.search-highlight");
    for (const mark of marks) {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize(); // Merge adjacent text nodes
    }
  }

  /**
   * The element of a text task (its span), in whichever box it is.
   * @param {string} taskId
   * @returns {HTMLElement|null}
   */
  findTaskElement(taskId) {
    return this.container?.querySelector(`.task-text[data-task-id="${taskId}"]`) ?? null;
  }

  // ─── Content ────────────────────────────────────────────────────────────────

  /**
   * Get current HTML content: the main box's text, then every box with text,
   * wrapped with its geometry. Only the active box is read from the editor;
   * every other box contributes its stored string.
   * @returns {string}
   */
  getContent() {
    if (!this.container) return "";
    let out = this._main ? this._htmlOf(this._main) : "";
    for (const box of this._boxes) {
      const html = this._htmlOf(box);
      // An empty box is not content (a new box until it has text, or one emptied)
      if (isEmptyBoxHtml(html)) continue;
      out += boxHtml({ id: box.id, x: box.x, y: box.y, w: box.w, html });
    }
    return out;
  }

  /**
   * Set content without triggering history push (used by undo/redo)
   * @param {string} html - HTML content to set
   */
  setContentSilently(html) {
    this._suppressHistory = true;
    this._applyContent(html);
    this._lastHtml = html;
    this._suppressHistory = false;
  }

  /**
   * Replace the text with a version that came from storage (another writer's
   * changes merged in), without recording an undo step. Only boxes that changed
   * are touched, and the caret stays with the text it was in, within its box
   * (caretMapping.js), so typing can go on.
   * @param {string} html
   */
  replaceContent(html) {
    const active = this._active;
    const caret = active ? this._caretOffset() : null;
    const before = caret === null ? null : this._caretText();
    const safeHtml = sanitizeNoteHtml(html || "");
    this.setContentSilently(safeHtml);
    if (caret !== null && this._active === active) {
      this._placeCaret(mapCaretOffset(before, this._caretText(), caret));
    }
  }

  /** The active editor's text nodes the caret can stand in: not a conflict hint's icon. */
  _caretTextNodes() {
    const editor = this._editorElement;
    if (!editor) return [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest(MERGE_HINT_SELECTOR)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  }

  /** The active editor's text as the caret offsets count it. */
  _caretText() {
    return this._caretTextNodes()
      .map((node) => node.data)
      .join("");
  }

  /** The caret as a character offset into the active editor's text, or null when it is elsewhere. */
  _caretOffset() {
    const selection = window.getSelection?.();
    const editor = this._editorElement;
    if (!editor || !selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    let offset = range.toString().length;
    // Hint icons before the caret are not text it can stand in
    for (const hint of editor.querySelectorAll(MERGE_HINT_SELECTOR)) {
      if (range.intersectsNode(hint)) offset -= hint.textContent.length;
    }
    return Math.max(0, offset);
  }

  /** Put the caret at a character offset into the active editor's text (the end if beyond it). */
  _placeCaret(offset) {
    const editor = this._editorElement;
    if (!editor) return;
    const range = document.createRange();
    let remaining = offset;
    let placed = false;
    for (const node of this._caretTextNodes()) {
      if (remaining <= node.length) {
        range.setStart(node, remaining);
        range.collapse(true);
        placed = true;
        break;
      }
      remaining -= node.length;
    }
    if (!placed) {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Get content height in content coordinates (before zoom)
   * @returns {number}
   */
  getContentHeight() {
    return this._contentHeight;
  }

  /**
   * Debounce content save to storage
   * @private
   */
  _debounceSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      if (this.isDirty) {
        this.onContentChange(this.getContent());
        this.isDirty = false;
      }
    }, 500);
  }

  /**
   * Debounce history push to group rapid keystrokes into one undo command
   * @private
   */
  _debounceHistoryPush() {
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => {
      this._pushHistoryCommand();
    }, 300);
  }

  /**
   * Push a TextChangeCommand to HistoryManager if content changed
   * @private
   */
  _pushHistoryCommand() {
    clearTimeout(this._historyTimer);
    if (!this.historyManager) return;

    const currentHtml = this.getContent();
    if (currentHtml === this._lastHtml) return;

    const command = new TextChangeCommand(this._lastHtml, currentHtml);
    this.historyManager.push(command);
    this._lastHtml = currentHtml;
  }

  /**
   * Force save (called on destroy/navigate)
   */
  forceSave() {
    clearTimeout(this._saveTimer);
    clearTimeout(this._historyTimer);

    // Push any pending history command before saving
    if (!this._suppressHistory) {
      this._pushHistoryCommand();
    }

    if (this.isDirty) {
      this.onContentChange(this.getContent());
      this.isDirty = false;
    }
  }

  /**
   * Render checkboxes for text tasks in every box
   * @param {Array} tasks - All tasks (will filter to text type)
   */
  renderTaskCheckboxes(tasks) {
    this._tasks = tasks ?? [];
    this.textTaskManager?.renderCheckboxes(this._tasks);
  }

  /**
   * Remove tasks whose spans are in no box any more (static or active)
   * @param {Array} tasks - Current tasks array (will be modified in place)
   * @returns {boolean} Whether any orphans were removed
   */
  cleanupOrphanedTextTasks(tasks) {
    return this.textTaskManager?.cleanupOrphans(tasks) ?? false;
  }

  /**
   * Clean up all resources
   */
  destroy() {
    this.forceSave();
    this._closeBoxOptions();
    this._deactivate();

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    if (this.toolbarWrapper?.parentNode) {
      this.toolbarWrapper.parentNode.removeChild(this.toolbarWrapper);
    }

    this._main = null;
    this._boxes = [];
    this.container = null;
    this.toolbarWrapper = null;
    this.historyManager = null;
  }
}
