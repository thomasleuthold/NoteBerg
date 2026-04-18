/**
 * ImageCropper - Handles image cropping and perspective correction
 */

import { t } from "../../i18n/index.js";
import PerspT from "perspective-transform";

export class ImageCropper {
  constructor() {
    this.overlay = null;
    this.resolvePromise = null;
    this.rejectPromise = null;
    this.imageElement = null;
    this.originalImage = null;
  }

  /**
   * Show the cropper UI
   * @param {HTMLImageElement} image - The source image to crop
   * @returns {Promise<Blob|null>} - Resolves with the cropped image Blob, or null if cancelled
   */
  show(image) {
    this.originalImage = image;
    return new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
      this._createDOM();
    });
  }

  _createDOM() {
    // Create crop overlay
    this.overlay = document.createElement("div");
    this.overlay.id = "crop-overlay";
    this.overlay.className = "crop-overlay active";
    this.overlay.dataset.cropMode = "simple";

    // Create crop container
    const container = document.createElement("div");
    container.className = "crop-container";

    // Create mode toggle buttons
    const modeToggle = document.createElement("div");
    modeToggle.className = "crop-mode-toggle";

    const simpleModeBtn = document.createElement("button");
    simpleModeBtn.textContent = t("canvas.crop.simpleCrop");
    simpleModeBtn.className = "crop-mode-btn crop-mode-simple active";
    simpleModeBtn.onclick = () => this._switchCropMode("simple");

    const perspectiveModeBtn = document.createElement("button");
    perspectiveModeBtn.textContent = t("canvas.crop.perspective");
    perspectiveModeBtn.className = "crop-mode-btn crop-mode-perspective";
    perspectiveModeBtn.onclick = () => this._switchCropMode("perspective");

    modeToggle.appendChild(simpleModeBtn);
    modeToggle.appendChild(perspectiveModeBtn);

    // Create image element for cropping
    this.imageElement = document.createElement("img");
    this.imageElement.className = "crop-image";
    this.imageElement.src = this.originalImage.src;

    // Create crop area
    const cropArea = document.createElement("div");
    cropArea.className = "crop-area";
    cropArea.id = "crop-area";

    // Create crop handles
    const handles = ["nw", "ne", "sw", "se"];
    handles.forEach((pos) => {
      const handle = document.createElement("div");
      handle.className = `crop-handle crop-${pos}`;
      handle.dataset.position = pos;
      cropArea.appendChild(handle);
    });

    // Create perspective corners
    const perspectiveArea = document.createElement("div");
    perspectiveArea.className = "perspective-area";
    perspectiveArea.id = "perspective-area";
    perspectiveArea.style.display = "none";

    const corners = [
      { name: "tl", label: "TL" },
      { name: "tr", label: "TR" },
      { name: "br", label: "BR" },
      { name: "bl", label: "BL" },
    ];
    corners.forEach((corner) => {
      const cornerHandle = document.createElement("div");
      cornerHandle.className = `perspective-corner perspective-${corner.name}`;
      cornerHandle.dataset.corner = corner.name;
      cornerHandle.innerHTML = `<span class="corner-label">${corner.label}</span>`;
      perspectiveArea.appendChild(cornerHandle);
    });

    // Create crop controls
    const controls = document.createElement("div");
    controls.className = "crop-controls";

    const applyBtn = document.createElement("button");
    applyBtn.textContent = t("canvas.crop.apply");
    applyBtn.className = "crop-btn crop-apply-btn";
    applyBtn.onclick = () => this._applyCrop();

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = t("canvas.crop.cancel");
    cancelBtn.className = "crop-btn crop-cancel-btn";
    cancelBtn.onclick = () => this._close(null);

    controls.appendChild(cancelBtn);
    controls.appendChild(applyBtn);

    // Wrap image + overlays so absolute positioning is relative to the image
    const imageWrapper = document.createElement("div");
    imageWrapper.className = "crop-image-wrapper";
    imageWrapper.appendChild(this.imageElement);
    imageWrapper.appendChild(cropArea);
    imageWrapper.appendChild(perspectiveArea);

    // Assemble UI
    container.appendChild(modeToggle);
    container.appendChild(imageWrapper);
    container.appendChild(controls);
    this.overlay.appendChild(container);
    document.body.appendChild(this.overlay);

    // Initialize crop area after image loads
    this.imageElement.onload = () => {
      const imgRect = this.imageElement.getBoundingClientRect();
      const cropWidth = imgRect.width * 0.8;
      const cropHeight = imgRect.height * 0.8;
      const cropLeft = (imgRect.width - cropWidth) / 2;
      const cropTop = (imgRect.height - cropHeight) / 2;

      cropArea.style.left = `${cropLeft}px`;
      cropArea.style.top = `${cropTop}px`;
      cropArea.style.width = `${cropWidth}px`;
      cropArea.style.height = `${cropHeight}px`;

      this._initCropAreaDrag(cropArea, this.imageElement);
      // Perspective corners start at the full image edges (apply = no change)
      this._initPerspectiveCorners(perspectiveArea, this.imageElement);
    };
  }

  _close(result) {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    if (this.resolvePromise) {
      this.resolvePromise(result);
    }
  }

  _switchCropMode(mode) {
    const cropArea = this.overlay.querySelector("#crop-area");
    const perspectiveArea = this.overlay.querySelector("#perspective-area");
    const simpleModeBtn = this.overlay.querySelector(".crop-mode-simple");
    const perspectiveModeBtn = this.overlay.querySelector(".crop-mode-perspective");

    this.overlay.dataset.cropMode = mode;

    if (mode === "simple") {
      cropArea.style.display = "block";
      perspectiveArea.style.display = "none";
      simpleModeBtn.classList.add("active");
      perspectiveModeBtn.classList.remove("active");
    } else {
      cropArea.style.display = "none";
      perspectiveArea.style.display = "block";
      simpleModeBtn.classList.remove("active");
      perspectiveModeBtn.classList.add("active");
      // Draw lines now that the area is visible (offsetLeft/offsetTop need display != none)
      this._drawPerspectiveLines(perspectiveArea);
    }
  }

  async _applyCrop() {
    const mode = this.overlay.dataset.cropMode;
    const imgRect = this.imageElement.getBoundingClientRect();
    let blob = null;

    if (mode === "perspective") {
      blob = await this._applyPerspectiveCorrection(imgRect);
    } else {
      blob = await this._applySimpleCrop(imgRect);
    }

    this._close(blob);
  }

  async _applySimpleCrop(imgRect) {
    const cropArea = this.overlay.querySelector("#crop-area");
    const cropRect = cropArea.getBoundingClientRect();

    const scaleX = this.originalImage.naturalWidth / imgRect.width;
    const scaleY = this.originalImage.naturalHeight / imgRect.height;

    const cropX = (cropRect.left - imgRect.left) * scaleX;
    const cropY = (cropRect.top - imgRect.top) * scaleY;
    const cropWidth = cropRect.width * scaleX;
    const cropHeight = cropRect.height * scaleY;

    const canvas = document.createElement("canvas");
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    const ctx = canvas.getContext("2d");

    ctx.drawImage(
      this.originalImage,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      0,
      0,
      cropWidth,
      cropHeight,
    );

    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  }

  async _applyPerspectiveCorrection(imgRect) {
    const perspectiveArea = this.overlay.querySelector("#perspective-area");
    const corners = {};
    perspectiveArea.querySelectorAll(".perspective-corner").forEach((corner) => {
      corners[corner.dataset.corner] = {
        x: corner.offsetLeft,
        y: corner.offsetTop,
      };
    });

    const containerRect = perspectiveArea.getBoundingClientRect();
    const imgOffsetX = imgRect.left - containerRect.left;
    const imgOffsetY = imgRect.top - containerRect.top;

    const scaleX = this.originalImage.naturalWidth / imgRect.width;
    const scaleY = this.originalImage.naturalHeight / imgRect.height;

    const srcCorners = [
      (corners.tl.x - imgOffsetX) * scaleX,
      (corners.tl.y - imgOffsetY) * scaleY,
      (corners.tr.x - imgOffsetX) * scaleX,
      (corners.tr.y - imgOffsetY) * scaleY,
      (corners.br.x - imgOffsetX) * scaleX,
      (corners.br.y - imgOffsetY) * scaleY,
      (corners.bl.x - imgOffsetX) * scaleX,
      (corners.bl.y - imgOffsetY) * scaleY,
    ];

    // Calculate dimensions
    const topWidth = Math.sqrt(
      (srcCorners[2] - srcCorners[0]) ** 2 + (srcCorners[3] - srcCorners[1]) ** 2,
    );
    const bottomWidth = Math.sqrt(
      (srcCorners[4] - srcCorners[6]) ** 2 + (srcCorners[5] - srcCorners[7]) ** 2,
    );
    const leftHeight = Math.sqrt(
      (srcCorners[6] - srcCorners[0]) ** 2 + (srcCorners[7] - srcCorners[1]) ** 2,
    );
    const rightHeight = Math.sqrt(
      (srcCorners[4] - srcCorners[2]) ** 2 + (srcCorners[5] - srcCorners[3]) ** 2,
    );

    const outputWidth = Math.sqrt(topWidth * bottomWidth);
    const outputHeight = Math.sqrt(leftHeight * rightHeight);

    const dstCorners = [0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight];

    let perspT;
    try {
      perspT = PerspT(srcCorners, dstCorners);
    } catch (e) {
      console.error("[ImageCropper] Failed to create perspective transform:", e);
      return this._applySimpleCrop(imgRect); // Fallback to simple crop
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(outputWidth);
    canvas.height = Math.round(outputHeight);
    const ctx = canvas.getContext("2d");

    // Source data
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = this.originalImage.naturalWidth;
    srcCanvas.height = this.originalImage.naturalHeight;
    const srcCtx = srcCanvas.getContext("2d");
    srcCtx.drawImage(this.originalImage, 0, 0);
    const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height).data;

    const outputImageData = ctx.createImageData(canvas.width, canvas.height);
    const outputData = outputImageData.data;

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const srcPoint = perspT.transformInverse(x, y);
        const srcX = Math.round(srcPoint[0]);
        const srcY = Math.round(srcPoint[1]);

        if (srcX >= 0 && srcX < srcCanvas.width && srcY >= 0 && srcY < srcCanvas.height) {
          const srcIndex = (srcY * srcCanvas.width + srcX) * 4;
          const dstIndex = (y * canvas.width + x) * 4;
          outputData[dstIndex] = srcData[srcIndex];
          outputData[dstIndex + 1] = srcData[srcIndex + 1];
          outputData[dstIndex + 2] = srcData[srcIndex + 2];
          outputData[dstIndex + 3] = 255;
        }
      }
    }

    ctx.putImageData(outputImageData, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  }

  _initCropAreaDrag(cropArea, img) {
    let isDragging = false;
    let isResizing = false;
    let activePointerId = null;
    let resizeHandle = null;
    let startX = 0,
      startY = 0,
      startLeft = 0,
      startTop = 0,
      startWidth = 0,
      startHeight = 0;
    const imgRect = img.getBoundingClientRect();

    cropArea.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("crop-handle")) {
        isResizing = true;
        resizeHandle = e.target.dataset.position;
        startWidth = cropArea.offsetWidth;
        startHeight = cropArea.offsetHeight;
      } else {
        isDragging = true;
      }
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = cropArea.offsetLeft;
      startTop = cropArea.offsetTop;
      cropArea.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    cropArea.addEventListener("pointermove", (e) => {
      if ((!isDragging && !isResizing) || e.pointerId !== activePointerId) return;
      // Ignore stylus hover (no contact with screen)
      if (e.pressure === 0 && e.pointerType !== "mouse") return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (isDragging) {
        const newLeft = Math.max(0, Math.min(startLeft + dx, imgRect.width - cropArea.offsetWidth));
        const newTop = Math.max(0, Math.min(startTop + dy, imgRect.height - cropArea.offsetHeight));
        cropArea.style.left = `${newLeft}px`;
        cropArea.style.top = `${newTop}px`;
      } else if (isResizing) {
        let newWidth = startWidth;
        let newHeight = startHeight;
        let newLeft = startLeft;
        let newTop = startTop;

        if (resizeHandle.includes("e")) newWidth += dx;
        if (resizeHandle.includes("w")) {
          newWidth -= dx;
          newLeft += dx;
        }
        if (resizeHandle.includes("s")) newHeight += dy;
        if (resizeHandle.includes("n")) {
          newHeight -= dy;
          newTop += dy;
        }

        if (newWidth >= 50 && newHeight >= 50) {
          cropArea.style.width = `${newWidth}px`;
          cropArea.style.height = `${newHeight}px`;
          cropArea.style.left = `${newLeft}px`;
          cropArea.style.top = `${newTop}px`;
        }
      }
    });

    const endDrag = (e) => {
      if (e.pointerId !== activePointerId) return;
      isDragging = false;
      isResizing = false;
      activePointerId = null;
      try {
        cropArea.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* already released */
      }
    };
    cropArea.addEventListener("pointerup", endDrag);
    cropArea.addEventListener("pointercancel", endDrag);
  }

  _initPerspectiveCorners(perspectiveArea, img) {
    const imgRect = img.getBoundingClientRect();

    // Place corners exactly at the image edges so apply = no change.
    // The perspective area is inside crop-image-wrapper which matches the image size,
    // so coordinates are directly relative to the image.
    const corners = {
      tl: { x: 0, y: 0 },
      tr: { x: imgRect.width, y: 0 },
      br: { x: imgRect.width, y: imgRect.height },
      bl: { x: 0, y: imgRect.height },
    };

    Object.entries(corners).forEach(([name, pos]) => {
      const handle = perspectiveArea.querySelector(`.perspective-${name}`);
      handle.style.left = `${pos.x}px`;
      handle.style.top = `${pos.y}px`;
      this._makeDraggable(handle, perspectiveArea);
    });
  }

  _makeDraggable(element, container) {
    let isDragging = false;
    let activePointerId = null;
    let startX = 0,
      startY = 0,
      startLeft = 0,
      startTop = 0;

    element.addEventListener("pointerdown", (e) => {
      isDragging = true;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = element.offsetLeft;
      startTop = element.offsetTop;
      element.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    element.addEventListener("pointermove", (e) => {
      if (!isDragging || e.pointerId !== activePointerId) return;
      // Ignore stylus hover (no contact with screen)
      if (e.pressure === 0 && e.pointerType !== "mouse") return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      element.style.left = `${startLeft + dx}px`;
      element.style.top = `${startTop + dy}px`;
      this._drawPerspectiveLines(container);
    });

    const endDrag = (e) => {
      if (e.pointerId !== activePointerId) return;
      isDragging = false;
      activePointerId = null;
      try {
        element.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* already released */
      }
    };
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
  }

  _drawPerspectiveLines(container) {
    container.querySelectorAll(".perspective-line").forEach((l) => {
      l.remove();
    });
    const corners = {};
    container.querySelectorAll(".perspective-corner").forEach((c) => {
      corners[c.dataset.corner] = { x: c.offsetLeft, y: c.offsetTop };
    });

    const lines = [
      ["tl", "tr"],
      ["tr", "br"],
      ["br", "bl"],
      ["bl", "tl"],
    ];
    lines.forEach(([p1, p2]) => {
      const c1 = corners[p1];
      const c2 = corners[p2];
      const line = document.createElement("div");
      line.className = "perspective-line";
      const length = Math.sqrt((c2.x - c1.x) ** 2 + (c2.y - c1.y) ** 2);
      const angle = (Math.atan2(c2.y - c1.y, c2.x - c1.x) * 180) / Math.PI;
      line.style.width = `${length}px`;
      line.style.left = `${c1.x}px`;
      line.style.top = `${c1.y}px`;
      line.style.transform = `rotate(${angle}deg)`;
      container.appendChild(line);
    });
  }
}
