/**
 * TextBox - one text box of the text layer (text boxes DESIGN §4.1)
 *
 * Owns the box's element, its geometry and its stored HTML string. While it is
 * not the active box its text is static HTML; TextLayer mounts the one editor
 * on the active box (it replaces `contentEl` with the editor's element) and
 * puts static HTML back when the box is left.
 *
 * The implicit main box (`implicit: true`) is the unwrapped text written before
 * boxes existed: in normal flow at the top of the layer, full width, with the
 * single editor's padding, and no geometry until its first move or resize
 * wraps it into an ordinary box.
 */

import { renderMergeHints } from "./mergeHints.js";

const MEDIA_SELECTOR = "img, table, hr, video, audio, iframe, .task-text";

/**
 * Whether box HTML holds nothing worth keeping: no text and nothing that is
 * content without text (an image, a table, a task).
 * @param {string} html
 */
export function isEmptyBoxHtml(html) {
  if (!html) return true;
  // Cheap path: a character outside tags that is not space (or an entity) is content
  if (/>[^<\s &]|^[^<\s &]/.test(html)) return false;
  const probe = document.createElement("div");
  probe.innerHTML = html;
  return probe.textContent.replace(/ /g, " ").trim() === "" && !probe.querySelector(MEDIA_SELECTOR);
}

export class TextBox {
  /**
   * @param {object} model
   * @param {string|null} model.id - null for the implicit main box
   * @param {number} [model.x]
   * @param {number|null} [model.y]
   * @param {number} [model.w]
   * @param {string} model.html - stored inner HTML (sanitized)
   * @param {boolean} [model.implicit] - the implicit main box
   */
  constructor({ id, x = 0, y = 0, w = 0, html, implicit = false }) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.w = w;
    this.html = html ?? "";
    this.implicit = implicit;
    /** Measured height in content px (fed by the layer's ResizeObserver). */
    this.height = 0;

    this.el = document.createElement("div");
    this.el.className = implicit ? "text-box text-box--main" : "text-box";
    if (id) this.el.dataset.boxId = id;
    this.contentEl = TextBox.createContentElement();
    this.el.appendChild(this.contentEl);
    this.applyGeometry();
    this.renderStatic();
  }

  /** The element box text lives in, static or (once the editor is mounted) editable. */
  static createContentElement() {
    const el = document.createElement("div");
    el.className = "text-box__content";
    return el;
  }

  /** Position and width from the model; the implicit main box stays in flow. */
  applyGeometry() {
    const style = this.el.style;
    if (this.implicit) {
      style.left = "";
      style.top = "";
      style.width = "";
      return;
    }
    style.left = `${this.x}px`;
    style.top = `${this.y ?? 0}px`;
    style.width = `${this.w}px`;
  }

  /** @param {{x: number, y: number, w: number}} geometry */
  setGeometry({ x, y, w }) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.applyGeometry();
  }

  /** Turn the implicit main box into an ordinary box (its first move or resize). */
  wrap(id, geometry) {
    this.id = id;
    this.implicit = false;
    this.el.dataset.boxId = id;
    this.el.classList.remove("text-box--main");
    this.setGeometry(geometry);
  }

  /** Show the stored HTML as static text. */
  renderStatic() {
    this.contentEl.innerHTML = this.html;
    renderMergeHints(this.contentEl);
  }

  /** Swap the element the text lives in (the editor mounts on a fresh one). */
  replaceContentElement(el) {
    if (this.contentEl.parentNode === this.el) this.el.replaceChild(el, this.contentEl);
    else this.el.insertBefore(el, this.el.firstChild);
    this.contentEl = el;
  }

  /** Bottom edge in content px (top + measured height). */
  get bottom() {
    return (this.implicit ? 0 : (this.y ?? 0)) + this.height;
  }

  destroy() {
    this.el.remove();
  }
}
