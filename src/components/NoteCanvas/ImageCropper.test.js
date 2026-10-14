import { fireEvent } from "@testing-library/dom";
import * as PerspTModule from "perspective-transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectDocumentCorners } from "../../utils/documentDetector.js";
import { ImageCropper } from "./ImageCropper.js";

vi.mock("perspective-transform");
vi.mock("../../utils/documentDetector.js", () => ({
  detectDocumentCorners: vi.fn(),
}));

describe("ImageCropper", () => {
  let cropper;
  let mockImage;

  beforeEach(() => {
    cropper = new ImageCropper();
    mockImage = document.createElement("img");
    mockImage.src =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

    // Mock natural dimensions
    Object.defineProperty(mockImage, "naturalWidth", { value: 100 });
    Object.defineProperty(mockImage, "naturalHeight", { value: 100 });

    // Mock getBoundingClientRect on ALL <img> elements, not just mockImage:
    // ImageCropper.show() creates its own internal `this.imageElement` (a
    // fresh <img>, not mockImage) that the crop-area drag math measures
    // against — without this it reads 0x0 under jsdom and every drag clamps
    // to (0,0) regardless of the actual pointer movement.
    vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
    });

    // Mock pointer capture methods on HTMLElement prototype
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);

    detectDocumentCorners.mockResolvedValue(null);
  });

  afterEach(() => {
    // Cleanup DOM
    const overlay = document.getElementById("crop-overlay");
    if (overlay) {
      overlay.remove();
    }
    vi.restoreAllMocks();
  });

  it("initializes and shows overlay", async () => {
    const promise = cropper.show(mockImage);

    const overlay = document.getElementById("crop-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector(".crop-container")).toBeTruthy();
    expect(overlay.querySelector(".crop-image")).toBeTruthy();

    // Close to resolve promise
    cropper._close(null);
    await expect(promise).resolves.toBeNull();
  });

  it("switches modes", () => {
    cropper.show(mockImage);
    const overlay = document.getElementById("crop-overlay");

    // Default is simple
    expect(overlay.dataset.cropMode).toBe("simple");
    expect(overlay.querySelector("#crop-area").style.display).not.toBe("none");
    expect(overlay.querySelector("#perspective-area").style.display).toBe("none");

    // Switch to perspective
    cropper._switchCropMode("perspective");
    expect(overlay.dataset.cropMode).toBe("perspective");
    expect(overlay.querySelector("#perspective-area").style.display).toBe("block");
    expect(overlay.querySelector("#crop-area").style.display).toBe("none");
  });

  it("applies simple crop", async () => {
    const promise = cropper.show(mockImage);

    // Mock canvas creation and context
    const mockCtx = {
      drawImage: vi.fn(),
    };
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => mockCtx),
      toBlob: vi.fn((cb) => cb(new Blob(["cropped"], { type: "image/jpeg" }))),
    };
    const originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") return mockCanvas;
      return originalCreateElement.call(document, tag);
    });

    // Mock crop area rect
    const cropArea = document.getElementById("crop-area");
    vi.spyOn(cropArea, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 10,
      width: 50,
      height: 50,
    });

    // This internal method triggers the promise resolution
    cropper._applyCrop();

    const result = await promise;
    expect(result).toBeInstanceOf(Blob);
    expect(mockCtx.drawImage).toHaveBeenCalled();
  });

  it("applies perspective crop", async () => {
    // Mock PerspT module (imported directly, not via window)
    PerspTModule.default.mockReturnValue({
      transformInverse: vi.fn().mockReturnValue([0, 0]),
    });

    const promise = cropper.show(mockImage);
    cropper._switchCropMode("perspective");

    // Mock canvas context for perspective operation
    const mockCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(400) })),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(400) })),
      putImageData: vi.fn(),
    };

    // Mock createElement to return our mocked canvas
    const originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: vi.fn(() => mockCtx),
          toBlob: vi.fn((cb) => cb(new Blob(["cropped"], { type: "image/jpeg" }))),
        };
      }
      return originalCreateElement.call(document, tag);
    });

    // Trigger apply
    cropper._applyCrop();

    const result = await promise;
    expect(result).toBeInstanceOf(Blob);
    expect(PerspTModule.default).toHaveBeenCalled();
  });

  it("preserves PNG format when cropped image has transparency", async () => {
    const promise = cropper.show(mockImage);

    let passedMimeType = null;
    const mockCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([0, 0, 0, 0]),
      })),
    };
    const mockCanvas = {
      width: 50,
      height: 50,
      getContext: vi.fn(() => mockCtx),
      toBlob: vi.fn((cb, mimeType) => {
        passedMimeType = mimeType;
        cb(new Blob(["cropped"], { type: mimeType }));
      }),
    };
    const originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") return mockCanvas;
      return originalCreateElement.call(document, tag);
    });

    const cropArea = document.getElementById("crop-area");
    vi.spyOn(cropArea, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 10,
      width: 50,
      height: 50,
    });

    cropper._applyCrop();

    const result = await promise;
    expect(result).toBeInstanceOf(Blob);
    expect(passedMimeType).toBe("image/png");
    expect(result.type).toBe("image/png");
  });

  it("preserves PNG format and transparency when perspective cropping an image with transparency", async () => {
    PerspTModule.default.mockReturnValue({
      transformInverse: vi.fn().mockReturnValue([0, 0]),
    });

    const promise = cropper.show(mockImage);
    cropper._switchCropMode("perspective");

    let passedMimeType = null;
    let putImageDataArg = null;
    const mockCtx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        // source data: transparent pixels [0, 0, 0, 0]
        data: new Uint8ClampedArray(400),
      })),
      createImageData: vi.fn((w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })),
      putImageData: vi.fn((imgData) => {
        putImageDataArg = imgData;
      }),
    };
    const mockCanvas = {
      width: 50,
      height: 50,
      getContext: vi.fn(() => mockCtx),
      toBlob: vi.fn((cb, mimeType) => {
        passedMimeType = mimeType;
        cb(new Blob(["cropped"], { type: mimeType }));
      }),
    };
    const originalCreateElement = document.createElement;
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "canvas") return mockCanvas;
      return originalCreateElement.call(document, tag);
    });

    cropper._applyCrop();

    const result = await promise;
    expect(result).toBeInstanceOf(Blob);
    expect(passedMimeType).toBe("image/png");
    expect(result.type).toBe("image/png");
    // Verify that the outputImageData did NOT have its alpha hardcoded to 255 for transparent source pixels
    expect(putImageDataArg).toBeTruthy();
    expect(putImageDataArg.data[3]).toBe(0);
  });

  it("handles crop area dragging", () => {
    cropper.show(mockImage);

    // Manually trigger onload to initialize crop area
    const img = document.querySelector(".crop-image");
    fireEvent.load(img);

    const cropArea = document.getElementById("crop-area");

    // Simulate drag start (mouse, so the move handler's pen-hover guard
    // `pressure === 0 && pointerType !== "mouse"` doesn't short-circuit it)
    fireEvent.pointerDown(cropArea, {
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "mouse",
    });

    // Simulate drag move
    fireEvent.pointerMove(cropArea, {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    // dx = clientX(20) - startX(10) = 10; dy = 10. jsdom doesn't compute layout,
    // so offsetLeft/offsetTop/offsetWidth all read as 0 regardless of the inline
    // style set on init, making startLeft/startTop 0 and the clamp upper bound
    // imgRect.width (100). newLeft/newTop = max(0, min(0+10, 100)) = 10.
    expect(cropArea.style.left).toBe("10px");
    expect(cropArea.style.top).toBe("10px");

    fireEvent.pointerUp(document, { pointerId: 1 });
  });

  it("initializes crop area to full image dimensions on load", () => {
    cropper.show(mockImage);

    const img = document.querySelector(".crop-image");
    fireEvent.load(img);

    const cropArea = document.getElementById("crop-area");
    expect(cropArea.style.left).toBe("0px");
    expect(cropArea.style.top).toBe("0px");
    expect(cropArea.style.width).toBe("100px");
    expect(cropArea.style.height).toBe("100px");
  });

  it("positions perspective corners to detected document bounds when entering perspective mode", async () => {
    detectDocumentCorners.mockResolvedValue({
      tl: { x: 10, y: 15 },
      tr: { x: 85, y: 12 },
      br: { x: 90, y: 92 },
      bl: { x: 8, y: 88 },
    });

    cropper.show(mockImage);
    const img = document.querySelector(".crop-image");
    fireEvent.load(img);

    await cropper._switchCropMode("perspective");

    const perspectiveArea = document.getElementById("perspective-area");
    const tl = perspectiveArea.querySelector(".perspective-tl");
    const tr = perspectiveArea.querySelector(".perspective-tr");
    const br = perspectiveArea.querySelector(".perspective-br");
    const bl = perspectiveArea.querySelector(".perspective-bl");

    expect(tl.style.left).toBe("10px");
    expect(tl.style.top).toBe("15px");
    expect(tr.style.left).toBe("85px");
    expect(tr.style.top).toBe("12px");
    expect(br.style.left).toBe("90px");
    expect(br.style.top).toBe("92px");
    expect(bl.style.left).toBe("8px");
    expect(bl.style.top).toBe("88px");
  });

  it("displays .is-detecting spinner while corner detection is in flight and removes it when done", async () => {
    let resolveDetection;
    const detectionPromise = new Promise((resolve) => {
      resolveDetection = resolve;
    });
    detectDocumentCorners.mockReturnValue(detectionPromise);

    cropper.show(mockImage);
    const perspectiveBtn = document.querySelector(".crop-mode-perspective");
    expect(perspectiveBtn.classList.contains("is-detecting")).toBe(true);

    resolveDetection({
      tl: { x: 5, y: 5 },
      tr: { x: 95, y: 5 },
      br: { x: 95, y: 95 },
      bl: { x: 5, y: 95 },
    });
    await detectionPromise;
    // Allow microtasks for finally() handler
    await new Promise((r) => setTimeout(r, 0));

    expect(perspectiveBtn.classList.contains("is-detecting")).toBe(false);
  });

  it("falls back to full image bounds when document detection finds no document", async () => {
    detectDocumentCorners.mockResolvedValue(null);

    cropper.show(mockImage);
    const img = document.querySelector(".crop-image");
    fireEvent.load(img);

    await cropper._switchCropMode("perspective");

    const perspectiveArea = document.getElementById("perspective-area");
    const tl = perspectiveArea.querySelector(".perspective-tl");
    const br = perspectiveArea.querySelector(".perspective-br");

    expect(tl.style.left).toBe("0px");
    expect(tl.style.top).toBe("0px");
    expect(br.style.left).toBe("100px");
    expect(br.style.top).toBe("100px");
  });

  it("does not overwrite manual corner drag adjustments if user moves a handle", async () => {
    let resolveDetection;
    const detectionPromise = new Promise((resolve) => {
      resolveDetection = resolve;
    });
    detectDocumentCorners.mockReturnValue(detectionPromise);

    cropper.show(mockImage);
    const img = document.querySelector(".crop-image");
    fireEvent.load(img);

    const perspectiveArea = document.getElementById("perspective-area");
    const tl = perspectiveArea.querySelector(".perspective-tl");

    // User starts dragging before detection resolves
    fireEvent.pointerDown(tl, {
      clientX: 25,
      clientY: 25,
      pointerId: 1,
      pointerType: "mouse",
    });

    resolveDetection({
      tl: { x: 10, y: 15 },
      tr: { x: 85, y: 12 },
      br: { x: 90, y: 92 },
      bl: { x: 8, y: 88 },
    });
    await detectionPromise;
    await new Promise((r) => setTimeout(r, 0));

    // The user's interaction should prevent auto-placement from overriding
    expect(cropper._hasUserMovedCorner).toBe(true);
    expect(tl.style.left).not.toBe("10px");
  });

  describe("show() options", () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const cornerPos = (name) => {
      const handle = document.querySelector(`#perspective-area .perspective-${name}`);
      return [handle.style.left, handle.style.top];
    };

    it("opens in perspective mode with lighting normalization and a custom cancel label", () => {
      cropper.show(mockImage, {
        initialMode: "perspective",
        normalizeLighting: true,
        cancelLabel: "Retake",
      });

      expect(document.getElementById("crop-overlay").dataset.cropMode).toBe("perspective");
      expect(document.querySelector(".crop-mode-perspective").classList).toContain("active");
      expect(document.querySelector(".crop-mode-simple").classList).not.toContain("active");
      expect(document.getElementById("crop-area").style.display).toBe("none");
      expect(document.getElementById("perspective-area").style.display).toBe("block");
      expect(document.getElementById("crop-normalize-checkbox").checked).toBe(true);
      expect(document.querySelector(".crop-cancel-btn").textContent).toBe("Retake");
    });

    it("uses fallbackCorners when detection on the image finds no document", async () => {
      detectDocumentCorners.mockResolvedValue(null);

      cropper.show(mockImage, {
        initialMode: "perspective",
        fallbackCorners: {
          tl: { x: 20, y: 22 },
          tr: { x: 80, y: 21 },
          br: { x: 82, y: 78 },
          bl: { x: 18, y: 80 },
        },
      });
      fireEvent.load(document.querySelector(".crop-image"));
      await flush();

      expect(cornerPos("tl")).toEqual(["20px", "22px"]);
      expect(cornerPos("br")).toEqual(["82px", "78px"]);
    });

    it("uses fallbackCorners when detection throws", async () => {
      detectDocumentCorners.mockRejectedValue(new Error("canvas unavailable"));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      cropper.show(mockImage, {
        initialMode: "perspective",
        fallbackCorners: {
          tl: { x: 20, y: 22 },
          tr: { x: 80, y: 21 },
          br: { x: 82, y: 78 },
          bl: { x: 18, y: 80 },
        },
      });
      fireEvent.load(document.querySelector(".crop-image"));
      await flush();

      expect(cornerPos("tl")).toEqual(["20px", "22px"]);
    });

    it("prefers corners detected on the image over fallbackCorners", async () => {
      detectDocumentCorners.mockResolvedValue({
        tl: { x: 10, y: 15 },
        tr: { x: 85, y: 12 },
        br: { x: 90, y: 92 },
        bl: { x: 8, y: 88 },
      });

      cropper.show(mockImage, {
        initialMode: "perspective",
        fallbackCorners: {
          tl: { x: 20, y: 22 },
          tr: { x: 80, y: 21 },
          br: { x: 82, y: 78 },
          bl: { x: 18, y: 80 },
        },
      });
      fireEvent.load(document.querySelector(".crop-image"));
      await flush();

      expect(cornerPos("tl")).toEqual(["10px", "15px"]);
    });

    it("still positions detected corners when detection finishes before the image is laid out", async () => {
      detectDocumentCorners.mockResolvedValue({
        tl: { x: 10, y: 15 },
        tr: { x: 85, y: 12 },
        br: { x: 90, y: 92 },
        bl: { x: 8, y: 88 },
      });
      // Not laid out yet: the crop image has no size when detection resolves.
      const rect = vi.mocked(HTMLImageElement.prototype.getBoundingClientRect);
      rect.mockReturnValue({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });

      cropper.show(mockImage, { initialMode: "perspective" });
      await flush();

      rect.mockReturnValue({
        width: 100,
        height: 100,
        top: 0,
        left: 0,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
      });
      fireEvent.load(document.querySelector(".crop-image"));

      expect(cornerPos("tl")).toEqual(["10px", "15px"]);
      expect(cornerPos("br")).toEqual(["90px", "92px"]);
    });
  });
});
