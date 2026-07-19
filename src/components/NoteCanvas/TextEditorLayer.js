/**
 * TextEditorLayer - WYSIWYG text editor overlay for NoteCanvas
 *
 * Manages a Trumbowyg editor instance positioned within the VirtualScroller viewport.
 * The text layer sits below the canvas (z-index 1) so strokes render on top.
 * Integrates with HistoryManager for unified undo/redo across text and strokes.
 */

import trumbowygIconsSvg from "../../assets/trumbowyg-icons.svg?raw";
// jQuery must be on `window` before Trumbowyg is imported (separate module avoids hoisting issues)
import jQuery from "./jquerySetup.js";

// Import Trumbowyg core and CSS (relies on window.jQuery set by jquerySetup)
import "trumbowyg";
import "trumbowyg/dist/ui/trumbowyg.css";

// Import plugins
import "trumbowyg/dist/plugins/colors/trumbowyg.colors.js";
import "trumbowyg/dist/plugins/colors/ui/trumbowyg.colors.css";
import "trumbowyg/dist/plugins/fontsize/trumbowyg.fontsize.js";
// Note: trumbowyg.indent.js uses execCommand('indent') which is removed in
// modern Chromium. We register a custom indent/outdent plugin below instead.
import "trumbowyg/dist/plugins/lineheight/trumbowyg.lineheight.js";
import "trumbowyg/dist/plugins/table/trumbowyg.table.js";
import "trumbowyg/dist/plugins/table/ui/trumbowyg.table.css";

import { HELP_IDS } from "../../modules/helpGuidance.js";
import { getIcon } from "../../utils/icons.js";
import { sanitizeNoteHtml } from "../../utils/sanitizeHtml.js";
import { startHelpTour } from "../HelpOverlay.js";
import { getHelpContent, getHelpLabels } from "../helpContent.js";
import { TextChangeCommand } from "./commands/TextChangeCommand.js";
import "./TextEditorLayer.css";
import { SelectionFloatingBar } from "./SelectionFloatingBar.js";
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

export class TextEditorLayer {
  /**
   * @param {HTMLElement} viewportElement - The VirtualScroller's viewport element
   * @param {HTMLElement} scrollerContainer - The scroller container (for placing the vertical toolbar)
   * @param {Object} options
   * @param {number} options.maxContentWidth - Maximum content width (default 1200)
   * @param {Function} options.onContentChange - Callback (htmlContent) => void
   * @param {Function} options.onHeightChange - Callback (heightPx) => void
   * @param {import('./HistoryManager.js').HistoryManager} options.historyManager - For unified undo/redo
   */
  constructor(viewportElement, scrollerContainer, options = {}) {
    this.viewportElement = viewportElement;
    this.scrollerContainer = scrollerContainer;
    this.maxContentWidth = options.maxContentWidth || 1200;
    this.onContentChange = options.onContentChange || (() => {});
    this.onHeightChange = options.onHeightChange || (() => {});
    this.historyManager = options.historyManager || null;
    this.onTaskCreate = options.onTaskCreate || null;
    this.onTaskToggle = options.onTaskToggle || null;

    // DOM elements
    this.container = null;
    this.editorDiv = null;
    this.$editor = null;
    this.toolbarWrapper = null;
    this.textTaskManager = null;

    // State
    this.mode = "pan";
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

    // Undo/redo state
    this._lastHtml = "";
    this._suppressHistory = false;

    this._createDOM();
  }

  /**
   * Create the DOM elements for the text editor layer
   * @private
   */
  _createDOM() {
    // Container div positioned absolutely in the viewport.
    // Uses top/left for scroll positioning instead of CSS transform translate,
    // so the browser's auto-scroll-to-caret calculation uses the correct
    // layout position. Only transform: scale() is used for zoom.
    this.container = document.createElement("div");
    this.container.className = "note-canvas__text-editor-layer";

    // Editor div (Trumbowyg will wrap this in .trumbowyg-box)
    this.editorDiv = document.createElement("div");
    this.editorDiv.className = "note-canvas__text-editor";
    this.editorDiv.textEditorLayer = this; // Link instance for direct access from plugins

    this.container.appendChild(this.editorDiv);
    this.viewportElement.appendChild(this.container);

    // Vertical toolbar wrapper (fixed position on left side of scroller container)
    this.toolbarWrapper = document.createElement("div");
    this.toolbarWrapper.className = "note-canvas__trumbowyg-toolbar";
    this.toolbarWrapper.style.display = "none"; // Hidden until text mode
    this.scrollerContainer.appendChild(this.toolbarWrapper);
  }

  /**
   * Initialize Trumbowyg editor and load content
   * @param {string} htmlContent - Initial HTML content
   */
  init(htmlContent) {
    this.$editor = jQuery(this.editorDiv);

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
    // Temporarily remove NC's <base> tag during init so baseHref resolves to "" not the
    // page URL — otherwise <use href="#icon"> becomes <use href="[pageURL]#icon">.
    jQuery.trumbowyg.svgPath = "";
    const baseTag = document.querySelector("base");
    if (baseTag) baseTag.remove();

    this.$editor.trumbowyg({
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
    });

    // Restore <base> tag after Trumbowyg init (we removed it so baseHref resolves to "")
    if (baseTag) document.head.appendChild(baseTag);

    // Trumbowyg inserts its SVG sprite as body.childNodes[0], breaking NC's flex body layout
    // (#header must be first). Relocate it to after #header (or to body end as fallback).
    const sprite = document.getElementById("trumbowyg-icons");
    if (sprite) {
      const header = document.getElementById("header");
      if (header?.parentNode) {
        header.parentNode.insertBefore(sprite, header.nextSibling);
      } else {
        document.body.appendChild(sprite);
      }
    }

    // Attach instance to Trumbowyg object for plugin access
    const trumbowyg = this.$editor.data("trumbowyg");
    if (trumbowyg) {
      trumbowyg.textEditorLayer = this;
    }

    // Set initial content — note HTML is untrusted synced data, sanitize before
    // it enters the live editor DOM. _lastHtml must hold the sanitized form so
    // dirty-detection compares like with like.
    const safeHtml = sanitizeNoteHtml(htmlContent || "");
    this.$editor.trumbowyg("html", safeHtml);
    this._lastHtml = safeHtml;

    // Move toolbar to fixed vertical sidebar
    const trumbowygBox = this.container.querySelector(".trumbowyg-box");
    const btnPane = trumbowygBox?.querySelector(".trumbowyg-button-pane");
    if (btnPane) {
      this.toolbarWrapper.appendChild(btnPane);
    }

    // Move dropdown menus to toolbar wrapper (Trumbowyg appends them to $box)
    if (trumbowygBox) {
      const dropdowns = trumbowygBox.querySelectorAll(".trumbowyg-dropdown");
      for (const dd of dropdowns) {
        this.toolbarWrapper.appendChild(dd);
      }
    }

    // Inject icon for Mark as Task button
    const taskBtn = this.toolbarWrapper.querySelector(".trumbowyg-markAsTask-button");
    if (taskBtn) {
      taskBtn.innerHTML = getIcon("checkSquare", 20);
    }

    // Prevent toolbar/dropdown clicks from stealing focus from the editor.
    // Without this, saveRange() gets a null range when clicking dropdown items.
    this.toolbarWrapper.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    if (trumbowygBox) {
      trumbowygBox.addEventListener("mousedown", (e) => {
        if (e.target.closest(".trumbowyg-dropdown")) {
          e.preventDefault();
        }
      });
    }

    // Patch Trumbowyg's dropdown positioning to work with our vertical toolbar
    this._patchDropdownPositioning();

    // The table plugin checks t.$box.find('.trumbowyg-table-button').hasClass('active-button')
    // to decide whether to show edit options vs. create grid. Since we moved buttons to
    // toolbarWrapper, add a hidden proxy inside $box that mirrors the real button's classes.
    this._setupTableButtonProxy(trumbowygBox);

    // Listen for content changes
    this.$editor.on("tbwchange", () => {
      if (this._suppressHistory) return;

      this.isDirty = true;
      this._debounceSave();
      this._debounceHistoryPush();
    });

    // Mark as Task — the jQuery plugin event and the native DOM fallback both
    // funnel through one handler so the first-use help fires exactly once.
    const onMarkAsTask = () => {
      this.textTaskManager?.toggleTaskOnSelection(this.$editor.data("trumbowyg"));
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
    };

    // Listen for Mark as Task event from plugin
    this.$editor.on("tbwmarkastask", onMarkAsTask);

    // Native event listener fallback
    this.editorDiv.addEventListener("tbwmarkastask", onMarkAsTask);

    // Track content height changes with ResizeObserver.
    // When the text editor grows (e.g. user adds lines), we notify NoteCanvas
    // so it can expand the shared contentHeight (phantom div + canvas).
    const trumbowygEditor = this.container.querySelector(".trumbowyg-editor");
    if (trumbowygEditor) {
      this._resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          // borderBoxSize includes padding, giving us the full element height
          const newHeight = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height + 40;
          if (Math.abs(newHeight - this._contentHeight) > 10) {
            this._contentHeight = newHeight;
            this.onHeightChange(newHeight);
          }
        }
      });
      this._resizeObserver.observe(trumbowygEditor);
    }

    this._editorElement = trumbowygEditor;

    // Floating copy/cut/paste bar for text selections (works on Android and desktop)
    if (this._editorElement) {
      this._selectionFloatingBar = new SelectionFloatingBar(
        this._editorElement,
        this.viewportElement,
      );
    }

    // Initialize TextTaskManager
    this.textTaskManager = new TextTaskManager(this._editorElement, {
      onTaskCreate: this.onTaskCreate,
      onTaskToggle: this.onTaskToggle,
      triggerChange: () => this.$editor.trigger("tbwchange"),
    });

    // Intercept image paste: compress/downscale before inserting as base64
    if (this._editorElement) {
      this._editorElement.addEventListener("paste", (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
          if (item.type.startsWith("image/")) {
            e.preventDefault();
            e.stopPropagation();
            const file = item.getAsFile();
            if (file) this._insertCompressedImage(file);
            break;
          }
        }
      });
    }

    // Initial position update
    this._updatePosition();
  }

  /**
   * Compress and insert a pasted image into the editor at the current caret position.
   * Downscales to MAX_WIDTH if larger, encodes as JPEG (or PNG for transparent images).
   * @param {File} file
   * @private
   */
  _insertCompressedImage(file) {
    const MAX_WIDTH = 800;
    const JPEG_QUALITY = 0.85;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const scale = img.width > MAX_WIDTH ? MAX_WIDTH / img.width : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);

        // Preserve PNG for images that may have transparency; JPEG for everything else
        const dataUrl =
          file.type === "image/png"
            ? canvas.toDataURL("image/png")
            : canvas.toDataURL("image/jpeg", JPEG_QUALITY);

        const trumbowyg = this.$editor?.data("trumbowyg");
        if (!trumbowyg) return;
        trumbowyg.restoreRange();
        trumbowyg.execCmd("insertImage", dataUrl, false, true);
        trumbowyg.syncCode();
        this.$editor.trigger("tbwchange");
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
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
    const textEditorLayer = this;
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
      let $dropdown = jQuery(`[data-${prefix}dropdown=${name}]`, toolbarWrapper);
      const inToolbar = $dropdown.length > 0;
      if (!inToolbar) {
        $dropdown = originalBox.find(`[data-${prefix}dropdown=${name}]`);
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

        if (inToolbar) {
          $dropdown.css({ position: "fixed", top: desiredTop, left: desiredLeft }).show();
        } else {
          // Dropdown is inside the text editor container which has transform: scale(zoom).
          // The transform creates a containing block for position:fixed children.
          // The container's origin in viewport coords is its getBoundingClientRect().
          // A fixed child at (L,T) renders at viewport (origin.x + L*zoom, origin.y + T*zoom).
          const zoom = textEditorLayer.zoom;
          const layerRect = textEditorLayer.container.getBoundingClientRect();
          $dropdown
            .css({
              position: "fixed",
              top: (desiredTop - layerRect.top) / zoom,
              left: (desiredLeft - layerRect.left) / zoom,
            })
            .show();

          // Table plugin: close dropdown when a grid cell is clicked
          // (tableBuild inserts the table but doesn't close the dropdown)
          $dropdown.off("mouseup.dropdownDismiss").on("mouseup.dropdownDismiss", "td", () => {
            hideAll(this.eventNamespace);
          });
        }

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
   * This keeps the text editor container in sync with the drawing layer's height.
   * @param {number} height - Content height in content pixels
   */
  setContentHeight(height) {
    this._totalContentHeight = height;
    if (this.container) {
      this.container.style.height = `${height}px`;
    }
  }

  /**
   * Apply positioning to the text editor using top/left + scale.
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
  }

  /**
   * Set mode (enables/disables pointer events and toolbar visibility)
   * @param {string} mode - 'pan', 'draw', 'eraser', 'lasso', 'text'
   */
  setMode(mode) {
    this.mode = mode;
    // Show/hide Trumbowyg toolbar
    if (this.toolbarWrapper) {
      this.toolbarWrapper.style.display = mode === "text" ? "" : "none";
    }
    // pointer-events controlled by CSS on .note-canvas container class
  }

  /**
   * Highlight search terms in the editor content using <mark> elements.
   * @param {string} query - Search query (supports * and ? wildcards)
   */
  highlightSearchTerms(query) {
    this.clearHighlights();
    if (!query || !this._editorElement) return;

    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escapeRegex(query).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
    const regex = new RegExp(`(${pattern})`, "gi");

    // Walk all text nodes in the editor and wrap matches with <mark>
    const walker = document.createTreeWalker(this._editorElement, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
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
   * Remove all search highlight marks from the editor.
   */
  clearHighlights() {
    if (!this._editorElement) return;
    const marks = this._editorElement.querySelectorAll("mark.search-highlight");
    for (const mark of marks) {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize(); // Merge adjacent text nodes
    }
  }

  /**
   * Get current HTML content
   * @returns {string}
   */
  getContent() {
    if (!this._editorElement) return "";

    // Get raw HTML directly from DOM to avoid Trumbowyg's filtering
    const rawHtml = this._editorElement.innerHTML;

    // Clean up UI elements using a temporary DOM element
    // This avoids modifying the live editor DOM (preventing cursor jumps/flickering)
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = rawHtml;

    // 1. Remove injected checkboxes (UI only, not persisted)
    const checkboxes = tempDiv.querySelectorAll(".task-text-checkbox");
    for (const cb of checkboxes) {
      cb.remove();
    }

    // 2. Unwrap search highlights
    const marks = tempDiv.querySelectorAll("mark.search-highlight");
    for (const mark of marks) {
      const parent = mark.parentNode;
      // Replace mark with its text content (unwrap)
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
    }

    // Normalize to merge text nodes
    tempDiv.normalize();

    return tempDiv.innerHTML;
  }

  /**
   * Set content without triggering history push (used by undo/redo)
   * @param {string} html - HTML content to set
   */
  setContentSilently(html) {
    this._suppressHistory = true;
    if (this.$editor) {
      this.$editor.trumbowyg("html", html);
    }
    this._lastHtml = html;
    this._suppressHistory = false;
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
    if (!this.historyManager || !this.$editor) return;

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

    if (this.isDirty && this.$editor) {
      this.onContentChange(this.getContent());
      this.isDirty = false;
    }
  }

  /**
   * Render checkboxes for text tasks in the editor DOM
   * @param {Array} tasks - All tasks (will filter to text type)
   */
  renderTaskCheckboxes(tasks) {
    this.textTaskManager?.renderCheckboxes(tasks);
  }

  /**
   * Remove tasks whose spans no longer exist in the editor DOM
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

    if (this._tableProxyObserver) {
      this._tableProxyObserver.disconnect();
      this._tableProxyObserver = null;
    }

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this.editorDiv) {
      this.editorDiv.textEditorLayer = null;
    }

    this._selectionFloatingBar?.destroy();
    this._selectionFloatingBar = null;
    this._editorElement = null;

    if (this.$editor) {
      const trumbowyg = this.$editor.data("trumbowyg");
      if (trumbowyg) {
        trumbowyg.textEditorLayer = null;
      }
      this.$editor.off("tbwchange");
      this.$editor.trumbowyg("destroy");
      this.$editor = null;
    }

    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    if (this.toolbarWrapper?.parentNode) {
      this.toolbarWrapper.parentNode.removeChild(this.toolbarWrapper);
    }

    this.container = null;
    this.editorDiv = null;
    this.toolbarWrapper = null;
    this.historyManager = null;
  }
}
