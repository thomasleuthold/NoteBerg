import { fireEvent } from "@testing-library/dom";
import * as PerspTModule from "perspective-transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageCropper } from "./ImageCropper.js";

vi.mock("perspective-transform");

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
});
