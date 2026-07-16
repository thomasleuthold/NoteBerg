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
  compressImage,
  fileToDataUrl,
  formatFileSize,
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
