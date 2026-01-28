/**
 * MediaOverlay - Manages the floating UI for selected media items
 */
import { getIcon } from "../../utils/icons.js";

export class MediaOverlay {
  constructor(container, callbacks) {
    this.container = container;
    this.callbacks = callbacks; // { onDelete, onCrop, onToFront, onToBack }
    this.element = null;
    this.menu = null;
    this.optionBtn = null;
    this.activeMediaId = null;
    this.isVisible = false;

    this._onOptionClick = this._onOptionClick.bind(this);
    this._onDeleteClick = this._onDeleteClick.bind(this);
    this._onCropClick = this._onCropClick.bind(this);
    this._onToFrontClick = this._onToFrontClick.bind(this);
    this._onToBackClick = this._onToBackClick.bind(this);
    this._handleDocumentClick = this._handleDocumentClick.bind(this);

    this._createDOM();
  }

  _createDOM() {
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
          <button class="note-canvas-toolbar__option-btn" id="media-crop-btn">
            ${getIcon("crop", 16)} Crop
          </button>
          <button class="note-canvas-toolbar__option-btn" id="media-front-btn">
            ${getIcon("arrowUp", 16)} Send to Front
          </button>
          <button class="note-canvas-toolbar__option-btn" id="media-back-btn">
            ${getIcon("arrowDown", 16)} Send to Back
          </button>
        </div>
        <div class="note-canvas-toolbar__separator"></div>
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
    this.menu.querySelector("#media-crop-btn").addEventListener("click", this._onCropClick);
    this.menu.querySelector("#media-front-btn").addEventListener("click", this._onToFrontClick);
    this.menu.querySelector("#media-back-btn").addEventListener("click", this._onToBackClick);
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

  updatePosition(mediaItem, zoom, scrollLeft, scrollTop, viewportRect) {
    if (!this.isVisible) return;

    const rotation = (mediaItem.rotation || 0) * (Math.PI / 180);
    const width = mediaItem.width;
    const height = mediaItem.height;

    // Calculate corners relative to center
    const hw = width / 2;
    const hh = height / 2;

    const corners = [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ];

    // Rotate corners to find bounding box
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    let maxX = -Infinity;
    let minY = Infinity;

    corners.forEach((p) => {
      const rx = p.x * cos - p.y * sin;
      const ry = p.x * sin + p.y * cos;
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
    });

    // Center of image in content space
    const cx = mediaItem.x + hw;
    const cy = mediaItem.y + hh;

    // Visual top-right corner in content space
    const visualTopRightX = cx + maxX;
    const visualTopRightY = cy + minY;

    // Convert to screen space
    const screenX = visualTopRightX * zoom - scrollLeft;
    const screenY = visualTopRightY * zoom - scrollTop;

    // Position button
    const btnSize = 32;
    // Margin: 30px from right, 10px from top
    const btnLeft = screenX - btnSize - 30;
    const btnTop = screenY + 10;

    // Position relative to viewport container
    this.optionBtn.style.left = `${btnLeft}px`;
    this.optionBtn.style.top = `${btnTop}px`;

    // Update menu position relative to button
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
    e.stopPropagation();
    if (this.callbacks.onDelete) {
      this.callbacks.onDelete(this.activeMediaId);
    }
    this.hide();
  }

  _onCropClick(e) {
    e.stopPropagation();
    if (this.callbacks.onCrop) {
      this.callbacks.onCrop(this.activeMediaId);
    }
    this.hide();
  }

  _onToFrontClick(e) {
    e.stopPropagation();
    if (this.callbacks.onToFront) {
      this.callbacks.onToFront(this.activeMediaId);
    }
    this.menu.classList.remove("note-canvas-toolbar__options-dialog--open");
  }

  _onToBackClick(e) {
    e.stopPropagation();
    if (this.callbacks.onToBack) {
      this.callbacks.onToBack(this.activeMediaId);
    }
    this.menu.classList.remove("note-canvas-toolbar__options-dialog--open");
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
