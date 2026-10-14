/**
 * src/utils/imageUtils.test.js
 * Covers the resize/compress/format logic (aspect-ratio math, binary-search
 * quality search, size thresholds). Camera-capture / file-picker DOM flows
 * are excluded — they're thin wiring around getUserMedia/file inputs with no
 * meaningful logic of their own.
 *
 * jsdom doesn't implement real image decoding or canvas rasterization, so
 * `Image` and `HTMLCanvasElement` are stubbed to report controllable
 * width/height/toDataURL output while preserving the module's real control
 * flow (resize thresholds, binary search loop, etc).
 */

import PerspT from "perspective-transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real implementation, wrapped so a test can force a transform failure
vi.mock("perspective-transform", async (importOriginal) => {
  const actual = await importOriginal();
  return { default: vi.fn(actual.default) };
});

// Translation keys stand in for text, so tests can assert which string was used
vi.mock("../i18n/index.js", () => ({ t: (key) => key }));

let mockCropperOptions = null;
let mockCropperResolve = null;

vi.mock("../components/NoteCanvas/ImageCropper.js", () => ({
  ImageCropper: class MockImageCropper {
    show(_img, options) {
      mockCropperOptions = options;
      return new Promise((resolve) => {
        mockCropperResolve = resolve;
      });
    }
  },
}));

import {
  attachCaptureHandler,
  captureFromCamera,
  compressImage,
  fileToDataUrl,
  formatFileSize,
  getCameraUnavailableReason,
  hasTransparency,
  isCameraAvailable,
  normalizeDocumentLighting,
  optimizeImageForDisplay,
  processImageFile,
  resizeImage,
  startLiveDocumentDetection,
  syncOverlayToVideo,
  warpPerspective,
} from "./imageUtils.js";

function stubImage(width, height) {
  class FakeImage {
    set src(_value) {
      this.width = width;
      this.height = height;
      // Simulate async decode like a real <img>.
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
}

function stubCanvas({ toDataURLImpl, getImageDataImpl } = {}) {
  const drawImage = vi.fn();
  const ctx = {
    drawImage,
    imageSmoothingQuality: null,
    getImageData: getImageDataImpl ? vi.fn(getImageDataImpl) : undefined,
  };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx);
  HTMLCanvasElement.prototype.toDataURL = vi.fn(function (type, quality) {
    if (toDataURLImpl) return toDataURLImpl(type, quality, this.width, this.height);
    return `data:${type};base64,AAAA`;
  });

  return {
    ctx,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    },
  };
}

describe("fileToDataUrl", () => {
  it("resolves with the FileReader result", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const result = await fileToDataUrl(file);
    expect(result).toMatch(/^data:text\/plain;base64,/);
  });
});

describe("formatFileSize", () => {
  it("formats sizes under 1024KB as whole KB", () => {
    expect(formatFileSize(500)).toBe("500 KB");
    expect(formatFileSize(1023.6)).toBe("1024 KB");
  });

  it("formats sizes at or above 1024KB as MB with one decimal", () => {
    expect(formatFileSize(1024)).toBe("1.0 MB");
    expect(formatFileSize(2560)).toBe("2.5 MB");
  });
});

describe("resizeImage", () => {
  let canvas;
  afterEach(() => {
    canvas?.restore();
    vi.unstubAllGlobals();
  });

  it("returns the original data URL unchanged when within max dimensions", async () => {
    stubImage(800, 600);
    canvas = stubCanvas();
    const result = await resizeImage("data:image/png;base64,orig", 3072);
    expect(result).toBe("data:image/png;base64,orig");
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });

  it("scales down a landscape image, preserving aspect ratio", async () => {
    stubImage(4000, 2000);
    let sizedCanvas;
    canvas = stubCanvas({
      toDataURLImpl: (_type, _q, w, h) => {
        sizedCanvas = { w, h };
        return "data:image/png;base64,resized";
      },
    });

    const result = await resizeImage("data:image/png;base64,orig", 2000);

    expect(result).toBe("data:image/png;base64,resized");
    expect(sizedCanvas).toEqual({ w: 2000, h: 1000 });
  });

  it("scales down a portrait image, preserving aspect ratio", async () => {
    stubImage(2000, 4000);
    let sizedCanvas;
    canvas = stubCanvas({
      toDataURLImpl: (_type, _q, w, h) => {
        sizedCanvas = { w, h };
        return "data:image/png;base64,resized";
      },
    });

    await resizeImage("data:image/png;base64,orig", 2000);
    expect(sizedCanvas).toEqual({ w: 1000, h: 2000 });
  });

  it("treats a square image at exactly max dimension as not needing resize", async () => {
    stubImage(3072, 3072);
    canvas = stubCanvas();
    const result = await resizeImage("data:image/png;base64,orig", 3072);
    expect(result).toBe("data:image/png;base64,orig");
  });
});

describe("compressImage", () => {
  let canvas;
  afterEach(() => {
    canvas?.restore();
    vi.unstubAllGlobals();
  });

  it("binary-searches quality to land under the target size", async () => {
    stubImage(1000, 1000);
    // Bigger `quality` -> bigger fake output size, roughly linear.
    canvas = stubCanvas({
      toDataURLImpl: (_type, quality) => {
        const bytes = Math.round(quality * 2_000_000);
        return `data:image/jpeg;base64,${"A".repeat(bytes)}`;
      },
    });

    const targetKB = 500;
    const result = await compressImage("data:image/png;base64,orig", targetKB);

    const sizeKB = (result.length * 0.75) / 1024;
    expect(sizeKB).toBeLessThanOrEqual(targetKB * 1.05); // small tolerance for the loop's granularity
  });

  it("falls back to the original data URL if even min quality exceeds target", async () => {
    stubImage(1000, 1000);
    canvas = stubCanvas({
      toDataURLImpl: () => `data:image/jpeg;base64,${"A".repeat(5_000_000)}`, // always huge
    });

    const result = await compressImage("data:image/png;base64,orig", 10);
    expect(result).toBe("data:image/png;base64,orig");
  });

  it("stops within a bounded number of iterations", async () => {
    stubImage(1000, 1000);
    let calls = 0;
    canvas = stubCanvas({
      toDataURLImpl: (_type, quality) => {
        calls++;
        return `data:image/jpeg;base64,${"A".repeat(Math.round(quality * 1_000_000))}`;
      },
    });

    await compressImage("data:image/png;base64,orig", 500);
    expect(calls).toBeLessThanOrEqual(8);
  });

  it("preserves PNG format and skips JPEG compression when image has transparency", async () => {
    stubImage(100, 100);
    canvas = stubCanvas({
      getImageDataImpl: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }), // transparent pixel
      toDataURLImpl: (type) => `data:${type};base64,transparent-png`,
    });

    const result = await compressImage("data:image/png;base64,orig", 500);
    expect(result).toBe("data:image/png;base64,transparent-png");
  });
});

describe("optimizeImageForDisplay", () => {
  let canvas;
  afterEach(() => {
    canvas?.restore();
    vi.unstubAllGlobals();
  });

  it("returns the image unchanged when already close to 2x display size", async () => {
    stubImage(200, 100);
    canvas = stubCanvas();
    const result = await optimizeImageForDisplay("data:image/png;base64,orig", 100, 50);
    expect(result).toEqual({ dataUrl: "data:image/png;base64,orig", width: 200, height: 100 });
    expect(HTMLCanvasElement.prototype.getContext).not.toHaveBeenCalled();
  });

  it("downsamples when the image is significantly larger than 2x display size", async () => {
    stubImage(4000, 2000);
    canvas = stubCanvas({ toDataURLImpl: () => "data:image/jpeg;base64,optimized" });

    const result = await optimizeImageForDisplay("data:image/png;base64,orig", 100, 50);

    expect(result).toEqual({
      dataUrl: "data:image/jpeg;base64,optimized",
      width: 200,
      height: 100,
    });
  });
});

describe("attachCaptureHandler", () => {
  /**
   * Build the parts of a camera modal the handler touches: the loading spinner
   * and controls container that showLoadingState toggles, plus a video with
   * controllable dimensions standing in for a live stream.
   */
  function buildModal({ videoWidth = 1920, videoHeight = 1080 } = {}) {
    const modal = document.createElement("div");

    const loading = document.createElement("div");
    loading.className = "camera-loading";
    loading.style.display = "none";

    const controls = document.createElement("div");
    controls.className = "camera-controls";

    const video = document.createElement("video");
    Object.defineProperty(video, "videoWidth", { value: videoWidth });
    Object.defineProperty(video, "videoHeight", { value: videoHeight });

    const captureBtn = document.createElement("button");
    captureBtn.className = "capture-btn";

    controls.appendChild(captureBtn);
    modal.append(loading, video, controls);
    return { modal, video, captureBtn, loading, controls };
  }

  const waitFor = async (assertion, timeout = 1000) => {
    const start = Date.now();
    while (true) {
      try {
        return assertion();
      } catch (err) {
        if (Date.now() - start > timeout) throw err;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };

  /**
   * jsdom has no canvas encoder and never loads images, so stand in for the
   * frame-capture pipeline: getContext/drawImage, toBlob (the encoded frame),
   * object URLs, and an Image whose load/error fires like a real decode.
   */
  function stubFrameCapture({ encodeFails = false, loadFails = false } = {}) {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback) =>
      callback(encodeFails ? null : new Blob(["frame"], { type: "image/jpeg" })),
    );
    const createObjectURL = vi.fn(() => "blob:frame");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    class FakeImage extends EventTarget {
      set src(value) {
        this._src = value;
        this.naturalWidth = loadFails ? 0 : 1920;
        this.naturalHeight = loadFails ? 0 : 1080;
        queueMicrotask(() => this.dispatchEvent(new Event(loadFails ? "error" : "load")));
      }
      get src() {
        return this._src;
      }
    }
    vi.stubGlobal("Image", FakeImage);

    return {
      revokeObjectURL,
      restore: () => {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        HTMLCanvasElement.prototype.toBlob = originalToBlob;
      },
    };
  }

  let frame;
  beforeEach(() => {
    mockCropperOptions = null;
    mockCropperResolve = null;
    frame = stubFrameCapture();
  });

  afterEach(() => {
    frame.restore();
    vi.unstubAllGlobals();
  });

  it("captures the frame, passes it to ImageCropper, and hands back a JPEG file when crop is applied", async () => {
    const { modal, video, captureBtn } = buildModal();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();

    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    mockCropperResolve(new Blob(["cropped-data"], { type: "image/jpeg" }));

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    const file = onCapture.mock.calls[0][0];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/jpeg");
    expect(file.name).toMatch(/^camera-/);
  });

  it("shows the spinner and disables the button while capture is preparing", () => {
    const { modal, video, captureBtn, loading, controls } = buildModal();

    attachCaptureHandler(modal, video, captureBtn, vi.fn());
    captureBtn.click();

    // While capture is in flight: the user must see progress and be unable to tap again.
    expect(captureBtn.disabled).toBe(true);
    expect(loading.style.display).toBe("flex");
    expect(controls.style.pointerEvents).toBe("none");
  });

  it("ignores repeat clicks while a capture is still in flight", async () => {
    const { modal, video, captureBtn } = buildModal();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();
    captureBtn.click();
    captureBtn.click();

    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    mockCropperResolve(new Blob(["x"], { type: "image/jpeg" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
  });

  it("ignores clicks before the first frame has arrived", () => {
    const { modal, video, captureBtn } = buildModal({ videoWidth: 0, videoHeight: 0 });
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();

    expect(onCapture).not.toHaveBeenCalled();
    // The button stays usable so the user can capture once the preview is live.
    expect(captureBtn.disabled).toBe(false);
  });

  it("re-enables capture when user retakes (cancels crop), restoring the camera viewfinder", async () => {
    const { modal, video, captureBtn, loading } = buildModal();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();

    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    mockCropperResolve(null); // User clicked retake / cancelled

    await waitFor(() => expect(captureBtn.disabled).toBe(false));
    expect(onCapture).not.toHaveBeenCalled();
    expect(loading.style.display).toBe("none");
    expect(modal.style.display).toBe("");

    // And a retry actually works.
    mockCropperResolve = null;
    captureBtn.click();
    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    mockCropperResolve(new Blob(["x"], { type: "image/jpeg" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
  });

  it("opens document mode in perspective crop, with the live viewfinder corners as detection fallback", async () => {
    const { modal, video, captureBtn } = buildModal();
    modal.dataset.cameraMode = "document";
    modal.dataset.flattenLighting = "true";
    modal._detectedCorners = {
      tl: { x: 10, y: 10 },
      tr: { x: 90, y: 10 },
      br: { x: 90, y: 90 },
      bl: { x: 10, y: 90 },
    };

    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();

    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    expect(mockCropperOptions.initialMode).toBe("perspective");
    // Live corners are only a fallback — the cropper re-detects on the captured
    // frame first, since the camera may have moved since the last live frame.
    expect(mockCropperOptions.fallbackCorners).toEqual(modal._detectedCorners);
    expect(mockCropperOptions.normalizeLighting).toBe(true);
    expect(mockCropperOptions.cancelLabel).toBe("canvas.camera.retake");

    mockCropperResolve(new Blob(["doc"], { type: "image/jpeg" }));
    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));

    const file = onCapture.mock.calls[0][0];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toMatch(/^document-/);
  });

  it("does not pass live corners in photo mode", async () => {
    const { modal, video, captureBtn } = buildModal();
    modal._detectedCorners = { tl: { x: 1, y: 1 } };

    attachCaptureHandler(modal, video, captureBtn, vi.fn());
    captureBtn.click();

    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    expect(mockCropperOptions.initialMode).toBe("simple");
    expect(mockCropperOptions.fallbackCorners).toBeNull();
  });

  it("names the file after the cropped blob's actual type", async () => {
    const { modal, video, captureBtn } = buildModal();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();

    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    mockCropperResolve(new Blob(["png"], { type: "image/png" }));

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(1));
    const file = onCapture.mock.calls[0][0];
    expect(file.type).toBe("image/png");
    expect(file.name).toMatch(/\.png$/);
  });

  it("releases the frame's object URL once the cropper closes", async () => {
    const { modal, video, captureBtn } = buildModal();

    attachCaptureHandler(modal, video, captureBtn, vi.fn());
    captureBtn.click();

    await waitFor(() => expect(mockCropperResolve).toBeTruthy());
    expect(frame.revokeObjectURL).not.toHaveBeenCalled();
    mockCropperResolve(null);

    await waitFor(() => expect(frame.revokeObjectURL).toHaveBeenCalledWith("blob:frame"));
  });

  it.each([
    ["encoding the frame fails", { encodeFails: true }],
    ["the encoded frame cannot be decoded", { loadFails: true }],
  ])("stays on the viewfinder and re-enables capture when %s", async (_label, opts) => {
    frame.restore();
    frame = stubFrameCapture(opts);
    const { modal, video, captureBtn, loading } = buildModal();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();

    await waitFor(() => expect(captureBtn.disabled).toBe(false));
    expect(mockCropperResolve).toBeNull();
    expect(onCapture).not.toHaveBeenCalled();
    expect(modal.style.display).toBe("");
    expect(loading.style.display).toBe("none");
  });
});

// Camera availability. The bug this covers: on an origin the browser considers
// insecure (a Nextcloud instance served over plain HTTP), navigator.mediaDevices
// is undefined outright — not permission-gated. Every failure used to collapse
// into `null`, which the caller could not tell apart from "user cancelled", so
// tapping "Take Photo" did nothing at all: no prompt, no preview, no error.
describe("camera availability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubMediaDevices(value) {
    vi.stubGlobal("navigator", { mediaDevices: value });
  }

  it("reports unavailable when the browser exposes no mediaDevices", () => {
    stubMediaDevices(undefined);
    expect(isCameraAvailable()).toBe(false);
  });

  it("reports available when getUserMedia exists", () => {
    stubMediaDevices({ getUserMedia: () => {} });
    expect(isCameraAvailable()).toBe(true);
    expect(getCameraUnavailableReason()).toBeNull();
  });

  it("blames the insecure origin when the context is not secure", () => {
    stubMediaDevices(undefined);
    vi.stubGlobal("window", { isSecureContext: false });
    expect(getCameraUnavailableReason()).toMatchObject({ reason: "insecure-context" });
  });

  it("blames the browser when the context is secure but the API is missing", () => {
    stubMediaDevices(undefined);
    vi.stubGlobal("window", { isSecureContext: true });
    expect(getCameraUnavailableReason()).toMatchObject({ reason: "unsupported" });
  });

  // The core regression: an unavailable camera must raise, never resolve null.
  // Resolving null is reserved for a genuine user cancellation, and the caller
  // relies on that distinction to decide whether to show an error.
  it("throws rather than resolving null when the camera is unavailable", async () => {
    stubMediaDevices(undefined);
    vi.stubGlobal("window", { isSecureContext: false });

    await expect(captureFromCamera()).rejects.toMatchObject({ reason: "insecure-context" });
  });

  it("maps a denied permission onto a permission-denied reason", async () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    stubMediaDevices({
      getUserMedia: vi.fn().mockRejectedValue(denied),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    });
    vi.stubGlobal("window", { isSecureContext: true });

    await expect(captureFromCamera()).rejects.toMatchObject({ reason: "permission-denied" });
  });

  it("maps a missing camera onto a no-camera reason", async () => {
    const missing = new Error("none");
    missing.name = "NotFoundError";
    stubMediaDevices({
      getUserMedia: vi.fn().mockRejectedValue(missing),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    });
    vi.stubGlobal("window", { isSecureContext: true });

    await expect(captureFromCamera()).rejects.toMatchObject({ reason: "no-camera" });
  });
});

describe("hasTransparency", () => {
  it("returns false for null or non-positive dimension canvas", () => {
    expect(hasTransparency(null)).toBe(false);
    expect(hasTransparency({ width: 0, height: 100 })).toBe(false);
    expect(hasTransparency({ width: 100, height: 0 })).toBe(false);
    expect(hasTransparency({ width: -10, height: 50 })).toBe(false);
  });

  it("returns false when context or getImageData is not available", () => {
    expect(hasTransparency({ width: 10, height: 10, getContext: () => null })).toBe(false);
    expect(hasTransparency({ width: 10, height: 10, getContext: () => ({}) })).toBe(false);
  });

  it("returns true when any pixel has alpha < 255", () => {
    const mockCanvas = {
      width: 2,
      height: 2,
      getContext: () => ({
        getImageData: () => ({
          data: new Uint8ClampedArray([
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            255,
            0,
            0,
            0,
            0, // fully transparent
          ]),
        }),
      }),
    };
    expect(hasTransparency(mockCanvas)).toBe(true);
  });

  it("returns true for semi-transparent pixels", () => {
    const mockCanvas = {
      width: 1,
      height: 1,
      getContext: () => ({
        getImageData: () => ({
          data: new Uint8ClampedArray([100, 150, 200, 254]),
        }),
      }),
    };
    expect(hasTransparency(mockCanvas)).toBe(true);
  });

  it("returns false when all pixels are fully opaque", () => {
    const mockCanvas = {
      width: 2,
      height: 2,
      getContext: () => ({
        getImageData: () => ({
          data: new Uint8ClampedArray([
            255, 255, 255, 255, 0, 0, 0, 255, 128, 128, 128, 255, 50, 50, 50, 255,
          ]),
        }),
      }),
    };
    expect(hasTransparency(mockCanvas)).toBe(false);
  });
});

describe("processImageFile", () => {
  let canvas;
  afterEach(() => {
    canvas?.restore();
    vi.unstubAllGlobals();
  });

  it("preserves PNG dataUrl for an image with transparency", async () => {
    stubImage(100, 100);
    canvas = stubCanvas({
      getImageDataImpl: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
      toDataURLImpl: (type) => `data:${type};base64,preserved`,
    });

    const file = new File(["test"], "icon.png", { type: "image/png" });
    const result = await processImageFile(file);

    expect(result.dataUrl).toBe("data:image/png;base64,preserved");
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });
});

describe("warpPerspective", () => {
  it("returns a canvas with dimensions computed from corner distances", () => {
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = 100;
    srcCanvas.height = 100;
    const corners = {
      tl: { x: 0, y: 0 },
      tr: { x: 50, y: 0 },
      br: { x: 50, y: 80 },
      bl: { x: 0, y: 80 },
    };
    const result = warpPerspective(srcCanvas, corners);
    expect(result).toBeInstanceOf(HTMLCanvasElement);
    expect(result.width).toBe(50);
    expect(result.height).toBe(80);
  });

  it("returns null for missing corners so the caller picks its own fallback", () => {
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = 100;
    srcCanvas.height = 80;
    expect(warpPerspective(srcCanvas, null)).toBeNull();
  });

  it("returns null when the corners do not define a valid transform", () => {
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = 100;
    srcCanvas.height = 80;
    PerspT.mockImplementationOnce(() => {
      throw new Error("singular matrix");
    });
    const corners = {
      tl: { x: 0, y: 0 },
      tr: { x: 0, y: 0 },
      br: { x: 0, y: 0 },
      bl: { x: 0, y: 0 },
    };
    expect(warpPerspective(srcCanvas, corners)).toBeNull();
  });
});

describe("normalizeDocumentLighting", () => {
  it("handles empty or zero-dimension canvas safely without error", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 0;
    canvas.height = 0;
    expect(() => normalizeDocumentLighting(canvas)).not.toThrow();
  });
});

describe("startLiveDocumentDetection", () => {
  it("initializes and allows setting enabled and stop", () => {
    const video = document.createElement("video");
    const overlay = document.createElement("canvas");
    const statusPill = document.createElement("div");
    const modal = document.createElement("div");

    const controller = startLiveDocumentDetection(video, overlay, statusPill, modal);
    expect(typeof controller.setEnabled).toBe("function");
    expect(typeof controller.stop).toBe("function");

    controller.setEnabled(true);
    expect(overlay.style.display).toBe("block");
    expect(statusPill.style.display).toBe("flex");

    controller.setEnabled(false);
    expect(overlay.style.display).toBe("none");
    expect(statusPill.style.display).toBe("none");

    controller.stop();
  });
});

describe("syncOverlayToVideo", () => {
  function mockElementRect(
    elem,
    { clientWidth = 0, clientHeight = 0, offsetLeft = 0, offsetTop = 0 } = {},
  ) {
    Object.defineProperty(elem, "clientWidth", { value: clientWidth, configurable: true });
    Object.defineProperty(elem, "clientHeight", { value: clientHeight, configurable: true });
    Object.defineProperty(elem, "offsetLeft", { value: offsetLeft, configurable: true });
    Object.defineProperty(elem, "offsetTop", { value: offsetTop, configurable: true });
  }

  function mockVideoDimensions(video, width, height) {
    Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
  }

  it("handles null or zero-dimension video safely", () => {
    const video = document.createElement("video");
    const overlay = document.createElement("canvas");

    expect(() => syncOverlayToVideo(null, overlay)).not.toThrow();
    expect(() => syncOverlayToVideo(video, null)).not.toThrow();

    mockVideoDimensions(video, 0, 0);
    mockElementRect(video, { clientWidth: 0, clientHeight: 0 });
    expect(() => syncOverlayToVideo(video, overlay)).not.toThrow();
  });

  it("aligns overlay precisely when video element is wider than stream (pillarbox)", () => {
    const video = document.createElement("video");
    const overlay = document.createElement("canvas");

    // 16:9 stream (1280x720) in a wide container (988x490, aspect ~2.016 > 1.778)
    mockVideoDimensions(video, 1280, 720);
    mockElementRect(video, { clientWidth: 988, clientHeight: 490, offsetLeft: 10, offsetTop: 5 });

    syncOverlayToVideo(video, overlay);

    expect(video.style.aspectRatio).toBe("1280 / 720");
    // renderH = 490, renderW = 490 * (1280/720) = 871.11 => 871px
    // offsetX = (988 - 871.11)/2 = 58.44 => 58px. Left = 10 + 58 = 68px.
    expect(overlay.style.width).toBe("871px");
    expect(overlay.style.height).toBe("490px");
    expect(overlay.style.left).toBe("68px");
    expect(overlay.style.top).toBe("5px");
    expect(overlay.width).toBe(1280);
    expect(overlay.height).toBe(720);
  });

  it("aligns overlay precisely when video element is taller than stream (letterbox)", () => {
    const video = document.createElement("video");
    const overlay = document.createElement("canvas");

    // 16:9 stream (1280x720) in a square/tall container (600x600, aspect 1.0 < 1.778)
    mockVideoDimensions(video, 1280, 720);
    mockElementRect(video, { clientWidth: 600, clientHeight: 600, offsetLeft: 0, offsetTop: 0 });

    syncOverlayToVideo(video, overlay);

    expect(video.style.aspectRatio).toBe("1280 / 720");
    // renderW = 600, renderH = 600 / (1280/720) = 337.5 => 338px
    // offsetY = (600 - 337.5)/2 = 131.25 => 131px. Top = 0 + 131 = 131px.
    expect(overlay.style.width).toBe("600px");
    expect(overlay.style.height).toBe("338px");
    expect(overlay.style.left).toBe("0px");
    expect(overlay.style.top).toBe("131px");
    expect(overlay.width).toBe(1280);
    expect(overlay.height).toBe(720);
  });
});
