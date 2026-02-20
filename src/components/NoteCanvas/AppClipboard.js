/**
 * AppClipboard - In-app clipboard singleton
 *
 * Holds one item at a time across note navigations.
 * Also writes to the system clipboard when content is expressible as text or PNG.
 *
 * Supported types:
 *   "strokes" - array of stroke objects (deep-cloned, with original bounds)
 *   "text"    - HTML string from the text editor
 *   "image"   - media item descriptor { fileId, width, height, ... }
 */

class _AppClipboard {
  constructor() {
    /** @type {"strokes"|"text"|"image"|null} */
    this.type = null;
    /** @type {any} */
    this.data = null;
    /** @type {{minX:number,minY:number,maxX:number,maxY:number}|null} */
    this.bounds = null; // content-coordinate bounds for strokes
  }

  /**
   * Store an item in the in-app clipboard.
   * For text: also writes to system clipboard.
   * For strokes: caller is responsible for writing PNG to system clipboard separately
   *              (requires canvas rendering context).
   *
   * @param {"strokes"|"text"|"image"} type
   * @param {any} data
   * @param {{minX,minY,maxX,maxY}|null} [bounds] - Required for type "strokes"
   */
  copy(type, data, bounds = null) {
    this.type = type;
    this.data = data;
    this.bounds = bounds;

    if (type === "text") {
      const plain = this._htmlToPlain(data);
      navigator.clipboard.writeText(plain).catch(() => {
        // Clipboard write can fail if document is not focused — ignore silently
      });
    }
  }

  /**
   * Returns the stored item, or null if empty.
   * @returns {{type: string, data: any, bounds: any}|null}
   */
  paste() {
    if (!this.type) return null;
    return { type: this.type, data: this.data, bounds: this.bounds };
  }

  /** @returns {boolean} */
  isEmpty() {
    return this.type === null;
  }

  /**
   * Whether the current clipboard content can be pasted in the given canvas mode.
   * @param {"pan"|"draw"|"eraser"|"lasso"|"text"|string} mode
   * @returns {boolean}
   */
  canPasteInMode(mode) {
    if (this.isEmpty()) return false;
    if (mode === "text") {
      return this.type === "text" || this.type === "image";
    }
    // pan / draw / eraser / lasso — strokes and images can be pasted on canvas
    return this.type === "strokes" || this.type === "image";
  }

  /**
   * Strip HTML tags to get plain text for system clipboard.
   * @param {string} html
   * @returns {string}
   */
  _htmlToPlain(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    return div.textContent || div.innerText || "";
  }
}

export const AppClipboard = new _AppClipboard();
