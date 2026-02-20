/**
 * ContextFloatingMenu - A small floating action menu
 *
 * Shows a list of action buttons at a given screen position.
 * Auto-dismisses when the user taps/clicks outside.
 *
 * Usage:
 *   const menu = new ContextFloatingMenu(container, [
 *     { label: 'Paste', icon: clipboardSvg, action: () => { ... } },
 *   ], { x: clientX, y: clientY });
 *   // Later:
 *   menu.destroy();
 */
export class ContextFloatingMenu {
  /**
   * @param {HTMLElement} container - The element to append the menu to (position: relative or absolute parent)
   * @param {Array<{label: string, icon?: string, action: () => void}>} items
   * @param {{x: number, y: number}} screenPos - clientX/clientY position
   */
  constructor(container, items, screenPos) {
    this.container = container;
    this._onDocPointerDown = this._onDocPointerDown.bind(this);

    this._build(items, screenPos);
  }

  _build(items, screenPos) {
    this.element = document.createElement("div");
    this.element.className = "context-floating-menu";
    this.element.addEventListener("pointerdown", (e) => e.stopPropagation());

    for (const item of items) {
      const btn = document.createElement("button");
      btn.className = "context-floating-menu__btn";
      btn.type = "button";
      if (item.icon) {
        const iconSpan = document.createElement("span");
        iconSpan.innerHTML = item.icon;
        iconSpan.className = "context-floating-menu__icon";
        btn.appendChild(iconSpan);
      }
      const labelSpan = document.createElement("span");
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.destroy();
        item.action();
      });
      this.element.appendChild(btn);
    }

    this.container.appendChild(this.element);
    this._position(screenPos);

    // Dismiss on outside pointer
    setTimeout(() => {
      document.addEventListener("pointerdown", this._onDocPointerDown, { capture: true });
    }, 0);
  }

  _position({ x, y }) {
    const containerRect = this.container.getBoundingClientRect();
    let left = x - containerRect.left;
    let top = y - containerRect.top;

    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;

    // After paint: adjust if the menu goes off-screen
    requestAnimationFrame(() => {
      if (!this.element) return;
      const menuRect = this.element.getBoundingClientRect();
      const vw = containerRect.right;
      const vh = containerRect.bottom;

      if (menuRect.right > vw) {
        left -= menuRect.right - vw + 8;
        this.element.style.left = `${left}px`;
      }
      if (menuRect.bottom > vh) {
        top -= menuRect.bottom - vh + 8;
        this.element.style.top = `${top}px`;
      }
    });
  }

  _onDocPointerDown(e) {
    if (!this.element?.contains(e.target)) {
      this.destroy();
    }
  }

  destroy() {
    document.removeEventListener("pointerdown", this._onDocPointerDown, { capture: true });
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
    this.element = null;
  }
}
