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
    // Container is invisible but holds layout
    this.element.style.cssText = `
      display: flex;
      gap: 16px;
      padding: 10px 20px;
      width: 100%;
      background-color: var(--bg-primary);
      border-bottom: 1px solid var(--border-primary);
      align-items: center;
    `;

    const createBtn = (id, icon, title) => {
      const btn = document.createElement("button");
      btn.id = `nc-tool-${id}`;
      btn.title = title;
      btn.innerHTML = icon;
      btn.style.cssText = `
        width: 48px;
        height: 48px;
        border-radius: 50%;
        border: 1px solid var(--border-primary, #e2e8f0);
        background-color: var(--bg-primary, #ffffff);
        color: var(--text-secondary, #64748b);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        pointer-events: auto;
        outline: none;
      `;

      // Add hover effects via JS since we're using inline styles for encapsulation
      btn.addEventListener("mouseenter", () => {
        if (!btn.dataset.active) {
          btn.style.transform = "translateY(-2px)";
          btn.style.boxShadow =
            "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)";
        }
      });

      btn.addEventListener("mouseleave", () => {
        if (!btn.dataset.active) {
          btn.style.transform = "none";
          btn.style.boxShadow =
            "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)";
        }
      });

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
        btn.dataset.active = "true";
        btn.style.backgroundColor = "var(--color-primary, #3b82f6)";
        btn.style.color = "#ffffff";
        btn.style.borderColor = "var(--color-primary, #3b82f6)";
        btn.style.transform = "scale(1.1)";
        btn.style.boxShadow = "0 10px 15px -3px rgba(59, 130, 246, 0.4)";
      } else {
        delete btn.dataset.active;
        btn.style.backgroundColor = "var(--bg-primary, #ffffff)";
        btn.style.color = "var(--text-secondary, #64748b)";
        btn.style.borderColor = "var(--border-primary, #e2e8f0)";
        btn.style.transform = "none";
        btn.style.boxShadow =
          "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)";
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
