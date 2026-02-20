/**
 * SelectionFloatingBar - Floating Copy/Cut/Paste bar for the text editor
 *
 * Appears above the current text selection when text is selected inside the editor.
 * Also shows a Paste-only menu on long-press/right-click when nothing is selected.
 *
 * Lifecycle:
 *   const bar = new SelectionFloatingBar(editorElement, viewportElement, appClipboard);
 *   bar.destroy();
 */
import { t } from "../../i18n/index.js";
import { AppClipboard } from "./AppClipboard.js";

export class SelectionFloatingBar {
  /**
   * @param {HTMLElement} editorElement - The `.trumbowyg-editor` contenteditable div
   * @param {HTMLElement} viewportElement - The NoteCanvas viewport (used as positioning parent)
   */
  constructor(editorElement, viewportElement) {
    this._editor = editorElement;
    this._viewport = viewportElement;
    this._bar = null;

    this._onContextMenu = this._onContextMenu.bind(this);
    this._onEditorLongPressDown = this._onEditorLongPressDown.bind(this);
    this._onEditorLongPressMove = this._onEditorLongPressMove.bind(this);
    this._onEditorLongPressUp = this._onEditorLongPressUp.bind(this);
    this._longPressTimer = null;
    this._longPressStart = null;
    this._longPressPointerType = null;

    editorElement.addEventListener("contextmenu", this._onContextMenu);
    editorElement.addEventListener("pointerdown", this._onEditorLongPressDown);
    editorElement.addEventListener("pointermove", this._onEditorLongPressMove);
    editorElement.addEventListener("pointerup", this._onEditorLongPressUp);
    editorElement.addEventListener("pointercancel", this._onEditorLongPressUp);
  }

  _showSelectionBar(range) {
    const rect = range.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      this._hide();
      return;
    }

    const buttons = [];

    buttons.push({ label: t("canvas.textSelection.cut"), action: () => this._cut() });
    buttons.push({ label: t("canvas.textSelection.copy"), action: () => this._copy() });

    // Show Paste only if clipboard has compatible content
    if (AppClipboard.canPasteInMode("text")) {
      buttons.push({ label: t("canvas.textSelection.paste"), action: () => this._paste() });
    }

    this._showBar(buttons, {
      x: rect.left + rect.width / 2, // center of selection
      y: rect.top,
      preferAbove: true,
    });
  }

  // ─── Long-press on editor (touch: paste menu or copy/cut menu after selection) ─

  _onEditorLongPressDown(e) {
    if (e.pointerType !== "touch") return;
    this._longPressStart = { x: e.clientX, y: e.clientY };
    this._longPressPointerType = e.pointerType;
    this._longPressTimer = setTimeout(() => {
      this._longPressTimer = null;
      // Long press fired — show paste menu now; selection bar will show on pointerup if text gets selected
      const startPos = this._longPressStart;
      this._longPressStart = null;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        // Text was selected by the long press — show copy/cut bar
        const range = sel.getRangeAt(0);
        this._showSelectionBar(range);
      } else if (AppClipboard.canPasteInMode("text")) {
        this._showBar([{ label: t("canvas.textSelection.paste"), action: () => this._paste() }], {
          x: startPos?.x ?? e.clientX,
          y: startPos?.y ?? e.clientY,
          preferAbove: false,
        });
      }
    }, 500);
  }

  _onEditorLongPressMove(e) {
    if (!this._longPressStart) return;
    const dist = Math.hypot(e.clientX - this._longPressStart.x, e.clientY - this._longPressStart.y);
    if (dist > 10) this._cancelLongPress();
  }

  _onEditorLongPressUp(e) {
    const wasLongPress = !this._longPressTimer; // timer already fired = long press happened
    this._cancelLongPress();

    // On touch pointerup (not cancel) after a long-press that created a selection, show the bar.
    // This handles drag-extending the selection after long-press word selection.
    if (e?.type === "pointerup" && e.pointerType === "touch" && wasLongPress) {
      const sel = window.getSelection();
      const hasSelection =
        sel &&
        !sel.isCollapsed &&
        sel.rangeCount > 0 &&
        this._editor.contains(sel.getRangeAt(0).commonAncestorContainer);
      if (hasSelection && !this._bar) {
        const range = sel.getRangeAt(0);
        this._showSelectionBar(range);
      }
    }
  }

  _cancelLongPress() {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    this._longPressStart = null;
    this._longPressPointerType = null;
  }

  // ─── Right-click on editor ─────────────────────────────────────────────────

  _onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation(); // Prevent main.js global preventDefault from firing

    // Touch contextmenu events are handled by the long-press handler above.
    // On touch, the browser fires contextmenu as part of the long-press text selection flow,
    // but we manage the bar ourselves via _onEditorLongPressDown to control timing.
    if (e.pointerType === "touch") return;

    const sel = window.getSelection();
    const hasSelection =
      sel &&
      !sel.isCollapsed &&
      sel.rangeCount > 0 &&
      this._editor.contains(sel.getRangeAt(0).commonAncestorContainer);

    if (hasSelection) {
      const range = sel.getRangeAt(0);
      this._showSelectionBar(range);
    } else if (AppClipboard.canPasteInMode("text")) {
      this._showBar([{ label: t("canvas.textSelection.paste"), action: () => this._paste() }], {
        x: e.clientX,
        y: e.clientY,
        preferAbove: false,
      });
    }
  }

  // ─── Clipboard actions ─────────────────────────────────────────────────────

  _copy() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);
    // Get HTML of selection
    const fragment = range.cloneContents();
    const div = document.createElement("div");
    div.appendChild(fragment);
    const html = div.innerHTML;
    const plain = div.textContent || "";

    AppClipboard.copy("text", html);
    // System clipboard (plain text)
    navigator.clipboard.writeText(plain).catch(() => {});

    this._hide();
  }

  _cut() {
    this._copy();
    document.execCommand("delete");
    this._hide();
  }

  _paste() {
    this._editor.focus();

    // Try system clipboard first, fall back to in-app clipboard
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) {
          document.execCommand("insertText", false, text);
        } else {
          this._pasteFromAppClipboard();
        }
      })
      .catch(() => {
        this._pasteFromAppClipboard();
      });

    this._hide();
  }

  _pasteFromAppClipboard() {
    const item = AppClipboard.paste();
    if (!item || item.type !== "text") return;
    // Strip HTML to plain text for safe insertion
    const div = document.createElement("div");
    div.innerHTML = item.data;
    document.execCommand("insertText", false, div.textContent || "");
  }

  // ─── Bar DOM management ────────────────────────────────────────────────────

  /**
   * @param {Array<{label:string, action:()=>void}>} buttons
   * @param {{x:number, y:number, preferAbove:boolean}} pos - screen coordinates
   */
  _showBar(buttons, pos) {
    this._hide(); // Remove any existing bar first

    const bar = document.createElement("div");
    bar.className = "selection-floating-bar";

    for (const btn of buttons) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "selection-floating-bar__btn";
      b.textContent = btn.label;
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        btn.action();
      });
      bar.appendChild(b);
    }

    this._viewport.appendChild(bar);
    this._bar = bar;

    // Dismiss on outside tap / click
    this._onDocPointerDown = (e) => {
      if (!this._bar?.contains(e.target)) this._hide();
    };
    // Use setTimeout(0) so the current pointerdown that triggered _showBar doesn't immediately dismiss it
    setTimeout(() => {
      document.addEventListener("pointerdown", this._onDocPointerDown, { capture: true });
    }, 0);

    // Dismiss when selection is cleared
    this._onSelectionChangeHide = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) this._hide();
    };
    document.addEventListener("selectionchange", this._onSelectionChangeHide);

    // Position after paint so we know the bar's dimensions
    requestAnimationFrame(() => {
      if (!this._bar) return;
      const barRect = bar.getBoundingClientRect();
      const vpRect = this._viewport.getBoundingClientRect();

      let left = pos.x - vpRect.left - barRect.width / 2;
      let top;

      if (pos.preferAbove) {
        top = pos.y - vpRect.top - barRect.height - 8;
        if (top < 4) top = pos.y - vpRect.top + 8; // Flip below if no room
      } else {
        top = pos.y - vpRect.top + 8;
      }

      // Clamp horizontally
      left = Math.max(4, Math.min(left, vpRect.width - barRect.width - 4));

      bar.style.left = `${left}px`;
      bar.style.top = `${top}px`;
    });
  }

  _hide() {
    if (this._bar) {
      this._bar.remove();
      this._bar = null;
    }
    if (this._onDocPointerDown) {
      document.removeEventListener("pointerdown", this._onDocPointerDown, { capture: true });
      this._onDocPointerDown = null;
    }
    if (this._onSelectionChangeHide) {
      document.removeEventListener("selectionchange", this._onSelectionChangeHide);
      this._onSelectionChangeHide = null;
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  destroy() {
    this._cancelLongPress();
    this._hide();
    this._editor.removeEventListener("contextmenu", this._onContextMenu);
    this._editor.removeEventListener("pointerdown", this._onEditorLongPressDown);
    this._editor.removeEventListener("pointermove", this._onEditorLongPressMove);
    this._editor.removeEventListener("pointerup", this._onEditorLongPressUp);
    this._editor.removeEventListener("pointercancel", this._onEditorLongPressUp);
  }
}
