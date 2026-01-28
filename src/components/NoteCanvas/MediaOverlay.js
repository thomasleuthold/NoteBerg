/**
 * MediaOverlay - Manages the floating UI for selected media items
 */
import { getIcon } from "../../utils/icons.js";

export class MediaOverlay {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks; // { onDelete: () => void }
    this.element = null;
    this.menu = null;
    this.optionBtn = null;
    this.activeMediaId = null;
    this.isVisible = false;

    this._onOptionClick = this._onOptionClick.bind(this);
    this._onDeleteClick = this._onDeleteClick.bind(this);
    this._handleDocumentClick = this._handleDocumentClick.bind(this);

    this._createDOM();
  }

  _createDOM() {
    console.log("[MediaOverlay] Creating DOM elements");
    this.element = document.createElement("div");
    this.element.className = "note-canvas__media-overlay";

    // Option Button (3 dots)
    this.optionBtn = document.createElement("div");
    this.optionBtn.className = "note-canvas__media-btn";
    this.optionBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;
    this.optionBtn.addEventListener("pointerdown", (e) => e.stopPropagation()); // Prevent canvas interaction
    this.optionBtn.addEventListener("click", this._onOptionClick);
    this.element.appendChild(this.optionBtn);

    // Menu (Hidden by default)
    this.menu = document.createElement("div");
    this.menu.className = "note-canvas-toolbar__options-dialog"; // Reuse toolbar styles
    this.menu.style.position = "absolute";
    this.menu.style.width = "150px";
    this.menu.style.pointerEvents = "auto";
    this.menu.innerHTML = `
      <div class="note-canvas-toolbar__options-content">
        <div class="note-canvas-toolbar__options-section">
          <button class="note-canvas-toolbar__delete-btn" id="media-delete-btn">
            ${getIcon("trash", 16)} Delete
          </button>
        </div>
      </div>
    `;
    // Prevent pointer events from bubbling to canvas (which would cancel the click)
    this.menu.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.menu.querySelector("#media-delete-btn").addEventListener("click", this._onDeleteClick);
    this.element.appendChild(this.menu);

    this.container.appendChild(this.element);
    document.addEventListener("pointerdown", this._handleDocumentClick);
  }

  show(mediaItem, zoom, scrollLeft, scrollTop, viewportRect) {
    this.activeMediaId = mediaItem.id;
    this.isVisible = true;
    this.element.classList.add("note-canvas__media-overlay--visible");
    this.updatePosition(mediaItem, zoom, scrollLeft, scrollTop, viewportRect);
  }

  hide() {
    this.activeMediaId = null;
    this.isVisible = false;
    this.element.classList.remove("note-canvas__media-overlay--visible");
    this.menu.classList.remove("note-canvas-toolbar__options-dialog--open");
  }

  updatePosition(mediaItem, zoom, scrollLeft, scrollTop, _viewportRect) {
    if (!this.isVisible) return;

    // Calculate screen position of the top-right corner of the image
    // Note: We use the unrotated bounding box corner for the button to keep it simple and accessible
    const screenX = mediaItem.x * zoom - scrollLeft;
    const screenY = mediaItem.y * zoom - scrollTop;
    const screenWidth = mediaItem.width * zoom;
    const screenHeight = mediaItem.height * zoom;

    // Position button at center of image
    const btnSize = 32;
    const btnLeft = screenX + screenWidth / 2 - btnSize / 2;
    const btnTop = screenY + screenHeight / 2 - btnSize / 2;

    // Position relative to viewport container
    this.optionBtn.style.left = `${btnLeft}px`;
    this.optionBtn.style.top = `${btnTop}px`;

    // Update menu position relative to button
    if (this.menu.classList.contains("note-canvas-toolbar__options-dialog--open")) {
      this._positionMenu(_viewportRect);
    }
  }

  _onOptionClick(e) {
    e.stopPropagation();
    this.menu.classList.toggle("note-canvas-toolbar__options-dialog--open");
    this._positionMenu();
  }

  _positionMenu(viewportRect) {
    if (!this.menu.classList.contains("note-canvas-toolbar__options-dialog--open")) return;

    const menuWidth = this.menu.offsetWidth || 150;
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

  _onDeleteClick(e) {
    console.log("[MediaOverlay] Delete button clicked for:", this.activeMediaId);
    e.stopPropagation();
    if (this.callbacks.onDelete) {
      this.callbacks.onDelete(this.activeMediaId);
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
