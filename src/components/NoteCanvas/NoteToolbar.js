/**
 * NoteToolbar - Floating toolbar for NoteCanvas
 * Manages Pan vs Draw mode switching
 */

export class NoteToolbar {
  /**
   * @param {HTMLElement} container - Container to append toolbar to
   * @param {Function} onModeChange - Callback (isDrawMode) => void
   */
  constructor(container, onModeChange) {
    this.container = container;
    this.onModeChange = onModeChange;
    this.element = null;
    this.panBtn = null;
    this.drawBtn = null;

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

    // Icons (slightly larger for standalone buttons)
    const panIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M6 11v3.6a6 6 0 0 0 6 6h2"/><path d="M18 11a4 4 0 0 1 4 4v3a4 4 0 0 1-4 4h-2"/></svg>`;
    const penIcon = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>`;

    this.panBtn = createBtn("pan", panIcon, "Pan Mode");
    this.panBtn.onclick = () => this.onModeChange(false);

    this.drawBtn = createBtn("draw", penIcon, "Draw Mode");
    this.drawBtn.onclick = () => this.onModeChange(true);

    this.element.appendChild(this.panBtn);
    this.element.appendChild(this.drawBtn);
    this.container.appendChild(this.element);
  }

  updateMode(isDrawMode) {
    const setActive = (btn, active) => {
      if (active) {
        btn.classList.add("note-canvas-toolbar__button--active");
      } else {
        btn.classList.remove("note-canvas-toolbar__button--active");
      }
    };

    setActive(this.panBtn, !isDrawMode);
    setActive(this.drawBtn, isDrawMode);
  }

  destroy() {
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
    this.panBtn = null;
    this.drawBtn = null;
  }
}
