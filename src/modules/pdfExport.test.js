/**
 * src/modules/pdfExport.test.js
 * Unit tests for pdfExport.js.
 *
 * Heavy DOM-dependent paths (html2canvas, iframe) are mocked; pdf-lib is used
 * for real so we can assert on the resulting document structure.
 */

import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadPdfBytes, exportNoteToPdf } from "./pdfExport.js";

// ── Mock html2canvas ──────────────────────────────────────────────────────────
// Returns a fake canvas-like object. jsdom's canvas.getContext("2d") returns
// null, so we build a minimal stub that satisfies the drawTextSliceOnPage path.

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeFakeCanvas(width = 1200, height = 200) {
  const fakeCtx = { drawImage: vi.fn() };
  return {
    width,
    height,
    getContext: () => fakeCtx,
    toDataURL: () => `data:image/png;base64,${TINY_PNG_B64}`,
  };
}

vi.mock("html2canvas", () => ({
  default: vi.fn(async () => makeFakeCanvas()),
}));

// ── Mock storage.getFile ──────────────────────────────────────────────────────
vi.mock("./storage.js", () => ({
  getFile: vi.fn(() => Promise.resolve(null)),
}));

// ── Mock @tauri-apps/api/core (invoke) ────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNote(overrides = {}) {
  return {
    id: "note-1",
    title: "Test note",
    strokes: [],
    media: [],
    pdfSource: null,
    background: "none",
    content: null,
    modified: Date.now(),
    ...overrides,
  };
}

function makeStroke(xs, ys, overrides = {}) {
  return {
    id: "s1",
    type: "pen",
    colorIndex: 0,
    width: 2,
    x: xs,
    y: ys,
    pressure: xs.map(() => 0.5),
    ...overrides,
  };
}

// ── exportNoteToPdf ───────────────────────────────────────────────────────────

describe("exportNoteToPdf", () => {
  let createElementSpy;

  beforeEach(() => {
    // jsdom's canvas.getContext("2d") returns null — patch createElement so that
    // every canvas element we create during export has a working stub context.
    const origCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, "createElement").mockImplementation((tag, ...args) => {
      if (tag === "canvas") return makeFakeCanvas();
      return origCreate(tag, ...args);
    });
  });

  afterEach(() => {
    createElementSpy?.mockRestore();
  });

  it("returns a non-empty Uint8Array for a blank note", async () => {
    const bytes = await exportNoteToPdf(makeNote(), []);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("creates a single A4 page for an empty note", async () => {
    const bytes = await exportNoteToPdf(makeNote(), []);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("calls onProgress for each page", async () => {
    const progress = vi.fn();
    await exportNoteToPdf(makeNote(), [], progress);
    expect(progress).toHaveBeenCalledWith(1, 1);
  });

  it("filters out deleted strokes", async () => {
    const note = makeNote({
      strokes: [
        makeStroke([10, 20], [100, 200], { _deleted: true }),
        makeStroke([30, 40], [300, 400]),
      ],
    });

    // Should not throw; deleted strokes are silently excluded
    const bytes = await exportNoteToPdf(note, []);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("creates multiple pages when strokes extend beyond one page", async () => {
    // A4 content height ≈ 1697 px (841.89 / (595.28/1200))
    // Put a stroke at Y=5000 → forces a second page
    const note = makeNote({
      strokes: [makeStroke([10, 20], [5000, 5100])],
    });

    const bytes = await exportNoteToPdf(note, []);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("sets document title from note.title", async () => {
    const bytes = await exportNoteToPdf(makeNote({ title: "My Journal" }), []);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("My Journal");
  });

  it("embeds text content when note.content is provided", async () => {
    const note = makeNote({ content: "<p>Hello world</p>" });
    // html2canvas mock returns a canvas, so the text slice path runs
    const bytes = await exportNoteToPdf(note, []);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("handles note with pdf-page media items (Case A)", async () => {
    const { getFile } = await import("./storage.js");

    // Create a minimal valid PDF to serve as the source
    const srcDoc = await PDFDocument.create();
    srcDoc.addPage([595, 841]);
    const srcBytes = await srcDoc.save();

    // jsdom Blob may lack arrayBuffer(); provide a plain object with it
    getFile.mockResolvedValue({ arrayBuffer: () => Promise.resolve(srcBytes.buffer) });

    const pdfPageItem = {
      type: "pdf-page",
      fileId: "pdf-source",
      pageIndex: 0,
      x: 0,
      y: 0,
      width: 1200,
      height: 1697,
    };

    const note = makeNote({ pdfSource: "pdf-source" });
    const bytes = await exportNoteToPdf(note, [pdfPageItem]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("appends extra pages when strokes overflow the last PDF page (Case A)", async () => {
    const { getFile } = await import("./storage.js");

    const srcDoc = await PDFDocument.create();
    srcDoc.addPage([595, 841]);
    const srcBytes = await srcDoc.save();

    getFile.mockResolvedValue({ arrayBuffer: () => Promise.resolve(srcBytes.buffer) });

    const pdfPageItem = {
      type: "pdf-page",
      fileId: "pdf-source",
      pageIndex: 0,
      x: 0,
      y: 0,
      width: 1200,
      height: 1697,
    };

    const note = makeNote({
      pdfSource: "pdf-source",
      strokes: [makeStroke([10, 20], [5000, 5100])],
    });

    const bytes = await exportNoteToPdf(note, [pdfPageItem]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

// ── downloadPdfBytes ─────────────────────────────────────────────────────────

describe("downloadPdfBytes", () => {
  const fakeBytes = new Uint8Array([37, 80, 68, 70]); // "%PDF"

  beforeEach(() => {
    // Reset Tauri globals
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers a browser download (anchor click) when not in Tauri", async () => {
    const createObjectURL = vi.fn(() => "blob:fake-url");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(window, "URL", {
      value: { createObjectURL, revokeObjectURL },
      writable: true,
      configurable: true,
    });

    const appendSpy = vi.spyOn(document.body, "appendChild").mockImplementation(() => {});
    const removeSpy = vi.spyOn(document.body, "removeChild").mockImplementation(() => {});
    const clickSpy = vi.fn();

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === "a") el.click = clickSpy;
      return el;
    });

    await downloadPdfBytes(fakeBytes, "test.pdf");

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");

    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("calls Tauri invoke('save_pdf') on desktop Tauri", async () => {
    window.__TAURI_INTERNALS__ = {};

    const { invoke } = await import("@tauri-apps/api/core");
    invoke.mockResolvedValue(undefined);

    await downloadPdfBytes(fakeBytes, "note.pdf");

    expect(invoke).toHaveBeenCalledWith("save_pdf", {
      bytes: Array.from(fakeBytes),
      suggestedName: "note.pdf",
    });
  });
});
