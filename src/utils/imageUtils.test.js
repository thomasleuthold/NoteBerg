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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachCaptureHandler,
  captureFromCamera,
  compressImage,
  fileToDataUrl,
  formatFileSize,
  getCameraUnavailableReason,
  isCameraAvailable,
  optimizeImageForDisplay,
  resizeImage,
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

function stubCanvas({ toDataURLImpl } = {}) {
  const drawImage = vi.fn();
  const ctx = { drawImage, imageSmoothingQuality: null };
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

  /**
   * jsdom's canvas has no encoder, so toBlob never calls back. Drive it manually
   * so a test controls exactly when encoding "finishes" — that window between
   * click and completion is what the guard protects.
   */
  function stubToBlob() {
    const original = HTMLCanvasElement.prototype.toBlob;
    const pending = [];
    HTMLCanvasElement.prototype.toBlob = vi.fn((callback) => pending.push(callback));
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() }));
    return {
      finish: (blob = new Blob(["x"], { type: "image/jpeg" })) => {
        for (const cb of pending.splice(0)) cb(blob);
      },
      pendingCount: () => pending.length,
      restore: () => {
        HTMLCanvasElement.prototype.toBlob = original;
        HTMLCanvasElement.prototype.getContext = originalGetContext;
      },
    };
  }

  let toBlob;
  afterEach(() => {
    toBlob?.restore();
    vi.unstubAllGlobals();
  });

  it("captures the frame and hands back a JPEG file", () => {
    const { modal, video, captureBtn } = buildModal();
    toBlob = stubToBlob();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();
    toBlob.finish();

    expect(onCapture).toHaveBeenCalledTimes(1);
    const file = onCapture.mock.calls[0][0];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/jpeg");
  });

  it("shows the spinner and disables the button while encoding", () => {
    const { modal, video, captureBtn, loading, controls } = buildModal();
    toBlob = stubToBlob();

    attachCaptureHandler(modal, video, captureBtn, vi.fn());
    captureBtn.click();

    // Still encoding: the user must see progress and be unable to tap again.
    expect(captureBtn.disabled).toBe(true);
    expect(loading.style.display).toBe("flex");
    expect(controls.style.pointerEvents).toBe("none");
  });

  it("ignores repeat clicks while a capture is still encoding", () => {
    const { modal, video, captureBtn } = buildModal();
    toBlob = stubToBlob();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();
    captureBtn.click();
    captureBtn.click();

    // One encode queued, not three — a second capture would resolve the flow
    // twice and tear down an already-removed modal.
    expect(toBlob.pendingCount()).toBe(1);
    toBlob.finish();
    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks before the first frame has arrived", () => {
    const { modal, video, captureBtn } = buildModal({ videoWidth: 0, videoHeight: 0 });
    toBlob = stubToBlob();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();

    // A 0x0 canvas encodes to null, and `new File([null], ...)` would throw.
    expect(toBlob.pendingCount()).toBe(0);
    expect(onCapture).not.toHaveBeenCalled();
    // The button stays usable so the user can capture once the preview is live.
    expect(captureBtn.disabled).toBe(false);
  });

  it("re-enables capture when encoding fails, so the user can retry", () => {
    const { modal, video, captureBtn, loading } = buildModal();
    toBlob = stubToBlob();
    const onCapture = vi.fn();

    attachCaptureHandler(modal, video, captureBtn, onCapture);
    captureBtn.click();
    toBlob.finish(null); // encoder produced nothing

    expect(onCapture).not.toHaveBeenCalled();
    expect(captureBtn.disabled).toBe(false);
    expect(loading.style.display).toBe("none");

    // And a retry actually works.
    captureBtn.click();
    toBlob.finish();
    expect(onCapture).toHaveBeenCalledTimes(1);
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
