/**
 * SelectionOverlay - Manages the floating UI for selected strokes
 *
 * Shows a 3-dot option button at the top-right of the selection bounds
 * with a dropdown menu offering "Mark as Task" and "Delete" actions.
 * Modeled after MediaOverlay.js.
 */
import { getIcon } from "../../utils/icons.js";

export class SelectionOverlay {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks; // { onMarkAsTask, onDelete, onRemoveTask }
    this.element = null;
    this.menu = null;
    this.optionBtn = null;
    this.isVisible = false;

    this._onOptionClick = this._onOptionClick.bind(this);
    this._onMarkAsTaskClick = this._onMarkAsTaskClick.bind(this);
    this._onRemoveTaskClick = this._onRemoveTaskClick.bind(this);
    this._onDeleteClick = this._onDeleteClick.bind(this);
    this._handleDocumentClick = this._handleDocumentClick.bind(this);

    this._createDOM();
  }

  _createDOM() {
    this.element = document.createElement("div");
    this.element.className = "note-canvas__selection-overlay";

    // Option Button (3 dots)
    this.optionBtn = document.createElement("div");
    this.optionBtn.className = "note-canvas__media-btn";
    this.optionBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
    this.optionBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.optionBtn.addEventListener("click", this._onOptionClick);
    this.element.appendChild(this.optionBtn);

    // Menu (Hidden by default)
    this.menu = document.createElement("div");
    this.menu.className = "note-canvas-toolbar__options-dialog";
    this.menu.style.position = "absolute";
    this.menu.style.width = "180px";
    this.menu.style.pointerEvents = "auto";
    this.menu.innerHTML = `
      <div class="note-canvas-toolbar__options-content">
        <div class="note-canvas-toolbar__options-section">
          <button class="note-canvas-toolbar__option-btn" id="selection-task-btn">
            ${getIcon("checkSquare", 16)} Mark as Task
          </button>
          <button class="note-canvas-toolbar__option-btn" id="selection-remove-task-btn" style="display:none">
            ${getIcon("square", 16)} Remove Task
          </button>
        </div>
        <div class="note-canvas-toolbar__separator"></div>
        <div class="note-canvas-toolbar__options-section">
          <button class="note-canvas-toolbar__delete-btn" id="selection-delete-btn">
            ${getIcon("trash", 16)} Delete
          </button>
        </div>
      </div>
    `;
    this.menu.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.menu
      .querySelector("#selection-task-btn")
      .addEventListener("click", this._onMarkAsTaskClick);
    this.menu
      .querySelector("#selection-remove-task-btn")
      .addEventListener("click", this._onRemoveTaskClick);
    this.menu.querySelector("#selection-delete-btn").addEventListener("click", this._onDeleteClick);
    this.element.appendChild(this.menu);

    this.container.appendChild(this.element);
    document.addEventListener("pointerdown", this._handleDocumentClick);
  }

  setTaskMode(isTask) {
    const taskBtn = this.menu.querySelector("#selection-task-btn");
    const removeTaskBtn = this.menu.querySelector("#selection-remove-task-btn");
    if (isTask) {
      taskBtn.style.display = "none";
      removeTaskBtn.style.display = "flex";
    } else {
      taskBtn.style.display = "flex";
      removeTaskBtn.style.display = "none";
    }
  }

  show(bounds, zoom, scrollLeft, scrollTop, viewportRect, offsetX = 0) {
    this.isVisible = true;
    this._bounds = bounds;
    this.element.classList.add("note-canvas__selection-overlay--visible");
    this.updatePosition(bounds, zoom, scrollLeft, scrollTop, viewportRect, offsetX);
  }

  hide() {
    this.isVisible = false;
    this._bounds = null;
    this.element.classList.remove("note-canvas__selection-overlay--visible");
    this.menu.classList.remove("note-canvas-toolbar__options-dialog--open");
  }

  updatePosition(bounds, zoom, scrollLeft, scrollTop, viewportRect, offsetX = 0) {
    if (!this.isVisible || !bounds) return;

    // Convert selection bounds top-right to screen coordinates
    const screenX = bounds.maxX * zoom - scrollLeft + offsetX;
    const screenY = bounds.minY * zoom - scrollTop;

    // Position button inside the bounds, 10px from right, 10px from top
    const btnSize = 32;
    const btnLeft = screenX - btnSize - 10;
    const btnTop = screenY + 10;

    this.optionBtn.style.left = `${btnLeft}px`;
    this.optionBtn.style.top = `${btnTop}px`;

    // Update menu position if open
    if (this.menu.classList.contains("note-canvas-toolbar__options-dialog--open")) {
      this._positionMenu(viewportRect);
    }
  }

  _onOptionClick(e) {
    e.stopPropagation();
    this.menu.classList.toggle("note-canvas-toolbar__options-dialog--open");
    this._positionMenu();
  }

  _positionMenu(viewportRect) {
    if (!this.menu.classList.contains("note-canvas-toolbar__options-dialog--open")) return;

    const menuWidth = this.menu.offsetWidth || 180;
    const btnRect = this.optionBtn.getBoundingClientRect();
    const containerRect = viewportRect || this.container.getBoundingClientRect();

    // Default: to the right. If off-screen, move to the left.
    let menuLeft = btnRect.right - containerRect.left + 5;
    if (menuLeft + menuWidth > containerRect.width) {
      menuLeft = btnRect.left - containerRect.left - menuWidth - 5;
    }

    this.menu.style.left = `${menuLeft}px`;
    this.menu.style.top = `${btnRect.top - containerRect.top}px`;
  }

  _onMarkAsTaskClick(e) {
    e.stopPropagation();
    if (this.callbacks.onMarkAsTask) {
      this.callbacks.onMarkAsTask();
    }
    this.hide();
  }

  _onRemoveTaskClick(e) {
    e.stopPropagation();
    if (this.callbacks.onRemoveTask) {
      this.callbacks.onRemoveTask();
    }
    this.hide();
  }

  _onDeleteClick(e) {
    e.stopPropagation();
    if (this.callbacks.onDelete) {
      this.callbacks.onDelete();
    }
    this.hide();
  }

  _handleDocumentClick(e) {
    if (
      this.menu.classList.contains("note-canvas-toolbar__options-dialog--open") &&
      !this.menu.contains(e.target) &&
      !this.optionBtn.contains(e.target)
    ) {
      this.menu.classList.remove("note-canvas-toolbar__options-dialog--open");
    }
  }

  destroy() {
    document.removeEventListener("pointerdown", this._handleDocumentClick);
    if (this.element?.parentNode) {
      this.element.parentNode.removeChild(this.element);
    }
  }
}
