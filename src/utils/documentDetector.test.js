import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectDocumentCorners } from "./documentDetector.js";

class MockContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = "#000000";
    this.buffer = new Uint8ClampedArray(canvas.width * canvas.height * 4);
    this.currentPath = [];
  }

  _parseColor(style) {
    if (typeof style === "string" && style.startsWith("rgb")) {
      const m = style.match(/\d+/g);
      if (m) return [parseInt(m[0], 10), parseInt(m[1], 10), parseInt(m[2], 10), 255];
    }
    return [0, 0, 0, 255];
  }

  fillRect(x, y, w, h) {
    const [r, g, b, a] = this._parseColor(this.fillStyle);
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const xEnd = Math.min(cw, x + w);
    const yEnd = Math.min(ch, y + h);

    for (let py = Math.max(0, y); py < yEnd; py++) {
      for (let px = Math.max(0, x); px < xEnd; px++) {
        const idx = (py * cw + px) * 4;
        this.buffer[idx] = r;
        this.buffer[idx + 1] = g;
        this.buffer[idx + 2] = b;
        this.buffer[idx + 3] = a;
      }
    }
  }

  beginPath() {
    this.currentPath = [];
  }

  moveTo(x, y) {
    this.currentPath.push({ x, y });
  }

  lineTo(x, y) {
    this.currentPath.push({ x, y });
  }

  closePath() {}

  fill() {
    if (this.currentPath.length < 3) return;
    const [r, g, b, a] = this._parseColor(this.fillStyle);
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const poly = this.currentPath;

    const pointInPoly = (px, py) => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    };

    let minX = cw,
      maxX = 0,
      minY = ch,
      maxY = 0;
    for (const p of poly) {
      if (p.x < minX) minX = Math.floor(p.x);
      if (p.x > maxX) maxX = Math.ceil(p.x);
      if (p.y < minY) minY = Math.floor(p.y);
      if (p.y > maxY) maxY = Math.ceil(p.y);
    }

    for (let py = Math.max(0, minY); py < Math.min(ch, maxY); py++) {
      for (let px = Math.max(0, minX); px < Math.min(cw, maxX); px++) {
        if (pointInPoly(px + 0.5, py + 0.5)) {
          const idx = (py * cw + px) * 4;
          this.buffer[idx] = r;
          this.buffer[idx + 1] = g;
          this.buffer[idx + 2] = b;
          this.buffer[idx + 3] = a;
        }
      }
    }
  }

  drawImage(src) {
    const srcCtx = src._mockCtx;
    if (srcCtx) {
      const srcW = src.width;
      const srcH = src.height;
      const dstW = this.canvas.width;
      const dstH = this.canvas.height;

      for (let dy = 0; dy < dstH; dy++) {
        const sy = Math.floor((dy * srcH) / dstH);
        for (let dx = 0; dx < dstW; dx++) {
          const sx = Math.floor((dx * srcW) / dstW);
          const srcIdx = (sy * srcW + sx) * 4;
          const dstIdx = (dy * dstW + dx) * 4;
          this.buffer[dstIdx] = srcCtx.buffer[srcIdx];
          this.buffer[dstIdx + 1] = srcCtx.buffer[srcIdx + 1];
          this.buffer[dstIdx + 2] = srcCtx.buffer[srcIdx + 2];
          this.buffer[dstIdx + 3] = srcCtx.buffer[srcIdx + 3];
        }
      }
    }
  }

  getImageData() {
    return { data: this.buffer };
  }
}

describe("documentDetector", () => {
  let originalGetContext;

  beforeEach(() => {
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      if (type === "2d") {
        if (!this._mockCtx || this._mockCtx.canvas !== this) {
          this._mockCtx = new MockContext2D(this);
        }
        return this._mockCtx;
      }
      return null;
    };
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
  });

  it("returns null for null, undefined, or empty inputs", async () => {
    expect(await detectDocumentCorners(null)).toBeNull();
    expect(await detectDocumentCorners(undefined)).toBeNull();
    expect(await detectDocumentCorners({ width: 0, height: 0 })).toBeNull();
    expect(await detectDocumentCorners({ naturalWidth: 10, naturalHeight: 10 })).toBeNull();
  });

  it("returns null for a broken image instead of waiting for a load that never comes", async () => {
    // A complete image with no width has already fired its error event; it
    // will never fire load or error again.
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 0 });

    await expect(detectDocumentCorners(img)).resolves.toBeNull();
  });

  it("waits for a loading image without replacing the caller's handlers", async () => {
    const img = document.createElement("img");
    let complete = false;
    Object.defineProperty(img, "complete", { get: () => complete });
    Object.defineProperty(img, "naturalWidth", { value: 0 });
    let callerOnloadCalls = 0;
    img.onload = () => {
      callerOnloadCalls++;
    };

    const result = detectDocumentCorners(img);
    complete = true;
    img.dispatchEvent(new Event("load"));

    await expect(result).resolves.toBeNull();
    expect(callerOnloadCalls).toBe(1);
  });

  it("returns null on a uniform blank image without edges", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 200;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgb(128, 128, 128)";
    ctx.fillRect(0, 0, 300, 200);

    const corners = await detectDocumentCorners(canvas);
    expect(corners).toBeNull();
  });

  it("detects a high-contrast rectangular document on a dark background", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");

    // Dark desk background
    ctx.fillStyle = "rgb(20, 20, 20)";
    ctx.fillRect(0, 0, 400, 300);

    // White paper document
    const docX = 60;
    const docY = 40;
    const docW = 280;
    const docH = 220;
    ctx.fillStyle = "rgb(240, 240, 240)";
    ctx.fillRect(docX, docY, docW, docH);

    const corners = await detectDocumentCorners(canvas);
    expect(corners).not.toBeNull();
    expect(corners).toHaveProperty("tl");
    expect(corners).toHaveProperty("tr");
    expect(corners).toHaveProperty("br");
    expect(corners).toHaveProperty("bl");

    // Proximity tolerance of within 10px
    expect(Math.abs(corners.tl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tl.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.tr.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tr.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.br.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.br.y - (docY + docH))).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.bl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.bl.y - (docY + docH))).toBeLessThanOrEqual(10);
  });

  it("detects a perspective-skewed quadrilateral document", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");

    // Dark background
    ctx.fillStyle = "rgb(15, 15, 15)";
    ctx.fillRect(0, 0, 400, 300);

    // Skewed document polygon
    const p1 = { x: 70, y: 50 };
    const p2 = { x: 330, y: 30 };
    const p3 = { x: 310, y: 260 };
    const p4 = { x: 50, y: 240 };

    ctx.fillStyle = "rgb(250, 250, 250)";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.lineTo(p4.x, p4.y);
    ctx.closePath();
    ctx.fill();

    const corners = await detectDocumentCorners(canvas);
    expect(corners).not.toBeNull();

    // Verify correct corner ordering
    expect(corners.tl.x).toBeLessThan(corners.tr.x);
    expect(corners.bl.x).toBeLessThan(corners.br.x);
    expect(corners.tl.y).toBeLessThan(corners.bl.y);
    expect(corners.tr.y).toBeLessThan(corners.br.y);

    // Coordinate proximity
    expect(Math.abs(corners.tl.x - p1.x)).toBeLessThanOrEqual(15);
    expect(Math.abs(corners.tl.y - p1.y)).toBeLessThanOrEqual(15);
    expect(Math.abs(corners.tr.x - p2.x)).toBeLessThanOrEqual(15);
    expect(Math.abs(corners.tr.y - p2.y)).toBeLessThanOrEqual(15);
    expect(Math.abs(corners.br.x - p3.x)).toBeLessThanOrEqual(15);
    expect(Math.abs(corners.br.y - p3.y)).toBeLessThanOrEqual(15);
    expect(Math.abs(corners.bl.x - p4.x)).toBeLessThanOrEqual(15);
    expect(Math.abs(corners.bl.y - p4.y)).toBeLessThanOrEqual(15);
  });

  it("returns null if the document area is too small (<15% of image)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "rgb(20, 20, 20)";
    ctx.fillRect(0, 0, 400, 300);

    // Tiny stamp / note (only 40x30 = 1200 px out of 120,000 = 1%)
    ctx.fillStyle = "rgb(240, 240, 240)";
    ctx.fillRect(100, 100, 40, 30);

    const corners = await detectDocumentCorners(canvas);
    expect(corners).toBeNull();
  });

  it("detects a document on a textured/patterned background (e.g. fabric / denim weave)", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");

    // Draw textured background with diagonal stripes and noise (like denim or fabric)
    for (let y = 0; y < 300; y += 4) {
      for (let x = 0; x < 400; x += 4) {
        const shade = 25 + ((x + y) % 16 < 8 ? 20 : 0);
        ctx.fillStyle = `rgb(${shade}, ${shade + 10}, ${shade + 15})`;
        ctx.fillRect(x, y, 4, 4);
      }
    }

    // Centered white document
    const docX = 80;
    const docY = 60;
    const docW = 240;
    const docH = 180;
    ctx.fillStyle = "rgb(230, 230, 220)";
    ctx.fillRect(docX, docY, docW, docH);

    // Simulate some dark text lines inside the document
    ctx.fillStyle = "rgb(30, 30, 30)";
    for (let ty = docY + 20; ty < docY + docH - 20; ty += 15) {
      ctx.fillRect(docX + 20, ty, docW - 40, 4);
    }

    const corners = await detectDocumentCorners(canvas);
    expect(corners).not.toBeNull();

    // Verify corners match the document, NOT the image frame!
    expect(Math.abs(corners.tl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tl.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.tr.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tr.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.br.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.br.y - (docY + docH))).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.bl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.bl.y - (docY + docH))).toBeLessThanOrEqual(10);
  });

  it("detects a document placed on a bright wooden / warm-colored floor without including the floor", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");

    // Bright oak wood floor background (warm golden-brown, high luminance ~145)
    ctx.fillStyle = "rgb(180, 140, 95)";
    ctx.fillRect(0, 0, 400, 300);

    // White paper document
    const docX = 70;
    const docY = 50;
    const docW = 260;
    const docH = 190;
    ctx.fillStyle = "rgb(240, 240, 240)";
    ctx.fillRect(docX, docY, docW, docH);

    // Add some text lines
    ctx.fillStyle = "rgb(20, 20, 20)";
    for (let ty = docY + 25; ty < docY + docH - 25; ty += 18) {
      ctx.fillRect(docX + 20, ty, docW - 40, 3);
    }

    const corners = await detectDocumentCorners(canvas);
    expect(corners).not.toBeNull();

    // Verify corners match the document, NOT the wooden floor!
    expect(Math.abs(corners.tl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tl.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.tr.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tr.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.br.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.br.y - (docY + docH))).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.bl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.bl.y - (docY + docH))).toBeLessThanOrEqual(10);
  });

  it("detects a low-contrast washed-out/brightened document on a light background", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");

    // Washed out, bright background (e.g. overexposed light oak floor, luma ~190)
    ctx.fillStyle = "rgb(198, 185, 170)";
    ctx.fillRect(0, 0, 400, 300);

    // Washed out white document (luma ~235)
    const docX = 80;
    const docY = 60;
    const docW = 240;
    const docH = 180;
    ctx.fillStyle = "rgb(238, 238, 235)";
    ctx.fillRect(docX, docY, docW, docH);

    // Light faded text lines
    ctx.fillStyle = "rgb(120, 120, 120)";
    for (let ty = docY + 25; ty < docY + docH - 25; ty += 18) {
      ctx.fillRect(docX + 20, ty, docW - 40, 3);
    }

    const corners = await detectDocumentCorners(canvas);
    expect(corners).not.toBeNull();

    expect(Math.abs(corners.tl.x - docX)).toBeLessThanOrEqual(12);
    expect(Math.abs(corners.tl.y - docY)).toBeLessThanOrEqual(12);

    expect(Math.abs(corners.tr.x - (docX + docW))).toBeLessThanOrEqual(12);
    expect(Math.abs(corners.tr.y - docY)).toBeLessThanOrEqual(12);

    expect(Math.abs(corners.br.x - (docX + docW))).toBeLessThanOrEqual(12);
    expect(Math.abs(corners.br.y - (docY + docH))).toBeLessThanOrEqual(12);

    expect(Math.abs(corners.bl.x - docX)).toBeLessThanOrEqual(12);
    expect(Math.abs(corners.bl.y - (docY + docH))).toBeLessThanOrEqual(12);
  });

  it("detects a document on high-contrast patterned tile floor without tile leakage", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");

    // Intricate tile floor pattern (checkerboard with dark and light decorative tiles)
    for (let ty = 0; ty < 300; ty += 25) {
      for (let tx = 0; tx < 400; tx += 25) {
        const isLight = (tx / 25 + ty / 25) % 2 === 0;
        ctx.fillStyle = isLight ? "rgb(120, 105, 90)" : "rgb(35, 35, 40)";
        ctx.fillRect(tx, ty, 25, 25);
      }
    }

    // White document placed on top of the tiles
    const docX = 90;
    const docY = 50;
    const docW = 220;
    const docH = 200;
    ctx.fillStyle = "rgb(245, 245, 245)";
    ctx.fillRect(docX, docY, docW, docH);

    // Text content
    ctx.fillStyle = "rgb(25, 25, 25)";
    for (let ty = docY + 20; ty < docY + docH - 20; ty += 15) {
      ctx.fillRect(docX + 20, ty, docW - 40, 3);
    }

    const corners = await detectDocumentCorners(canvas);
    expect(corners).not.toBeNull();

    expect(Math.abs(corners.tl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tl.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.tr.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.tr.y - docY)).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.br.x - (docX + docW))).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.br.y - (docY + docH))).toBeLessThanOrEqual(10);

    expect(Math.abs(corners.bl.x - docX)).toBeLessThanOrEqual(10);
    expect(Math.abs(corners.bl.y - (docY + docH))).toBeLessThanOrEqual(10);
  });

  describe("document filling the camera frame", () => {
    // 400x300 frame: dark desk, white page with a few text lines.
    async function detectPage(x, y, w, h) {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgb(20, 20, 20)";
      ctx.fillRect(0, 0, 400, 300);
      ctx.fillStyle = "rgb(240, 240, 240)";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "rgb(30, 30, 30)";
      for (let ty = Math.max(y, 0) + 30; ty < Math.min(y + h, 300) - 30; ty += 25) {
        ctx.fillRect(Math.max(x, 0) + 30, ty, Math.min(w, 400 - x) - 60, 3);
      }
      return detectDocumentCorners(canvas);
    }

    function expectCornersNear(corners, x, y, w, h, tolerance) {
      expect(corners).not.toBeNull();
      const expected = {
        tl: { x, y },
        tr: { x: x + w, y },
        br: { x: x + w, y: y + h },
        bl: { x, y: y + h },
      };
      for (const name of ["tl", "tr", "br", "bl"]) {
        expect(Math.abs(corners[name].x - expected[name].x)).toBeLessThanOrEqual(tolerance);
        expect(Math.abs(corners[name].y - expected[name].y)).toBeLessThanOrEqual(tolerance);
      }
    }

    it("detects a close-up page covering ~80% of the frame with all four edges visible", async () => {
      // 6% margin on every side: the page fills the shot, but desk shows around it.
      const corners = await detectPage(24, 18, 352, 264);
      expectCornersNear(corners, 24, 18, 352, 264, 6);
    });

    it("returns null for a page clipped by the frame on one side", async () => {
      // The right edge of the page is outside the shot: the frame border is not
      // a page edge, so no quad here describes the page.
      expect(await detectPage(60, 40, 400, 220)).toBeNull();
    });

    it("returns null for a page clipped by the frame on two sides", async () => {
      expect(await detectPage(60, 40, 400, 300)).toBeNull();
    });

    it("returns null for a page clipped by the frame on three sides", async () => {
      expect(await detectPage(0, 40, 400, 300)).toBeNull();
    });

    // KNOWN GAP: a page whose four edges ARE visible, but within 4.5% of the
    // frame, is rejected — isImageFrameBorder counts corners inside that band
    // as "hugging the frame" without checking that the edges are real (high
    // gradient). Close-up scans framed tightly fall back to the full frame.
    // `it.fails` keeps this GREEN while the gap exists; when the heuristic is
    // fixed it turns red — convert it to a normal `it(...)` then.
    it.fails("KNOWN GAP: detects a tightly framed page whose edges sit 3% from the frame", async () => {
      const corners = await detectPage(12, 9, 376, 282);
      expectCornersNear(corners, 12, 9, 376, 282, 6);
    });
  });
});
