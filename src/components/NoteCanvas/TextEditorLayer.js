/**
 * TextEditorLayer - WYSIWYG text editor overlay for NoteCanvas
 *
 * Manages a Trumbowyg editor instance positioned within the VirtualScroller viewport.
 * The text layer sits below the canvas (z-index 1) so strokes render on top.
 * Integrates with HistoryManager for unified undo/redo across text and strokes.
 */

import jQuery from "jquery/slim";

// Set jQuery global (required by Trumbowyg)
window.jQuery = window.$ = jQuery;

// Import Trumbowyg core and CSS
import "trumbowyg";
import "trumbowyg/dist/ui/trumbowyg.css";

// Import plugins
import "trumbowyg/dist/plugins/colors/trumbowyg.colors.js";
import "trumbowyg/dist/plugins/colors/ui/trumbowyg.colors.css";
import "trumbowyg/dist/plugins/fontfamily/trumbowyg.fontfamily.js";
import "trumbowyg/dist/plugins/fontsize/trumbowyg.fontsize.js";
import "trumbowyg/dist/plugins/indent/trumbowyg.indent.js";
import "trumbowyg/dist/plugins/lineheight/trumbowyg.lineheight.js";
import "trumbowyg/dist/plugins/table/trumbowyg.table.js";
import "trumbowyg/dist/plugins/table/ui/trumbowyg.table.css";

import { TextChangeCommand } from "./commands/TextChangeCommand.js";
import "./TextEditorLayer.css";

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

    // DOM elements
    this.container = null;
    this.editorDiv = null;
    this.$editor = null;
    this.toolbarWrapper = null;

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
    // Container div positioned absolutely in viewport (below canvas)
    this.container = document.createElement("div");
    this.container.className = "note-canvas__text-editor-layer";

    // Editor div (Trumbowyg will wrap this in .trumbowyg-box)
    this.editorDiv = document.createElement("div");
    this.editorDiv.className = "note-canvas__text-editor";

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

    // Configure SVG icons path
    jQuery.trumbowyg.svgPath = "/trumbowyg-icons.svg";

    this.$editor.trumbowyg({
      btns: [
        ["formatting"],
        ["fontfamily"],
        ["fontsize"],
        ["bold", "italic", "underline", "strikethrough"],
        ["foreColor", "backColor"],
        ["lineheight"],
        ["indent", "outdent"],
        ["unorderedList", "orderedList"],
        ["table"],
        ["removeformat"],
      ],
      autogrow: true,
      autogrowOnEnter: true,
      resetCss: false,
      semantic: true,
      tagsToRemove: ["script", "link"],
    });

    // Set initial content
    this.$editor.trumbowyg("html", htmlContent || "");
    this._lastHtml = htmlContent || "";

    // Move toolbar to fixed vertical sidebar
    const btnPane = this.container.querySelector(".trumbowyg-button-pane");
    if (btnPane) {
      this.toolbarWrapper.appendChild(btnPane);
    }

    // Listen for content changes
    this.$editor.on("tbwchange", () => {
      if (this._suppressHistory) return;

      this.isDirty = true;
      this._debounceSave();
      this._debounceHistoryPush();
    });

    // Track content height changes with ResizeObserver
    const trumbowygEditor = this.container.querySelector(".trumbowyg-editor");
    if (trumbowygEditor) {
      this._resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const newHeight = entry.contentRect.height;
          if (Math.abs(newHeight - this._contentHeight) > 10) {
            this._contentHeight = newHeight;
            this.onHeightChange(newHeight);
          }
        }
      });
      this._resizeObserver.observe(trumbowygEditor);
    }

    // Initial position update
    this._updatePosition();
  }

  /**
   * Update position based on scroll and zoom
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
   * Apply CSS transform to position the text editor in viewport space
   * @private
   */
  _updatePosition() {
    if (!this.container) return;

    const screenX = -this.scrollLeft + this.centeringOffset;
    const screenY = -this.scrollTop;

    this.container.style.transform = `translate(${screenX}px, ${screenY}px) scale(${this.zoom})`;
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
   * Get current HTML content
   * @returns {string}
   */
  getContent() {
    if (!this.$editor) return "";
    return this.$editor.trumbowyg("html");
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
   * Clean up all resources
   */
  destroy() {
    this.forceSave();

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this.$editor) {
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
